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

// =========================================================================================================
// Constants
// =========================================================================================================

/** Upper bound callers may set on an intent's wait, guarding against runaway holds on the MCP request. */
const MAX_INTENT_TIMEOUT_MS = 60_000;

// =========================================================================================================
// Helpers
// =========================================================================================================

/** Wrap a value as MCP text tool content, JSON-stringified for structured readability. */
function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

/** Wrap an error message as an MCP tool error result. */
function errorContent(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
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

/** Register the bridge-facing tools on the given MCP server. */
export function registerBridgeTools(server: McpServer, bridge: BridgeSocketServer): void {
  server.registerTool(
    "send_intent",
    {
      title: "Send Intent",
      description:
        "Send a structured action to the bridge plugin running inside the gameserver and get a " +
        "correlated, structured result back. The main control primitive: use it for anything that should " +
        'run in-game with the full SourceMod API. The "console" action runs any server console command; ' +
        "other actions are typed and validated by the plugin.",
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
    async ({ action, payload, confirm, timeoutMs }) => {
      if (!bridge.isConnected) {
        return errorContent(
          "No bridge plugin connected. Load the bridge plugin in the gameserver, or use rcon_exec as a fallback.",
        );
      }

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
        return errorContent(err instanceof Error ? err.message : String(err));
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
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}
