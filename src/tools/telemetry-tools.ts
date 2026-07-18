// =========================================================================================================
// Telemetry Tools
// =========================================================================================================
// Read-side tools over the telemetry channel. get_recent_events serves the live in-memory event buffer;
// get_live_state issues a query_state intent to the plugin for a structured, native-backed snapshot rather
// than parsing raw console text.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeSocketServer } from "../socket-server.js";
import type { EventBuffer } from "../event-buffer.js";
import { jsonContent, errorContent, errMessage } from "./shared.js";

// =========================================================================================================
// Constants
// =========================================================================================================

const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 500;

// =========================================================================================================
// Main
// =========================================================================================================

export function registerTelemetryTools(
  server: McpServer,
  bridge: BridgeSocketServer,
  buffer: EventBuffer,
): void {
  server.registerTool(
    "get_recent_events",
    {
      title: "Get Recent Events",
      description:
        "Return buffered real-time events pushed by the bridge plugin (connects, chat, deaths, round/map " +
        "changes, errors), most recent last. Use for live debugging or to confirm an action had the " +
        "expected in-game effect. This reads the live in-memory buffer; use get_event_log for older history.",
      inputSchema: {
        actions: z
          .array(z.string())
          .optional()
          .describe('Filter to these event action names only, e.g. ["player_death", "round_start"].'),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_EVENT_LIMIT)
          .optional()
          .describe(`Max events to return (default ${DEFAULT_EVENT_LIMIT}).`),
      },
    },
    async ({ actions, limit }) => {
      const events = buffer.query({ actions, limit: limit ?? DEFAULT_EVENT_LIMIT });
      return jsonContent({ count: events.length, buffered: buffer.size, events });
    },
  );

  server.registerTool(
    "get_live_state",
    {
      title: "Get Live State",
      description:
        "Return current game state — players, teams, map, bot/human counts, alive status — read through " +
        "SourceMod natives (not string parsing). Call before acting, or whenever you want an accurate " +
        "snapshot instead of raw console text. Requires the bridge plugin to be connected.",
      inputSchema: {},
    },
    async () => {
      if (!bridge.isConnected) {
        return errorContent("No bridge plugin connected; cannot query live state.");
      }
      try {
        const result = await bridge.sendIntent("query_state", {}, { timeoutMs: 5_000 });
        if (!result.ok) {
          return errorContent(result.error ?? "query_state failed");
        }
        return jsonContent(result.data);
      } catch (err) {
        return errorContent(errMessage(err));
      }
    },
  );
}
