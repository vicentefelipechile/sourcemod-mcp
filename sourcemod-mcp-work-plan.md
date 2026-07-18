# SourceMod MCP Server — Work Plan (WebSocket Architecture)

## Goal
An MCP server that gives Claude general-purpose control over a local TF2/SourceMod server. Instead of relying only on RCON console strings, a custom SourceMod plugin holds a persistent socket connection to the MCP, so Claude can send structured intents and receive real-time game events back. Claude composes primitives for arbitrary tasks.

## Architecture
Two processes on the same machine, connected by a persistent local socket:

- **MCP server (TypeScript / Node)** exposes tools to Claude, runs a local socket server, invokes spcomp, edits files, and falls back to RCON when useful.
- **Bridge plugin (SourcePawn + sm-ext-socket)** runs inside the gameserver, connects to the MCP socket, receives JSON intents, executes them with the full SourceMod API (natives, hooks, forwards, not just console commands), and pushes game events back.

Because everything is local: no network latency, no public ports, direct filesystem and process access.

## Stack
- TypeScript + `@modelcontextprotocol/sdk`
- Node `net` module for the local socket server (raw TCP, framed JSON)
- `sm-ext-socket` (libuv-based, maintained) on the SourcePawn side
- `sm-ripext` optional, for JSON parsing helpers inside the plugin
- Node `child_process` for `spcomp` / `spcomp64`
- `rcon-srcds` as a fallback control path

## Wire Protocol
- Transport: local TCP socket, length-prefixed JSON frames (avoid partial-read issues)
- Message shape: `{ id, type, action, payload }`
- Directions:
  - MCP to plugin: `intent` messages (do something in-game)
  - plugin to MCP: `event` messages (game telemetry) and `result` messages (intent ack/response, correlated by `id`)
- Every intent gets a correlated result so Claude knows success/failure with structured data

---

## How It's Used

You operate in intention, not commands. You say what you want in natural language. Claude picks the right tool or chains several, checks live state before acting, executes, and reports back with structured data. The server stops being something you operate by hand and becomes something you delegate.

### Setup (once)
Start the gameserver with the bridge plugin loaded. The plugin connects to the MCP's local socket. Register the MCP in your client (Claude Code, for example). From then on you just talk.

### Use Case Catalog

**1. Live server control while playing**
> "the server feels empty, throw some action onto the other team"

