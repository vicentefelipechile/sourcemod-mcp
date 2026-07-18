// =========================================================================================================
// Debugging Tools
// =========================================================================================================
// The debugging layer that turns the project from "works" into "worth building" for development:
//   get_errors      structured SourcePawn errors from the plugin's error hook (ring buffer)
//   get_event_log   query the persistent on-disk event log (survives live-buffer rotation)
//   set_capture     toggle the plugin's structured error capture (capture_errors action)
//   set_recording   toggle persisting the event stream to disk (record_events)
//   reproduce       trigger a named scenario in-game to recreate a bug deterministically
//   dump_state      read internal state a target plugin opted in to expose (dump_plugin_state)
// Capture and recording are development toggles, gated on purpose — not always-on — to avoid production
// overhead and noise.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeSocketServer } from "../socket-server.js";
import type { DebugStore } from "../debug-store.js";

// =========================================================================================================
// Constants
// =========================================================================================================

const MAX_ERROR_LIMIT = 300;

// =========================================================================================================
// Helpers
// =========================================================================================================

function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorContent(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/** Send an intent, returning a uniform error result when the bridge is down or the intent fails. */
async function bridgeIntent(bridge: BridgeSocketServer, action: string, payload: unknown) {
  if (!bridge.isConnected) {
    return { ok: false, error: "No bridge plugin connected." };
  }
  try {
    return await bridge.sendIntent(action, payload, { timeoutMs: 8_000 });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// =========================================================================================================
// Main
// =========================================================================================================

/** Register the debugging tools. */
export function registerDebugTools(server: McpServer, bridge: BridgeSocketServer, store: DebugStore): void {
  // --- get_errors ---
  server.registerTool(
    "get_errors",
    {
      title: "Get Errors",
      description:
        "Return structured SourcePawn errors captured by the plugin's error hook: plugin, file, line, " +
        "native, message, and stack. The first call when investigating a runtime failure — far faster than " +
        "parsing raw log files. Enable capture first with set_capture if it is off.",
      inputSchema: {
        plugin: z.string().optional().describe("Filter to errors from this plugin only."),
        limit: z.number().int().positive().max(MAX_ERROR_LIMIT).optional().describe("Max errors to return."),
      },
    },
    async ({ plugin, limit }) => {
      const errors = store.queryErrors({ plugin, limit });
      return jsonContent({ count: errors.length, capturing: store.isRecording, errors });
    },
  );

  // --- get_event_log ---
  server.registerTool(
    "get_event_log",
    {
      title: "Get Event Log",
      description:
        "Query the persistent on-disk event log (not just the live buffer), filterable by time window, " +
        "action type, and count. Use to investigate a bug that happened earlier, after the live telemetry " +
        "buffer has rotated. Requires recording to have been enabled with set_recording.",
      inputSchema: {
        since: z.string().optional().describe("ISO timestamp; return only events at or after this time."),
        actions: z.array(z.string()).optional().describe("Filter to these event action names only."),
        limit: z.number().int().positive().optional().describe("Max entries to return (most recent)."),
      },
    },
    async ({ since, actions, limit }) => {
      try {
        const entries = await store.queryEventLog({ since, actions, limit });
        return jsonContent({ count: entries.length, recording: store.isRecording, entries });
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- set_capture (capture_errors toggle) ---
  server.registerTool(
    "set_capture",
    {
      title: "Set Error Capture",
      description:
        "Toggle the plugin's structured error capture (the capture_errors action). Turn on during " +
        "development so runtime errors stream out structured instead of sitting in a log file. A dev toggle; " +
        "leave off in production.",
      inputSchema: {
        enabled: z.boolean().describe("True to start capturing structured errors, false to stop."),
      },
    },
    async ({ enabled }) => {
      const result = await bridgeIntent(bridge, "capture_errors", { enabled });
      return jsonContent(result);
    },
  );

  // --- set_recording (record_events toggle) ---
  server.registerTool(
    "set_recording",
    {
      title: "Set Event Recording",
      description:
        "Toggle persisting the event stream to disk so it can be queried historically with get_event_log. " +
        "Also tells the plugin to keep pushing events (record_events action). A dev toggle; leave off in " +
        "production to avoid overhead.",
      inputSchema: {
        enabled: z.boolean().describe("True to start recording events to disk, false to stop."),
      },
    },
    async ({ enabled }) => {
      store.setRecording(enabled);
      // Inform the plugin too; it may gate its own event pushing on this.
      const result = await bridgeIntent(bridge, "record_events", { enabled });
      return jsonContent({ ok: true, recording: enabled, plugin: result });
    },
  );

  // --- reproduce ---
  server.registerTool(
    "reproduce",
    {
      title: "Reproduce Scenario",
      description:
        "Trigger a named, parameterized scenario in-game (spawn setup, force round phase, emit a test event) " +
        "so a state-dependent bug can be recreated deterministically instead of waiting for it to recur. " +
        "Scenarios are defined per bug class in the plugin; pass the scenario name and its parameters.",
      inputSchema: {
        scenario: z.string().min(1).describe('The scenario name to run, e.g. "force_round_start".'),
        params: z.record(z.unknown()).optional().describe("Scenario-specific parameters."),
      },
    },
    async ({ scenario, params }) => {
      const result = await bridgeIntent(bridge, "reproduce", { scenario, params: params ?? {} });
      return jsonContent(result);
    },
  );

  // --- dump_state ---
  server.registerTool(
    "dump_state",
    {
      title: "Dump Plugin State",
      description:
        "Read internal state a target plugin chose to expose (registered vars, collections, handles) via " +
        "the dump_plugin_state action. Use for logic bugs invisible in game events — a mispopulated " +
        "StringMap, an invalid handle, wrong counters. Only works if the target plugin opted in.",
      inputSchema: {
        plugin: z.string().min(1).describe("The target plugin to dump internal state from."),
        key: z.string().optional().describe("Optional specific state key to read; omit for everything exposed."),
      },
    },
    async ({ plugin, key }) => {
      const result = await bridgeIntent(bridge, "dump_plugin_state", { plugin, key });
      return jsonContent(result);
    },
  );
}
