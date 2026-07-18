// =========================================================================================================
// Shared Tool Helpers
// =========================================================================================================
// Small primitives every tool module needs, hoisted here so they exist once instead of being copy-pasted
// into each file: MCP content wrappers (json/text/error), the error-message normalizer used in every catch,
// and the "run via the bridge, fall back to RCON" pattern shared by lifecycle and cfg exec.

import type { Config } from "../config.js";
import type { BridgeSocketServer } from "../socket-server.js";
import { rconExec } from "../rcon.js";
import { createLogger } from "../logger.js";
import { errMessage } from "../errors.js";

export { errMessage };

// =========================================================================================================
// Constants
// =========================================================================================================

const log = createLogger("tools");

export const DEFAULT_TOOL_TIMEOUT_MS = 8_000;

// =========================================================================================================
// Helpers
// =========================================================================================================

export function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function errorContent(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

// =========================================================================================================
// Main
// =========================================================================================================

/**
 * Run a console command preferring the bridge's in-process `console` action and falling back to RCON when the
 * bridge is down or the intent fails. Returns a structured result tagged with which path was taken. Shared by
 * lifecycle-style tools and cfg exec so the fallback logic lives in one place.
 */
export async function execViaBridgeOrRcon(
  config: Config,
  bridge: BridgeSocketServer,
  command: string,
): Promise<Record<string, unknown>> {
  if (bridge.isConnected) {
    try {
      const result = await bridge.sendIntent("console", { command }, { timeoutMs: DEFAULT_TOOL_TIMEOUT_MS });
      return { via: "bridge", ...result };
    } catch (err) {
      log.warn("Bridge command failed; falling back to RCON", { message: errMessage(err) });
    }
  }
  const output = await rconExec(config.rcon, command);
  return { via: "rcon", ok: true, command, output };
}
