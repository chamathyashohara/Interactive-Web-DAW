#include "PluginHost.h"

PluginHost::PluginHost()
{
    juce::addHeadlessDefaultFormatsToManager(formats); // VST3, plus VST2 when JUCE_PLUGINHOST_VST is on (JUCE 8, no editor UI here)
}

bool PluginHost::supportsVst2()
{
#if JUCE_PLUGINHOST_VST
    return true;
#else
    return false;
#endif
}

std::string PluginHost::load(const std::string& path, double sampleRate, int maxBlock)
{
    unload();
    sr = sampleRate;
    block = maxBlock;

    const juce::File file(juce::String::fromUTF8(path.c_str()));
    if (!file.exists())
        return "plugin file not found: " + path;

    // Ask each registered format whether it can read this file; take the first that finds a plugin in it.
    juce::OwnedArray<juce::PluginDescription> found;
    juce::AudioPluginFormat* chosenFormat = nullptr;
    for (auto* fmt : formats.getFormats())
    {
        if (!fmt->fileMightContainThisPluginType(file.getFullPathName())) continue;
        fmt->findAllTypesForFile(found, file.getFullPathName());
        if (!found.isEmpty()) { chosenFormat = fmt; break; }
    }
    if (found.isEmpty() || chosenFormat == nullptr)
    {
        if (file.hasFileExtension("dll") && !supportsVst2())
            return "this is a VST2 plugin (.dll); this build has no VST2 support (it needs Steinberg's VST2 SDK, see docs/plugin-hosting.md)";
        return "no plugin found in: " + path;
    }

    // Prefer an instrument; otherwise the first type in the file.
    const juce::PluginDescription* chosen = found.getFirst();
    for (auto* d : found)
        if (d->isInstrument) { chosen = d; break; }

    juce::String error;
    plugin = formats.createPluginInstance(*chosen, sampleRate, maxBlock, error);
    if (plugin == nullptr)
        return "could not load plugin: " + error.toStdString();

    // Stereo out; no audio in (an instrument).
    plugin->enableAllBuses();
    juce::AudioProcessor::BusesLayout layout = plugin->getBusesLayout();
    for (auto& bus : layout.outputBuses)
        if (bus.size() > 2) bus = juce::AudioChannelSet::stereo();
    plugin->setBusesLayout(layout);

    plugin->setRateAndBufferSizeDetails(sampleRate, maxBlock);
    plugin->prepareToPlay(sampleRate, maxBlock);
    return {};
}

void PluginHost::unload()
{
    if (plugin != nullptr)
    {
        plugin->releaseResources();
        plugin.reset();
    }
}

void PluginHost::render(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    if (plugin == nullptr)
    {
        buffer.clear();
        return;
    }
    plugin->processBlock(buffer, midi);
}

void PluginHost::reset()
{
    if (plugin != nullptr)
        plugin->reset();
}

juce::MemoryBlock PluginHost::getState() const
{
    juce::MemoryBlock state;
    if (plugin != nullptr)
        plugin->getStateInformation(state);
    return state;
}

void PluginHost::setState(const juce::MemoryBlock& state)
{
    if (plugin != nullptr && state.getSize() > 0)
        plugin->setStateInformation(state.getData(), static_cast<int>(state.getSize()));
}
