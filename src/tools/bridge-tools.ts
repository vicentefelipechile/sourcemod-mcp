// =========================================================================================================
// Bridge Tools
// =========================================================================================================
// MCP tools that talk to the bridge plugin over the local socket. This module seeds the control primitives:
// `send_intent` (the general control tool) and `bridge_status` (a liveness/health check). More typed tools
// are layered on in later phases; this is the foundation that proves the round-trip.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeSocketServer } from "../socket-server.js";
import { classifyCommand, confirmationGate } from "../safety.js";
import { jsonContent, errorContent, errMessage } from "./shared.js";

// =========================================================================================================
// Constants
// =========================================================================================================

/** Upper bound callers may set on an intent's wait, guarding against runaway holds on the MCP request. */
const MAX_INTENT_TIMEOUT_MS = 60_000;

// =========================================================================================================
// Helpers
// =========================================================================================================

/**
 * Some MCP clients hand `payload` over as a JSON *string* rather than a nested object, which would then get
 * double-encoded on the wire and reach the plugin as a string it cannot index. Parse such a string back into
 * an object so the plugin always receives a real JSON object; leave anything else untouched.
 */
function normalizePayload(payload: unknown): unknown {
  if (typeof payload !== "string") {
    return payload;
  }
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return payload;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return payload;
  }
}

/** Pull the command string out of a console action's payload, tolerating an unknown/missing shape. */
function extractCommand(payload: unknown): string {
  if (payload && typeof payload === "object" && "command" in payload) {
    const command = (payload as { command: unknown }).command;
    return typeof command === "string" ? command : "";
  }
  return "";
}

// =========================================================================================================
// Main
// =========================================================================================================

export function registerBridgeTools(server: McpServer, bridge: BridgeSocketServer): void {
  server.registerTool(
    "send_intent",
    {
      title: "Send Intent",
      description:
        "PREFERRED way to run anything on the gameserver. Sends a structured action to the bridge plugin " +
        "running in-process and returns a correlated, structured result with the full SourceMod API " +
        'available. ALWAYS try this before rcon_exec: use the "console" action to run any server console ' +
        "command (payload { command: string }) — it is the direct replacement for RCON and returns cleaner " +
        "output. Other actions (ping, query_state, plugins, ...) are typed and validated by the plugin. " +
        "Only fall back to rcon_exec when this tool reports the bridge is not connected.",
      inputSchema: {
        action: z
          .string()
          .min(1)
          .describe('The plugin action to invoke, e.g. "ping", "console", "query_state", "plugins".'),
        payload: z
          .unknown()
          .optional()
          .describe("Action-specific JSON body. For console: { command: string }."),
        confirm: z
          .boolean()
          .optional()
          .describe("Set true to execute a destructive console command. Omit to preview it first."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(MAX_INTENT_TIMEOUT_MS)
          .optional()
          .describe("How long to wait for the plugin's result before failing."),
      },
    },
    async ({ action, payload: rawPayload, confirm, timeoutMs }) => {
      if (!bridge.isConnected) {
        return errorContent(
          "No bridge plugin connected. Load the bridge plugin in the gameserver, or use rcon_exec as a fallback.",
        );
      }

      const payload = normalizePayload(rawPayload);

      // The "console" action runs an arbitrary server command, so it carries the same destructive risk as
      // rcon_exec and goes through the same confirmation gate. Other actions are typed and narrow.
      if (action === "console") {
        const command = extractCommand(payload);
        const gate = confirmationGate("send_intent(console)", classifyCommand(command), confirm ?? false);
        if (gate.blocked) {
          return jsonContent({ ...gate.preview, command });
        }
      }

      try {
        const result = await bridge.sendIntent(action, payload ?? {}, { timeoutMs });
        return jsonContent(result);
      } catch (err) {
        return errorContent(errMessage(err));
      }
    },
  );

  server.registerTool(
    "bridge_status",
    {
      title: "Bridge Status",
      description:
        "Report whether the bridge plugin is connected to the MCP socket. When connected, issues a ping " +
        "intent and reports the round-trip result so you can confirm the link is not just open but responsive.",
      inputSchema: {},
    },
    async () => {
      if (!bridge.isConnected) {
        return jsonContent({ connected: false, responsive: false });
      }
      try {
        const result = await bridge.sendIntent("ping", {}, { timeoutMs: 5_000 });
        return jsonContent({ connected: true, responsive: result.ok, ping: result });
      } catch (err) {
        return jsonContent({
          connected: true,
          responsive: false,
          error: errMessage(err),
        });
      }
    },
  );
}
