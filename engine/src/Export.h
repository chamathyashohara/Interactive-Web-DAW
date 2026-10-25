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

class AudioEngine;

/** Receives rendered stereo blocks. */
using BlockSink = std::function<void(const float* left, const float* right, int numSamples)>;
/** Called after every rendered block with the (offline) engine and the master signal as it was before the soft clip. */
using BlockProbe = std::function<void(AudioEngine& engine, const float* preClipL, const float* preClipR, int numSamples)>;

/** Frames in one pass of the song at the model's tempo (ceil). */
int64_t songFrames(const PlaybackModel& model, double sampleRate);

/**
 * Renders the song once, then `tailSeconds` more so releases and drum decays ring out (the sequencer is stopped
 * exactly at the song end). Returns the total number of frames delivered: songFrames + round(tail * sampleRate).
 * Returns -1 if cancelled. `progress` receives 0..1.
 */
int64_t renderSong(const PlaybackModel& model, double sampleRate, double tailSeconds, const BlockSink& sink,
                   const std::function<void(double)>& progress = {}, const std::atomic<bool>* cancel = nullptr, const BlockProbe& probe = {});

/**
 * Estimates the true peak of one channel: the highest value of the signal between the samples, from 4x oversampling with a windowed
 * sinc. A converter reconstructs those in-between values, so they can pass 0 dBFS when no sample does. An estimate, not a certified
 * ITU-R BS.1770 meter. Feed it blocks in order.
 */
class TruePeakMeter
{
public:
    TruePeakMeter();
    void process(const float* x, int n);
    float peak() const { return maxPeak; }

private:
    static constexpr int kTaps = 12;
    float hist[kTaps] = {};
    float coef[3][kTaps] = {};
    int filled = 0;
    float maxPeak = 0.0f;
};

/** What the mixer assistant needs from a whole-song render. */
struct MixAnalysisResult
{
    bool ok = false;
    std::string error;
    double sampleRate = 0.0;
    int64_t frames = 0;
    float prePeak = 0.0f;  // master sample peak before the soft clip
    float truePeak = 0.0f; // estimated true peak of that signal
    float outPeak = 0.0f;  // what reaches the speakers
    uint64_t softClips = 0, overs = 0;
    std::vector<float> bus;           // per slot
    std::vector<double> sumSq;        // per slot
    std::vector<uint64_t> slotFrames; // per slot
};

/** Renders the song once (plus a short tail) without writing a file and measures it with the same meters the live engine uses. */
MixAnalysisResult analyzeMixOffline(const PlaybackModel& model, double sampleRate, double tailSeconds, const std::function<void(double)>& progress = {}, const std::atomic<bool>* cancel = nullptr);

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
