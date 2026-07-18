// =========================================================================================================
// RCON Fallback
// =========================================================================================================
// A thin wrapper over rcon-srcds used as the fallback control path: when the bridge plugin is not loaded or
// not connected, raw console commands still reach the server over RCON. Each call opens, authenticates, runs,
// and closes so a dropped RCON session never leaves a stale connection around.

import { createLogger } from "./logger.js";
import type { RconConfig } from "./config.js";

// =========================================================================================================
// Constants
// =========================================================================================================

const log = createLogger("rcon");

// =========================================================================================================
// Main
// =========================================================================================================

/** Run a single console command over RCON and return its textual response. Throws on connect/auth failure. */
export async function rconExec(config: RconConfig, command: string): Promise<string> {
  if (!config.password) {
    throw new Error("SM_RCON_PASSWORD is not configured; RCON fallback is unavailable.");
  }

  // rcon-srcds is CJS-first; import dynamically so the ESM build stays clean.
  // Depending on the interop layer the constructor lands one or two `default`s deep,
  // so unwrap until we hit the callable.
  const module = await import("rcon-srcds");
  const unwrap = (m: unknown): unknown =>
    m && typeof m === "object" && "default" in m ? unwrap((m as { default: unknown }).default) : m;
  const Rcon = unwrap(module) as unknown as new (opts: {
    host: string;
    port: number;
  }) => {
    authenticate(password: string): Promise<void>;
    execute(command: string): Promise<string>;
    disconnect(): Promise<void> | void;
  };

  const conn = new Rcon({ host: config.host, port: config.port });
  try {
    await conn.authenticate(config.password);
    const response = await conn.execute(command);
    return typeof response === "string" ? response : String(response);
  } catch (err) {
    log.error("RCON command failed", { message: err instanceof Error ? err.message : String(err) });
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    try {
      await conn.disconnect();
    } catch {
      // Best-effort close; the command result already returned.
    }
  }
}
