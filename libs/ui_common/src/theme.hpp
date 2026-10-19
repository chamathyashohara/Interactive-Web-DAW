#pragma once

// Stage 10: one visual language for both apps (ADR-021).
//
// A single application-wide style sheet, so every panel looks the same without each widget
// styling itself. Colours are fixed (not taken from the system theme) so that a screenshot in a
// test report always looks the same, and so the contrast of the status colours is known.
//
// Status is NEVER shown by colour alone: every pill carries a word and a symbol as well.

#include <QString>

class QLabel;
class QWidget;

namespace rr::ui {

// The whole style sheet. Applied once to the QApplication.
QString theme_style_sheet();

// Status pill kinds. The object name decides the colours; the caller always supplies text too.
enum class Pill { Idle, Busy, Good, Warn, Bad, Recording };

// Sets `label` to a status pill: a symbol, a word and the detail, e.g. "[REC] RECORDING - take 2".
// Never colour alone (Stage 10 brief).
void set_pill(QLabel* label, Pill kind, const QString& text);

// Marks a step card as done / current / waiting. Returns the symbol used, for the step badge.
QString step_symbol(bool done, bool enabled);

}  // namespace rr::ui
