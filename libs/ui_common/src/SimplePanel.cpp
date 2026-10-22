#include "SimplePanel.h"

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

#include "AudioPanel.h"
#include "SessionPanel.h"
#include "Theme.h"
#include "rr/shared/Clock.h"

namespace
{

QString qs(const std::string& text)
{
    return QString::fromStdString(text);
}

QLabel* makeLabel(const QString& text, const char* objectName = nullptr, bool wrap = true)
{
    auto* label = new QLabel(text);
    label->setWordWrap(wrap);
    if (objectName != nullptr)
    {
        label->setObjectName(QString::fromLatin1(objectName));
    }
    return label;
}

bool takeInProgress(SessionState s)
{
    return s == SessionState::Armed || s == SessionState::Scheduled || s == SessionState::Recording ||
           s == SessionState::Stopping || s == SessionState::Finalising;
}

// Seconds until `atNs` on this PC's clock (0 when it has passed or is unknown).
double secondsUntil(int64_t atNs)
{
    if (atNs == 0)
    {
        return 0.0;
    }
    const double s = static_cast<double>(atNs - monotonicNs()) / 1e9;
    return s > 0.0 ? s : 0.0;
}

}  // namespace

SimplePanel::SimplePanel(Role role, const AppConfig& config, AudioPanel& audio, SessionPanel& session,
                         QWidget* parent)
    : QWidget(parent), role(role), config(config), audio(audio), session(session) {
    setObjectName(QStringLiteral("pageSimple"));
    build();
    timer = new QTimer(this);
    timer->setInterval(150);
    connect(timer, &QTimer::timeout, this, &SimplePanel::refresh);
    timer->start();
    refresh();
}

SimplePanel::Step SimplePanel::addStep(QWidget* parent, int number, const QString& title, QWidget* body)
{
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

    step.title = makeLabel(title, "h2", false);
    grid->addWidget(step.title, 0, 1);

    step.status = makeLabel(QString(), "muted");
    grid->addWidget(step.status, 1, 1);

    body->setParent(step.card);
    grid->addWidget(body, 2, 1);
    grid->setColumnStretch(1, 1);
    return step;
}

