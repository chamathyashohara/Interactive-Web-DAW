#pragma once

#include <filesystem>
#include <memory>
#include <vector>

#include <QString>
#include <QWidget>

#include "rr/audio/audio_engine.hpp"
#include "rr/shared/config.hpp"
#include "rr/shared/log.hpp"

class QComboBox;
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

private:
    void build_ui();
    void refresh_devices();
    void toggle_input();
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
    std::filesystem::path recordings_root() const;

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

    std::vector<float> peak_hold_;
    std::int64_t input_opened_ns_ = 0;
    std::int64_t last_signal_ns_ = 0;
};

}  // namespace rr::ui
