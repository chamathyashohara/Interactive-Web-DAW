#include "theme.hpp"

#include <QApplication>
#include <QColor>
#include <QLabel>
#include <QPalette>
#include <QStyle>
#include <QStyleFactory>

namespace rr::ui {

void apply_theme(QApplication& app) {
    // Fusion honours the palette on every platform and draws a proper tick in a check box; the
    // native Windows style would keep its own dark-mode colours.
    if (QStyle* fusion = QStyleFactory::create(QStringLiteral("Fusion")); fusion != nullptr) {
        app.setStyle(fusion);
    }
    const QColor text(0x1b, 0x1d, 0x2a);
    const QColor muted(0x8a, 0x8e, 0xa3);
    const QColor accent(0x6c, 0x4c, 0xf1);
    QPalette p;
    p.setColor(QPalette::Window, QColor(0xf4, 0xf5, 0xfb));
    p.setColor(QPalette::WindowText, text);
    p.setColor(QPalette::Base, QColor(0xff, 0xff, 0xff));
    p.setColor(QPalette::AlternateBase, QColor(0xf7, 0xf8, 0xfd));
    p.setColor(QPalette::Text, text);
    p.setColor(QPalette::PlaceholderText, muted);
    p.setColor(QPalette::Button, QColor(0xff, 0xff, 0xff));
    p.setColor(QPalette::ButtonText, text);
    p.setColor(QPalette::ToolTipBase, text);
    p.setColor(QPalette::ToolTipText, QColor(0xff, 0xff, 0xff));
    p.setColor(QPalette::Highlight, accent);
    p.setColor(QPalette::HighlightedText, QColor(0xff, 0xff, 0xff));
    p.setColor(QPalette::Link, QColor(0x4b, 0x3a, 0xd0));
    p.setColor(QPalette::Disabled, QPalette::Text, muted);
    p.setColor(QPalette::Disabled, QPalette::WindowText, muted);
    p.setColor(QPalette::Disabled, QPalette::ButtonText, muted);
    app.setPalette(p);
    app.setStyleSheet(theme_style_sheet());
}

QString theme_style_sheet() {
    // Light, high-contrast, rounded cards. Fixed colours: the apps must look the same on a PC in
    // dark mode, because screenshots go into the test reports.
    return QStringLiteral(R"QSS(
QMainWindow, QDialog { background: #f4f5fb; }
QWidget#pageSimple, QWidget#pageAdvanced, QWidget#pageDiagnostics { background: #f4f5fb; }
QScrollArea { background: #f4f5fb; border: none; }
QTabWidget::pane { background: #f4f5fb; }
QLabel { color: #1b1d2a; background: transparent; }
QToolTip {
    background: #1b1d2a;
    color: #ffffff;
    border: none;
    padding: 6px 8px;
}

/* ---- cards ---- */
QFrame#card {
    background: #ffffff;
    border: 1px solid #e4e6f0;
    border-radius: 14px;
}
QFrame#cardMuted {
    background: #fbfbfe;
    border: 1px dashed #d9dcea;
    border-radius: 14px;
}
QFrame#hero {
    background: #ffffff;
    border: 1px solid #e4e6f0;
    border-radius: 16px;
}

QGroupBox {
    background: #ffffff;
    border: 1px solid #e4e6f0;
    border-radius: 12px;
    margin-top: 14px;
    padding: 14px 12px 12px 12px;
    font-weight: 600;
}
QGroupBox::title {
    subcontrol-origin: margin;
    left: 14px;
    top: 2px;
    padding: 0 6px;
    color: #4a4e63;
}

/* ---- text ---- */
QLabel#h1 { font-size: 20pt; font-weight: 700; }
QLabel#h2 { font-size: 13pt; font-weight: 600; }
QLabel#muted { color: #6b6f85; }
QLabel#tiny { color: #8a8ea3; font-size: 9pt; }
QLabel#notice {
    background: #fff7e6;
    border: 1px solid #f0dcb4;
    border-radius: 10px;
    padding: 8px 10px;
    color: #6b4e14;
}
QLabel#errorText { color: #b3261e; font-weight: 600; }
QLabel#code {
    font-family: "Consolas", monospace;
    font-size: 22pt;
    font-weight: 700;
    letter-spacing: 4px;
    color: #3b2bb5;
    background: #f1efff;
    border: 1px solid #ddd7ff;
    border-radius: 10px;
    padding: 6px 14px;
}
QLabel#value { font-family: "Consolas", monospace; font-weight: 600; }

/* ---- step badges ---- */
QLabel#stepOn, QLabel#stepOff, QLabel#stepDone {
    min-width: 26px; max-width: 26px; min-height: 26px; max-height: 26px;
    border-radius: 13px;
    font-weight: 700;
    qproperty-alignment: AlignCenter;
}
QLabel#stepOn   { background: #6c4cf1; color: #ffffff; }
QLabel#stepDone { background: #0f8a4d; color: #ffffff; }
QLabel#stepOff  { background: #e6e8f2; color: #8a8ea3; }

/* ---- status pills (always with a word and a symbol too) ---- */
QLabel#pillIdle, QLabel#pillBusy, QLabel#pillGood, QLabel#pillWarn, QLabel#pillBad, QLabel#pillRec {
    border-radius: 11px;
    padding: 4px 12px;
    font-weight: 600;
}
QLabel#pillIdle { background: #eceef6; color: #4a4e63; }
QLabel#pillBusy { background: #e8f0ff; color: #1b4fcb; }
QLabel#pillGood { background: #e4f6ec; color: #0b6b3b; }
QLabel#pillWarn { background: #fff4e0; color: #8a5a00; }
QLabel#pillBad  { background: #fdeceb; color: #9f1d16; }
QLabel#pillRec  { background: #c62828; color: #ffffff; }

