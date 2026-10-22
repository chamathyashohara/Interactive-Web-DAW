#include "AudioPanel.h"

#include <algorithm>
#include <cmath>
#include <system_error>

#include <QCheckBox>
#include <QColor>
#include <QComboBox>
#include <QFont>
#include <QDesktopServices>
#include <QDir>
#include <QFileDialog>
#include <QFormLayout>
#include <QGridLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QListWidget>
#include <QProgressBar>
#include <QPushButton>
#include <QSettings>
#include <QSlider>
#include <QStandardPaths>
#include <QTimer>
#include <QUrl>
#include <QVBoxLayout>

#include "rr/audio/FileIo.h"
#include "rr/audio/TakeNaming.h"
#include "rr/audio/WavInspect.h"
#include "rr/shared/BuildInfo.h"
#include "rr/shared/Clock.h"

namespace
{

QString qs(const std::string& s)
{
    return QString::fromStdString(s);
}

QString qpath(const std::filesystem::path& p)
{
    return QDir::toNativeSeparators(QString::fromStdString(pathToUtf8(p)));
}

std::filesystem::path toPath(const QString& s)
{
#ifdef _WIN32
    return std::filesystem::path(s.toStdWString());
#else
    return std::filesystem::path(s.toStdString());
#endif
}

double toDbfs(float peak)
{
    return peak > 1e-6f ? 20.0 * std::log10(static_cast<double>(peak)) : -120.0;
}

constexpr int kMeterMin = -60;  // dBFS at the left end of a meter
constexpr int64_t kNoSignalNs = 3'000'000'000LL;  // DEV-04: 3 s (prov.)
constexpr float kSignalThreshold = 1e-5f;              // -100 dBFS

const char* const kSettingsInput = "audio/input_device";
const char* const kSettingsOutput = "audio/output_device";
const char* const kSettingsFolder = "audio/recordings_dir";
const char* const kSettingsMonitorGain = "audio/monitor_gain_db";

constexpr int64_t kClipHoldNs = 2'000'000'000LL;     // CLIP indicator stays lit 2 s
constexpr int64_t kProblemLogIntervalNs = 1'000'000'000LL;

const char* faultText(DeviceFault fault)
{
    switch (fault)
    {
    case DeviceFault::None: return "none";
    case DeviceFault::StoppedUnexpectedly: return "stopped unexpectedly (unplugged, disabled or failed)";
    case DeviceFault::Rerouted: return "moved to another device";
    }
    return "unknown";
}

}  // namespace

AudioPanel::AudioPanel(Role role, const AppConfig& config, Logger& logger, QWidget* parent)
    : QWidget(parent), role(role), config(config), logger(logger),
      engine(std::make_unique<AudioEngine>())
      {
    QSettings settings;
    recordingsDir = settings
                          .value(QString::fromLatin1(kSettingsFolder),
                                 QStandardPaths::writableLocation(QStandardPaths::MusicLocation) +
                                     QStringLiteral("/RemoteRecording"))
                          .toString();
    buildUi();

    std::string error;
    if (!engine->initialise(error))
    {
        showError(tr("Audio system unavailable: %1").arg(qs(error)));
        this->logger.log(Level::Error, "audio", "init_failed", error);
    }
    else
    {
        this->logger.log(Level::Info, "audio", "init", "audio system ready", {{"backend", engine->backendName()}});
        refreshDevices();
    }
    scanIncompleteFiles();

    timer = new QTimer(this);
    timer->setInterval(50);  // 20 Hz UI telemetry
    connect(timer, &QTimer::timeout, this, &AudioPanel::tick);
    timer->start();
    updateControls();
}

AudioPanel::~AudioPanel()
{
    shutDownAudio();
}

