// =========================================================================================================
// Build & Deploy Tools
// =========================================================================================================
// The plugin build/deploy chain, all local process/file work plus live lifecycle control:
//   compile        invoke spcomp, return parsed diagnostics + the .smx path
//   deploy         copy a compiled .smx into the plugins directory
//   load/unload/reload_plugin   manage plugin lifecycle live via the bridge's plugins intent, RCON fallback
//   rcon_exec      run a raw console command over RCON (works without the bridge)
// Lifecycle prefers the socket path (structured result, in-process) and falls back to RCON when the bridge
// is down, so a freshly deployed plugin can be applied without restarting the server.

import { basename, join } from "node:path";
import { copyFile, mkdir } from "node:fs/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "../config.js";
import type { BridgeSocketServer } from "../socket-server.js";
import { compileSource } from "../compiler.js";
import { rconExec } from "../rcon.js";
import { classifyCommand, confirmationGate } from "../safety.js";
import { createLogger } from "../logger.js";

// =========================================================================================================
// Constants
// =========================================================================================================

const log = createLogger("build");

/** Lifecycle operations exposed as distinct tools, mapped to the plugin's plugins-intent op. */
const LIFECYCLE_OPS = ["load", "unload", "reload"] as const;

// =========================================================================================================
// Helpers
// =========================================================================================================

function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorContent(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/**
 * Run a plugin lifecycle op, preferring the bridge's structured plugins intent and falling back to RCON.
 * Returns a structured result describing which path was taken.
 */
async function runLifecycle(
  config: Config,
  bridge: BridgeSocketServer,
  op: (typeof LIFECYCLE_OPS)[number],
  name: string,
) {
  if (bridge.isConnected) {
    try {
      const result = await bridge.sendIntent("plugins", { op, name }, { timeoutMs: 8_000 });
      return { via: "bridge", ...result };
    } catch (err) {
      log.warn("Bridge lifecycle failed; falling back to RCON", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const output = await rconExec(config.rcon, `sm plugins ${op} ${name}`);
  return { via: "rcon", ok: true, data: { op, name, output } };
}

// =========================================================================================================
// Main
// =========================================================================================================

/** Register the build, deploy, lifecycle, and RCON tools. */
export function registerBuildTools(server: McpServer, config: Config, bridge: BridgeSocketServer): void {
  // --- compile ---
  server.registerTool(
    "compile",
    {
      title: "Compile Plugin",
      description:
        "Invoke spcomp on a .sp source file and return structured errors and warnings plus the resolved " +
        ".smx path. Parses the compiler output so you can react to specific errors by file and line rather " +
        "than scraping raw text. The scripting include dir is added automatically.",
      inputSchema: {
        source: z.string().min(1).describe("Path to the .sp source file to compile."),
        includeDirs: z
          .array(z.string())
          .optional()
          .describe("Extra -i include directories, in addition to the project scripting include dir."),
        outputPath: z
          .string()
          .optional()
          .describe("Where to write the .smx. Defaults to the source path with a .smx extension."),
      },
    },
    async ({ source, includeDirs, outputPath }) => {
      try {
        const projectInclude = config.paths.scriptingDir
          ? [join(config.paths.scriptingDir, "include")]
          : [];
        const result = await compileSource(config.compiler, source, {
          includeDirs: [...projectInclude, ...(includeDirs ?? [])],
          outputPath,
        });
        return jsonContent(result);
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- deploy ---
  server.registerTool(
    "deploy",
    {
      title: "Deploy Plugin",
      description:
        "Copy a compiled .smx into the plugins directory so it can be loaded. A local file operation; run " +
        "after a successful compile. Returns the destination path.",
      inputSchema: {
        smxPath: z.string().min(1).describe("Path to the compiled .smx to deploy."),
        destName: z
          .string()
          .optional()
          .describe("Override the destination file name. Defaults to the source file name."),
      },
    },
    async ({ smxPath, destName }) => {
      if (!config.paths.pluginsDir) {
        return errorContent("SM_PLUGINS_DIR is not configured; cannot deploy.");
      }
      try {
        await mkdir(config.paths.pluginsDir, { recursive: true });
        const target = join(config.paths.pluginsDir, destName ?? basename(smxPath));
        await copyFile(smxPath, target);
        log.info("Deployed plugin", { from: smxPath, to: target });
        return jsonContent({ ok: true, deployed: target });
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- lifecycle: load_plugin / unload_plugin / reload_plugin ---
  for (const op of LIFECYCLE_OPS) {
    server.registerTool(
      `${op}_plugin`,
      {
        title: `${op[0].toUpperCase()}${op.slice(1)} Plugin`,
        description:
          `${op[0].toUpperCase()}${op.slice(1)} a plugin by name live. Prefers the bridge's structured ` +
          "plugins intent and falls back to RCON when the bridge is not connected. Applies a freshly " +
          "deployed plugin without restarting the server.",
        inputSchema: {
          name: z
            .string()
            .min(1)
            .describe('Plugin file name without extension, e.g. "rounds" for rounds.smx.'),
        },
      },
      async ({ name }) => {
        try {
          const result = await runLifecycle(config, bridge, op, name);
          return jsonContent(result);
        } catch (err) {
          return errorContent(err instanceof Error ? err.message : String(err));
        }
      },
    );
  }

  // --- rcon_exec ---
  server.registerTool(
    "rcon_exec",
    {
      title: "RCON Exec",
      description:
        "Run a raw console command over RCON. Use when the bridge plugin is not loaded/connected, or for a " +
        "one-off command not worth a dedicated action. Works without the custom plugin. Destructive commands " +
        "(map/restart/kick/ban/exec/password) require confirm: true; without it the call returns a preview.",
      inputSchema: {
        command: z.string().min(1).describe("The console command to run."),
        confirm: z
          .boolean()
          .optional()
          .describe("Set true to execute a destructive command. Omit to preview what would happen first."),
      },
    },
    async ({ command, confirm }) => {
      const gate = confirmationGate("rcon_exec", classifyCommand(command), confirm ?? false);
      if (gate.blocked) {
        return jsonContent({ ...gate.preview, command });
      }
      try {
        const output = await rconExec(config.rcon, command);
        return jsonContent({ ok: true, command, output });
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
