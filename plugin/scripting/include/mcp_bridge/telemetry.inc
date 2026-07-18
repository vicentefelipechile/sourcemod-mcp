// =========================================================================================================
// MCP Bridge — Telemetry
// =========================================================================================================
// Hooks a curated set of game events and forwards each to the MCP as an event frame. The MCP buffers these
// so Claude can read the recent stream (get_recent_events) for live debugging and effect confirmation.
//
// Kept intentionally small: connect/disconnect, chat, death, and round/map lifecycle cover the common
// debugging needs. Adding a hook is HookEvent in MCP_Telemetry_Init plus one push handler. Game events are
// forwarded by name with their useful fields flattened into the payload.

#if defined _mcp_bridge_telemetry_included
 #endinput
#endif
#define _mcp_bridge_telemetry_included

#include <sourcemod>
#include <ripext>

#include "mcp_bridge/dispatch.inc"

// =========================================================================================================
// Forwards
// =========================================================================================================

// True when the socket link is up; telemetry is dropped when disconnected. Implemented in the main plugin.
forward bool MCP_IsConnected();

// True when event pushing is enabled (the record_events toggle). Implemented in the main plugin so it can
// read the debug layer's flag without a circular include. Defaults to enabled.
forward bool MCP_EventsEnabled();

// =========================================================================================================
// Helpers
// =========================================================================================================

// Build a fresh event id from the server time + a rolling counter so events are uniquely identifiable.
static int s_eventCounter = 0;

stock void MCP_MakeEventId(char[] out, int maxlen)
{
    s_eventCounter++;
    Format(out, maxlen, "evt-%d-%d", GetTime(), s_eventCounter);
}

// Push a telemetry event, but only while connected and while event recording is enabled. Takes ownership of
// freeing payload. Error frames bypass the recording gate by calling MCP_EmitFrame directly.
stock void MCP_PushEvent(const char[] action, JSONObject payload)
{
    if (!MCP_IsConnected() || !MCP_EventsEnabled())
    {
        delete payload;
        return;
    }
    MCP_EmitFrame(action, payload);
}

// Emit an event frame gated only on the connection (not on the record_events toggle). Used by error
// reporting, which has its own capture gate. Takes ownership of freeing payload.
stock void MCP_EmitFrame(const char[] action, JSONObject payload)
{
    if (!MCP_IsConnected())
    {
        delete payload;
        return;
    }
    char id[48];
    MCP_MakeEventId(id, sizeof(id));
    MCP_SendEvent(id, action, payload);
    delete payload;
}

// =========================================================================================================
// Game event handlers
// =========================================================================================================

public void MCP_OnPlayerConnected(Event event, const char[] name, bool dontBroadcast)
{
    JSONObject payload = new JSONObject();
    char playerName[MAX_NAME_LENGTH];
    event.GetString("name", playerName, sizeof(playerName));
    payload.SetString("name", playerName);
    payload.SetInt("userid", event.GetInt("userid"));
    payload.SetBool("bot", event.GetBool("bot"));
    MCP_PushEvent("player_connect", payload);
}

public void MCP_OnPlayerDisconnect(Event event, const char[] name, bool dontBroadcast)
{
    JSONObject payload = new JSONObject();
    char playerName[MAX_NAME_LENGTH];
    char reason[128];
    event.GetString("name", playerName, sizeof(playerName));
    event.GetString("reason", reason, sizeof(reason));
    payload.SetString("name", playerName);
    payload.SetString("reason", reason);
    payload.SetInt("userid", event.GetInt("userid"));
    MCP_PushEvent("player_disconnect", payload);
}

public void MCP_OnPlayerDeath(Event event, const char[] name, bool dontBroadcast)
{
    JSONObject payload = new JSONObject();
    payload.SetInt("victim_userid", event.GetInt("userid"));
    payload.SetInt("attacker_userid", event.GetInt("attacker"));
    char weapon[64];
    event.GetString("weapon", weapon, sizeof(weapon));
    payload.SetString("weapon", weapon);
    MCP_PushEvent("player_death", payload);
}

public void MCP_OnPlayerChat(Event event, const char[] name, bool dontBroadcast)
{
    JSONObject payload = new JSONObject();
    char text[256];
    event.GetString("text", text, sizeof(text));
    payload.SetInt("userid", event.GetInt("userid"));
    payload.SetString("text", text);
    MCP_PushEvent("player_chat", payload);
}

public void MCP_OnRoundStart(Event event, const char[] name, bool dontBroadcast)
{
    JSONObject payload = new JSONObject();
    payload.SetString("phase", "start");
    MCP_PushEvent("round_start", payload);
}

public void MCP_OnRoundEnd(Event event, const char[] name, bool dontBroadcast)
{
    JSONObject payload = new JSONObject();
    payload.SetInt("winner", event.GetInt("team"));
    MCP_PushEvent("round_end", payload);
}

// =========================================================================================================
// Main
// =========================================================================================================

// Hook the curated event set. Called once on plugin start. Events not present in the running game are
// skipped by SourceMod without error.
stock void MCP_Telemetry_Init()
{
    HookEvent("player_connect", MCP_OnPlayerConnected, EventHookMode_Post);
    HookEvent("player_disconnect", MCP_OnPlayerDisconnect, EventHookMode_Post);
    HookEvent("player_death", MCP_OnPlayerDeath, EventHookMode_Post);
    HookEvent("player_say", MCP_OnPlayerChat, EventHookMode_Post);
    HookEvent("round_start", MCP_OnRoundStart, EventHookMode_Post);
    HookEvent("round_end", MCP_OnRoundEnd, EventHookMode_Post);
}

// Emit a map-change event. Called from OnMapStart in the main plugin (map name is not a game event field).
stock void MCP_Telemetry_MapStart(const char[] mapName)
{
    JSONObject payload = new JSONObject();
    payload.SetString("map", mapName);
    MCP_PushEvent("map_start", payload);
}
