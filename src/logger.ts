// =========================================================================================================
// Logger
// =========================================================================================================
// Structured logging to stderr. stdout is reserved for the MCP stdio transport (JSON-RPC frames), so every
// diagnostic line the server emits must go to stderr to avoid corrupting the protocol stream.

// =========================================================================================================
// Types
// =========================================================================================================

type LogLevel = "debug" | "info" | "warn" | "error";

// =========================================================================================================
// Helpers
// =========================================================================================================

/** Format a single structured log line as timestamped, level-tagged text. */
function format(level: LogLevel, scope: string, message: string, extra?: unknown): string {
  const time = new Date().toISOString();
  const base = `${time} [${level.toUpperCase()}] (${scope}) ${message}`;
  if (extra === undefined) {
    return base;
  }
  try {
    return `${base} ${JSON.stringify(extra)}`;
  } catch {
    return `${base} ${String(extra)}`;
  }
}

/** Write a line to stderr at the given level. */
function emit(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  process.stderr.write(`${format(level, scope, message, extra)}\n`);
}

// =========================================================================================================
// Main
// =========================================================================================================

/** Create a scoped logger. The scope tag identifies the subsystem in every line it emits. */
export function createLogger(scope: string) {
  return {
    debug: (message: string, extra?: unknown) => emit("debug", scope, message, extra),
    info: (message: string, extra?: unknown) => emit("info", scope, message, extra),
    warn: (message: string, extra?: unknown) => emit("warn", scope, message, extra),
    error: (message: string, extra?: unknown) => emit("error", scope, message, extra),
  };
}

export type Logger = ReturnType<typeof createLogger>;
