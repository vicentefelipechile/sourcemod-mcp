// =========================================================================================================
// MCP Bridge Plugin
// =========================================================================================================
// Runs inside the gameserver and holds a persistent local TCP connection to the SourceMod MCP. It receives
// structured JSON intents, executes them with the full SourceMod API, and frames correlated results back.
// It also pushes game telemetry as event frames (added in the telemetry phase).
//
// Connection model: the MCP is the TCP server; this plugin is the client. On load, map change, and after any
// disconnect, a reconnect timer re-establishes the link so a plugin/MCP restart on either side self-heals.

#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>
#include <socket>
#include <ripext>

#include "mcp_bridge/protocol.inc"
#include "mcp_bridge/dispatch.inc"
#include "mcp_bridge/telemetry.inc"
#include "mcp_bridge/debug.inc"

// =========================================================================================================
// Constants
// =========================================================================================================

#define PLUGIN_VERSION "0.1.0"

// The MCP socket endpoint. Kept in cvars so it can be pointed elsewhere without recompiling.
#define DEFAULT_MCP_HOST "127.0.0.1"
#define DEFAULT_MCP_PORT 27100

// Seconds between reconnect attempts while disconnected.
#define RECONNECT_INTERVAL 5.0

// Working buffer for a single inbound frame's JSON. Sized to the protocol frame cap headroom for typical
// intents; oversized frames are rejected by the framing layer, not here.
#define FRAME_JSON_MAXLEN 8192

// =========================================================================================================
// Globals
// =========================================================================================================

Handle g_hSocket = null;
bool g_bConnected = false;
Handle g_hReconnectTimer = null;

ConVar g_cvHost = null;
ConVar g_cvPort = null;

FrameBuffer g_RxBuffer;

// =========================================================================================================
// Plugin metadata
// =========================================================================================================

public Plugin myinfo =
{
    name = "MCP Bridge",
    author = "Vicente",
    description = "Persistent socket bridge between the SourceMod MCP and the gameserver.",
    version = PLUGIN_VERSION,
    url = "https://github.com/vicentefelipechile/sourcemod-mcp"
};

// =========================================================================================================
// Plugin lifecycle
// =========================================================================================================

public void OnPluginStart()
{
    g_cvHost = CreateConVar("mcp_bridge_host", DEFAULT_MCP_HOST, "Host of the MCP socket server.", FCVAR_PROTECTED);
    g_cvPort = CreateConVar("mcp_bridge_port", "27100", "Port of the MCP socket server.", FCVAR_PROTECTED, true, 1.0, true, 65535.0);

    g_RxBuffer.Init();

    RegAdminCmd("mcp_bridge_status", Cmd_Status, ADMFLAG_ROOT, "Report MCP bridge connection status.");
    RegAdminCmd("mcp_bridge_reconnect", Cmd_Reconnect, ADMFLAG_ROOT, "Force an immediate MCP reconnect attempt.");

    MCP_Telemetry_Init();

    // Attempt the first connection shortly after load.
    CreateTimer(1.0, Timer_TryConnect);
}

public void OnMapStart()
{
    char mapName[128];
    GetCurrentMap(mapName, sizeof(mapName));
    MCP_Telemetry_MapStart(mapName);

    // OnMapEnd tears the socket down (it does not survive a map change), so re-establish the link on the new
    // map. Without this the bridge stays dead after every changelevel until the plugin is reloaded by hand.
    if (!g_bConnected)
    {
        ScheduleReconnect();
    }
}

public void OnPluginEnd()
{
    CloseSocket();
    g_RxBuffer.Dispose();
}

public void OnMapEnd()
{
    // Sockets do not survive a map change reliably; force a clean reconnect on the next map.
    CloseSocket();
}

// =========================================================================================================
// Connection management
// =========================================================================================================

void CloseSocket()
{
    if (g_hReconnectTimer != null)
    {
        KillTimer(g_hReconnectTimer);
        g_hReconnectTimer = null;
    }
    if (g_hSocket != null)
    {
        CloseHandle(g_hSocket);
        g_hSocket = null;
    }
    g_bConnected = false;
    g_RxBuffer.Clear();
}