/* ---- buttons ---- */
QPushButton {
    background: #ffffff;
    border: 1px solid #d7dae8;
    border-radius: 10px;
    padding: 7px 14px;
    min-height: 20px;
    color: #1b1d2a;
}
QPushButton:hover   { background: #f3f4fb; border-color: #c3c7dd; }
QPushButton:pressed { background: #e9ebf6; }
QPushButton:disabled { color: #a7abbd; background: #f3f4f8; border-color: #e3e5ef; }
QPushButton:focus { border: 2px solid #6c4cf1; }

QPushButton#primary {
    background: #6c4cf1; color: #ffffff; border: none; font-weight: 600;
    padding: 10px 20px; min-height: 24px;
}
QPushButton#primary:hover   { background: #5a3ce0; }
QPushButton#primary:pressed { background: #4c31c9; }
QPushButton#primary:disabled { background: #d5d3ea; color: #ffffff; }

QPushButton#record {
    background: #c62828; color: #ffffff; border: none; font-weight: 700;
    padding: 12px 24px; font-size: 12pt; min-height: 28px;
}
QPushButton#record:hover   { background: #ad1f1f; }
QPushButton#record:disabled { background: #e6c9c9; color: #ffffff; }

QPushButton#stop {
    background: #1b1d2a; color: #ffffff; border: none; font-weight: 700;
    padding: 12px 24px; font-size: 12pt; min-height: 28px;
}
QPushButton#stop:hover { background: #33364a; }
QPushButton#stop:disabled { background: #d2d4de; color: #ffffff; }

QPushButton#link {
    background: transparent; border: none; color: #4b3ad0;
    text-decoration: underline; padding: 2px 4px; min-height: 0;
}
QPushButton#link:hover { color: #2f22a0; }

/* ---- inputs ---- */
QLineEdit, QSpinBox, QComboBox, QPlainTextEdit, QListWidget {
    background: #ffffff;
    border: 1px solid #d7dae8;
    border-radius: 10px;
    padding: 7px 10px;
    selection-background-color: #6c4cf1;
    selection-color: #ffffff;
}
QLineEdit:focus, QSpinBox:focus, QComboBox:focus, QPlainTextEdit:focus {
    border: 2px solid #6c4cf1;
    padding: 6px 9px;
}
QLineEdit:disabled, QSpinBox:disabled, QComboBox:disabled {
    background: #f3f4f8; color: #a7abbd;
}
QLineEdit#bigEntry {
    font-family: "Consolas", monospace;
    font-size: 15pt;
    letter-spacing: 2px;
    padding: 10px 12px;
}
QComboBox::drop-down { border: none; width: 22px; }
QComboBox QAbstractItemView {
    background: #ffffff; border: 1px solid #d7dae8; selection-background-color: #ece9ff;
    selection-color: #1b1d2a; outline: none;
}

