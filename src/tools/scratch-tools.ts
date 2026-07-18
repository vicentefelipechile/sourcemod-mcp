// =========================================================================================================
// Scratch Tools
// =========================================================================================================
// The Claude-facing surface of the scratch scripting subsystem (Route A): write-and-run ephemeral one-off
// micro-plugins that auto-clean with zero trace.
//   run_scratch        compile+load a micro-plugin from source, return a scratch id
//   list_scratch       list currently loaded scratch scripts
//   kill_scratch       unload+delete one scratch script
//   kill_all_scratch   unload+delete every scratch script
//   promote_scratch    copy a scratch script's source out into a persistent standalone plugin (Route B)
// run_scratch returns parsed compile diagnostics on failure so Claude can auto-correct and retry (with a cap
// applied by the caller, not here).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ScratchManager } from "../scratch-manager.js";

// =========================================================================================================
// Helpers
// =========================================================================================================

function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorContent(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

// =========================================================================================================
// Main
// =========================================================================================================

/** Register the scratch scripting tools. */
export function registerScratchTools(server: McpServer, scratch: ScratchManager): void {
  // --- run_scratch ---
  server.registerTool(
    "run_scratch",
    {
      title: "Run Scratch Script",
      description:
        "Compile and hot-load an ephemeral one-off SourcePawn micro-plugin from the source you provide, to " +
        "an isolated scratch dir, and return a scratch id. For arbitrary one-off behavior no command covers " +
        "that should be thrown away. On compile failure it returns structured diagnostics so you can fix the " +
        "source and call again. The script is zero-trace: it auto-cleans on kill, session close, or restart.",
      inputSchema: {
        description: z
          .string()
          .min(1)
          .describe("Short human-readable description of what this one-off does (shown in list_scratch)."),
        source: z
          .string()
          .min(1)
          .describe("Complete SourcePawn .sp source for the micro-plugin, including includes and OnPluginStart."),
      },
    },
    async ({ description, source }) => {
      try {
        const result = await scratch.run(description, source);
        return jsonContent(result);
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- list_scratch ---
  server.registerTool(
    "list_scratch",
    {
      title: "List Scratch Scripts",
      description: "List the scratch scripts currently loaded, with their ids and descriptions.",
      inputSchema: {},
    },
    async () => {
      const scripts = scratch.list();
      return jsonContent({ count: scripts.length, scripts });
    },
  );

  // --- kill_scratch ---
  server.registerTool(
    "kill_scratch",
    {
      title: "Kill Scratch Script",
      description:
        "Unload one scratch script by id and delete its .sp and .smx from scratch. Ends a one-off on demand.",
      inputSchema: {
        id: z.string().min(1).describe("The scratch id returned by run_scratch."),
      },
    },
    async ({ id }) => {
      const killed = await scratch.kill(id);
      if (!killed) {
        return errorContent(`No scratch script with id ${id}.`);
      }
      return jsonContent({ ok: true, killed: id });
    },
  );

  // --- kill_all_scratch ---
  server.registerTool(
    "kill_all_scratch",
    {
      title: "Kill All Scratch Scripts",
      description: "Unload every scratch script and delete all their files at once. Clears everything ephemeral.",
      inputSchema: {},
    },
    async () => {
      const count = await scratch.killAll();
      return jsonContent({ ok: true, killed: count });
    },
  );

  // --- promote_scratch ---
  server.registerTool(
    "promote_scratch",
    {
      title: "Promote Scratch Script",
      description:
        "Move a scratch script out of scratch into the real scripting dir as a persistent standalone plugin " +
        "source (Route B). The rare case where a throwaway turned out worth keeping. Explicit only — scratch " +
        "never persists on its own. The ephemeral instance is then cleaned up.",
      inputSchema: {
        id: z.string().min(1).describe("The scratch id to promote."),
        name: z.string().min(1).describe("File name (without extension) for the new standalone plugin source."),
      },
    },
    async ({ id, name }) => {
      const result = await scratch.promote(id, name);
      if (!result.ok) {
        return errorContent(result.error ?? "Promotion failed.");
      }
      return jsonContent(result);
    },
  );
}