void AudioPanel::buildUi()
{
    auto* root = new QVBoxLayout(this);

    // --- devices -------------------------------------------------------------------------
    auto* devices = new QGroupBox(tr("Audio devices"));
    auto* form = new QFormLayout(devices);
    inputCombo = new QComboBox;
    outputCombo = new QComboBox;
    refreshButton = new QPushButton(tr("Refresh"));
    inputButton = new QPushButton(tr("Open input"));
    auto* inputRow = new QHBoxLayout;
    inputRow->addWidget(inputCombo, 1);
    inputRow->addWidget(inputButton);
    inputRow->addWidget(refreshButton);
    form->addRow(tr("Input (microphone):"), inputRow);
    formatLabel = new QLabel(tr("Input closed."));
    formatLabel->setWordWrap(true);
    form->addRow(tr("Input format:"), formatLabel);
    outputButton = new QPushButton(tr("Open output"));
    auto* outputRow = new QHBoxLayout;
    outputRow->addWidget(outputCombo, 1);
    outputRow->addWidget(outputButton);
    form->addRow(tr("Output (headphones):"), outputRow);
    outputFormatLabel = new QLabel(tr("Output closed."));
    outputFormatLabel->setWordWrap(true);
    form->addRow(tr("Output format:"), outputFormatLabel);
    root->addWidget(devices);

    // --- monitoring (explicit setting, off by default) -------------------------------------
    auto* monitoring = new QGroupBox(tr("Local monitoring (hear your own microphone)"));
    auto* monLayout = new QVBoxLayout(monitoring);
    auto* warning = new QLabel(
        tr("Warning: monitoring through loudspeakers can cause loud howling feedback. Use headphones, "
           "especially during live two-way communication. Monitoring changes only what you hear; "
           "the recording is never processed."));
    warning->setWordWrap(true);
    warning->setStyleSheet(QStringLiteral("color: #8a5a00; font-weight: bold;"));
    monLayout->addWidget(warning);
    auto* monRow = new QHBoxLayout;
    monitorCheck = new QCheckBox(tr("Monitor my input"));
    monitorGain = new QSlider(Qt::Horizontal);
    monitorGain->setRange(-40, 6);
    monitorGain->setValue(QSettings().value(QString::fromLatin1(kSettingsMonitorGain), 0).toInt());
    monitorGainLabel = new QLabel;
    toneButton = new QPushButton(tr("Test output (1 s tone, 440 Hz, -20 dBFS)"));
    monRow->addWidget(monitorCheck);
    monRow->addWidget(new QLabel(tr("Monitor gain:")));
    monRow->addWidget(monitorGain, 1);
    monRow->addWidget(monitorGainLabel);
    monLayout->addLayout(monRow);
    monLayout->addWidget(toneButton);
    processingLabel = new QLabel;
    processingLabel->setWordWrap(true);
    monLayout->addWidget(processingLabel);
    root->addWidget(monitoring);

    // --- meters --------------------------------------------------------------------------
    auto* metersBox = new QGroupBox(tr("Input level (bar: peak with hold; text: peak / RMS over 50 ms, dBFS)"));
    auto* grid = new QGridLayout(metersBox);
    for (uint32_t c = 0; c < kMaxChannels; ++c)
    {
        auto* bar = new QProgressBar;
        bar->setRange(kMeterMin * 10, 0);
        bar->setValue(kMeterMin * 10);
        bar->setTextVisible(false);
        auto* label = new QLabel(QStringLiteral("ch%1  -inf").arg(c + 1));
        auto* clip = new QLabel(tr("CLIP"));
        clip->setStyleSheet(QStringLiteral("color: white; background: #b00020; padding: 0 4px; font-weight: bold;"));
        grid->addWidget(label, static_cast<int>(c), 0);
        grid->addWidget(bar, static_cast<int>(c), 1);
        grid->addWidget(clip, static_cast<int>(c), 2);
        bar->setVisible(false);
        label->setVisible(false);
        clip->setVisible(false);
        meters.push_back(bar);
        meterLabels.push_back(label);
        clipLabels.push_back(clip);
        clipUntilNs.push_back(0);
    }
    signalWarning = new QLabel(
        tr("No input signal: the microphone is delivering digital silence. Check the mute key and "
           "Windows Sound settings (Recording > device > Levels), and Settings > Privacy & security > "
           "Microphone."));
    signalWarning->setWordWrap(true);
    signalWarning->setStyleSheet(QStringLiteral("color: #b00020; font-weight: bold;"));
    signalWarning->setVisible(false);
    grid->addWidget(signalWarning, static_cast<int>(kMaxChannels), 0, 1, 3);
    countersLabel = new QLabel;
    countersLabel->setWordWrap(true);
    grid->addWidget(countersLabel, static_cast<int>(kMaxChannels) + 1, 0, 1, 3);
    buffersLabel = new QLabel;
    buffersLabel->setWordWrap(true);
    grid->addWidget(buffersLabel, static_cast<int>(kMaxChannels) + 2, 0, 1, 3);
    root->addWidget(metersBox);

    // --- recording -----------------------------------------------------------------------
    auto* rec = new QGroupBox(role == Role::Producer ? tr("Local recording")
                                                      : tr("Local recording (test mode)"));
    auto* recLayout = new QVBoxLayout(rec);
    auto* folderRow = new QHBoxLayout;
    folderLabel = new QLabel;
    folderLabel->setWordWrap(true);
    folderLabel->setTextInteractionFlags(Qt::TextSelectableByMouse);
    folderButton = new QPushButton(tr("Change folder..."));
    openFolderButton = new QPushButton(tr("Open folder"));
    folderRow->addWidget(folderLabel, 1);
    folderRow->addWidget(folderButton);
    folderRow->addWidget(openFolderButton);
    recLayout->addLayout(folderRow);
    if (role == Role::Performer)
    {
        auto* note = new QLabel(tr("Stage 4 test mode: you can start a local take here to check recording. "
                                   "In the session stages only the producer starts takes (SES-08)."));
        note->setWordWrap(true);
        recLayout->addWidget(note);
    }
    auto* controlRow = new QHBoxLayout;
    recordButton = new QPushButton(tr("Record"));
    recLabel = new QLabel(tr("Not recording"));
    QFont recFont = recLabel->font();
    recFont.setBold(true);
    recFont.setPointSize(recFont.pointSize() + 4);
    recLabel->setFont(recFont);
    controlRow->addWidget(recordButton);
    controlRow->addWidget(recLabel, 1);
    recLayout->addLayout(controlRow);
    resultLabel = new QLabel;
    resultLabel->setWordWrap(true);
    resultLabel->setTextInteractionFlags(Qt::TextSelectableByMouse);
    recLayout->addWidget(resultLabel);
    takesList = new QListWidget;
    takesList->setMaximumHeight(110);
    recLayout->addWidget(new QLabel(tr("Takes this session:")));
    recLayout->addWidget(takesList);
    root->addWidget(rec);

    // --- incomplete files (ERR-05b) ------------------------------------------------------
    auto* incomplete = new QGroupBox(tr("Incomplete recordings found (.wav.partial)"));
    auto* incLayout = new QVBoxLayout(incomplete);
    incompleteList = new QListWidget;
    incompleteList->setMaximumHeight(80);
    recoverButton = new QPushButton(tr("Recover selected (writes a new .recovered.wav, keeps the original)"));
    incLayout->addWidget(incompleteList);
    incLayout->addWidget(recoverButton);
    root->addWidget(incomplete);

    connect(refreshButton, &QPushButton::clicked, this, &AudioPanel::refreshDevices);
    connect(inputButton, &QPushButton::clicked, this, &AudioPanel::toggleInput);
    connect(folderButton, &QPushButton::clicked, this, &AudioPanel::chooseFolder);
    connect(openFolderButton, &QPushButton::clicked, this, &AudioPanel::openFolder);
    connect(recordButton, &QPushButton::clicked, this, [this] {
        if (sessionControlled)
        {
            return;  // a session take is controlled by the session panel (SES-08)
        }
        if (recordingActive())
        {
            stopTake();
        }
        else
        {
            startTake();
        }
    });
    connect(recoverButton, &QPushButton::clicked, this, &AudioPanel::recoverSelected);
    connect(outputCombo, &QComboBox::currentTextChanged, this, [](const QString& name)
    {
        QSettings().setValue(QString::fromLatin1(kSettingsOutput), name);
    });
    connect(outputButton, &QPushButton::clicked, this, &AudioPanel::toggleOutput);
    connect(monitorCheck, &QCheckBox::toggled, this, &AudioPanel::setMonitoring);
    connect(monitorGain, &QSlider::valueChanged, this, [this](int db)
    {
        engine->monitor().setGainDb(static_cast<float>(db));
        QSettings().setValue(QString::fromLatin1(kSettingsMonitorGain), db);
        updateMonitorDescription();
    });
    connect(toneButton, &QPushButton::clicked, this, [this] {
        engine->monitor().startTestTone(440.0f, -20.0f, 1.0f);
        logger.log(Level::Info, "audio", "test_tone", "1 s test tone on the output");
    });
    engine->monitor().setGainDb(static_cast<float>(monitorGain->value()));
    folderLabel->setText(QDir::toNativeSeparators(recordingsDir));
}