/* The indicator is drawn from shipped images. A style-sheet indicator WITHOUT an image is a
   blank square with no tick, and a consent box must be unmistakable. */
QCheckBox { spacing: 9px; }
QCheckBox::indicator { width: 18px; height: 18px; }
QCheckBox::indicator:unchecked { image: url(:/rr/check_off.svg); }
QCheckBox::indicator:checked   { image: url(:/rr/check_on.svg); }
QCheckBox::indicator:disabled  { image: url(:/rr/check_off_disabled.svg); }

/* ---- meters ---- */
QProgressBar {
    background: #eceef6; border: none; border-radius: 7px;
    max-height: 14px; min-height: 14px; text-align: center;
    color: #4a4e63; font-size: 8pt;
}
QProgressBar::chunk { background: #6c4cf1; border-radius: 7px; }

/* ---- tabs ---- */
QTabWidget::pane { border: none; top: -1px; background: #f4f5fb; }
QTabBar::tab {
    background: transparent;
    color: #5f6377;
    padding: 9px 18px;
    margin-right: 6px;
    border: 1px solid transparent;
    border-radius: 10px;
    font-weight: 600;
}
QTabBar::tab:hover { background: #eceef6; }
QTabBar::tab:selected { background: #ffffff; color: #3b2bb5; border-color: #e4e6f0; }

/* ---- misc ---- */
QMenuBar { background: #f4f5fb; }
QMenuBar::item:selected { background: #e6e8f2; border-radius: 6px; }
QMenu { background: #ffffff; border: 1px solid #e4e6f0; padding: 6px; }
QMenu::item { padding: 6px 22px; border-radius: 6px; }
QMenu::item:selected { background: #ece9ff; }
QScrollBar:vertical { background: transparent; width: 12px; margin: 2px; }
QScrollBar::handle:vertical { background: #ccd0e0; border-radius: 5px; min-height: 30px; }
QScrollBar::handle:vertical:hover { background: #b4b9ce; }
QScrollBar::add-line, QScrollBar::sub-line { height: 0; width: 0; }
QScrollBar:horizontal { background: transparent; height: 12px; margin: 2px; }
QScrollBar::handle:horizontal { background: #ccd0e0; border-radius: 5px; min-width: 30px; }
)QSS");
}

void set_pill(QLabel* label, Pill kind, const QString& text) {
    if (label == nullptr) {
        return;
    }
    const char* name = "pillIdle";
    QString symbol = QStringLiteral("- ");
    switch (kind) {
        case Pill::Idle: name = "pillIdle"; symbol = QStringLiteral("- "); break;
        case Pill::Busy: name = "pillBusy"; symbol = QStringLiteral("... "); break;
        case Pill::Good: name = "pillGood"; symbol = QStringLiteral("OK  "); break;
        case Pill::Warn: name = "pillWarn"; symbol = QStringLiteral("!  "); break;
        case Pill::Bad: name = "pillBad"; symbol = QStringLiteral("X  "); break;
        case Pill::Recording: name = "pillRec"; symbol = QStringLiteral("REC  "); break;
    }
    if (label->objectName() != QLatin1String(name)) {
        label->setObjectName(QString::fromLatin1(name));
        // Re-apply the style sheet rules for the new object name.
        label->style()->unpolish(label);
        label->style()->polish(label);
    }
    label->setText(symbol + text);
}

QString step_symbol(bool done, bool enabled) {
    if (done) {
        return QStringLiteral("OK");
    }
    return enabled ? QStringLiteral(">") : QStringLiteral("-");
}

}  // namespace rr::ui