// Schedule a reconnect attempt if one is not already pending.
void ScheduleReconnect()
{
    if (g_hReconnectTimer != null)
    {
        return;
    }
    g_hReconnectTimer = CreateTimer(RECONNECT_INTERVAL, Timer_Reconnect);
}

public Action Timer_TryConnect(Handle timer)
{
    TryConnect();
    return Plugin_Stop;
}

public Action Timer_Reconnect(Handle timer)
{
    g_hReconnectTimer = null;
    TryConnect();
    return Plugin_Stop;
}

// Open a fresh socket and begin connecting to the configured MCP endpoint.
void TryConnect()
{
    if (g_bConnected)
    {
        return;
    }
    if (g_hSocket != null)
    {
        CloseHandle(g_hSocket);
        g_hSocket = null;
    }

    char host[64];
    g_cvHost.GetString(host, sizeof(host));
    int port = g_cvPort.IntValue;

    g_hSocket = SocketCreate(SOCKET_TCP, OnSocketError);
    SocketSetOption(g_hSocket, SocketReuseAddr, 1);
    SocketConnect(g_hSocket, OnSocketConnected, OnSocketReceive, OnSocketDisconnected, host, port);
}

// =========================================================================================================
// Socket callbacks
// =========================================================================================================

public void OnSocketConnected(Handle socket, any arg)
{
    g_bConnected = true;
    g_RxBuffer.Clear();
    LogMessage("[mcp_bridge] Connected to MCP socket");
}

public void OnSocketReceive(Handle socket, const char[] receiveData, const int dataSize, any arg)
{
    g_RxBuffer.Append(receiveData, dataSize);

    // Drain every complete frame currently available.
    char json[FRAME_JSON_MAXLEN];
    while (MCP_NextFrame(g_RxBuffer, json, sizeof(json)))
    {
        MCP_Dispatch(json);
    }
}

public void OnSocketDisconnected(Handle socket, any arg)
{
    LogMessage("[mcp_bridge] Disconnected from MCP socket");
    if (g_hSocket != null)
    {
        CloseHandle(g_hSocket);
        g_hSocket = null;
    }
    g_bConnected = false;
    g_RxBuffer.Clear();
    ScheduleReconnect();
}

public void OnSocketError(Handle socket, const int errorType, const int errorNum, any arg)
{
    LogError("[mcp_bridge] Socket error: type %d, num %d", errorType, errorNum);
    if (g_hSocket != null)
    {
        CloseHandle(g_hSocket);
        g_hSocket = null;
    }
    g_bConnected = false;
    ScheduleReconnect();
}

// =========================================================================================================
// Frame writing (implements the dispatch forward)
// =========================================================================================================

public bool MCP_IsConnected()
{
    return g_bConnected && g_hSocket != null;
}

public bool MCP_EventsEnabled()
{
    return g_bRecordEvents;
}

public void MCP_WriteFrame(const char[] json, int jsonLength)
{
    if (!g_bConnected || g_hSocket == null)
    {
        LogError("[mcp_bridge] Dropping outbound frame; not connected");
        return;
    }

    // Prepend the 4-byte big-endian length prefix, then the JSON bytes.
    int total = MCP_LENGTH_PREFIX_BYTES + jsonLength;
    char[] frame = new char[total];
    MCP_WriteUInt32BE(frame, jsonLength);
    for (int i = 0; i < jsonLength; i++)
    {
        frame[MCP_LENGTH_PREFIX_BYTES + i] = json[i];
    }

    SocketSend(g_hSocket, frame, total);
}

// =========================================================================================================
// Action dispatch (implements the dispatch forward)
// =========================================================================================================

public bool MCP_HandleAction(const char[] id, const char[] action, JSONObject payload)
{
    if (StrEqual(action, "ping"))
    {
        Action_Ping(id);
        return true;
    }
    if (StrEqual(action, "console"))
    {
        Action_Console(id, payload);
        return true;
    }
    if (StrEqual(action, "query_state"))
    {
        Action_QueryState(id);
        return true;
    }
    if (StrEqual(action, "plugins"))
    {
        Action_Plugins(id, payload);
        return true;
    }
    if (StrEqual(action, "capture_errors"))
    {
        Action_CaptureErrors(id, payload);
        return true;
    }
    if (StrEqual(action, "record_events"))
    {
        Action_RecordEvents(id, payload);
        return true;
    }
    if (StrEqual(action, "reproduce"))
    {
        Action_Reproduce(id, payload);
        return true;
    }
    if (StrEqual(action, "dump_plugin_state"))
    {
        Action_DumpState(id, payload);
        return true;
    }
    return false;
}