std::filesystem::path AudioPanel::recordingsRoot() const
{
    return toPath(recordingsDir);
}

void AudioPanel::refreshDevices()
{
    if (engine->captureOpen() || engine->playbackOpen())
    {
        return;  // indices would no longer match the open devices
    }
    std::string error;
    const auto inputs = engine->captureDevices(error);
    const auto outputs = engine->playbackDevices(error);
    if (!error.empty())
    {
        showError(tr("Device list failed: %1").arg(qs(error)));
    }
    QSettings settings;
    const QString savedIn = settings.value(QString::fromLatin1(kSettingsInput)).toString();
    const QString savedOut = settings.value(QString::fromLatin1(kSettingsOutput)).toString();

    inputCombo->clear();
    int select = -1;
    for (const auto& d : inputs)
    {
        const QString name = qs(d.name);
        inputCombo->addItem(name + (d.isDefault ? tr("  [Windows default]") : QString()),
                              static_cast<qulonglong>(d.index));
        if (name == savedIn || (select < 0 && d.isDefault))
        {
            select = inputCombo->count() - 1;
        }
    }
    if (select >= 0)
    {
        inputCombo->setCurrentIndex(select);
    }
    outputCombo->clear();
    for (const auto& d : outputs)
    {
        outputCombo->addItem(qs(d.name), static_cast<qulonglong>(d.index));
        if (qs(d.name) == savedOut || (savedOut.isEmpty() && d.isDefault))
        {
            outputCombo->setCurrentIndex(outputCombo->count() - 1);
        }
    }
    if (inputs.empty())
    {
        showError(tr("No input device found. Connect a microphone and press Refresh."));
    }
    logger.log(Level::Info, "audio", "devices_enumerated", "device list refreshed",
                {{"inputs", std::to_string(inputs.size())}, {"outputs", std::to_string(outputs.size())}});
    updateControls();
}

void AudioPanel::toggleInput()
{
    if (engine->captureOpen())
    {
        if (recordingActive())
        {
            showError(tr("Stop the recording before closing the input."));
            return;
        }
        closeInput(QStringLiteral("user"));
    }
    else
    {
        openSelectedInput();
    }
}

