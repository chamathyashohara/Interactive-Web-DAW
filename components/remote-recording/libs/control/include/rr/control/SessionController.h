#pragma once

// Producer/performer session control (Stage 6). Single-threaded: every public method, including
// poll(), must be called from one thread (the UI thread in the apps, the main thread in the CLI).
// Network I/O happens on the ControlLink's own thread; recording on the recorder's threads.
//
// Rules enforced here:
//  - every state change goes through sessionTransition(); invalid events change
//    nothing, are logged, and messages that caused them are answered with a refusal;
//  - take ids are strictly increasing: a duplicated or delayed ARM/SCHEDULE_START/STOP can never
//    start or stop a second recording (duplicates are answered idempotently, stale ones refused);
//  - the producer shows a performer step only after the performer's own message (ARM_ACK,
//    START_ACK, TAKE_STARTED, TAKE_FINALISED), never because a command was sent;
//  - pairing codes and resume tokens are never logged.

#include <cstdint>
#include <deque>
#include <filesystem>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "rr/control/Readiness.h"
#include "rr/control/RecorderPort.h"
#include "rr/network/ControlLink.h"
#include "rr/session/SessionMachine.h"
#include "rr/shared/Config.h"
#include "rr/shared/Log.h"
#include "rr/transfer/TakeReceiver.h"
#include "rr/transfer/TakeSender.h"

struct ControllerConfig
{
    Role role = Role::Producer;
    SessionTimingConfig timing;
    LinkTimings link;
    std::string appVersion;
    std::string displayName;
    uint32_t armToScheduleTimeoutMs = 5000;  // performer: SCHEDULE_START must follow ARM
    uint32_t statusIntervalMs = 2000;
    uint32_t minOffsetSamples = 3;              // performer: before it can accept a schedule
    uint16_t testProtocolMajor = 0;             // TEST ONLY: non-zero announces this major in HELLO
    /** Stage 11: take transfer (performer's original -> producer's verified copy). */
    bool autoTransfer = false;                        // producer: request each finalised performer take
    std::filesystem::path receivedRoot;               // producer: used when the recorder has no session folder
    uint32_t transferResumeWaitMs = 60000;     // producer: paused transfer -> FAILED
    SenderParams transferSender;                // performer
};

/**
 * Everything the UI shows about one take. Producer: "peer*" flags are set only by the
 * performer's messages.
 */
struct TakeView
{
    uint32_t takeId = 0;
    bool armSent = false;
    bool peerArmAck = false;
    bool scheduleSent = false;
    bool peerStartAck = false;
    int64_t startAtLocalNs = 0;     // this PC's clock
    int64_t peerPlannedStartNs = 0; // performer's clock (from START_ACK)
    bool localStarted = false;
    int64_t localFirstSampleNs = 0;
    uint64_t localLateFrames = 0;
    bool peerStarted = false;
    int64_t peerFirstSampleNs = 0;  // performer's clock
    uint64_t peerLateFrames = 0;
    bool stopSent = false;
    bool peerStopAck = false;
    bool localFinalised = false;
    TakeStatus localStatus = TakeStatus::Complete;
    uint64_t localFrames = 0;
    std::string localFile;
    std::string localError;
    bool peerFinalised = false;
    bool peerReportTimedOut = false;
    TakeStatus peerStatus = TakeStatus::Complete;
    uint64_t peerFrames = 0;
    bool hasStartOffset = false;
    double startOffsetMs = 0.0;     // (performer first sample - producer first sample), estimated
    double startOffsetUncMs = 0.0; // +/- (clock-offset uncertainty only; callback jitter not included)

