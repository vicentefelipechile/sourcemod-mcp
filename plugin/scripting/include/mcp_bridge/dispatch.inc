// =========================================================================================================
// MCP Bridge — Action Dispatch
// =========================================================================================================
// The thin dispatcher: parse an inbound intent message, route it by action to a handler, and frame a
// correlated result back. The intelligence lives in the MCP/Claude; the plugin just executes and reports.
//
// Adding an action is one entry in MCP_Dispatch plus one handler. Handlers receive the correlation id, the
// parsed payload object, and return a result by calling MCP_SendResult / MCP_SendError with that id.

#if defined _mcp_bridge_dispatch_included
 #endinput
#endif
#define _mcp_bridge_dispatch_included

#include <ripext>

#include "mcp_bridge/protocol.inc"

// =========================================================================================================
// Constants
// =========================================================================================================

// Max length of a message id string. UUIDs are 36 chars; leave headroom.
#define MCP_ID_MAXLEN 64

// Max length of an action name.
#define MCP_ACTION_MAXLEN 64

// Working buffer size for outbound JSON message bodies.
#define MCP_MSG_MAXLEN 8192

// =========================================================================================================
// Forwards (implemented in the main plugin)
// =========================================================================================================

// Write a fully-framed message (length prefix + JSON) to the active socket.
forward void MCP_WriteFrame(const char[] json, int jsonLength);

// Route an action to its handler. Implemented in the main plugin so handlers can use plugin-global state.
// Returns true if the action was recognized and handled (a result was/will be sent), false if unknown.
forward bool MCP_HandleAction(const char[] id, const char[] action, JSONObject payload);

// =========================================================================================================
// Helpers
// =========================================================================================================

// Serialize a JSONObject message and write it as a length-prefixed frame.
stock void MCP_SendMessage(JSONObject message)
{
    char json[MCP_MSG_MAXLEN];
    message.ToString(json, sizeof(json), JSON_COMPACT);
    MCP_WriteFrame(json, strlen(json));
}

// =========================================================================================================
// Main
// =========================================================================================================

// Send a successful result correlated to an intent id, carrying an arbitrary data value.
stock void MCP_SendResult(const char[] id, JSON data)
{
    JSONObject payload = new JSONObject();
    payload.SetBool("ok", true);
    if (data != null)
    {
        payload.Set("data", data);
    }

    JSONObject message = new JSONObject();
    message.SetString("id", id);
    message.SetString("type", "result");
    message.SetString("action", "");
    message.Set("payload", payload);

    // Set deep-copies the value, so the local payload handle is ours to free.
    MCP_SendMessage(message);
    delete payload;
    delete message;
}

// Send a successful result whose data is a plain string.
stock void MCP_SendResultString(const char[] id, const char[] text)
{
    JSONObject payload = new JSONObject();
    payload.SetBool("ok", true);
    payload.SetString("data", text);

    JSONObject message = new JSONObject();
    message.SetString("id", id);
    message.SetString("type", "result");
    message.SetString("action", "");
    message.Set("payload", payload);

    MCP_SendMessage(message);
    delete payload;
    delete message;
}

// Send a failure result correlated to an intent id.
stock void MCP_SendError(const char[] id, const char[] error)
{
    JSONObject payload = new JSONObject();
    payload.SetBool("ok", false);
    payload.SetString("error", error);

    JSONObject message = new JSONObject();
    message.SetString("id", id);
    message.SetString("type", "result");
    message.SetString("action", "");
    message.Set("payload", payload);

    MCP_SendMessage(message);
    delete payload;
    delete message;
}

// Push an unsolicited event frame (telemetry) to the MCP. The caller owns and frees the payload handle.
stock void MCP_SendEvent(const char[] eventId, const char[] action, JSONObject payload)
{
    JSONObject message = new JSONObject();
    message.SetString("id", eventId);
    message.SetString("type", "event");
    message.SetString("action", action);
    message.Set("payload", payload);

    MCP_SendMessage(message);
    delete message;
}

// Parse one inbound frame's JSON and dispatch it. Only intent messages are expected inbound; anything else
// is logged and ignored. Unknown actions produce an error result so the MCP always gets a correlated answer.
stock void MCP_Dispatch(const char[] json)
{
    JSONObject message = JSONObject.FromString(json);
    if (message == null)
    {
        LogError("[mcp_bridge] Failed to parse inbound frame as JSON");
        return;
    }

    char type[16];
    message.GetString("type", type, sizeof(type));
    if (!StrEqual(type, "intent"))
    {
        LogError("[mcp_bridge] Ignoring inbound non-intent frame of type '%s'", type);
        delete message;
        return;
    }

    char id[MCP_ID_MAXLEN];
    char action[MCP_ACTION_MAXLEN];
    message.GetString("id", id, sizeof(id));
    message.GetString("action", action, sizeof(action));

    // payload is optional; Get errors on a missing key, so guard on HasKey and skip JSON null.
    JSONObject payload = null;
    if (message.HasKey("payload") && !message.IsNull("payload"))
    {
        payload = view_as<JSONObject>(message.Get("payload"));
    }

    bool handled = MCP_HandleAction(id, action, payload);
    if (!handled)
    {
        char err[128];
        Format(err, sizeof(err), "Unknown action: %s", action);
        MCP_SendError(id, err);
    }

    if (payload != null)
    {
        delete payload;
    }
    delete message;
}