bool AudioPanel::openSelectedInput()
{
    if (inputCombo->currentIndex() < 0)
    {
        showError(tr("Choose an input device first."));
        return false;
    }
    const auto index = static_cast<size_t>(inputCombo->currentData().toULongLong());
    CaptureOptions options;
    options.requiredSampleRate = config.audio.requiredSampleRateHz;
    options.periodMs = config.audio.devicePeriodMs;
    options.ringSeconds = config.audio.recordRingSeconds;
    std::string error;
    if (!engine->openCapture(index, options, RecorderOptions{}, error))
    {
        showError(tr("Not ready: %1").arg(qs(error)));
        logger.log(Level::Error, "audio", "input_open_failed", error,
                    {{"device", inputCombo->currentText().toStdString()}});
        updateControls();
        return false;
    }
    const auto& d = engine->captureDescription();
    QSettings().setValue(QString::fromLatin1(kSettingsInput), qs(d.deviceName));
    QString notes;
    for (const auto& n : d.conversionNotes)
    {
        notes += QStringLiteral("\n- ") + qs(n);
    }
    formatLabel->setText(tr("Recording format: WAV float32, %1 Hz, %2 channel(s), native rate and channels. "
                              "Device stream: %3, %4 Hz, %5 ch, period %6 frames x %7.%8")
                               .arg(d.sampleRate).arg(d.channels).arg(qs(d.deviceInternalFormat))
                               .arg(d.deviceInternalRate).arg(d.deviceInternalChannels)
                               .arg(d.devicePeriodFrames).arg(d.devicePeriods).arg(notes));
    peakHold.assign(d.channels, 0.0f);
    for (size_t c = 0; c < meters.size(); ++c)
    {
        meters[c]->setVisible(c < d.channels);
        meterLabels[c]->setVisible(c < d.channels);
        clipLabels[c]->setVisible(false);
        clipUntilNs[c] = 0;
    }
    inputOpenedNs = monotonicNs();
    lastSignalNs = 0;
    if (error.empty())
    {
        showInfo(tr("Input open: %1").arg(qs(d.deviceName)));
    }
    else
    {
        showError(tr("Input open: %1. %2").arg(qs(d.deviceName), qs(error)));  // output re-open failed
    }
    updateMonitorDescription();
    logger.log(Level::Info, "audio", "input_opened", "input device opened",
                {{"device", d.deviceName}, {"backend", d.backend},
                 {"rate", std::to_string(d.sampleRate)}, {"channels", std::to_string(d.channels)},
                 {"internal_format", d.deviceInternalFormat},
                 {"period_frames", std::to_string(d.devicePeriodFrames)}});
    updateControls();
    return true;
}

void AudioPanel::closeInput(const QString& reason)
{
    if (!engine->captureOpen())
    {
        return;
    }
    engine->closeCapture();
    formatLabel->setText(tr("Input closed."));
    for (size_t c = 0; c < meters.size(); ++c)
    {
        meters[c]->setVisible(false);
        meterLabels[c]->setVisible(false);
        clipLabels[c]->setVisible(false);
    }
    signalWarning->setVisible(false);
    logger.log(Level::Info, "audio", "input_closed", "input device closed",
                {{"reason", reason.toStdString()}});
    updateMonitorDescription();
    updateControls();
}

void AudioPanel::toggleOutput()
{
    if (engine->playbackOpen())
    {
        closeOutput(QStringLiteral("user"));
    }
    else
    {
        openSelectedOutput();
    }
}

bool AudioPanel::openSelectedOutput()
{
    if (outputCombo->currentIndex() < 0)
    {
        showError(tr("Choose an output device first."));
        return false;
    }
    const auto index = static_cast<size_t>(outputCombo->currentData().toULongLong());
    PlaybackOptions options;
    options.periodMs = config.audio.devicePeriodMs;
    std::string error;
    if (!engine->openPlayback(index, options, error))
    {
        showError(tr("Output not open: %1").arg(qs(error)));
        logger.log(Level::Error, "audio", "output_open_failed", error,
                    {{"device", outputCombo->currentText().toStdString()}});
        updateControls();
        return false;
    }
    const auto& p = engine->playbackDescription();
    logger.log(Level::Info, "audio", "output_opened", "output device opened",
                {{"device", p.deviceName}, {"rate", std::to_string(p.sampleRate)},
                 {"channels", std::to_string(p.channels)}, {"internal_rate", std::to_string(p.deviceInternalRate)}});
    showInfo(tr("Output open: %1").arg(qs(p.deviceName)));
    updateMonitorDescription();
    updateControls();
    return true;
}

void AudioPanel::closeOutput(const QString& reason)
{
    if (!engine->playbackOpen())
    {
        return;
    }
    engine->closePlayback();
    logger.log(Level::Info, "audio", "output_closed", "output device closed",
                {{"reason", reason.toStdString()}});
    updateMonitorDescription();
    updateControls();
}

void AudioPanel::setMonitoring(bool enabled)
{
    engine->monitor().setEnabled(enabled);
    logger.log(Level::Info, "audio", enabled ? "monitoring_on" : "monitoring_off",
                enabled ? "local monitoring enabled" : "local monitoring disabled",
                {{"gain_db", std::to_string(monitorGain->value())}});
    updateMonitorDescription();
}

// States exactly what differs between what is heard and what is saved (MONITOR_PATH.md §3).
void AudioPanel::updateMonitorDescription()
{
    monitorGainLabel->setText(tr("%1 dB").arg(monitorGain->value()));
    if (!engine->playbackOpen())
    {
        outputFormatLabel->setText(tr("Output closed."));
    }
    else
    {
        const auto& p = engine->playbackDescription();
        QString notes;
        for (const auto& n : p.notes)
        {
            notes += QStringLiteral("\n- ") + qs(n);
        }
        outputFormatLabel->setText(tr("%1: renders %2 Hz, %3 ch. Device stream: %4, %5 Hz, %6 ch, period %7 x %8.%9")
                                          .arg(qs(p.deviceName)).arg(p.sampleRate).arg(p.channels)
                                          .arg(qs(p.deviceInternalFormat)).arg(p.deviceInternalRate)
                                          .arg(p.deviceInternalChannels).arg(p.devicePeriodFrames)
                                          .arg(p.devicePeriods).arg(notes));
    }
    QString text = tr("Saved master: unprocessed (no gain, no resampling, no noise suppression, no AGC, "
                      "no compression).\nWhat you hear when monitoring: ");
    if (!monitorCheck->isChecked())
    {
        text += tr("monitoring is OFF.");
    }
    else
    {
        text += tr("channel map to stereo/output, monitor gain %1 dB").arg(monitorGain->value());
        if (engine->playbackOpen() &&
            engine->playbackDescription().deviceInternalRate != engine->playbackDescription().sampleRate)
            {
            text += tr(", resampled to %1 Hz by miniaudio").arg(engine->playbackDescription().deviceInternalRate);
        }
        text += tr(", silence on underruns, latency trims. Added delay: about %1 ms buffer plus both device "
                   "buffers (estimate, not measured).")
                    .arg(1000.0 * engine->monitor().stats().targetFrames / engine->monitor().getSampleRate(), 0, 'f', 0);
        if (!engine->captureOpen() || !engine->playbackOpen())
        {
            text += tr(" (Open both input and output to hear anything.)");
        }
    }
    processingLabel->setText(text);
}

