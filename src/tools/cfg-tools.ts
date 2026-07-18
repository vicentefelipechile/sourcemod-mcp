// =========================================================================================================
// CFG Tools
// =========================================================================================================
// Dedicated tools for manipulating server config (.cfg) files, scoped to the cfg root via the path guard.
// Editing a .cfg by hand through write_file means round-tripping the whole file just to flip one cvar; these
// tools understand the ConVar-per-line format so the model can read/set a single cvar without disturbing the
// rest of the file (comments, ordering, unrelated cvars). `cfg_exec` then applies a cfg live via the bridge
// (RCON fallback), closing the edit -> apply loop without a server restart.

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "../config.js";
import type { BridgeSocketServer } from "../socket-server.js";
import { resolveWithinRoots, type NamedRoot } from "../path-guard.js";
import { createLogger } from "../logger.js";
import { jsonContent, textContent, errorContent, errMessage, execViaBridgeOrRcon } from "./shared.js";

// =========================================================================================================
// Constants
// =========================================================================================================

const log = createLogger("cfg");

const CFG_EXTENSION = ".cfg";

const CVAR_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

// =========================================================================================================
// Types
// =========================================================================================================

interface CvarLine {
  lineIndex: number;
  name: string;
  value: string;
}

// =========================================================================================================
// Helpers
// =========================================================================================================

function cfgRoots(config: Config): NamedRoot[] {
  return [{ name: "cfg", path: config.paths.cfgDir }];
}

function assertCfgPath(path: string): void {
  if (!path.toLowerCase().endsWith(CFG_EXTENSION)) {
    throw new Error(`"${path}" is not a .cfg file; cfg tools only operate on .cfg files.`);
  }
}

function formatCvarValue(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// The last uncommented assignment wins, mirroring how the engine applies a cfg top to bottom.
function findCvar(lines: string[], name: string): CvarLine | null {
  const target = name.toLowerCase();
  let found: CvarLine | null = null;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped === "" || stripped.startsWith("//")) {
      continue;
    }
    const match = stripped.match(/^(\S+)\s*(.*)$/);
    if (!match) {
      continue;
    }
    if (match[1].toLowerCase() === target) {
      found = { lineIndex: i, name: match[1], value: unquote(match[2]) };
    }
  }
  return found;
}

// =========================================================================================================
// Main
// =========================================================================================================

