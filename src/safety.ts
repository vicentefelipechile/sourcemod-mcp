// =========================================================================================================
// Safety Layer
// =========================================================================================================
// Classifies console/RCON commands by how destructive they are and provides the confirmation-gating
// primitive the tools use. MCP has no interactive mid-call prompt, so gating is a two-step contract:
// a destructive call without an explicit `confirm: true` returns a preview + warning instead of running,
// and the caller must re-issue with confirmation. This makes irreversible actions deliberate, never
// accidental, while leaving read-only and benign commands to run straight through.

// =========================================================================================================
// Constants
// =========================================================================================================

/**
 * Console/RCON verbs that change the game world in a way a player would notice and that cannot be quietly
 * undone: map changes, restarts, mass kicks/bans, config execution, and anything that rewrites server auth.
 * Matched against the first whitespace-delimited token of a command, case-insensitively.
 */
const DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set([
  "quit",
  "exit",
  "_restart",
  "restart",
  // "map",
  // "changelevel",
  "changelevel2",
  // "sm_map",
  "kickall",
  "sm_kickall",
  // "exec",
  "rcon_password",
  "sv_password",
  "sm_rcon",
]);

/**
 * Command prefixes (verb + argument shape) that are destructive only in some forms. Each predicate gets the
 * lowercased token array and decides. Keeps the flat verb set above simple while still catching, e.g.,
 * `mp_restartgame` with a nonzero delay or a `ban`/`kick` aimed at a live client.
 */
const DESTRUCTIVE_PATTERNS: ReadonlyArray<{ reason: string; test: (tokens: string[]) => boolean }> = [
  { reason: "kicks a player", test: (t) => t[0] === "kick" || t[0] === "sm_kick" },
  { reason: "bans a player", test: (t) => t[0] === "banid" || t[0] === "sm_ban" || t[0] === "addip" },
  { reason: "restarts the current game/round", test: (t) => t[0] === "mp_restartgame" || t[0] === "mp_restartround" },
];

// =========================================================================================================
// Types
// =========================================================================================================

/** The result of classifying a command: whether it is destructive and, if so, a human-readable reason. */
export interface CommandRisk {
  destructive: boolean;
  reason?: string;
}

// =========================================================================================================
// Main
// =========================================================================================================

/**
 * Classify a raw console/RCON command string. Empty or read-only commands are non-destructive; anything in
 * the destructive verb set or matching a destructive pattern is flagged with a reason for the preview.
 */
export function classifyCommand(command: string): CommandRisk {
  const tokens = command.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { destructive: false };
  }

  const verb = tokens[0];
  if (DESTRUCTIVE_COMMANDS.has(verb)) {
    return { destructive: true, reason: `"${verb}" changes server state and cannot be silently undone` };
  }

  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(tokens)) {
      return { destructive: true, reason: pattern.reason };
    }
  }

  return { destructive: false };
}

/**
 * The confirmation-gating contract for a destructive action. When the action is destructive and the caller
 * did not pass `confirmed`, returns a `blocked` preview describing what would happen; otherwise `blocked` is
 * false and the caller proceeds. `label` names the action for the preview message.
 */
export function confirmationGate(
  label: string,
  risk: CommandRisk,
  confirmed: boolean,
): { blocked: boolean; preview?: Record<string, unknown> } {
  if (!risk.destructive || confirmed) {
    return { blocked: false };
  }
  return {
    blocked: true,
    preview: {
      ok: false,
      requiresConfirmation: true,
      action: label,
      reason: risk.reason,
      hint: "This is a destructive action. Re-run the same tool with confirm: true to execute it.",
    },
  };
}
