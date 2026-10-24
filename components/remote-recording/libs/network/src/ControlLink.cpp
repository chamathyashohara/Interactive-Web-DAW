#include "rr/network/ControlLink.h"

#include <algorithm>
#include <cstdio>
#include <random>

#include "rr/shared/BuildInfo.h"
#include "rr/shared/Clock.h"

namespace
{

int64_t msToNs(uint32_t ms)
{
    return static_cast<int64_t>(ms) * 1'000'000;
}

}  // namespace

std::string makePairingCode()
{
    std::random_device rd;
    std::uniform_int_distribution<int> digit(0, 9);
    std::string code;
    for (int i = 0; i < 6; ++i)
    {
        code += static_cast<char>('0' + digit(rd));
    }
    return code;
}

std::string makeRandomToken(size_t hexDigits)
{
    static const char* const kHex = "0123456789abcdef";
    std::random_device rd;
    std::string token;
    while (token.size() < hexDigits)
    {
        uint32_t v = rd();
        for (int i = 0; i < 8 && token.size() < hexDigits; ++i)
        {
            token += kHex[v & 0xF];
            v >>= 4;
        }
    }
    return token;
}

std::unique_ptr<ControlLink> ControlLink::server(const ServerParams& params)
{
    std::unique_ptr<ControlLink> link(new ControlLink());
    link->serverRole = true;
    link->sp = params;
    link->t = params.timings;
    return link;
}

std::unique_ptr<ControlLink> ControlLink::client(const ClientParams& params)
{
    std::unique_ptr<ControlLink> link(new ControlLink());
    link->serverRole = false;
    link->cp = params;
    link->t = params.timings;
    return link;
}

ControlLink::~ControlLink()
{
    stop();
}

bool ControlLink::start(std::string& error)
{
    if (running.load())
    {
        return true;
    }
    if (!initSockets(error))
    {
        return false;
    }
    if (serverRole)
    {
        // ADR-016: listen on one explicitly chosen interface, never on all of them.
        if (sp.bindAddress == "0.0.0.0")
        {
            error = "listening on all interfaces (0.0.0.0) is not allowed; choose one network interface";
            return false;
        }
        if (!listener.listenOn(sp.bindAddress, sp.port, error))
        {
            return false;
        }
        newPairingCode();
        {
            std::lock_guard<std::mutex> lock(mutex);
            join.sessionId = sp.sessionId;
        }
        setState(LinkState::Listening, "listening on " + sp.bindAddress + ":" + std::to_string(sp.port));
    }
    else
    {
        if (!isValidIpv4(cp.hostAddress))
        {
            error = "not an IPv4 address: " + cp.hostAddress;
            return false;
        }
        std::lock_guard<std::mutex> lock(mutex);
        clientId = makeRandomToken(8);
    }
    running.store(true);
    thread = std::thread([this] { run(); });
    return true;
}

void ControlLink::stop(ErrorCode reason)
{
    {
        std::lock_guard<std::mutex> lock(mutex);
        stopWithClose = true;
        stopReason = reason;
    }
    if (running.exchange(false) && thread.joinable())
    {
        thread.join();
    }
    else if (thread.joinable())
    {
        thread.join();
    }
}

bool ControlLink::send(Frame frame)
{
    if (state.load() != LinkState::Connected)
    {
        return false;
    }
    std::lock_guard<std::mutex> lock(mutex);
    appOutbox.push_back(std::move(frame));
    return true;
}

std::vector<LinkEvent> ControlLink::pollEvents()
{
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<LinkEvent> out(events.begin(), events.end());
    events.clear();
    return out;
}

LinkStats ControlLink::getStats() const
{
    std::lock_guard<std::mutex> lock(mutex);
    return stats;
}

JoinInfo ControlLink::joinInfo() const
{
    std::lock_guard<std::mutex> lock(mutex);
    return join;
}

std::string ControlLink::newPairingCode()
{
    std::lock_guard<std::mutex> lock(mutex);
    pairingCode = makePairingCode();
    codeCreatedNs = monotonicNs();
    codeUsed = false;
    failedJoins = 0;
    return pairingCode;
}

