#pragma once

#include <filesystem>
#include <functional>
#include <memory>
#include <vector>

#include <QString>
#include <QWidget>

#include "rr/audio/AudioEngine.h"
#include "rr/shared/Config.h"
#include "rr/shared/Log.h"

class QCheckBox;
class QComboBox;
class QSlider;
class QLabel;
class QListWidget;
class QProgressBar;
class QPushButton;
class QTimer;

/**
 * Device selection, input meters and local recording for one app (Stage 4).
 *
 * All engine state is read on the UI thread by a 20 Hz timer (bounded telemetry): meter peaks
 * and counters are atomics, recorder status is atomics, finished takes are collected from the
 * recorder's queue. The UI never blocks on the audio callback, which never touches the UI.
 */
class AudioPanel final : public QWidget
{
    Q_OBJECT

public:
    AudioPanel(Role role, const AppConfig& config, Logger& logger, QWidget* parent = nullptr);
    ~AudioPanel() override;

    bool recordingActive() const;
    /** Finalises an active take (status complete_shutdown) and closes the device. */
    void shutDownAudio();
    QString diagnosticsText() const;
    /** Structured engine snapshot (engineReportJson) for the diagnostic report. */
    std::string reportJson() const;

    /**
     * Stage 6: while a session is active the session controller owns the recorder's take
     * reports. The panel then never collects them itself; where it would, it calls `flush`
     * (which polls the controller) so nothing is lost before the input is closed. The local
     * Record button is disabled (SES-08: session takes are started only by the producer).
     */
    void setSessionControl(bool active, std::function<void()> flush);
    AudioEngine& getEngine() { return *engine; }

    /**
     * Stage 10: the guided "Start here" view drives THIS panel's own controls, so the two views
     * can never disagree about which device is open.
     */
    void uiOpenInput();   // opens the selected (by default, the system default) input if closed
    void uiOpenOutput();
    bool uiInputOpen() const;
    bool uiOutputOpen() const;
    QString uiInputName() const;
    QString uiOutputName() const;
    /**
     * Peak of the loudest channel, dBFS, taken from the meter's hold value. The raw levels are
     * consumed by tick(), so a second reader must never take them again.
     */
    double uiPeakDbfs() const;
    std::filesystem::path recordingsRoot() const;

private:
    void buildUi();
    void refreshDevices();
    void toggleInput();
    void toggleOutput();
    bool openSelectedOutput();
    void closeOutput(const QString& reason);
    void setMonitoring(bool enabled);
    void updateMonitorDescription();
    void logProblemDeltas();
    bool openSelectedInput();
    void closeInput(const QString& reason);
    void chooseFolder();
    void openFolder();
    void startTake();
    void stopTake();
    void tick();
    void handleResult(const TakeMetadata& meta);
    void scanIncompleteFiles();
    void recoverSelected();
    void showError(const QString& text);
    void showInfo(const QString& text);
    void updateControls();
    void collectTakeReports();

    Role role;
    AppConfig config;
    Logger& logger;
    std::unique_ptr<AudioEngine> engine;

    QString recordingsDir;
    std::string sessionId;
    std::filesystem::path sessionDir;
    std::filesystem::path lastTakeDir;

    QComboBox* inputCombo = nullptr;
    QComboBox* outputCombo = nullptr;
    QPushButton* refreshButton = nullptr;
    QPushButton* inputButton = nullptr;
    QLabel* formatLabel = nullptr;
    QPushButton* outputButton = nullptr;
    QLabel* outputFormatLabel = nullptr;
    QCheckBox* monitorCheck = nullptr;
    QSlider* monitorGain = nullptr;
    QLabel* monitorGainLabel = nullptr;
    QPushButton* toneButton = nullptr;
    QLabel* processingLabel = nullptr;
    QLabel* buffersLabel = nullptr;
    std::vector<QLabel*> clipLabels;
    std::vector<int64_t> clipUntilNs;
    std::vector<QProgressBar*> meters;
    std::vector<QLabel*> meterLabels;
    QLabel* signalWarning = nullptr;
    QLabel* countersLabel = nullptr;
    QLabel* folderLabel = nullptr;
    QPushButton* folderButton = nullptr;
    QPushButton* openFolderButton = nullptr;
    QPushButton* recordButton = nullptr;
    QLabel* recLabel = nullptr;
    QLabel* resultLabel = nullptr;
    QListWidget* takesList = nullptr;
    QListWidget* incompleteList = nullptr;
    QPushButton* recoverButton = nullptr;
    QTimer* timer = nullptr;
    bool sessionControlled = false;
    std::function<void()> sessionFlush;

    std::vector<float> peakHold;
    int64_t inputOpenedNs = 0;
    int64_t lastSignalNs = 0;
    /** Last logged values, so problems are logged once per change (at most once per second). */
    int64_t lastProblemLogNs = 0;
    uint64_t loggedRecOverruns = 0;
    uint64_t loggedTimingAnomalies = 0;
    uint64_t loggedMonUnderruns = 0;
    uint64_t loggedMonOverflows = 0;
    uint64_t loggedMonTrims = 0;
    uint64_t loggedCaptureFaults = 0;
    uint64_t loggedPlaybackFaults = 0;
};

