#pragma once
#include "Synth.h"
#include <cstdint>
#include <memory>
#include <vector>

struct SampleData;

constexpr int kMaxSlots = 16;
enum Instrument : int { kSynth = 0, kDrums = 1, kSample = 2 };

/** One note on the absolute timeline, already clipped to the loop. */
struct NoteEvent
{
    int64_t startTick = 0;
    int64_t endTick = 0;
    int pitch = 60;
    int velocity = 90;
    // Sample tracks (see EngineNote in the protocol): per-clip sound shaping. Defaults mean "as recorded".
    float gain = 1.0f;
    double offsetSec = 0.0;
    double fadeInSec = 0.0;
    double fadeOutSec = 0.0;
    double lengthSec = 0.0; // the note's length at the project tempo (fades and cuts are timed against it)
    bool cut = false;
};

/** One point of an automation curve: an absolute tick and a value 0..1. */
struct AutoPoint
{
    double tick = 0.0;
    float value = 1.0f;
};

/** The curve's value at `tick`: the first value before the curve, the last after it, straight lines between. An empty curve is 1. */
inline float autoAt(const std::vector<AutoPoint>& p, double tick)
{
    if (p.empty()) return 1.0f;
    if (tick <= p.front().tick) return p.front().value;
    if (tick >= p.back().tick) return p.back().value;
    size_t i = 1;
    while (p[i].tick < tick) ++i;
    const AutoPoint& a = p[i - 1];
    const AutoPoint& b = p[i];
    return a.value + static_cast<float>((b.value - a.value) * (tick - a.tick) / (b.tick - a.tick));
}

struct TrackModel
{
    SynthParams synth; // kSynth tracks: the preset parameters (default = the original sound)
    int slot = 0;
    int instrument = kSynth;
    float gain = 0.64f; // final linear gain (mute/solo already resolved by the host)
    float pan = 0.0f;   // -1..1
    std::vector<NoteEvent> notes; // sorted by startTick
    /** kSample tracks: the decoded sound (null = missing file, plays nothing) and whether a note-off cuts it. */
    std::shared_ptr<const SampleData> sample;
    bool gate = false;
    std::vector<AutoPoint> volumeAuto; // value 1 = the fader level; the gain follows value squared (the fader's own curve)
    std::vector<AutoPoint> filterAuto; // value 0..1 = low-pass cutoff 20 Hz .. 20 kHz (log); 1 = open (no filter)
};

/**
 * Immutable playable view of the project. Built on the command thread, published to the
 * audio thread through an atomic pointer, and freed later off the audio thread.
 */
struct PlaybackModel
{
    int ppq = 960;
    double tempo = 120.0; // used by offline export; live playback takes tempo from Sequencer::setBpm
    int64_t loopTicks = 15360;
    /** Loop region (playback only; export ignores it). Active when end > start. */
    int64_t loopStartTick = 0;
    int64_t loopEndTick = 0;
    float masterGain = 0.64f;
    std::vector<TrackModel> tracks;
};