void SimplePanel::build()
{
    auto* page = new QVBoxLayout(this);
    page->setContentsMargins(22, 18, 22, 18);
    page->setSpacing(14);

    // ---------------- hero ----------------
    auto* hero = new QFrame;
    hero->setObjectName(QStringLiteral("hero"));
    auto* heroLayout = new QHBoxLayout(hero);
    heroLayout->setContentsMargins(20, 16, 20, 16);
    auto* heroText = new QVBoxLayout;
    heroText->addWidget(makeLabel(role == Role::Producer ? tr("Producer Studio") : tr("Performer Client"), "h1", false));
    heroText->addWidget(makeLabel(role == Role::Producer
                                        ? tr("You start the session and press Record. Both PCs record their own "
                                             "microphone at full quality.")
                                        : tr("You join the producer's session. Your own microphone is recorded on "
                                             "this PC; the producer presses Record."),
                                    "muted"));
    peerLabel = makeLabel(QString(), "muted");
    heroText->addWidget(peerLabel);
    heroLayout->addLayout(heroText, 1);
    statusPill = new QLabel;
    statusPill->setObjectName(QStringLiteral("pillIdle"));
    heroLayout->addWidget(statusPill, 0, Qt::AlignTop);
    page->addWidget(hero);

    // ---------------- step 1: sound ----------------
    {
        auto* body = new QWidget;
        auto* v = new QVBoxLayout(body);
        v->setContentsMargins(0, 0, 0, 0);
        v->setSpacing(8);

        auto* micRow = new QHBoxLayout;
        micLabel = makeLabel(tr("Microphone"), nullptr, false);
        micButton = new QPushButton(tr("Turn on my &microphone"));
        micButton->setObjectName(QStringLiteral("primary"));
        micRow->addWidget(micLabel, 1);
        micRow->addWidget(micButton);
        v->addLayout(micRow);

        auto* levelRow = new QHBoxLayout;
        level = new QProgressBar;
        level->setRange(-60, 0);
        level->setValue(-60);
        level->setTextVisible(false);
        levelText = makeLabel(tr("no sound yet"), "tiny", false);
        levelText->setMinimumWidth(150);
        level->setMaximumWidth(360);
        levelRow->addWidget(level, 1);
        levelRow->addWidget(levelText);
        v->addLayout(levelRow);

        auto* outRow = new QHBoxLayout;
        outLabel = makeLabel(tr("Headphones"), nullptr, false);
        outButton = new QPushButton(tr("Turn on my &headphones"));
        outRow->addWidget(outLabel, 1);
        outRow->addWidget(outButton);
        v->addLayout(outRow);

        v->addWidget(makeLabel(tr("Use headphones, not speakers: the two of you hear each other live, and "
                                   "speakers would echo back into the recording."),
                                "tiny"));
        stepSound = addStep(this, 1, tr("Sound"), body);
        page->addWidget(stepSound.card);

        connect(micButton, &QPushButton::clicked, this, [this] {
            audio.uiOpenInput();
            refresh();
        });
        connect(outButton, &QPushButton::clicked, this, [this] {
            audio.uiOpenOutput();
            refresh();
        });
    }

    // ---------------- step 2: connect ----------------
    {
        auto* body = new QWidget;
        auto* v = new QVBoxLayout(body);
        v->setContentsMargins(0, 0, 0, 0);
        v->setSpacing(10);

        if (role == Role::Producer)
        {
            sessionButton = new QPushButton(tr("&Start the session"));
            sessionButton->setObjectName(QStringLiteral("primary"));
            auto* row = new QHBoxLayout;
            row->addWidget(sessionButton);
            row->addStretch(1);
            v->addLayout(row);

            inviteCard = new QFrame;
            inviteCard->setObjectName(QStringLiteral("cardMuted"));
            auto* invite = new QGridLayout(inviteCard);
            invite->setContentsMargins(14, 12, 14, 12);
            invite->addWidget(makeLabel(tr("Tell the performer these two things:"), "muted"), 0, 0, 1, 2);
            invite->addWidget(makeLabel(tr("Address"), nullptr, false), 1, 0);
            addressValue = makeLabel(QStringLiteral("-"), "value", false);
            addressValue->setTextInteractionFlags(Qt::TextSelectableByMouse);
            invite->addWidget(addressValue, 1, 1);
            invite->addWidget(makeLabel(tr("Code"), nullptr, false), 2, 0, Qt::AlignVCenter);
            codeValue = makeLabel(QStringLiteral("------"), "code", false);
            codeValue->setTextInteractionFlags(Qt::TextSelectableByMouse);
            invite->addWidget(codeValue, 2, 1, Qt::AlignLeft);
            invite->addWidget(makeLabel(tr("If the performer cannot connect, this may be the wrong network: "
                                            "pick another one under \"All controls\"."),
                                         "tiny"),
                              4, 0, 1, 2);
            newCodeButton = new QPushButton(tr("New code"));
            newCodeButton->setObjectName(QStringLiteral("link"));
            invite->addWidget(newCodeButton, 3, 1, Qt::AlignLeft);
            invite->setColumnStretch(1, 1);
            v->addWidget(inviteCard);

            connect(sessionButton, &QPushButton::clicked, this, [this] {
                session.uiCreateOrEnd();
                refresh();
            });
            connect(newCodeButton, &QPushButton::clicked, this, [this] {
                session.uiNewPairingCode();
                refresh();
            });
        }
        else
        {
            auto* grid = new QGridLayout;
            grid->addWidget(makeLabel(tr("Producer's address"), nullptr, false), 0, 0);
            hostEdit = new QLineEdit;
            hostEdit->setObjectName(QStringLiteral("bigEntry"));
            hostEdit->setPlaceholderText(QStringLiteral("192.168.1.20"));
            grid->addWidget(hostEdit, 0, 1);
            grid->addWidget(makeLabel(tr("6-digit code"), nullptr, false), 1, 0);
            codeEdit = new QLineEdit;
            codeEdit->setObjectName(QStringLiteral("bigEntry"));
            codeEdit->setPlaceholderText(QStringLiteral("123456"));
            codeEdit->setMaxLength(6);
            codeEdit->setValidator(new QRegularExpressionValidator(QRegularExpression(QStringLiteral("[0-9]{0,6}")), this));
            grid->addWidget(codeEdit, 1, 1);
            grid->setColumnStretch(1, 1);
            v->addLayout(grid);

            joinButton = new QPushButton(tr("&Join the session"));
            joinButton->setObjectName(QStringLiteral("primary"));
            auto* row = new QHBoxLayout;
            row->addWidget(joinButton);
            row->addStretch(1);
            v->addLayout(row);

            auto join = [this] {
                session.uiSetConnection(hostEdit->text().trimmed(), codeEdit->text().trimmed());
                session.uiJoinOrLeave();
                refresh();
            };
            connect(joinButton, &QPushButton::clicked, this, join);
            connect(codeEdit, &QLineEdit::returnPressed, this, join);
        }
        stepConnect = addStep(this, 2, tr("Connect the two PCs"), body);
        page->addWidget(stepConnect.card);
    }

    // ---------------- step 3: record ----------------
    {
        auto* body = new QWidget;
        auto* v = new QVBoxLayout(body);
        v->setContentsMargins(0, 0, 0, 0);
        v->setSpacing(10);

        auto* row = new QHBoxLayout;
        if (role == Role::Producer)
        {
            recordButton = new QPushButton(tr("&Record on both PCs"));
            recordButton->setObjectName(QStringLiteral("record"));
            stopButton = new QPushButton(tr("S&top"));
            stopButton->setObjectName(QStringLiteral("stop"));
            row->addWidget(recordButton);
            row->addWidget(stopButton);
            connect(recordButton, &QPushButton::clicked, this, [this] {
                session.uiRecord();
                refresh();
            });
            connect(stopButton, &QPushButton::clicked, this, [this] {
                session.uiStop();
                refresh();
            });
        }
        else
        {
            stopSaveButton = new QPushButton(tr("Stop && save my own recording"));
            row->addWidget(stopSaveButton);
            connect(stopSaveButton, &QPushButton::clicked, this, [this] {
                session.uiStopAndSave();  // asks for confirmation
                refresh();
            });
        }
        row->addStretch(1);
        v->addLayout(row);

        thisPc = makeLabel(QString(), nullptr);
        otherPc = makeLabel(QString(), nullptr);
        v->addWidget(thisPc);
        v->addWidget(otherPc);
        stepRecord = addStep(this, 3, tr("Record"), body);
        page->addWidget(stepRecord.card);
    }

    // ---------------- step 4: the performer's file ----------------
    {
        auto* body = new QWidget;
        auto* v = new QVBoxLayout(body);
        v->setContentsMargins(0, 0, 0, 0);
        v->setSpacing(8);

        if (role == Role::Producer)
        {
            auto* row = new QHBoxLayout;
            copyButton = new QPushButton(tr("&Get the performer's recording"));
            copyButton->setObjectName(QStringLiteral("primary"));
            autoCopy = new QCheckBox(tr("Do this automatically after every take"));
            row->addWidget(copyButton);
            row->addWidget(autoCopy);
            row->addStretch(1);
            v->addLayout(row);
            connect(copyButton, &QPushButton::clicked, this, [this] {
                session.uiRequestCopy();
                refresh();
            });
            connect(autoCopy, &QCheckBox::toggled, this, [this](bool on) { session.uiSetAutoCopy(on); });
        }
        else
        {
            allowCopy = new QCheckBox(tr("Let the producer receive a copy of my recordings"));
            {
                QFont f = allowCopy->font();
                f.setBold(true);
                allowCopy->setFont(f);
            }
            v->addWidget(allowCopy);
            v->addWidget(makeLabel(tr("Your own files always stay on this PC and are never changed. The producer "
                                       "receives a copy, which the app checks before it is accepted."),
                                    "tiny"));
            connect(allowCopy, &QCheckBox::toggled, this, [this](bool on) { session.uiSetDeliveryConsent(on); });
        }
        copyStatus = makeLabel(QString(), "muted");
        v->addWidget(copyStatus);
        stepCopy = addStep(this, 4, tr("The performer's recording on the producer's PC"), body);
        page->addWidget(stepCopy.card);
    }

    // ---------------- consent, reasons, errors ----------------
    auto* foot = new QFrame;
    foot->setObjectName(QStringLiteral("card"));
    auto* footLayout = new QVBoxLayout(foot);
    footLayout->setContentsMargins(18, 14, 18, 14);
    footLayout->setSpacing(8);
    consent = new QCheckBox(role == Role::Producer
                                 ? tr("I consent to this session being recorded")
                                 : tr("I agree to be recorded, and I am ready to start"));
    {
        QFont f = consent->font();
        f.setPointSize(f.pointSize() + 1);
        f.setBold(true);
        consent->setFont(f);
    }
    footLayout->addWidget(consent);
    reasons = makeLabel(QString(), "muted");
    footLayout->addWidget(reasons);
    error = makeLabel(QString(), "errorText");
    error->setVisible(false);
    footLayout->addWidget(error);
    page->addWidget(foot);
    connect(consent, &QCheckBox::toggled, this, [this](bool on) { session.uiSetConsent(on); });

    auto* links = new QHBoxLayout;
    auto* advanced = new QPushButton(tr("Show all controls, meters and counters (advanced)"));
    advanced->setObjectName(QStringLiteral("link"));
    connect(advanced, &QPushButton::clicked, this, [this] { emit advancedRequested(); });
    links->addWidget(advanced);
    links->addStretch(1);
    page->addLayout(links);

    page->addWidget(makeLabel(tr("LAN-only prototype: audio and control are not encrypted. Use it only on a "
                                  "trusted private network, never across the internet."),
                               "notice"));
    page->addStretch(1);
}

