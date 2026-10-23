#pragma once

// Connection-level control channel (ADR-016). One instance per app, running its own thread:
//  - producer ("server"): listens on ONE explicitly chosen IPv4 address, accepts one performer;
//  - performer ("client"): connects, and after a successful join reconnects automatically.
// The link handles HELLO (version), JOIN (pairing code or resume token), HEARTBEAT (liveness +
// clock-offset samples stamped on this thread) and SESSION_CLOSED. Every other frame is passed
// to the application as a FrameReceived event, in order.
//
// Security (ADR-012): NOT encrypted, NOT authenticated against an attacker. The pairing code
// only prevents accidental connections. Codes and resume tokens are never put into events or logs.

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "rr/network/ClockOffset.h"
#include "rr/network/ControlProtocol.h"
#include "rr/network/Socket.h"
#include "rr/session/States.h"
#include "rr/shared/ErrorCodes.h"

struct LinkTimings
{
    uint32_t heartbeatIntervalMs = 1000;
    uint32_t linkLostAfterMs = 6000;   // no frame of any kind for this long (Stage 12: was 3000)
    uint32_t connectTimeoutMs = 5000;
    uint32_t handshakeTimeoutMs = 3000;
    uint32_t reconnectIntervalMs = 2000;
    uint32_t reconnectGiveUpMs = 120000;
    uint32_t pairingCodeTtlMs = 600000;  // 10 min (prov.)
    uint32_t maxFailedJoins = 5;          // then a new code is required
};

struct ServerParams
{
    std::string bindAddress;   // explicit IPv4 of one interface (or 127.0.0.1)
    uint16_t port = 52000;
    std::string sessionId;     // 8 hex
    std::string producerName;
    std::string appVersion;
    uint32_t maxTakeSeconds = 1800;
    LinkTimings timings;
};

struct ClientParams
{
    std::string hostAddress;
    uint16_t port = 52000;
    std::string pairingCode;   // never logged
    std::string performerName;
    std::string appVersion;
    LinkTimings timings;
};

enum class LinkEventKind
{
    StateChanged,    // `state` is the new state; `text` explains
    Joined,          // handshake complete (first join or resume); `resumed` set on resume
    FrameReceived,   // application frame in `frame`
    PeerClosed,      // SESSION_CLOSED received (`code`)
    JoinRejected,    // performer: join refused (`code`, `text`); no automatic retry
    ProtocolError,   // malformed/unexpected input; the connection was closed (`text`)
    Info,            // diagnostic text
};

struct LinkEvent
{
    LinkEventKind kind = LinkEventKind::Info;
    LinkState state = LinkState::Disconnected;
    Frame frame;
    ErrorCode code = ErrorCode::Ok;
    std::string text;
    bool resumed = false;
};

struct LinkStats
{
    uint64_t framesSent = 0;
    uint64_t framesReceived = 0;
    uint64_t staleFramesDropped = 0;   // msgId not increasing
    uint64_t protocolErrors = 0;
    uint64_t heartbeatsReceived = 0;
    uint64_t connections = 0;            // successful joins (incl. resumes)
    uint64_t reconnectAttempts = 0;
    uint64_t failedJoins = 0;
    int64_t controlRttNs = -1;         // latest HEARTBEAT round trip (TCP + thread scheduling)
    int64_t controlRttBestNs = -1;    // smallest round trip in the offset window; -1 = none yet
    int64_t thetaNs = 0;                // estimated (peer clock - local clock)
    int64_t thetaUncertaintyNs = -1;   // -1 = no estimate yet
    uint64_t offsetSamples = 0;
};

struct JoinInfo
{
    std::string sessionId;
    std::string peerName;
    std::string peerAppVersion;
    std::string peerAddress;
    uint32_t maxTakeSeconds = 0;
    uint16_t protocolMinor = 0;  // agreed minor version (min of both sides); 2+ = take transfer
};

