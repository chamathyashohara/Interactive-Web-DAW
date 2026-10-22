#pragma once

// Internal: one RRXF connection (non-blocking TcpSocket + bounded output buffer + decoder).

#include <cstdint>
#include <deque>
#include <string>
#include <vector>

#include "rr/network/Socket.h"
#include "rr/transfer/TransferProtocol.h"

class XConn
{
public:
    XConn() = default;
    explicit XConn(TcpSocket s) : sock(std::move(s)) {}

    bool valid() const { return sock.valid() && !failed; }
    TcpSocket& socket() { return sock; }
    void reset(TcpSocket s)
    {
        sock = std::move(s);
        out.clear();
        outOff = 0;
        dec = XDecoder{};
        failed = false;
        error.clear();
    }
    void close()
    {
        sock.close();
        out.clear();
        outOff = 0;
    }
    /** Graceful: flush what is queued (best effort, bounded wait), then close. */
    void closeAfterFlush(int maxMs);

    void send(const XMsg& m)
    {
        const auto b = encode(m);
        out.insert(out.end(), b.begin(), b.end());
    }
    size_t pendingOut() const { return out.size() - outOff; }

    /**
     * Waits up to timeoutMs for I/O, moves bytes both ways, appends decoded messages to `in`.
     * Returns false when the connection is finished (error, protocol error or peer close);
     * getError() then explains.
     */
    bool pump(int timeoutMs, std::deque<XMsg>& in);
    const std::string& getError() const { return error; }

private:
    TcpSocket sock;
    std::vector<uint8_t> out;
    size_t outOff = 0;
    XDecoder dec;
    bool failed = false;
    std::string error;
};

