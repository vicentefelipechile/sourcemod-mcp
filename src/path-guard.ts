// =========================================================================================================
// Path Guard
// =========================================================================================================
// File tools operate only within whitelisted roots (scripting, cfg, plugins, scratch). This guard resolves a
// requested path to an absolute path and confirms it lies inside one of those roots, blocking traversal
// escapes (../) and absolute paths that point elsewhere. Every file tool routes through resolveWithinRoots
// before touching the filesystem.

import { relative, resolve, sep } from "node:path";

// =========================================================================================================
// Types
// =========================================================================================================

/** A named whitelisted root a path may resolve under. */
export interface NamedRoot {
  name: string;
  path: string;
}

// =========================================================================================================
// Helpers
// =========================================================================================================

/** True when child resolves to root itself or something strictly inside it. */
function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  // Outside if the relative path climbs out (starts with ..) or is an absolute path on another drive.
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsoluteEscape(rel));
}

/** Detect a relative() result that is actually absolute (e.g. different Windows drive), which means outside. */
function isAbsoluteEscape(rel: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(rel);
}

// =========================================================================================================
// Main
// =========================================================================================================

/**
 * Resolve requestedPath against the whitelisted roots. If a relative path is given it is resolved under the
 * first configured root; an absolute path is used as-is. The result must land inside at least one root or an
 * error is thrown. Returns the resolved absolute path and the root it matched.
 */
export function resolveWithinRoots(
  requestedPath: string,
  roots: NamedRoot[],
): { absolutePath: string; root: NamedRoot } {
  const configured = roots.filter((r) => r.path !== "");
  if (configured.length === 0) {
    throw new Error("No file roots are configured; file tools are disabled.");
  }

  // Relative paths anchor to the first root; absolute paths resolve to themselves.
  const base = configured[0].path;
  const absolutePath = resolve(base, requestedPath);

  for (const root of configured) {
    if (isInside(resolve(root.path), absolutePath)) {
      return { absolutePath, root };
    }
  }

  const allowed = configured.map((r) => `${r.name} (${r.path})`).join(", ");
  throw new Error(`Path "${requestedPath}" resolves outside all whitelisted roots. Allowed: ${allowed}`);
}
