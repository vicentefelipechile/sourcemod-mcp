// =========================================================================================================
// Event Buffer
// =========================================================================================================
// A bounded in-memory ring buffer of the most recent telemetry events pushed by the bridge plugin. Backs the
// get_recent_events tool. Old events are evicted once the cap is reached, so live debugging reads the recent
// window without unbounded memory growth. Persistent on-disk history is a separate concern (Phase 7).

import type { EventMessage } from "./protocol.js";

// =========================================================================================================
// Constants
// =========================================================================================================

/** Maximum number of events retained in the live buffer before the oldest are evicted. */
const DEFAULT_CAPACITY = 500;

// =========================================================================================================
// Types
// =========================================================================================================

/** A buffered event: the plugin's event frame plus the time the MCP received it. */
export interface BufferedEvent {
  receivedAt: string;
  action: string;
  payload: unknown;
}

export interface EventQuery {
  /** Return only events whose action matches one of these names. */
  actions?: string[];
  /** Return at most this many of the most recent matching events. */
  limit?: number;
}

// =========================================================================================================
// Main
// =========================================================================================================

/** A fixed-capacity ring buffer of recent telemetry events. */
export class EventBuffer {
  private readonly events: BufferedEvent[] = [];

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  /** Record an incoming event frame, evicting the oldest when at capacity. */
  record(event: EventMessage): void {
    this.events.push({
      receivedAt: new Date().toISOString(),
      action: event.action,
      payload: event.payload,
    });
    if (this.events.length > this.capacity) {
      this.events.shift();
    }
  }

  /** Return recent events, most recent last, optionally filtered by action and limited in count. */
  query(query: EventQuery = {}): BufferedEvent[] {
    let result = this.events;

    if (query.actions && query.actions.length > 0) {
      const wanted = new Set(query.actions);
      result = result.filter((event) => wanted.has(event.action));
    }

    if (query.limit !== undefined && query.limit >= 0 && result.length > query.limit) {
      result = result.slice(result.length - query.limit);
    }

    // Copy so callers cannot mutate the internal buffer.
    return [...result];
  }

  /** Current number of buffered events. */
  get size(): number {
    return this.events.length;
  }
}
