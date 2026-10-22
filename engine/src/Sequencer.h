#pragma once
#include "Model.h"
#include <atomic>

/** Receives sample-accurate note events. Offsets are sample indices within the current block. */
struct SequencerSink
{
    virtual ~SequencerSink() = default;
    virtual void noteOn(int slot, int instrument, int sampleOffset, int pitch, int velocity) = 0;
    virtual void noteOff(int slot, int sampleOffset, int pitch) = 0;
    /** Same as noteOn, but with the whole note (sample tracks need its clip settings). */
    virtual void noteOnEx(int slot, int instrument, int sampleOffset, const NoteEvent& note) { noteOn(slot, instrument, sampleOffset, note.pitch, note.velocity); }
    /** A beat boundary (metronome). `downbeat` = first beat of a bar. Only called while the click is on. */
    virtual void beat(int sampleOffset, bool downbeat) { (void) sampleOffset; (void) downbeat; }
};

/**
 * Tick-based looping multi-track MIDI sequencer. No JUCE, no allocation, no locks: safe to run on
 * the audio thread and testable offline. Control methods may be called from any thread (atomics only).
 *
 * Position is tracked in ticks as a double and advanced by (bpm * ppq / (60 * sampleRate)) per
 * sample, so tempo changes take effect immediately and loops stay drift-free (the overshoot at
 * the loop boundary is carried into the next pass).
 */
class Sequencer
{
public:
    void prepare(double sampleRate) { sr = sampleRate; }

    void setModel(const PlaybackModel* m) { model.store(m, std::memory_order_release); }
    const PlaybackModel* currentModel() const { return model.load(std::memory_order_acquire); }
    void setPlaying(bool p) { playing.store(p, std::memory_order_release); }
    void setBpm(double b) { bpm.store(b, std::memory_order_release); }
    void requestSeek(double tick) { seekTick.store(tick, std::memory_order_release); }
    /** Playback wraps inside the model's loop region (live engine only: the offline export plays the whole song). */
    void setUseLoopRegion(bool on) { useRegion.store(on, std::memory_order_release); }
    /** Emit a beat event at every quarter note while playing. */
    void setClick(bool on) { click.store(on, std::memory_order_release); }

    double getTick() const { return posMirror.load(std::memory_order_relaxed); }
    double getBpm() const { return bpm.load(std::memory_order_relaxed); }
    bool isPlaying() const { return playing.load(std::memory_order_relaxed); }

    /** Advances time by numSamples and emits note events (offs before ons at equal offsets). */
    void process(int numSamples, SequencerSink& sink);

private:
    void releaseAll(int offset, SequencerSink& sink);

    std::atomic<const PlaybackModel*> model{nullptr};
    std::atomic<bool> playing{false};
    std::atomic<double> bpm{120.0};
    std::atomic<double> seekTick{-1.0};
    std::atomic<double> posMirror{0.0};
    std::atomic<bool> useRegion{false};
    std::atomic<bool> click{false};
    double wrapFrom = 0.0; // where the events of the pass after a wrap start (0 for the song loop, the region start for a region)

    double sr = 48000.0;
    double pos = 0.0;
    bool wasPlaying = false;
    bool justWrapped = false;

    struct Active
    {
        bool on = false;
        double endTick = 0.0;
    };
    Active active[kMaxSlots][128];
    int activeCount[kMaxSlots] = {};
};