// Logs new buffer/device problems at most once per second (not from the audio thread).
void AudioPanel::logProblemDeltas()
{
    const int64_t now = monotonicNs();
    if (now - lastProblemLogNs < kProblemLogIntervalNs)
    {
        return;
    }
    lastProblemLogNs = now;
    auto report = [this](const char* event, uint64_t value, uint64_t& logged, const char* what)
    {
        if (value > logged)
        {
            logger.log(Level::Warn, "audio", event, what,
                        {{"new", std::to_string(value - logged)}, {"total", std::to_string(value)}});
            logged = value;
        }
    };
    if (const CaptureIngest* ingest = engine->ingest())
    {
        const auto s = ingest->stats();
        report("record_ring_overrun", s.overrunEvents, loggedRecOverruns,
               "record ring overrun: captured audio dropped (gap filled with silence if recording)");
        report("capture_timing_anomaly", s.timingAnomalies, loggedTimingAnomalies,
               "capture callback arrived late (possible device/OS stall)");
    }
    const auto m = engine->monitor().stats();
    report("monitor_underrun", m.underrunEvents, loggedMonUnderruns, "monitor buffer ran dry (silence heard)");
    report("monitor_overflow", m.overflowEvents, loggedMonOverflows, "monitor buffer full (block not heard)");
    report("monitor_drift_trim", m.driftTrimEvents, loggedMonTrims, "excess monitor latency trimmed");
    const auto e = engine->deviceEvents();
    report("capture_device_fault", e.captureFaults, loggedCaptureFaults, "input device fault");
    report("playback_device_fault", e.playbackFaults, loggedPlaybackFaults, "output device fault");
}

void AudioPanel::chooseFolder()
{
    if (recordingActive())
    {
        return;
    }
    const QString dir = QFileDialog::getExistingDirectory(this, tr("Recordings folder"), recordingsDir);
    if (dir.isEmpty())
    {
        return;
    }
    recordingsDir = dir;
    QSettings().setValue(QString::fromLatin1(kSettingsFolder), dir);
    folderLabel->setText(QDir::toNativeSeparators(dir));
    sessionId.clear();  // the next take starts a new session folder under the new root
    sessionDir.clear();
    scanIncompleteFiles();
    logger.log(Level::Info, "audio", "folder_changed", "recordings folder changed",
                {{"folder", dir.toStdString()}});
}

void AudioPanel::openFolder()
{
    const std::filesystem::path p = lastTakeDir.empty() ? recordingsRoot() : lastTakeDir;
    std::error_code ec;
    std::filesystem::create_directories(p, ec);
    QDesktopServices::openUrl(QUrl::fromLocalFile(QString::fromStdString(pathToUtf8(p))));
}

void AudioPanel::startTake()
{
    auto* recorder = engine->recorder();
    if (!engine->captureOpen() || recorder == nullptr)
    {
        showError(tr("Open an input device first."));
        return;
    }
    if (sessionId.empty())
    {
        sessionId = makeSessionId();
        sessionDir = recordingsRoot() / sessionFolderName(utcNowMs(), sessionId);
    }
    std::error_code ec;
    std::filesystem::create_directories(sessionDir, ec);
    if (ec)
    {
        showError(tr("Cannot create the recordings folder %1: %2").arg(qpath(sessionDir), qs(ec.message())));
        return;
    }
    // REC-09: enough room for a take of the planned maximum length.
    const auto& d = engine->captureDescription();
    const uint64_t needed = static_cast<uint64_t>(config.timing.maxTakeSeconds) * d.sampleRate *
                                     d.channels * 4ULL + (1ULL << 20);
    const uint64_t freeBytes = availableDiskBytes(sessionDir);
    if (freeBytes < needed)
    {
        showError(tr("Not ready: not enough disk space. %1 MB free, %2 MB needed for a %3-minute take.")
                       .arg(freeBytes >> 20).arg(needed >> 20).arg(config.timing.maxTakeSeconds / 60));
        logger.log(Level::Error, "audio", "disk_space_low", "not enough disk space",
                    {{"free_bytes", std::to_string(freeBytes)}, {"needed_bytes", std::to_string(needed)}});
        return;
    }
    TakeRequest request;
    request.sessionDir = sessionDir;
    request.takeNumber = nextFreeTakeNumber(sessionDir, role, sessionId);
    request.role = role;
    request.sessionId = sessionId;
    request.appVersion = buildInfo().version + " (" + buildInfo().gitCommit + ")";
    request.maxTakeSeconds = config.timing.maxTakeSeconds;
    request.capture = d;
    if (request.takeNumber == 0)
    {
        showError(tr("No free take number left in this session folder."));
        return;
    }
    std::string error;
    if (!recorder->beginTake(request, error))
    {
        showError(tr("Recording did not start: %1").arg(qs(error)));
        logger.log(Level::Error, "audio", "take_start_failed", error);
        return;
    }
    lastTakeDir = sessionDir;
    resultLabel->clear();
    logger.log(Level::Info, "audio", "take_started", "take started",
                {{"take", std::to_string(request.takeNumber)}, {"session", sessionId},
                 {"folder", pathToUtf8(sessionDir)}});
    updateControls();
}

