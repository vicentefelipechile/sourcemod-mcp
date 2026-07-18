// =========================================================================================================
// Errors
// =========================================================================================================
// Error helpers shared across the whole codebase, not just the tool layer.

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
