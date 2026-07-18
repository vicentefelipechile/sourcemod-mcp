# AGENTS.md

Behavioral guidance for AI agents driving this SourceMod MCP server. This complements the tool
descriptions (which the model reads at call time) and the README (which is human-facing reference).

## Running console commands

- **Prefer `send_intent` with the `console` action over `rcon_exec`.** `send_intent` runs the command
  in-process through the bridge plugin, has the full SourceMod API available, and returns cleaner,
  structured output. `rcon_exec` is a **fallback** for when the bridge plugin is not connected.
- Check `bridge_status` if unsure whether the bridge is up. Only reach for `rcon_exec` when it reports
  the bridge is disconnected.
- For anything with a typed action (`ping`, `query_state`, `plugins`, ...), use that action rather than
  a raw `console` command — it is validated by the plugin.

## Editing config (.cfg) files

- Use the dedicated `cfg_*` tools, not `read_file` / `write_file`, when working with `.cfg` files.
- To change a single cvar, use **`cfg_set_cvar`** — it edits in place and preserves comments, ordering,
  and every other cvar. Do not rewrite the whole file with `cfg_write` just to flip one value.
- Use `cfg_get_cvar` to read one value, `cfg_read` to inspect the whole file, `cfg_list` to discover
  configs.
- Editing a `.cfg` does not apply it live. After editing, run **`cfg_exec`** (or reload the map) to
  activate the change.

## Safety

- Destructive console/RCON commands are gated: a call without `confirm: true` returns a preview and does
  not run. Re-issue with `confirm: true` to execute. This applies to `rcon_exec` and the `console`
  action of `send_intent`. See `src/safety.ts` for the classification.
- All filesystem/cfg tools are confined to whitelisted roots; paths outside them are rejected.