std::string ControlLink::getPairingCode() const
{
    std::lock_guard<std::mutex> lock(mutex);
    return pairingCode;
}

void ControlLink::setState(LinkState s, const std::string& why)
{
    const LinkState old = state.exchange(s);
    if (old != s)
    {
        LinkEvent e;
        e.kind = LinkEventKind::StateChanged;
        e.state = s;
        e.text = why;
        pushEvent(std::move(e));
    }
}

void ControlLink::pushEvent(LinkEvent e)
{
    std::lock_guard<std::mutex> lock(mutex);
    if (events.size() >= 4096)
    {
        events.pop_front();  // the application stopped polling; keep the newest
    }
    events.push_back(std::move(e));
}

void ControlLink::queueFrame(Frame f)
{
    f.msgId = nextMsgId++;
    f.setI64(Tag::SentNs, monotonicNs());
    const std::vector<uint8_t> bytes = encode(f);
    outbuf.insert(outbuf.end(), bytes.begin(), bytes.end());
    std::lock_guard<std::mutex> lock(mutex);
    ++stats.framesSent;
}

void ControlLink::sendErrorAndClose(ErrorCode code, const std::string& text, uint32_t refId)
{
    Frame e;
    e.type = MsgType::Error;
    e.refId = refId;
    e.setU16(Tag::ErrorCode, static_cast<uint16_t>(code));
    e.setStr(Tag::ErrorText, text);
    queueFrame(std::move(e));
    phase = Phase::Closing;
    phaseDeadlineNs = monotonicNs() + 500'000'000;  // flush, then close
    LinkEvent ev;
    ev.kind = LinkEventKind::Info;
    ev.code = code;
    ev.text = "refused peer: " + std::string(errorCodeName(code)) + " (" + text + ")";
    pushEvent(std::move(ev));
}

void ControlLink::closeConnection(const std::string& why, bool lost)
{
    const bool wasJoined = phase == Phase::Joined;
    conn.close();
    outbuf.clear();
    decoder = FrameDecoder();
    phase = Phase::Idle;
    const int64_t now = monotonicNs();
    if (serverRole)
    {
        setState(everJoined ? LinkState::LinkLost : LinkState::Listening, why);
        return;
    }
    if (lost && everJoined)
    {
        if (wasJoined || linkLostSinceNs == 0)
        {
            linkLostSinceNs = now;
        }
        nextReconnectNs = now + msToNs(t.reconnectIntervalMs);
        setState(LinkState::LinkLost, why);
    }
    else
    {
        setState(LinkState::Disconnected, why);
    }
}

void ControlLink::startClientConnect()
{
    std::string error;
    decoder = FrameDecoder();
    outbuf.clear();
    nextMsgId = 1;
    lastRxMsgId = 0;
    if (everJoined)
    {
        std::lock_guard<std::mutex> lock(mutex);
        ++stats.reconnectAttempts;
    }
    if (!conn.connectStart(cp.hostAddress, cp.port, error))
    {
        closeConnection(error, true);
        return;
    }
    phase = Phase::Connecting;
    phaseDeadlineNs = monotonicNs() + msToNs(t.connectTimeoutMs);
    if (!everJoined)
    {
        setState(LinkState::Connecting, "connecting to " + cp.hostAddress + ":" + std::to_string(cp.port));
    }
}

