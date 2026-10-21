#pragma once
#include <juce_audio_formats/juce_audio_formats.h>
#include <atomic>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

/** A fully decoded sample: float, mono or stereo (extra channels are dropped). Immutable once published. */
struct SampleData
{
    double sampleRate = 48000.0;
    int channels = 1;
    int64_t frames = 0;
    std::vector<float> left;
    std::vector<float> right; // empty for mono
    float peak = 0.0f;
    /** Voices on the audio thread currently reading this sample; it is never freed while this is above zero. */
    mutable std::atomic<int> voices{ 0 };
};

constexpr double kMaxSampleSeconds = 15.0 * 60.0; // refuse anything longer (a whole song is not a sample)

/** Reads WAV / AIFF / FLAC / OGG (whatever JUCE's basic formats cover). Never throws; returns null and fills `error`. */
std::shared_ptr<SampleData> loadSample(const juce::File& file, std::string& error);

/**
 * Time-stretches `src` without changing its pitch: `ratio` is the speed factor (2 = twice as fast, half as long; 0.5 = twice as long).
 * The result is `round(frames / ratio)` frames long, with the first sound aligned to the first sample, so a loop that was an exact
 * number of bars stays an exact number of bars at the new tempo. Offline (takes a few tens of milliseconds per second of audio).
 */
std::shared_ptr<SampleData> stretchSample(const SampleData& src, double ratio, std::string& error);

/** `buckets` loudness values 0..255 (peak per bucket, normalised to the loudest bucket) for the little waveform picture. */
std::vector<int> samplePeaks(const SampleData& s, int buckets = 96);

/**
 * Keeps decoded samples alive for the audio thread. The audio thread only ever holds a raw pointer, so a sample that
 * was playing is released a few seconds after it was replaced, never on the audio thread.
 */
class SampleStore
{
public:
    /** Loads (or finds in the cache) the sample for `path`. */
    std::shared_ptr<SampleData> get(const std::string& path, std::string& error);
    /** The sample for `path` time-stretched by `ratio` (cached, so a tempo that is set again costs nothing). */
    std::shared_ptr<SampleData> getStretched(const std::string& path, double ratio, std::string& error);
    /** Marks `s` as in use by the audio thread; the previous one is retired and freed later. */
    void hold(std::shared_ptr<SampleData> s);
    /** Hands over a sample nobody needs any more; it is freed once no audio voice reads it (never on the audio thread). */
    void keep(std::shared_ptr<const SampleData> s);
    /** Frees retired samples that the audio thread cannot be using any more. */
    void purge();

private:
    struct Retired { std::shared_ptr<const SampleData> data; juce::uint32 at; };
    std::mutex mutex;
    std::unordered_map<std::string, std::shared_ptr<SampleData>> cache;
    std::deque<std::string> lru;
    std::shared_ptr<SampleData> held;
    std::vector<Retired> retired;
};

/**
 * Polyphonic sample player of one track slot (audio thread only). A note starts the sample at a speed that follows the pitch
 * (middle C = original), resampled by linear interpolation to the device rate. Gated sounds fade out on note-off; one-shots
 * play to their end. `cut()` fades everything (transport stop).
 */
class SampleVoices
{
public:
    static constexpr int kVoices = 16;
    ~SampleVoices() { for (auto& x : v) end(x); } // an engine that goes away (an export) must not leave samples marked as playing
    void prepare(double deviceRate);
    void trigger(const SampleData* d, int pitch, int velocity, bool gate);
    void release(int pitch);
    void cut();
    bool anyActive() const { return active > 0; }
    /** Adds the voices into mono-compatible stereo buffers (L, R). Samples are rendered as they are: stereo stays stereo. */
    void render(float* L, float* R, int n);

private:
    struct Voice
    {
        const SampleData* data = nullptr;
        double pos = 0.0;
        double step = 1.0;
        float gain = 1.0f;
        float env = 0.0f;
        int pitch = 60;
        bool gate = false;
        bool fading = false;
    };
    Voice v[kVoices];
    int active = 0;
    double deviceRate = 48000.0;
    float fadeInStep = 0.02f, fadeOutStep = 0.004f;
    void end(Voice& x);
};

/**
 * The browser's audition voice. Lives on the audio thread; commands arrive through atomics (never blocks, never allocates).
 * Plays one sample at a time with a 1 ms fade-in and a short fade-out when it is stopped or replaced, so it never clicks.
 */
class SamplePreview
{
public:
    void prepare(double deviceRate);

    /** Command thread: start playing `data` (must stay alive; see SampleStore). */
    void start(const SampleData* data, float gain);
    void stop();

    /** Audio thread: adds the preview into L and R. */
    void renderAdd(float* L, float* R, int n);

    /** -1 when nothing is playing, else how far through the sample it is (0..1). */
    float fraction() const { return frac.load(std::memory_order_relaxed); }

private:
    struct Voice
    {
        const SampleData* data = nullptr;
        double pos = 0.0;
        float gain = 1.0f;
        float env = 0.0f;
        bool fadingOut = false;
    };
    double ratio = 1.0;
    double deviceRate = 48000.0;
    float fadeInStep = 0.02f, fadeOutStep = 0.004f;
    Voice cur, old;
    std::atomic<const SampleData*> pendingData{ nullptr };
    std::atomic<float> pendingGain{ 1.0f };
    std::atomic<int> pendingSerial{ 0 };
    std::atomic<int> stopSerial{ 0 };
    int seenSerial = 0, seenStop = 0;
    std::atomic<float> frac{ -1.0f };

    void mix(Voice& v, float* L, float* R, int n, bool& finished);
};
