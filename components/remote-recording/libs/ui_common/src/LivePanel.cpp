#include "LivePanel.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

#include <QCheckBox>
#include <QComboBox>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileDialog>
#include <QFormLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QMessageBox>
#include <QPushButton>
#include <QSettings>
#include <QSlider>
#include <QSpinBox>
#include <QStandardPaths>
#include <QTimer>
#include <QVBoxLayout>

#include "AudioPanel.h"
#include "rr/media/LiveReport.h"
#include "rr/media/MediaPacket.h"
#include "rr/shared/BuildInfo.h"
#include "rr/shared/Clock.h"
#include "SessionPanel.h"

namespace
{

QString qs(const std::string& s)
{
    return QString::fromUtf8(s.data(), static_cast<qsizetype>(s.size()));
}

constexpr const char* kSettingsFrame = "live/frame_samples";
constexpr const char* kSettingsBitrate = "live/bitrate_kbps";
constexpr const char* kSettingsMode = "live/application";
constexpr const char* kSettingsGain = "live/gain_db";
constexpr const char* kSettingsJitter = "live/jitter_frames";

const char* const kHeadphones =
    "Use headphones on BOTH PCs. This app has no echo cancellation: sound from speakers reaches the "
    "microphone, is sent back (the other person hears themselves) and ends up in your own master "
    "recording.";

const char* const kConcealmentNote =
    "Live audio is a monitor only. Lost or late packets are filled in by Opus concealment for "
    "listening; this never repairs or changes any recording. Each PC records its own microphone "
    "locally; received live audio is never written to a recording.";

const char* const kTradeOff =
    "Jitter buffer: fewer frames = less delay but more dropouts when packets arrive unevenly; "
    "more frames = steadier but later (each frame adds one frame of delay in this direction).";

}  // namespace

