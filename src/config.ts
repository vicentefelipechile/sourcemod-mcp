// =========================================================================================================
// Configuration
// =========================================================================================================
// Loads all runtime configuration from a JSON file (see config.example.json). Everything the MCP needs to
// know about the local machine — socket port, filesystem roots, compiler binary, RCON creds — is resolved
// here once at startup so the rest of the code depends on a single typed config object.
//
// The config file is resolved in this order:
//   1. An explicit path passed as the first CLI argument (`node dist/index.js C:/path/config.json`).
//   2. The SM_MCP_CONFIG environment variable.
//   3. `config.json` next to the project root (the parent of dist/).
// Any field may be omitted; documented defaults apply. Relative paths resolve against the process CWD.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// =========================================================================================================
// Constants
// =========================================================================================================

const DEFAULT_SOCKET_HOST = "127.0.0.1";
const DEFAULT_SOCKET_PORT = 27100;
const DEFAULT_RCON_HOST = "127.0.0.1";
const DEFAULT_RCON_PORT = 27015;
const DEFAULT_SCRATCH_DIR = "./scratch";

/** Config file name looked up next to the project root when no explicit path is given. */
const DEFAULT_CONFIG_NAME = "config.json";

/** Lockfile name, written next to the scratch dir. */
const LOCKFILE_NAME = "mcp.lock";

// =========================================================================================================
// Types
// =========================================================================================================

export interface SocketConfig {
  host: string;
  port: number;
  /** PID lockfile path; lets a new instance recognize and replace a stale predecessor holding the port. */
  lockfilePath: string;
}

export interface PathsConfig {
  gameRoot: string;
  scriptingDir: string;
  pluginsDir: string;
  cfgDir: string;
  scratchDir: string;
}

export interface CompilerConfig {
  spcompBin: string;
}

export interface RconConfig {
  host: string;
  port: number;
  password: string;
}

export interface Config {
  socket: SocketConfig;
  paths: PathsConfig;
  compiler: CompilerConfig;
  rcon: RconConfig;
}

/** Shape of the on-disk config.json. Every field is optional; defaults fill the gaps. */
interface RawConfig {
  socket?: { host?: string; port?: number };
  paths?: {
    gameRoot?: string;
    scriptingDir?: string;
    pluginsDir?: string;
    cfgDir?: string;
    scratchDir?: string;
  };
  compiler?: { spcompBin?: string };
  rcon?: { host?: string; port?: number; password?: string };
}

// =========================================================================================================
// Helpers
// =========================================================================================================

/** Coerce a config value to a trimmed string, falling back to a default. Empty strings count as unset. */
function asStr(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  return value.trim();
}

// Throws on an out-of-range port rather than silently falling back, so a typo'd port fails loudly.
function asPort(value: unknown, key: string, fallback: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port in ${key}: ${String(value)}`);
  }
  return parsed;
}

/** Resolve a path value to an absolute path, or return "" when unset (path-scoped tools guard on this). */
function asPath(value: unknown, fallback = ""): string {
  const raw = asStr(value, fallback);
  return raw === "" ? "" : resolve(raw);
}

/** Locate the config file: CLI arg, then SM_MCP_CONFIG, then config.json at the project root. */
function resolveConfigPath(): string {
  const fromArg = process.argv[2];
  if (fromArg && fromArg.trim() !== "") {
    return resolve(fromArg.trim());
  }
  const fromEnv = process.env.SM_MCP_CONFIG;
  if (fromEnv && fromEnv.trim() !== "") {
    return resolve(fromEnv.trim());
  }
  // Project root is the parent of the dir holding this compiled module (dist/).
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", DEFAULT_CONFIG_NAME);
}

function readRawConfig(path: string): RawConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Config file not found at ${path}. Copy config.example.json to config.json (or set SM_MCP_CONFIG).`,
    );
  }
  try {
    return JSON.parse(text) as RawConfig;
  } catch (err) {
    throw new Error(`Config file at ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

// =========================================================================================================
// Main
// =========================================================================================================

export function loadConfig(): Config {
  const path = resolveConfigPath();
  const raw = readRawConfig(path);
  const scratchDir = asPath(raw.paths?.scratchDir, DEFAULT_SCRATCH_DIR);

  return {
    socket: {
      host: asStr(raw.socket?.host, DEFAULT_SOCKET_HOST),
      port: asPort(raw.socket?.port, "socket.port", DEFAULT_SOCKET_PORT),
      lockfilePath: join(scratchDir, LOCKFILE_NAME),
    },
    paths: {
      gameRoot: asPath(raw.paths?.gameRoot),
      scriptingDir: asPath(raw.paths?.scriptingDir),
      pluginsDir: asPath(raw.paths?.pluginsDir),
      cfgDir: asPath(raw.paths?.cfgDir),
      scratchDir,
    },
    compiler: {
      spcompBin: asPath(raw.compiler?.spcompBin),
    },
    rcon: {
      host: asStr(raw.rcon?.host, DEFAULT_RCON_HOST),
      port: asPort(raw.rcon?.port, "rcon.port", DEFAULT_RCON_PORT),
      password: asStr(raw.rcon?.password, ""),
    },
  };
}
