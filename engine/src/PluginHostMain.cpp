// daw_pluginhost: loads ONE instrument plugin and renders it for the engine through shared memory (see PluginIpc.h).
// Run by the engine, not by hand:   daw_pluginhost --id <session> --plugin <path> --sr <hz> --engine-pid <pid> [--state <file>] [--state-out <file>]
// Test it alone:                    daw_pluginhost --test <path>      (loads, plays one note, prints whether audio came out)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include "PluginHost.h"
#include "PluginIpc.h"
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#endif

namespace
{
std::string argValue(int argc, char** argv, const char* name)
{
    for (int i = 1; i + 1 < argc; ++i)
        if (std::strcmp(argv[i], name) == 0) return argv[i + 1];
    return {};
}
bool hasFlag(int argc, char** argv, const char* name)
{
    for (int i = 1; i < argc; ++i)
        if (std::strcmp(argv[i], name) == 0) return true;
    return false;
}

/** --test: load, play one note for a second, report. */
int runTest(const std::string& path)
{
    const double sr = 48000.0;
    const int block = 512;
    PluginHost host;
    const std::string err = host.load(path, sr, block);
    if (!err.empty())
    {
        std::printf("{\"t\":\"plugintest\",\"ok\":false,\"error\":\"%s\"}\n", juce::String(err).replace("\"", "'").toRawUTF8());
        return 1;
    }
    juce::AudioBuffer<float> buffer(2, block);
    float peak = 0.0f;
    for (int b = 0; b < static_cast<int>(sr * 2.0 / block); ++b)
    {
        buffer.clear();
        juce::MidiBuffer midi;
        if (b == 0) midi.addEvent(juce::MidiMessage::noteOn(1, 60, (juce::uint8) 100), 0);
        if (b == static_cast<int>(sr / block)) midi.addEvent(juce::MidiMessage::noteOff(1, 60), 0);
        host.render(buffer, midi);
        for (int ch = 0; ch < 2; ++ch)
            for (int i = 0; i < block; ++i) peak = std::max(peak, std::fabs(buffer.getSample(ch, i)));
    }
    std::printf("{\"t\":\"plugintest\",\"ok\":true,\"name\":\"%s\",\"audible\":%s,\"peak\":%.5f,\"vst2\":%s}\n", host.name().replace("\"", "'").toRawUTF8(), peak > 0.001f ? "true" : "false", peak,
                PluginHost::supportsVst2() ? "true" : "false");
    return peak > 0.001f ? 0 : 2;
}

#ifdef _WIN32
bool processAlive(DWORD pid)
{
    HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, pid);
    if (h == nullptr) return false;
    const bool alive = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
    CloseHandle(h);
    return alive;
}
#endif
} // namespace