    /**
     * Stage 9 timing record (this PC's monotonic clock, ns; 0 = did not happen). Logged as
     * "take_timing" when the take ends (completed, failed or cancelled).
     */
    int64_t armSentNs = 0;          // producer
    int64_t armAckRxNs = 0;        // producer
    int64_t scheduleSentNs = 0;     // producer
    int64_t startAckRxNs = 0;      // producer
    int64_t armRxNs = 0;            // performer
    int64_t scheduleRxNs = 0;       // performer: SCHEDULE_START received
    int64_t startAckSentNs = 0;    // performer
    int64_t peerStartedRxNs = 0;   // producer: TAKE_STARTED received
    int64_t peerFinalisedRxNs = 0; // producer: TAKE_FINALISED received
    int64_t stopCmdNs = 0;          // producer: STOP_SCHEDULE sent; performer: received / own stop
    int64_t stopAtLocalNs = 0;     // when the local recorder was told to stop
    int64_t stopAckRxNs = 0;       // producer
    int64_t localStartedSeenNs = 0;
    int64_t localFinalisedNs = 0;
    uint64_t localFirstFrame = 0;   // capture frame index of the first written sample
    uint64_t peerFirstFrame = 0;
    uint32_t devicePeriodFrames = 0;
    uint32_t devicePeriods = 0;
    int64_t thetaNs = 0;             // clock offset used for the schedule (performer - producer as seen here)
    int64_t thetaUncNs = 0;
    uint64_t offsetSamples = 0;
    uint32_t startLeadMs = 0;
    bool cancelled = false;
    std::string cancelReason;
};

struct ControllerSnapshot
{
    Role role = Role::Producer;
    LinkState link = LinkState::Disconnected;
    SessionState session = SessionState::NotReady;
    std::vector<std::string> notReadyReasons;
    std::string sessionId;
    std::string pairingCode;   // producer only, for DISPLAY; never logged
    std::string bindAddress;
    uint16_t port = 0;
    std::string peerName;
    std::string peerAddress;
    bool localConsent = false;
    bool peerReady = false;
    bool peerConsent = false;
    std::string peerReasons;
    std::vector<ReadinessCheck> localChecks;  // every item on this PC (Stage 9)
    std::vector<ReadinessCheck> peerChecks;   // the other PC's items, from its READY_STATUS
    uint32_t startLeadMs = 0;           // configured scheduling lead (producer)
    uint32_t minStartLeadMs = 0;       // minimum for the measured link (producer)
    uint32_t effectiveStartLeadMs = 0; // what the next take would use (producer, Stage 12)
    bool autoStartLead = false;              // producer sizes the lead for the link (Stage 12)
    LinkStats linkStats;
    TakeView take;              // current or last take
    std::string lastError;
    uint64_t invalidEvents = 0;
    uint64_t refusedMessages = 0;
    uint64_t duplicateMessages = 0;
    std::string recorderDescription;
    /** Stage 11: take transfer. */
    std::vector<TransferView> transfers;  // producer: received copies; performer: takes sent
    bool deliveryConsent = false;              // performer: allows copies to be sent (XFER-05)
    bool peerDeliveryConsent = false;         // producer: the performer allows it (from READY_STATUS)
    bool autoTransfer = false;
    uint16_t protocolMinor = 0;           // agreed control protocol minor (2+ = transfer)
    uint16_t transferPort = 0;            // producer: listening transfer port (0 = not open)
};

class SessionController
{
public:
    SessionController(ControllerConfig config, RecorderPort& port, Logger& logger);
    ~SessionController();
    SessionController(const SessionController&) = delete;
    SessionController& operator=(const SessionController&) = delete;

    /** ---- producer ---- */
    bool createSession(const std::string& bindAddress, uint16_t port, std::string& error);
    std::string newPairingCode();
    bool startTake(std::string& error);  // Record
    /**
     * Stop. Before the start (Armed/Scheduled) this CANCELS the take on both PCs; while stopping or
     * finalising it is refused (the files are being closed).
     */
    bool stopTake(std::string& error);
    /**
     * Scheduling lead, clamped to 300..10000 ms. Record is refused while it is below
     * minStartLeadMs() for the measured link.
     */
    void setStartLeadMs(uint32_t ms);
    uint32_t minStartLeadMs() const;
    /**
     * Stage 12: the lead the next take will really use. Equal to the configured lead unless
     * `autoStartLead` is on, when the producer raises it to suit the measured link.
     */
    uint32_t effectiveStartLeadMs() const;
    void setAutoStartLead(bool on);
    bool autoStartLead() const { return cfg.timing.autoStartLead; }
    /**
     * Headroom added above minStartLeadMs() when choosing automatically, so ordinary jitter
     * does not land a take on the edge of the margin.
     */
    static constexpr uint32_t kAutoStartLeadHeadroomMs = 250;

    /** ---- performer ---- */
    bool join(const std::string& host, uint16_t port, const std::string& pairingCode, std::string& error);
    bool stopAndSave(std::string& error);  // performer's own Stop & save

