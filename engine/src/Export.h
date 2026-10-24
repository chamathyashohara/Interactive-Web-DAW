#pragma once
#include "Model.h"
#include <atomic>
#include <cstdint>
#include <functional>
#include <juce_core/juce_core.h>
#include <string>

/**
 * Offline rendering and WAV export. Uses the very same AudioEngine mixer path as live playback
 * (a separate instance, so it never disturbs what is playing), but runs as fast as the CPU allows.
 */

/** Receives rendered stereo blocks. */
using BlockSink = std::function<void(const float* left, const float* right, int numSamples)>;

/** Frames in one pass of the song at the model's tempo (ceil). */
int64_t songFrames(const PlaybackModel& model, double sampleRate);

/**
 * Renders the song once, then `tailSeconds` more so releases and drum decays ring out (the sequencer is stopped
 * exactly at the song end). Returns the total number of frames delivered: songFrames + round(tail * sampleRate).
 * Returns -1 if cancelled. `progress` receives 0..1.
 */
int64_t renderSong(const PlaybackModel& model, double sampleRate, double tailSeconds, const BlockSink& sink,
                   const std::function<void(double)>& progress = {}, const std::atomic<bool>* cancel = nullptr);

struct ExportResult
{
    bool ok = false;
    std::string error;
    int64_t frames = 0;
    double peak = 0.0; // linear
};

/** Writes a 24-bit stereo WAV (overwriting any existing file). */
ExportResult exportWav(const PlaybackModel& model, const juce::File& file, double sampleRate, double tailSeconds,
                       const std::function<void(double)>& progress = {}, const std::atomic<bool>* cancel = nullptr);
