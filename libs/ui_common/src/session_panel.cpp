#include "session_panel.hpp"

#include <QCheckBox>
#include <QComboBox>
#include <QFont>
#include <QFontDatabase>
#include <QFormLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QMessageBox>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QRegularExpression>
#include <QRegularExpressionValidator>
#include <QScrollBar>
#include <QSettings>
#include <QSpinBox>
#include <QSysInfo>
#include <QTimer>
#include <QVBoxLayout>

#include "audio_panel.hpp"
#include "rr/network/socket.hpp"
#include "rr/shared/build_info.hpp"
#include "rr/shared/clock.hpp"

namespace rr::ui {
namespace {

using rr::session::LinkState;
using rr::session::SessionState;

QString qs(const std::string& s) {
    return QString::fromStdString(s);
}

QString qs(std::string_view s) {
    return QString::fromUtf8(s.data(), static_cast<qsizetype>(s.size()));
}

const char* const kSettingsBind = "session/bind_address";
const char* const kSettingsPort = "session/port";
const char* const kSettingsHost = "session/host";  // the pairing code is never stored

const char* const kLanNotice =
    "LAN-only prototype: the control connection is NOT encrypted (no TLS) and is protected only by "
    "a short-lived pairing code. Use it only on a trusted private network. It is not designed or "
    "tested for use across the internet.";

const char* const kFirewallNotice =
    "Windows Firewall: the first time a session is created Windows may ask whether Producer Studio "
    "may accept connections. Allow it for Private networks only. This app never changes firewall "
    "settings itself. If the performer cannot connect, see docs/testing/SESSION_TEST_PROTOCOL.md "
    "(firewall section) for a narrow, manual rule.";

QString yes_waiting(bool done, bool expected) {
    if (done) {
        return QStringLiteral("<b>yes</b>");
    }
    return expected ? QStringLiteral("<i>waiting</i>") : QStringLiteral("-");
}

}  // namespace

SessionPanel::SessionPanel(Role role, const AppConfig& config, AudioPanel& audio, rr::log::Logger& logger,
                           QWidget* parent)
    : QWidget(parent), role_(role), config_(config), audio_(&audio), logger_(logger) {
    std::string error;
    rr::net::init_sockets(error);

    auto* outer = new QVBoxLayout(this);
    outer->setContentsMargins(0, 0, 0, 0);
    auto* box = new QGroupBox(role_ == Role::Producer ? tr("Session (producer)") : tr("Session (performer)"));
    outer->addWidget(box);
    auto* layout = new QVBoxLayout(box);

    auto* lan = new QLabel(QString::fromUtf8(kLanNotice));
    lan->setWordWrap(true);
    lan->setObjectName(QStringLiteral("lanNotice"));
    layout->addWidget(lan);

    if (role_ == Role::Producer) {
        build_producer_ui(layout);
    } else {
        build_performer_ui(layout);
    }

    state_label_ = new QLabel;
    QFont state_font = state_label_->font();
    state_font.setBold(true);
    state_font.setPointSize(state_font.pointSize() + 2);
    state_label_->setFont(state_font);
    state_label_->setWordWrap(true);
    layout->addWidget(state_label_);
    reasons_label_ = new QLabel;
    reasons_label_->setWordWrap(true);
    layout->addWidget(reasons_label_);
    checks_label_ = new QLabel;
    checks_label_->setTextFormat(Qt::RichText);
    checks_label_->setWordWrap(true);
    layout->addWidget(checks_label_);
    pcs_label_ = new QLabel;
    pcs_label_->setTextFormat(Qt::RichText);
    pcs_label_->setWordWrap(true);
    layout->addWidget(pcs_label_);

    // Stage 11: verified copies of the performer's takes (the originals never leave the performer's PC).
    auto* copies_box = new QGroupBox(tr("Take copies: performer's original WAV -> verified copy on the producer's PC"));
    auto* copies_layout = new QVBoxLayout(copies_box);
    if (role_ == Role::Producer) {
        auto* copy_row = new QHBoxLayout;
        copy_button_ = new QPushButton(tr("Get verified copy of the performer's last take"));
        copy_button_->setToolTip(tr("Asks the performer's app to send a copy of its finalised take. The copy is "
                                    "marked VERIFIED only after its SHA-256 matches and the WAV checks pass. "
                                    "Record is unavailable while a copy is being received."));
        cancel_copy_button_ = new QPushButton(tr("Cancel copy"));
        auto_copy_check_ = new QCheckBox(tr("Automatically after each take"));
        auto_copy_check_->setChecked(QSettings().value(QStringLiteral("session/auto_copy"), false).toBool());
        copy_row->addWidget(copy_button_);
        copy_row->addWidget(cancel_copy_button_);
        copy_row->addWidget(auto_copy_check_);
        copy_row->addStretch(1);
        copies_layout->addLayout(copy_row);
        connect(copy_button_, &QPushButton::clicked, this, &SessionPanel::request_copy);
        connect(cancel_copy_button_, &QPushButton::clicked, this, &SessionPanel::cancel_copy);
        connect(auto_copy_check_, &QCheckBox::toggled, this, [this](bool on) {
            QSettings().setValue(QStringLiteral("session/auto_copy"), on);
            if (controller_) {
                controller_->set_auto_transfer(on);
            }
        });
    } else {
        delivery_check_ = new QCheckBox(tr("Allow the producer to receive a verified copy of my takes "
                                           "(my original files stay on this PC and are never changed)"));
        copies_layout->addWidget(delivery_check_);
        connect(delivery_check_, &QCheckBox::toggled, this, [this](bool on) {
            if (controller_) {
                controller_->set_delivery_consent(on);
            }
        });
    }
    transfers_label_ = new QLabel;
    transfers_label_->setTextFormat(Qt::RichText);
    transfers_label_->setWordWrap(true);
    transfers_label_->setTextInteractionFlags(Qt::TextSelectableByMouse);
    copies_layout->addWidget(transfers_label_);
    layout->addWidget(copies_box);
    error_label_ = new QLabel;
    error_label_->setWordWrap(true);
    error_label_->setStyleSheet(QStringLiteral("color: #b00020;"));
    layout->addWidget(error_label_);

    consent_check_ = new QCheckBox(role_ == Role::Producer
                                       ? tr("I consent to this session being recorded")
                                       : tr("I agree to be recorded in this session and am ready (consent = arm)"));
    layout->addWidget(consent_check_);
    connect(consent_check_, &QCheckBox::toggled, this, [this](bool on) {
        if (controller_) {
            controller_->set_consent(on);
        }
    });

    stats_label_ = new QLabel;
    stats_label_->setWordWrap(true);
    layout->addWidget(stats_label_);

    auto* history_box = new QGroupBox(tr("Session log (this PC)"));
    auto* history_layout = new QVBoxLayout(history_box);
    history_view_ = new QPlainTextEdit;
    history_view_->setReadOnly(true);
    history_view_->setMaximumBlockCount(500);
    history_view_->setFont(QFontDatabase::systemFont(QFontDatabase::FixedFont));
    history_view_->setMinimumHeight(120);
    history_layout->addWidget(history_view_);
    layout->addWidget(history_box);

    timer_ = new QTimer(this);
    timer_->setInterval(50);
    connect(timer_, &QTimer::timeout, this, &SessionPanel::tick);
    timer_->start();
    tick();
}

SessionPanel::~SessionPanel() {
    shut_down();
}

// ---------------------------------------------------------------------------------------------
void SessionPanel::build_producer_ui(QVBoxLayout* layout) {
    auto* form = new QFormLayout;
    auto* iface_row = new QHBoxLayout;
    interface_combo_ = new QComboBox;
    interface_combo_->setToolTip(tr("The network interface the session listens on. Choose the adapter of the "
                                    "private LAN the performer is on. Loopback is for tests on one PC."));
    interfaces_button_ = new QPushButton(tr("Refresh"));
    iface_row->addWidget(interface_combo_, 1);
    iface_row->addWidget(interfaces_button_);
    form->addRow(tr("Listen on:"), iface_row);
    port_spin_ = new QSpinBox;
    port_spin_->setRange(1024, 65535);
    port_spin_->setValue(QSettings().value(QString::fromLatin1(kSettingsPort), static_cast<int>(config_.network.control_tcp_port)).toInt());
    form->addRow(tr("TCP port:"), port_spin_);
    lead_spin_ = new QSpinBox;
    lead_spin_->setRange(300, 10000);
    lead_spin_->setSingleStep(100);
    lead_spin_->setSuffix(tr(" ms"));
    lead_spin_->setValue(QSettings().value(QStringLiteral("session/start_lead_ms"),
                                           static_cast<int>(config_.timing.start_lead_ms)).toInt());
    lead_spin_->setToolTip(tr("How far ahead both PCs are told the start time. It must cover the network round "
                              "trip, the clock-offset uncertainty and both apps' processing; Record is refused if "
                              "it is below the minimum measured for this link."));
    form->addRow(tr("Start lead:"), lead_spin_);
    connect(lead_spin_, qOverload<int>(&QSpinBox::valueChanged), this, [this](int v) {
        QSettings().setValue(QStringLiteral("session/start_lead_ms"), v);
        if (controller_) {
            controller_->set_start_lead_ms(static_cast<std::uint32_t>(v));
        }
    });
    layout->addLayout(form);

    auto* row = new QHBoxLayout;
    create_button_ = new QPushButton(tr("Create session"));
    new_code_button_ = new QPushButton(tr("New pairing code"));
    row->addWidget(create_button_);
    row->addWidget(new_code_button_);
    row->addStretch(1);
    layout->addLayout(row);

    auto* info = new QFormLayout;
    session_id_label_ = new QLabel(QStringLiteral("-"));
    session_id_label_->setTextInteractionFlags(Qt::TextSelectableByMouse);
    code_label_ = new QLabel(QStringLiteral("-"));
    QFont code_font = QFontDatabase::systemFont(QFontDatabase::FixedFont);
    code_font.setPointSize(code_font.pointSize() + 10);
    code_font.setBold(true);
    code_label_->setFont(code_font);
    code_label_->setTextInteractionFlags(Qt::TextSelectableByMouse);
    code_label_->setToolTip(tr("Tell the performer this code. It works once, expires after 10 minutes and is "
                               "locked after 5 wrong attempts. It is never written to the log."));
    address_label_ = new QLabel(QStringLiteral("-"));
    address_label_->setTextInteractionFlags(Qt::TextSelectableByMouse);
    address_label_->setWordWrap(true);
    info->addRow(tr("Session ID:"), session_id_label_);
    info->addRow(tr("Pairing code:"), code_label_);
    info->addRow(tr("Performer joins:"), address_label_);
    layout->addLayout(info);

    auto* firewall = new QLabel(QString::fromUtf8(kFirewallNotice));
    firewall->setWordWrap(true);
    layout->addWidget(firewall);

    auto* take_row = new QHBoxLayout;
    record_button_ = new QPushButton(tr("Record (both)"));
    stop_button_ = new QPushButton(tr("Stop (both)"));
    QFont big = record_button_->font();
    big.setBold(true);
    big.setPointSize(big.pointSize() + 2);
    record_button_->setFont(big);
    stop_button_->setFont(big);
    take_row->addWidget(record_button_);
    take_row->addWidget(stop_button_);
    take_row->addStretch(1);
    layout->addLayout(take_row);

    confirmations_label_ = new QLabel;
    confirmations_label_->setTextFormat(Qt::RichText);
    confirmations_label_->setWordWrap(true);
    layout->addWidget(confirmations_label_);

    connect(interfaces_button_, &QPushButton::clicked, this, &SessionPanel::refresh_interfaces);
    connect(create_button_, &QPushButton::clicked, this, &SessionPanel::create_or_end_session);
    connect(new_code_button_, &QPushButton::clicked, this, [this] {
        if (controller_) {
            controller_->new_pairing_code();
        }
    });
    connect(record_button_, &QPushButton::clicked, this, &SessionPanel::record);
    connect(stop_button_, &QPushButton::clicked, this, &SessionPanel::stop);
    refresh_interfaces();
}

void SessionPanel::build_performer_ui(QVBoxLayout* layout) {
    auto* form = new QFormLayout;
    host_edit_ = new QLineEdit(QSettings().value(QString::fromLatin1(kSettingsHost)).toString());
    host_edit_->setPlaceholderText(tr("producer's IPv4 address, e.g. 192.168.1.20"));
    port_spin_ = new QSpinBox;
    port_spin_->setRange(1024, 65535);
    port_spin_->setValue(QSettings().value(QString::fromLatin1(kSettingsPort), static_cast<int>(config_.network.control_tcp_port)).toInt());
    code_edit_ = new QLineEdit;
    code_edit_->setPlaceholderText(tr("6 digits from the producer"));
    code_edit_->setMaxLength(6);
    code_edit_->setValidator(new QRegularExpressionValidator(QRegularExpression(QStringLiteral("[0-9]{0,6}")), code_edit_));
    form->addRow(tr("Producer address:"), host_edit_);
    form->addRow(tr("TCP port:"), port_spin_);
    form->addRow(tr("Pairing code:"), code_edit_);
    layout->addLayout(form);

    auto* row = new QHBoxLayout;
    join_button_ = new QPushButton(tr("Join"));
    stop_save_button_ = new QPushButton(tr("Stop && save my recording"));
    stop_save_button_->setToolTip(tr("Stops and saves this PC's recording now. The producer is told, but its own "
                                     "recording continues."));
    row->addWidget(join_button_);
    row->addWidget(stop_save_button_);
    row->addStretch(1);
    layout->addLayout(row);

    auto* note = new QLabel(tr("Only the producer starts and stops session takes (SES-08). This PC records its own "
                               "microphone locally at full quality; the recording does not depend on the network."));
    note->setWordWrap(true);
    layout->addWidget(note);
    controller_label_ = new QLabel;
    controller_label_->setWordWrap(true);
    layout->addWidget(controller_label_);
    take_label_ = new QLabel;
    take_label_->setWordWrap(true);
    QFont take_font = take_label_->font();
    take_font.setBold(true);
    take_font.setPointSize(take_font.pointSize() + 4);
    take_label_->setFont(take_font);
    layout->addWidget(take_label_);

    connect(join_button_, &QPushButton::clicked, this, &SessionPanel::join_or_leave);
    connect(stop_save_button_, &QPushButton::clicked, this, &SessionPanel::stop_and_save);
}

void SessionPanel::refresh_interfaces() {
    const QString previous = interface_combo_->currentData().toString().isEmpty()
                                 ? QSettings().value(QString::fromLatin1(kSettingsBind)).toString()
                                 : interface_combo_->currentData().toString();
    interface_combo_->clear();
    int select = -1;
    for (const auto& i : rr::net::list_ipv4_interfaces()) {
        QString label = qs(i.address) + QStringLiteral("  -  ") + qs(i.name);
        if (i.loopback) {
            label += tr("  (loopback: this PC only, for tests)");
        } else if (i.private_lan) {
            label += tr("  (private LAN)");
        } else {
            label += tr("  (NOT a private address: not recommended)");
        }
        interface_combo_->addItem(label, qs(i.address));
        const int index = interface_combo_->count() - 1;
        if (qs(i.address) == previous) {
            select = index;
        } else if (select < 0 && i.private_lan && !i.loopback) {
            select = index;
        }
    }
    if (select >= 0) {
        interface_combo_->setCurrentIndex(select);
    }
    if (interface_combo_->count() == 0) {
        show_error(tr("No IPv4 network interface found."));
    }
}

// ---------------------------------------------------------------------------------------------
void SessionPanel::ensure_controller() {
    if (controller_ && controller_->session_active()) {
        return;
    }
    // A fresh controller + port per session: picks up the current recordings folder.
    controller_.reset();
    port_ = std::make_unique<rr::control::AudioRecorderPort>(audio_->engine(), audio_->recordings_root(), config_);
    rr::control::ControllerConfig c;
    c.role = role_;
    c.timing = config_.timing;
    c.app_version = rr::build_info().version;
    c.display_name = std::string(rr::role_display_name(role_)) + " (" + QSysInfo::machineHostName().toStdString() + ")";
    controller_ = std::make_unique<rr::control::SessionController>(c, *port_, logger_);
    controller_->set_consent(consent_check_->isChecked());
    if (lead_spin_ != nullptr) {
        controller_->set_start_lead_ms(static_cast<std::uint32_t>(lead_spin_->value()));
    }
    if (auto_copy_check_ != nullptr) {
        controller_->set_auto_transfer(auto_copy_check_->isChecked());
    }
    if (delivery_check_ != nullptr) {
        controller_->set_delivery_consent(delivery_check_->isChecked());
    }
    shown_history_ = 0;
    shown_history_last_.clear();
    history_view_->clear();
}

void SessionPanel::set_session_control(bool active) {
    if (active == session_control_) {
        return;
    }
    session_control_ = active;
    if (!audio_) {
        return;
    }
    audio_->set_session_control(active, [this] {
        if (controller_) {
            controller_->poll();
        }
    });
}

void SessionPanel::create_or_end_session() {
    if (controller_ && controller_->session_active() && controller_->snapshot().link != LinkState::Disconnected) {
        controller_->leave();  // refused (with a message) while a take is running
        return;
    }
    const QString bind = interface_combo_->currentData().toString();
    if (bind.isEmpty()) {
        show_error(tr("Choose the network interface to listen on."));
        return;
    }
    ensure_controller();
    std::string error;
    set_session_control(true);
    if (!controller_->create_session(bind.toStdString(), static_cast<std::uint16_t>(port_spin_->value()), error)) {
        set_session_control(false);
        show_error(tr("The session could not be created: %1").arg(qs(error)));
        return;
    }
    QSettings().setValue(QString::fromLatin1(kSettingsBind), bind);
    QSettings().setValue(QString::fromLatin1(kSettingsPort), port_spin_->value());
    error_label_->clear();
}

void SessionPanel::join_or_leave() {
    if (controller_ && controller_->session_active() && controller_->snapshot().link != LinkState::Disconnected) {
        controller_->leave();
        return;
    }
    const std::string host = host_edit_->text().trimmed().toStdString();
    const std::string code = code_edit_->text().trimmed().toStdString();
    if (!rr::net::is_valid_ipv4(host)) {
        show_error(tr("Enter the producer's IPv4 address (four numbers, e.g. 192.168.1.20)."));
        return;
    }
    if (code.size() != 6) {
        show_error(tr("Enter the 6-digit pairing code shown on the producer's screen."));
        return;
    }
    ensure_controller();
    std::string error;
    set_session_control(true);
    if (!controller_->join(host, static_cast<std::uint16_t>(port_spin_->value()), code, error)) {
        set_session_control(false);
        show_error(tr("Could not join: %1").arg(qs(error)));
        return;
    }
    QSettings().setValue(QString::fromLatin1(kSettingsHost), host_edit_->text().trimmed());
    QSettings().setValue(QString::fromLatin1(kSettingsPort), port_spin_->value());
    code_edit_->clear();  // single use
    error_label_->clear();
}

void SessionPanel::record() {
    std::string error;
    if (!controller_ || !controller_->start_take(error)) {
        show_error(tr("Recording not started: %1").arg(qs(error.empty() ? std::string("no session") : error)));
    }
}

void SessionPanel::stop() {
    std::string error;
    if (!controller_ || !controller_->stop_take(error)) {
        show_error(tr("Stop: %1").arg(qs(error.empty() ? std::string("no session") : error)));
    }
}

void SessionPanel::stop_and_save() {
    if (!controller_) {
        return;
    }
    const auto answer = QMessageBox::question(
        this, tr("Stop and save"),
        tr("Stop and save the recording on this PC now? The producer is told, but the producer's own recording "
           "continues until the producer presses Stop."),
        QMessageBox::Yes | QMessageBox::No, QMessageBox::No);
    if (answer != QMessageBox::Yes) {
        return;
    }
    std::string error;
    if (!controller_->stop_and_save(error)) {
        show_error(qs(error));
    }
}

void SessionPanel::request_copy() {
    if (!controller_) {
        return;
    }
    const auto s = controller_->snapshot();
    std::string error;
    if (!controller_->request_transfer(s.take.take_id, error)) {
        show_error(tr("Copy not requested: %1").arg(qs(error)));
    }
}

void SessionPanel::cancel_copy() {
    if (!controller_) {
        return;
    }
    for (const auto& v : controller_->snapshot().transfers) {
        if (!rr::xfer::transfer_state_final(v.state)) {
            const auto answer = QMessageBox::question(
                this, tr("Cancel copy"),
                tr("Stop receiving the copy of take %1? What has arrived is kept and a new request continues from "
                   "there. The performer's original is not affected.").arg(v.take_id),
                QMessageBox::Yes | QMessageBox::No, QMessageBox::No);
            if (answer == QMessageBox::Yes) {
                controller_->cancel_transfer(v.take_id);
            }
            return;
        }
    }
}

void SessionPanel::show_error(const QString& text) {
    error_label_->setText(text);
}

// ---------------------------------------------------------------------------------------------
void SessionPanel::tick() {
    if (!audio_) {
        return;
    }
    rr::control::ControllerSnapshot s;
    if (controller_) {
        controller_->poll();
        s = controller_->snapshot();
    } else {
        s.role = role_;
        const rr::session::SessionSnapshot initial = rr::session::initial_snapshot(role_);
        s.not_ready_reasons = initial.not_ready_reasons;
    }
    // The AudioPanel's recorder belongs to the session while it is connected or a take runs.
    const bool active = controller_ && controller_->session_active() &&
                        (s.link != LinkState::Disconnected || rr::session::is_take_active(s.session) ||
                         s.session == SessionState::Recording);
    set_session_control(active);
    render(s);
    emit statusChanged();
}

void SessionPanel::render(const rr::control::ControllerSnapshot& s) {
    const bool live = controller_ && controller_->session_active() && s.link != LinkState::Disconnected;
    const bool take_running = s.session == SessionState::Recording || rr::session::is_take_active(s.session) ||
                              s.session == SessionState::Armed;

    state_label_->setText(tr("Connection: %1    Session: %2")
                              .arg(qs(rr::session::link_state_label(s.link)), qs(rr::session::session_state_name(s.session))));
    QString reasons;
    if (s.session == SessionState::NotReady && !s.not_ready_reasons.empty()) {
        QStringList list;
        for (const auto& r : s.not_ready_reasons) {
            list << qs(r);
        }
        reasons = tr("Not ready: %1").arg(list.join(QStringLiteral("; ")));
    }
    if (!s.peer_name.empty()) {
        reasons += (reasons.isEmpty() ? QString() : QStringLiteral("\n")) +
                   tr("Other side: %1 at %2 - ready: %3, consent: %4%5")
                       .arg(qs(s.peer_name), qs(s.peer_address), s.peer_ready ? tr("yes") : tr("no"),
                            s.peer_consent ? tr("yes") : tr("no"),
                            s.peer_reasons.empty() ? QString() : QStringLiteral(" (") + qs(s.peer_reasons) + QLatin1Char(')'));
    }
    reasons_label_->setText(reasons);
    checks_label_->setText(live ? checks_html(s) : QString());
    pcs_label_->setText(live && s.take.take_id != 0 ? pcs_text(s) : QString());
    transfers_label_->setText(transfers_html(s));
    if (copy_button_ != nullptr) {
        bool any_active = false;
        for (const auto& v : s.transfers) {
            any_active = any_active || !rr::xfer::transfer_state_final(v.state);
        }
        QString why;
        if (!live || s.link != LinkState::Connected) {
            why = tr("the performer is not connected");
        } else if (s.protocol_minor < 2) {
            why = tr("the performer's app does not support take copies (control protocol 1.%1)").arg(s.protocol_minor);
        } else if (!s.peer_delivery_consent) {
            why = tr("the performer has not allowed copies of its takes");
        } else if (s.take.take_id == 0 || !s.take.peer_finalised) {
            why = tr("no finalised performer take yet");
        } else if (take_running) {
            why = tr("a take is being recorded");
        } else if (any_active) {
            why = tr("a copy is already being received");
        }
        copy_button_->setEnabled(why.isEmpty());
        copy_button_->setToolTip(why.isEmpty() ? tr("Request a verified copy of take %1").arg(s.take.take_id)
                                               : tr("Not available: %1").arg(why));
        cancel_copy_button_->setEnabled(any_active);
    }
    if (!s.last_error.empty()) {
        error_label_->setText(qs(s.last_error));
    }

    if (live || s.link_stats.offset_samples > 0) {
        const auto& ls = s.link_stats;
        stats_label_->setText(
            tr("Control round trip %1 ms | clock offset (other PC - this PC) %2 ms +/- %3 ms from %4 samples | "
               "frames sent %5, received %6 | reconnect attempts %7 | refused %8, duplicates %9")
                .arg(ls.control_rtt_ns >= 0 ? QString::number(static_cast<double>(ls.control_rtt_ns) / 1e6, 'f', 2) : QStringLiteral("-"))
                .arg(static_cast<double>(ls.theta_ns) / 1e6, 0, 'f', 3)
                .arg(ls.theta_uncertainty_ns >= 0 ? QString::number(static_cast<double>(ls.theta_uncertainty_ns) / 1e6, 'f', 3)
                                                  : QStringLiteral("?"))
                .arg(ls.offset_samples)
                .arg(ls.frames_sent)
                .arg(ls.frames_received)
                .arg(ls.reconnect_attempts)
                .arg(s.refused_messages)
                .arg(s.duplicate_messages));
    } else {
        stats_label_->clear();
    }

    if (role_ == Role::Producer) {
        create_button_->setText(live ? tr("End session") : tr("Create session"));
        create_button_->setEnabled(!take_running);
        interface_combo_->setEnabled(!live);
        interfaces_button_->setEnabled(!live);
        port_spin_->setEnabled(!live);
        new_code_button_->setEnabled(live && s.link != LinkState::Connected);
        session_id_label_->setText(live ? qs(s.session_id) : QStringLiteral("-"));
        code_label_->setText(live && s.link != LinkState::Connected && !s.pairing_code.empty()
                                 ? qs(s.pairing_code)
                                 : (live ? tr("(used: performer joined)") : QStringLiteral("-")));
        address_label_->setText(live ? tr("%1  port %2  (enter these on the Performer Client)")
                                           .arg(qs(s.bind_address))
                                           .arg(s.port)
                                     : QStringLiteral("-"));
        record_button_->setEnabled(s.session == SessionState::Ready);
        const bool before_start = s.session == SessionState::Armed || s.session == SessionState::Scheduled;
        stop_button_->setEnabled(before_start || s.session == SessionState::Recording);
        stop_button_->setText(before_start ? tr("Cancel take (not started)") : tr("Stop (both)"));
        record_button_->setToolTip(s.session == SessionState::Ready
                                       ? tr("Start lead %1 ms (minimum for this link: %2 ms)").arg(s.start_lead_ms).arg(s.min_start_lead_ms)
                                       : tr("Not ready: see the checklist"));
        confirmations_label_->setText(confirmations_text(s));
    } else {
        join_button_->setText(live ? tr("Leave") : tr("Join"));
        join_button_->setEnabled(!take_running);
        host_edit_->setEnabled(!live);
        port_spin_->setEnabled(!live);
        code_edit_->setEnabled(!live);
        stop_save_button_->setEnabled(s.session == SessionState::Recording);
        controller_label_->setText(live && !s.peer_name.empty()
                                       ? tr("Session controlled by: %1 at %2. Only the producer starts and stops takes; "
                                            "your recording starts automatically at the agreed time.")
                                             .arg(qs(s.peer_name), qs(s.peer_address))
                                       : QString());
        const auto& t = s.take;
        QString text;
        if (t.take_id != 0) {
            text = tr("Take %1: ").arg(t.take_id);
            if (s.session == SessionState::Armed) {
                text += tr("armed by the producer, waiting for the start time");
            } else if (s.session == SessionState::Scheduled) {
                const std::int64_t left_ms = (t.start_at_local_ns - rr::time::monotonic_ns()) / 1000000;
                text += tr("SCHEDULED - recording starts in %1 s, at about %2 (this PC's clock)")
                            .arg(static_cast<double>(left_ms) / 1000.0, 0, 'f', 1)
                            .arg(qs(rr::time::format_utc_iso8601_ms(rr::time::utc_now_ms() + left_ms)));
            } else if (s.session == SessionState::Recording) {
                text += tr("RECORDING on this PC");
            } else if (t.local_finalised) {
                text += tr("saved (%1, %2 frames) %3")
                            .arg(qs(rr::take_status_name(t.local_status)))
                            .arg(t.local_frames)
                            .arg(qs(t.local_file));
            } else if (!t.local_started) {
                text += tr("did not start on this PC");
            } else {
                text += tr("finishing");
            }
        }
        take_label_->setText(text);
    }

    // History: append new lines only.
    const std::vector<std::string> history = controller_ ? controller_->take_history() : std::vector<std::string>();
    if (!history.empty() && (history.size() != shown_history_ || history.back() != shown_history_last_)) {
        history_view_->clear();
        for (const auto& line : history) {
            history_view_->appendPlainText(qs(line));
        }
        history_view_->verticalScrollBar()->setValue(history_view_->verticalScrollBar()->maximum());
        shown_history_ = history.size();
        shown_history_last_ = history.back();
    }
}

QString SessionPanel::checks_html(const rr::control::ControllerSnapshot& s) const {
    // Every item, both PCs, passing ones included (Stage 9).
    using rr::control::ReadyItem;
    auto mark = [](const std::vector<rr::control::ReadinessCheck>& list, ReadyItem item, QString* detail) -> QString {
        for (const auto& c : list) {
            if (c.item == item) {
                if (detail != nullptr) {
                    *detail = QString::fromStdString(c.detail).toHtmlEscaped();
                }
                return c.ok ? QStringLiteral("<b style='color:#006400'>OK</b>") : QStringLiteral("<b style='color:#b00020'>NO</b>");
            }
        }
        return QStringLiteral("-");
    };
    QString html = QStringLiteral("<table cellspacing='4'><tr><th align='left'>%1</th><th>%2</th><th>%3</th><th align='left'>%4</th></tr>")
                       .arg(tr("Readiness check"), tr("This PC"), tr("Other PC"), tr("Detail (this PC)"));
    for (const ReadyItem item : {ReadyItem::InputDevice, ReadyItem::EngineHealthy, ReadyItem::FolderWritable,
                                 ReadyItem::DiskSpace, ReadyItem::NoActiveRecording, ReadyItem::Consent,
                                 ReadyItem::Connected, ReadyItem::ClockOffset}) {
        QString detail;
        const QString here = mark(s.local_checks, item, &detail);
        const QString there = mark(s.peer_checks, item, nullptr);
        html += QStringLiteral("<tr><td>%1</td><td align='center'>%2</td><td align='center'>%3</td><td>%4</td></tr>")
                    .arg(qs(std::string(rr::control::ready_item_label(item))), here, there, detail);
    }
    return html + QStringLiteral("</table>");
}

QString SessionPanel::pcs_text(const rr::control::ControllerSnapshot& s) const {
    // One row per PC: scheduled / recording / saved. "Recording" only after that PC's own start report.
    const auto& t = s.take;
    auto row = [](const QString& who, const QString& state) {
        return QStringLiteral("<b>%1:</b> %2<br>").arg(who, state);
    };
    QString here;
    if (t.cancelled) {
        here = tr("take %1 cancelled before the start (nothing recorded)").arg(t.take_id);
    } else if (t.local_finalised) {
        here = tr("take %1 saved: %2, %3 frames").arg(t.take_id).arg(qs(rr::take_status_name(t.local_status))).arg(t.local_frames);
    } else if (t.local_started) {
        here = tr("RECORDING take %1").arg(t.take_id);
    } else if (t.start_at_local_ns != 0) {
        const std::int64_t left_ms = (t.start_at_local_ns - rr::time::monotonic_ns()) / 1000000;
        here = tr("SCHEDULED take %1, starts in %2 s").arg(t.take_id).arg(static_cast<double>(left_ms) / 1000.0, 0, 'f', 1);
    } else {
        here = tr("take %1 armed, no start time yet").arg(t.take_id);
    }
    QString out = row(role_ == Role::Producer ? tr("Producer PC (this PC)") : tr("This PC"), here);
    if (role_ == Role::Producer) {
        QString there;
        if (t.cancelled) {
            there = tr("cancelled");
        } else if (t.peer_finalised) {
            there = tr("saved: %1, %2 frames").arg(qs(rr::take_status_name(t.peer_status))).arg(t.peer_frames);
        } else if (t.peer_report_timed_out) {
            there = tr("<b>UNKNOWN</b> (no report from the performer)");
        } else if (t.peer_started) {
            there = tr("RECORDING (confirmed by the performer)");
        } else if (t.peer_start_ack) {
            there = tr("SCHEDULED (start time acknowledged)");
        } else if (t.peer_arm_ack) {
            there = tr("armed (acknowledged), start time being agreed");
        } else {
            there = tr("waiting for the performer's acknowledgement");
        }
        out += row(tr("Performer PC"), there);
        if (t.has_start_offset) {
            out += tr("Estimated recording-start offset (performer - producer): %1 ms +/- %2 ms "
                      "(clock-offset uncertainty only; device input latency not included)")
                       .arg(t.start_offset_ms, 0, 'f', 3)
                       .arg(t.start_offset_unc_ms, 0, 'f', 3);
        }
    }
    return out;
}

QString SessionPanel::transfers_html(const rr::control::ControllerSnapshot& s) const {
    // State as words plus a symbol (never colour alone). VERIFIED comes only from the producer's
    // own SHA-256 and WAV checks (ADR-020).
    if (s.transfers.empty()) {
        return role_ == Role::Producer ? tr("No copies requested in this session.")
                                       : tr("No copies sent in this session.");
    }
    using rr::xfer::TransferState;
    QString html = QStringLiteral("<table cellspacing='4'><tr><th align='left'>%1</th><th align='left'>%2</th>"
                                  "<th align='left'>%3</th><th align='left'>%4</th></tr>")
                       .arg(tr("Take"), tr("State"), tr("Progress"), tr("Details"));
    for (const auto& v : s.transfers) {
        QString state;
        switch (v.state) {
            case TransferState::Queued: state = tr("[ ] QUEUED"); break;
            case TransferState::Transferring: state = tr("[>] TRANSFERRING"); break;
            case TransferState::Retrying: state = tr("[||] PAUSED / RETRYING"); break;
            case TransferState::Verifying: state = tr("[?] VERIFYING"); break;
            case TransferState::Verified: state = tr("[OK] VERIFIED COPY"); break;
            case TransferState::Failed: state = tr("[X] FAILED"); break;
        }
        const double pct = v.bytes_total ? 100.0 * static_cast<double>(v.bytes_done) / static_cast<double>(v.bytes_total) : 0.0;
        QString progress = tr("%1 % of %2 MB").arg(pct, 0, 'f', 0).arg(static_cast<double>(v.bytes_total) / 1e6, 0, 'f', 1);
        if (v.resumes > 0) {
            progress += tr(", resumed %1x").arg(v.resumes);
        }
        QString details = qs(v.detail).toHtmlEscaped();
        if (role_ == Role::Producer && v.state == TransferState::Verified) {
            details = tr("%1 s, %2 Hz, %3 ch, %4 frames (matches the performer's report: %5)<br>SHA-256 %6<br>%7")
                          .arg(v.duration_s, 0, 'f', 3)
                          .arg(v.sample_rate)
                          .arg(v.channels)
                          .arg(static_cast<qulonglong>(v.frames))
                          .arg(qs(v.frames_vs_report))
                          .arg(qs(v.sha256_hex))
                          .arg(qs(v.file).toHtmlEscaped());
        }
        if (v.state == TransferState::Failed) {
            details += tr("<br>The original is still on the performer's PC.");
        }
        if (role_ == Role::Performer && !v.source_sha_after_hex.empty()) {
            details += v.source_unchanged ? tr("<br>Original on this PC: unchanged (SHA-256 checked before and after).")
                                          : tr("<br><b>Original on this PC: CHANGED during sending</b>");
        }
        html += QStringLiteral("<tr><td>%1</td><td><b>%2</b></td><td>%3</td><td>%4</td></tr>")
                    .arg(v.take_id)
                    .arg(state, progress, details);
    }
    return html + QStringLiteral("</table>");
}

QString SessionPanel::confirmations_text(const rr::control::ControllerSnapshot& s) const {
    const auto& t = s.take;
    if (t.take_id == 0) {
        return tr("<i>No take yet. Record is enabled when both PCs are ready and both people have consented.</i>");
    }
    const bool active = s.session != SessionState::Ready && s.session != SessionState::NotReady;
    QString html = tr("<b>Take %1</b> - performer steps are shown only after the performer's own reply:<br>").arg(t.take_id);
    html += tr("ARM sent: %1 &nbsp; performer ARM_ACK: %2<br>")
                .arg(yes_waiting(t.arm_sent, false), yes_waiting(t.peer_arm_ack, t.arm_sent && active));
    html += tr("start time sent: %1 &nbsp; performer START_ACK: %2<br>")
                .arg(yes_waiting(t.schedule_sent, false), yes_waiting(t.peer_start_ack, t.schedule_sent && active));
    html += tr("recording started here: %1 &nbsp; performer CONFIRMED its recording started: %2<br>")
                .arg(yes_waiting(t.local_started, active), yes_waiting(t.peer_started, t.peer_start_ack && active));
    if (t.has_start_offset) {
        html += tr("estimated start difference (performer - producer): %1 ms +/- %2 ms "
                   "<i>(clock-offset uncertainty only; device input latency not included)</i><br>")
                    .arg(t.start_offset_ms, 0, 'f', 2)
                    .arg(t.start_offset_unc_ms, 0, 'f', 2);
    }
    if (t.stop_sent || t.peer_stop_ack || t.local_finalised) {
        html += tr("stop sent: %1 &nbsp; performer STOP_ACK: %2<br>")
                    .arg(yes_waiting(t.stop_sent, false), yes_waiting(t.peer_stop_ack, t.stop_sent && active));
    }
    if (t.local_finalised) {
        html += tr("this PC's take: <b>%1</b>, %2 frames<br>").arg(qs(rr::take_status_name(t.local_status))).arg(t.local_frames);
    }
    if (t.peer_finalised) {
        html += tr("performer's take: <b>%1</b>, %2 frames (reported by the performer)")
                    .arg(qs(rr::take_status_name(t.peer_status)))
                    .arg(t.peer_frames);
    } else if (t.peer_report_timed_out) {
        html += tr("performer's take: <b>UNKNOWN</b> (no report received)");
    }
    return html;
}

// ---------------------------------------------------------------------------------------------
rr::session::SessionSnapshot SessionPanel::status_snapshot() const {
    if (!controller_) {
        return rr::session::initial_snapshot(role_);
    }
    const rr::control::ControllerSnapshot c = controller_->snapshot();
    rr::session::SessionSnapshot s;
    s.role = role_;
    s.link = c.link;
    s.session = c.session;
    s.not_ready_reasons = c.not_ready_reasons;
    return s;
}

bool SessionPanel::take_active() const {
    if (!controller_) {
        return false;
    }
    const SessionState st = controller_->snapshot().session;
    return st == SessionState::Recording || rr::session::is_take_active(st) || st == SessionState::Armed;
}

void SessionPanel::shut_down() {
    if (timer_) {
        timer_->stop();
    }
    if (controller_) {
        controller_->shutdown();
        if (audio_) {
            controller_->poll();  // collect a take finalised by the shutdown (the port needs the engine)
        }
    }
    set_session_control(false);
}

LiveContext SessionPanel::live_context() const {
    LiveContext c;
    if (!controller_ || !controller_->session_active()) {
        return c;
    }
    const rr::control::ControllerSnapshot s = controller_->snapshot();
    c.session_open = s.link != LinkState::Disconnected;
    c.connected = s.link == LinkState::Connected;
    c.session_id = s.session_id;
    c.local_address = s.bind_address;
    c.peer_address = s.peer_address;
    c.control_port = s.port;
    c.link_state = std::string(rr::session::link_state_name(s.link));
    c.peer_name = s.peer_name;
    c.control_rtt_ms = static_cast<double>(s.link_stats.control_rtt_ns) / 1e6;
    const auto& t = s.take;
    if (t.take_id == 0) {
        c.recording_status = "idle (no take yet); session " + std::string(rr::session::session_state_name(s.session));
    } else if (t.local_finalised) {
        c.recording_status = "take " + std::to_string(t.take_id) + " " + std::string(rr::take_status_name(t.local_status)) +
                             ", " + std::to_string(t.local_frames) + " frames";
    } else {
        c.recording_status = std::string(t.local_started ? "RECORDING take " : "take armed/scheduled: ") +
                             std::to_string(t.take_id);
    }
    return c;
}

QString SessionPanel::diagnostics_text() const {
    QString out = QStringLiteral("=== Session ===\n");
    if (!controller_) {
        return out + QStringLiteral("no session created/joined yet\n");
    }
    const rr::control::ControllerSnapshot s = controller_->snapshot();
    out += QStringLiteral("link %1, session %2, session id %3, peer '%4' at %5\n")
               .arg(qs(rr::session::link_state_name(s.link)), qs(rr::session::session_state_name(s.session)),
                    qs(s.session_id), qs(s.peer_name), qs(s.peer_address));
    out += QStringLiteral("local address %1 port %2, recorder: %3\n")
               .arg(qs(s.bind_address)).arg(s.port).arg(qs(s.recorder_description));
    out += QStringLiteral("invalid events %1, refused messages %2, duplicates %3\n")
               .arg(s.invalid_events).arg(s.refused_messages).arg(s.duplicate_messages);
    for (const auto& line : controller_->take_history()) {
        out += qs(line) + QLatin1Char('\n');
    }
    return out;
}

}  // namespace rr::ui
