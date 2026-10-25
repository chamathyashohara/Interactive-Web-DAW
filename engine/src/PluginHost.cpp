#include "PluginHost.h"

/** A plain window around the plugin's own editor. Closing it only raises a flag; the host loop deletes the window. */
class PluginHost::EditorWindow : public juce::DocumentWindow
{
public:
    EditorWindow(juce::AudioProcessorEditor* editor, const juce::String& title)
        : juce::DocumentWindow(title, juce::Colour(0xff1b1f29), juce::DocumentWindow::minimiseButton | juce::DocumentWindow::closeButton)
    {
        setUsingNativeTitleBar(true);
        setContentOwned(editor, true);
        setResizable(editor->isResizable(), false);
        centreWithSize(getWidth(), getHeight());
        setVisible(true);
        setAlwaysOnTop(true); // the DAW window is a different program; keep the plugin reachable while it is being played
    }
    void closeButtonPressed() override { closeRequested = true; }
    std::atomic<bool> closeRequested{ false };
};

PluginHost::PluginHost()
{
    juce::addDefaultFormatsToManager(formats); // VST3 (with its editor), plus VST2 when JUCE_PLUGINHOST_VST is on
}

PluginHost::~PluginHost() { closeEditor(); }

bool PluginHost::openEditor()
{
    if (plugin == nullptr || !plugin->hasEditor()) return false;
    if (editorWindow != nullptr)
    {
        editorWindow->toFront(true);
        return true;
    }
    auto* editor = plugin->createEditorIfNeeded();
    if (editor == nullptr) return false;
    editorWindow = std::make_unique<EditorWindow>(editor, plugin->getName());
    return true;
}

bool PluginHost::editorIsOpen() const { return editorWindow != nullptr; }

bool PluginHost::serviceEditor()
{
    if (editorWindow != nullptr && editorWindow->closeRequested.load())
    {
        closeEditor();
        return true;
    }
    return false;
}

void PluginHost::closeEditor() { editorWindow.reset(); }

bool PluginHost::takeChangedSettings(int64_t quietMs)
{
    if (!changes.dirty.load(std::memory_order_acquire)) return false;
    const int64_t now = static_cast<int64_t>(juce::Time::getMillisecondCounterHiRes());
    if (now - changes.lastMs.load(std::memory_order_relaxed) < quietMs) return false;
    changes.dirty.store(false, std::memory_order_release);
    return true;
}

juce::StringArray PluginHost::parameterNames() const
{
    juce::StringArray names;
    if (plugin != nullptr)
        for (auto* p : plugin->getParameters()) names.add(p->getName(64));
    return names;
}

bool PluginHost::tweakParameter(const juce::String& match)
{
    if (plugin == nullptr) return false;
    for (auto* p : plugin->getParameters())
        if (p->getName(64).containsIgnoreCase(match))
        {
            p->setValueNotifyingHost(p->getValue() < 0.5f ? 0.85f : 0.15f);
            return true;
        }
    return false;
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
    changes.dirty = false;
    plugin->addListener(&changes);
    return {};
}

void PluginHost::unload()
{
    closeEditor(); // the window must go before the plugin it shows
    if (plugin != nullptr)
    {
        plugin->removeListener(&changes);
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