    /**
     * ---- take transfer (Stage 11) ----
     * Producer: ask the performer for a verified copy of its finalised take `takeId`. Refused while
     * a take is being recorded, before the performer's TAKE_FINALISED, or if the performer's app
     * is older than control protocol 1.2.
     */
    bool requestTransfer(uint32_t takeId, std::string& error);
    void cancelTransfer(uint32_t takeId);  // producer: ends a queued/paused transfer as FAILED
    void setAutoTransfer(bool on);              // producer
    void setDeliveryConsent(bool given);        // performer: explicit permission to send copies (XFER-05)
    TakeReceiver* transferReceiver() { return receiver.get(); }  // tests
    TakeSender* transferSender() { return sender.get(); }        // tests

    /** ---- both ---- */
    void setConsent(bool given);
    void leave();     // ends the session (SESSION_CLOSED); not allowed while recording
    void shutdown();  // app closing
    void poll();
    ControllerSnapshot snapshot() const;
    std::vector<std::string> takeHistory() const;  // human-readable, newest last
    bool sessionActive() const { return link != nullptr; }
    ControlLink* getLink() { return link.get(); }  // tests

private:
    bool apply(SessionEvent event, const std::string& why);
    void handleLinkEvent(const LinkEvent& e);
    void handleFrame(const Frame& f);
    void producerFrame(const Frame& f);
    void performerFrame(const Frame& f);
    void handlePortEvent(const PortEvent& e);
    void updateReadiness();
    void sendStatus(bool force);
    bool send(Frame f);
    void sendOrQueue(Frame f);
    void reply(MsgType type, uint32_t ref, uint32_t take, bool accepted, ErrorCode code,
               const std::string& text);
    void refuse(const Frame& f, ErrorCode code, const std::string& text);
    void history(const std::string& line);
    void checkTimers();
    void maybeComplete();
    void computeStartOffset();
    bool sendStopSchedule(int64_t stopAt);
    void releaseFinishedLink();
    void cancelBeforeStart(const std::string& why);
    void logTakeTiming(const std::string& outcome);
    void pollTransfers();
    bool ensureReceiver(std::string& error);
    void performerTransferRequest(const Frame& f);
    void stopTransfers();

    ControllerConfig cfg;
    RecorderPort& port;
    Logger& log;
    std::unique_ptr<ControlLink> link;
    LinkState linkState = LinkState::Disconnected;
    SessionState state = SessionState::NotReady;

    std::string sessionId;
    std::string bindAddress;
    uint16_t portNumber = 0;
    bool consent = false;
    bool peerReady = false;
    bool peerConsent = false;
    std::string peerReasons;
    std::vector<std::string> reasons;
    std::vector<ReadinessCheck> localChecks;
    std::vector<ReadinessCheck> peerChecks;
    bool localReady = false;
    bool stopAfterStart = false;     // producer: Stop pressed in the last moments before the start
    std::string lastStatusPayload;
    int64_t lastStatusNs = 0;
    std::string lastError;

    TakeView take;
    bool takeOpen = false;            // a take is in progress (ids below are meaningful)
    uint32_t lastTakeId = 0;    // producer: last issued; performer: last accepted ARM
    int64_t armAckDeadline = 0;
    int64_t startAckDeadline = 0;
    int64_t scheduleDeadline = 0;
    int64_t peerReportDeadline = 0;
    int64_t stopAckDeadline = 0;
    uint32_t armMsgId = 0;
    bool stopOwed = false;            // producer: STOP_SCHEDULE could not be sent; re-sent on reconnect
    std::deque<Frame> reportQueue;  // performer reports waiting for a connection

    uint64_t invalidEvents = 0;
    uint64_t refused = 0;
    uint64_t duplicates = 0;
    std::deque<std::string> historyLines;

    /** Stage 11: take transfer. */
    struct FinishedTake
    {
        TakeStatus status = TakeStatus::Complete;
        uint64_t frames = 0;
        std::string file;  // performer: its finalised WAV
    };
    std::map<uint32_t, FinishedTake> finishedTakes;  // producer: from TAKE_FINALISED; performer: own files
    std::unique_ptr<TakeReceiver> receiver;          // producer
    std::unique_ptr<TakeSender> sender;              // performer
    bool deliveryConsent = false;
    bool peerDeliveryConsent = false;
    std::deque<uint32_t> autoQueue;
};