void SimplePanel::setStep(const Step& step, int number, bool done, bool enabled, const QString& status)
{
    const char* name = done ? "stepDone" : (enabled ? "stepOn" : "stepOff");
    if (step.badge->objectName() != QLatin1String(name))
    {
        step.badge->setObjectName(QString::fromLatin1(name));
        step.badge->style()->unpolish(step.badge);
        step.badge->style()->polish(step.badge);
    }
    step.badge->setText(done ? QStringLiteral("OK") : QString::number(number));
    step.status->setText(status);
}

void SimplePanel::refresh()
{
    const ControllerSnapshot s = session.uiSnapshot();
    const bool connected = s.link == LinkState::Connected;
    const bool recording = s.session == SessionState::Recording;
    const bool inTake = takeInProgress(s.session);

    // ---- hero ----
    if (recording)
    {
        setPill(statusPill, Pill::Recording, tr("RECORDING"));
    }
    else if (s.session == SessionState::Scheduled || s.session == SessionState::Armed)
    {
        setPill(statusPill, Pill::Busy, tr("starting in %1 s").arg(secondsUntil(s.take.startAtLocalNs), 0, 'f', 1));
    }
    else if (s.session == SessionState::Stopping || s.session == SessionState::Finalising)
    {
        setPill(statusPill, Pill::Busy, tr("saving the file"));
    }
    else if (s.session == SessionState::Ready)
    {
        setPill(statusPill, Pill::Good, tr("Ready"));
    }
    else if (connected)
    {
        setPill(statusPill, Pill::Warn, tr("Not ready yet"));
    }
    else if (s.link == LinkState::Connecting || s.link == LinkState::Listening)
    {
        setPill(statusPill, Pill::Busy, role == Role::Producer ? tr("waiting for the performer") : tr("connecting"));
    }
    else if (s.link == LinkState::LinkLost)
    {
        setPill(statusPill, Pill::Bad, tr("connection lost"));
    }
    else
    {
        setPill(statusPill, Pill::Idle, tr("not connected"));
    }
    peerLabel->setText(connected && !s.peerName.empty()
                             ? tr("Connected to %1 (%2)").arg(qs(s.peerName), qs(s.peerAddress))
                             : QString());
    peerLabel->setVisible(!peerLabel->text().isEmpty());

    // ---- step 1: sound ----
    const bool micOn = audio.uiInputOpen();
    const bool outOn = audio.uiOutputOpen();
    micLabel->setText(micOn ? tr("Microphone: %1").arg(audio.uiInputName())
                               : tr("Microphone: not on yet (%1)").arg(audio.uiInputName()));
    micButton->setEnabled(!micOn);
    micButton->setText(micOn ? tr("Microphone is on") : tr("Turn on my &microphone"));
    outLabel->setText(outOn ? tr("Headphones: %1").arg(audio.uiOutputName())
                               : tr("Headphones: not on yet (%1)").arg(audio.uiOutputName()));
    outButton->setEnabled(!outOn);
    outButton->setText(outOn ? tr("Headphones are on") : tr("Turn on my &headphones"));
    if (micOn)
    {
        const double db = audio.uiPeakDbfs();
        level->setValue(static_cast<int>(std::max(-60.0, std::min(0.0, db))));
        levelText->setText(db <= -59.0 ? tr("no sound - is the mic muted in Windows?")
                                         : tr("%1 dB").arg(db, 0, 'f', 0));
    }
    else
    {
        level->setValue(-60);
        levelText->setText(tr("microphone is off"));
    }
    setStep(stepSound, 1, micOn && outOn, true,
             micOn && outOn ? tr("Microphone and headphones are on.")
                              : tr("Turn on the microphone you want to record, and your headphones."));

    // ---- step 2: connect ----
    const bool sessionOpen = session.uiSessionActive();
    if (role == Role::Producer)
    {
        sessionButton->setText(sessionOpen ? tr("&End the session") : tr("&Start the session"));
        sessionButton->setEnabled(!inTake);
        sessionButton->setToolTip(inTake ? tr("Not while a take is running: press Stop first.") : QString());
        inviteCard->setVisible(sessionOpen);
        if (sessionOpen)
        {
            addressValue->setText(QStringLiteral("%1   (port %2)").arg(qs(s.bindAddress)).arg(s.port));
            codeValue->setText(s.pairingCode.empty() ? QStringLiteral("------") : qs(s.pairingCode));
            newCodeButton->setEnabled(!connected);
        }
        setStep(stepConnect, 2, connected, true,
                 connected ? tr("The performer has joined.")
                           : sessionOpen ? tr("Waiting for the performer to type the address and the code.")
                                          : tr("Start the session to get a pairing code for the performer."));
    }
    else
    {
        const bool joined = sessionOpen && s.link != LinkState::Disconnected;
        hostEdit->setEnabled(!joined);
        codeEdit->setEnabled(!joined);
        joinButton->setText(joined ? tr("&Leave the session") : tr("&Join the session"));
        joinButton->setEnabled(!inTake);
        joinButton->setToolTip(inTake ? tr("Not while a take is running.") : QString());
        setStep(stepConnect, 2, connected, true,
                 connected ? tr("Joined.")
                           : joined ? tr("Connecting to the producer...")
                                    : tr("Type what the producer reads out to you, then press Join."));
    }

    // ---- step 3: record ----
    const auto& t = s.take;
    const bool haveTake = t.takeId != 0;
    const bool takeSaved = haveTake && t.localFinalised && !t.cancelled;
    if (role == Role::Producer)
    {
        QString why;
        if (!connected)
        {
            why = tr("the performer is not connected");
        }
        else if (s.session != SessionState::Ready)
        {
            why = s.notReadyReasons.empty() ? tr("not ready yet") : qs(s.notReadyReasons.front());
        }
        recordButton->setEnabled(why.isEmpty());
        recordButton->setToolTip(why.isEmpty() ? tr("Starts both PCs recording at an agreed moment")
                                                 : tr("Not available: %1").arg(why));
        const bool beforeStart = s.session == SessionState::Armed || s.session == SessionState::Scheduled;
        stopButton->setEnabled(beforeStart || recording);
        stopButton->setText(beforeStart ? tr("Cancel (not started yet)") : tr("S&top"));
    }
    else if (stopSaveButton != nullptr)
    {
        stopSaveButton->setEnabled(recording);
        stopSaveButton->setToolTip(recording ? tr("Keeps what has been recorded so far on this PC")
                                                : tr("Only while this PC is recording"));
    }

    QString mine;
    if (!haveTake)
    {
        mine = tr("This PC: nothing recorded yet.");
    }
    else if (t.cancelled)
    {
        mine = tr("This PC: take %1 was cancelled before it started - nothing was recorded.").arg(t.takeId);
    }
    else if (t.localFinalised)
    {
        mine = tr("This PC: take %1 saved (%2 frames).").arg(t.takeId).arg(t.localFrames);
    }
    else if (t.localStarted)
    {
        mine = tr("This PC: RECORDING take %1.").arg(t.takeId);
    }
    else if (t.startAtLocalNs != 0)
    {
        mine = tr("This PC: take %1 starts in %2 s.").arg(t.takeId).arg(secondsUntil(t.startAtLocalNs), 0, 'f', 1);
    }
    else
    {
        mine = tr("This PC: take %1 is being set up.").arg(t.takeId);
    }
    thisPc->setText(mine);

    QString theirs;
    if (role == Role::Producer)
    {
        if (!haveTake)
        {
            theirs = tr("Performer PC: nothing recorded yet.");
        }
        else if (t.cancelled)
        {
            theirs = tr("Performer PC: cancelled, nothing recorded.");
        }
        else if (t.peerFinalised)
        {
            theirs = tr("Performer PC: saved (%1 frames).").arg(t.peerFrames);
        }
        else if (t.peerReportTimedOut)
        {
            theirs = tr("Performer PC: UNKNOWN - no report came back.");
        }
        else if (t.peerStarted)
        {
            theirs = tr("Performer PC: RECORDING (the performer's app confirmed it).");
        }
        else if (t.peerStartAck)
        {
            theirs = tr("Performer PC: start time agreed, waiting for it.");
        }
        else
        {
            theirs = tr("Performer PC: waiting for the performer's app to answer.");
        }
    }
    else if (s.session == SessionState::Scheduled)
    {
        theirs = tr("The producer starts this take. You do not have to press anything.");
    }
    else
    {
        theirs = tr("Only the producer starts and stops takes.");
    }
    otherPc->setText(theirs);
    setStep(stepRecord, 3, takeSaved, connected,
             recording ? tr("Recording now. Press Stop when you are finished.")
                       : takeSaved ? tr("Take %1 is saved on both PCs.").arg(t.takeId)
                                    : connected ? tr("Ready when both PCs are ready.")
                                                : tr("Connect the two PCs first."));

    // ---- step 4: the performer's file ----
    QString copyText;
    bool copyDone = false;
    for (const auto& v : s.transfers)
    {
        if (v.state == TransferState::Verified)
        {
            copyDone = true;
        }
        copyText = tr("Take %1: %2 - %3")
                        .arg(v.takeId)
                        .arg(QString::fromLatin1(transferStateName(v.state)), qs(v.detail));
    }
    if (copyText.isEmpty())
    {
        copyText = role == Role::Producer ? tr("No copy asked for yet.") : tr("Nothing sent yet.");
    }
    copyStatus->setText(copyText);
    if (role == Role::Producer)
    {
        QString why;
        if (!connected)
        {
            why = tr("the performer is not connected");
        }
        else if (s.protocolMinor < 2)
        {
            why = tr("the performer's app is an older version");
        }
        else if (!s.peerDeliveryConsent)
        {
            why = tr("the performer has not allowed copies yet");
        }
        else if (!haveTake || !t.peerFinalised)
        {
            why = tr("there is no finished performer take yet");
        }
        else if (inTake)
        {
            why = tr("a take is running");
        }
        copyButton->setEnabled(why.isEmpty());
        copyButton->setToolTip(why.isEmpty() ? tr("Asks the performer's app for a copy and checks it")
                                               : tr("Not available: %1").arg(why));
        const QSignalBlocker block(autoCopy);
        autoCopy->setChecked(session.uiAutoCopy());
        setStep(stepCopy, 4, copyDone, connected,
                 copyDone ? tr("A checked copy of the performer's take is on this PC.")
                           : why.isEmpty() ? tr("You can ask for a copy of the performer's take now.")
                                           : tr("Not available yet: %1.").arg(why));
    }
    else
    {
        const QSignalBlocker block(allowCopy);
        allowCopy->setChecked(session.uiDeliveryConsent());
        setStep(stepCopy, 4, copyDone, true,
                 session.uiDeliveryConsent() ? tr("The producer may ask for copies. Your originals stay here.")
                                    : tr("Tick the box if the producer may receive a copy of your recordings."));
    }

    // ---- consent and reasons ----
    {
        const QSignalBlocker block(consent);
        consent->setChecked(session.uiConsent());
    }
    if (s.notReadyReasons.empty())
    {
        reasons->setText(connected ? tr("Everything is ready.") : QString());
    }
    else
    {
        QStringList list;
        for (const auto& r : s.notReadyReasons)
        {
            list << qs(r);
        }
        reasons->setText(tr("Not ready yet: %1.").arg(list.join(QStringLiteral("; "))));
    }
    reasons->setVisible(!reasons->text().isEmpty());
    error->setVisible(!s.lastError.empty());
    error->setText(qs(s.lastError));
}