void ControlLink::run()
{
    if (!serverRole)
    {
        startClientConnect();
    }
    std::vector<uint8_t> buffer(4096);
    while (running.load())
    {
        if (dropRequested.exchange(false) && conn.valid())
        {
            closeConnection("test: connection dropped", true);
        }
        {
            // Application frames are sent only on a joined connection; anything queued for a
            // connection that has since been lost is discarded (the controller resynchronises).
            std::deque<Frame> pending;
            {
                std::lock_guard<std::mutex> lock(mutex);
                pending.swap(appOutbox);
            }
            for (Frame& f : pending)
            {
                if (phase == Phase::Joined)
                {
                    queueFrame(std::move(f));
                }
            }
        }
        int64_t now = monotonicNs();
        if (!serverRole && phase == Phase::Idle && everJoined && state.load() == LinkState::LinkLost &&
            now >= nextReconnectNs)
            {
            if (now - linkLostSinceNs > msToNs(t.reconnectGiveUpMs))
            {
                everJoined = false;
                setState(LinkState::Disconnected, "gave up reconnecting");
            }
            else
            {
                startClientConnect();
            }
        }

        std::vector<TcpSocket*> readers;
        std::vector<TcpSocket*> writers;
        if (listener.valid())
        {
            readers.push_back(&listener);
        }
        if (conn.valid())
        {
            if (phase == Phase::Connecting)
            {
                writers.push_back(&conn);
            }
            else
            {
                readers.push_back(&conn);
                if (!outbuf.empty())
                {
                    writers.push_back(&conn);
                }
            }
        }
        TcpSocket::wait(readers, writers, 20);
        now = monotonicNs();

        // ---- server: accept ----
        if (listener.valid() && TcpSocket::isReadable(listener))
        {
            std::string peer;
            std::string error;
            TcpSocket incoming = listener.acceptPending(peer, error);
            if (incoming.valid())
            {
                if (conn.valid())
                {
                    // One performer per session: tell the newcomer and close it.
                    Frame e;
                    e.type = MsgType::Error;
                    e.msgId = 1;
                    e.setI64(Tag::SentNs, now);
                    e.setU16(Tag::ErrorCode, static_cast<uint16_t>(ErrorCode::SessionFull));
                    e.setStr(Tag::ErrorText, "this session already has a performer");
                    const auto bytes = encode(e);
                    std::string ignored;
                    incoming.sendSome(bytes.data(), bytes.size(), ignored);
                    incoming.shutdownSend();
                    rejecting.push_back(Rejecting{std::move(incoming), now + 1'000'000'000});
                    LinkEvent ev;
                    ev.kind = LinkEventKind::Info;
                    ev.text = "refused a second connection from " + peer + " (session full)";
                    pushEvent(std::move(ev));
                }
                else
                {
                    conn = std::move(incoming);
                    connPeer = peer;
                    decoder = FrameDecoder();
                    outbuf.clear();
                    nextMsgId = 1;
                    lastRxMsgId = 0;
                    lastRxNs = now;
                    phase = Phase::AwaitHello;
                    phaseDeadlineNs = now + msToNs(t.handshakeTimeoutMs);
                    if (!everJoined)
                    {
                        setState(LinkState::Handshaking, "connection from " + peer);
                    }
                }
            }
        }

        // ---- refused extra connections: drain until the peer closes or the grace period ends ----
        for (auto it = rejecting.begin(); it != rejecting.end();)
        {
            std::string ignored;
            uint8_t sink[512];
            long n = 0;
            while ((n = it->socket.recvSome(sink, sizeof sink, ignored)) > 0)
            {
            }
            if (n < 0 || now > it->closeAtNs)
            {
                it->socket.close();
                it = rejecting.erase(it);
            }
            else
            {
                ++it;
            }
        }

        // ---- client: connect progress ----
        if (phase == Phase::Connecting)
        {
            std::string error;
            const int r = conn.connectFinished(error);
            if (r == 1)
            {
                connPeer = cp.hostAddress;
                lastRxNs = now;
                Frame hello;
                hello.type = MsgType::Hello;
                hello.setU16(Tag::ProtoMajor, testMajor ? testMajor : kProtocolMajor);
                hello.setU16(Tag::ProtoMinor, kProtocolMinor);
                hello.setU8(Tag::Role, 2);
                hello.setStr(Tag::AppVersion, cp.appVersion);
                queueFrame(std::move(hello));
                phase = Phase::AwaitHelloAck;
                phaseDeadlineNs = now + msToNs(t.handshakeTimeoutMs);
                if (!everJoined)
                {
                    setState(LinkState::Handshaking, "connected, checking versions");
                }
            }
            else if (r < 0 || now > phaseDeadlineNs)
            {
                closeConnection(r < 0 ? "could not connect: " + error : "could not connect: timed out", true);
            }
        }

        // ---- read ----
        if (conn.valid() && phase != Phase::Connecting)
        {
            // Read everything available first. A peer often sends a last frame (ERROR,
            // SESSION_CLOSED) and closes at once: those frames must be decoded and acted on
            // BEFORE the close is handled, or the reason for the close would be lost.
            std::string readError;
            bool peerClosed = false;
            for (;;)
            {
                const long n = conn.recvSome(buffer.data(), buffer.size(), readError);
                if (n > 0)
                {
                    decoder.feed(buffer.data(), static_cast<size_t>(n));
                    continue;
                }
                peerClosed = n == -2;
                if (n != -1)
                {
                    readError.clear();
                }
                break;
            }
            Frame f;
            std::string error;
            while (conn.valid())
            {
                const FrameDecoder::Result r = decoder.next(f, error);
                if (r == FrameDecoder::Result::NeedMore)
                {
                    break;
                }
                if (r == FrameDecoder::Result::Error)
                {
                    {
                        std::lock_guard<std::mutex> lock(mutex);
                        ++stats.protocolErrors;
                    }
                    LinkEvent ev;
                    ev.kind = LinkEventKind::ProtocolError;
                    ev.text = "malformed control data: " + error;
                    pushEvent(std::move(ev));
                    closeConnection("malformed control data", true);
                    break;
                }
                handleFrame(f, now);
            }
            // Only now act on the close/error (handling a frame may already have closed it).
            if (conn.valid() && phase != Phase::Closing)
            {
                if (peerClosed)
                {
                    closeConnection("the other side closed the connection", true);
                }
                else if (!readError.empty())
                {
                    closeConnection(readError, true);
                }
            }
        }

        // ---- write ----
        if (conn.valid() && phase != Phase::Connecting && !outbuf.empty())
        {
            std::string error;
            const long n = conn.sendSome(outbuf.data(), outbuf.size(), error);
            if (n > 0)
            {
                outbuf.erase(outbuf.begin(), outbuf.begin() + n);
            }
            else if (n < 0)
            {
                closeConnection(error, true);
            }
        }

        // ---- timers ----
        if (conn.valid())
        {
            switch (phase)
            {
            case Phase::AwaitHello:
            case Phase::AwaitHelloAck:
            case Phase::AwaitJoin:
            case Phase::AwaitJoinAck:
                if (now > phaseDeadlineNs)
                {
                    closeConnection("handshake timed out", true);
                }
                break;
            case Phase::Closing:
                if (outbuf.empty() || now > phaseDeadlineNs)
                {
                    if (serverRole)
                    {
                        closeConnection("peer refused", false);
                    }
                    else
                    {
                        everJoined = false;
                        closeConnection("join refused", false);
                    }
                }
                break;
            case Phase::Joined:
                if (!suspendHeartbeats.load() && now - lastHbTxNs >= msToNs(t.heartbeatIntervalMs))
                {
                    Frame hb;
                    hb.type = MsgType::Heartbeat;
                    queueFrame(std::move(hb));
                    lastHbTxNs = now;
                }
                if (now - lastRxNs > msToNs(t.linkLostAfterMs))
                {
                    closeConnection("no message from the other side for " + std::to_string(t.linkLostAfterMs) +
                                         " ms",
                                     true);
                }
                break;
            default:
                break;
            }
        }
    }

    // ---- shutdown: tell the peer, flush briefly, close ----
    if (conn.valid() && phase == Phase::Joined)
    {
        Frame bye;
        bye.type = MsgType::SessionClosed;
        ErrorCode reason;
        {
            std::lock_guard<std::mutex> lock(mutex);
            reason = stopReason;
        }
        bye.setU16(Tag::ErrorCode, static_cast<uint16_t>(reason));
        queueFrame(std::move(bye));
        const int64_t until = monotonicNs() + 300'000'000;
        while (!outbuf.empty() && monotonicNs() < until)
        {
            std::string error;
            const long n = conn.sendSome(outbuf.data(), outbuf.size(), error);
            if (n < 0)
            {
                break;
            }
            outbuf.erase(outbuf.begin(), outbuf.begin() + n);
            if (!outbuf.empty())
            {
                TcpSocket::wait({}, {&conn}, 20);
            }
        }
        // Graceful close: closing with unread data in the receive buffer (e.g. the peer's
        // heartbeats) makes Windows send a reset, which can destroy SESSION_CLOSED before the
        // peer reads it. Half-close, then drain until the peer closes or 500 ms pass.
        conn.shutdownSend();
        const int64_t drainUntil = monotonicNs() + 500'000'000;
        while (monotonicNs() < drainUntil)
        {
            std::string ignored;
            uint8_t sink[512];
            const long n = conn.recvSome(sink, sizeof sink, ignored);
            if (n < 0)
            {
                break;  // peer closed (-2) or error
            }
            if (n == 0)
            {
                TcpSocket::wait({&conn}, {}, 20);
            }
        }
    }
    conn.close();
    listener.close();
    phase = Phase::Idle;
    setState(LinkState::Disconnected, "stopped");
}

void ControlLink::handleFrame(Frame& f, int64_t arrivalNs)
{
    if (f.msgId <= lastRxMsgId)
    {
        std::lock_guard<std::mutex> lock(mutex);
        ++stats.staleFramesDropped;  // duplicate or out of order: never acted upon
        return;
    }
    lastRxMsgId = f.msgId;
    lastRxNs = arrivalNs;
    {
        std::lock_guard<std::mutex> lock(mutex);
        ++stats.framesReceived;
    }
    if (phase != Phase::Joined)
    {
        if (serverRole)
        {
            serverHandleHandshake(f);
        }
        else
        {
            clientHandleHandshake(f);
        }
        return;
    }
    switch (f.type)
    {
    case MsgType::Heartbeat: {
        Frame ack;
        ack.type = MsgType::HeartbeatAck;
        ack.refId = f.msgId;
        ack.setI64(Tag::EchoSentNs, f.i64(Tag::SentNs).value_or(0));
        ack.setI64(Tag::RecvNs, arrivalNs);
        queueFrame(std::move(ack));  // SentNs (t3) stamped here
        std::lock_guard<std::mutex> lock(mutex);
        ++stats.heartbeatsReceived;
        break;
    }
    case MsgType::HeartbeatAck: {
        const int64_t t1 = f.i64(Tag::EchoSentNs).value_or(0);
        const int64_t t2 = f.i64(Tag::RecvNs).value_or(0);
        const int64_t t3 = f.i64(Tag::SentNs).value_or(0);
        offset.addSample(t1, t2, t3, arrivalNs);
        std::lock_guard<std::mutex> lock(mutex);
        stats.controlRttNs = arrivalNs - t1;
        if (offset.hasEstimate())
        {
            stats.thetaNs = offset.thetaNs();
            stats.thetaUncertaintyNs = offset.uncertaintyNs();
            stats.offsetSamples = offset.sampleCount();
            stats.controlRttBestNs = offset.bestDeltaNs();
        }
        break;
    }
    case MsgType::SessionClosed: {
        LinkEvent ev;
        ev.kind = LinkEventKind::PeerClosed;
        ev.code = static_cast<ErrorCode>(f.u16(Tag::ErrorCode).value_or(0));
        ev.text = std::string("the other side closed the session (") + std::string(errorCodeName(ev.code)) + ")";
        pushEvent(ev);
        everJoined = false;  // a deliberate close: no reconnect / no resume
        if (serverRole)
        {
            std::lock_guard<std::mutex> lock(mutex);
            resumeToken.clear();
        }
        closeConnection(ev.text, false);
        break;
    }
    case MsgType::Hello:
    case MsgType::HelloAck:
    case MsgType::Join:
    case MsgType::JoinAck: {
        LinkEvent ev;
        ev.kind = LinkEventKind::Info;
        ev.text = std::string("ignored unexpected ") + msgTypeName(f.type) + " on a joined connection";
        pushEvent(std::move(ev));
        break;
    }
    default: {
        LinkEvent ev;
        ev.kind = LinkEventKind::FrameReceived;
        ev.frame = f;
        pushEvent(std::move(ev));
        break;
    }
    }
}

void ControlLink::serverHandleHandshake(Frame& f)
{
    const int64_t now = monotonicNs();
    if (phase == Phase::AwaitHello)
    {
        if (f.type != MsgType::Hello)
        {
            sendErrorAndClose(ErrorCode::ProtocolMalformed, "expected HELLO", f.msgId);
            return;
        }
        const auto major = f.u16(Tag::ProtoMajor).value_or(0);
        const auto minor = f.u16(Tag::ProtoMinor).value_or(0);
        if (major != kProtocolMajor)
        {
            char text[96];
            std::snprintf(text, sizeof text, "producer speaks protocol %u.%u, performer offered %u.%u",
                          static_cast<unsigned>(kProtocolMajor), static_cast<unsigned>(kProtocolMinor),
                          static_cast<unsigned>(major), static_cast<unsigned>(minor));
            sendErrorAndClose(ErrorCode::VersionUnsupported, text, f.msgId);
            return;
        }
        if (f.u8(Tag::Role).value_or(0) != 2)
        {
            sendErrorAndClose(ErrorCode::WrongRole, "only a Performer Client can join a Producer Studio", f.msgId);
            return;
        }
        {
            std::lock_guard<std::mutex> lock(mutex);
            join.peerAppVersion = f.str(Tag::AppVersion).value_or("");
            join.protocolMinor = std::min<uint16_t>(kProtocolMinor, minor);
        }
        Frame ack;
        ack.type = MsgType::HelloAck;
        ack.refId = f.msgId;
        ack.setU16(Tag::ProtoMajor, kProtocolMajor);
        ack.setU16(Tag::ProtoMinor, std::min<uint16_t>(kProtocolMinor, minor));
        ack.setStr(Tag::AppVersion, sp.appVersion);
        queueFrame(std::move(ack));
        phase = Phase::AwaitJoin;
        phaseDeadlineNs = now + msToNs(t.handshakeTimeoutMs);
        return;
    }
    if (phase != Phase::AwaitJoin)
    {
        return;
    }
    if (f.type != MsgType::Join)
    {
        sendErrorAndClose(ErrorCode::ProtocolMalformed, "expected JOIN", f.msgId);
        return;
    }
    const std::string peerClientId = f.str(Tag::ClientId).value_or("");
    bool resumed = false;
    std::string reject;
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (f.has(Tag::ResumeToken))
        {
            if (!resumeToken.empty() && f.str(Tag::ResumeToken).value_or("") == resumeToken && peerClientId == clientId)
            {
                resumed = true;
            }
            else
            {
                reject = "resume refused (session ended or a different performer); join again with a new code";
            }
        }
        else if (f.has(Tag::PairingCode))
        {
            if (failedJoins >= t.maxFailedJoins)
            {
                reject = "too many wrong codes; ask the producer for a new pairing code";
            }
            else if (codeUsed)
            {
                reject = "pairing code already used; ask the producer for a new code";
            }
            else if (now - codeCreatedNs > msToNs(t.pairingCodeTtlMs))
            {
                reject = "pairing code expired; ask the producer for a new code";
            }
            else if (f.str(Tag::PairingCode).value_or("") != pairingCode)
            {
                ++failedJoins;
                ++stats.failedJoins;
                reject = "wrong pairing code";
            }
            else
            {
                codeUsed = true;
                clientId = peerClientId;
                resumeToken = makeRandomToken(32);
            }
        }
        else
        {
            reject = "JOIN without pairing code or resume token";
        }
    }
    if (!reject.empty())
    {
        sendErrorAndClose(ErrorCode::BadPairingCode, reject, f.msgId);
        return;
    }
    Frame ack;
    ack.type = MsgType::JoinAck;
    ack.refId = f.msgId;
    {
        std::lock_guard<std::mutex> lock(mutex);
        ack.setStr(Tag::SessionId, sp.sessionId);
        ack.setStr(Tag::ResumeToken, resumeToken);
        join.peerName = f.str(Tag::DisplayName).value_or("");
        join.peerAddress = connPeer;
        join.maxTakeSeconds = sp.maxTakeSeconds;
        ++stats.connections;
    }
    ack.setStr(Tag::DisplayName, sp.producerName);
    ack.setU32(Tag::MaxTakeSeconds, sp.maxTakeSeconds);
    queueFrame(std::move(ack));
    phase = Phase::Joined;
    everJoined = true;
    lastHbTxNs = 0;
    setState(LinkState::Connected, resumed ? "performer reconnected" : "performer joined");
    LinkEvent ev;
    ev.kind = LinkEventKind::Joined;
    ev.resumed = resumed;
    ev.text = resumed ? "performer reconnected" : "performer joined";
    pushEvent(std::move(ev));
}

void ControlLink::clientHandleHandshake(Frame& f)
{
    const int64_t now = monotonicNs();
    if (f.type == MsgType::Error)
    {
        LinkEvent ev;
        ev.kind = LinkEventKind::JoinRejected;
        ev.code = static_cast<ErrorCode>(f.u16(Tag::ErrorCode).value_or(0));
        ev.text = f.str(Tag::ErrorText).value_or(std::string(errorCodeName(ev.code)));
        pushEvent(ev);
        everJoined = false;  // a refusal is final: no automatic retry
        closeConnection(std::string("join refused: ") + std::string(errorCodeName(ev.code)) + " - " + ev.text, false);
        return;
    }
    if (phase == Phase::AwaitHelloAck)
    {
        if (f.type != MsgType::HelloAck || f.u16(Tag::ProtoMajor).value_or(0) != kProtocolMajor)
        {
            {
                std::lock_guard<std::mutex> lock(mutex);
                ++stats.protocolErrors;
            }
            everJoined = false;
            closeConnection("unexpected reply to HELLO", false);
            return;
        }
        {
            std::lock_guard<std::mutex> lock(mutex);
            join.peerAppVersion = f.str(Tag::AppVersion).value_or("");
            join.protocolMinor = std::min<uint16_t>(kProtocolMinor, f.u16(Tag::ProtoMinor).value_or(0));
        }
        Frame joinFrame;
        joinFrame.type = MsgType::Join;
        {
            std::lock_guard<std::mutex> lock(mutex);
            joinFrame.setStr(Tag::ClientId, clientId);
            if (everJoined && !resumeToken.empty())
            {
                joinFrame.setStr(Tag::ResumeToken, resumeToken);
            }
            else
            {
                joinFrame.setStr(Tag::PairingCode, cp.pairingCode);
            }
        }
        joinFrame.setStr(Tag::DisplayName, cp.performerName);
        queueFrame(std::move(joinFrame));
        phase = Phase::AwaitJoinAck;
        phaseDeadlineNs = now + msToNs(t.handshakeTimeoutMs);
        return;
    }
    if (phase == Phase::AwaitJoinAck && f.type == MsgType::JoinAck)
    {
        const bool resumed = everJoined;
        {
            std::lock_guard<std::mutex> lock(mutex);
            join.sessionId = f.str(Tag::SessionId).value_or("");
            join.peerName = f.str(Tag::DisplayName).value_or("");
            join.peerAddress = cp.hostAddress;
            join.maxTakeSeconds = f.u32(Tag::MaxTakeSeconds).value_or(0);
            resumeToken = f.str(Tag::ResumeToken).value_or("");
            ++stats.connections;
        }
        phase = Phase::Joined;
        everJoined = true;
        linkLostSinceNs = 0;
        lastHbTxNs = 0;
        setState(LinkState::Connected, resumed ? "reconnected to the producer" : "joined the producer's session");
        LinkEvent ev;
        ev.kind = LinkEventKind::Joined;
        ev.resumed = resumed;
        ev.text = resumed ? "reconnected" : "joined";
        pushEvent(std::move(ev));
        return;
    }
    {
        std::lock_guard<std::mutex> lock(mutex);
        ++stats.protocolErrors;
    }
    closeConnection(std::string("unexpected ") + msgTypeName(f.type) + " during the handshake", true);
}