export function registerCfgTools(server: McpServer, config: Config, bridge: BridgeSocketServer): void {
  const roots = () => cfgRoots(config);

  server.registerTool(
    "cfg_list",
    {
      title: "List CFGs",
      description:
        "List .cfg files under the server's cfg directory (recurses one level into subfolders like " +
        "sourcemod/). Use to discover which configs exist before reading or editing one.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Subdirectory within the cfg root to list. Defaults to the cfg root."),
      },
    },
    async ({ path }) => {
      try {
        const { absolutePath, root } = resolveWithinRoots(path ?? ".", roots());
        const entries = await readdir(absolutePath, { withFileTypes: true });
        const files = entries
          .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(CFG_EXTENSION))
          .map((e) => e.name);
        const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
        return jsonContent({ path: absolutePath, root: root.name, cfgs: files, subdirs: dirs });
      } catch (err) {
        return errorContent(errMessage(err));
      }
    },
  );

  server.registerTool(
    "cfg_read",
    {
      title: "Read CFG",
      description:
        "Read a .cfg file's full contents from the cfg directory. Use to inspect a config before editing " +
        "cvars or rewriting it.",
      inputSchema: {
        path: z.string().min(1).describe("Path to the .cfg, relative to the cfg root or absolute within it."),
      },
    },
    async ({ path }) => {
      try {
        assertCfgPath(path);
        const { absolutePath } = resolveWithinRoots(path, roots());
        const content = await readFile(absolutePath, "utf8");
        return textContent(content);
      } catch (err) {
        return errorContent(errMessage(err));
      }
    },
  );

  server.registerTool(
    "cfg_write",
    {
      title: "Write CFG",
      description:
        "Write a .cfg file's full contents to the cfg directory, creating parent folders as needed. Use to " +
        "create a new config or fully replace one. To change a single cvar in an existing file, prefer " +
        "cfg_set_cvar so comments and other settings are preserved.",
      inputSchema: {
        path: z.string().min(1).describe("Path to the .cfg, relative to the cfg root or absolute within it."),
        content: z.string().describe("Full contents to write."),
      },
    },
    async ({ path, content }) => {
      try {
        assertCfgPath(path);
        const { absolutePath, root } = resolveWithinRoots(path, roots());
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content, "utf8");
        log.info("Wrote cfg", { path: absolutePath, bytes: content.length });
        return jsonContent({ ok: true, path: absolutePath, root: root.name, bytes: content.length });
      } catch (err) {
        return errorContent(errMessage(err));
      }
    },
  );

  server.registerTool(
    "cfg_get_cvar",
    {
      title: "Get CFG ConVar",
      description:
        "Read the value of a single cvar from a .cfg file without dumping the whole file. Returns the " +
        "current value (the last uncommented assignment wins, matching how the engine applies a cfg), or " +
        "reports that the cvar is not set.",
      inputSchema: {
        path: z.string().min(1).describe("Path to the .cfg, relative to the cfg root or absolute within it."),
        cvar: z.string().min(1).describe('The cvar name, e.g. "sv_cheats" or "mp_friendlyfire".'),
      },
    },
    async ({ path, cvar }) => {
      try {
        assertCfgPath(path);
        const { absolutePath } = resolveWithinRoots(path, roots());
        const lines = (await readFile(absolutePath, "utf8")).split(/\r?\n/);
        const found = findCvar(lines, cvar);
        if (!found) {
          return jsonContent({ found: false, cvar, path: absolutePath });
        }
        return jsonContent({ found: true, cvar: found.name, value: found.value, line: found.lineIndex + 1 });
      } catch (err) {
        return errorContent(errMessage(err));
      }
    },
  );

  server.registerTool(
    "cfg_set_cvar",
    {
      title: "Set CFG ConVar",
      description:
        "Set a cvar's value in a .cfg file in place, preserving comments, ordering, and every other cvar. " +
        "Updates the existing assignment if present; otherwise appends it. This is the safe way to tweak one " +
        "setting — prefer it over cfg_write for single-value edits. Does not apply the change live; run " +
        "cfg_exec (or reload the map) afterwards to activate it.",
      inputSchema: {
        path: z.string().min(1).describe("Path to the .cfg, relative to the cfg root or absolute within it."),
        cvar: z.string().min(1).describe('The cvar name, e.g. "sv_cheats" or "mp_friendlyfire".'),
        value: z.string().describe("The value to set. Quoting is added automatically when it contains spaces."),
      },
    },
    async ({ path, cvar, value }) => {
      try {
        assertCfgPath(path);
        if (!CVAR_NAME_PATTERN.test(cvar)) {
          return errorContent(`"${cvar}" is not a valid cvar name (expected letters, digits, underscores).`);
        }
        const { absolutePath } = resolveWithinRoots(path, roots());

        let existing = "";
        try {
          existing = await readFile(absolutePath, "utf8");
        } catch {
          // No file yet: cfg_set_cvar doubles as create-with-one-cvar. mkdir below handles the parent dir.
        }

        const usesCrlf = existing.includes("\r\n");
        const newline = usesCrlf ? "\r\n" : "\n";
        const lines = existing === "" ? [] : existing.split(/\r?\n/);
        const formatted = `${cvar} ${formatCvarValue(value)}`;

        const found = findCvar(lines, cvar);
        let mutation: "updated" | "appended";
        let previousValue: string | undefined;
        if (found) {
          previousValue = found.value;
          lines[found.lineIndex] = formatted;
          mutation = "updated";
        } else {
          // Drop a trailing empty line so the append lands cleanly, then re-terminate the file.
          if (lines.length > 0 && lines[lines.length - 1] === "") {
            lines.pop();
          }
          lines.push(formatted);
          mutation = "appended";
        }

        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, lines.join(newline) + newline, "utf8");
        log.info("Set cvar in cfg", { path: absolutePath, cvar, mutation });
        return jsonContent({ ok: true, path: absolutePath, cvar, value, mutation, previousValue });
      } catch (err) {
        return errorContent(errMessage(err));
      }
    },
  );

  server.registerTool(
    "cfg_exec",
    {
      title: "Exec CFG",
      description:
        "Apply a .cfg live by running the server's exec command, so edits take effect without a map change " +
        "or restart. Prefers the bridge (structured, in-process) and falls back to RCON when the bridge is " +
        "not connected. Pass the cfg name as the engine expects it (relative to the cfg dir, .cfg optional).",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe('CFG name to exec, e.g. "server" or "sourcemod/myplugin". The .cfg suffix is optional.'),
      },
    },
    async ({ name }) => {
      try {
        return jsonContent(await execViaBridgeOrRcon(config, bridge, `exec ${name}`));
      } catch (err) {
        return errorContent(errMessage(err));
      }
    },
  );
}
