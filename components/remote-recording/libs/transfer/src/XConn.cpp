#include "XConn.h"

#include <algorithm>

#include "rr/shared/Clock.h"

bool XConn::pump(int timeoutMs, std::deque<XMsg>& in)
{
    if (!sock.valid() || failed)
    {
        if (error.empty())
        {
            error = "not connected";
        }
        return false;
    }
    std::vector<TcpSocket*> rd;
    std::vector<TcpSocket*> wr;
    if (dec.canAcceptMore())
    {
        rd.push_back(&sock);
    }
    if (pendingOut() > 0)
    {
        wr.push_back(&sock);
    }
    if (!TcpSocket::wait(rd, wr, timeoutMs))
    {
        failed = true;
        error = "select failed";
        return false;
    }
    std::string err;
    // Write as much as the socket takes.
    while (pendingOut() > 0)
    {
        const long n = sock.sendSome(out.data() + outOff, pendingOut(), err);
        if (n < 0)
        {
            failed = true;
            error = err;  // already says "send failed: ..."
            return false;
        }
        if (n == 0)
        {
            break;
        }
        outOff += static_cast<size_t>(n);
    }
    if (outOff == out.size())
    {
        out.clear();
        outOff = 0;
    }
    else if (outOff > (1u << 20))
    {
        out.erase(out.begin(), out.begin() + static_cast<ptrdiff_t>(outOff));
        outOff = 0;
    }
    // Read what is waiting (bounded by the decoder's limit).
    uint8_t buf[65536];
    while (dec.canAcceptMore())
    {
        // Never read past the decoder's bound (it rejects a stream that overfills it).
        const size_t room = std::min(sizeof buf, dec.room());
        const long n = sock.recvSome(buf, room, err);
        if (n == -2)
        {
            // Orderly close: deliver whatever complete messages arrived first.
            failed = true;
            error = "the other side closed the connection";
            break;
        }
        if (n < 0)
        {
            failed = true;
            error = err;  // already says "receive failed: ..."
            break;
        }
        if (n == 0)
        {
            break;
        }
        dec.feed(buf, static_cast<size_t>(n));
    }
    for (;;)
    {
        XMsg m;
        std::string derr;
        const auto r = dec.next(m, derr);
        if (r == XDecoder::Result::NeedMore)
        {
            break;
        }
        if (r == XDecoder::Result::Error)
        {
            failed = true;
            error = "protocol error: " + derr;
            return false;
        }
        in.push_back(std::move(m));
    }
    return !failed;
}

void XConn::closeAfterFlush(int maxMs)
{
    const int64_t until = monotonicNs() + static_cast<int64_t>(maxMs) * 1000000;
    std::deque<XMsg> ignored;
    while (valid() && pendingOut() > 0 && monotonicNs() < until)
    {
        if (!pump(10, ignored))
        {
            break;
        }
    }
    sock.shutdownSend();
    // Drain until the peer closes (bounded): closing with unread data would send a reset that
    // can discard the last message (an ABORT or RESULT) before the peer reads it.
    const int64_t drainUntil = monotonicNs() + 300 * 1000000LL;
    uint8_t buf[4096];
    std::string err;
    while (sock.valid() && monotonicNs() < drainUntil)
    {
        std::vector<TcpSocket*> rd{&sock};
        TcpSocket::wait(rd, {}, 20);
        const long n = sock.recvSome(buf, sizeof buf, err);
        if (n < 0)
        {
            break;  // closed (-2) or error
        }
    }
    close();
}

