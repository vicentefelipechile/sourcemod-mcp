// =========================================================================================================
// SourcePawn Compiler
// =========================================================================================================
// Wraps the spcomp binary: invoke it on a .sp file, parse its stdout/stderr into structured errors and
// warnings, and return the resolved .smx path. The parsed diagnostics are what let Claude react to compile
// failures precisely instead of scraping raw text. Shared by the compile tool (Phase 5) and the scratch
// scripting subsystem (Phase 8).

import { spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { access } from "node:fs/promises";

import { createLogger } from "./logger.js";
import type { CompilerConfig } from "./config.js";

// =========================================================================================================
// Constants
// =========================================================================================================

/** Matches an spcomp diagnostic line: "path(line -- col?) : error/warning NNN: message". */
const DIAGNOSTIC_REGEX = /^(.*?)\((\d+)(?:\s*--\s*\d+)?\)\s*:\s*(error|warning|fatal error)\s+(\d+):\s*(.*)$/;

/** Time budget for a single compile before it is killed. */
const COMPILE_TIMEOUT_MS = 30_000;

const log = createLogger("compiler");

// =========================================================================================================
// Types
// =========================================================================================================

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  file: string;
  line: number;
  code: string;
  message: string;
}

export interface CompileOptions {
  /** Extra include directories passed to spcomp as -i, in addition to the SourceMod default include dir. */
  includeDirs?: string[];
  /** Output .smx path. Defaults to the source path with a .smx extension in the same directory. */
  outputPath?: string;
}

export interface CompileResult {
  ok: boolean;
  smxPath: string | null;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** Raw combined compiler output, kept for cases the parser does not cover. */
  raw: string;
}

// =========================================================================================================
// Helpers
// =========================================================================================================

/** Parse combined spcomp output into structured diagnostics. */
function parseDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC_REGEX.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, file, lineNo, rawSeverity, code, message] = match;
    diagnostics.push({
      severity: rawSeverity === "warning" ? "warning" : "error",
      file: file.trim(),
      line: Number.parseInt(lineNo, 10),
      code,
      message: message.trim(),
    });
  }
  return diagnostics;
}

/** Resolve the default .smx output path next to a source file. */
function defaultOutputPath(sourcePath: string): string {
  const dir = dirname(sourcePath);
  const name = basename(sourcePath).replace(/\.sp$/i, "");
  return join(dir, `${name}.smx`);
}

/** Run spcomp and collect its combined output plus exit code. */
function runSpcomp(bin: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(bin, args, { windowsHide: true });
    let output = "";

    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const timer = setTimeout(() => {
      child.kill();
      output += `\nspcomp timed out after ${COMPILE_TIMEOUT_MS}ms`;
    }, COMPILE_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ code: null, output: `${output}\nFailed to spawn spcomp: ${err.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, output });
    });
  });
}

// =========================================================================================================
// Main
// =========================================================================================================

/** Compile a .sp source file, returning structured diagnostics and the resolved .smx path on success. */
export async function compileSource(
  config: CompilerConfig,
  sourcePath: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const bin = config.spcompBin;
  if (!bin) {
    throw new Error("SM_SPCOMP_BIN is not configured; cannot compile.");
  }

  const source = resolve(sourcePath);
  try {
    await access(source);
  } catch {
    throw new Error(`Source file not found: ${source}`);
  }

  const outputPath = options.outputPath ? resolve(options.outputPath) : defaultOutputPath(source);

  // spcomp ships with a default include dir alongside the binary; add any caller-supplied dirs on top.
  const includeArgs = (options.includeDirs ?? []).map((dir) => `-i${resolve(dir)}`);
  const args = [source, ...includeArgs, `-o${outputPath}`];

  log.info("Compiling", { source, outputPath });
  const { code, output } = await runSpcomp(bin, args);

  const diagnostics = parseDiagnostics(output);
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  // Success requires a clean exit and that the .smx actually landed.
  let smxExists = false;
  try {
    await access(outputPath);
    smxExists = true;
  } catch {
    smxExists = false;
  }

  const ok = code === 0 && errors.length === 0 && smxExists;
  return {
    ok,
    smxPath: ok ? outputPath : null,
    errors,
    warnings,
    raw: output.trim(),
  };
}
