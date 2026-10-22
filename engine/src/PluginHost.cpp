#ifdef DAW_ENABLE_VST3
#include "PluginHost.h"
#include <cmath>
#include <cstdio>

PluginHost::PluginHost()
{
    juce::addHeadlessDefaultFormatsToManager(formats); // registers VST3 without UI code (JUCE 8; we render, not show the editor here)
}

std::string PluginHost::load(const std::string& path, double sampleRate, int blockSize)
{
    unload();
    sr = sampleRate;
    block = blockSize;

    const juce::File file(juce::String::fromUTF8(path.c_str()));
    if (!file.exists())
        return "plugin file not found: " + path;

    juce::VST3PluginFormat vst3;
    juce::OwnedArray<juce::PluginDescription> found;
    vst3.findAllTypesForFile(found, file.getFullPathName());
    if (found.isEmpty())
        return "no VST3 plugin in: " + path;

    // Prefer an instrument; otherwise take the first type in the file.
    const juce::PluginDescription* chosen = found.getFirst();
    for (auto* d : found)
        if (d->isInstrument) { chosen = d; break; }

    juce::String error;
    plugin = formats.createPluginInstance(*chosen, sampleRate, blockSize, error);
    if (plugin == nullptr)
        return "could not load plugin: " + error.toStdString();

    // Stereo out, no audio in (a synth): keep the main output bus at 2 channels where the plugin allows it.
    plugin->enableAllBuses();
    juce::AudioProcessor::BusesLayout layout = plugin->getBusesLayout();
    for (auto& bus : layout.outputBuses)
        if (bus.size() > 2) bus = juce::AudioChannelSet::stereo();
    plugin->setBusesLayout(layout);

    plugin->setRateAndBufferSizeDetails(sampleRate, blockSize);
    plugin->prepareToPlay(sampleRate, blockSize);
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
    juce::MemoryBlock block;
    if (plugin != nullptr)
        plugin->getStateInformation(block);
    return block;
}

void PluginHost::setState(const juce::MemoryBlock& state)
{
    if (plugin != nullptr && state.getSize() > 0)
        plugin->setStateInformation(state.getData(), static_cast<int>(state.getSize()));
}

int runPluginTest(const std::string& path)
{
    juce::ScopedJuceInitialiser_GUI juceInit; // plugin scanning/creation needs the message thread
    const double sr = 48000.0;
    const int block = 512;

    PluginHost host;
    const std::string err = host.load(path, sr, block);
    if (!err.empty())
    {
        std::printf("{\"t\":\"plugintest\",\"ok\":false,\"error\":\"%s\"}\n", juce::String(err).replace("\"", "'").toRawUTF8());
        return 1;
    }

    // Two seconds: note on at the start, note off after one second; measure the peak while the note sounds.
    const int totalBlocks = static_cast<int>(sr * 2.0 / block);
    const int noteOffBlock = static_cast<int>(sr * 1.0 / block);
    juce::AudioBuffer<float> buffer(2, block);
    float peak = 0.0f;
    double energy = 0.0;
    int64_t counted = 0;

    for (int b = 0; b < totalBlocks; ++b)
    {
        buffer.clear();
        juce::MidiBuffer midi;
        if (b == 0) midi.addEvent(juce::MidiMessage::noteOn(1, 60, (juce::uint8) 100), 0);
        if (b == noteOffBlock) midi.addEvent(juce::MidiMessage::noteOff(1, 60), 0);
        host.render(buffer, midi);

        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        {
            const float* d = buffer.getReadPointer(ch);
            for (int i = 0; i < block; ++i)
            {
                peak = std::max(peak, std::fabs(d[i]));
                if (b < noteOffBlock) { energy += static_cast<double>(d[i]) * d[i]; ++counted; }
            }
        }
    }

    const double rms = counted > 0 ? std::sqrt(energy / static_cast<double>(counted)) : 0.0;
    const bool audible = peak > 0.001;
    std::printf("{\"t\":\"plugintest\",\"ok\":true,\"name\":\"%s\",\"audible\":%s,\"peak\":%.5f,\"rms\":%.5f}\n",
                host.name().replace("\"", "'").toRawUTF8(), audible ? "true" : "false", peak, rms);
    host.unload();
    return audible ? 0 : 2;
}
#endif