int main(int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI juceInit; // plugins expect a message thread; this one is it

    if (hasFlag(argc, argv, "--caps"))
    {
        std::printf("{\"vst3\":true,\"vst2\":%s}\n", PluginHost::supportsVst2() ? "true" : "false");
        return 0;
    }
    if (hasFlag(argc, argv, "--test")) return runTest(argValue(argc, argv, "--test"));
    if (hasFlag(argc, argv, "--params"))
    {
        PluginHost host;
        const std::string err = host.load(argValue(argc, argv, "--params"), 48000.0, 512);
        if (!err.empty()) { std::printf("%s\n", err.c_str()); return 1; }
        const auto names = host.parameterNames();
        for (int i = 0; i < names.size(); ++i) std::printf("%d %s\n", i, names[i].toRawUTF8());
        return 0;
    }

#ifndef _WIN32
    return 3; // the shared-memory link is Windows-only for now
#else
    const std::string id = argValue(argc, argv, "--id");
    const std::string pluginPath = argValue(argc, argv, "--plugin");
    const std::string stateFile = argValue(argc, argv, "--state");
    const std::string stateOutFile = argValue(argc, argv, "--state-out"); // where the plugin's changed settings are written for the engine
    const double sampleRate = std::atof(argValue(argc, argv, "--sr").c_str());
    const DWORD enginePid = static_cast<DWORD>(std::atol(argValue(argc, argv, "--engine-pid").c_str()));
    if (id.empty() || pluginPath.empty() || sampleRate < 8000.0) return 4;

    HANDLE map = OpenFileMappingA(FILE_MAP_ALL_ACCESS, FALSE, plugipc::mapName(id).c_str());
    if (map == nullptr) return 5;
    auto* sh = static_cast<plugipc::Shared*>(MapViewOfFile(map, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(plugipc::Shared)));
    HANDLE reqEvent = OpenEventA(SYNCHRONIZE, FALSE, plugipc::requestEventName(id).c_str());
    HANDLE doneEvent = OpenEventA(EVENT_MODIFY_STATE, FALSE, plugipc::doneEventName(id).c_str());
    if (sh == nullptr || reqEvent == nullptr || doneEvent == nullptr || sh->magic != plugipc::kMagic) return 6;

    PluginHost host;
    const std::string err = host.load(pluginPath, sampleRate, plugipc::kMaxFrames);
    if (!err.empty())
    {
        std::snprintf(sh->error, sizeof(sh->error), "%s", err.c_str());
        sh->hostState.store(plugipc::kFailed, std::memory_order_release);
        return 7;
    }
    if (!stateFile.empty())
    {
        juce::MemoryBlock state;
        if (juce::File(juce::String::fromUTF8(stateFile.c_str())).loadFileAsData(state)) host.setState(state);
    }
    host.takeChangedSettings(0); // loading the saved settings is not a change to save
    std::snprintf(sh->name, sizeof(sh->name), "%s", host.name().toRawUTF8());
    sh->latencySamples.store(static_cast<uint32_t>(std::max(0, host.latencySamples())), std::memory_order_release);
    sh->hostState.store(plugipc::kReady, std::memory_order_release);

    juce::AudioBuffer<float> buffer(2, plugipc::kMaxFrames);
    juce::MidiBuffer midi;
    uint64_t processed = 0;
    int idleLoops = 0;

    // The plugin's own window: opened when the engine asks. When the plugin reports that its settings changed (and has been quiet for
    // a moment, so dragging a knob is one save), the settings are written to --state-out for the engine to put into the project.
    uint32_t handledOpen = sh->openEditorSeq.load(std::memory_order_acquire);
    const auto saveNow = [&] {
        if (stateOutFile.empty()) return;
        const juce::MemoryBlock now = host.getState();
        if (now.getSize() == 0) return;
        if (juce::File(juce::String::fromUTF8(stateOutFile.c_str())).replaceWithData(now.getData(), now.getSize()))
            sh->stateSeq.fetch_add(1, std::memory_order_release);
    };

    for (;;)
    {
        WaitForSingleObject(reqEvent, 20);
        juce::MessageManager::getInstance()->runDispatchLoopUntil(0); // let the plugin's timers and messages run
        sh->hostBeat.fetch_add(1, std::memory_order_relaxed);
        if (sh->quit.load(std::memory_order_acquire) != 0) break;
        if ((++idleLoops % 50) == 0 && !processAlive(enginePid)) break; // the engine is gone: do not linger

        const uint32_t openReq = sh->openEditorSeq.load(std::memory_order_acquire);
        if (openReq != handledOpen)
        {
            handledOpen = openReq;
            host.openEditor();
            // test hook: stands in for a person turning a knob in the plugin window (DAW_PLUGINHOST_TWEAK=<part of a parameter name>)
            const juce::String tweak = juce::SystemStats::getEnvironmentVariable("DAW_PLUGINHOST_TWEAK", {});
            if (tweak.isNotEmpty()) host.tweakParameter(tweak);
        }
        if (host.serviceEditor() && host.takeChangedSettings(0)) saveNow(); // just closed: keep whatever was changed last
        sh->editorOpen.store(host.editorIsOpen() ? 1u : 0u, std::memory_order_release);
        if (host.editorIsOpen())
        {
            if (host.takeChangedSettings(400)) saveNow();
        }
        else
            host.takeChangedSettings(0); // changes with no window open (the plugin's own modulation) are not the user's edits

        const uint64_t requested = sh->requestSeq.load(std::memory_order_acquire);
        if (requested > processed + plugipc::kSlots - 1) processed = requested - 1; // fell too far behind: skip ahead, keep only the newest
        while (processed < requested)
        {
            plugipc::Slot& slot = sh->slots[processed % plugipc::kSlots];
            const int frames = static_cast<int>(std::min<uint32_t>(slot.frames, plugipc::kMaxFrames));
            midi.clear();
            for (uint32_t i = 0; i < std::min<uint32_t>(slot.midiCount, plugipc::kMaxMidi); ++i)
            {
                const auto& e = slot.midi[i];
                midi.addEvent(juce::MidiMessage(e.status, e.data1, e.data2), juce::jlimit(0, std::max(0, frames - 1), static_cast<int>(e.offset)));
            }
            buffer.setSize(2, frames, false, false, true);
            buffer.clear();
            host.render(buffer, midi);
            std::memcpy(slot.left, buffer.getReadPointer(0), sizeof(float) * static_cast<size_t>(frames));
            std::memcpy(slot.right, buffer.getReadPointer(1), sizeof(float) * static_cast<size_t>(frames));
            ++processed;
            sh->doneSeq.store(processed, std::memory_order_release);
            SetEvent(doneEvent);
        }
    }
    host.unload();
    UnmapViewOfFile(sh);
    CloseHandle(map);
    return 0;
#endif
}
