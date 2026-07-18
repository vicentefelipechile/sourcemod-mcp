// =========================================================================================================
// MCP Bridge — Debugging Layer
// =========================================================================================================
// Handlers for the four debug actions plus the plugin-side plumbing they need:
//   capture_errors      toggle structured error capture; while on, MCP_ReportError pushes sm_error frames
//   record_events       toggle event pushing (telemetry gates on this so it can be silenced in production)
//   reproduce           run a named scenario to recreate a bug deterministically
//   dump_plugin_state   return internal state a plugin opted in to expose via a registered StringMap
//
// Error capture and state dumping rely on opt-in: a plugin under development registers its inspectable state
// and calls MCP_ReportError on failures. This can't read arbitrary memory of a plugin not written for it.

#if defined _mcp_bridge_debug_included
 #endinput
#endif
#define _mcp_bridge_debug_included

#include <sourcemod>
#include <ripext>

#include "mcp_bridge/dispatch.inc"
#include "mcp_bridge/telemetry.inc"

// =========================================================================================================
// Globals
// =========================================================================================================

// Whether structured error capture is on. MCP_ReportError is a no-op while off.
bool g_bCaptureErrors = false;

// Whether the plugin should keep pushing telemetry/events. Telemetry checks this via MCP_EventsEnabled.
bool g_bRecordEvents = true;

// Registry of exposed plugin state for dump_plugin_state: plugin name -> (key -> string value).
// A plugin opts in by calling MCP_RegisterState; the bridge reads it back on request.
StringMap g_smExposedState = null;

// =========================================================================================================
// Helpers
// =========================================================================================================

// Build the per-plugin state map key used to namespace exposed values.
stock void MCP_StateKey(char[] out, int maxlen, const char[] plugin, const char[] key)
{
    Format(out, maxlen, "%s::%s", plugin, key);
}

// =========================================================================================================
// Public opt-in API (used by plugins under development, incl. scratch scripts)
// =========================================================================================================

// Report a structured error to the MCP. No-op unless capture is enabled. All fields except message optional.
stock void MCP_ReportError(const char[] message, const char[] plugin = "", const char[] file = "", int line = 0, const char[] nativeName = "")
{
    if (!g_bCaptureErrors)
    {
        return;
    }

    JSONObject payload = new JSONObject();
    payload.SetString("message", message);
    if (plugin[0] != '\0')     payload.SetString("plugin", plugin);
    if (file[0] != '\0')       payload.SetString("file", file);
    if (line > 0)              payload.SetInt("line", line);
    if (nativeName[0] != '\0') payload.SetString("native", nativeName);

    // Bypass the record_events gate: error capture has its own gate (g_bCaptureErrors, checked above).
    MCP_EmitFrame("sm_error", payload);
}

// Register (or update) an inspectable state value for dump_plugin_state.
stock void MCP_RegisterState(const char[] plugin, const char[] key, const char[] value)
{
    if (g_smExposedState == null)
    {
        g_smExposedState = new StringMap();
    }
    char mapKey[256];
    MCP_StateKey(mapKey, sizeof(mapKey), plugin, key);
    g_smExposedState.SetString(mapKey, value);
}

// =========================================================================================================
// Action handlers
// =========================================================================================================

// --- capture_errors: toggle structured error capture ---
stock void Action_CaptureErrors(const char[] id, JSONObject payload)
{
    bool enabled = (payload != null) ? payload.GetBool("enabled") : false;
    g_bCaptureErrors = enabled;

    JSONObject data = new JSONObject();
    data.SetBool("capturing", g_bCaptureErrors);
    MCP_SendResult(id, data);
    delete data;
}

// --- record_events: toggle event pushing ---
stock void Action_RecordEvents(const char[] id, JSONObject payload)
{
    bool enabled = (payload != null) ? payload.GetBool("enabled") : false;
    g_bRecordEvents = enabled;

    JSONObject data = new JSONObject();
    data.SetBool("recording", g_bRecordEvents);
    MCP_SendResult(id, data);
    delete data;
}

// --- dump_plugin_state: return exposed internal state ---
stock void Action_DumpState(const char[] id, JSONObject payload)
{
    if (payload == null)
    {
        MCP_SendError(id, "dump_plugin_state requires { plugin, key? }");
        return;
    }

    char plugin[128];
    char key[128];
    payload.GetString("plugin", plugin, sizeof(plugin));
    payload.GetString("key", key, sizeof(key));

    if (g_smExposedState == null)
    {
        MCP_SendError(id, "No plugin has exposed inspectable state.");
        return;
    }

    JSONObject data = new JSONObject();

    if (key[0] != '\0')
    {
        // Single key lookup.
        char mapKey[256];
        MCP_StateKey(mapKey, sizeof(mapKey), plugin, key);
        char value[512];
        if (g_smExposedState.GetString(mapKey, value, sizeof(value)))
        {
            data.SetString(key, value);
        }
        else
        {
            delete data;
            MCP_SendError(id, "Requested state key is not exposed by that plugin.");
            return;
        }
    }
    else
    {
        // All keys for the plugin: iterate the snapshot and include matching namespaced entries.
        char prefix[160];
        Format(prefix, sizeof(prefix), "%s::", plugin);
        int prefixLen = strlen(prefix);

        StringMapSnapshot snap = g_smExposedState.Snapshot();
        for (int i = 0; i < snap.Length; i++)
        {
            int keyLen = snap.KeyBufferSize(i);
            char[] fullKey = new char[keyLen];
            snap.GetKey(i, fullKey, keyLen);

            if (strncmp(fullKey, prefix, prefixLen) == 0)
            {
                char value[512];
                g_smExposedState.GetString(fullKey, value, sizeof(value));
                data.SetString(fullKey[prefixLen], value);
            }
        }
        delete snap;
    }

    MCP_SendResult(id, data);
    delete data;
}

// --- reproduce: run a named scenario ---
// Scenarios are code you write per bug class. Two built-ins are provided as examples; extend as needed.
stock void Action_Reproduce(const char[] id, JSONObject payload)
{
    if (payload == null)
    {
        MCP_SendError(id, "reproduce requires { scenario, params? }");
        return;
    }

    char scenario[64];
    payload.GetString("scenario", scenario, sizeof(scenario));

    if (StrEqual(scenario, "force_round_start"))
    {
        // Restart the round via the standard cvar so round-start logic fires deterministically.
        ServerCommand("mp_restartgame 1");
        JSONObject data = new JSONObject();
        data.SetString("scenario", scenario);
        data.SetString("effect", "issued mp_restartgame 1");
        MCP_SendResult(id, data);
        delete data;
        return;
    }

    if (StrEqual(scenario, "spawn_bot"))
    {
        int count = 1;
        JSONObject params = view_as<JSONObject>(payload.Get("params"));
        if (params != null)
        {
            if (params.HasKey("count")) count = params.GetInt("count");
            delete params;
        }
        char cmd[64];
        Format(cmd, sizeof(cmd), "bot_add %d", count);
        ServerCommand("%s", cmd);
        JSONObject data = new JSONObject();
        data.SetString("scenario", scenario);
        data.SetInt("count", count);
        MCP_SendResult(id, data);
        delete data;
        return;
    }

    char err[128];
    Format(err, sizeof(err), "Unknown scenario: %s. Add a handler in Action_Reproduce.", scenario);
    MCP_SendError(id, err);
}
