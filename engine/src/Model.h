#pragma once
#include <cstdint>
#include <vector>

constexpr int kMaxSlots = 16;
enum Instrument : int { kSynth = 0, kDrums = 1 };

/** One note on the absolute timeline, already clipped to the loop. */
struct NoteEvent
{
    int64_t startTick = 0;
    int64_t endTick = 0;
    int pitch = 60;
    int velocity = 90;
};

struct TrackModel
{
    int slot = 0;
    int instrument = kSynth;
    float gain = 0.64f; // final linear gain (mute/solo already resolved by the host)
    float pan = 0.0f;   // -1..1
    std::vector<NoteEvent> notes; // sorted by startTick
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
    float masterGain = 0.64f;
    std::vector<TrackModel> tracks;
};
