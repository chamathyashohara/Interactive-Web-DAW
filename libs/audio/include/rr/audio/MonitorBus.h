#pragma once

#include <atomic>
#include <cstdint>
#include <vector>

#include "rr/audio/SpscRing.h"

struct MonitorStats
{
    uint64_t pushedFrames = 0;        // frames offered by the capture side while enabled
    uint64_t overflowEvents = 0;      // capture block dropped: monitor buffer full
    uint64_t overflowFrames = 0;
    uint64_t playedFrames = 0;        // frames rendered to the output (any source)
    uint64_t renderCallbacks = 0;
    uint64_t underrunEvents = 0;      // buffer ran dry while monitoring (gap in what you hear)
    uint64_t underrunFrames = 0;
    uint64_t prefillEvents = 0;       // (re)starts of monitoring after filling to the target
    uint64_t startTrimFrames = 0;    // backlog dropped at a (re)start so delay starts at the target
    uint64_t driftTrimEvents = 0;    // excess latency removed (capture clock faster than playback)
    uint64_t driftTrimFrames = 0;
    uint32_t fillFrames = 0;          // frames buffered after the latest render
    uint32_t maxFillFrames = 0;
    uint32_t targetFrames = 0;        // prefill target
    uint32_t capacityFrames = 0;
    int64_t maxRenderNs = 0;
};

/**
 * Local software monitoring path ("hear yourself") and output test tone.
 *
 * Capture callback --pushCapture()--> [stereo SPSC ring] --render()--> playback callback.
 *
 * Monitor-only processing, all stated in the UI and the diagnostics report (MONITOR_PATH.md):
 * 1. channel map into the ring: 1 ch -> L=R; 2 ch -> copied; >2 ch -> first two channels;
 * 2. channel map to the output: stereo -> 1 ch average; 2 ch copy; >2 ch L/R then silence;
 * 3. monitor gain (default 0 dB);
 * 4. silence for underruns / while filling, trimming of the backlog at each (re)start and
 * of persistently excess buffered audio (clock drift).
 * None of this touches the master recording: the record path has its own ring.
 *
 * Real-time rules: pushCapture() runs on the capture callback, render() on the playback
 * callback. Both use only preallocated memory, atomics and bounded loops. The control
 * functions (setEnabled, setGainDb, startTestTone, stats) may be called from any
 * other thread.
 */
class MonitorBus
{
public:
    static constexpr uint32_t kMaxBlockFrames = 4096;  // larger blocks are processed in chunks

    MonitorBus(uint32_t sampleRate, uint32_t capacityMs = 200, uint32_t targetMs = 20);
    MonitorBus(const MonitorBus&) = delete;
    MonitorBus& operator=(const MonitorBus&) = delete;

    /** ---- capture callback (real-time) ---- */
    void pushCapture(const float* interleaved, uint32_t frames, uint32_t channels) noexcept;

    /** ---- playback callback (real-time) ---- */
    void render(float* out, uint32_t frames, uint32_t outChannels) noexcept;

    /** ---- control (any non-real-time thread) ---- */
    void setEnabled(bool on) noexcept { enabled.store(on, std::memory_order_release); }
    bool isEnabled() const noexcept { return enabled.load(std::memory_order_acquire); }
    void setGainDb(float db) noexcept;
    float getGainDb() const noexcept { return gainDb.load(std::memory_order_relaxed); }
    /** Mixes a sine into the output for `seconds` (independent of monitoring). */
    void startTestTone(float frequencyHz, float levelDbfs, float seconds) noexcept;
    bool testToneActive() const noexcept { return toneFramesLeft.load(std::memory_order_relaxed) > 0; }
    uint32_t getSampleRate() const noexcept { return sampleRate; }
    MonitorStats stats() const noexcept;

private:
    const uint32_t sampleRate;
    const uint32_t targetFrames;
    SpscRing<float> ring;                 // interleaved stereo frames
    std::vector<float> captureScratch;   // capture side only
    std::vector<float> renderScratch;    // playback side only

    std::atomic<bool> enabled{false};
    std::atomic<float> gainDb{0.0f};
    std::atomic<float> gainLinear{1.0f};
    std::atomic<uint64_t> toneFramesLeft{0};
    std::atomic<float> toneFrequency{440.0f};
    std::atomic<float> toneAmplitude{0.1f};

    /** Playback-side state (touched only inside render()). */
    bool playing = false;
    double tonePhase = 0.0;
    uint32_t overTargetRenders = 0;

    std::atomic<uint64_t> pushedFrames{0};
    std::atomic<uint64_t> overflowEvents{0};
    std::atomic<uint64_t> overflowFrames{0};
    std::atomic<uint64_t> playedFrames{0};
    std::atomic<uint64_t> renderCallbacks{0};
    std::atomic<uint64_t> underrunEvents{0};
    std::atomic<uint64_t> underrunFrames{0};
    std::atomic<uint64_t> prefillEvents{0};
    std::atomic<uint64_t> startTrimFrames{0};
    std::atomic<uint64_t> driftTrimEvents{0};
    std::atomic<uint64_t> driftTrimFrames{0};
    std::atomic<uint32_t> fillFrames{0};
    std::atomic<uint32_t> maxFillFrames{0};
    std::atomic<int64_t> maxRenderNs{0};
};