void AudioPanel::stopTake()
{
    if (auto* recorder = engine->recorder())
    {
        recorder->endTake(StopReason::User);
        logger.log(Level::Info, "audio", "take_stop_requested", "stop requested");
    }
}

bool AudioPanel::recordingActive() const
{
    auto* recorder = engine ? engine->recorder() : nullptr;
    return recorder != nullptr && recorder->status().state != RecorderState::Idle;
}

void AudioPanel::shutDownAudio()
{
    if (!engine)
    {
        return;
    }
    TakeRecorder* recorder = engine->recorder();
    if (recorder != nullptr)
    {
        recorder->stop();  // finalises an active take as complete_shutdown (ERR-05a)
        collectTakeReports();
    }
    closeInput(QStringLiteral("shutdown"));
    closeOutput(QStringLiteral("shutdown"));
}

void AudioPanel::tick()
{
    const int64_t now = monotonicNs();

    // ---- output / monitor (independent of the input; never touches recording) ----
    const MonitorStats ms = engine->monitor().stats();
    const double monRate = engine->monitor().getSampleRate();
    QString buffers;
    if (engine->playbackOpen())
    {
        if (engine->playbackFault() != DeviceFault::None)
        {
            const QString what = QString::fromLatin1(faultText(engine->playbackFault()));
            closeOutput(QStringLiteral("device_fault"));
            showError(tr("The output device %1. Monitoring stopped; recording is not affected. "
                          "Choose an output and press Open output.").arg(what));
        }
        else
        {
            buffers = tr("Monitor buffer %1 ms (target %2, max %3) | underruns %4 | overflows %5 | latency trims %6 | "
                         "output callbacks %7 | longest output callback %8 us")
                          .arg(1000.0 * ms.fillFrames / monRate, 0, 'f', 1)
                          .arg(1000.0 * ms.targetFrames / monRate, 0, 'f', 0)
                          .arg(1000.0 * ms.maxFillFrames / monRate, 0, 'f', 1)
                          .arg(ms.underrunEvents).arg(ms.overflowEvents).arg(ms.driftTrimEvents)
                          .arg(ms.renderCallbacks).arg(static_cast<double>(ms.maxRenderNs) / 1000.0, 0, 'f', 0);
        }
    }
    const DeviceEventCounts ev = engine->deviceEvents();
    buffers += (buffers.isEmpty() ? QString() : QStringLiteral("\n")) +
               tr("Device opens: input %1, output %2 | device faults: input %3, output %4")
                   .arg(ev.captureOpens).arg(ev.playbackOpens).arg(ev.captureFaults).arg(ev.playbackFaults);
    logProblemDeltas();

    CaptureIngest* ingest = engine->ingest();
    if (ingest == nullptr)
    {
        buffersLabel->setText(buffers);
        updateControls();
        return;
    }
    float blockMax = 0.0f;
    for (uint32_t c = 0; c < ingest->getChannels() && c < meters.size(); ++c)
    {
        const ChannelLevels lv = ingest->takeLevels(c);
        blockMax = std::max(blockMax, lv.peak);
        // Bar: peak with hold and release so short peaks stay visible.
        peakHold[c] = std::max(lv.peak, peakHold[c] * 0.85f);
        const double holdDb = toDbfs(peakHold[c]);
        meters[c]->setValue(static_cast<int>(std::max(holdDb, static_cast<double>(kMeterMin)) * 10.0));
        const double peakDb = toDbfs(lv.peak);
        const double rmsDb = toDbfs(lv.rms);
        meterLabels[c]->setText(peakDb <= -119.0
                                      ? QStringLiteral("ch%1  -inf").arg(c + 1)
                                      : QStringLiteral("ch%1 %2 / %3").arg(c + 1).arg(peakDb, 0, 'f', 1).arg(rmsDb, 0, 'f', 1));
        if (lv.clipped > 0)
        {
            clipUntilNs[c] = now + kClipHoldNs;
        }
        clipLabels[c]->setVisible(now < clipUntilNs[c]);
    }
    if (blockMax > kSignalThreshold)
    {
        lastSignalNs = now;
    }
    const int64_t since = lastSignalNs != 0 ? lastSignalNs : inputOpenedNs;
    signalWarning->setVisible(now - since > kNoSignalNs);

    const IngestStats st = ingest->stats();
    const double inRate = ingest->getSampleRate();
    countersLabel->setText(tr("Input: %1 Hz, %2 ch | callbacks %3, frames %4 | record ring %5 ms (max %6 of %7 ms) | "
                                "ring overruns %8 (%9 frames)")
                                 .arg(ingest->getSampleRate()).arg(ingest->getChannels()).arg(st.callbacks)
                                 .arg(st.framesCaptured)
                                 .arg(1000.0 * st.ringFillFrames / inRate, 0, 'f', 0)
                                 .arg(1000.0 * st.ringMaxFillFrames / inRate, 0, 'f', 0)
                                 .arg(1000.0 * st.ringCapacityFrames / inRate, 0, 'f', 0)
                                 .arg(st.overrunEvents).arg(st.overrunFrames) +
                             tr(" | timing anomalies %1 | clipped samples %2 | longest input callback %3 us")
                                 .arg(st.timingAnomalies).arg(st.clippedSamples)
                                 .arg(static_cast<double>(st.maxCallbackNs) / 1000.0, 0, 'f', 0));
    buffersLabel->setText(buffers);

    // Collect finished takes first: closing the input below destroys the recorder.
    collectTakeReports();
    if (ingest->getDeviceFault() != DeviceFault::None && !recordingActive())
    {
        const QString previous = resultLabel->text();
        closeInput(QStringLiteral("device_fault"));
        refreshDevices();
        showError(previous + (previous.isEmpty() ? QString() : QStringLiteral("\n")) +
                   tr("The input device stopped (unplugged, disabled or failed). Press Refresh, then Open input."));
        return;
    }

    if (auto* recorder = engine->recorder())
    {
        const RecorderStatus rs = recorder->status();
        const double seconds = ingest->getSampleRate() ? static_cast<double>(rs.framesWritten) / ingest->getSampleRate() : 0.0;
        switch (rs.state)
        {
        case RecorderState::Idle:
            recLabel->setText(tr("Not recording"));
            recLabel->setStyleSheet(QString());
            break;
        case RecorderState::Starting:
            recLabel->setText(tr("Starting take %1...").arg(rs.takeNumber));
            break;
        case RecorderState::Recording:
            recLabel->setText(tr("● REC take %1   %2:%3%4")
                                    .arg(rs.takeNumber, 2, 10, QLatin1Char('0'))
                                    .arg(static_cast<int>(seconds) / 60)
                                    .arg(std::fmod(seconds, 60.0), 4, 'f', 1, QLatin1Char('0'))
                                    .arg(rs.hasGaps ? tr("   (GAPS: audio was lost and filled with silence)") : QString()));
            recLabel->setStyleSheet(QStringLiteral("color: #b00020;"));
            break;
        case RecorderState::Finalising:
            recLabel->setText(tr("Saving take %1...").arg(rs.takeNumber));
            recLabel->setStyleSheet(QString());
            break;
        }
    }
    updateControls();
}

