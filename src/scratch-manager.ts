// =========================================================================================================
// Scratch Manager
// =========================================================================================================
// The ephemeral, zero-trace scratch scripting subsystem (Route A). Claude writes a micro-plugin's source,
// this manager compiles it to an isolated scratch dir, deploys+loads it live, tracks it in an active
// registry, and guarantees cleanup on all three triggers: explicit kill, session close, and (as the real
// backstop) a full scratch-dir wipe on startup and shutdown so a crash cannot leave orphans.
//
// Everything is ephemeral by invariant. Promotion to a real plugin is a separate explicit action that copies
// the source out before the scratch entry is removed.

import { randomUUID } from "node:crypto";
import { join, basename } from "node:path";
import { mkdir, writeFile, rm, copyFile, readdir } from "node:fs/promises";

import { createLogger } from "./logger.js";
import { compileSource, type CompileResult } from "./compiler.js";
import { errMessage } from "./errors.js";
import type { BridgeSocketServer } from "./socket-server.js";
import type { Config } from "./config.js";

// =========================================================================================================
// Constants
// =========================================================================================================

const log = createLogger("scratch");

/** Prefix for scratch plugin file names so they never collide with real plugins. */
const SCRATCH_PREFIX = "mcp_scratch_";

// =========================================================================================================
// Types
// =========================================================================================================

/** A live scratch script tracked in the registry. */
export interface ScratchEntry {
  id: string;
  description: string;
  /** Plugin name without extension, as SourceMod sees it (used for load/unload). */
  pluginName: string;
  sourcePath: string;
  smxPath: string;
  createdAt: string;
}

/** Public view of a scratch entry (omits absolute paths that aren't useful to Claude). */
export interface ScratchInfo {
  id: string;
  description: string;
  pluginName: string;
  createdAt: string;
}

export interface RunResult {
  ok: boolean;
  id?: string;
  info?: ScratchInfo;
  compile?: CompileResult;
  error?: string;
}

// =========================================================================================================
// Main
// =========================================================================================================

/** Owns the scratch dir, the active-script registry, and the ephemeral lifecycle. */
export class ScratchManager {
  private readonly registry = new Map<string, ScratchEntry>();

  constructor(
    private readonly config: Config,
    private readonly bridge: BridgeSocketServer,
  ) {}

  /** Public snapshot of the currently loaded scratch scripts. */
  list(): ScratchInfo[] {
    return [...this.registry.values()].map((e) => this.toInfo(e));
  }

