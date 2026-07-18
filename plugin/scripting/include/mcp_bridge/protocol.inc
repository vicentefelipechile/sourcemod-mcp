// =========================================================================================================
// MCP Bridge — Wire Protocol
// =========================================================================================================
// Length-prefixed JSON framing over the raw TCP socket, mirroring src/protocol.ts on the MCP side.
//
// Frame layout: [ 4-byte big-endian uint32 length ][ UTF-8 JSON payload of that many bytes ].
//
// Incoming bytes arrive in arbitrary chunks via OnSocketReceive; a frame can be split across reads or several
// frames can arrive in one read. We accumulate raw bytes into a growable byte buffer (a cell array, one byte
// per cell) and extract every complete frame available. Message JSON is parsed with sm-ripext (YYJSON).

#if defined _mcp_bridge_protocol_included
 #endinput
#endif
#define _mcp_bridge_protocol_included

#include <ripext>

// =========================================================================================================
// Constants
// =========================================================================================================

// Size in bytes of the big-endian length prefix that precedes every frame.
#define MCP_LENGTH_PREFIX_BYTES 4

// Hard cap on a single frame payload; matches MAX_FRAME_BYTES on the MCP side.
#define MCP_MAX_FRAME_BYTES 8388608

// Initial capacity (in bytes) of the receive accumulator.
#define MCP_RX_INITIAL_CAP 4096

// =========================================================================================================
// Types
// =========================================================================================================

// A growable byte accumulator for inbound socket data. Backed by a resizable ArrayList of single bytes,
// which keeps the logic simple and null-byte-safe (length-prefix bytes may be zero).
enum struct FrameBuffer
{
    ArrayList bytes;

    void Init()
    {
        this.bytes = new ArrayList();
    }

    void Dispose()
    {
        if (this.bytes != null)
        {
            delete this.bytes;
            this.bytes = null;
        }
    }

    // Discard all buffered bytes without freeing the backing list.
    void Clear()
    {
        if (this.bytes != null)
        {
            this.bytes.Clear();
        }
    }

    // Append raw received bytes.
    void Append(const char[] data, int size)
    {
        for (int i = 0; i < size; i++)
        {
            // Store as unsigned byte value 0..255.
            this.bytes.Push(data[i] & 0xFF);
        }
    }

    int Length()
    {
        return this.bytes.Length;
    }

    int Get(int index)
    {
        return this.bytes.Get(index);
    }

    // Drop the first count bytes from the front of the buffer.
    void Consume(int count)
    {
        for (int i = 0; i < count; i++)
        {
            this.bytes.Erase(0);
        }
    }
}

// =========================================================================================================
// Helpers
// =========================================================================================================

// Read a big-endian uint32 from the buffer starting at offset. Caller guarantees 4 bytes are available.
stock int MCP_ReadUInt32BE(FrameBuffer buffer, int offset)
{
    int b0 = buffer.Get(offset + 0);
    int b1 = buffer.Get(offset + 1);
    int b2 = buffer.Get(offset + 2);
    int b3 = buffer.Get(offset + 3);
    return (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
}

// Write a big-endian uint32 length prefix into out[0..3].
stock void MCP_WriteUInt32BE(char[] out, int value)
{
    out[0] = (value >> 24) & 0xFF;
    out[1] = (value >> 16) & 0xFF;
    out[2] = (value >> 8) & 0xFF;
    out[3] = value & 0xFF;
}

// =========================================================================================================
// Main
// =========================================================================================================

// Extract the next complete frame's JSON payload from the buffer into json (a char array sized by the
// caller). Returns true and consumes the frame when one is available; returns false when more data is needed.
// On a protocol violation (oversized frame) it clears the buffer and returns false.
stock bool MCP_NextFrame(FrameBuffer buffer, char[] json, int maxlen)
{
    if (buffer.Length() < MCP_LENGTH_PREFIX_BYTES)
    {
        return false;
    }

    int length = MCP_ReadUInt32BE(buffer, 0);
    if (length < 0 || length > MCP_MAX_FRAME_BYTES)
    {
        LogError("[mcp_bridge] Oversized/invalid frame length %d; clearing buffer", length);
        buffer.Clear();
        return false;
    }

    int frameEnd = MCP_LENGTH_PREFIX_BYTES + length;
    if (buffer.Length() < frameEnd)
    {
        // Full frame not yet received.
        return false;
    }

    // Copy JSON bytes out. Cap at maxlen-1 to leave room for the null terminator; JSON has no null bytes.
    int copy = length < (maxlen - 1) ? length : (maxlen - 1);
    for (int i = 0; i < copy; i++)
    {
        json[i] = buffer.Get(MCP_LENGTH_PREFIX_BYTES + i);
    }
    json[copy] = '\0';

    buffer.Consume(frameEnd);
    return true;
}
