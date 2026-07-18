// =========================================================================================================
// Wire Protocol
// =========================================================================================================
// The framing and message shapes shared across the local TCP link between the MCP and the bridge plugin.
//
// Transport: raw local TCP. Because TCP is a byte stream with no message boundaries, each JSON message is
// length-prefixed: a 4-byte big-endian unsigned integer giving the byte length of the UTF-8 JSON payload
// that follows. This avoids partial-read / coalesced-read ambiguity that a newline delimiter cannot.
//
// Message shape: { id, type, action, payload }
//   - id      correlation id; every intent's result echoes the intent's id.
//   - type    "intent" | "result" | "event".
//   - action  the operation name (e.g. "ping", "console"); meaningful for intents and events.
//   - payload arbitrary JSON body for the action.

// =========================================================================================================
// Constants
// =========================================================================================================

/** Size in bytes of the big-endian length prefix that precedes every frame. */
export const LENGTH_PREFIX_BYTES = 4;

/** Hard cap on a single frame's payload to guard against runaway allocation from a malformed length prefix. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

// =========================================================================================================
// Types
// =========================================================================================================

export type MessageType = "intent" | "result" | "event";

/** A message travelling in either direction over the socket. */
export interface Message {
  id: string;
  type: MessageType;
  action: string;
  payload: unknown;
}

/** An intent the MCP sends to the plugin: "do this in-game". */
export interface IntentMessage extends Message {
  type: "intent";
}

/** A result the plugin sends back, correlated to an intent by id. */
export interface ResultMessage extends Message {
  type: "result";
  payload: ResultPayload;
}

/** An unsolicited event the plugin pushes (telemetry). id may be a fresh id, not correlated to any intent. */
export interface EventMessage extends Message {
  type: "event";
}

/** Standard shape of a result payload so callers can branch on ok without guessing. */
export interface ResultPayload {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// =========================================================================================================
// Helpers
// =========================================================================================================

/** Narrow an unknown parsed object to a Message, returning null when it does not match the shape. */
function asMessage(value: unknown): Message | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "string") return null;
  if (obj.type !== "intent" && obj.type !== "result" && obj.type !== "event") return null;
  if (typeof obj.action !== "string") return null;
  return {
    id: obj.id,
    type: obj.type,
    action: obj.action,
    payload: obj.payload,
  };
}

// =========================================================================================================
// Main
// =========================================================================================================

// Wire format: a 4-byte big-endian length prefix followed by the UTF-8 JSON body.
export function encodeFrame(message: Message): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  if (json.length > MAX_FRAME_BYTES) {
    throw new Error(`Frame exceeds max size: ${json.length} > ${MAX_FRAME_BYTES}`);
  }
  const prefix = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES);
  prefix.writeUInt32BE(json.length, 0);
  return Buffer.concat([prefix, json]);
}

/**
 * Incremental frame decoder. Feed it raw chunks as they arrive; it buffers partial frames and yields every
 * complete Message it can extract. Keeps its own internal buffer across calls, so a frame split across two
 * TCP reads (or several frames coalesced into one read) are both handled correctly.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /** Append a chunk and return every complete, valid message now available. Throws on protocol violations. */
  push(chunk: Buffer): Message[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: Message[] = [];

    while (this.buffer.length >= LENGTH_PREFIX_BYTES) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new Error(`Declared frame length ${length} exceeds max ${MAX_FRAME_BYTES}`);
      }

      const frameEnd = LENGTH_PREFIX_BYTES + length;
      if (this.buffer.length < frameEnd) {
        // The full frame has not arrived yet; wait for more data.
        break;
      }

      const jsonBytes = this.buffer.subarray(LENGTH_PREFIX_BYTES, frameEnd);
      this.buffer = this.buffer.subarray(frameEnd);

      const parsed = JSON.parse(jsonBytes.toString("utf8")) as unknown;
      const message = asMessage(parsed);
      if (message === null) {
        throw new Error("Received frame that is not a valid protocol message");
      }
      messages.push(message);
    }

    return messages;
  }

  /** Reset the internal buffer, discarding any partial frame. Called on disconnect. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
