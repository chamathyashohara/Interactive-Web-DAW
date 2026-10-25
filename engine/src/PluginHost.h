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
    ~PluginHost();

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

    /** The plugin's own window (message thread only). `openEditor` shows it, or brings it forward; false if the plugin has none. */
    bool hasEditor() const { return plugin != nullptr && plugin->hasEditor(); }
    bool openEditor();
    bool editorIsOpen() const;
    /** Call from the host loop: closes the window if the user pressed its close button. True when it just closed. */
    bool serviceEditor();
    void closeEditor();

    /** True once if the plugin reported a change to its settings (a knob moved, a preset loaded) at least `quietMs` ago. A plugin's
        saved state can differ on every call (timestamps, random seeds), so the plugin's own notifications are the signal, not a comparison. */
    bool takeChangedSettings(int64_t quietMs);

    /** Tests and tooling: parameter names, and a stand-in for the user turning a knob (sets the first parameter whose name contains `match`). */
    juce::StringArray parameterNames() const;
    bool tweakParameter(const juce::String& match);

    /** True when this build can open VST2 (.dll) plugins. */
    static bool supportsVst2();

private:
    juce::AudioPluginFormatManager formats;
    std::unique_ptr<juce::AudioPluginInstance> plugin;
    double sr = 48000.0;
    int block = 512;

    class EditorWindow;
    std::unique_ptr<EditorWindow> editorWindow;

    struct ChangeWatcher : juce::AudioProcessorListener
    {
        std::atomic<bool> dirty{ false };
        std::atomic<int64_t> lastMs{ 0 };
        void touch()
        {
            lastMs.store(static_cast<int64_t>(juce::Time::getMillisecondCounterHiRes()), std::memory_order_relaxed);
            dirty.store(true, std::memory_order_release);
        }
        void audioProcessorParameterChanged(juce::AudioProcessor*, int, float) override { touch(); }
        void audioProcessorChanged(juce::AudioProcessor*, const ChangeDetails& d) override
        {
            if (d.parameterInfoChanged || d.programChanged || d.nonParameterStateChanged) touch();
        }
    } changes;
};
