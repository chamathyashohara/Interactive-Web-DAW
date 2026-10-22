#pragma once
#ifdef DAW_ENABLE_VST3
#include <juce_audio_processors/juce_audio_processors.h>
#include <memory>
#include <string>

/**
 * Hosts a single VST3 instrument plugin loaded from a .vst3 path. Loading (and prepare) must happen off the audio thread;
 * `render` is real-time safe once loaded. A failed load leaves the host empty and reports why, so a slot stays silent
 * rather than crashing the engine. Compiled only when DAW_ENABLE_VST3 is on (it pulls in juce_audio_processors + the VST3 SDK).
 */
class PluginHost
{
public:
    PluginHost();

    /** Loads the .vst3 at `path` and prepares it for `sampleRate`/`blockSize`. Returns an error string (empty on success). */
    std::string load(const std::string& path, double sampleRate, int blockSize);
    void unload();
    bool isLoaded() const { return plugin != nullptr; }
    juce::String name() const { return plugin != nullptr ? plugin->getName() : juce::String(); }

    /** Renders `buffer.getNumSamples()` frames into `buffer` (stereo), consuming `midi`. Does nothing if not loaded. */
    void render(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);
    /** Silences the plugin's voices (e.g. on stop). */
    void reset();

    /** The plugin's own saved settings, for persisting with the project. */
    juce::MemoryBlock getState() const;
    void setState(const juce::MemoryBlock& state);

private:
    juce::AudioPluginFormatManager formats;
    std::unique_ptr<juce::AudioPluginInstance> plugin;
    double sr = 48000.0;
    int block = 512;
};

/** CLI smoke test (`daw_engine --plugintest <path.vst3>`): load, play one note, report whether audio came out. */
int runPluginTest(const std::string& path);
#endif
