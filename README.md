# SourceMod MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude general-purpose,
programmatic control over a local TF2 / SourceMod game server: query live state, run commands, compile and
hot-load plugins, stream telemetry, debug runtime errors, and write throwaway one-off scripts — all through
the full SourceMod native API rather than by scraping console text.

## Architecture

Two processes on the same machine, connected by a persistent local TCP socket:

```
┌─────────────┐   stdio    ┌──────────────────┐   local TCP    ┌──────────────────────┐
│   Claude    │◄──────────►│   MCP server     │◄──────────────►│   Bridge plugin      │
│  (client)   │   (MCP)    │  (TypeScript)    │  JSON frames   │  (SourcePawn, in     │
└─────────────┘            │                  │                │   the gameserver)    │
                           │ • tool surface   │                │ • intent dispatch    │
                           │ • spcomp / files │                │ • event push         │
                           │ • RCON fallback  │                │ • full SM native API │
                           └──────────────────┘                └──────────────────────┘
```

- **MCP server (`src/`, Node + TypeScript, ESM):** exposes the tools to Claude over stdio, runs the local
  socket **server** the plugin connects to, invokes `spcomp`, edits files under whitelisted roots, and falls
  back to RCON when the bridge is down.
- **Bridge plugin (`plugin/`, SourcePawn + [sm-ext-socket](https://github.com/nefarius/sm-ext-socket) +
  [sm-ripext](https://github.com/ErikMinekus/sm-ripext)):** runs inside the gameserver, receives JSON intents,
  executes them with the full SourceMod API, and pushes game events back.

The MCP server is the TCP **server**; the plugin is the **client** and reconnects every 5 s if the link drops.
`stdout` is owned by the MCP transport — all server diagnostics go to `stderr`.

## Wire protocol

Raw local TCP carrying **length-prefixed JSON frames**:

```
┌────────────────────────┬─────────────────────────────────┐
│ 4-byte length (BE u32) │  UTF-8 JSON payload (that many) │
└────────────────────────┴─────────────────────────────────┘
```

- Length prefix is a big-endian unsigned 32-bit byte count of the JSON that follows.
- Max frame size is 8 MiB (`MAX_FRAME_BYTES`); larger frames are a protocol error.
- Frames may be split across TCP reads or coalesced; both sides decode incrementally.

### Message shape

```jsonc
{
  "id":      "uuid-or-correlation-id",   // correlates an intent with its result
  "type":    "intent" | "result" | "event",
  "action":  "console",                   // the verb; "" on results
  "payload": { /* action-specific */ }
}
```

- **`intent`** — MCP → plugin. A request to do something. The plugin replies with a `result` carrying the same `id`.
- **`result`** — plugin → MCP. `payload` is `{ ok: boolean, data?: unknown, error?: string }`.
- **`event`** — plugin → MCP, unsolicited. Telemetry (connects, deaths, chat, round/map changes) and structured
  errors (`action: "sm_error"`). No reply.

Intents are correlated by `id`: the MCP server keeps a pending-intent registry and resolves the matching
promise when the `result` arrives (or rejects on timeout).

## MCP tools

24 tools, grouped by concern.

### Control
| Tool | Purpose |
|---|---|
| `send_intent` | The general control primitive. Send any typed action to the plugin and get a structured result. The `console` action runs an arbitrary server command (**gated**, see Safety). |
| `bridge_status` | Report whether the plugin is connected, and ping it to confirm the link is responsive. |

### Telemetry
| Tool | Purpose |
|---|---|
| `get_recent_events` | Read the live in-memory event buffer (recent connects, deaths, chat, round/map changes, errors). |
| `get_live_state` | Structured snapshot of players/teams/map/bot counts via SourceMod natives (not text parsing). |

### Build & deploy
| Tool | Purpose |
|---|---|
| `compile` | Invoke `spcomp` and return parsed errors/warnings + the `.smx` path. |
| `deploy` | Copy a compiled `.smx` into the plugins dir. |
| `load_plugin` / `unload_plugin` / `reload_plugin` | Lifecycle via the bridge (RCON fallback). |
| `rcon_exec` | Run a raw console command over RCON, no plugin required (**gated**). |

### Files
| Tool | Purpose |
|---|---|
| `read_file` / `write_file` / `list_dir` | Scoped to whitelisted roots (scripting, cfg, plugins, scratch) via the path guard. |

### Debugging
| Tool | Purpose |
|---|---|
| `get_errors` | Structured SourcePawn errors (plugin, file, line, native, message) from the plugin's error hook. |
| `get_event_log` | Query the persistent on-disk event log, filterable by time/action. |
| `set_capture` | Toggle the plugin's structured error capture. |
| `set_recording` | Toggle persisting the event stream to disk. |
| `reproduce` | Trigger a named in-game scenario to recreate a bug deterministically. |
| `dump_state` | Read internal state a target plugin opted in to expose. |

### Scratch scripting (ephemeral, zero-trace)
| Tool | Purpose |
|---|---|
| `run_scratch` | Compile + hot-load a one-off micro-plugin from source. Returns diagnostics on failure so Claude can auto-correct. |
| `list_scratch` | List currently loaded scratch scripts. |
| `kill_scratch` / `kill_all_scratch` | Unload + delete scratch scripts (removes every file). |
| `promote_scratch` | Copy a scratch script's source out into a persistent standalone plugin. |

**Zero-trace guarantee:** the scratch dir is wiped on startup (the real backstop against crash orphans) and on
shutdown; kills remove every file from both scratch and plugins dirs; failed compiles leave nothing on disk.
Promotion to a real plugin is the only way scratch content persists, and it is always explicit.

## Bridge plugin actions

Actions the plugin's dispatcher (`MCP_HandleAction`) understands, invoked via `send_intent` or a typed tool:

| Action | Payload | Result data |
|---|---|---|
| `ping` | `{}` | `{ pong: true }` |
| `console` | `{ command }` | command output |
| `query_state` | `{}` | players/teams/map/bot snapshot |
| `plugins` | `{ op: "load"\|"unload"\|"reload", name }` | lifecycle result |
| `capture_errors` | `{ enabled }` | `{ capturing }` |
| `record_events` | `{ enabled }` | `{ recording }` |
| `reproduce` | `{ scenario, params }` | scenario effect |
| `dump_plugin_state` | `{ plugin, key? }` | exposed state |

Events pushed by the plugin include `player_connect`, `player_disconnect`, `player_death`, `player_say`,
`round_start`, `round_end`, `map_start`, and `sm_error` (structured runtime errors).

## Safety

MCP has no interactive mid-call prompt, so destructive actions use a **two-step confirmation gate**:

1. A destructive console/RCON command called **without** `confirm: true` returns a preview
   (`{ requiresConfirmation: true, reason, hint }`) and does **not** run.
2. Re-issue the same tool with `confirm: true` to execute.

Commands classified as destructive (in `src/safety.ts`): `quit`/`exit`/`restart`, `map`/`changelevel`,
`kickall`, `kick`/`ban`/`addip`, `exec`, `mp_restartgame`/`mp_restartround`, and anything that rewrites server
auth (`rcon_password`/`sv_password`). Read-only and benign commands run straight through. This applies to both
`rcon_exec` and the `console` action of `send_intent`.

Additional safety layers: all filesystem tools are confined to whitelisted roots via a resolve-and-confine path
guard (blocks `../` traversal); the RCON password lives only in the environment, never in code; and all inputs
are validated with [zod](https://zod.dev) schemas at the tool boundary.

## Setup

### Prerequisites
- Node.js ≥ 20 (developed on v24), npm.
- A TF2 / SourceMod server you control locally.
- `spcomp` (bundled with SourceMod) for compiling plugins.
- The `sm-ext-socket` extension and `sm-ripext` installed in the gameserver.

### 1. Install and build the MCP server
```bash
npm install
npm run build
```

### 2. Configure
Copy `config.example.json` to `config.json` and fill in the paths and credentials:

| Key | Purpose |
|---|---|
| `socket.host` / `socket.port` | Local socket the plugin connects to (default `127.0.0.1:27100`). |
| `paths.gameRoot` | Root of the game server install. |
| `paths.scriptingDir` | SourceMod `scripting/` dir (its `include/` is added to compiles automatically). |
| `paths.pluginsDir` | SourceMod `plugins/` dir. |
| `paths.cfgDir` | Server `cfg/` dir. |
| `paths.scratchDir` | Isolated dir for ephemeral scratch scripts (default `./scratch`). |
| `compiler.spcompBin` | Path to the `spcomp` binary. |
| `rcon.host` / `rcon.port` / `rcon.password` | RCON fallback credentials. |

The config file is resolved in order: an explicit path passed as the first CLI argument
(`node dist/index.js C:/path/config.json`), then the `SM_MCP_CONFIG` env var, then `config.json` next to the
project root. Any field may be omitted; documented defaults apply.

### 3. Compile and load the bridge plugin
Compile `plugin/scripting/mcp_bridge.sp` with `spcomp` (its includes are under
`plugin/scripting/include/mcp_bridge/`), deploy the `.smx` into the gameserver's plugins dir, and load it. The
plugin connects to the MCP socket on load and reconnects automatically. Its host/port are set via the
`mcp_bridge_host` / `mcp_bridge_port` ConVars; check the link with the `mcp_bridge_status` admin command.

### 4. Register the MCP server with Claude
Point your MCP client at the built server (stdio transport):
```jsonc
{
  "mcpServers": {
    "sourcemod": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/sourcemod-mcp"
    }
  }
}
```

Or register it from the CLI:
```bash
claude mcp add sourcemod --scope user -- node /path/to/sourcemod-mcp/dist/index.js
```

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # compile to dist/
npm run dev         # watch mode
npm start           # run the built server
```

## Project layout

```
src/
  index.ts            entry point: boots socket + tools, wires shutdown
  config.ts           env → typed config
  protocol.ts         frame encode/decode, message types
  socket-server.ts    the local TCP server + pending-intent registry
  safety.ts           destructive-command classifier + confirmation gate
  compiler.ts         spcomp invocation + diagnostic parsing
  rcon.ts             RCON fallback
  path-guard.ts       resolve-and-confine within whitelisted roots
  scratch-manager.ts  ephemeral scratch lifecycle + zero-trace cleanup
  event-buffer.ts     live in-memory event ring buffer
  debug-store.ts      error ring buffer + on-disk event log
  logger.ts           stderr structured logging
  tools/              the MCP tool modules (one per concern)
plugin/
  scripting/mcp_bridge.sp                main bridge plugin
  scripting/include/mcp_bridge/*.inc     protocol, dispatch, telemetry, debug
```
