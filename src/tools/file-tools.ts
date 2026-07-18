// =========================================================================================================
// File Tools
// =========================================================================================================
// read_file / write_file / list_dir, each scoped to the whitelisted roots (scripting, cfg, plugins, scratch)
// via the path guard. Direct filesystem access is safe here because everything is local; the guard is what
// keeps these tools from wandering outside the server's directories.

import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "../config.js";
import { resolveWithinRoots, type NamedRoot } from "../path-guard.js";
import { createLogger } from "../logger.js";

// =========================================================================================================
// Constants
// =========================================================================================================

const log = createLogger("files");

/** Cap on a single read to avoid dumping huge files into a tool response. */
const MAX_READ_BYTES = 1024 * 1024;

// =========================================================================================================
// Helpers
// =========================================================================================================

function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorContent(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/** Assemble the whitelisted roots from config, in priority order (scripting anchors relative paths). */
function fileRoots(config: Config): NamedRoot[] {
  return [
    { name: "scripting", path: config.paths.scriptingDir },
    { name: "cfg", path: config.paths.cfgDir },
    { name: "plugins", path: config.paths.pluginsDir },
    { name: "scratch", path: config.paths.scratchDir },
  ];
}

// =========================================================================================================
// Main
// =========================================================================================================

/** Register the file read/write/list tools. */
export function registerFileTools(server: McpServer, config: Config): void {
  const roots = () => fileRoots(config);

  // --- read_file ---
  server.registerTool(
    "read_file",
    {
      title: "Read File",
      description:
        "Read a UTF-8 text file scoped to the whitelisted roots (scripting, cfg, plugins, scratch). Use to " +
        "inspect configs or source before acting. Relative paths resolve under the scripting dir.",
      inputSchema: {
        path: z.string().min(1).describe("File path, relative to the scripting root or absolute within a root."),
      },
    },
    async ({ path }) => {
      try {
        const { absolutePath } = resolveWithinRoots(path, roots());
        const info = await stat(absolutePath);
        if (info.size > MAX_READ_BYTES) {
          return errorContent(`File is ${info.size} bytes, over the ${MAX_READ_BYTES}-byte read cap.`);
        }
        const content = await readFile(absolutePath, "utf8");
        return textContent(content);
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- write_file ---
  server.registerTool(
    "write_file",
    {
      title: "Write File",
      description:
        "Write a UTF-8 text file scoped to the whitelisted roots. Creates parent directories as needed. Use " +
        "to edit configs or source. Overwrites the file's full contents.",
      inputSchema: {
        path: z.string().min(1).describe("File path, relative to the scripting root or absolute within a root."),
        content: z.string().describe("Full UTF-8 contents to write."),
      },
    },
    async ({ path, content }) => {
      try {
        const { absolutePath, root } = resolveWithinRoots(path, roots());
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content, "utf8");
        log.info("Wrote file", { path: absolutePath, root: root.name, bytes: content.length });
        return jsonContent({ ok: true, path: absolutePath, root: root.name, bytes: content.length });
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- list_dir ---
  server.registerTool(
    "list_dir",
    {
      title: "List Directory",
      description:
        "List entries of a directory scoped to the whitelisted roots. Use to inspect the layout before " +
        "acting. Returns each entry with its type (file/dir) and size.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Directory path within a root. Defaults to the scripting root."),
      },
    },
    async ({ path }) => {
      try {
        const { absolutePath, root } = resolveWithinRoots(path ?? ".", roots());
        const entries = await readdir(absolutePath, { withFileTypes: true });
        const listing = await Promise.all(
          entries.map(async (entry) => {
            const type = entry.isDirectory() ? "dir" : "file";
            let size = 0;
            if (entry.isFile()) {
              try {
                size = (await stat(`${absolutePath}/${entry.name}`)).size;
              } catch {
                size = -1;
              }
            }
            return { name: entry.name, type, size };
          }),
        );
        return jsonContent({ path: absolutePath, root: root.name, entries: listing });
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
