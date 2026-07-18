// =========================================================================================================
// Bridge Socket Server
// =========================================================================================================
// The MCP acts as the TCP server; the bridge plugin (running inside the gameserver) is the client that
// connects to it. This module owns that server: it accepts a single active bridge connection, decodes
// inbound frames, correlates results back to the intents that produced them, and fans out events to
// registered listeners.
//
// Only one bridge connection is meaningful at a time (one gameserver). A newer connection supersedes an
// older one so a plugin reload / server restart cleanly re-establishes the link.

import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

import { createLogger } from "./logger.js";
import {
  FrameDecoder,
  encodeFrame,
  type EventMessage,
  type Message,
  type ResultMessage,
  type ResultPayload,
} from "./protocol.js";
import { errMessage } from "./errors.js";
import type { SocketConfig } from "./config.js";

// =========================================================================================================
// Constants
// =========================================================================================================

/** Default time to wait for a plugin result before rejecting the pending intent. */
const DEFAULT_INTENT_TIMEOUT_MS = 10_000;

const BIND_RETRY_TOTAL_MS = 15_000;
const BIND_RETRY_INTERVAL_MS = 500;

// =========================================================================================================
// Types
// =========================================================================================================

/** A caller waiting on the result of an intent it sent. */
interface PendingIntent {
  resolve: (payload: ResultPayload) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  action: string;
}

/** A listener invoked for every event frame the plugin pushes. */
export type EventListener = (event: EventMessage) => void;

export interface SendIntentOptions {
  timeoutMs?: number;
}

const log = createLogger("socket");

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

// =========================================================================================================
// Main
// =========================================================================================================

/**
 * Owns the TCP link to the bridge plugin. Send intents and await correlated results; subscribe to pushed
 * events. Tolerant of the plugin connecting late, disconnecting, and reconnecting.
 */
export class BridgeSocketServer {
  private server: Server | null = null;
  private connection: Socket | null = null;
  private decoder = new FrameDecoder();
  private readonly pending = new Map<string, PendingIntent>();
  private readonly eventListeners = new Set<EventListener>();

  constructor(private readonly config: SocketConfig) {}

  get isConnected(): boolean {
    return this.connection !== null && !this.connection.destroyed;
  }

  /**
   * Start listening for the bridge plugin to connect. Resolves once the server is bound. Retries on
   * EADDRINUSE, since a predecessor MCP process can still be releasing the port as this one starts.
   */
  async start(): Promise<void> {
    const deadline = Date.now() + BIND_RETRY_TOTAL_MS;
    for (;;) {
      try {
        await this.tryBind();
        return;
      } catch (err) {
        const inUse = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
        if (!inUse || Date.now() >= deadline) {
          throw err;
        }
        log.warn("Port in use, waiting for predecessor to release it", {
          host: this.config.host,
          port: this.config.port,
        });
        await delay(BIND_RETRY_INTERVAL_MS);
      }
    }
  }

  private tryBind(): Promise<void> {
    return new Promise((resolveBind, rejectBind) => {
      const server = createServer((socket) => this.onConnection(socket));

      const onError = (err: Error) => {
        server.removeListener("error", onError);
        server.close();
        this.server = null;
        rejectBind(err);
      };
      server.on("error", onError);

      server.listen(this.config.port, this.config.host, () => {
        server.removeListener("error", onError);
        server.on("error", (err) => log.error("Socket server error", { message: err.message }));
        log.info("Bridge socket server listening", {
          host: this.config.host,
          port: this.config.port,
        });
        resolveBind();
      });

      this.server = server;
    });
  }

  /** Stop the server, drop any connection, and fail all pending intents. */
  async stop(): Promise<void> {
    this.rejectAllPending(new Error("Socket server shutting down"));
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
    await new Promise<void>((resolveStop) => {
      if (!this.server) {
        resolveStop();
        return;
      }
      this.server.close(() => resolveStop());
      this.server = null;
    });
  }

  /** Register a listener for pushed event frames. Returns an unsubscribe function. */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Send an intent to the bridge plugin and await its correlated result. Rejects if no plugin is connected,
   * if the write fails, or if the plugin does not answer within the timeout.
   */
  sendIntent(
    action: string,
    payload: unknown,
    options: SendIntentOptions = {},
  ): Promise<ResultPayload> {
    if (!this.isConnected || !this.connection) {
      return Promise.reject(new Error("No bridge plugin connected"));
    }

    const id = randomUUID();
    const message: Message = { id, type: "intent", action, payload };
    const timeoutMs = options.timeoutMs ?? DEFAULT_INTENT_TIMEOUT_MS;

    return new Promise<ResultPayload>((resolveIntent, rejectIntent) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectIntent(new Error(`Intent "${action}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve: resolveIntent, reject: rejectIntent, timer, action });

      try {
        this.connection!.write(encodeFrame(message));
      } catch (err) {
        this.clearPending(id);
        rejectIntent(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // =======================================================================================================
  // Connection lifecycle (private)
  // =======================================================================================================

  /** Handle a new inbound bridge connection, superseding any previous one. */
  private onConnection(socket: Socket): void {
    if (this.connection && !this.connection.destroyed) {
      log.warn("New bridge connection superseding an existing one");
      this.connection.destroy();
    }

    socket.setNoDelay(true);
    this.connection = socket;
    this.decoder.reset();
    log.info("Bridge plugin connected", { remote: socket.remoteAddress });

    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) => log.error("Bridge connection error", { message: err.message }));
    socket.on("close", () => this.onClose(socket));
  }

  private onData(chunk: Buffer): void {
    let messages: Message[];
    try {
      messages = this.decoder.push(chunk);
    } catch (err) {
      log.error("Frame decode failure; dropping connection", {
        message: errMessage(err),
      });
      this.connection?.destroy();
      return;
    }

    for (const message of messages) {
      this.routeMessage(message);
    }
  }

  private routeMessage(message: Message): void {
    if (message.type === "result") {
      this.resolveResult(message as ResultMessage);
      return;
    }
    if (message.type === "event") {
      this.dispatchEvent(message as EventMessage);
      return;
    }
    // Intents flow MCP -> plugin only; receiving one here is a protocol violation we log and ignore.
    log.warn("Ignoring unexpected inbound intent frame", { action: message.action });
  }

  private resolveResult(result: ResultMessage): void {
    const entry = this.pending.get(result.id);
    if (!entry) {
      log.warn("Received result with no matching pending intent", { id: result.id });
      return;
    }
    this.clearPending(result.id);
    entry.resolve(result.payload);
  }

  /** Fan an event out to every registered listener, isolating listener errors. */
  private dispatchEvent(event: EventMessage): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        log.error("Event listener threw", {
          message: errMessage(err),
        });
      }
    }
  }

  /** Clean up after the bridge connection closes. */
  private onClose(socket: Socket): void {
    if (this.connection !== socket) {
      // A superseded connection closing; the active one is unaffected.
      return;
    }
    log.warn("Bridge plugin disconnected");
    this.connection = null;
    this.decoder.reset();
    this.rejectAllPending(new Error("Bridge plugin disconnected before result"));
  }

  /** Remove a pending intent and clear its timeout. */
  private clearPending(id: string): void {
    const entry = this.pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
    }
  }

  /** Fail every outstanding intent with the given error. */
  private rejectAllPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}
