#include "rr/control/SessionController.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

#include "rr/audio/TakeNaming.h"
#include "rr/shared/Clock.h"

namespace
{

int64_t ms(uint32_t v)
{
    return static_cast<int64_t>(v) * 1'000'000;
}

std::string joinReasons(const std::vector<std::string>& r)
{
    std::string out;
    for (size_t i = 0; i < r.size(); ++i)
    {
        out += (i ? "; " : "") + r[i];
    }
    return out;
}

// Messages that carry the session id (protocol 1.1); a mismatch is refused (Stage 9).
bool carriesSession(MsgType t)
{
    switch (t)
    {
        case MsgType::Arm: case MsgType::ArmAck: case MsgType::ScheduleStart: case MsgType::StartAck:
        case MsgType::TakeStarted: case MsgType::Cancel: case MsgType::StopSchedule: case MsgType::StopAck:
        case MsgType::LocalStop: case MsgType::TakeFinalised:
        case MsgType::TransferRequest: case MsgType::TransferAck:
            return true;
        default:
            return false;
    }
}

std::string nsText(int64_t v)
{
    return std::to_string(v);
}

std::string msBetween(int64_t from, int64_t to)
{
    if (from == 0 || to == 0)
    {
        return "n/a";
    }
    char b[32];
    std::snprintf(b, sizeof b, "%.3f", static_cast<double>(to - from) / 1e6);
    return b;
}

std::string msValue(double v)
{
    char b[32];
    std::snprintf(b, sizeof b, "%.3f", v);
    return b;
}

bool takeRunning(SessionState s)
{
    return s == SessionState::Recording || s == SessionState::Stopping || s == SessionState::Finalising;
}

}  // namespace

SessionController::SessionController(ControllerConfig config, RecorderPort& port, Logger& logger)
    : cfg(std::move(config)), port(port), log(logger) {}

SessionController::~SessionController()
{
    shutdown();
}

void SessionController::history(const std::string& line)
{
    historyLines.push_back(formatUtcIso8601Ms(utcNowMs()).substr(11, 12) + "  " + line);
    if (historyLines.size() > 300)
    {
        historyLines.pop_front();
    }
}

std::vector<std::string> SessionController::takeHistory() const
{
    return std::vector<std::string>(historyLines.begin(), historyLines.end());
}