class ControlLink
{
public:
    static std::unique_ptr<ControlLink> server(const ServerParams& params);
    static std::unique_ptr<ControlLink> client(const ClientParams& params);
    ~ControlLink();
    ControlLink(const ControlLink&) = delete;
    ControlLink& operator=(const ControlLink&) = delete;

    /** Server: binds and listens (errors are immediate). Client: starts connecting. */
    bool start(std::string& error);
    /** Sends SESSION_CLOSED (if connected), closes, joins the thread. Idempotent. */
    void stop(ErrorCode reason = ErrorCode::Shutdown);

    /**
     * Queue an application frame. msgId and SentNs are assigned on the link thread. Returns false
     * (frame dropped) if the link is not Connected.
     */
    bool send(Frame frame);
    std::vector<LinkEvent> pollEvents();

    LinkState getState() const noexcept { return state.load(); }
    LinkStats getStats() const;
    JoinInfo joinInfo() const;
    bool isServer() const noexcept { return serverRole; }

    /** Server only: invalidates the old code, returns a new 6-digit code (for display only). */
    std::string newPairingCode();
    std::string getPairingCode() const;  // for display only

    /** ---- test hooks ---- */
    void testSuspendHeartbeats(bool suspend) { suspendHeartbeats.store(suspend); }
    void testDropConnection() { dropRequested.store(true); }
    /** Client: next HELLO advertises this major version (to test version rejection). */
    void testSetProtocolMajor(uint16_t major) { testMajor = major; }

private:
    ControlLink() = default;
    void run();
    void setState(LinkState s, const std::string& why);
    void pushEvent(LinkEvent e);
    void queueFrame(Frame f);  // link thread only
    void closeConnection(const std::string& why, bool lost);
    void handleFrame(Frame& f, int64_t arrivalNs);
    void serverHandleHandshake(Frame& f);
    void clientHandleHandshake(Frame& f);
    void sendErrorAndClose(ErrorCode code, const std::string& text, uint32_t refId);
    void startClientConnect();

    bool serverRole = false;
    ServerParams sp;
    ClientParams cp;
    LinkTimings t;

    std::thread thread;
    std::atomic<bool> running{false};
    std::atomic<LinkState> state{LinkState::Disconnected};
    std::atomic<bool> suspendHeartbeats{false};
    std::atomic<bool> dropRequested{false};
    uint16_t testMajor = 0;

    mutable std::mutex mutex;  // guards the members below
    std::deque<Frame> appOutbox;
    std::deque<LinkEvent> events;
    LinkStats stats;
    JoinInfo join;
    std::string pairingCode;
    int64_t codeCreatedNs = 0;
    bool codeUsed = false;
    uint32_t failedJoins = 0;
    std::string resumeToken;
    std::string clientId;
    bool stopWithClose = false;
    ErrorCode stopReason = ErrorCode::Shutdown;

    /** ---- link thread only ---- */
    TcpSocket listener;
    TcpSocket conn;
    struct Rejecting
    {
        TcpSocket socket;
        int64_t closeAtNs;
    };
    std::vector<Rejecting> rejecting;  // refused extra connections, closed gracefully
    std::string connPeer;
    FrameDecoder decoder;
    std::vector<uint8_t> outbuf;
    uint32_t nextMsgId = 1;
    uint32_t lastRxMsgId = 0;
    enum class Phase { Idle, Connecting, AwaitHello, AwaitHelloAck, AwaitJoin, AwaitJoinAck, Joined, Closing } phase = Phase::Idle;
    int64_t phaseDeadlineNs = 0;
    int64_t lastRxNs = 0;
    int64_t lastHbTxNs = 0;
    int64_t linkLostSinceNs = 0;
    int64_t nextReconnectNs = 0;
    bool everJoined = false;
    ClockOffsetEstimator offset;
};

/** 6 random digits (std::random_device). */
std::string makePairingCode();
/** 32 random hex digits. */
std::string makeRandomToken(size_t hexDigits);