  /**
   * Wipe the scratch dir clean and recreate it empty. Called on startup (the real zero-trace guarantee,
   * since an unclean exit won't have run graceful cleanup) and on shutdown.
   */
  async wipe(): Promise<void> {
    const dir = this.config.paths.scratchDir;
    if (!dir) {
      throw new Error("SM_SCRATCH_DIR is not configured; scratch subsystem is disabled.");
    }
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      log.error("Failed to wipe scratch dir", { message: errMessage(err) });
    }
    await mkdir(dir, { recursive: true });
    this.registry.clear();
    log.info("Scratch dir wiped", { dir });
  }

  /**
   * Compile a micro-plugin's source to scratch, deploy it into the plugins dir under a unique scratch name,
   * load it live, and register it. Returns the compile result on failure so the caller can auto-correct.
   */
  async run(description: string, source: string): Promise<RunResult> {
    const dir = this.config.paths.scratchDir;
    if (!dir) {
      return { ok: false, error: "SM_SCRATCH_DIR is not configured; scratch subsystem is disabled." };
    }
    if (!this.config.paths.pluginsDir) {
      return { ok: false, error: "SM_PLUGINS_DIR is not configured; cannot load scratch scripts." };
    }

    await mkdir(dir, { recursive: true });

    const id = randomUUID();
    const pluginName = `${SCRATCH_PREFIX}${id.replace(/-/g, "").slice(0, 12)}`;
    const sourcePath = join(dir, `${pluginName}.sp`);
    const smxScratchPath = join(dir, `${pluginName}.smx`);

    await writeFile(sourcePath, source, "utf8");

    const scriptingInclude = this.config.paths.scriptingDir
      ? [join(this.config.paths.scriptingDir, "include")]
      : [];
    const compile = await compileSource(this.config.compiler, sourcePath, {
      includeDirs: scriptingInclude,
      outputPath: smxScratchPath,
    });

    if (!compile.ok || !compile.smxPath) {
      // Zero-trace: the parsed diagnostics go back in the result, so nothing needs to stay on disk. Delete
      // the failed source and any partial .smx before returning; the caller rewrites the full source to retry.
      await this.deleteQuietly(sourcePath);
      await this.deleteQuietly(smxScratchPath);
      return { ok: false, compile, error: "Compilation failed." };
    }

    // Deploy the compiled scratch .smx into the plugins dir so SourceMod can load it, then load it live.
    const deployedSmx = join(this.config.paths.pluginsDir, `${pluginName}.smx`);
    await copyFile(compile.smxPath, deployedSmx);

    try {
      const result = await this.bridge.sendIntent("plugins", { op: "load", name: pluginName }, { timeoutMs: 8_000 });
      if (!result.ok) {
        await this.cleanupFiles(pluginName, sourcePath, smxScratchPath, deployedSmx);
        return { ok: false, error: result.error ?? "Plugin load failed." };
      }
    } catch (err) {
      await this.cleanupFiles(pluginName, sourcePath, smxScratchPath, deployedSmx);
      return { ok: false, error: errMessage(err) };
    }

    const entry: ScratchEntry = {
      id,
      description,
      pluginName,
      sourcePath,
      smxPath: deployedSmx,
      createdAt: new Date().toISOString(),
    };
    this.registry.set(id, entry);
    log.info("Scratch script loaded", { id, pluginName, description });
    return { ok: true, id, info: this.toInfo(entry), compile };
  }

  /** Unload one scratch script and delete its .sp/.smx from scratch and the deployed .smx. */
  async kill(id: string): Promise<boolean> {
    const entry = this.registry.get(id);
    if (!entry) {
      return false;
    }
    await this.unloadAndDelete(entry);
    this.registry.delete(id);
    log.info("Scratch script killed", { id, pluginName: entry.pluginName });
    return true;
  }

  /** Unload and delete every scratch script. Used on explicit kill-all and on session close. */
  async killAll(): Promise<number> {
    const entries = [...this.registry.values()];
    for (const entry of entries) {
      await this.unloadAndDelete(entry);
      this.registry.delete(entry.id);
    }
    if (entries.length > 0) {
      log.info("All scratch scripts killed", { count: entries.length });
    }
    return entries.length;
  }

  /**
   * Promote a scratch script out of scratch into a persistent standalone plugin: copy its source into the
   * scripting dir under a real name, then remove the scratch entry (its ephemeral files are cleaned up).
   */
  async promote(id: string, newName: string): Promise<{ ok: boolean; sourcePath?: string; error?: string }> {
    const entry = this.registry.get(id);
    if (!entry) {
      return { ok: false, error: `No scratch script with id ${id}.` };
    }
    if (!this.config.paths.scriptingDir) {
      return { ok: false, error: "SM_SCRIPTING_DIR is not configured; cannot promote." };
    }

    const safeName = basename(newName).replace(/\.sp$/i, "");
    const destSource = join(this.config.paths.scriptingDir, `${safeName}.sp`);
    try {
      await copyFile(entry.sourcePath, destSource);
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }

    // The scratch instance stays loaded under its scratch name; the promoted copy is a fresh standalone
    // source the caller can compile/deploy as a real plugin. Remove the ephemeral registry entry's files.
    await this.kill(id);
    log.info("Scratch script promoted", { id, to: destSource });
    return { ok: true, sourcePath: destSource };
  }

  // =======================================================================================================
  // Helpers (private)
  // =======================================================================================================

  private toInfo(entry: ScratchEntry): ScratchInfo {
    return {
      id: entry.id,
      description: entry.description,
      pluginName: entry.pluginName,
      createdAt: entry.createdAt,
    };
  }

  /** Unload the plugin (best-effort) then delete all its files. */
  private async unloadAndDelete(entry: ScratchEntry): Promise<void> {
    if (this.bridge.isConnected) {
      try {
        await this.bridge.sendIntent("plugins", { op: "unload", name: entry.pluginName }, { timeoutMs: 8_000 });
      } catch (err) {
        log.warn("Failed to unload scratch plugin; deleting files anyway", {
          pluginName: entry.pluginName,
          message: errMessage(err),
        });
      }
    }
    // Delete the deployed .smx, the scratch-dir source, and the scratch-dir .smx (same basename in scratch).
    await this.deleteQuietly(entry.smxPath);
    await this.deleteQuietly(entry.sourcePath);
    await this.deleteQuietly(join(this.config.paths.scratchDir, `${entry.pluginName}.smx`));
  }

  /** Delete files for a failed load that never made it into the registry. */
  private async cleanupFiles(pluginName: string, ...paths: string[]): Promise<void> {
    log.warn("Cleaning up failed scratch load", { pluginName });
    for (const p of paths) {
      await this.deleteQuietly(p);
    }
  }

  /** Remove a file, ignoring "not found" and logging other errors. */
  private async deleteQuietly(path: string): Promise<void> {
    try {
      await rm(path, { force: true });
    } catch (err) {
      log.error("Failed to delete scratch file", { path, message: errMessage(err) });
    }
  }

  /** List raw scratch dir contents; used by diagnostics/tests to confirm zero-trace cleanup. */
  async listScratchDir(): Promise<string[]> {
    try {
      return await readdir(this.config.paths.scratchDir);
    } catch {
      return [];
    }
  }
}