LivePanel::LivePanel(Role role, const AppConfig& config, AudioPanel& audio, SessionPanel& session,
                     Logger& logger, QWidget* parent)
    : QWidget(parent), role(role), config(config), audio(&audio), session(&session), logger(logger) {
    const QString other = this->role == Role::Producer ? tr("the performer") : tr("the producer");
    auto* outer = new QVBoxLayout(this);
    outer->setContentsMargins(0, 0, 0, 0);
    auto* box = new QGroupBox(tr("Live audio (talkback, both directions)"));
    outer->addWidget(box);
    auto* form = new QFormLayout(box);
    QSettings settings;

    // ---- outgoing ----
    auto* sendRow = new QHBoxLayout;
    sendCheck = new QCheckBox(tr("Send my microphone live to %1").arg(other));
    sendCheck->setChecked(false);
    muteButton = new QPushButton(tr("Mute my microphone"));
    muteButton->setCheckable(true);
    muteButton->setToolTip(tr("Talkback mute: %1 hears silence; your own recording is NOT affected.").arg(other));
    sendRow->addWidget(sendCheck, 1);
    sendRow->addWidget(muteButton);
    form->addRow(sendRow);
    frameCombo = new QComboBox;
    for (const uint32_t f : {120u, 240u, 480u, 960u})
    {
        frameCombo->addItem(tr("%1 ms").arg(frameMs(f), 0, 'g', 3), static_cast<int>(f));
    }
    const int defaultFrame = static_cast<int>(this->config.audio.liveFrameUs * 48 / 1000);
    frameCombo->setCurrentIndex(
        std::max(0, frameCombo->findData(settings.value(QString::fromLatin1(kSettingsFrame), defaultFrame).toInt())));
    form->addRow(tr("Frame size:"), frameCombo);
    bitrateSpin = new QSpinBox;
    bitrateSpin->setRange(static_cast<int>(kMinBitrate / 1000), static_cast<int>(kMaxBitrate / 1000));
    bitrateSpin->setSuffix(tr(" kbit/s"));
    bitrateSpin->setValue(settings.value(QString::fromLatin1(kSettingsBitrate), 64).toInt());
    form->addRow(tr("Bitrate (constant):"), bitrateSpin);
    modeCombo = new QComboBox;
    modeCombo->addItem(tr("Lowest delay (Opus RESTRICTED_LOWDELAY)"), 0);
    modeCombo->addItem(tr("Music / mixed (Opus AUDIO, more codec delay)"), 1);
    modeCombo->setCurrentIndex(settings.value(QString::fromLatin1(kSettingsMode), 0).toInt() == 1 ? 1 : 0);
    form->addRow(tr("Codec mode:"), modeCombo);
    for (QComboBox* c : {frameCombo, modeCombo})
    {
        connect(c, qOverload<int>(&QComboBox::currentIndexChanged), this, [this] { applyCodecChange(); });
    }
    connect(bitrateSpin, qOverload<int>(&QSpinBox::valueChanged), this, [this] { applyCodecChange(); });
    connect(sendCheck, &QCheckBox::toggled, this, [this] { applySwitches(); });
    connect(muteButton, &QPushButton::toggled, this, [this] { applySwitches(); });

    // ---- incoming ----
    hearCheck = new QCheckBox(tr("Hear %1").arg(other));
    hearCheck->setChecked(false);
    form->addRow(hearCheck);
    connect(hearCheck, &QCheckBox::toggled, this, [this] { applySwitches(); });
    auto* gainRow = new QHBoxLayout;
    gainSlider = new QSlider(Qt::Horizontal);
    gainSlider->setRange(static_cast<int>(kMinGainDb), static_cast<int>(kMaxGainDb));
    gainSlider->setValue(settings.value(QString::fromLatin1(kSettingsGain), -12).toInt());
    gainLabel = new QLabel;
    gainRow->addWidget(gainSlider, 1);
    gainRow->addWidget(gainLabel);
    form->addRow(tr("Volume of %1:").arg(other), gainRow);
    auto* jitterRow = new QHBoxLayout;
    jitterSpin = new QSpinBox;
    jitterSpin->setRange(static_cast<int>(kMinTargetFrames), static_cast<int>(kMaxTargetFrames));
    jitterSpin->setSuffix(tr(" frames"));
    jitterSpin->setValue(
        settings.value(QString::fromLatin1(kSettingsJitter), static_cast<int>(this->config.audio.jitterDepthFrames)).toInt());
    jitterLabel = new QLabel;
    jitterRow->addWidget(jitterSpin);
    jitterRow->addWidget(jitterLabel, 1);
    form->addRow(tr("Jitter buffer:"), jitterRow);
    auto* tradeoff = new QLabel(tr(kTradeOff));
    tradeoff->setWordWrap(true);
    form->addRow(tradeoff);
    auto* headphones = new QLabel(tr(kHeadphones));
    headphones->setWordWrap(true);
    headphones->setObjectName(QStringLiteral("headphonesNotice"));
    form->addRow(headphones);
    connect(gainSlider, &QSlider::valueChanged, this, [this](int v)
    {
        QSettings().setValue(QString::fromLatin1(kSettingsGain), v);
        if (endpoint && endpoint->getIncoming())
        {
            endpoint->getIncoming()->setGainDb(static_cast<float>(v));
        }
        render();
    });
    connect(jitterSpin, qOverload<int>(&QSpinBox::valueChanged), this, [this](int v)
    {
        QSettings().setValue(QString::fromLatin1(kSettingsJitter), v);
        if (endpoint && endpoint->getIncoming())
        {
            endpoint->getIncoming()->setTargetFrames(static_cast<uint32_t>(v));  // applies at the next refill
        }
        render();
    });

    // ---- five separate status rows ----
    auto makeRow = [form](const QString& name)
    {
        auto* label = new QLabel;
        label->setWordWrap(true);
        label->setTextInteractionFlags(Qt::TextSelectableByMouse);
        form->addRow(name, label);
        return label;
    };
    captureRow = makeRow(tr("Local capture:"));
    recordingRow = makeRow(tr("Local recording:"));
    outgoingRow = makeRow(tr("Outgoing stream:"));
    outStatsLabel = makeRow(QString());
    incomingRow = makeRow(tr("Incoming stream:"));
    inStatsLabel = makeRow(QString());
    remoteRow = makeRow(tr("Remote participant:"));
    auto* note = new QLabel(tr(kConcealmentNote));
    note->setWordWrap(true);
    form->addRow(note);
    reportButton = new QPushButton(tr("Export live report (one page)..."));
    connect(reportButton, &QPushButton::clicked, this, [this] { exportReport(); });
    form->addRow(reportButton);

    timer = new QTimer(this);
    timer->setInterval(200);
    connect(timer, &QTimer::timeout, this, [this] { tick(); });
    timer->start();
    tick();
}

