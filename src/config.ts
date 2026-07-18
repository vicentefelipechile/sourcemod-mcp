// =========================================================================================================
// Configuration
// =========================================================================================================
// Loads all runtime configuration from environment variables (see .env.example). Everything the MCP needs
// to know about the local machine — socket port, filesystem roots, compiler binary, RCON creds — is resolved
// here once at startup so the rest of the code depends on a single typed config object.

import { resolve } from "node:path";

// =========================================================================================================
// Constants
// =========================================================================================================

const DEFAULT_SOCKET_HOST = "127.0.0.1";
const DEFAULT_SOCKET_PORT = 27100;
const DEFAULT_RCON_HOST = "127.0.0.1";
const DEFAULT_RCON_PORT = 27015;
const DEFAULT_SCRATCH_DIR = "./scratch";

// =========================================================================================================
// Types
// =========================================================================================================

export interface SocketConfig {
  host: string;
  port: number;
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

// =========================================================================================================
// Helpers
// =========================================================================================================

/** Read an env var as a string, falling back to a default. Empty strings count as unset. */
function envStr(key: string, fallback: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return value.trim();
}

/** Read an env var as an integer port, falling back to a default when unset or invalid. */
function envPort(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port in ${key}: ${raw}`);
  }
  return parsed;
}

/** Resolve a path env var to an absolute path, or return "" when unset (path-scoped tools guard on this). */
function envPath(key: string, fallback = ""): string {
  const raw = envStr(key, fallback);
  return raw === "" ? "" : resolve(raw);
}

// =========================================================================================================
// Main
// =========================================================================================================

/** Build the config object from the current process environment. Throws on malformed values. */
export function loadConfig(): Config {
  return {
    socket: {
      host: envStr("SM_MCP_SOCKET_HOST", DEFAULT_SOCKET_HOST),
      port: envPort("SM_MCP_SOCKET_PORT", DEFAULT_SOCKET_PORT),
    },
    paths: {
      gameRoot: envPath("SM_GAME_ROOT"),
      scriptingDir: envPath("SM_SCRIPTING_DIR"),
      pluginsDir: envPath("SM_PLUGINS_DIR"),
      cfgDir: envPath("SM_CFG_DIR"),
      scratchDir: envPath("SM_SCRATCH_DIR", DEFAULT_SCRATCH_DIR),
    },
    compiler: {
      spcompBin: envPath("SM_SPCOMP_BIN"),
    },
    rcon: {
      host: envStr("SM_RCON_HOST", DEFAULT_RCON_HOST),
      port: envPort("SM_RCON_PORT", DEFAULT_RCON_PORT),
      password: envStr("SM_RCON_PASSWORD", ""),
    },
  };
}