// --- ping: liveness round-trip ---
void Action_Ping(const char[] id)
{
    MCP_SendResultString(id, "pong");
}

// --- console: run any server console command, capturing its output ---
void Action_Console(const char[] id, JSONObject payload)
{
    if (payload == null)
    {
        MCP_SendError(id, "console requires a payload with { command }");
        return;
    }

    char command[512];
    if (!payload.GetString("command", command, sizeof(command)))
    {
        MCP_SendError(id, "console payload missing 'command'");
        return;
    }

    // Capture command output via the server console redirect.
    char output[4096];
    ServerCommandEx(output, sizeof(output), "%s", command);

    JSONObject data = new JSONObject();
    data.SetString("command", command);
    data.SetString("output", output);
    MCP_SendResult(id, data);
    delete data;
}

// --- query_state: structured live game state through natives ---
void Action_QueryState(const char[] id)
{
    char mapName[128];
    GetCurrentMap(mapName, sizeof(mapName));

    int maxPlayers = MaxClients;
    int humans = 0;
    int bots = 0;

    JSONArray players = new JSONArray();
    for (int client = 1; client <= maxPlayers; client++)
    {
        if (!IsClientInGame(client))
        {
            continue;
        }

        bool isBot = IsFakeClient(client);
        if (isBot) bots++; else humans++;

        char name[MAX_NAME_LENGTH];
        GetClientName(client, name, sizeof(name));

        JSONObject p = new JSONObject();
        p.SetInt("userid", GetClientUserId(client));
        p.SetInt("client", client);
        p.SetString("name", name);
        p.SetInt("team", GetClientTeam(client));
        p.SetBool("bot", isBot);
        p.SetBool("alive", IsPlayerAlive(client));
        players.Push(p);
        delete p;
    }

    JSONObject data = new JSONObject();
    data.SetString("map", mapName);
    data.SetInt("maxplayers", maxPlayers);
    data.SetInt("humans", humans);
    data.SetInt("bots", bots);
    data.Set("players", players);
    MCP_SendResult(id, data);
    delete data;
    delete players;
}

// --- plugins: load / unload / reload a plugin by name ---
void Action_Plugins(const char[] id, JSONObject payload)
{
    if (payload == null)
    {
        MCP_SendError(id, "plugins requires a payload with { op, name }");
        return;
    }

    char op[16];
    char name[128];
    payload.GetString("op", op, sizeof(op));
    payload.GetString("name", name, sizeof(name));

    if (op[0] == '\0' || name[0] == '\0')
    {
        MCP_SendError(id, "plugins payload requires 'op' (load|unload|reload) and 'name'");
        return;
    }

    char command[192];
    if (StrEqual(op, "load"))
    {
        Format(command, sizeof(command), "sm plugins load %s", name);
    }
    else if (StrEqual(op, "unload"))
    {
        Format(command, sizeof(command), "sm plugins unload %s", name);
    }
    else if (StrEqual(op, "reload"))
    {
        Format(command, sizeof(command), "sm plugins reload %s", name);
    }
    else
    {
        MCP_SendError(id, "plugins 'op' must be one of load|unload|reload");
        return;
    }

    char output[2048];
    ServerCommandEx(output, sizeof(output), "%s", command);

    JSONObject data = new JSONObject();
    data.SetString("op", op);
    data.SetString("name", name);
    data.SetString("output", output);
    MCP_SendResult(id, data);
    delete data;
}

// =========================================================================================================
// Admin commands
// =========================================================================================================

public Action Cmd_Status(int client, int args)
{
    ReplyToCommand(client, "[mcp_bridge] connected=%s", g_bConnected ? "yes" : "no");
    return Plugin_Handled;
}

public Action Cmd_Reconnect(int client, int args)
{
    ReplyToCommand(client, "[mcp_bridge] forcing reconnect");
    CloseSocket();
    TryConnect();
    return Plugin_Handled;
}