void AudioPanel::handleResult(const TakeMetadata& m)
{
    const std::filesystem::path dir = lastTakeDir.empty() ? sessionDir : lastTakeDir;
    const bool saved = takeStatusIsComplete(m.status) && m.finalised;
    const QString status = qs(std::string(takeStatusName(m.status)));
    QString line;
    if (saved)
    {
        line = tr("Saved take %1: %2 | %3 s, %4 Hz, %5 ch, float32 WAV")
                   .arg(m.takeNumber).arg(qpath(dir / m.fileName))
                   .arg(m.durationSeconds(), 0, 'f', 2).arg(m.sampleRate).arg(m.channels);
        if (m.hasGaps)
        {
            line += tr(" | WARNING: %1 gap(s) where audio was lost were filled with silence%2")
                        .arg(m.gaps.size())
                        .arg(m.gapPositionsComplete ? QString() : tr(" (positions incomplete)"));
        }
        resultLabel->setStyleSheet(m.hasGaps ? QStringLiteral("color: #8a5a00;") : QStringLiteral("color: #1b5e20;"));
    }
    else
    {
        const std::string file = m.finalised ? m.fileName : m.partialFileName;
        line = tr("INCOMPLETE take %1 (%2): %3 | file kept as %4 | %5 s")
                   .arg(m.takeNumber).arg(status, qs(m.error), qpath(dir / file))
                   .arg(m.durationSeconds(), 0, 'f', 2);
        resultLabel->setStyleSheet(QStringLiteral("color: #b00020; font-weight: bold;"));
    }
    resultLabel->setText(line);
    auto* item = new QListWidgetItem(line);
    if (!saved)
    {
        item->setForeground(QColor(0xb0, 0x00, 0x20));
    }
    takesList->addItem(item);
    logger.log(saved ? Level::Info : Level::Error, "audio", "take_finished", line.toStdString(),
                {{"take", std::to_string(m.takeNumber)}, {"status", status.toStdString()},
                 {"finalised", m.finalised ? "true" : "false"}, {"frames", std::to_string(m.frames)},
                 {"has_gaps", m.hasGaps ? "true" : "false"}, {"stop_reason", m.stopReason}});
    if (!saved)
    {
        scanIncompleteFiles();
    }
}

void AudioPanel::scanIncompleteFiles()
{
    incompleteList->clear();
    for (const auto& p : findPartialFiles(recordingsRoot()))
    {
        // A file the recorder is writing right now is not "incomplete".
        if (recordingActive() && p.parent_path() == sessionDir)
        {
            continue;
        }
        auto* item = new QListWidgetItem(qpath(p));
        item->setData(Qt::UserRole, QString::fromStdString(pathToUtf8(p)));
        incompleteList->addItem(item);
    }
    if (incompleteList->count() > 0)
    {
        logger.log(Level::Warn, "audio", "incomplete_files_found", "incomplete recordings present",
                    {{"count", std::to_string(incompleteList->count())}});
    }
    updateControls();
}

