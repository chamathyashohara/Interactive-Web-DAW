#include "simple_panel.hpp"

#include <algorithm>
#include <cmath>

#include <QCheckBox>
#include <QFont>
#include <QFrame>
#include <QGridLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QProgressBar>
#include <QStyle>
#include <QPushButton>
#include <QRegularExpression>
#include <QRegularExpressionValidator>
#include <QSignalBlocker>
#include <QTimer>
#include <QVBoxLayout>

#include "audio_panel.hpp"
#include "session_panel.hpp"
#include "theme.hpp"
#include "rr/shared/clock.hpp"

namespace rr::ui {
namespace {

using rr::session::LinkState;
using rr::session::SessionState;

QString qs(const std::string& text) {
    return QString::fromStdString(text);
}

QLabel* make_label(const QString& text, const char* object_name = nullptr, bool wrap = true) {
    auto* label = new QLabel(text);
    label->setWordWrap(wrap);
    if (object_name != nullptr) {
        label->setObjectName(QString::fromLatin1(object_name));
    }
    return label;
}

bool take_in_progress(SessionState s) {
    return s == SessionState::Armed || s == SessionState::Scheduled || s == SessionState::Recording ||
           s == SessionState::Stopping || s == SessionState::Finalising;
}

// Seconds until `at_ns` on this PC's clock (0 when it has passed or is unknown).
double seconds_until(std::int64_t at_ns) {
    if (at_ns == 0) {
        return 0.0;
    }
    const double s = static_cast<double>(at_ns - rr::time::monotonic_ns()) / 1e9;
    return s > 0.0 ? s : 0.0;
}

}  // namespace

SimplePanel::SimplePanel(Role role, const AppConfig& config, AudioPanel& audio, SessionPanel& session,
                         QWidget* parent)
    : QWidget(parent), role_(role), config_(config), audio_(audio), session_(session) {
    setObjectName(QStringLiteral("pageSimple"));
    build();
    timer_ = new QTimer(this);
    timer_->setInterval(150);
    connect(timer_, &QTimer::timeout, this, &SimplePanel::refresh);
    timer_->start();
    refresh();
}

SimplePanel::Step SimplePanel::add_step(QWidget* parent, int number, const QString& title, QWidget* body) {
    Step step;
    step.card = new QFrame(parent);
    step.card->setObjectName(QStringLiteral("card"));
    auto* grid = new QGridLayout(step.card);
    grid->setContentsMargins(18, 16, 18, 16);
    grid->setHorizontalSpacing(14);
    grid->setVerticalSpacing(8);

    step.badge = new QLabel(QString::number(number));
    step.badge->setObjectName(QStringLiteral("stepOff"));
    grid->addWidget(step.badge, 0, 0, Qt::AlignTop);

    step.title = make_label(title, "h2", false);
    grid->addWidget(step.title, 0, 1);

    step.status = make_label(QString(), "muted");
    grid->addWidget(step.status, 1, 1);

    body->setParent(step.card);
    grid->addWidget(body, 2, 1);
    grid->setColumnStretch(1, 1);
    return step;
}

void SimplePanel::build() {
    auto* page = new QVBoxLayout(this);
    page->setContentsMargins(22, 18, 22, 18);
    page->setSpacing(14);

    // ---------------- hero ----------------
    auto* hero = new QFrame;
    hero->setObjectName(QStringLiteral("hero"));
    auto* hero_layout = new QHBoxLayout(hero);
    hero_layout->setContentsMargins(20, 16, 20, 16);
    auto* hero_text = new QVBoxLayout;
    hero_text->addWidget(make_label(role_ == Role::Producer ? tr("Producer Studio") : tr("Performer Client"), "h1", false));
    hero_text->addWidget(make_label(role_ == Role::Producer
                                        ? tr("You start the session and press Record. Both PCs record their own "
                                             "microphone at full quality.")
                                        : tr("You join the producer's session. Your own microphone is recorded on "
                                             "this PC; the producer presses Record."),
                                    "muted"));
    peer_label_ = make_label(QString(), "muted");
    hero_text->addWidget(peer_label_);
    hero_layout->addLayout(hero_text, 1);
    status_pill_ = new QLabel;
    status_pill_->setObjectName(QStringLiteral("pillIdle"));
    hero_layout->addWidget(status_pill_, 0, Qt::AlignTop);
    page->addWidget(hero);

    // ---------------- step 1: sound ----------------
    {
        auto* body = new QWidget;
        auto* v = new QVBoxLayout(body);
        v->setContentsMargins(0, 0, 0, 0);
        v->setSpacing(8);

        auto* mic_row = new QHBoxLayout;
        mic_label_ = make_label(tr("Microphone"), nullptr, false);
        mic_button_ = new QPushButton(tr("Turn on my &microphone"));
        mic_button_->setObjectName(QStringLiteral("primary"));
        mic_row->addWidget(mic_label_, 1);
        mic_row->addWidget(mic_button_);
        v->addLayout(mic_row);

        auto* level_row = new QHBoxLayout;
        level_ = new QProgressBar;
        level_->setRange(-60, 0);
        level_->setValue(-60);
        level_->setTextVisible(false);
        level_text_ = make_label(tr("no sound yet"), "tiny", false);
        level_text_->setMinimumWidth(150);
        level_->setMaximumWidth(360);
        level_row->addWidget(level_, 1);
        level_row->addWidget(level_text_);
        v->addLayout(level_row);

        auto* out_row = new QHBoxLayout;
        out_label_ = make_label(tr("Headphones"), nullptr, false);
        out_button_ = new QPushButton(tr("Turn on my &headphones"));
        out_row->addWidget(out_label_, 1);
        out_row->addWidget(out_button_);
        v->addLayout(out_row);

        v->addWidget(make_label(tr("Use headphones, not speakers: the two of you hear each other live, and "
                                   "speakers would echo back into the recording."),
                                "tiny"));
        step_sound_ = add_step(this, 1, tr("Sound"), body);
        page->addWidget(step_sound_.card);

        connect(mic_button_, &QPushButton::clicked, this, [this] {
            audio_.ui_open_input();
            refresh();
        });
        connect(out_button_, &QPushButton::clicked, this, [this] {
            audio_.ui_open_output();
            refresh();
        });
    }

    // ---------------- step 2: connect ----------------
    {
        auto* body = new QWidget;
        auto* v = new QVBoxLayout(body);
        v->setContentsMargins(0, 0, 0, 0);
        v->setSpacing(10);

        if (role_ == Role::Producer) {
            session_button_ = new QPushButton(tr("&Start the session"));
            session_button_->setObjectName(QStringLiteral("primary"));
            auto* row = new QHBoxLayout;
            row->addWidget(session_button_);
            row->addStretch(1);
            v->addLayout(row);

            invite_card_ = new QFrame;
            invite_card_->setObjectName(QStringLiteral("cardMuted"));
            auto* invite = new QGridLayout(invite_card_);
            invite->setContentsMargins(14, 12, 14, 12);
            invite->addWidget(make_label(tr("Tell the performer these two things:"), "muted"), 0, 0, 1, 2);
            invite->addWidget(make_label(tr("Address"), nullptr, false), 1, 0);
            address_value_ = make_label(QStringLiteral("-"), "value", false);
            address_value_->setTextInteractionFlags(Qt::TextSelectableByMouse);
            invite->addWidget(address_value_, 1, 1);
            invite->addWidget(make_label(tr("Code"), nullptr, false), 2, 0, Qt::AlignVCenter);
            code_value_ = make_label(QStringLiteral("------"), "code", false);
            code_value_->setTextInteractionFlags(Qt::TextSelectableByMouse);
            invite->addWidget(code_value_, 2, 1, Qt::AlignLeft);
            invite->addWidget(make_label(tr("If the performer cannot connect, this may be the wrong network: "
                                            "pick another one under \"All controls\"."),
                                         "tiny"),
                              4, 0, 1, 2);
            new_code_button_ = new QPushButton(tr("New code"));
            new_code_button_->setObjectName(QStringLiteral("link"));
            invite->addWidget(new_code_button_, 3, 1, Qt::AlignLeft);
            invite->setColumnStretch(1, 1);
            v->addWidget(invite_card_);

            connect(session_button_, &QPushButton::clicked, this, [this] {
                session_.ui_create_or_end();
                refresh();
            });
            connect(new_code_button_, &QPushButton::clicked, this, [this] {
                session_.ui_new_pairing_code();
                refresh();
            });
        } else {
            auto* grid = new QGridLayout;
            grid->addWidget(make_label(tr("Producer's address"), nullptr, false), 0, 0);
            host_edit_ = new QLineEdit;
            host_edit_->setObjectName(QStringLiteral("bigEntry"));
            host_edit_->setPlaceholderText(QStringLiteral("192.168.1.20"));
            grid->addWidget(host_edit_, 0, 1);
            grid->addWidget(make_label(tr("6-digit code"), nullptr, false), 1, 0);
            code_edit_ = new QLineEdit;
            code_edit_->setObjectName(QStringLiteral("bigEntry"));
            code_edit_->setPlaceholderText(QStringLiteral("123456"));
            code_edit_->setMaxLength(6);
            code_edit_->setValidator(new QRegularExpressionValidator(QRegularExpression(QStringLiteral("[0-9]{0,6}")), this));
            grid->addWidget(code_edit_, 1, 1);
            grid->setColumnStretch(1, 1);
            v->addLayout(grid);

            join_button_ = new QPushButton(tr("&Join the session"));
            join_button_->setObjectName(QStringLiteral("primary"));
            auto* row = new QHBoxLayout;
            row->addWidget(join_button_);
            row->addStretch(1);
            v->addLayout(row);

            auto join = [this] {
                session_.ui_set_connection(host_edit_->text().trimmed(), code_edit_->text().trimmed());
                session_.ui_join_or_leave();
                refresh();
            };
            connect(join_button_, &QPushButton::clicked, this, join);
            connect(code_edit_, &QLineEdit::returnPressed, this, join);
        }
        step_connect_ = add_step(this, 2, tr("Connect the two PCs"), body);
        page->addWidget(step_connect_.card);
    }

    // ---------------- step 3: record ----------------
    {
        auto* body = new QWidget;
        auto* v = new QVBoxLayout(body);
        v->setContentsMargins(0, 0, 0, 0);
        v->setSpacing(10);

        auto* row = new QHBoxLayout;
        if (role_ == Role::Producer) {
            record_button_ = new QPushButton(tr("&Record on both PCs"));
            record_button_->setObjectName(QStringLiteral("record"));
            stop_button_ = new QPushButton(tr("S&top"));
            stop_button_->setObjectName(QStringLiteral("stop"));
            row->addWidget(record_button_);
            row->addWidget(stop_button_);
            connect(record_button_, &QPushButton::clicked, this, [this] {
                session_.ui_record();
                refresh();
            });
            connect(stop_button_, &QPushButton::clicked, this, [this] {
                session_.ui_stop();
                refresh();
            });
        } else {
            stop_save_button_ = new QPushButton(tr("Stop && save my own recording"));
            row->addWidget(stop_save_button_);
            connect(stop_save_button_, &QPushButton::clicked, this, [this] {
                session_.ui_stop_and_save();  // asks for confirmation
                refresh();
            });
        }
        row->addStretch(1);
        v->addLayout(row);

        this_pc_ = make_label(QString(), nullptr);
        other_pc_ = make_label(QString(), nullptr);
        v->addWidget(this_pc_);
        v->addWidget(other_pc_);
        step_record_ = add_step(this, 3, tr("Record"), body);
        page->addWidget(step_record_.card);
    }

    // ---------------- step 4: the performer's file ----------------
    {
        auto* body = new QWidget;
        auto* v = new QVBoxLayout(body);
        v->setContentsMargins(0, 0, 0, 0);
        v->setSpacing(8);

        if (role_ == Role::Producer) {
            auto* row = new QHBoxLayout;
            copy_button_ = new QPushButton(tr("&Get the performer's recording"));
            copy_button_->setObjectName(QStringLiteral("primary"));
            auto_copy_ = new QCheckBox(tr("Do this automatically after every take"));
            row->addWidget(copy_button_);
            row->addWidget(auto_copy_);
            row->addStretch(1);
            v->addLayout(row);
            connect(copy_button_, &QPushButton::clicked, this, [this] {
                session_.ui_request_copy();
                refresh();
            });
            connect(auto_copy_, &QCheckBox::toggled, this, [this](bool on) { session_.ui_set_auto_copy(on); });
        } else {
            allow_copy_ = new QCheckBox(tr("Let the producer receive a copy of my recordings"));
            {
                QFont f = allow_copy_->font();
                f.setBold(true);
                allow_copy_->setFont(f);
            }
            v->addWidget(allow_copy_);
            v->addWidget(make_label(tr("Your own files always stay on this PC and are never changed. The producer "
                                       "receives a copy, which the app checks before it is accepted."),
                                    "tiny"));
            connect(allow_copy_, &QCheckBox::toggled, this, [this](bool on) { session_.ui_set_delivery_consent(on); });
        }
        copy_status_ = make_label(QString(), "muted");
        v->addWidget(copy_status_);
        step_copy_ = add_step(this, 4, tr("The performer's recording on the producer's PC"), body);
        page->addWidget(step_copy_.card);
    }

    // ---------------- consent, reasons, errors ----------------
    auto* foot = new QFrame;
    foot->setObjectName(QStringLiteral("card"));
    auto* foot_layout = new QVBoxLayout(foot);
    foot_layout->setContentsMargins(18, 14, 18, 14);
    foot_layout->setSpacing(8);
    consent_ = new QCheckBox(role_ == Role::Producer
                                 ? tr("I consent to this session being recorded")
                                 : tr("I agree to be recorded, and I am ready to start"));
    {
        QFont f = consent_->font();
        f.setPointSize(f.pointSize() + 1);
        f.setBold(true);
        consent_->setFont(f);
    }
    foot_layout->addWidget(consent_);
    reasons_ = make_label(QString(), "muted");
    foot_layout->addWidget(reasons_);
    error_ = make_label(QString(), "errorText");
    error_->setVisible(false);
    foot_layout->addWidget(error_);
    page->addWidget(foot);
    connect(consent_, &QCheckBox::toggled, this, [this](bool on) { session_.ui_set_consent(on); });

    auto* links = new QHBoxLayout;
    auto* advanced = new QPushButton(tr("Show all controls, meters and counters (advanced)"));
    advanced->setObjectName(QStringLiteral("link"));
    connect(advanced, &QPushButton::clicked, this, [this] { emit advancedRequested(); });
    links->addWidget(advanced);
    links->addStretch(1);
    page->addLayout(links);

    page->addWidget(make_label(tr("LAN-only prototype: audio and control are not encrypted. Use it only on a "
                                  "trusted private network, never across the internet."),
                               "notice"));
    page->addStretch(1);
}

void SimplePanel::set_step(const Step& step, int number, bool done, bool enabled, const QString& status) {
    const char* name = done ? "stepDone" : (enabled ? "stepOn" : "stepOff");
    if (step.badge->objectName() != QLatin1String(name)) {
        step.badge->setObjectName(QString::fromLatin1(name));
        step.badge->style()->unpolish(step.badge);
        step.badge->style()->polish(step.badge);
    }
    step.badge->setText(done ? QStringLiteral("OK") : QString::number(number));
    step.status->setText(status);
}

void SimplePanel::refresh() {
    const rr::control::ControllerSnapshot s = session_.ui_snapshot();
    const bool connected = s.link == LinkState::Connected;
    const bool recording = s.session == SessionState::Recording;
    const bool in_take = take_in_progress(s.session);

    // ---- hero ----
    if (recording) {
        set_pill(status_pill_, Pill::Recording, tr("RECORDING"));
    } else if (s.session == SessionState::Scheduled || s.session == SessionState::Armed) {
        set_pill(status_pill_, Pill::Busy, tr("starting in %1 s").arg(seconds_until(s.take.start_at_local_ns), 0, 'f', 1));
    } else if (s.session == SessionState::Stopping || s.session == SessionState::Finalising) {
        set_pill(status_pill_, Pill::Busy, tr("saving the file"));
    } else if (s.session == SessionState::Ready) {
        set_pill(status_pill_, Pill::Good, tr("Ready"));
    } else if (connected) {
        set_pill(status_pill_, Pill::Warn, tr("Not ready yet"));
    } else if (s.link == LinkState::Connecting || s.link == LinkState::Listening) {
        set_pill(status_pill_, Pill::Busy, role_ == Role::Producer ? tr("waiting for the performer") : tr("connecting"));
    } else if (s.link == LinkState::LinkLost) {
        set_pill(status_pill_, Pill::Bad, tr("connection lost"));
    } else {
        set_pill(status_pill_, Pill::Idle, tr("not connected"));
    }
    peer_label_->setText(connected && !s.peer_name.empty()
                             ? tr("Connected to %1 (%2)").arg(qs(s.peer_name), qs(s.peer_address))
                             : QString());
    peer_label_->setVisible(!peer_label_->text().isEmpty());

    // ---- step 1: sound ----
    const bool mic_on = audio_.ui_input_open();
    const bool out_on = audio_.ui_output_open();
    mic_label_->setText(mic_on ? tr("Microphone: %1").arg(audio_.ui_input_name())
                               : tr("Microphone: not on yet (%1)").arg(audio_.ui_input_name()));
    mic_button_->setEnabled(!mic_on);
    mic_button_->setText(mic_on ? tr("Microphone is on") : tr("Turn on my &microphone"));
    out_label_->setText(out_on ? tr("Headphones: %1").arg(audio_.ui_output_name())
                               : tr("Headphones: not on yet (%1)").arg(audio_.ui_output_name()));
    out_button_->setEnabled(!out_on);
    out_button_->setText(out_on ? tr("Headphones are on") : tr("Turn on my &headphones"));
    if (mic_on) {
        const double db = audio_.ui_peak_dbfs();
        level_->setValue(static_cast<int>(std::max(-60.0, std::min(0.0, db))));
        level_text_->setText(db <= -59.0 ? tr("no sound - is the mic muted in Windows?")
                                         : tr("%1 dB").arg(db, 0, 'f', 0));
    } else {
        level_->setValue(-60);
        level_text_->setText(tr("microphone is off"));
    }
    set_step(step_sound_, 1, mic_on && out_on, true,
             mic_on && out_on ? tr("Microphone and headphones are on.")
                              : tr("Turn on the microphone you want to record, and your headphones."));

    // ---- step 2: connect ----
    const bool session_open = session_.ui_session_active();
    if (role_ == Role::Producer) {
        session_button_->setText(session_open ? tr("&End the session") : tr("&Start the session"));
        session_button_->setEnabled(!in_take);
        session_button_->setToolTip(in_take ? tr("Not while a take is running: press Stop first.") : QString());
        invite_card_->setVisible(session_open);
        if (session_open) {
            address_value_->setText(QStringLiteral("%1   (port %2)").arg(qs(s.bind_address)).arg(s.port));
            code_value_->setText(s.pairing_code.empty() ? QStringLiteral("------") : qs(s.pairing_code));
            new_code_button_->setEnabled(!connected);
        }
        set_step(step_connect_, 2, connected, true,
                 connected ? tr("The performer has joined.")
                           : session_open ? tr("Waiting for the performer to type the address and the code.")
                                          : tr("Start the session to get a pairing code for the performer."));
    } else {
        const bool joined = session_open && s.link != LinkState::Disconnected;
        host_edit_->setEnabled(!joined);
        code_edit_->setEnabled(!joined);
        join_button_->setText(joined ? tr("&Leave the session") : tr("&Join the session"));
        join_button_->setEnabled(!in_take);
        join_button_->setToolTip(in_take ? tr("Not while a take is running.") : QString());
        set_step(step_connect_, 2, connected, true,
                 connected ? tr("Joined.")
                           : joined ? tr("Connecting to the producer...")
                                    : tr("Type what the producer reads out to you, then press Join."));
    }

    // ---- step 3: record ----
    const auto& t = s.take;
    const bool have_take = t.take_id != 0;
    const bool take_saved = have_take && t.local_finalised && !t.cancelled;
    if (role_ == Role::Producer) {
        QString why;
        if (!connected) {
            why = tr("the performer is not connected");
        } else if (s.session != SessionState::Ready) {
            why = s.not_ready_reasons.empty() ? tr("not ready yet") : qs(s.not_ready_reasons.front());
        }
        record_button_->setEnabled(why.isEmpty());
        record_button_->setToolTip(why.isEmpty() ? tr("Starts both PCs recording at an agreed moment")
                                                 : tr("Not available: %1").arg(why));
        const bool before_start = s.session == SessionState::Armed || s.session == SessionState::Scheduled;
        stop_button_->setEnabled(before_start || recording);
        stop_button_->setText(before_start ? tr("Cancel (not started yet)") : tr("S&top"));
    } else if (stop_save_button_ != nullptr) {
        stop_save_button_->setEnabled(recording);
        stop_save_button_->setToolTip(recording ? tr("Keeps what has been recorded so far on this PC")
                                                : tr("Only while this PC is recording"));
    }

    QString mine;
    if (!have_take) {
        mine = tr("This PC: nothing recorded yet.");
    } else if (t.cancelled) {
        mine = tr("This PC: take %1 was cancelled before it started - nothing was recorded.").arg(t.take_id);
    } else if (t.local_finalised) {
        mine = tr("This PC: take %1 saved (%2 frames).").arg(t.take_id).arg(t.local_frames);
    } else if (t.local_started) {
        mine = tr("This PC: RECORDING take %1.").arg(t.take_id);
    } else if (t.start_at_local_ns != 0) {
        mine = tr("This PC: take %1 starts in %2 s.").arg(t.take_id).arg(seconds_until(t.start_at_local_ns), 0, 'f', 1);
    } else {
        mine = tr("This PC: take %1 is being set up.").arg(t.take_id);
    }
    this_pc_->setText(mine);

    QString theirs;
    if (role_ == Role::Producer) {
        if (!have_take) {
            theirs = tr("Performer PC: nothing recorded yet.");
        } else if (t.cancelled) {
            theirs = tr("Performer PC: cancelled, nothing recorded.");
        } else if (t.peer_finalised) {
            theirs = tr("Performer PC: saved (%1 frames).").arg(t.peer_frames);
        } else if (t.peer_report_timed_out) {
            theirs = tr("Performer PC: UNKNOWN - no report came back.");
        } else if (t.peer_started) {
            theirs = tr("Performer PC: RECORDING (the performer's app confirmed it).");
        } else if (t.peer_start_ack) {
            theirs = tr("Performer PC: start time agreed, waiting for it.");
        } else {
            theirs = tr("Performer PC: waiting for the performer's app to answer.");
        }
    } else if (s.session == SessionState::Scheduled) {
        theirs = tr("The producer starts this take. You do not have to press anything.");
    } else {
        theirs = tr("Only the producer starts and stops takes.");
    }
    other_pc_->setText(theirs);
    set_step(step_record_, 3, take_saved, connected,
             recording ? tr("Recording now. Press Stop when you are finished.")
                       : take_saved ? tr("Take %1 is saved on both PCs.").arg(t.take_id)
                                    : connected ? tr("Ready when both PCs are ready.")
                                                : tr("Connect the two PCs first."));

    // ---- step 4: the performer's file ----
    QString copy_text;
    bool copy_done = false;
    for (const auto& v : s.transfers) {
        if (v.state == rr::xfer::TransferState::Verified) {
            copy_done = true;
        }
        copy_text = tr("Take %1: %2 - %3")
                        .arg(v.take_id)
                        .arg(QString::fromLatin1(rr::xfer::transfer_state_name(v.state)), qs(v.detail));
    }
    if (copy_text.isEmpty()) {
        copy_text = role_ == Role::Producer ? tr("No copy asked for yet.") : tr("Nothing sent yet.");
    }
    copy_status_->setText(copy_text);
    if (role_ == Role::Producer) {
        QString why;
        if (!connected) {
            why = tr("the performer is not connected");
        } else if (s.protocol_minor < 2) {
            why = tr("the performer's app is an older version");
        } else if (!s.peer_delivery_consent) {
            why = tr("the performer has not allowed copies yet");
        } else if (!have_take || !t.peer_finalised) {
            why = tr("there is no finished performer take yet");
        } else if (in_take) {
            why = tr("a take is running");
        }
        copy_button_->setEnabled(why.isEmpty());
        copy_button_->setToolTip(why.isEmpty() ? tr("Asks the performer's app for a copy and checks it")
                                               : tr("Not available: %1").arg(why));
        const QSignalBlocker block(auto_copy_);
        auto_copy_->setChecked(session_.ui_auto_copy());
        set_step(step_copy_, 4, copy_done, connected,
                 copy_done ? tr("A checked copy of the performer's take is on this PC.")
                           : why.isEmpty() ? tr("You can ask for a copy of the performer's take now.")
                                           : tr("Not available yet: %1.").arg(why));
    } else {
        const QSignalBlocker block(allow_copy_);
        allow_copy_->setChecked(session_.ui_delivery_consent());
        set_step(step_copy_, 4, copy_done, true,
                 session_.ui_delivery_consent() ? tr("The producer may ask for copies. Your originals stay here.")
                                    : tr("Tick the box if the producer may receive a copy of your recordings."));
    }

    // ---- consent and reasons ----
    {
        const QSignalBlocker block(consent_);
        consent_->setChecked(session_.ui_consent());
    }
    if (s.not_ready_reasons.empty()) {
        reasons_->setText(connected ? tr("Everything is ready.") : QString());
    } else {
        QStringList list;
        for (const auto& r : s.not_ready_reasons) {
            list << qs(r);
        }
        reasons_->setText(tr("Not ready yet: %1.").arg(list.join(QStringLiteral("; "))));
    }
    reasons_->setVisible(!reasons_->text().isEmpty());
    error_->setVisible(!s.last_error.empty());
    error_->setText(qs(s.last_error));
}

}  // namespace rr::ui
