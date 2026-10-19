#ifdef _WIN32
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif
#include "AudioEngine.h"
#include "Export.h"
#include "SelfTest.h"
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <algorithm>
#include <atomic>
#include <cstdio>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace
{
constexpr const char* kVersion = "0.3.0";
constexpr double kExportSampleRate = 48000.0; // exports do not depend on the audio device

std::mutex gOutMutex;
void sendLine(const std::string& json)
{
    std::lock_guard<std::mutex> lock(gOutMutex);
    std::fwrite(json.data(), 1, json.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

std::string jsonEscape(const juce::String& s)
{
    return juce::JSON::toString(juce::var(s), true).toStdString(); // quoted + escaped
}

/** Model ownership: published to the audio thread by pointer, freed a couple of seconds later. */
class ModelStore
{
public:
    explicit ModelStore(Sequencer& s) : sequencer(s) {}
    ~ModelStore()
    {
        sequencer.setModel(nullptr);
        std::lock_guard<std::mutex> lock(mutex);
        delete current;
        for (auto& r : retired) delete r.model;
    }

    void publish(PlaybackModel* fresh)
    {
        std::lock_guard<std::mutex> lock(mutex);
        sequencer.setModel(fresh);
        if (current != nullptr) retired.push_back({ current, juce::Time::getMillisecondCounter() });
        current = fresh;
    }

    /** A private copy of the current model for the export thread (the live one may be retired at any time). */
    std::unique_ptr<PlaybackModel> copyCurrent()
    {
        std::lock_guard<std::mutex> lock(mutex);
        return current != nullptr ? std::make_unique<PlaybackModel>(*current) : nullptr;
    }

    void purge()
    {
        std::lock_guard<std::mutex> lock(mutex);
        const auto now = juce::Time::getMillisecondCounter();
        for (size_t i = 0; i < retired.size();)
        {
            if (now - retired[i].at > 2000) // the audio thread holds a model for at most one block
            {
                delete retired[i].model;
                retired.erase(retired.begin() + static_cast<long>(i));
            }
            else ++i;
        }
    }

private:
    struct Retired { PlaybackModel* model; juce::uint32 at; };
    Sequencer& sequencer;
    std::mutex mutex;
    PlaybackModel* current = nullptr;
    std::vector<Retired> retired;
};

PlaybackModel* parseModel(const juce::var& project)
{
    auto* model = new PlaybackModel();
    model->ppq = std::max(1, static_cast<int>(project["ppq"]));
    model->loopTicks = static_cast<juce::int64>(project["loopTicks"]);
    model->masterGain = static_cast<float>(static_cast<double>(project["masterGain"]));
    model->tempo = static_cast<double>(project["tempo"]);

    if (const auto* tracks = project["tracks"].getArray())
    {
        for (const auto& t : *tracks)
        {
            TrackModel tm;
            tm.slot = std::clamp(static_cast<int>(t["slot"]), 0, kMaxSlots - 1);
            tm.instrument = t["instrument"].toString() == "drums" ? kDrums : kSynth;
            tm.gain = static_cast<float>(static_cast<double>(t["gain"]));
            tm.pan = std::clamp(static_cast<float>(static_cast<double>(t["pan"])), -1.0f, 1.0f);
            if (const auto* arr = t["notes"].getArray())
            {
                for (const auto& n : *arr)
                {
                    NoteEvent e;
                    e.pitch = std::clamp(static_cast<int>(n["pitch"]), 0, 127);
                    e.velocity = std::clamp(static_cast<int>(n["velocity"]), 1, 127);
                    e.startTick = static_cast<juce::int64>(n["startTick"]);
                    e.endTick = std::min<juce::int64>(e.startTick + static_cast<juce::int64>(n["durationTicks"]), model->loopTicks);
                    if (e.startTick >= 0 && e.startTick < model->loopTicks && e.endTick > e.startTick)
                        tm.notes.push_back(e);
                }
            }
            std::stable_sort(tm.notes.begin(), tm.notes.end(),
                             [](const NoteEvent& a, const NoteEvent& b) { return a.startTick < b.startTick; });
            model->tracks.push_back(std::move(tm));
        }
    }
    return model;
}

std::string statusJson(AudioEngine& engine, juce::AudioDeviceManager& dm)
{
    std::string s = "{\"t\":\"status\",\"playing\":";
    s += engine.sequencer.isPlaying() ? "true" : "false";
    char buf[512];
    std::snprintf(buf, sizeof(buf),
                  ",\"tick\":%.2f,\"callbacks\":%llu,\"overruns\":%llu,\"peakLoad\":%.4f,\"xruns\":%d,\"masterL\":%.4f,\"masterR\":%.4f,\"slots\":[",
                  engine.sequencer.getTick(), static_cast<unsigned long long>(engine.callbacks.load()),
                  static_cast<unsigned long long>(engine.overruns.load()), engine.peakLoad.load(), dm.getXRunCount(),
                  engine.masterPeakL.exchange(0.0f), engine.masterPeakR.exchange(0.0f));
    s += buf;
    for (int i = 0; i < kMaxSlots; ++i)
    {
        std::snprintf(buf, sizeof(buf), i ? ",%.4f" : "%.4f", engine.slotPeak[i].exchange(0.0f));
        s += buf;
    }
    s += "]}";
    return s;
}
} // namespace

int main(int argc, char** argv)
{
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    int requestedBuffer = 0;
    for (int i = 1; i < argc; ++i)
    {
        const std::string a = argv[i];
        if (a == "--selftest") return runSelfTest();
        if (a == "--benchmark") return runBenchmark();
        if (a == "--buffer" && i + 1 < argc) requestedBuffer = std::atoi(argv[++i]);
    }

    juce::ScopedJuceInitialiser_GUI juceInit;

    AudioEngine engine;
    ModelStore models(engine.sequencer);
    juce::AudioDeviceManager deviceManager;

    bool audioOk = false;
    juce::String deviceName = "none", typeName = "none";
    const auto err = deviceManager.initialiseWithDefaultDevices(0, 2);
    if (err.isNotEmpty())
        sendLine("{\"t\":\"error\",\"message\":" + jsonEscape("audio init: " + err) + "}");

    if (auto* dev = deviceManager.getCurrentAudioDevice())
    {
        if (requestedBuffer > 0)
        {
            auto setup = deviceManager.getAudioDeviceSetup();
            setup.bufferSize = requestedBuffer;
            deviceManager.setAudioDeviceSetup(setup, true);
            dev = deviceManager.getCurrentAudioDevice();
        }
        if (dev != nullptr)
        {
            deviceManager.addAudioCallback(&engine);
            audioOk = true;
            deviceName = dev->getName();
            typeName = dev->getTypeName();
        }
    }

    char readyBuf[512];
    std::snprintf(readyBuf, sizeof(readyBuf),
                  "{\"t\":\"ready\",\"device\":%s,\"deviceType\":%s,\"sampleRate\":%.0f,\"bufferSize\":%d,\"version\":\"%s\"}",
                  jsonEscape(deviceName).c_str(), jsonEscape(typeName).c_str(), engine.sampleRate, engine.bufferSize, kVersion);
    sendLine(readyBuf);
    if (!audioOk)
        sendLine("{\"t\":\"error\",\"message\":\"no audio output device; running without sound\"}");

    std::atomic<bool> running{ true };
    std::thread statusThread([&] {
        while (running.load())
        {
            sendLine(statusJson(engine, deviceManager));
            models.purge();
            std::this_thread::sleep_for(std::chrono::milliseconds(33));
        }
    });

    // Offline WAV export runs on its own thread (separate AudioEngine instance) so live playback is undisturbed.
    std::thread exportThread;
    std::atomic<bool> exporting{ false };
    std::atomic<bool> cancelExport{ false };
    auto startExport = [&](const juce::String& id, const juce::String& path, double tailSeconds) {
        const std::string sid = id.toStdString();
        if (exporting.load())
        {
            sendLine("{\"t\":\"exportError\",\"id\":" + jsonEscape(id) + ",\"message\":\"an export is already running\"}");
            return;
        }
        auto model = models.copyCurrent();
        if (model == nullptr)
        {
            sendLine("{\"t\":\"exportError\",\"id\":" + jsonEscape(id) + ",\"message\":\"no project loaded\"}");
            return;
        }
        if (exportThread.joinable()) exportThread.join();
        exporting = true;
        cancelExport = false;
        exportThread = std::thread([&, id, path, tailSeconds, m = std::move(model)] {
#ifdef _WIN32
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL); // never compete with the audio thread
#endif
            juce::uint32 lastSent = 0;
            const auto progress = [&](double fraction) {
                const auto now = juce::Time::getMillisecondCounter();
                if (now - lastSent < 100 && fraction < 1.0) return;
                lastSent = now;
                char buf[160];
                std::snprintf(buf, sizeof(buf), ",\"fraction\":%.4f}", fraction);
                sendLine("{\"t\":\"exportProgress\",\"id\":" + jsonEscape(id) + buf);
            };
            const auto result = exportWav(*m, juce::File(path), kExportSampleRate, tailSeconds, progress, &cancelExport);
            if (result.ok)
            {
                char buf[256];
                std::snprintf(buf, sizeof(buf), ",\"frames\":%lld,\"sampleRate\":%.0f,\"seconds\":%.3f,\"peak\":%.5f}",
                              static_cast<long long>(result.frames), kExportSampleRate, static_cast<double>(result.frames) / kExportSampleRate, result.peak);
                sendLine("{\"t\":\"exportDone\",\"id\":" + jsonEscape(id) + ",\"path\":" + jsonEscape(path) + buf);
            }
            else
                sendLine("{\"t\":\"exportError\",\"id\":" + jsonEscape(id) + ",\"message\":" + jsonEscape(juce::String(result.error)) + "}");
            exporting = false;
        });
    };

    // Command loop (blocks until the parent closes our stdin).
    std::string line;
    while (std::getline(std::cin, line))
    {
        if (line.empty()) continue;
        const juce::var msg = juce::JSON::parse(juce::String(line));
        const juce::String type = msg["t"].toString();

        if (type == "loadProject")
        {
            const auto project = msg["project"];
            models.publish(parseModel(project));
            engine.sequencer.setBpm(static_cast<double>(project["tempo"]));
        }
        else if (type == "play") engine.sequencer.setPlaying(true);
        else if (type == "stop")
        {
            engine.sequencer.setPlaying(false);
            engine.sequencer.requestSeek(0.0);
        }
        else if (type == "seek") engine.sequencer.requestSeek(static_cast<double>(msg["tick"]));
        else if (type == "setTempo") engine.sequencer.setBpm(static_cast<double>(msg["bpm"]));
        else if (type == "preview")
            engine.pushPreview({ std::clamp(static_cast<int>(msg["slot"]), 0, kMaxSlots - 1), std::clamp(static_cast<int>(msg["pitch"]), 0, 127),
                                 std::clamp(static_cast<int>(msg["velocity"]), 1, 127), static_cast<bool>(msg["on"]) });
        else if (type == "exportWav") startExport(msg["id"].toString(), msg["path"].toString(), static_cast<double>(msg["tailSeconds"]));
        else if (type == "hello") sendLine(readyBuf);
    }

    cancelExport = true;
    if (exportThread.joinable()) exportThread.join();
    running = false;
    statusThread.join();
    deviceManager.removeAudioCallback(&engine);
    deviceManager.closeAudioDevice();
    return 0;
}
