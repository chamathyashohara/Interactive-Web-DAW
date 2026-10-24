#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <memory>
#include <string>

/**
 * Loads ONE instrument plugin from a file and renders it. Lives inside the plugin host process (daw_pluginhost), never in the
 * engine. Loading must happen on the message thread; `render` is the real-time path once loaded. A failed load leaves the host
 * empty and says why. Formats: VST3 always; VST2 (.dll) only when the host was built with Steinberg's VST2 SDK headers.
 */
class PluginHost
{
public:
    PluginHost();

    /** Loads the plugin at `path` (a .vst3, or a VST2 .dll if built with it) for `sampleRate` / up to `maxBlock` frames. Empty string = success. */
    std::string load(const std::string& path, double sampleRate, int maxBlock);
    void unload();
    bool isLoaded() const { return plugin != nullptr; }
    juce::String name() const { return plugin != nullptr ? plugin->getName() : juce::String(); }
    int latencySamples() const { return plugin != nullptr ? plugin->getLatencySamples() : 0; }

    /** Renders `buffer.getNumSamples()` frames (stereo) while consuming `midi`. Silence when not loaded. */
    void render(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);
    void reset();

    /** The plugin's own saved settings. */
    juce::MemoryBlock getState() const;
    void setState(const juce::MemoryBlock& state);

    /** True when this build can open VST2 (.dll) plugins. */
    static bool supportsVst2();

private:
    juce::AudioPluginFormatManager formats;
    std::unique_ptr<juce::AudioPluginInstance> plugin;
    double sr = 48000.0;
    int block = 512;
};
