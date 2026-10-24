#pragma once

// Stage 10: one visual language for both apps (ADR-021).
//
// A single application-wide style sheet, so every panel looks the same without each widget
// styling itself. Colours are fixed (not taken from the system theme) so that a screenshot in a
// test report always looks the same, and so the contrast of the status colours is known.
//
// Status is NEVER shown by colour alone: every pill carries a word and a symbol as well.

#include <QString>

class QApplication;
class QLabel;
class QWidget;

/**
 * Applies the widget style and the colour palette to the application. Must run before the style
 * sheet. Both apps force a LIGHT palette and the Fusion style, because the native Windows style
 * follows the system dark/light setting: in dark mode every widget this file does not colour
 * explicitly (check boxes, line edits, menus) would draw white text on these white cards.
 */
void applyTheme(QApplication& app);

/** The whole style sheet. Applied once to the QApplication. */
QString themeStyleSheet();

/** Status pill kinds. The object name decides the colours; the caller always supplies text too. */
enum class Pill { Idle, Busy, Good, Warn, Bad, Recording };

/**
 * Sets `label` to a status pill: a symbol, a word and the detail, e.g. "[REC] RECORDING - take 2".
 * Never colour alone (Stage 10 brief).
 */
void setPill(QLabel* label, Pill kind, const QString& text);

/** Marks a step card as done / current / waiting. Returns the symbol used, for the step badge. */
QString stepSymbol(bool done, bool enabled);