Claude runs `get_live_state` (sees you're on RED, current map, 2 players), then `send_intent(console, "tf_bot_add 4 blue")`, then confirms with the structured result the plugin returned. You never typed a command.

Best when: you're in-game and want to change the match without alt-tabbing to a console.

**2. Plugin development cycle**
> "compile the rounds plugin and test it"

Claude runs `compile("rounds.sp")`. On errors it shows them parsed and stops. On success it chains `deploy`, then `reload_plugin("rounds")`, then `get_recent_events` to confirm it loaded without crashing. The whole compile-move-reload loop without leaving chat.

Best when: iterating on a plugin and you want the tedious build/deploy/reload steps handled automatically.

**3. Live debugging**
> "something's off when the round starts, take a look"

Claude runs `get_recent_events` (reads the telemetry stream: round events, deaths, errors), reasons over the real state, and tells you what it found. If it wants to confirm a fix it edits the `.sp`, recompiles, and tests.

Best when: a bug only shows up at runtime and you want Claude reasoning over real event data instead of guessing.

**4. Config editing applied live**
> "bump the round time to 10 minutes"

Claude runs `read_file` on the cfg, `write_file` with the change, then `send_intent(console, "mp_timelimit 10")` to apply it live without a restart.

Best when: tweaking server settings and you want both the persistent change and the immediate live effect.

**5. State inspection and reporting**
> "who's on the server and how's the match going?"

Claude runs `get_live_state` and gives you a structured readout: players, teams, scores, map, round phase.

Best when: you want a quick, accurate snapshot without parsing raw `status` output yourself.

**6. Scripted / multi-step operations**
> "swap to a koth map, set the bot quota to fill, and announce it in chat"

Claude chains multiple intents in order, checking each result before the next.

Best when: an operation is several steps that must happen in sequence with verification between them.

**7. Structured plugin debugging**
> "something broke in the rounds plugin, check what happened"

Claude runs `get_errors` (structured SourcePawn errors with stack traces, not raw log text), correlates the failing line and native with the `.sp` it reads via `read_file`, and forms a hypothesis. To confirm, it can `reproduce` the scenario on demand (spawn, force a round, fire the triggering event), watch `get_recent_events`, and if it needs the plugin's internal state it calls `dump_state` to read variables the plugin exposes. Once it has a fix it edits, compiles, deploys, reloads, reproduces again, and confirms the symptom is gone.

Best when: a runtime bug where you want Claude reasoning over real error data and internal plugin state, and able to recreate the trigger instead of waiting for it to happen again. This is the primary reason to build the debugging layer.

### The debugging loop
This is the workflow that turns the whole project from "works" into "worth building" for development. The loop Claude runs:
1. **Orient** — `get_errors` + `get_live_state` to see what actually happened and the current state.
2. **Correlate** — cross the error's file/line/native against the `.sp` source.
3. **Hypothesize** — propose a cause from code + error + state.
4. **Reproduce** — `reproduce` the trigger on demand so the bug isn't left to chance.
5. **Inspect** — `dump_state` for internal plugin variables when the game events aren't enough.
6. **Fix and verify** — edit, `compile`, `deploy`, `reload_plugin`, reproduce again, confirm via `get_recent_events`.

**8. Situational scripting (ephemeral, zero-trace)**
> "make every enemy explode when they die, just for the next couple minutes"

No command or cvar does this, and it's a throwaway. Claude writes a minimal SourcePawn micro-plugin, compiles it to an isolated scratch directory, hot-loads it, and it runs. When its own timer ends, or you say "kill it", or the MCP session closes, the plugin is unloaded and both the `.smx` and `.sp` are deleted from scratch. Nothing touches the real plugins folder; nothing persists.

Best when: you want arbitrary one-off behavior right now that no command covers, and you don't want it kept. If it turns out you want to keep it, that's a separate explicit request ("save this as a plugin") that promotes it out of scratch into a real standalone plugin.

### Two routes for "there's no command for this"
When a goal can't be met by any existing command, cvar, or typed action, Claude writes code. There are two distinct routes:

- **Route A — Situational (scratch scripts):** small, hyper-specific, single-use, always ephemeral. Handled by the scratch scripting subsystem below. Compiles real SourcePawn, but to an isolated scratch dir, hot-loads, and auto-deletes with zero trace. The default for one-offs.
- **Route B — Standalone (plugins):** larger, stateful, worth keeping and versioning. Full flow: write `.sp`, `compile`, `deploy`, `load_plugin`, iterate, and it lives in the real plugins folder.

The boundary is persistence, and Claude decides it: is this a throwaway or something you want to keep? When unsure, it asks. Scratch never persists unless you explicitly promote it.

---

## MCP Tools (Claude-facing)

These are what Claude actually calls. They are the stable, general primitives.

| Tool | Scope | Purpose | Most indicated when |
|------|-------|---------|---------------------|
| `send_intent` | Control (bidirectional) | Send a structured action to the bridge plugin and get a correlated, structured result. The main control primitive. | Anything that should run inside the game with the full SourceMod API, or any live change where you want a structured ack back. |
| `get_live_state` | Read (structured) | Return current game state: players, teams, scores, map, round phase, bot count. | Before acting, or whenever you want an accurate snapshot instead of raw console text. |
| `get_recent_events` | Read (telemetry) | Return buffered real-time events pushed by the plugin (connects, chat, deaths, round/map changes, errors). | Live debugging, or confirming that an action had the expected in-game effect. |
| `compile` | Build | Invoke spcomp on a `.sp`, parse stdout/stderr into structured errors and warnings, return the resolved `.smx` path. | Any time source changes and needs building; the parsed output lets Claude react to errors. |
| `deploy` | Deploy | Copy a compiled `.smx` into the plugins directory (local file op). | After a successful compile, to move the artifact into place. |
| `reload_plugin` / `load_plugin` / `unload_plugin` | Deploy | Manage plugin lifecycle live via socket action or RCON. | Applying a freshly deployed plugin without restarting the server. |
| `read_file` / `write_file` / `list_dir` | Files | Read, edit, and browse files scoped to whitelisted roots (scripting, cfg, plugins). | Editing configs or source, inspecting the layout before acting. |
| `get_errors` | Debug (read) | Return structured SourcePawn errors: file, line, native, message, stack trace. Backed by the plugin's error hook, with the SourceMod error logs as a fallback source. | Debugging: the first call when investigating a runtime failure. Far faster than parsing raw log files. |
| `get_event_log` | Debug (read) | Query the persistent event log on disk (not just the live buffer), filterable by time window, type, or plugin. | Investigating a bug that happened earlier, after the live telemetry buffer has rotated. |
| `reproduce` | Debug (control) | Trigger a defined scenario on demand (spawn, force round state, fire a test event) so a bug can be recreated deterministically. | Confirming a hypothesis about a state-dependent bug instead of waiting for it to recur. |
| `dump_state` | Debug (read) | Read internal plugin state that a plugin chooses to expose (registered vars, collections, handles). | Logic bugs invisible in game events: a mispopulated StringMap, an invalid handle, wrong internal counters. |
| `run_scratch` | Scratch (write+run) | Claude writes a micro-plugin for the described behavior, compiles it to the scratch dir, hot-loads it, returns a scratch id. Auto-corrects on compile errors. | Arbitrary one-off behavior no command covers, that should be ephemeral. Route A. |
| `list_scratch` | Scratch (read) | List currently loaded scratch scripts with their ids and descriptions. | Checking what ephemeral scripts are running right now. |
| `kill_scratch` / `kill_all_scratch` | Scratch (control) | Unload one or all scratch scripts and delete their `.smx` and `.sp` from scratch. | Ending a one-off on demand, or clearing everything ephemeral at once. |
| `promote_scratch` | Scratch to standalone | Move a scratch script out of scratch into the real plugins folder as a persistent standalone plugin. | The rare case where a throwaway turned out worth keeping. Explicit only. |
| `rcon_exec` | Fallback | Run a raw console command over RCON. | When the bridge plugin isn't loaded/connected, or for a one-off command not worth a dedicated action. |

---

## Plugin Actions (bridge plugin, extensible)

Actions are what `send_intent` targets. The plugin's dispatcher is intentionally thin: Claude/MCP holds the intelligence, the plugin executes and reports. Adding an action is one enum entry plus one handler.

| Action | Scope | Purpose | Most indicated when |
|--------|-------|---------|---------------------|
| `ping` | Liveness | Round-trip health check; returns `pong`. | Verifying the socket link is alive; used internally on connect/heartbeat. |
| `console` | Control (broad) | Execute any server console command in-process and return output. RCON-equivalent power but inside the game with structured framing. | The generic escape hatch: any command that doesn't yet have a dedicated typed action. |
| `query_state` | Read (structured) | Read live game state through natives (not string parsing) and return JSON. Backs `get_live_state`. | Whenever accurate structured state is needed; more reliable than parsing `status`. |
| `plugins` | Lifecycle | Load, unload, or reload plugins by name. | Applying builds live; safer as a typed action than a raw console string. |
| `chat` | Output | Send a message to game chat (all or targeted). | Announcements, or surfacing Claude's actions to players in-game. |
| `players` | Read/Control | Enumerate players or act on one (kick, team, slay) via typed payload with validation. | Player management where you want validation and a structured result, not a raw kick string. |
| `capture_errors` | Debug | Hook SourceMod's logging/error path and push each error as a structured frame (file, line, native, stack). Backs `get_errors`. | Turned on during development so runtime errors stream out structured instead of sitting in a log file. |
| `record_events` | Debug | Toggle persisting the event stream to disk so it can be queried historically. Backs `get_event_log`. | Development sessions where you want to look back at what happened before a bug surfaced. |
| `reproduce` | Debug | Execute a named, parameterized scenario (spawn setup, force round phase, emit a test event) to recreate a bug trigger. | Recreating state-dependent bugs deterministically for confirmation. |
| `dump_plugin_state` | Debug | Return internal state a target plugin registered as inspectable. Requires the plugin to opt in by exposing its vars. | Reading plugin-internal data structures that game events don't reveal. |
| *(extend)* | — | New capability: one enum + one handler, full SM API available behind it. | Any recurring operation you'd rather express as a typed, validated action than a raw console command. |

### Scope boundary: typed action vs `console`
`console` exists so Claude is never blocked: if there's no typed action, it can always fall back to a raw command. Typed actions (`plugins`, `players`, `chat`, `query_state`) exist for the operations you use often or want guarded, since they add validation, structured payloads, and structured results. Rule of thumb: prototype with `console`, promote to a typed action once a pattern repeats or needs safety.

---

## Scratch Scripting Subsystem (Route A)

For situational, single-use behavior no command covers. It runs real SourcePawn so it has no capability ceiling: if SourcePawn can do it, Claude can write it. The whole compile-load-unload cycle is automated so it feels instant despite compiling under the hood. Everything about it is ephemeral by invariant, not by option.

### Lifecycle
1. **Write** — Claude generates the minimal `.sp` for the requested behavior, applying the user's coding standards.
2. **Compile to scratch** — `spcomp` outputs to an isolated scratch dir (e.g. `/tmp/mcp-scratch/`), never the real plugins folder. Compile errors are read, corrected, and recompiled without user involvement unless it can't resolve them.
3. **Hot-load** — the scratch `.smx` is loaded live and starts running immediately.
4. **Run** — the script does its thing. It may carry its own end condition (a timer), or stay until told to stop.
5. **Auto-destroy** — on any of three triggers the plugin is unloaded and its `.smx` and `.sp` are deleted from scratch.

### Zero-trace guarantees
- **Isolated scratch dir** that never touches the real plugins folder. All ephemeral code lives and dies there.
- **Active-script registry** in the MCP: which scratch plugins are loaded now, so they can be listed and killed individually or en masse.
- **Auto-cleanup on three triggers:** the script's own end condition, an explicit kill, and MCP session close. None leaves a `.sp` or `.smx` behind.
- **Scratch dir wiped** on both MCP startup and shutdown, so a crash can't leave orphans.
- **Unique names per script** (uuid or timestamp) so multiple ephemerals can run at once without plugin-name collisions.

### Boundary with Route B
Scratch never persists on its own. Keeping one is a separate, explicit action (`promote_scratch`) that moves it into the real plugins folder and makes it a standalone plugin. Without that command, it's gone.

---

## Channel Selection: which path for what

| Situation | Path | Why |
|-----------|------|-----|
| Live in-game change with structured feedback | `send_intent` (socket) | Bidirectional, structured result, full SM API |
| Reading real-time game events | telemetry channel (socket) | Push from server, no polling, structured |
| Building/deploying plugins | MCP-local tools (spcomp, file ops) | No game involvement needed; pure local process/file work |
| Editing configs/source | file tools | Direct filesystem access since everything is local |
| One-off behavior no command covers, throwaway | scratch subsystem (`run_scratch`) | Real SourcePawn, no ceiling, ephemeral and zero-trace |
| Behavior worth keeping | Route B (write `.sp` to real plugins folder) | Persists, versioned, standalone |
| Debugging a runtime failure | debug tools (`get_errors`, `dump_state`, `reproduce`) | Structured errors, internal state, and deterministic reproduction |
| Investigating something that happened earlier | `get_event_log` | Persistent on-disk history survives buffer rotation |
| Bridge plugin down, or one-off command | `rcon_exec` | Works without the custom plugin loaded |

---

## Build Phases

- **Phase 0 — Setup:** scaffold TS MCP project, config (socket port, paths, spcomp binary, RCON fallback creds from env), verify bare MCP handshake.
- **Phase 1 — Local socket server (MCP):** Node `net` server, length-prefixed JSON framing, connection lifecycle, pending-intent registry keyed by `id`.
- **Phase 2 — Bridge plugin (SourcePawn):** load `sm-ext-socket`, connect + reconnect loop, parse frames, dispatch by action, send framed results. Prove the round-trip with `ping`/`pong`.
- **Phase 3 — Intent actions:** extensible dispatcher, seed `console` + `query_state` + `plugins`, expose `send_intent`.
- **Phase 4 — Telemetry:** hook game events, push `event` frames, buffer in MCP, expose `get_recent_events` / `get_live_state`.
- **Phase 5 — Build & deploy:** `compile` (parsed spcomp output), `deploy` (local copy), plugin lifecycle tools.
- **Phase 6 — Files & config:** `read_file` / `write_file` / `list_dir` with path validation.
- **Phase 7 — Debugging layer:** `capture_errors` (structured error hook) + `get_errors`; `record_events` (persistent log) + `get_event_log`; `reproduce` scenarios; `dump_plugin_state` + `dump_state`. This is the phase that makes the tool genuinely useful for plugin development, so build it once the core loop (Phases 1 to 5) is proven.
- **Phase 8 — Scratch scripting subsystem:** isolated scratch dir, automated compile-load-unload cycle, active-script registry, auto-cleanup on all three triggers, scratch wipe on startup/shutdown, unique naming. Tools: `run_scratch` / `list_scratch` / `kill_scratch` / `kill_all_scratch` / `promote_scratch`. Depends on the build/deploy chain from Phase 5.
- **Phase 9 — Safety & polish:** confirmation gating for destructive actions, input validation, structured logging, README documenting protocol and schemas.

## Milestones
1. MCP to plugin socket round-trip (`ping`/`pong`) working. Phases 0 to 2.
2. First real intent + structured state query. Phase 3.
3. Live telemetry streaming into the MCP. Phase 4.
4. Full build to deploy to reload chain. Phase 5.
5. File editing. Phase 6.
6. Debugging loop closed: structured errors, reproduce, and internal state working together. Phase 7.
7. Scratch scripting: write to ephemeral one-off, run, auto-clean with zero trace. Phase 8.
8. Safety layer. Phase 9.

## Key Risks / Notes
- `sm-ext-socket` gives raw sockets, not WebSockets. A plain framed-TCP protocol over the local socket is simpler than real WS and enough since it's local. Only go full WebSocket if you later want a browser to connect directly.
- Late-load and reconnect handling on both sides is the fiddliest part. Nail the round-trip in Phase 2 before building breadth.
- Keep the plugin's action dispatcher thin: the intelligence lives in the MCP/Claude, the plugin just executes and reports.
- `dump_plugin_state` only works if the target plugin opts in and exposes its internals. It can't read arbitrary memory of a plugin that wasn't written for it. For your own plugins under development this is fine (add a small debug include); for third-party plugins, fall back to `get_errors` + game events.
- `capture_errors` and `record_events` are development toggles, not always-on. Leaving structured error capture and disk logging running in production adds overhead and noise; gate them behind a debug mode.
- `reproduce` scenarios are code you write per bug class. It's not magic reproduction: each scenario (spawn setup, force round, emit event) is a defined handler. Build the ones that match the bugs you actually hit.
- Scratch scripts run real SourcePawn with full server access, so a bad one can crash or hang the server just like any plugin. The zero-trace cleanup protects the filesystem, not the running server. The value is no ceiling on what a one-off can do; the cost is a one-off can do anything.
- The zero-trace guarantee hinges on cleanup actually firing. Session-close and crash cases need the startup wipe as the backstop, since an unclean exit won't run the normal unload path. Treat the startup wipe as the real guarantee, not the graceful one.
- Compile latency is trivial for small scripts, but Claude auto-correcting compile errors in a loop needs a retry cap so a script it can't fix doesn't spin. Fail out to the user after a few attempts.