void AudioPanel::recoverSelected()
{
    QListWidgetItem* item = incompleteList->currentItem();
    if (item == nullptr)
    {
        return;
    }
    const std::filesystem::path partial = toPath(item->data(Qt::UserRole).toString());
    const RecoveryResult r = recoverPartial(partial);
    if (r.ok)
    {
        showInfo(tr("Recovered %1 frames into %2 (original .partial kept).")
                      .arg(r.frames).arg(qpath(r.recoveredPath)));
        logger.log(Level::Info, "audio", "partial_recovered", pathToUtf8(r.recoveredPath),
                    {{"frames", std::to_string(r.frames)}});
    }
    else
    {
        showError(tr("Recovery failed: %1").arg(qs(r.error)));
        logger.log(Level::Error, "audio", "partial_recovery_failed", r.error);
    }
}

void AudioPanel::showError(const QString& text)
{
    resultLabel->setStyleSheet(QStringLiteral("color: #b00020; font-weight: bold;"));
    resultLabel->setText(text);
}

void AudioPanel::showInfo(const QString& text)
{
    resultLabel->setStyleSheet(QString());
    resultLabel->setText(text);
}

// ---- Stage 10: hooks for the guided view (they act on this panel's widgets) ----
void AudioPanel::uiOpenInput()
{
    if (!engine->captureOpen())
    {
        toggleInput();
    }
}

void AudioPanel::uiOpenOutput()
{
    if (!engine->playbackOpen())
    {
        toggleOutput();
    }
}

bool AudioPanel::uiInputOpen() const
{
    return engine->captureOpen();
}

bool AudioPanel::uiOutputOpen() const
{
    return engine->playbackOpen();
}

QString AudioPanel::uiInputName() const
{
    if (engine->captureOpen())
    {
        return QString::fromStdString(engine->captureDescription().deviceName);
    }
    return inputCombo->count() > 0 ? inputCombo->currentText() : tr("no input device found");
}

QString AudioPanel::uiOutputName() const
{
    if (engine->playbackOpen())
    {
        return QString::fromStdString(engine->playbackDescription().deviceName);
    }
    return outputCombo->count() > 0 ? outputCombo->currentText() : tr("no output device found");
}

double AudioPanel::uiPeakDbfs() const
{
    float peak = 0.0f;
    for (const float v : peakHold)
    {
        peak = std::max(peak, v);
    }
    return toDbfs(peak);
}

void AudioPanel::setSessionControl(bool active, std::function<void()> flush)
{
    if (!active)
    {
        collectTakeReports();  // last reports go to the session before control is released
    }
    sessionControlled = active;
    sessionFlush = active ? std::move(flush) : std::function<void()>();
    logger.log(Level::Info, "audio", "session_control", active ? "recorder controlled by the session"
                                                                          : "recorder back under local control");
    updateControls();
}

void AudioPanel::collectTakeReports()
{
    if (sessionControlled)
    {
        if (sessionFlush)
        {
            sessionFlush();  // the session controller collects them through its recorder port
        }
        return;
    }
    if (auto* recorder = engine->recorder())
    {
        for (const auto& meta : recorder->takeFinished())
        {
            handleResult(meta);
        }
        recorder->takeStarted();  // start reports matter only to session takes; discard
    }
}

void AudioPanel::updateControls()
{
    const bool open = engine->captureOpen();
    const bool outOpen = engine->playbackOpen();
    const bool recording = recordingActive();
    inputButton->setText(open ? tr("Close input") : tr("Open input"));
    inputButton->setEnabled(!recording && (open || inputCombo->count() > 0));
    inputCombo->setEnabled(!open);
    outputButton->setText(outOpen ? tr("Close output") : tr("Open output"));
    outputButton->setEnabled(outOpen || outputCombo->count() > 0);
    outputCombo->setEnabled(!outOpen);
    refreshButton->setEnabled(!open && !outOpen);
    toneButton->setEnabled(outOpen && !engine->monitor().testToneActive());
    folderButton->setEnabled(!recording);
    recordButton->setEnabled(open && !sessionControlled);
    recordButton->setToolTip(sessionControlled
                                   ? tr("A session is active: takes are started and stopped in the Session panel.")
                                   : QString());
    const QString startText = role == Role::Producer ? tr("Record") : tr("Record (local test)");
    recordButton->setText(recording && !sessionControlled ? tr("Stop") : startText);
    recoverButton->setEnabled(incompleteList->count() > 0);
}

std::string AudioPanel::reportJson() const
{
    return engineReportJson(*engine);
}

QString AudioPanel::diagnosticsText() const
{
    // Human-readable view of the same snapshot that the exported report contains.
    QString out = QStringLiteral("=== Audio ===\n");
    out += QStringLiteral("recordings folder: %1\n").arg(QDir::toNativeSeparators(recordingsDir));
    out += QStringLiteral("session: %1  folder: %2\n")
               .arg(sessionId.empty() ? QStringLiteral("(none yet)") : qs(sessionId), qpath(sessionDir));
    out += QStringLiteral("monitoring: %1, gain %2 dB\n")
               .arg(engine->monitor().isEnabled() ? QStringLiteral("ON") : QStringLiteral("off"))
               .arg(engine->monitor().getGainDb(), 0, 'f', 1);
    out += QString::fromStdString(reportJson());
    out += QLatin1Char('\n');
    return out;
}

