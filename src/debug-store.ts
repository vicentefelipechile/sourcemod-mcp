// =========================================================================================================
// Debug Store
// =========================================================================================================
// Backing state for the debugging layer:
//   - an error ring buffer fed by structured error frames the plugin pushes (backs get_errors)
//   - an append-only on-disk event log the plugin's record_events toggle drives (backs get_event_log)
// The live event buffer (event-buffer.ts) is short and rotates; this on-disk log survives that rotation so a
// bug that happened earlier can still be investigated. Both are development aids, gated by the plugin.

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { createLogger } from "./logger.js";
import type { EventMessage } from "./protocol.js";

// =========================================================================================================
// Constants
// =========================================================================================================

/** Max structured errors held in the ring buffer. */
const DEFAULT_ERROR_CAPACITY = 300;

const log = createLogger("debug");

// =========================================================================================================
// Types
// =========================================================================================================

/** A structured SourcePawn error frame pushed by the plugin's error hook. */
export interface StructuredError {
  receivedAt: string;
  plugin?: string;
  file?: string;
  line?: number;
  native?: string;
  message: string;
  stack?: string[];
}

export interface ErrorQuery {
  plugin?: string;
  limit?: number;
}

export interface EventLogQuery {
  /** Only events at or after this ISO timestamp. */
  since?: string;
  /** Only these action names. */
  actions?: string[];
  /** Max entries to return (most recent). */
  limit?: number;
}

/** One persisted event-log line. */
interface EventLogEntry {
  at: string;
  action: string;
  payload: unknown;
}

// =========================================================================================================
// Helpers
// =========================================================================================================

/** Coerce a loosely-typed error payload into a StructuredError, tolerating missing fields. */
function toStructuredError(payload: unknown): StructuredError {
  const obj = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const stack = Array.isArray(obj.stack) ? obj.stack.map((s) => String(s)) : undefined;
  return {
    receivedAt: new Date().toISOString(),
    plugin: typeof obj.plugin === "string" ? obj.plugin : undefined,
    file: typeof obj.file === "string" ? obj.file : undefined,
    line: typeof obj.line === "number" ? obj.line : undefined,
    native: typeof obj.native === "string" ? obj.native : undefined,
    message: typeof obj.message === "string" ? obj.message : String(obj.message ?? "unknown error"),
    stack,
  };
}

// =========================================================================================================
// Main
// =========================================================================================================

/** Holds the error ring buffer and drives the persistent event log. */
export class DebugStore {
  private readonly errors: StructuredError[] = [];
  private recording = false;

  constructor(
    private readonly eventLogPath: string,
    private readonly errorCapacity: number = DEFAULT_ERROR_CAPACITY,
  ) {}

  /** Record a structured error frame, evicting the oldest when at capacity. */
  recordError(payload: unknown): void {
    this.errors.push(toStructuredError(payload));
    if (this.errors.length > this.errorCapacity) {
      this.errors.shift();
    }
  }

  /** Return recent structured errors, optionally filtered by plugin and limited. */
  queryErrors(query: ErrorQuery = {}): StructuredError[] {
    let result = this.errors;
    if (query.plugin) {
      result = result.filter((e) => e.plugin === query.plugin);
    }
    if (query.limit !== undefined && result.length > query.limit) {
      result = result.slice(result.length - query.limit);
    }
    return [...result];
  }

  /** Enable or disable persisting events to the on-disk log. */
  setRecording(enabled: boolean): void {
    this.recording = enabled;
    log.info("Event recording toggled", { enabled });
  }

  get isRecording(): boolean {
    return this.recording;
  }

  /** Persist an event to the on-disk log when recording is on. One JSON object per line (JSONL). */
  async persistEvent(event: EventMessage): Promise<void> {
    if (!this.recording) {
      return;
    }
    const entry: EventLogEntry = {
      at: new Date().toISOString(),
      action: event.action,
      payload: event.payload,
    };
    try {
      await mkdir(dirname(this.eventLogPath), { recursive: true });
      await appendFile(this.eventLogPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (err) {
      log.error("Failed to persist event", { message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Read the persistent event log back, filtered by time window, action, and count. */
  async queryEventLog(query: EventLogQuery = {}): Promise<EventLogEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.eventLogPath, "utf8");
    } catch {
      // No log file yet means no history.
      return [];
    }

    const sinceMs = query.since ? Date.parse(query.since) : Number.NEGATIVE_INFINITY;
    const wanted = query.actions && query.actions.length > 0 ? new Set(query.actions) : null;

    const entries: EventLogEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      let entry: EventLogEntry;
      try {
        entry = JSON.parse(trimmed) as EventLogEntry;
      } catch {
        continue;
      }
      if (Date.parse(entry.at) < sinceMs) continue;
      if (wanted && !wanted.has(entry.action)) continue;
      entries.push(entry);
    }

    if (query.limit !== undefined && entries.length > query.limit) {
      return entries.slice(entries.length - query.limit);
    }
    return entries;
  }
}