LivePanel::~LivePanel()
{
    shutDown();
}

LiveCodecSettings LivePanel::codecFromUi() const
{
    LiveCodecSettings c;
    c.frameSamples = static_cast<uint32_t>(frameCombo->currentData().toInt());
    c.bitrateBps = static_cast<uint32_t>(bitrateSpin->value()) * 1000u;
    c.application = modeCombo->currentData().toInt() == 1 ? OpusApplication::Audio
                                                            : OpusApplication::RestrictedLowDelay;
    return c;
}

void LivePanel::applyCodecChange()
{
    QSettings settings;
    settings.setValue(QString::fromLatin1(kSettingsFrame), frameCombo->currentData().toInt());
    settings.setValue(QString::fromLatin1(kSettingsBitrate), bitrateSpin->value());
    settings.setValue(QString::fromLatin1(kSettingsMode), modeCombo->currentData().toInt());
    // The encoder is configured at start: restart the endpoint (both directions resume at once).
    if (endpoint && endpoint->isRunning())
    {
        stopLive();
        startIfPossible();
    }
}

void LivePanel::applySwitches()
{
    if (!endpoint)
    {
        return;
    }
    if (auto* out = endpoint->getOutgoing())
    {
        out->setEnabled(sendCheck->isChecked());
        out->setMuted(muteButton->isChecked());
    }
    if (auto* in = endpoint->getIncoming())
    {
        in->setOutputEnabled(hearCheck->isChecked());
    }
    muteButton->setText(muteButton->isChecked() ? tr("MUTED - click to unmute") : tr("Mute my microphone"));
}

void LivePanel::startIfPossible()
{
    if (!session || !audio)
    {
        return;
    }
    const LiveContext ctx = session->liveContext();
    uint32_t mediaSession = 0;
    if (!ctx.connected || !sessionIdToU32(ctx.sessionId, mediaSession) || ctx.controlPort == 0 ||
        ctx.controlPort == 65535)
        {
        return;
    }
    const bool producer = role == Role::Producer;
    LiveEndpointConfig c;
    c.bindMode = producer;
    c.localAddress = ctx.localAddress;
    c.peerAddress = ctx.peerAddress;
    // Both sides derive the media port the same way: control port + 1 (ADR-017; 52001 by default).
    c.mediaPort = static_cast<uint16_t>(ctx.controlPort + 1);
    c.sessionId = mediaSession;
    c.hasOutgoing = true;
    c.outgoing.streamId = producer ? kStreamProducerMic : kStreamPerformerMic;
    c.outgoing.codec = codecFromUi();
    c.hasIncoming = true;
    c.incoming.streamId = producer ? kStreamPerformerMic : kStreamProducerMic;
    c.incoming.playout.gainDb = static_cast<float>(gainSlider->value());
    c.incoming.playout.targetFrames = static_cast<uint32_t>(jitterSpin->value());
    endpoint = std::make_unique<LiveEndpoint>(&logger);
    std::string error;
    if (!endpoint->start(c, &audio->getEngine().liveTap(), error))
    {
        lastError = "live audio could not start: " + error;
        endpoint.reset();
    }
    else
    {
        applySwitches();
        audio->getEngine().attachPlaybackContributor(endpoint->getIncoming());
        attached = true;
        lastError.clear();
    }
    runningSession = ctx.sessionId;
}

void LivePanel::stopLive()
{
    if (attached && audio)
    {
        audio->getEngine().detachPlaybackContributor();  // the callback can no longer touch the stream
    }
    attached = false;
    if (endpoint)
    {
        endpoint->stop();
        endpoint.reset();
    }
    runningSession.clear();
}

void LivePanel::tick()
{
    if (!session || !audio)
    {
        stopLive();
        return;
    }
    const LiveContext ctx = session->liveContext();
    if (!ctx.sessionOpen)
    {
        stopLive();
    }
    else if (ctx.connected && ctx.sessionId != runningSession)
    {
        stopLive();
        startIfPossible();
    }
    if (endpoint)
    {
        // While the control link is up, a silent media direction does not stop the other (ADR-018).
        endpoint->setControlLinkUp(ctx.connected);
    }
    render();
}

