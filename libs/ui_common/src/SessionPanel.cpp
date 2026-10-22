#include "SessionPanel.h"

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

#include "AudioPanel.h"
#include "rr/network/Socket.h"
#include "rr/shared/BuildInfo.h"
#include "rr/shared/Clock.h"

namespace
{

QString qs(const std::string& s)
{
    return QString::fromStdString(s);
}

QString qs(std::string_view s)
{
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

QString yesWaiting(bool done, bool expected)
{
    if (done)
    {
        return QStringLiteral("<b>yes</b>");
    }
    return expected ? QStringLiteral("<i>waiting</i>") : QStringLiteral("-");
}

}  // namespace

SessionPanel::SessionPanel(Role role, const AppConfig& config, AudioPanel& audio, Logger& logger,
                           QWidget* parent)
    : QWidget(parent), role(role), config(config), audio(&audio), logger(logger) {
    std::string error;
    initSockets(error);

    auto* outer = new QVBoxLayout(this);
    outer->setContentsMargins(0, 0, 0, 0);
    auto* box = new QGroupBox(this->role == Role::Producer ? tr("Session (producer)") : tr("Session (performer)"));
    outer->addWidget(box);
    auto* layout = new QVBoxLayout(box);

    auto* lan = new QLabel(QString::fromUtf8(kLanNotice));
    lan->setWordWrap(true);
    lan->setObjectName(QStringLiteral("lanNotice"));
    layout->addWidget(lan);

    if (this->role == Role::Producer)
    {
        buildProducerUi(layout);
    }
    else
    {
        buildPerformerUi(layout);
    }

    stateLabel = new QLabel;
    QFont stateFont = stateLabel->font();
    stateFont.setBold(true);
    stateFont.setPointSize(stateFont.pointSize() + 2);
    stateLabel->setFont(stateFont);
    stateLabel->setWordWrap(true);
    layout->addWidget(stateLabel);
    reasonsLabel = new QLabel;
    reasonsLabel->setWordWrap(true);
    layout->addWidget(reasonsLabel);
    checksLabel = new QLabel;
    checksLabel->setTextFormat(Qt::RichText);
    checksLabel->setWordWrap(true);
    layout->addWidget(checksLabel);
    pcsLabel = new QLabel;
    pcsLabel->setTextFormat(Qt::RichText);
    pcsLabel->setWordWrap(true);
    layout->addWidget(pcsLabel);

    // Stage 11: verified copies of the performer's takes (the originals never leave the performer's PC).
    auto* copiesBox = new QGroupBox(tr("Take copies: performer's original WAV -> verified copy on the producer's PC"));
    auto* copiesLayout = new QVBoxLayout(copiesBox);
    if (this->role == Role::Producer)
    {
        auto* copyRow = new QHBoxLayout;
        copyButton = new QPushButton(tr("Get verified copy of the performer's last take"));
        copyButton->setToolTip(tr("Asks the performer's app to send a copy of its finalised take. The copy is "
                                    "marked VERIFIED only after its SHA-256 matches and the WAV checks pass. "
                                    "Record is unavailable while a copy is being received."));
        cancelCopyButton = new QPushButton(tr("Cancel copy"));
        autoCopyCheck = new QCheckBox(tr("Automatically after each take"));
        autoCopyCheck->setChecked(QSettings().value(QStringLiteral("session/auto_copy"), false).toBool());
        copyRow->addWidget(copyButton);
        copyRow->addWidget(cancelCopyButton);
        copyRow->addWidget(autoCopyCheck);
        copyRow->addStretch(1);
        copiesLayout->addLayout(copyRow);
        connect(copyButton, &QPushButton::clicked, this, &SessionPanel::requestCopy);
        connect(cancelCopyButton, &QPushButton::clicked, this, &SessionPanel::cancelCopy);
        connect(autoCopyCheck, &QCheckBox::toggled, this, [this](bool on)
        {
            QSettings().setValue(QStringLiteral("session/auto_copy"), on);
            if (controller)
            {
                controller->setAutoTransfer(on);
            }
        });
    }
    else
    {
        deliveryCheck = new QCheckBox(tr("Allow the producer to receive a verified copy of my takes "
                                           "(my original files stay on this PC and are never changed)"));
        copiesLayout->addWidget(deliveryCheck);
        connect(deliveryCheck, &QCheckBox::toggled, this, [this](bool on)
        {
            if (controller)
            {
                controller->setDeliveryConsent(on);
            }
        });
    }
    transfersLabel = new QLabel;
    transfersLabel->setTextFormat(Qt::RichText);
    transfersLabel->setWordWrap(true);
    transfersLabel->setTextInteractionFlags(Qt::TextSelectableByMouse);
    copiesLayout->addWidget(transfersLabel);
    layout->addWidget(copiesBox);
    errorLabel = new QLabel;
    errorLabel->setWordWrap(true);
    errorLabel->setStyleSheet(QStringLiteral("color: #b00020;"));
    layout->addWidget(errorLabel);

    consentCheck = new QCheckBox(this->role == Role::Producer
                                       ? tr("I consent to this session being recorded")
                                       : tr("I agree to be recorded in this session and am ready (consent = arm)"));
    layout->addWidget(consentCheck);
    connect(consentCheck, &QCheckBox::toggled, this, [this](bool on)
    {
        if (controller)
        {
            controller->setConsent(on);
        }
    });

    statsLabel = new QLabel;
    statsLabel->setWordWrap(true);
    layout->addWidget(statsLabel);

    auto* historyBox = new QGroupBox(tr("Session log (this PC)"));
    auto* historyLayout = new QVBoxLayout(historyBox);
    historyView = new QPlainTextEdit;
    historyView->setReadOnly(true);
    historyView->setMaximumBlockCount(500);
    historyView->setFont(QFontDatabase::systemFont(QFontDatabase::FixedFont));
    historyView->setMinimumHeight(120);
    historyLayout->addWidget(historyView);
    layout->addWidget(historyBox);

    timer = new QTimer(this);
    timer->setInterval(50);
    connect(timer, &QTimer::timeout, this, &SessionPanel::tick);
    timer->start();
    tick();
}

SessionPanel::~SessionPanel()
{
    shutDown();
}

// ---------------------------------------------------------------------------------------------
void SessionPanel::buildProducerUi(QVBoxLayout* layout)
{
    auto* form = new QFormLayout;
    auto* ifaceRow = new QHBoxLayout;
    interfaceCombo = new QComboBox;
    interfaceCombo->setToolTip(tr("The network interface the session listens on. Choose the adapter of the "
                                    "private LAN the performer is on. Loopback is for tests on one PC."));
    interfacesButton = new QPushButton(tr("Refresh"));
    ifaceRow->addWidget(interfaceCombo, 1);
    ifaceRow->addWidget(interfacesButton);
    form->addRow(tr("Listen on:"), ifaceRow);
    portSpin = new QSpinBox;
    portSpin->setRange(1024, 65535);
    portSpin->setValue(QSettings().value(QString::fromLatin1(kSettingsPort), static_cast<int>(config.network.controlTcpPort)).toInt());
    form->addRow(tr("TCP port:"), portSpin);
    leadSpin = new QSpinBox;
    leadSpin->setRange(300, 10000);
    leadSpin->setSingleStep(100);
    leadSpin->setSuffix(tr(" ms"));
    leadSpin->setValue(QSettings().value(QStringLiteral("session/start_lead_ms"),
                                           static_cast<int>(config.timing.startLeadMs)).toInt());
    leadSpin->setToolTip(tr("How far ahead both PCs are told the start time. It must cover the network round "
                              "trip, the clock-offset uncertainty and both apps' processing; Record is refused if "
                              "it is below the minimum measured for this link."));
    // Stage 12: on by default, so the same build works on a cabled LAN and on Wi-Fi without the
    // user having to understand what a scheduling lead is.
    autoLeadCheck = new QCheckBox(tr("Choose automatically for this link"));
    autoLeadCheck->setChecked(
        QSettings().value(QStringLiteral("session/auto_start_lead"), config.timing.autoStartLead).toBool());
    autoLeadCheck->setToolTip(tr("The producer measures the round trip and the clock-offset uncertainty and "
                                    "raises the lead to suit them, never below the value set here. Turn it off "
                                    "to pin the lead by hand, for example to repeat a timing experiment."));
    auto* leadRow = new QHBoxLayout;
    leadRow->addWidget(leadSpin);
    leadRow->addWidget(autoLeadCheck);
    leadRow->addStretch(1);
    form->addRow(tr("Start lead:"), leadRow);
    leadHint = new QLabel(QStringLiteral("-"));
    leadHint->setObjectName(QStringLiteral("tiny"));
    leadHint->setWordWrap(true);
    form->addRow(QString(), leadHint);
    connect(leadSpin, qOverload<int>(&QSpinBox::valueChanged), this, [this](int v)
    {
        QSettings().setValue(QStringLiteral("session/start_lead_ms"), v);
        if (controller)
        {
            controller->setStartLeadMs(static_cast<uint32_t>(v));
        }
    });
    connect(autoLeadCheck, &QCheckBox::toggled, this, [this](bool on)
    {
        QSettings().setValue(QStringLiteral("session/auto_start_lead"), on);
        if (controller)
        {
            controller->setAutoStartLead(on);
        }
    });
    layout->addLayout(form);

    auto* row = new QHBoxLayout;
    createButton = new QPushButton(tr("Create session"));
    newCodeButton = new QPushButton(tr("New pairing code"));
    row->addWidget(createButton);
    row->addWidget(newCodeButton);
    row->addStretch(1);
    layout->addLayout(row);

    auto* info = new QFormLayout;
    sessionIdLabel = new QLabel(QStringLiteral("-"));
    sessionIdLabel->setTextInteractionFlags(Qt::TextSelectableByMouse);
    codeLabel = new QLabel(QStringLiteral("-"));
    QFont codeFont = QFontDatabase::systemFont(QFontDatabase::FixedFont);
    codeFont.setPointSize(codeFont.pointSize() + 10);
    codeFont.setBold(true);
    codeLabel->setFont(codeFont);
    codeLabel->setTextInteractionFlags(Qt::TextSelectableByMouse);
    codeLabel->setToolTip(tr("Tell the performer this code. It works once, expires after 10 minutes and is "
                               "locked after 5 wrong attempts. It is never written to the log."));
    addressLabel = new QLabel(QStringLiteral("-"));
    addressLabel->setTextInteractionFlags(Qt::TextSelectableByMouse);
    addressLabel->setWordWrap(true);
    info->addRow(tr("Session ID:"), sessionIdLabel);
    info->addRow(tr("Pairing code:"), codeLabel);
    info->addRow(tr("Performer joins:"), addressLabel);
    layout->addLayout(info);

    auto* firewall = new QLabel(QString::fromUtf8(kFirewallNotice));
    firewall->setWordWrap(true);
    layout->addWidget(firewall);

    auto* takeRow = new QHBoxLayout;
    recordButton = new QPushButton(tr("Record (both)"));
    stopButton = new QPushButton(tr("Stop (both)"));
    QFont big = recordButton->font();
    big.setBold(true);
    big.setPointSize(big.pointSize() + 2);
    recordButton->setFont(big);
    stopButton->setFont(big);
    takeRow->addWidget(recordButton);
    takeRow->addWidget(stopButton);
    takeRow->addStretch(1);
    layout->addLayout(takeRow);

    confirmationsLabel = new QLabel;
    confirmationsLabel->setTextFormat(Qt::RichText);
    confirmationsLabel->setWordWrap(true);
    layout->addWidget(confirmationsLabel);

    connect(interfacesButton, &QPushButton::clicked, this, &SessionPanel::refreshInterfaces);
    connect(createButton, &QPushButton::clicked, this, &SessionPanel::createOrEndSession);
    connect(newCodeButton, &QPushButton::clicked, this, [this] {
        if (controller)
        {
            controller->newPairingCode();
        }
    });
    connect(recordButton, &QPushButton::clicked, this, &SessionPanel::record);
    connect(stopButton, &QPushButton::clicked, this, &SessionPanel::stop);
    refreshInterfaces();
}

void SessionPanel::buildPerformerUi(QVBoxLayout* layout)
{
    auto* form = new QFormLayout;
    hostEdit = new QLineEdit(QSettings().value(QString::fromLatin1(kSettingsHost)).toString());
    hostEdit->setPlaceholderText(tr("producer's IPv4 address, e.g. 192.168.1.20"));
    portSpin = new QSpinBox;
    portSpin->setRange(1024, 65535);
    portSpin->setValue(QSettings().value(QString::fromLatin1(kSettingsPort), static_cast<int>(config.network.controlTcpPort)).toInt());
    codeEdit = new QLineEdit;
    codeEdit->setPlaceholderText(tr("6 digits from the producer"));
    codeEdit->setMaxLength(6);
    codeEdit->setValidator(new QRegularExpressionValidator(QRegularExpression(QStringLiteral("[0-9]{0,6}")), codeEdit));
    form->addRow(tr("Producer address:"), hostEdit);
    form->addRow(tr("TCP port:"), portSpin);
    form->addRow(tr("Pairing code:"), codeEdit);
    layout->addLayout(form);

    auto* row = new QHBoxLayout;
    joinButton = new QPushButton(tr("Join"));
    stopSaveButton = new QPushButton(tr("Stop && save my recording"));
    stopSaveButton->setToolTip(tr("Stops and saves this PC's recording now. The producer is told, but its own "
                                     "recording continues."));
    row->addWidget(joinButton);
    row->addWidget(stopSaveButton);
    row->addStretch(1);
    layout->addLayout(row);

    auto* note = new QLabel(tr("Only the producer starts and stops session takes (SES-08). This PC records its own "
                               "microphone locally at full quality; the recording does not depend on the network."));
    note->setWordWrap(true);
    layout->addWidget(note);
    controllerLabel = new QLabel;
    controllerLabel->setWordWrap(true);
    layout->addWidget(controllerLabel);
    takeLabel = new QLabel;
    takeLabel->setWordWrap(true);
    QFont takeFont = takeLabel->font();
    takeFont.setBold(true);
    takeFont.setPointSize(takeFont.pointSize() + 4);
    takeLabel->setFont(takeFont);
    layout->addWidget(takeLabel);

    connect(joinButton, &QPushButton::clicked, this, &SessionPanel::joinOrLeave);
    connect(stopSaveButton, &QPushButton::clicked, this, &SessionPanel::stopAndSave);
}

void SessionPanel::refreshInterfaces()
{
    const QString previous = interfaceCombo->currentData().toString().isEmpty()
                                 ? QSettings().value(QString::fromLatin1(kSettingsBind)).toString()
                                 : interfaceCombo->currentData().toString();
    interfaceCombo->clear();
    int select = -1;
    int bestRank = -1;
    for (const auto& i : listIpv4Interfaces())
    {
        // 169.254.x.x is link-local: the adapter never got an address, so no other PC can reach
        // it. It stays in the list but is never chosen over a real private address.
        const bool linkLocal = i.address.rfind("169.254.", 0) == 0;
        QString label = qs(i.address) + QStringLiteral("  -  ") + qs(i.name);
        if (i.loopback)
        {
            label += tr("  (loopback: this PC only, for tests)");
        }
        else if (linkLocal)
        {
            label += tr("  (no network address: the other PC cannot reach this)");
        }
        else if (i.privateLan)
        {
            label += tr("  (private LAN)");
        }
        else
        {
            label += tr("  (NOT a private address: not recommended)");
        }
        interfaceCombo->addItem(label, qs(i.address));
        const int index = interfaceCombo->count() - 1;
        const int rank = i.loopback ? 1 : (linkLocal ? 2 : (i.privateLan ? 4 : 3));
        if (qs(i.address) == previous)
        {
            select = index;
            bestRank = 99;
        }
        else if (rank > bestRank)
        {
            select = index;
            bestRank = rank;
        }
    }
    if (select >= 0)
    {
        interfaceCombo->setCurrentIndex(select);
    }
    if (interfaceCombo->count() == 0)
    {
        showError(tr("No IPv4 network interface found."));
    }
}

// ---------------------------------------------------------------------------------------------
void SessionPanel::ensureController()
{
    if (controller && controller->sessionActive())
    {
        return;
    }
    // A fresh controller + port per session: picks up the current recordings folder.
    controller.reset();
    port = std::make_unique<AudioRecorderPort>(audio->getEngine(), audio->recordingsRoot(), config);
    ControllerConfig c;
    c.role = role;
    c.timing = config.timing;
    c.appVersion = buildInfo().version;
    c.displayName = std::string(roleDisplayName(role)) + " (" + QSysInfo::machineHostName().toStdString() + ")";
    controller = std::make_unique<SessionController>(c, *port, logger);
    controller->setConsent(consentCheck->isChecked());
    if (leadSpin != nullptr)
    {
        controller->setStartLeadMs(static_cast<uint32_t>(leadSpin->value()));
    }
    if (autoLeadCheck != nullptr)
    {
        controller->setAutoStartLead(autoLeadCheck->isChecked());
    }
    if (autoCopyCheck != nullptr)
    {
        controller->setAutoTransfer(autoCopyCheck->isChecked());
    }
    if (deliveryCheck != nullptr)
    {
        controller->setDeliveryConsent(deliveryCheck->isChecked());
    }
    shownHistory = 0;
    shownHistoryLast.clear();
    historyView->clear();
}

void SessionPanel::setSessionControl(bool active)
{
    if (active == sessionControl)
    {
        return;
    }
    sessionControl = active;
    if (!audio)
    {
        return;
    }
    audio->setSessionControl(active, [this] {
        if (controller)
        {
            controller->poll();
        }
    });
}

void SessionPanel::createOrEndSession()
{
    if (controller && controller->sessionActive() && controller->snapshot().link != LinkState::Disconnected)
    {
        controller->leave();  // refused (with a message) while a take is running
        return;
    }
    const QString bind = interfaceCombo->currentData().toString();
    if (bind.isEmpty())
    {
        showError(tr("Choose the network interface to listen on."));
        return;
    }
    ensureController();
    std::string error;
    setSessionControl(true);
    if (!controller->createSession(bind.toStdString(), static_cast<uint16_t>(portSpin->value()), error))
    {
        setSessionControl(false);
        showError(tr("The session could not be created: %1").arg(qs(error)));
        return;
    }
    QSettings().setValue(QString::fromLatin1(kSettingsBind), bind);
    QSettings().setValue(QString::fromLatin1(kSettingsPort), portSpin->value());
    errorLabel->clear();
}

void SessionPanel::joinOrLeave()
{
    if (controller && controller->sessionActive() && controller->snapshot().link != LinkState::Disconnected)
    {
        controller->leave();
        return;
    }
    const std::string host = hostEdit->text().trimmed().toStdString();
    const std::string code = codeEdit->text().trimmed().toStdString();
    if (!isValidIpv4(host))
    {
        showError(tr("Enter the producer's IPv4 address (four numbers, e.g. 192.168.1.20)."));
        return;
    }
    if (code.size() != 6)
    {
        showError(tr("Enter the 6-digit pairing code shown on the producer's screen."));
        return;
    }
    ensureController();
    std::string error;
    setSessionControl(true);
    if (!controller->join(host, static_cast<uint16_t>(portSpin->value()), code, error))
    {
        setSessionControl(false);
        showError(tr("Could not join: %1").arg(qs(error)));
        return;
    }
    QSettings().setValue(QString::fromLatin1(kSettingsHost), hostEdit->text().trimmed());
    QSettings().setValue(QString::fromLatin1(kSettingsPort), portSpin->value());
    codeEdit->clear();  // single use
    errorLabel->clear();
}

void SessionPanel::record()
{
    std::string error;
    if (!controller || !controller->startTake(error))
    {
        showError(tr("Recording not started: %1").arg(qs(error.empty() ? std::string("no session") : error)));
    }
}

void SessionPanel::stop()
{
    std::string error;
    if (!controller || !controller->stopTake(error))
    {
        showError(tr("Stop: %1").arg(qs(error.empty() ? std::string("no session") : error)));
    }
}

void SessionPanel::stopAndSave()
{
    if (!controller)
    {
        return;
    }
    const auto answer = QMessageBox::question(
        this, tr("Stop and save"),
        tr("Stop and save the recording on this PC now? The producer is told, but the producer's own recording "
           "continues until the producer presses Stop."),
        QMessageBox::Yes | QMessageBox::No, QMessageBox::No);
    if (answer != QMessageBox::Yes)
    {
        return;
    }
    std::string error;
    if (!controller->stopAndSave(error))
    {
        showError(qs(error));
    }
}

void SessionPanel::requestCopy()
{
    if (!controller)
    {
        return;
    }
    const auto s = controller->snapshot();
    std::string error;
    if (!controller->requestTransfer(s.take.takeId, error))
    {
        showError(tr("Copy not requested: %1").arg(qs(error)));
    }
}

void SessionPanel::cancelCopy()
{
    if (!controller)
    {
        return;
    }
    for (const auto& v : controller->snapshot().transfers)
    {
        if (!transferStateFinal(v.state))
        {
            const auto answer = QMessageBox::question(
                this, tr("Cancel copy"),
                tr("Stop receiving the copy of take %1? What has arrived is kept and a new request continues from "
                   "there. The performer's original is not affected.").arg(v.takeId),
                QMessageBox::Yes | QMessageBox::No, QMessageBox::No);
            if (answer == QMessageBox::Yes)
            {
                controller->cancelTransfer(v.takeId);
            }
            return;
        }
    }
}

void SessionPanel::showError(const QString& text)
{
    errorLabel->setText(text);
}

// ---------------------------------------------------------------------------------------------
void SessionPanel::tick()
{
    if (!audio)
    {
        return;
    }
    ControllerSnapshot s;
    if (controller)
    {
        controller->poll();
        s = controller->snapshot();
    }
    else
    {
        s.role = role;
        const SessionSnapshot initial = initialSnapshot(role);
        s.notReadyReasons = initial.notReadyReasons;
    }
    // The AudioPanel's recorder belongs to the session while it is connected or a take runs.
    const bool active = controller && controller->sessionActive() &&
                        (s.link != LinkState::Disconnected || isTakeActive(s.session) ||
                         s.session == SessionState::Recording);
    setSessionControl(active);
    render(s);
    emit statusChanged();
}

void SessionPanel::render(const ControllerSnapshot& s)
{
    const bool live = controller && controller->sessionActive() && s.link != LinkState::Disconnected;
    const bool takeRunning = s.session == SessionState::Recording || isTakeActive(s.session) ||
                              s.session == SessionState::Armed;

    stateLabel->setText(tr("Connection: %1    Session: %2")
                              .arg(qs(linkStateLabel(s.link)), qs(sessionStateName(s.session))));
    QString reasons;
    if (s.session == SessionState::NotReady && !s.notReadyReasons.empty())
    {
        QStringList list;
        for (const auto& r : s.notReadyReasons)
        {
            list << qs(r);
        }
        reasons = tr("Not ready: %1").arg(list.join(QStringLiteral("; ")));
    }
    if (!s.peerName.empty())
    {
        reasons += (reasons.isEmpty() ? QString() : QStringLiteral("\n")) +
                   tr("Other side: %1 at %2 - ready: %3, consent: %4%5")
                       .arg(qs(s.peerName), qs(s.peerAddress), s.peerReady ? tr("yes") : tr("no"),
                            s.peerConsent ? tr("yes") : tr("no"),
                            s.peerReasons.empty() ? QString() : QStringLiteral(" (") + qs(s.peerReasons) + QLatin1Char(')'));
    }
    reasonsLabel->setText(reasons);
    checksLabel->setText(live ? checksHtml(s) : QString());
    pcsLabel->setText(live && s.take.takeId != 0 ? pcsText(s) : QString());
    transfersLabel->setText(transfersHtml(s));
    if (copyButton != nullptr)
    {
        bool anyActive = false;
        for (const auto& v : s.transfers)
        {
            anyActive = anyActive || !transferStateFinal(v.state);
        }
        QString why;
        if (!live || s.link != LinkState::Connected)
        {
            why = tr("the performer is not connected");
        }
        else if (s.protocolMinor < 2)
        {
            why = tr("the performer's app does not support take copies (control protocol 1.%1)").arg(s.protocolMinor);
        }
        else if (!s.peerDeliveryConsent)
        {
            why = tr("the performer has not allowed copies of its takes");
        }
        else if (s.take.takeId == 0 || !s.take.peerFinalised)
        {
            why = tr("no finalised performer take yet");
        }
        else if (takeRunning)
        {
            why = tr("a take is being recorded");
        }
        else if (anyActive)
        {
            why = tr("a copy is already being received");
        }
        copyButton->setEnabled(why.isEmpty());
        copyButton->setToolTip(why.isEmpty() ? tr("Request a verified copy of take %1").arg(s.take.takeId)
                                               : tr("Not available: %1").arg(why));
        cancelCopyButton->setEnabled(anyActive);
    }
    if (!s.lastError.empty())
    {
        errorLabel->setText(qs(s.lastError));
    }

    if (live || s.linkStats.offsetSamples > 0)
    {
        const auto& ls = s.linkStats;
        statsLabel->setText(
            tr("Control round trip %1 ms | clock offset (other PC - this PC) %2 ms +/- %3 ms from %4 samples | "
               "frames sent %5, received %6 | reconnect attempts %7 | refused %8, duplicates %9")
                .arg(ls.controlRttNs >= 0 ? QString::number(static_cast<double>(ls.controlRttNs) / 1e6, 'f', 2) : QStringLiteral("-"))
                .arg(static_cast<double>(ls.thetaNs) / 1e6, 0, 'f', 3)
                .arg(ls.thetaUncertaintyNs >= 0 ? QString::number(static_cast<double>(ls.thetaUncertaintyNs) / 1e6, 'f', 3)
                                                  : QStringLiteral("?"))
                .arg(ls.offsetSamples)
                .arg(ls.framesSent)
                .arg(ls.framesReceived)
                .arg(ls.reconnectAttempts)
                .arg(s.refusedMessages)
                .arg(s.duplicateMessages));
    }
    else
    {
        statsLabel->clear();
    }

    if (role == Role::Producer)
    {
        createButton->setText(live ? tr("End session") : tr("Create session"));
        createButton->setEnabled(!takeRunning);
        interfaceCombo->setEnabled(!live);
        interfacesButton->setEnabled(!live);
        portSpin->setEnabled(!live);
        newCodeButton->setEnabled(live && s.link != LinkState::Connected);
        sessionIdLabel->setText(live ? qs(s.sessionId) : QStringLiteral("-"));
        codeLabel->setText(live && s.link != LinkState::Connected && !s.pairingCode.empty()
                                 ? qs(s.pairingCode)
                                 : (live ? tr("(used: performer joined)") : QStringLiteral("-")));
        addressLabel->setText(live ? tr("%1  port %2  (enter these on the Performer Client)")
                                           .arg(qs(s.bindAddress))
                                           .arg(s.port)
                                     : QStringLiteral("-"));
        recordButton->setEnabled(s.session == SessionState::Ready);
        const bool beforeStart = s.session == SessionState::Armed || s.session == SessionState::Scheduled;
        stopButton->setEnabled(beforeStart || s.session == SessionState::Recording);
        stopButton->setText(beforeStart ? tr("Cancel take (not started)") : tr("Stop (both)"));
        recordButton->setToolTip(s.session == SessionState::Ready
                                       ? tr("Start lead %1 ms (minimum for this link: %2 ms)")
                                             .arg(s.effectiveStartLeadMs)
                                             .arg(s.minStartLeadMs)
                                       : tr("Not ready: see the checklist"));
        if (leadHint != nullptr)
        {
            const auto& ls = s.linkStats;
            if (!live || ls.controlRttBestNs < 0)
            {
                leadHint->setText(tr("The link has not been measured yet."));
            }
            else
            {
                leadHint->setText(
                    tr("This link: round trip %1 ms (best of the last %2), clock offset +/- %3 ms. "
                       "Minimum lead %4 ms; next take would use %5 ms%6.")
                        .arg(static_cast<double>(ls.controlRttBestNs) / 1e6, 0, 'f', 1)
                        .arg(ls.offsetSamples)
                        .arg(static_cast<double>(ls.thetaUncertaintyNs) / 1e6, 0, 'f', 1)
                        .arg(s.minStartLeadMs)
                        .arg(s.effectiveStartLeadMs)
                        .arg(s.autoStartLead ? tr(" (chosen automatically)") : QString()));
            }
        }
        confirmationsLabel->setText(confirmationsText(s));
    }
    else
    {
        joinButton->setText(live ? tr("Leave") : tr("Join"));
        joinButton->setEnabled(!takeRunning);
        hostEdit->setEnabled(!live);
        portSpin->setEnabled(!live);
        codeEdit->setEnabled(!live);
        stopSaveButton->setEnabled(s.session == SessionState::Recording);
        controllerLabel->setText(live && !s.peerName.empty()
                                       ? tr("Session controlled by: %1 at %2. Only the producer starts and stops takes; "
                                            "your recording starts automatically at the agreed time.")
                                             .arg(qs(s.peerName), qs(s.peerAddress))
                                       : QString());
        const auto& t = s.take;
        QString text;
        if (t.takeId != 0)
        {
            text = tr("Take %1: ").arg(t.takeId);
            if (s.session == SessionState::Armed)
            {
                text += tr("armed by the producer, waiting for the start time");
            }
            else if (s.session == SessionState::Scheduled)
            {
                const int64_t leftMs = (t.startAtLocalNs - monotonicNs()) / 1000000;
                text += tr("SCHEDULED - recording starts in %1 s, at about %2 (this PC's clock)")
                            .arg(static_cast<double>(leftMs) / 1000.0, 0, 'f', 1)
                            .arg(qs(formatUtcIso8601Ms(utcNowMs() + leftMs)));
            }
            else if (s.session == SessionState::Recording)
            {
                text += tr("RECORDING on this PC");
            }
            else if (t.localFinalised)
            {
                text += tr("saved (%1, %2 frames) %3")
                            .arg(qs(takeStatusName(t.localStatus)))
                            .arg(t.localFrames)
                            .arg(qs(t.localFile));
            }
            else if (!t.localStarted)
            {
                text += tr("did not start on this PC");
            }
            else
            {
                text += tr("finishing");
            }
        }
        takeLabel->setText(text);
    }

    // History: append new lines only.
    const std::vector<std::string> history = controller ? controller->takeHistory() : std::vector<std::string>();
    if (!history.empty() && (history.size() != shownHistory || history.back() != shownHistoryLast))
    {
        historyView->clear();
        for (const auto& line : history)
        {
            historyView->appendPlainText(qs(line));
        }
        historyView->verticalScrollBar()->setValue(historyView->verticalScrollBar()->maximum());
        shownHistory = history.size();
        shownHistoryLast = history.back();
    }
}

QString SessionPanel::checksHtml(const ControllerSnapshot& s) const
{
    // Every item, both PCs, passing ones included (Stage 9).
    auto mark = [](const std::vector<ReadinessCheck>& list, ReadyItem item, QString* detail) -> QString
    {
        for (const auto& c : list)
        {
            if (c.item == item)
            {
                if (detail != nullptr)
                {
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
                                 ReadyItem::Connected, ReadyItem::ClockOffset})
                                 {
        QString detail;
        const QString here = mark(s.localChecks, item, &detail);
        const QString there = mark(s.peerChecks, item, nullptr);
        html += QStringLiteral("<tr><td>%1</td><td align='center'>%2</td><td align='center'>%3</td><td>%4</td></tr>")
                    .arg(qs(std::string(readyItemLabel(item))), here, there, detail);
    }
    return html + QStringLiteral("</table>");
}

QString SessionPanel::pcsText(const ControllerSnapshot& s) const
{
    // One row per PC: scheduled / recording / saved. "Recording" only after that PC's own start report.
    const auto& t = s.take;
    auto row = [](const QString& who, const QString& state)
    {
        return QStringLiteral("<b>%1:</b> %2<br>").arg(who, state);
    };
    QString here;
    if (t.cancelled)
    {
        here = tr("take %1 cancelled before the start (nothing recorded)").arg(t.takeId);
    }
    else if (t.localFinalised)
    {
        here = tr("take %1 saved: %2, %3 frames").arg(t.takeId).arg(qs(takeStatusName(t.localStatus))).arg(t.localFrames);
    }
    else if (t.localStarted)
    {
        here = tr("RECORDING take %1").arg(t.takeId);
    }
    else if (t.startAtLocalNs != 0)
    {
        const int64_t leftMs = (t.startAtLocalNs - monotonicNs()) / 1000000;
        here = tr("SCHEDULED take %1, starts in %2 s").arg(t.takeId).arg(static_cast<double>(leftMs) / 1000.0, 0, 'f', 1);
    }
    else
    {
        here = tr("take %1 armed, no start time yet").arg(t.takeId);
    }
    QString out = row(role == Role::Producer ? tr("Producer PC (this PC)") : tr("This PC"), here);
    if (role == Role::Producer)
    {
        QString there;
        if (t.cancelled)
        {
            there = tr("cancelled");
        }
        else if (t.peerFinalised)
        {
            there = tr("saved: %1, %2 frames").arg(qs(takeStatusName(t.peerStatus))).arg(t.peerFrames);
        }
        else if (t.peerReportTimedOut)
        {
            there = tr("<b>UNKNOWN</b> (no report from the performer)");
        }
        else if (t.peerStarted)
        {
            there = tr("RECORDING (confirmed by the performer)");
        }
        else if (t.peerStartAck)
        {
            there = tr("SCHEDULED (start time acknowledged)");
        }
        else if (t.peerArmAck)
        {
            there = tr("armed (acknowledged), start time being agreed");
        }
        else
        {
            there = tr("waiting for the performer's acknowledgement");
        }
        out += row(tr("Performer PC"), there);
        if (t.hasStartOffset)
        {
            out += tr("Estimated recording-start offset (performer - producer): %1 ms +/- %2 ms "
                      "(clock-offset uncertainty only; device input latency not included)")
                       .arg(t.startOffsetMs, 0, 'f', 3)
                       .arg(t.startOffsetUncMs, 0, 'f', 3);
        }
    }
    return out;
}

QString SessionPanel::transfersHtml(const ControllerSnapshot& s) const
{
    // State as words plus a symbol (never colour alone). VERIFIED comes only from the producer's
    // own SHA-256 and WAV checks (ADR-020).
    if (s.transfers.empty())
    {
        return role == Role::Producer ? tr("No copies requested in this session.")
                                       : tr("No copies sent in this session.");
    }
    QString html = QStringLiteral("<table cellspacing='4'><tr><th align='left'>%1</th><th align='left'>%2</th>"
                                  "<th align='left'>%3</th><th align='left'>%4</th></tr>")
                       .arg(tr("Take"), tr("State"), tr("Progress"), tr("Details"));
    for (const auto& v : s.transfers)
    {
        QString state;
        switch (v.state)
        {
            case TransferState::Queued: state = tr("[ ] QUEUED"); break;
            case TransferState::Transferring: state = tr("[>] TRANSFERRING"); break;
            case TransferState::Retrying: state = tr("[||] PAUSED / RETRYING"); break;
            case TransferState::Verifying: state = tr("[?] VERIFYING"); break;
            case TransferState::Verified: state = tr("[OK] VERIFIED COPY"); break;
            case TransferState::Failed: state = tr("[X] FAILED"); break;
        }
        const double pct = v.bytesTotal ? 100.0 * static_cast<double>(v.bytesDone) / static_cast<double>(v.bytesTotal) : 0.0;
        QString progress = tr("%1 % of %2 MB").arg(pct, 0, 'f', 0).arg(static_cast<double>(v.bytesTotal) / 1e6, 0, 'f', 1);
        if (v.resumes > 0)
        {
            progress += tr(", resumed %1x").arg(v.resumes);
        }
        QString details = qs(v.detail).toHtmlEscaped();
        if (role == Role::Producer && v.state == TransferState::Verified)
        {
            details = tr("%1 s, %2 Hz, %3 ch, %4 frames (matches the performer's report: %5)<br>SHA-256 %6<br>%7")
                          .arg(v.durationS, 0, 'f', 3)
                          .arg(v.sampleRate)
                          .arg(v.channels)
                          .arg(static_cast<qulonglong>(v.frames))
                          .arg(qs(v.framesVsReport))
                          .arg(qs(v.sha256Hex))
                          .arg(qs(v.file).toHtmlEscaped());
        }
        if (v.state == TransferState::Failed)
        {
            details += tr("<br>The original is still on the performer's PC.");
        }
        if (role == Role::Performer && !v.sourceShaAfterHex.empty())
        {
            details += v.sourceUnchanged ? tr("<br>Original on this PC: unchanged (SHA-256 checked before and after).")
                                          : tr("<br><b>Original on this PC: CHANGED during sending</b>");
        }
        html += QStringLiteral("<tr><td>%1</td><td><b>%2</b></td><td>%3</td><td>%4</td></tr>")
                    .arg(v.takeId)
                    .arg(state, progress, details);
    }
    return html + QStringLiteral("</table>");
}

QString SessionPanel::confirmationsText(const ControllerSnapshot& s) const
{
    const auto& t = s.take;
    if (t.takeId == 0)
    {
        return tr("<i>No take yet. Record is enabled when both PCs are ready and both people have consented.</i>");
    }
    const bool active = s.session != SessionState::Ready && s.session != SessionState::NotReady;
    QString html = tr("<b>Take %1</b> - performer steps are shown only after the performer's own reply:<br>").arg(t.takeId);
    html += tr("ARM sent: %1 &nbsp; performer ARM_ACK: %2<br>")
                .arg(yesWaiting(t.armSent, false), yesWaiting(t.peerArmAck, t.armSent && active));
    html += tr("start time sent: %1 &nbsp; performer START_ACK: %2<br>")
                .arg(yesWaiting(t.scheduleSent, false), yesWaiting(t.peerStartAck, t.scheduleSent && active));
    html += tr("recording started here: %1 &nbsp; performer CONFIRMED its recording started: %2<br>")
                .arg(yesWaiting(t.localStarted, active), yesWaiting(t.peerStarted, t.peerStartAck && active));
    if (t.hasStartOffset)
    {
        html += tr("estimated start difference (performer - producer): %1 ms +/- %2 ms "
                   "<i>(clock-offset uncertainty only; device input latency not included)</i><br>")
                    .arg(t.startOffsetMs, 0, 'f', 2)
                    .arg(t.startOffsetUncMs, 0, 'f', 2);
    }
    if (t.stopSent || t.peerStopAck || t.localFinalised)
    {
        html += tr("stop sent: %1 &nbsp; performer STOP_ACK: %2<br>")
                    .arg(yesWaiting(t.stopSent, false), yesWaiting(t.peerStopAck, t.stopSent && active));
    }
    if (t.localFinalised)
    {
        html += tr("this PC's take: <b>%1</b>, %2 frames<br>").arg(qs(takeStatusName(t.localStatus))).arg(t.localFrames);
    }
    if (t.peerFinalised)
    {
        html += tr("performer's take: <b>%1</b>, %2 frames (reported by the performer)")
                    .arg(qs(takeStatusName(t.peerStatus)))
                    .arg(t.peerFrames);
    }
    else if (t.peerReportTimedOut)
    {
        html += tr("performer's take: <b>UNKNOWN</b> (no report received)");
    }
    return html;
}

// ---------------------------------------------------------------------------------------------
// ---- Stage 10: hooks for the guided view ----------------------------------------------------
ControllerSnapshot SessionPanel::uiSnapshot() const
{
    if (controller)
    {
        return controller->snapshot();
    }
    ControllerSnapshot s;
    s.role = role;
    const SessionSnapshot initial = initialSnapshot(role);
    s.notReadyReasons = initial.notReadyReasons;
    return s;
}

bool SessionPanel::uiSessionActive() const
{
    return controller && controller->sessionActive();
}

bool SessionPanel::uiConsent() const
{
    return consentCheck != nullptr && consentCheck->isChecked();
}

bool SessionPanel::uiDeliveryConsent() const
{
    return deliveryCheck != nullptr && deliveryCheck->isChecked();
}

bool SessionPanel::uiAutoCopy() const
{
    return autoCopyCheck != nullptr && autoCopyCheck->isChecked();
}

void SessionPanel::uiSetConsent(bool on)
{
    consentCheck->setChecked(on);  // the panel's own signal applies it to the controller
}

void SessionPanel::uiSetDeliveryConsent(bool on)
{
    if (deliveryCheck != nullptr)
    {
        deliveryCheck->setChecked(on);
    }
}

void SessionPanel::uiSetAutoCopy(bool on)
{
    if (autoCopyCheck != nullptr)
    {
        autoCopyCheck->setChecked(on);
    }
}

void SessionPanel::uiSetConnection(const QString& host, const QString& code)
{
    if (hostEdit != nullptr)
    {
        hostEdit->setText(host);
    }
    if (codeEdit != nullptr)
    {
        codeEdit->setText(code);
    }
}

void SessionPanel::uiCreateOrEnd()
{
    createOrEndSession();
}

void SessionPanel::uiNewPairingCode()
{
    if (newCodeButton != nullptr && newCodeButton->isEnabled())
    {
        newCodeButton->click();
    }
}

void SessionPanel::uiJoinOrLeave()
{
    joinOrLeave();
}

void SessionPanel::uiRecord()
{
    record();
}

void SessionPanel::uiStop()
{
    stop();
}

void SessionPanel::uiStopAndSave()
{
    stopAndSave();
}

void SessionPanel::uiRequestCopy()
{
    requestCopy();
}

SessionSnapshot SessionPanel::statusSnapshot() const
{
    if (!controller)
    {
        return initialSnapshot(role);
    }
    const ControllerSnapshot c = controller->snapshot();
    SessionSnapshot s;
    s.role = role;
    s.link = c.link;
    s.session = c.session;
    s.notReadyReasons = c.notReadyReasons;
    return s;
}

bool SessionPanel::takeActive() const
{
    if (!controller)
    {
        return false;
    }
    const SessionState st = controller->snapshot().session;
    return st == SessionState::Recording || isTakeActive(st) || st == SessionState::Armed;
}

void SessionPanel::shutDown()
{
    if (timer)
    {
        timer->stop();
    }
    if (controller)
    {
        controller->shutdown();
        if (audio)
        {
            controller->poll();  // collect a take finalised by the shutdown (the port needs the engine)
        }
    }
    setSessionControl(false);
}

LiveContext SessionPanel::liveContext() const
{
    LiveContext c;
    if (!controller || !controller->sessionActive())
    {
        return c;
    }
    const ControllerSnapshot s = controller->snapshot();
    c.sessionOpen = s.link != LinkState::Disconnected;
    c.connected = s.link == LinkState::Connected;
    c.sessionId = s.sessionId;
    c.localAddress = s.bindAddress;
    c.peerAddress = s.peerAddress;
    c.controlPort = s.port;
    c.linkState = std::string(linkStateName(s.link));
    c.peerName = s.peerName;
    c.controlRttMs = static_cast<double>(s.linkStats.controlRttNs) / 1e6;
    const auto& t = s.take;
    if (t.takeId == 0)
    {
        c.recordingStatus = "idle (no take yet); session " + std::string(sessionStateName(s.session));
    }
    else if (t.localFinalised)
    {
        c.recordingStatus = "take " + std::to_string(t.takeId) + " " + std::string(takeStatusName(t.localStatus)) +
                             ", " + std::to_string(t.localFrames) + " frames";
    }
    else
    {
        c.recordingStatus = std::string(t.localStarted ? "RECORDING take " : "take armed/scheduled: ") +
                             std::to_string(t.takeId);
    }
    return c;
}

QString SessionPanel::diagnosticsText() const
{
    QString out = QStringLiteral("=== Session ===\n");
    if (!controller)
    {
        return out + QStringLiteral("no session created/joined yet\n");
    }
    const ControllerSnapshot s = controller->snapshot();
    out += QStringLiteral("link %1, session %2, session id %3, peer '%4' at %5\n")
               .arg(qs(linkStateName(s.link)), qs(sessionStateName(s.session)),
                    qs(s.sessionId), qs(s.peerName), qs(s.peerAddress));
    out += QStringLiteral("local address %1 port %2, recorder: %3\n")
               .arg(qs(s.bindAddress)).arg(s.port).arg(qs(s.recorderDescription));
    out += QStringLiteral("invalid events %1, refused messages %2, duplicates %3\n")
               .arg(s.invalidEvents).arg(s.refusedMessages).arg(s.duplicateMessages);
    for (const auto& line : controller->takeHistory())
    {
        out += qs(line) + QLatin1Char('\n');
    }
    return out;
}

