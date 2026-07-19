// =========================================================================================================
// Instance Lockfile
// =========================================================================================================
// Lets a new MCP process recognize a predecessor holding the bridge port as specifically a prior
// sourcemod-mcp instance (not an unrelated process) and terminate it before retrying the bind.

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

import { createLogger } from "./logger.js";
import { errMessage } from "./errors.js";

// =========================================================================================================
// Constants
// =========================================================================================================

const log = createLogger("lockfile");

const KILL_WAIT_TOTAL_MS = 3_000;
const KILL_WAIT_INTERVAL_MS = 100;

// =========================================================================================================
// Helpers
// =========================================================================================================

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 probes liveness without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLivePid(path: string): number | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return null;
  }
  return isProcessAlive(pid) ? pid : null;
}

// =========================================================================================================
// Main
// =========================================================================================================

/** Terminate the predecessor named in `path`'s lockfile, if it's still alive, and wait for it to exit. */
export async function killStalePredecessor(path: string): Promise<void> {
  const pid = readLivePid(path);
  if (pid === null) {
    return;
  }

  log.warn("Killing stale predecessor MCP process holding the bridge port", { pid });
  try {
    process.kill(pid);
  } catch (err) {
    log.warn("Failed to signal stale predecessor", { pid, message: errMessage(err) });
    return;
  }

  const deadline = Date.now() + KILL_WAIT_TOTAL_MS;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, KILL_WAIT_INTERVAL_MS));
  }
}

export function writeLockfile(path: string): void {
  try {
    writeFileSync(path, String(process.pid), "utf8");
  } catch (err) {
    log.warn("Failed to write lockfile", { path, message: errMessage(err) });
  }
}

/** Only removes the file if it still names this process, so a slow shutdown can't delete a newer lock. */
export function removeLockfileIfOwn(path: string): void {
  try {
    if (readFileSync(path, "utf8").trim() === String(process.pid)) {
      unlinkSync(path);
    }
  } catch {
    // Missing or unreadable: nothing to clean up.
  }
}
