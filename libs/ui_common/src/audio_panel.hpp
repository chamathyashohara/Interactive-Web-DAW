#pragma once

#include <filesystem>
#include <functional>
#include <memory>
#include <vector>

#include <QString>
#include <QWidget>

#include "rr/audio/audio_engine.hpp"
#include "rr/shared/config.hpp"
#include "rr/shared/log.hpp"

class QCheckBox;
class QComboBox;
class QSlider;
class QLabel;
class QListWidget;
class QProgressBar;
class QPushButton;
class QTimer;

namespace rr::ui {

// Device selection, input meters and local recording for one app (Stage 4).
//
// All engine state is read on the UI thread by a 20 Hz timer (bounded telemetry): meter peaks
// and counters are atomics, recorder status is atomics, finished takes are collected from the
// recorder's queue. The UI never blocks on the audio callback, which never touches the UI.
class AudioPanel final : public QWidget {
    Q_OBJECT

public:
    AudioPanel(Role role, const AppConfig& config, rr::log::Logger& logger, QWidget* parent = nullptr);
    ~AudioPanel() override;

    bool recording_active() const;
    // Finalises an active take (status complete_shutdown) and closes the device.
    void shut_down_audio();
    QString diagnostics_text() const;
    // Structured engine snapshot (rr::audio::engine_report_json) for the diagnostic report.
    std::string report_json() const;

    // Stage 6: while a session is active the session controller owns the recorder's take
    // reports. The panel then never collects them itself; where it would, it calls `flush`
    // (which polls the controller) so nothing is lost before the input is closed. The local
    // Record button is disabled (SES-08: session takes are started only by the producer).
    void set_session_control(bool active, std::function<void()> flush);
    rr::audio::AudioEngine& engine() { return *engine_; }
    std::filesystem::path recordings_root() const;

private:
    void build_ui();
    void refresh_devices();
    void toggle_input();
    void toggle_output();
    bool open_selected_output();
    void close_output(const QString& reason);
    void set_monitoring(bool enabled);
    void update_monitor_description();
    void log_problem_deltas();
    bool open_selected_input();
    void close_input(const QString& reason);
    void choose_folder();
    void open_folder();
    void start_take();
    void stop_take();
    void tick();
    void handle_result(const rr::audio::TakeMetadata& meta);
    void scan_incomplete_files();
    void recover_selected();
    void show_error(const QString& text);
    void show_info(const QString& text);
    void update_controls();
    void collect_take_reports();

    Role role_;
    AppConfig config_;
    rr::log::Logger& logger_;
    std::unique_ptr<rr::audio::AudioEngine> engine_;

    QString recordings_dir_;
    std::string session_id_;
    std::filesystem::path session_dir_;
    std::filesystem::path last_take_dir_;

    QComboBox* input_combo_ = nullptr;
    QComboBox* output_combo_ = nullptr;
    QPushButton* refresh_button_ = nullptr;
    QPushButton* input_button_ = nullptr;
    QLabel* format_label_ = nullptr;
    QPushButton* output_button_ = nullptr;
    QLabel* output_format_label_ = nullptr;
    QCheckBox* monitor_check_ = nullptr;
    QSlider* monitor_gain_ = nullptr;
    QLabel* monitor_gain_label_ = nullptr;
    QPushButton* tone_button_ = nullptr;
    QLabel* processing_label_ = nullptr;
    QLabel* buffers_label_ = nullptr;
    std::vector<QLabel*> clip_labels_;
    std::vector<std::int64_t> clip_until_ns_;
    std::vector<QProgressBar*> meters_;
    std::vector<QLabel*> meter_labels_;
    QLabel* signal_warning_ = nullptr;
    QLabel* counters_label_ = nullptr;
    QLabel* folder_label_ = nullptr;
    QPushButton* folder_button_ = nullptr;
    QPushButton* open_folder_button_ = nullptr;
    QPushButton* record_button_ = nullptr;
    QLabel* rec_label_ = nullptr;
    QLabel* result_label_ = nullptr;
    QListWidget* takes_list_ = nullptr;
    QListWidget* incomplete_list_ = nullptr;
    QPushButton* recover_button_ = nullptr;
    QTimer* timer_ = nullptr;
    bool session_controlled_ = false;
    std::function<void()> session_flush_;

    std::vector<float> peak_hold_;
    std::int64_t input_opened_ns_ = 0;
    std::int64_t last_signal_ns_ = 0;
    // Last logged values, so problems are logged once per change (at most once per second).
    std::int64_t last_problem_log_ns_ = 0;
    std::uint64_t logged_rec_overruns_ = 0;
    std::uint64_t logged_timing_anomalies_ = 0;
    std::uint64_t logged_mon_underruns_ = 0;
    std::uint64_t logged_mon_overflows_ = 0;
    std::uint64_t logged_mon_trims_ = 0;
    std::uint64_t logged_capture_faults_ = 0;
    std::uint64_t logged_playback_faults_ = 0;
};

}  // namespace rr::ui
