// =========================================================================================================
// SourceMod MCP — Entry Point
// =========================================================================================================
// Boots the MCP server: loads config, starts the local socket server that the bridge plugin connects to,
// registers the Claude-facing tools, and connects the MCP over stdio. stdout is owned by the MCP transport;
// all diagnostics go to stderr via the logger.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { join } from "node:path";

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { BridgeSocketServer } from "./socket-server.js";
import { EventBuffer } from "./event-buffer.js";
import { DebugStore } from "./debug-store.js";
import { registerBridgeTools } from "./tools/bridge-tools.js";
import { registerTelemetryTools } from "./tools/telemetry-tools.js";
import { registerBuildTools } from "./tools/build-tools.js";
import { registerFileTools } from "./tools/file-tools.js";
import { registerDebugTools } from "./tools/debug-tools.js";
import { ScratchManager } from "./scratch-manager.js";
import { registerScratchTools } from "./tools/scratch-tools.js";

// =========================================================================================================
// Constants
// =========================================================================================================

const SERVER_NAME = "sourcemod-mcp";
const SERVER_VERSION = "0.1.0";

/** Event action the plugin uses to push a structured SourcePawn error frame. */
const ERROR_EVENT_ACTION = "sm_error";

/** File name of the persistent event log under the scratch dir's parent (a stable, writable location). */
const EVENT_LOG_NAME = "event-log.jsonl";

const log = createLogger("main");

// =========================================================================================================
// Main
// =========================================================================================================

/** Boot the whole server and block until the process is torn down. */
async function main(): Promise<void> {
  const config = loadConfig();

  const bridge = new BridgeSocketServer(config.socket);
  await bridge.start();

  // Persistent debug state: error ring buffer + on-disk event log next to the scratch dir.
  const eventLogPath = join(config.paths.scratchDir || ".", EVENT_LOG_NAME);
  const debug = new DebugStore(eventLogPath);

  // Feed every pushed event into the live buffer, the persistent log (when recording), and — for error
  // frames — the structured error buffer.
  const events = new EventBuffer();
  bridge.onEvent((event) => {
    events.record(event);
    void debug.persistEvent(event);
    if (event.action === ERROR_EVENT_ACTION) {
      debug.recordError(event.payload);
    }
  });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerBridgeTools(server, bridge);
  registerTelemetryTools(server, bridge, events);
  registerBuildTools(server, config, bridge);
  registerFileTools(server, config);
  registerDebugTools(server, bridge, debug);

  // Scratch subsystem: wipe the scratch dir on startup (the real zero-trace backstop against crash orphans),
  // then register the tools.
  const scratch = new ScratchManager(config, bridge);
  if (config.paths.scratchDir) {
    await scratch.wipe();
  }
  registerScratchTools(server, scratch);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP server ready over stdio", { name: SERVER_NAME, version: SERVER_VERSION });

  registerShutdown(bridge, scratch);
}

/** Wire process signals to a clean shutdown: kill scratch scripts, wipe scratch dir, stop the socket. */
function registerShutdown(bridge: BridgeSocketServer, scratch: ScratchManager): void {
  const shutdown = async (signal: string) => {
    log.info("Shutting down", { signal });
    try {
      // Session-close cleanup for scratch scripts (kill + wipe); the startup wipe is the backstop for crashes.
      await scratch.killAll();
      await scratch.wipe();
    } catch (err) {
      log.error("Error cleaning up scratch on shutdown", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await bridge.stop();
    } catch (err) {
      log.error("Error during shutdown", { message: err instanceof Error ? err.message : String(err) });
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// =========================================================================================================
// Entry Point
// =========================================================================================================

main().catch((err) => {
  log.error("Fatal error during startup", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