bool SessionController::apply(SessionEvent event, const std::string& why)
{
    const Transition t = sessionTransition(cfg.role, state, event);
    if (!t.valid)
    {
        ++invalidEvents;
        log.log(Level::Warn, "session", "invalid_transition", why,
                 {{"state", std::string(sessionStateName(state))},
                  {"event", sessionEventName(event)}});
        return false;
    }
    if (t.next != state)
    {
        log.log(Level::Info, "session", "state", why,
                 {{"from", std::string(sessionStateName(state))},
                  {"to", std::string(sessionStateName(t.next))},
                  {"event", sessionEventName(event)}});
        history("state " + std::string(sessionStateName(state)) + " -> " +
                std::string(sessionStateName(t.next)) + " (" + why + ")");
    }
    state = t.next;
    if (state == SessionState::Completed)
    {
        updateReadiness();  // Completed is short-lived
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
bool SessionController::createSession(const std::string& address, uint16_t tcpPort, std::string& error)
{
    if (cfg.role != Role::Producer)
    {
        error = "only Producer Studio creates sessions";
        return false;
    }
    releaseFinishedLink();
    if (link)
    {
        error = "a session already exists";
        return false;
    }
    sessionId = makeSessionId();
    ServerParams p;
    p.bindAddress = address;
    p.port = tcpPort;
    p.sessionId = sessionId;
    p.producerName = cfg.displayName;
    p.appVersion = cfg.appVersion;
    p.maxTakeSeconds = cfg.timing.maxTakeSeconds;
    p.timings = cfg.link;
    link = ControlLink::server(p);
    if (cfg.testProtocolMajor != 0)
    {
        link->testSetProtocolMajor(cfg.testProtocolMajor);
    }
    if (!link->start(error))
    {
        link.reset();
        sessionId.clear();
        log.log(Level::Error, "session", "create_failed", error);
        return false;
    }
    bindAddress = address;
    portNumber = tcpPort;
    linkState = LinkState::Listening;  // until the link's own events arrive in poll()
    log.log(Level::Info, "session", "created", "session created",
             {{"session", sessionId}, {"bind", address}, {"port", std::to_string(tcpPort)},
              {"pairing_code", "<redacted>"}});
    history("session " + sessionId + " created on " + address + ":" + std::to_string(tcpPort));
    return true;
}

std::string SessionController::newPairingCode()
{
    if (!link || cfg.role != Role::Producer)
    {
        return {};
    }
    log.log(Level::Info, "session", "pairing_code_renewed", "new pairing code issued",
             {{"pairing_code", "<redacted>"}});
    history("new pairing code issued");
    return link->newPairingCode();
}

bool SessionController::join(const std::string& host, uint16_t tcpPort, const std::string& code, std::string& error)
{
    if (cfg.role != Role::Performer)
    {
        error = "only Performer Client joins sessions";
        return false;
    }
    releaseFinishedLink();
    if (link)
    {
        error = "already in a session";
        return false;
    }
    ClientParams p;
    p.hostAddress = host;
    p.port = tcpPort;
    p.pairingCode = code;
    p.performerName = cfg.displayName;
    p.appVersion = cfg.appVersion;
    p.timings = cfg.link;
    link = ControlLink::client(p);
    if (cfg.testProtocolMajor != 0)
    {
        link->testSetProtocolMajor(cfg.testProtocolMajor);
    }
    if (!link->start(error))
    {
        link.reset();
        return false;
    }
    bindAddress = host;
    portNumber = tcpPort;
    if (!sender)
    {
        sender = std::make_unique<TakeSender>(cfg.transferSender, log);  // idle until a request
    }
    linkState = LinkState::Connecting;  // until the link's own events arrive in poll()
    lastError.clear();
    log.log(Level::Info, "session", "join_started", "joining",
             {{"host", host}, {"port", std::to_string(tcpPort)}, {"pairing_code", "<redacted>"}});
    history("joining " + host + ":" + std::to_string(tcpPort));
    return true;
}

// A link that has ended for good (refused join, closed session, gave up reconnecting) is released
// so that the user can join or create again. Never while a local take is still running.
void SessionController::releaseFinishedLink()
{
    if (!link || linkState != LinkState::Disconnected || link->getState() != LinkState::Disconnected ||
        takeRunning(state) ||
        state == SessionState::Scheduled)
        {
        return;
    }
    link->stop(ErrorCode::UserStop);
    link.reset();
    peerReady = false;
    peerConsent = false;
    sessionId.clear();
    reportQueue.clear();
    stopTransfers();
}

void SessionController::setConsent(bool given)
{
    if (consent != given)
    {
        consent = given;
        log.log(Level::Info, "session", given ? "consent_given" : "consent_withdrawn",
                 given ? "local participant consented to recording" : "consent withdrawn");
        history(given ? "consent given" : "consent withdrawn");
        updateReadiness();
        sendStatus(true);
    }
}

void SessionController::leave()
{
    if (!link)
    {
        return;
    }
    if (takeRunning(state) || state == SessionState::Scheduled)
    {
        lastError = "stop the take before leaving the session";
        return;
    }
    link->stop(ErrorCode::UserStop);
    link.reset();
    stopTransfers();
    linkState = LinkState::Disconnected;
    apply(SessionEvent::LinkLost, "left the session");
    peerReady = false;
    peerConsent = false;
    sessionId.clear();
    history("left the session");
    log.log(Level::Info, "session", "left", "session closed by this side");
}

void SessionController::shutdown()
{
    stopTransfers();
    if (link)
    {
        link->stop(ErrorCode::Shutdown);
        link.reset();
    }
    if (state != SessionState::Closed)
    {
        Transition t = sessionTransition(cfg.role, state, SessionEvent::Shutdown);
        if (t.valid)
        {
            state = t.next;
        }
    }
}

// ---------------------------------------------------------------------------------------------
bool SessionController::send(Frame f)
{
    if (carriesSession(f.type) && !sessionId.empty())
    {
        f.setStr(Tag::SessionId, sessionId);
    }
    return link && link->send(std::move(f));
}

void SessionController::sendOrQueue(Frame f)
{
    if (!send(f))
    {
        reportQueue.push_back(std::move(f));  // re-sent after reconnection
    }
}

void SessionController::reply(MsgType type, uint32_t ref, uint32_t takeId, bool accepted, ErrorCode code,
                              const std::string& text)
                              {
    Frame r;
    r.type = type;
    r.refId = ref;
    r.setU32(Tag::TakeId, takeId);
    r.setU8(Tag::Accepted, accepted ? 1 : 0);
    if (!accepted)
    {
        r.setU16(Tag::ErrorCode, static_cast<uint16_t>(code));
        r.setStr(Tag::ErrorText, text);
        ++refused;
    }
    send(std::move(r));
}

void SessionController::refuse(const Frame& f, ErrorCode code, const std::string& text)
{
    log.log(Level::Warn, "session", "message_refused", text,
             {{"type", msgTypeName(f.type)}, {"code", std::string(errorCodeName(code))},
              {"state", std::string(sessionStateName(state))}});
    history(std::string("refused ") + msgTypeName(f.type) + ": " + text);
}

void SessionController::sendStatus(bool force)
{
    if (!link || linkState != LinkState::Connected)
    {
        return;
    }
    const std::string payload = std::to_string(localReady) + std::to_string(consent) + std::to_string(deliveryConsent) +
                                std::to_string(static_cast<int>(state)) + joinReasons(reasons) +
                                encodeChecks(localChecks);
    const int64_t now = monotonicNs();
    if (!force && payload == lastStatusPayload && now - lastStatusNs < ms(cfg.statusIntervalMs))
    {
        return;
    }
    Frame f;
    f.type = MsgType::ReadyStatus;
    f.setU8(Tag::Ready, localReady ? 1 : 0);
    f.setU8(Tag::Consent, consent ? 1 : 0);
    f.setU8(Tag::State, static_cast<uint8_t>(state));
    f.setStr(Tag::Reasons, joinReasons(reasons));
    f.setStr(Tag::ReadyChecks, encodeChecks(localChecks));
    if (cfg.role == Role::Performer)
    {
        f.setU8(Tag::DeliveryConsent, deliveryConsent ? 1 : 0);
    }
    if (send(std::move(f)))
    {
        lastStatusPayload = payload;
        lastStatusNs = now;
    }
}

void SessionController::updateReadiness()
{
    reasons.clear();
    const LocalReadiness local = port.readiness();
    reasons = local.reasons;
    localChecks = local.checks;
    localChecks.push_back(ReadinessCheck{ReadyItem::Consent, consent, true, consent ? "given" : "not given"});
    {
        const bool up = link && linkState == LinkState::Connected;
        localChecks.push_back(ReadinessCheck{ReadyItem::Connected, up, true,
                                               up ? std::string("connected") : std::string(linkStateName(linkState))});
    }
    if (cfg.role == Role::Performer)
    {
        const uint64_t n = link ? link->getStats().offsetSamples : 0;
        char d[96];
        std::snprintf(d, sizeof d, "%llu of %u samples, +/- %.3f ms", static_cast<unsigned long long>(n),
                      cfg.minOffsetSamples,
                      link ? static_cast<double>(link->getStats().thetaUncertaintyNs) / 1e6 : 0.0);
        localChecks.push_back(ReadinessCheck{ReadyItem::ClockOffset, n >= cfg.minOffsetSamples, true, d});
    }
    if (!consent)
    {
        reasons.emplace_back("recording consent not given");
    }
    const bool transferring = (receiver && receiver->anyActive()) || (sender && sender->isBusy());
    if (transferring)
    {
        reasons.emplace_back(cfg.role == Role::Producer ? "a take transfer is running (Record is available when it ends)"
                                                          : "sending a take to the producer");
    }
    if (!link)
    {
        reasons.emplace_back(cfg.role == Role::Producer ? "no session created" : "not joined to a session");
    }
    else if (linkState != LinkState::Connected)
    {
        reasons.emplace_back(cfg.role == Role::Producer ? "no performer connected" : "not connected to the producer");
    }
    else if (cfg.role == Role::Producer)
    {
        if (!peerConsent)
        {
            reasons.emplace_back("performer has not consented");
        }
        if (!peerReady)
        {
            reasons.emplace_back("performer not ready" + (peerReasons.empty() ? std::string() : ": " + peerReasons));
        }
    }
    else if (link->getStats().offsetSamples < cfg.minOffsetSamples)
    {
        reasons.emplace_back("measuring clock offset to the producer");
    }
    // Readiness reported to the peer means "this side could record" (excluding the peer).
    localReady = local.ok && consent && !transferring && link && linkState == LinkState::Connected &&
                   (cfg.role == Role::Producer || link->getStats().offsetSamples >= cfg.minOffsetSamples);
    const bool ready = reasons.empty();
    if (state == SessionState::NotReady || state == SessionState::Ready || state == SessionState::Completed)
    {
        const SessionState before = state;
        apply(ready ? SessionEvent::ReadinessOk : SessionEvent::ReadinessLost,
              ready ? "all readiness conditions hold" : "not ready: " + joinReasons(reasons));
        if (before != state)
        {
            sendStatus(true);
        }
    }
}

// ---------------------------------------------------------------------------------------------
void SessionController::setStartLeadMs(uint32_t v)
{
    cfg.timing.startLeadMs = std::min<uint32_t>(10000, std::max<uint32_t>(300, v));
}

void SessionController::setAutoStartLead(bool on)
{
    cfg.timing.autoStartLead = on;
}

// Provisional rule (ADR-019): the performer needs arm_ack_margin before the start, the SCHEDULE_START
// and START_ACK each take about one control RTT, the clock offset can be wrong by +/- u, and both
// apps add polling delay (UI 50 ms + link 20 ms, each side) -> margin + 2 RTT + 2 u + 200 ms.
//
// Stage 12: the RTT term is the SMALLEST round trip of the offset window, not the latest one.
// The latest swings with every Wi-Fi hiccup, so a single slow heartbeat arriving just before the
// producer pressed Record could push the minimum above the configured lead and have the take
// refused, while pressing again a second later worked. The smallest round trip is also the one
// the clock offset itself was measured from, so the two terms now describe the same sample.
uint32_t SessionController::minStartLeadMs() const
{
    const LinkStats ls = link ? link->getStats() : LinkStats{};
    const int64_t rttNs = ls.controlRttBestNs >= 0 ? ls.controlRttBestNs : ls.controlRttNs;
    const double extraMs = (2.0 * static_cast<double>(std::max<int64_t>(rttNs, 0)) +
                             2.0 * static_cast<double>(std::max<int64_t>(ls.thetaUncertaintyNs, 0))) / 1e6;
    return cfg.timing.armAckMarginMs + 200u + static_cast<uint32_t>(std::ceil(extraMs));
}

// Stage 12: the lead that will actually be used for the next take. With `autoStartLead` the
// producer sizes it for the link it measured -- a cabled LAN gets a short lead and a wireless link
// a long one, with no setting for the user to get wrong -- and never goes below the lead the user
// asked for, so raising the spin box by hand still works. Clamped to the same 300..10000 ms range
// as `setStartLeadMs`, so a very bad link reports "below the minimum" instead of silently
// scheduling a take minutes away.
uint32_t SessionController::effectiveStartLeadMs() const
{
    if (!cfg.timing.autoStartLead || cfg.role != Role::Producer)
    {
        return cfg.timing.startLeadMs;
    }
    const uint64_t needed = static_cast<uint64_t>(minStartLeadMs()) + kAutoStartLeadHeadroomMs;
    const uint64_t chosen = std::max<uint64_t>(needed, cfg.timing.startLeadMs);
    return static_cast<uint32_t>(std::min<uint64_t>(10000, std::max<uint64_t>(300, chosen)));
}

bool SessionController::startTake(std::string& error)
{
    if (cfg.role != Role::Producer)
    {
        error = "only the producer starts takes";
        return false;
    }
    updateReadiness();
    if (state != SessionState::Ready)
    {
        error = "not ready: " + joinReasons(reasons);
        return false;
    }
    const uint32_t leadMs = effectiveStartLeadMs();
    if (leadMs < minStartLeadMs())
    {
        error = "start lead " + std::to_string(leadMs) + " ms is below the minimum " +
                std::to_string(minStartLeadMs()) + " ms for the measured link";
        return false;
    }
    if (!apply(SessionEvent::UserRecord, "producer pressed Record"))
    {
        error = "Record is not allowed in this state";
        return false;
    }
    take = TakeView{};
    takeOpen = true;
    stopOwed = false;
    take.takeId = ++lastTakeId;
    stopAfterStart = false;
    // Fixed for the whole take: the schedule below and the evidence log must agree.
    take.startLeadMs = leadMs;
    take.armSentNs = monotonicNs();
    Frame f;
    f.type = MsgType::Arm;
    f.setU32(Tag::TakeId, take.takeId);
    f.setU32(Tag::MaxTakeSeconds, cfg.timing.maxTakeSeconds);
    take.armSent = send(std::move(f));
    armAckDeadline = monotonicNs() + ms(2000);
    history("take " + std::to_string(take.takeId) + ": ARM sent (waiting for the performer's ARM_ACK)");
    log.log(Level::Info, "session", "arm_sent", "ARM sent", {{"take", std::to_string(take.takeId)}});
    return true;
}

bool SessionController::stopTake(std::string& error)
{
    if (cfg.role != Role::Producer)
    {
        error = "only the producer stops session takes; use Stop & save";
        return false;
    }
    if (state == SessionState::Armed || state == SessionState::Scheduled)
    {
        // Stop before the start. Far enough ahead: cancel on both PCs. In the last 150 ms the local
        // recorder may already be starting, so stop it right after the start instead.
        if (take.startAtLocalNs != 0 && take.startAtLocalNs - monotonicNs() < ms(150))
        {
            stopAfterStart = true;
            history("take " + std::to_string(take.takeId) + ": Stop pressed just before the start; it stops right after");
            return true;
        }
        cancelBeforeStart("producer pressed Stop before the start");
        return true;
    }
    if (state == SessionState::Stopping || state == SessionState::Finalising)
    {
        error = "the take is already stopping; wait until both files are finalised";
        return false;
    }
    if (state != SessionState::Recording)
    {
        error = "no take is recording";
        return false;
    }
    const int64_t stopAt = monotonicNs() + ms(cfg.timing.stopLeadMs);
    sendStopSchedule(stopAt);
    port.scheduleStop(stopAt, false);
    apply(SessionEvent::UserStop, "producer pressed Stop");
    history("take " + std::to_string(take.takeId) + ": STOP_SCHEDULE sent" +
            (take.stopSent ? ""
                             : " FAILED (no connection): the performer keeps recording; STOP is re-sent when it reconnects"));
    return true;
}

bool SessionController::stopAndSave(std::string& error)
{
    if (cfg.role != Role::Performer)
    {
        error = "use Stop";
        return false;
    }
    if (state != SessionState::Recording)
    {
        error = "no take is recording";
        return false;
    }
    port.scheduleStop(0, false);
    take.stopCmdNs = monotonicNs();
    take.stopAtLocalNs = take.stopCmdNs;
    apply(SessionEvent::UserStopAndSave, "performer pressed Stop & save");
    Frame f;
    f.type = MsgType::LocalStop;
    f.setU32(Tag::TakeId, take.takeId);
    f.setStr(Tag::StopReason, "performer pressed Stop & save");
    sendOrQueue(std::move(f));
    history("take " + std::to_string(take.takeId) + ": stopped by the performer");
    return true;
}

// ---------------------------------------------------------------------------------------------
void SessionController::poll()
{
    if (link)
    {
        for (const auto& e : link->pollEvents())
        {
            handleLinkEvent(e);
        }
    }
    for (const auto& e : port.poll())
    {
        handlePortEvent(e);
    }
    checkTimers();
    pollTransfers();
    updateReadiness();
    sendStatus(false);
}

void SessionController::handleLinkEvent(const LinkEvent& e)
{
    switch (e.kind)
    {
    case LinkEventKind::StateChanged: {
        const LinkState old = linkState;
        linkState = e.state;
        log.log(e.state == LinkState::LinkLost ? Level::Warn : Level::Info, "link", "state", e.text,
                 {{"from", std::string(linkStateName(old))},
                  {"to", std::string(linkStateName(e.state))}});
        history("link " + std::string(linkStateName(e.state)) + ": " + e.text);
        if (old == LinkState::Connected && e.state != LinkState::Connected)
        {
            peerReady = false;
            const bool beforeStart = state == SessionState::Armed || state == SessionState::Scheduled;
            if (state == SessionState::Scheduled)
            {
                port.cancelTake();  // never start a take the other side cannot see (A-3)
            }
            apply(SessionEvent::LinkLost, "control link lost");
            if (beforeStart && takeOpen && !take.localStarted)
            {
                // Same outcome as CANCEL: the take never started on this PC (D-76).
                take.cancelled = true;
                take.cancelReason = "control link lost before the start";
                history("take " + std::to_string(take.takeId) + ": cancelled, control link lost before the start");
                logTakeTiming("cancelled");
            }
            if (state == SessionState::NotReady)
            {
                takeOpen = takeOpen && take.localStarted;
            }
        }
        if (cfg.role == Role::Performer && e.state == LinkState::Disconnected && state == SessionState::Recording)
        {
            // The session is over for good (closed by the producer, or reconnecting gave up): nobody
            // can send STOP any more, so stop and save the local take now rather than leave it open.
            port.scheduleStop(monotonicNs(), true);
            apply(SessionEvent::StopReceived, "session ended while recording");
            history("take " + std::to_string(take.takeId) +
                    ": session ended while recording; local take stopped and saved");
        }
        break;
    }
    case LinkEventKind::Joined: {
        const JoinInfo info = link->joinInfo();
        if (cfg.role == Role::Performer)
        {
            sessionId = info.sessionId;
        }
        log.log(Level::Info, "link", e.resumed ? "rejoined" : "joined", e.text,
                 {{"session", info.sessionId}, {"peer", info.peerName}, {"peer_address", info.peerAddress},
                  {"peer_version", info.peerAppVersion}});
        history(std::string(e.resumed ? "reconnected" : "connected") + " (" + info.peerName + " at " + info.peerAddress + ")");
        lastStatusPayload.clear();
        sendStatus(true);
        if (cfg.role == Role::Producer && stopOwed && take.takeId != 0 && !take.peerFinalised)
        {
            const bool sent = sendStopSchedule(monotonicNs() + ms(cfg.timing.stopLeadMs));
            history("take " + std::to_string(take.takeId) + ": STOP_SCHEDULE " +
                    (sent ? "re-sent after reconnecting (the performer's take ends later than the producer's)"
                          : "still could not be sent"));
            log.log(Level::Warn, "session", "stop_resent", "STOP_SCHEDULE re-sent after reconnecting",
                     {{"take", std::to_string(take.takeId)}, {"sent", sent ? "true" : "false"}});
        }
        while (!reportQueue.empty()) {  // performer: reports made while disconnected
            if (!send(reportQueue.front()))
            {
                break;
            }
            reportQueue.pop_front();
        }
        break;
    }
    case LinkEventKind::FrameReceived:
        handleFrame(e.frame);
        break;
    case LinkEventKind::PeerClosed:
        peerReady = false;
        peerConsent = false;
        history(e.text);
        log.log(Level::Info, "link", "peer_closed", e.text);
        break;
    case LinkEventKind::JoinRejected:
        lastError = e.text;
        history("join refused: " + e.text);
        log.log(Level::Warn, "link", "join_rejected", e.text, {{"code", std::string(errorCodeName(e.code))}});
        break;
    case LinkEventKind::ProtocolError:
        lastError = e.text;
        history(e.text);
        log.log(Level::Error, "link", "protocol_error", e.text);
        break;
    case LinkEventKind::Info:
        log.log(Level::Info, "link", "info", e.text);
        break;
    }
}

void SessionController::handleFrame(const Frame& f)
{
    if (f.type == MsgType::ReadyStatus)
    {
        peerReady = f.u8(Tag::Ready).value_or(0) != 0;
        peerConsent = f.u8(Tag::Consent).value_or(0) != 0;
        peerReasons = f.str(Tag::Reasons).value_or("");
        peerChecks = decodeChecks(f.str(Tag::ReadyChecks).value_or(""));
        peerDeliveryConsent = f.u8(Tag::DeliveryConsent).value_or(0) != 0;
        return;
    }
    if (carriesSession(f.type) && !sessionId.empty())
    {
        const auto sid = f.str(Tag::SessionId);
        if (sid && *sid != sessionId)
        {
            ++refused;
            log.log(Level::Warn, "session", "wrong_session", "command for another session refused",
                     {{"type", msgTypeName(f.type)}, {"expected", sessionId}, {"got", *sid}});
            history(std::string("refused ") + msgTypeName(f.type) + " for another session (" + *sid + ")");
            refuse(f, ErrorCode::UnknownTake, "session id mismatch");
            return;
        }
    }
    if (f.type == MsgType::Error)
    {
        const auto code = static_cast<ErrorCode>(f.u16(Tag::ErrorCode).value_or(0));
        lastError = std::string(errorCodeName(code)) + ": " + f.str(Tag::ErrorText).value_or("");
        history("peer reported " + lastError);
        log.log(Level::Warn, "session", "peer_error", lastError);
        return;
    }
    if (cfg.role == Role::Producer)
    {
        producerFrame(f);
    }
    else
    {
        performerFrame(f);
    }
}

void SessionController::producerFrame(const Frame& f)
{
    const uint32_t takeId = f.u32(Tag::TakeId).value_or(0);
    const bool current = takeOpen && takeId == take.takeId;
    const std::string tag = "take " + std::to_string(takeId) + ": ";
    switch (f.type)
    {
    case MsgType::ArmAck: {
        if (!current || state != SessionState::Armed || take.peerArmAck)
        {
            ++duplicates;
            refuse(f, ErrorCode::UnknownTake, "stale or duplicate ARM_ACK ignored");
            return;
        }
        if (f.u8(Tag::Accepted).value_or(0) == 0)
        {
            const std::string why = f.str(Tag::ErrorText).value_or("refused");
            history(tag + "performer REFUSED ARM: " + why);
            lastError = "performer refused the take: " + why;
            apply(SessionEvent::TakeRefused, "performer refused ARM");
            takeOpen = false;
            return;
        }
        take.peerArmAck = true;
        take.armAckRxNs = monotonicNs();
        apply(SessionEvent::ArmAckReceived, "performer accepted ARM");
        const int64_t startAt = monotonicNs() + ms(take.startLeadMs);
        take.startAtLocalNs = startAt;
        {
            const LinkStats ls = link->getStats();
            take.thetaNs = ls.thetaNs;
            take.thetaUncNs = ls.thetaUncertaintyNs;
            take.offsetSamples = ls.offsetSamples;
        }
        take.scheduleSentNs = monotonicNs();
        Frame s;
        s.type = MsgType::ScheduleStart;
        s.setU32(Tag::TakeId, take.takeId);
        s.setI64(Tag::StartAtNs, startAt);
        take.scheduleSent = send(std::move(s));
        startAckDeadline = startAt - ms(cfg.timing.armAckMarginMs);
        history(tag + "ARM_ACK received; SCHEDULE_START sent (start in " + std::to_string(take.startLeadMs) + " ms)");
        return;
    }
    case MsgType::StartAck: {
        if (!current || state != SessionState::Armed || !take.peerArmAck || take.peerStartAck)
        {
            ++duplicates;
            refuse(f, ErrorCode::UnknownTake, "stale or duplicate START_ACK ignored");
            return;
        }
        if (f.u8(Tag::Accepted).value_or(0) == 0)
        {
            const std::string why = f.str(Tag::ErrorText).value_or("refused");
            history(tag + "performer REFUSED the start: " + why);
            lastError = "performer refused the start: " + why;
            apply(SessionEvent::TakeRefused, "performer refused SCHEDULE_START");
            takeOpen = false;
            return;
        }
        take.peerStartAck = true;
        take.startAckRxNs = monotonicNs();
        take.peerPlannedStartNs = f.i64(Tag::PlannedLocalNs).value_or(0);
        PortTakeSpec spec;
        spec.takeId = take.takeId;
        spec.sessionId = sessionId;
        spec.role = Role::Producer;
        spec.maxTakeSeconds = cfg.timing.maxTakeSeconds;
        spec.startAtNs = take.startAtLocalNs;
        std::string error;
        if (!port.scheduleTake(spec, error))
        {
            Frame c;
            c.type = MsgType::Cancel;
            c.setU32(Tag::TakeId, take.takeId);
            c.setU16(Tag::ErrorCode, static_cast<uint16_t>(ErrorCode::DiskWrite));
            send(std::move(c));
            lastError = "local recording could not be scheduled: " + error;
            history(tag + "local schedule FAILED (" + error + "); CANCEL sent");
            apply(SessionEvent::TakeRefused, "local schedule failed");
            takeOpen = false;
            return;
        }
        apply(SessionEvent::StartAckReceived, "performer confirmed the start time");
        history(tag + "START_ACK received; both scheduled");
        return;
    }
    case MsgType::TakeStarted:
        if (!current || take.peerStarted)
        {
            ++duplicates;
            return;
        }
        take.peerStarted = true;
        take.peerStartedRxNs = monotonicNs();
        take.peerFirstFrame = f.u64(Tag::FirstFrame).value_or(0);
        take.peerFirstSampleNs = f.i64(Tag::FirstSampleNs).value_or(0);
        take.peerLateFrames = f.u64(Tag::LateFrames).value_or(0);
        history(tag + "performer CONFIRMED its recording started" +
                (take.peerLateFrames ? " (late by " + std::to_string(take.peerLateFrames) + " frames)" : ""));
        computeStartOffset();
        return;
    case MsgType::StopAck:
        // A re-sent STOP can be acknowledged after the take was completed here (report timed out).
        if (takeId == 0 || takeId != take.takeId || take.peerStopAck)
        {
            ++duplicates;
            return;
        }
        take.peerStopAck = f.u8(Tag::Accepted).value_or(0) != 0;
        take.stopAckRxNs = monotonicNs();
        history(tag + (take.peerStopAck ? "STOP_ACK received" : "performer refused STOP: " + f.str(Tag::ErrorText).value_or("")));
        return;
    case MsgType::LocalStop:
        history(tag + "performer stopped its own recording: " + f.str(Tag::StopReason).value_or(""));
        return;
    case MsgType::TakeFinalised:
        if (takeId != take.takeId || take.peerFinalised)
        {
            ++duplicates;
            return;
        }
        take.peerFinalised = true;
        take.peerFinalisedRxNs = monotonicNs();
        stopOwed = false;
        take.peerStatus = static_cast<TakeStatus>(f.u8(Tag::Status).value_or(0));
        take.peerFrames = f.u64(Tag::Frames).value_or(0);
        finishedTakes[takeId] = FinishedTake{take.peerStatus, take.peerFrames, {}};
        if (cfg.autoTransfer)
        {
            autoQueue.push_back(takeId);  // requested once this take has ended on both PCs
        }
        history(tag + "performer's take " + std::string(takeStatusName(take.peerStatus)) + ", " +
                std::to_string(take.peerFrames) + " frames");
        maybeComplete();
        return;
    case MsgType::TransferAck:
        if (f.u8(Tag::Accepted).value_or(0) != 0)
        {
            history(tag + "performer is sending its take (copy; its original stays on the performer's PC)");
        }
        else
        {
            const auto code = static_cast<ErrorCode>(f.u16(Tag::ErrorCode).value_or(0));
            const std::string why = "performer refused: " + std::string(errorCodeName(code)) + ": " +
                                    f.str(Tag::ErrorText).value_or("");
            history(tag + "transfer " + why);
            if (receiver)
            {
                receiver->cancel(takeId, why);
            }
        }
        return;
    default:
        ++refused;
        refuse(f, ErrorCode::ProtocolMalformed, "message not valid for the producer");
        return;
    }
}

void SessionController::performerFrame(const Frame& f)
{
    const uint32_t takeId = f.u32(Tag::TakeId).value_or(0);
    const int64_t now = monotonicNs();
    switch (f.type)
    {
    case MsgType::Arm: {
        if (takeId <= lastTakeId)
        {
            ++duplicates;
            reply(MsgType::ArmAck, f.msgId, takeId, false, ErrorCode::TakeIdConflict, "take id already used (duplicate or delayed ARM)");
            refuse(f, ErrorCode::TakeIdConflict, "duplicate or delayed ARM");
            return;
        }
        updateReadiness();
        const Transition t = performerTransition(state, SessionEvent::ArmReceived);
        if (!t.valid)
        {
            const ErrorCode code = !consent ? ErrorCode::NoConsent
                                   : state == SessionState::NotReady ? ErrorCode::NotReady
                                                                      : ErrorCode::Busy;
            const std::string text = state == SessionState::NotReady ? "not ready: " + joinReasons(reasons)
                                                                      : "busy (" + std::string(sessionStateName(state)) + ")";
            reply(MsgType::ArmAck, f.msgId, takeId, false, code, text);
            refuse(f, code, text);
            ++invalidEvents;
            return;
        }
        apply(SessionEvent::ArmReceived, "producer armed take " + std::to_string(takeId));
        take = TakeView{};
        takeOpen = true;
        take.takeId = takeId;
        take.armRxNs = now;
        lastTakeId = takeId;
        scheduleDeadline = now + ms(cfg.armToScheduleTimeoutMs);
        reply(MsgType::ArmAck, f.msgId, takeId, true, ErrorCode::Ok, "");
        history("take " + std::to_string(takeId) + ": ARM accepted");
        return;
    }
    case MsgType::ScheduleStart: {
        const bool current = takeOpen && takeId == take.takeId;
        if (current && take.peerStartAck)
        {
            // Duplicate SCHEDULE_START: answer again, never schedule a second recording.
            ++duplicates;
            Frame r;
            r.type = MsgType::StartAck;
            r.refId = f.msgId;
            r.setU32(Tag::TakeId, takeId);
            r.setU8(Tag::Accepted, 1);
            r.setI64(Tag::PlannedLocalNs, this->take.startAtLocalNs);
            send(std::move(r));
            return;
        }
        if (!current || state != SessionState::Armed)
        {
            reply(MsgType::StartAck, f.msgId, takeId, false, ErrorCode::UnknownTake, "no armed take with this id");
            refuse(f, ErrorCode::UnknownTake, "SCHEDULE_START for an unknown take");
            return;
        }
        take.scheduleRxNs = now;
        const LinkStats ls = link->getStats();
        // theta = producer clock - performer clock, so the producer's time T is T - theta here.
        const int64_t startLocal = f.i64(Tag::StartAtNs).value_or(0) - ls.thetaNs;
        if (ls.offsetSamples < cfg.minOffsetSamples)
        {
            reply(MsgType::StartAck, f.msgId, takeId, false, ErrorCode::NotReady, "clock offset not yet measured");
            apply(SessionEvent::TakeRefused, "no clock offset yet");
            takeOpen = false;
            return;
        }
        if (startLocal - now < ms(cfg.timing.armAckMarginMs))
        {
            reply(MsgType::StartAck, f.msgId, takeId, false, ErrorCode::ArmTooLate,
                  "start time already passed or less than " + std::to_string(cfg.timing.armAckMarginMs) + " ms away");
            refuse(f, ErrorCode::ArmTooLate, "start too late");
            apply(SessionEvent::TakeRefused, "start time too late");
            takeOpen = false;
            return;
        }
        PortTakeSpec spec;
        spec.takeId = takeId;
        spec.sessionId = sessionId;
        spec.role = Role::Performer;
        spec.maxTakeSeconds = cfg.timing.maxTakeSeconds;
        spec.startAtNs = startLocal;
        std::string error;
        if (!port.scheduleTake(spec, error))
        {
            reply(MsgType::StartAck, f.msgId, takeId, false, ErrorCode::DiskWrite, error);
            refuse(f, ErrorCode::DiskWrite, "local schedule failed: " + error);
            apply(SessionEvent::TakeRefused, "local schedule failed");
            takeOpen = false;
            return;
        }
        apply(SessionEvent::ScheduleReceived, "start scheduled");
        take.peerStartAck = true;  // here: "we acknowledged"
        take.startAtLocalNs = startLocal;
        take.thetaNs = ls.thetaNs;
        take.thetaUncNs = ls.thetaUncertaintyNs;
        take.offsetSamples = ls.offsetSamples;
        Frame r;
        r.type = MsgType::StartAck;
        r.refId = f.msgId;
        r.setU32(Tag::TakeId, takeId);
        r.setU8(Tag::Accepted, 1);
        r.setI64(Tag::PlannedLocalNs, startLocal);
        r.setI64(Tag::ThetaNs, ls.thetaNs);
        r.setI64(Tag::UncertaintyNs, ls.thetaUncertaintyNs);
        send(std::move(r));
        take.startAckSentNs = monotonicNs();
        history("take " + std::to_string(takeId) + ": start scheduled in " +
                std::to_string((startLocal - now) / 1'000'000) + " ms (clock offset " +
                std::to_string(ls.thetaNs / 1000) + " us +/- " + std::to_string(ls.thetaUncertaintyNs / 1000) + " us)");
        return;
    }
    case MsgType::Cancel: {
        if (takeOpen && takeId == take.takeId &&
            (state == SessionState::Armed || state == SessionState::Scheduled)) {
            port.cancelTake();
            apply(SessionEvent::CancelReceived, "producer cancelled take " + std::to_string(takeId));
            takeOpen = false;
            this->take.cancelled = true;
            this->take.cancelReason = "cancelled by the producer";
            history("take " + std::to_string(takeId) + ": cancelled by the producer");
            logTakeTiming("cancelled");
        }
        else if (takeOpen && takeId == take.takeId && state == SessionState::Recording)
        {
            // The CANCEL crossed the start (Stop pressed at the last moment): keep what was recorded.
            port.scheduleStop(now, true);
            this->take.stopCmdNs = now;
            this->take.stopAtLocalNs = now;
            apply(SessionEvent::StopReceived, "CANCEL arrived after the local start");
            history("take " + std::to_string(takeId) + ": CANCEL arrived after the local start; take stopped and saved");
        }
        else
        {
            ++duplicates;
        }
        return;
    }
    case MsgType::StopSchedule: {
        const bool current = takeOpen && takeId == take.takeId;
        if (current && (state == SessionState::Stopping || state == SessionState::Finalising ||
                        state == SessionState::Completed || take.stopSent))
                        {
            ++duplicates;
            reply(MsgType::StopAck, f.msgId, takeId, true, ErrorCode::Ok, "");  // idempotent
            return;
        }
        if (!current || state != SessionState::Recording)
        {
            reply(MsgType::StopAck, f.msgId, takeId, false, ErrorCode::UnknownTake, "no recording take with this id");
            refuse(f, ErrorCode::UnknownTake, "STOP for an unknown take");
            return;
        }
        const int64_t stopLocal = f.i64(Tag::StopAtNs).value_or(0) - link->getStats().thetaNs;
        port.scheduleStop(std::max(stopLocal, now), true);
        take.stopCmdNs = now;
        take.stopAtLocalNs = std::max(stopLocal, now);
        apply(SessionEvent::StopReceived, "producer stopped take " + std::to_string(takeId));
        take.stopSent = true;  // here: "stop accepted"
        reply(MsgType::StopAck, f.msgId, takeId, true, ErrorCode::Ok, "");
        history("take " + std::to_string(takeId) + ": stop scheduled by the producer");
        return;
    }
    case MsgType::TransferRequest:
        performerTransferRequest(f);
        return;
    default:
        ++refused;
        refuse(f, ErrorCode::ProtocolMalformed, "message not valid for the performer");
        return;
    }
}

void SessionController::handlePortEvent(const PortEvent& e)
{
    if (!takeOpen || e.takeId != take.takeId)
    {
        log.log(Level::Warn, "session", "stale_recorder_event", "recorder event for another take",
                 {{"take", std::to_string(e.takeId)}});
        return;
    }
    const std::string tag = "take " + std::to_string(e.takeId) + ": ";
    if (e.kind == PortEventKind::Started)
    {
        take.localStarted = true;
        take.localFirstSampleNs = e.firstSampleNs;
        take.localLateFrames = e.lateFrames;
        take.localStartedSeenNs = monotonicNs();
        take.localFirstFrame = e.firstFrame;
        take.devicePeriodFrames = e.devicePeriodFrames;
        take.devicePeriods = e.devicePeriods;
        apply(SessionEvent::LocalTakeStarted, "local recording started");
        history(tag + "LOCAL recording started" +
                (e.lateFrames ? " (late by " + std::to_string(e.lateFrames) + " frames)" : ""));
        if (cfg.role == Role::Performer)
        {
            Frame f;
            f.type = MsgType::TakeStarted;
            f.setU32(Tag::TakeId, e.takeId);
            f.setU64(Tag::FirstFrame, e.firstFrame);
            f.setI64(Tag::FirstSampleNs, e.firstSampleNs);
            f.setU64(Tag::LateFrames, e.lateFrames);
            sendOrQueue(std::move(f));
        }
        computeStartOffset();
        if (stopAfterStart && cfg.role == Role::Producer)
        {
            stopAfterStart = false;
            std::string ignored;
            stopTake(ignored);
        }
        return;
    }
    // Finalised (or cancelled)
    if (e.status == TakeStatus::Cancelled)
    {
        history(tag + "local take cancelled (no audio file)");
        return;
    }
    take.localFinalised = true;
    take.localFinalisedNs = monotonicNs();
    take.localStatus = e.status;
    take.localFrames = e.frames;
    take.localFile = e.file;
    take.localError = e.error;
    const bool early = state == SessionState::Recording;
    if (early)
    {
        apply(SessionEvent::LocalFault, "local take ended early: " + e.stopReason);
        if (cfg.role == Role::Producer)
        {
            // Make the performer stop too, so both takes cover the same span.
            sendStopSchedule(monotonicNs() + ms(cfg.timing.stopLeadMs));
        }
        else
        {
            Frame f;
            f.type = MsgType::LocalStop;
            f.setU32(Tag::TakeId, take.takeId);
            f.setStr(Tag::StopReason, e.stopReason + (e.error.empty() ? "" : ": " + e.error));
            sendOrQueue(std::move(f));
        }
    }
    apply(SessionEvent::LocalFinalised, "local take " + std::string(takeStatusName(e.status)));
    history(tag + "LOCAL take " + std::string(takeStatusName(e.status)) + (e.finalised ? " (finalised)" : " (NOT finalised)") +
            ", " + std::to_string(e.frames) + " frames" + (e.error.empty() ? "" : ", " + e.error));
    if (cfg.role == Role::Performer && e.finalised)
    {
        finishedTakes[e.takeId] = FinishedTake{e.status, e.frames, e.file};  // candidate for transfer
    }
    if (cfg.role == Role::Performer)
    {
        Frame f;
        f.type = MsgType::TakeFinalised;
        f.setU32(Tag::TakeId, e.takeId);
        f.setU8(Tag::Status, static_cast<uint8_t>(e.status));
        f.setU64(Tag::Frames, e.frames);
        f.setStr(Tag::StopReason, e.stopReason);
        sendOrQueue(std::move(f));
        takeOpen = false;
        logTakeTiming(std::string(takeStatusName(e.status)));
    }
    else
    {
        maybeComplete();
    }
}

// Producer: tell the performer to stop the current take at stopAt (this PC's clock). If there is
// no connection the stop is owed and re-sent, with a new stop time, when the performer reconnects;
// the performer's take is then longer than the producer's, which its report shows.
bool SessionController::sendStopSchedule(int64_t stopAt)
{
    Frame f;
    f.type = MsgType::StopSchedule;
    f.setU32(Tag::TakeId, take.takeId);
    f.setI64(Tag::StopAtNs, stopAt);
    take.stopCmdNs = monotonicNs();
    take.stopAtLocalNs = stopAt;
    take.stopSent = send(std::move(f));
    stopOwed = !take.stopSent;
    stopAckDeadline = monotonicNs() + ms(2000);
    peerReportDeadline = stopAt + ms(cfg.timing.finaliseReportWaitMs);
    return take.stopSent;
}

void SessionController::maybeComplete()
{
    if (cfg.role != Role::Producer || state != SessionState::Finalising || !take.localFinalised)
    {
        return;
    }
    if (take.peerFinalised || take.peerReportTimedOut)
    {
        apply(SessionEvent::TakeComplete, take.peerFinalised ? "both takes reported" : "performer report timed out");
        takeOpen = false;
        logTakeTiming(take.peerFinalised ? "complete" : "performer report timed out");
    }
}

void SessionController::computeStartOffset()
{
    if (cfg.role != Role::Producer || !take.localStarted || !take.peerStarted || !link)
    {
        return;
    }
    const LinkStats ls = link->getStats();  // theta = performer - producer (producer is requester)
    const double deltaNs = static_cast<double>(take.peerFirstSampleNs - ls.thetaNs - take.localFirstSampleNs);
    take.hasStartOffset = true;
    take.startOffsetMs = deltaNs / 1e6;
    take.startOffsetUncMs = static_cast<double>(ls.thetaUncertaintyNs) / 1e6;
    char text[160];
    std::snprintf(text, sizeof text,
                  "take %u: estimated recording-start offset (performer - producer) %.3f ms +/- %.3f ms "
                  "(clock-offset uncertainty only; device input latency not included)",
                  take.takeId, take.startOffsetMs, take.startOffsetUncMs);
    history(text);
    log.log(Level::Info, "session", "start_offset_estimate", text);
}

void SessionController::checkTimers()
{
    const int64_t now = monotonicNs();
    if (cfg.role == Role::Producer && takeOpen)
    {
        if (state == SessionState::Armed && !take.peerArmAck && now > armAckDeadline)
        {
            Frame c;
            c.type = MsgType::Cancel;
            c.setU32(Tag::TakeId, take.takeId);
            c.setU16(Tag::ErrorCode, static_cast<uint16_t>(ErrorCode::Timeout));
            send(std::move(c));
            lastError = "performer did not confirm ARM in time";
            history("take " + std::to_string(take.takeId) + ": no ARM_ACK in time; CANCEL sent");
            apply(SessionEvent::TakeRefused, "ARM_ACK timeout");
            takeOpen = false;
        }
        else if (state == SessionState::Armed && take.peerArmAck && !take.peerStartAck && now > startAckDeadline)
        {
            Frame c;
            c.type = MsgType::Cancel;
            c.setU32(Tag::TakeId, take.takeId);
            c.setU16(Tag::ErrorCode, static_cast<uint16_t>(ErrorCode::Timeout));
            send(std::move(c));
            lastError = "performer did not confirm the start time in time";
            history("take " + std::to_string(take.takeId) + ": no START_ACK before the start; CANCEL sent");
            apply(SessionEvent::TakeRefused, "START_ACK timeout");
            takeOpen = false;
        } else if (state == SessionState::Finalising && !take.peerFinalised && now > peerReportDeadline &&
                   !take.peerReportTimedOut) {
            take.peerReportTimedOut = true;
            history("take " + std::to_string(take.takeId) + ": no report from the performer: its take status is UNKNOWN");
            maybeComplete();
        } else if (state == SessionState::Stopping && take.stopSent && !take.peerStopAck && now > stopAckDeadline &&
                   stopAckDeadline != 0)
                   {
            history("take " + std::to_string(take.takeId) + ": no STOP_ACK yet (performer may not have stopped)");
            stopAckDeadline = 0;
        }
    }
    if (cfg.role == Role::Performer && takeOpen && state == SessionState::Armed && now > scheduleDeadline)
    {
        history("take " + std::to_string(take.takeId) + ": no SCHEDULE_START after ARM; disarmed");
        apply(SessionEvent::ArmExpired, "no schedule after ARM");
        takeOpen = false;
    }
}

void SessionController::cancelBeforeStart(const std::string& why)
{
    Frame c;
    c.type = MsgType::Cancel;
    c.setU32(Tag::TakeId, take.takeId);
    c.setU16(Tag::ErrorCode, static_cast<uint16_t>(ErrorCode::Cancelled));
    send(std::move(c));
    port.cancelTake();
    take.cancelled = true;
    take.cancelReason = why;
    history("take " + std::to_string(take.takeId) + ": " + why + "; CANCEL sent, nothing recorded");
    apply(SessionEvent::TakeRefused, why);
    takeOpen = false;
    logTakeTiming("cancelled");
}

void SessionController::logTakeTiming(const std::string& outcome)
{
    const TakeView& t = take;
    const bool producer = cfg.role == Role::Producer;
    std::vector<Field> fields{
        {"take", std::to_string(t.takeId)},
        {"session", sessionId},
        {"role", producer ? "producer" : "performer"},
        {"outcome", outcome},
        {"start_lead_ms", std::to_string(t.startLeadMs)},
        {"start_at_local_ns", nsText(t.startAtLocalNs)},
        {"local_first_sample_ns", nsText(t.localFirstSampleNs)},
        {"local_first_frame", std::to_string(t.localFirstFrame)},
        {"local_late_frames", std::to_string(t.localLateFrames)},
        {"first_sample_minus_scheduled_ms", msBetween(t.startAtLocalNs, t.localFirstSampleNs)},
        {"local_start_seen_ns", nsText(t.localStartedSeenNs)},
        {"stop_cmd_ns", nsText(t.stopCmdNs)},
        {"stop_at_local_ns", nsText(t.stopAtLocalNs)},
        {"local_finalised_ns", nsText(t.localFinalisedNs)},
        {"local_status", t.localFinalised ? std::string(takeStatusName(t.localStatus)) : std::string("none")},
        {"local_frames", std::to_string(t.localFrames)},
        {"device_period_frames", std::to_string(t.devicePeriodFrames)},
        {"device_periods", std::to_string(t.devicePeriods)},
        {"theta_ns", nsText(t.thetaNs)},
        {"theta_uncertainty_ns", nsText(t.thetaUncNs)},
        {"offset_samples", std::to_string(t.offsetSamples)},
    };
    if (producer)
    {
        fields.insert(fields.end(), {
            {"arm_sent_ns", nsText(t.armSentNs)},
            {"arm_ack_rx_ns", nsText(t.armAckRxNs)},
            {"schedule_sent_ns", nsText(t.scheduleSentNs)},
            {"start_ack_rx_ns", nsText(t.startAckRxNs)},
            {"arm_to_ack_ms", msBetween(t.armSentNs, t.armAckRxNs)},
            {"schedule_to_ack_ms", msBetween(t.scheduleSentNs, t.startAckRxNs)},
            {"ack_margin_before_start_ms", msBetween(t.startAckRxNs, t.startAtLocalNs)},
            {"peer_planned_start_ns", nsText(t.peerPlannedStartNs)},
            {"peer_first_sample_ns", nsText(t.peerFirstSampleNs)},
            {"peer_first_frame", std::to_string(t.peerFirstFrame)},
            {"peer_late_frames", std::to_string(t.peerLateFrames)},
            {"peer_started_rx_ns", nsText(t.peerStartedRxNs)},
            {"stop_ack_rx_ns", nsText(t.stopAckRxNs)},
            {"peer_finalised_rx_ns", nsText(t.peerFinalisedRxNs)},
            {"peer_status", t.peerFinalised ? std::string(takeStatusName(t.peerStatus)) : std::string("unknown")},
            {"peer_frames", std::to_string(t.peerFrames)},
            {"start_offset_estimate_ms", t.hasStartOffset ? msValue(t.startOffsetMs) : "n/a"},
            {"start_offset_uncertainty_ms", t.hasStartOffset ? msValue(t.startOffsetUncMs) : "n/a"},
        });
    }
    else
    {
        fields.insert(fields.end(), {
            {"arm_rx_ns", nsText(t.armRxNs)},
            {"schedule_rx_ns", nsText(t.scheduleRxNs)},
            {"start_ack_sent_ns", nsText(t.startAckSentNs)},
            {"schedule_rx_to_start_ms", msBetween(t.scheduleRxNs, t.startAtLocalNs)},
        });
    }
    if (t.cancelled)
    {
        fields.push_back({"cancel_reason", t.cancelReason});
    }
    Record r;
    r.monoNs = monotonicNs();
    r.utcMs = utcNowMs();
    r.level = Level::Info;
    r.component = "session";
    r.event = "take_timing";
    r.message = "take timing record (monotonic ns of this PC)";
    r.fields = std::move(fields);
    log.submit(std::move(r));
    history("take " + std::to_string(t.takeId) + " timing: first sample " +
            msBetween(t.startAtLocalNs, t.localFirstSampleNs) + " ms after the scheduled time (" +
            std::to_string(t.localLateFrames) + " late frames), " + std::to_string(t.localFrames) + " frames, " + outcome);
}

// ---------------------------------------------------------------------------------------------
// Stage 11: take transfer. The control link only carries the request and its answer; the file
// moves on its own TCP connection (rr_transfer), so control messages are never delayed by it.

void SessionController::setAutoTransfer(bool on)
{
    cfg.autoTransfer = on;
}

void SessionController::setDeliveryConsent(bool given)
{
    if (deliveryConsent != given)
    {
        deliveryConsent = given;
        history(given ? "allowed the producer to receive copies of this PC's takes"
                      : "no longer allows copies of this PC's takes to be sent");
        log.log(Level::Info, "transfer", given ? "delivery_consent_given" : "delivery_consent_withdrawn",
                 given ? "performer allows take copies to be sent" : "performer withdrew permission to send take copies");
        sendStatus(true);
    }
}

bool SessionController::ensureReceiver(std::string& error)
{
    if (receiver && receiver->isRunning())
    {
        return true;
    }
    ReceiverParams p;
    p.bindAddress = bindAddress;
    p.port = static_cast<uint16_t>(portNumber + 2);  // control + 2 (media is control + 1)
    p.sessionId = sessionId;
    p.resumeWaitMs = cfg.transferResumeWaitMs;
    receiver = std::make_unique<TakeReceiver>(p, log);
    if (!receiver->start(error))
    {
        error = "cannot open the take-transfer port " + std::to_string(p.port) + ": " + error;
        receiver.reset();
        return false;
    }
    return true;  // the receiver itself reports "transfer listener on ..." in the history
}

bool SessionController::requestTransfer(uint32_t takeId, std::string& error)
{
    if (cfg.role != Role::Producer)
    {
        error = "only Producer Studio requests take copies";
        return false;
    }
    if (!link || linkState != LinkState::Connected)
    {
        error = "the performer is not connected";
        return false;
    }
    const JoinInfo info = link->joinInfo();
    if (info.protocolMinor < 2)
    {
        error = "the performer's app does not support take transfer (control protocol 1." +
                std::to_string(info.protocolMinor) + "; 1.2 needed)";
        return false;
    }
    if (takeRunning(state) || state == SessionState::Armed || state == SessionState::Scheduled)
    {
        error = "a take is being recorded; request the copy after it";
        return false;
    }
    const auto it = finishedTakes.find(takeId);
    if (it == finishedTakes.end())
    {
        error = "take " + std::to_string(takeId) + " has not been reported finalised by the performer";
        return false;
    }
    std::filesystem::path dir = port.sessionFolder();
    if (!dir.empty())
    {
        dir /= "from_performer";
    }
    else if (!cfg.receivedRoot.empty())
    {
        dir = cfg.receivedRoot / sessionId / "from_performer";
    }
    else
    {
        error = "no folder for received takes (record a take on this PC first)";
        return false;
    }
    if (!ensureReceiver(error))
    {
        return false;
    }
    receiver->setAllowedPeer(info.peerAddress);
    std::string token;
    if (!receiver->expect(takeId, it->second.frames, dir, token, error))
    {
        return false;
    }
    Frame f;
    f.type = MsgType::TransferRequest;
    f.setU32(Tag::TakeId, takeId);
    f.setU16(Tag::TransferPort, receiver->port());
    f.setStr(Tag::TransferToken, token);  // never logged
    if (!send(std::move(f)))
    {
        receiver->cancel(takeId, "the request could not be sent (control link down)");
        error = "the request could not be sent";
        return false;
    }
    history("take " + std::to_string(takeId) + ": copy requested from the performer (QUEUED; the original stays on the performer's PC)");
    log.log(Level::Info, "transfer", "requested", "take copy requested",
             {{"take", std::to_string(takeId)}, {"port", std::to_string(receiver->port())},
              {"expected_frames", std::to_string(it->second.frames)}, {"token", "<redacted>"}});
    return true;
}

void SessionController::cancelTransfer(uint32_t takeId)
{
    if (receiver)
    {
        receiver->cancel(takeId, "cancelled by the producer");
        history("take " + std::to_string(takeId) + ": transfer cancelled by the producer");
    }
}

void SessionController::performerTransferRequest(const Frame& f)
{
    const uint32_t takeId = f.u32(Tag::TakeId).value_or(0);
    const uint16_t xport = f.u16(Tag::TransferPort).value_or(0);
    const std::string token = f.str(Tag::TransferToken).value_or("");
    const std::string tag = "take " + std::to_string(takeId) + ": ";
    auto no = [&](ErrorCode code, const std::string& text)
    {
        reply(MsgType::TransferAck, f.msgId, takeId, false, code, text);
        refuse(f, code, text);
    };
    if (!deliveryConsent)
    {
        no(ErrorCode::TransferRefused, "the performer has not allowed copies of its takes to be sent");
        return;
    }
    if (takeRunning(state) || state == SessionState::Armed || state == SessionState::Scheduled)
    {
        no(ErrorCode::Busy, "recording in progress; ask again after the take");
        return;
    }
    const auto it = finishedTakes.find(takeId);
    if (it == finishedTakes.end() || it->second.file.empty())
    {
        no(ErrorCode::UnknownTake, "no finalised take with this id on the performer's PC");
        return;
    }
    bool hex = token.size() == 32;
    for (const char ch : token)
    {
        hex = hex && ((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'));
    }
    if (!hex || xport == 0 || !link)
    {
        no(ErrorCode::ProtocolMalformed, "malformed transfer request");
        return;
    }
    if (!sender)
    {
        sender = std::make_unique<TakeSender>(cfg.transferSender, log);
    }
    SendJob job;
    job.host = link->joinInfo().peerAddress;
    job.port = xport;
    job.sessionId = sessionId;
    job.token = token;
    job.takeId = takeId;
    job.file = std::filesystem::u8path(it->second.file);
    job.takeStatus = static_cast<uint8_t>(it->second.status);
    std::string error;
    if (!sender->start(job, error))
    {
        no(ErrorCode::Busy, error);
        return;
    }
    reply(MsgType::TransferAck, f.msgId, takeId, true, ErrorCode::Ok, {});
    history(tag + "producer asked for a copy; sending it (the original stays here, opened read-only)");
    log.log(Level::Info, "transfer", "send_started", "sending a copy of the take",
             {{"take", std::to_string(takeId)}, {"port", std::to_string(xport)}, {"token", "<redacted>"}});
}

void SessionController::pollTransfers()
{
    auto takeLines = [this](std::vector<std::string> lines)
    {
        for (auto& l : lines)
        {
            historyLines.push_back(std::move(l));  // already time-stamped
            if (historyLines.size() > 300)
            {
                historyLines.pop_front();
            }
        }
    };
    if (receiver)
    {
        takeLines(receiver->takeHistory());
    }
    if (sender)
    {
        takeLines(sender->takeHistory());
    }
    if (cfg.role == Role::Producer && !autoQueue.empty() && !takeRunning(state) &&
        state != SessionState::Armed && state != SessionState::Scheduled && linkState == LinkState::Connected &&
        !(receiver && receiver->anyActive())) {
        const uint32_t takeId = autoQueue.front();
        autoQueue.pop_front();
        std::string error;
        if (!requestTransfer(takeId, error))
        {
            history("take " + std::to_string(takeId) + ": automatic copy not requested: " + error);
        }
    }
}

void SessionController::stopTransfers()
{
    if (sender)
    {
        sender->stop();
        sender.reset();
    }
    if (receiver)
    {
        receiver->stop();
        receiver.reset();
    }
    autoQueue.clear();
}

ControllerSnapshot SessionController::snapshot() const
{
    ControllerSnapshot s;
    s.role = cfg.role;
    s.link = linkState;
    s.session = state;
    s.notReadyReasons = reasons;
    s.sessionId = sessionId;
    if (link && cfg.role == Role::Producer)
    {
        s.pairingCode = link->getPairingCode();
    }
    s.bindAddress = bindAddress;
    s.port = portNumber;
    if (link)
    {
        const JoinInfo info = link->joinInfo();
        s.peerName = info.peerName;
        s.peerAddress = info.peerAddress;
        s.linkStats = link->getStats();
    }
    s.localConsent = consent;
    s.peerReady = peerReady;
    s.peerConsent = peerConsent;
    s.peerReasons = peerReasons;
    s.localChecks = localChecks;
    s.peerChecks = peerChecks;
    s.startLeadMs = cfg.timing.startLeadMs;
    s.minStartLeadMs = cfg.role == Role::Producer ? minStartLeadMs() : 0;
    s.effectiveStartLeadMs = cfg.role == Role::Producer ? effectiveStartLeadMs() : 0;
    s.autoStartLead = cfg.timing.autoStartLead;
    s.take = take;
    s.lastError = lastError;
    s.invalidEvents = invalidEvents;
    s.refusedMessages = refused;
    s.duplicateMessages = duplicates;
    s.recorderDescription = port.description();
    if (receiver)
    {
        s.transfers = receiver->transfers();
        s.transferPort = receiver->port();
    }
    else if (sender)
    {
        s.transfers = sender->transfers();
    }
    s.deliveryConsent = deliveryConsent;
    s.peerDeliveryConsent = peerDeliveryConsent;
    s.autoTransfer = cfg.autoTransfer;
    s.protocolMinor = link ? link->joinInfo().protocolMinor : 0;
    return s;
}