std::string LivePanel::localCaptureStatus() const
{
    if (!audio)
    {
        return "-";
    }
    AudioEngine& engine = audio->getEngine();
    if (!engine.captureOpen())
    {
        return "no input device open (open one in the audio panel)";
    }
    const auto& d = engine.captureDescription();
    std::string s = "running: " + d.deviceName + ", " + std::to_string(d.sampleRate) + " Hz, " +
                    std::to_string(d.channels) + " ch";
    if (engine.captureFault() != DeviceFault::None)
    {
        s += " - DEVICE FAULT (stopped or unplugged)";
    }
    return s;
}

std::string LivePanel::localRecordingStatus() const
{
    if (audio && audio->recordingActive())
    {
        return "RECORDING (local take, no session)";
    }
    if (!session)
    {
        return "-";
    }
    const LiveContext ctx = session->liveContext();
    return ctx.recordingStatus.empty() ? std::string("idle") : ctx.recordingStatus;
}

std::string LivePanel::remoteStatus() const
{
    if (!session)
    {
        return "-";
    }
    const LiveContext ctx = session->liveContext();
    if (!ctx.sessionOpen)
    {
        return "no session";
    }
    char rtt[32];
    std::snprintf(rtt, sizeof rtt, "%.1f", ctx.controlRttMs);
    return "'" + ctx.peerName + "' at " + ctx.peerAddress + ", control link " + ctx.linkState + ", control RTT " + rtt +
           " ms";
}

void LivePanel::render()
{
    gainLabel->setText(tr("%1 dB").arg(gainSlider->value()));
    captureRow->setText(qs(localCaptureStatus()));
    recordingRow->setText(qs(localRecordingStatus()));
    remoteRow->setText(qs(remoteStatus()));
    if (!endpoint)
    {
        const QString idle = lastError.empty() ? tr("starts when the session is connected") : qs(lastError);
        outgoingRow->setText(idle);
        incomingRow->setText(idle);
        outStatsLabel->clear();
        inStatsLabel->clear();
        jitterLabel->setText(tr("(= frames x the other side's frame size)"));
        return;
    }
    const EndpointStats e = endpoint->stats();
    if (const auto* out = endpoint->getOutgoing())
    {
        const auto o = out->stats();
        outgoingRow->setText(qs(outgoingStatusText(o, e)));
        QString remote = tr("no report from the other side yet");
        if (e.hasRemoteReport)
        {
            const auto& r = e.remoteReport;
            remote = tr("they received %1, lost (est.) %2, late %3, jitter %4 ms, underruns %5, concealed %6")
                         .arg(r.received)
                         .arg(r.lostEstimate)
                         .arg(r.late)
                         .arg(r.jitterUs / 1000.0, 0, 'f', 2)
                         .arg(r.underruns)
                         .arg(r.concealed);
        }
        outStatsLabel->setText(tr("sent %1 packets (%2 muted frames), send errors %3, capture gaps %4 frames, "
                                     "backlog trimmed %5 frames, codec delay %6 ms; %7")
                                      .arg(o.packetsSent)
                                      .arg(o.mutedFrames)
                                      .arg(o.sendErrors)
                                      .arg(o.tapGapFrames)
                                      .arg(o.backlogTrimFrames)
                                      .arg(o.lookaheadSamples / 48.0, 0, 'f', 2)
                                      .arg(remote));
    }
    if (const auto* in = endpoint->getIncoming())
    {
        const auto i = in->stats();
        incomingRow->setText(qs(incomingStatusText(i, e)));
        inStatsLabel->setText(tr("received %1, lost (est.) %2, late %3, duplicates %4, reordered %5, jitter %6 ms "
                                    "(max gap %7 ms), buffer %8/%9 (max %10), underruns %11, concealed %12, refills %13, "
                                    "catch-up %14, queue full %15, decode errors %16")
                                     .arg(i.arrival.received)
                                     .arg(i.arrival.lostEstimate)
                                     .arg(i.jb.late)
                                     .arg(i.arrival.duplicates)
                                     .arg(i.arrival.reordered)
                                     .arg(i.arrival.jitterMs, 0, 'f', 2)
                                     .arg(i.arrival.maxGapMs, 0, 'f', 1)
                                     .arg(i.jbHeld)
                                     .arg(i.jbTarget)
                                     .arg(i.jbMaxHeld)
                                     .arg(i.jb.underruns)
                                     .arg(i.concealed)
                                     .arg(i.jb.rebuffers)
                                     .arg(i.jb.catchupFrames)
                                     .arg(i.queueFullDrops)
                                     .arg(i.decodeErrors));
        jitterLabel->setText(i.lastFrameSamples != 0
                                   ? tr("= %1 ms at the other side's %2 ms frames")
                                         .arg(frameMs(i.lastFrameSamples) * jitterSpin->value(), 0, 'g', 3)
                                         .arg(frameMs(i.lastFrameSamples), 0, 'g', 3)
                                   : tr("(= frames x the other side's frame size)"));
    }
}

void LivePanel::exportReport()
{
    if (!endpoint)
    {
        QMessageBox::information(this, tr("Live report"), tr("Live audio is not running (no connected session)."));
        return;
    }
    const QString suggested =
        QDir(QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation))
            .filePath(QStringLiteral("rr_live_report_%1_%2.txt")
                          .arg(role == Role::Producer ? QStringLiteral("producer") : QStringLiteral("performer"),
                               QDateTime::currentDateTimeUtc().toString(QStringLiteral("yyyyMMdd-HHmmss"))));
    const QString path = QFileDialog::getSaveFileName(this, tr("Export live report"), suggested, tr("Text (*.txt)"));
    if (path.isEmpty())
    {
        return;
    }
    LiveReportConditions c;
    c.generatedUtc = formatUtcIso8601Ms(utcNowMs());
    c.role = role == Role::Producer ? "Producer Studio" : "Performer Client";
    c.appVersion = buildInfo().version;
    c.sessionId = session ? session->liveContext().sessionId : std::string();
    AudioEngine& engine = audio->getEngine();
    c.captureDevice = engine.captureOpen() ? engine.captureDescription().deviceName : "(none)";
    c.captureRate = engine.captureOpen() ? engine.captureDescription().sampleRate : 0;
    c.outputDevice = engine.playbackOpen() ? engine.playbackDescription().deviceName : "(none)";
    c.outputRate = engine.playbackRate();
    c.localCaptureStatus = localCaptureStatus();
    c.localRecordingStatus = localRecordingStatus();
    c.remoteParticipantStatus = remoteStatus();
    c.testConditions = "app run (fill in the network and set-up in the test record)";
    const auto answer = QMessageBox::question(this, tr("Live report"), tr("Are both people wearing headphones?"),
                                              QMessageBox::Yes | QMessageBox::No, QMessageBox::No);
    c.headphones = answer == QMessageBox::Yes ? "confirmed by the user" : "NOT confirmed";
    const QByteArray bytes = QString::fromStdString(liveReportText(c, *endpoint)).toUtf8();
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate) || file.write(bytes) != bytes.size())
    {
        QMessageBox::warning(this, tr("Export failed"), tr("Could not write %1: %2").arg(path, file.errorString()));
        return;
    }
    logger.log(Level::Info, "ui", "live_report_exported", "live report written", {{"path", path.toStdString()}});
}

void LivePanel::shutDown()
{
    if (timer)
    {
        timer->stop();
    }
    stopLive();
}

QString LivePanel::diagnosticsText() const
{
    QString out = QStringLiteral("=== Live audio (both directions) ===\n");
    if (!endpoint)
    {
        return out + QStringLiteral("not running (needs a connected session)\n");
    }
    LiveReportConditions c;
    c.role = role == Role::Producer ? "Producer Studio" : "Performer Client";
    c.appVersion = buildInfo().version;
    c.localCaptureStatus = localCaptureStatus();
    c.localRecordingStatus = localRecordingStatus();
    c.remoteParticipantStatus = remoteStatus();
    c.testConditions = "live view";
    c.headphones = "not asked (diagnostics view)";
    return out + QString::fromStdString(liveReportText(c, *endpoint));
}

