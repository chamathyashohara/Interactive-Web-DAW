#ifdef _WIN32
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif
#include "AudioEngine.h"
#include "Export.h"
#include "Samples.h"
#include "SelfTest.h"
#ifdef DAW_ENABLE_VST3
#include "PluginHost.h"
#endif
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
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
constexpr const char* kVersion = "0.6.0";
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
    ModelStore(Sequencer& s, SampleStore& st) : sequencer(s), samples(st) {}
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
                // Its samples may still be playing (a long loop): they are freed only after the last voice has ended.
                for (auto& tr : retired[i].model->tracks) samples.keep(tr.sample);
                delete retired[i].model;
                retired.erase(retired.begin() + static_cast<long>(i));
            }
            else ++i;
        }
    }

private:
    struct Retired { PlaybackModel* model; juce::uint32 at; };
    Sequencer& sequencer;
    SampleStore& samples;
    std::mutex mutex;
    PlaybackModel* current = nullptr;
    std::vector<Retired> retired;
};

PlaybackModel* parseModel(const juce::var& project, SampleStore& samples, std::vector<std::string>& problems)
{
    auto* model = new PlaybackModel();
    model->ppq = std::max(1, static_cast<int>(project["ppq"]));
    model->loopTicks = static_cast<juce::int64>(project["loopTicks"]);
    model->loopStartTick = static_cast<juce::int64>(project["loopStartTick"]);
    model->loopEndTick = static_cast<juce::int64>(project["loopEndTick"]);
    model->masterGain = static_cast<float>(static_cast<double>(project["masterGain"]));
    model->tempo = static_cast<double>(project["tempo"]);

    if (const auto* tracks = project["tracks"].getArray())
    {
        for (const auto& t : *tracks)
        {
            TrackModel tm;
            tm.slot = std::clamp(static_cast<int>(t["slot"]), 0, kMaxSlots - 1);
            const juce::String kind = t["instrument"].toString();
            tm.instrument = kind == "drums" ? kDrums : (kind == "sample" ? kSample : kSynth);
            if (tm.instrument == kSample)
            {
                tm.gate = static_cast<bool>(t["gate"]);
                const std::string path = t["samplePath"].toString().toStdString();
                if (!path.empty())
                {
                    std::string error;
                    const double ratio = static_cast<double>(t["stretchRatio"]);
                    tm.sample = ratio > 0.0 ? samples.getStretched(path, ratio, error) : samples.get(path, error);
                    if (tm.sample == nullptr) problems.push_back("sample track: " + error);
                }
            }
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
                    if (tm.instrument == kSample)
                    {
                        if (n.hasProperty("gain")) e.gain = std::clamp(static_cast<float>(static_cast<double>(n["gain"])), 0.0f, 8.0f);
                        e.offsetSec = std::max(0.0, static_cast<double>(n["offsetSec"]));
                        e.fadeInSec = std::max(0.0, static_cast<double>(n["fadeInSec"]));
                        e.fadeOutSec = std::max(0.0, static_cast<double>(n["fadeOutSec"]));
                        e.cut = static_cast<bool>(n["cut"]);
                        e.lengthSec = static_cast<double>(e.endTick - e.startTick) * 60.0 / (model->tempo * model->ppq);
                    }
                    if (e.startTick >= 0 && e.startTick < model->loopTicks && e.endTick > e.startTick)
                        tm.notes.push_back(e);
                }
            }
            if (const auto automation = t["automation"]; automation.isObject())
            {
                const auto readCurve = [](const juce::var& curve, std::vector<AutoPoint>& out) {
                    if (const auto* arr = curve.getArray())
                        for (const auto& pt : *arr)
                            if (const auto* pair = pt.getArray(); pair != nullptr && pair->size() == 2)
                                out.push_back({ static_cast<double>((*pair)[0]), std::clamp(static_cast<float>(static_cast<double>((*pair)[1])), 0.0f, 1.0f) });
                    std::stable_sort(out.begin(), out.end(), [](const AutoPoint& a, const AutoPoint& b) { return a.tick < b.tick; });
                };
                readCurve(automation["volume"], tm.volumeAuto);
                readCurve(automation["filter"], tm.filterAuto);
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
                  ",\"tick\":%.2f,\"callbacks\":%llu,\"overruns\":%llu,\"peakLoad\":%.4f,\"xruns\":%d,\"masterL\":%.4f,\"masterR\":%.4f,\"preview\":%.4f,\"slots\":[",
                  engine.sequencer.getTick(), static_cast<unsigned long long>(engine.callbacks.load()),
                  static_cast<unsigned long long>(engine.overruns.load()), engine.peakLoad.load(), dm.getXRunCount(),
                  engine.masterPeakL.exchange(0.0f), engine.masterPeakR.exchange(0.0f), static_cast<double>(engine.preview.fraction()));
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
#ifdef DAW_ENABLE_VST3
        if (a == "--plugintest" && i + 1 < argc) return runPluginTest(argv[++i]);
#endif
        if (a == "--buffer" && i + 1 < argc) requestedBuffer = std::atoi(argv[++i]);
    }

    juce::ScopedJuceInitialiser_GUI juceInit;

    AudioEngine engine;
    engine.setLoopRegionEnabled(true);
    SampleStore samples;
    ModelStore models(engine.sequencer, samples);
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
            samples.purge();
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

    // Sample jobs (decode for the browser preview, decode + waveform for imports) run on one worker thread,
    // so slow disks never delay transport or note commands. Only the newest preview request is honoured.
    std::mutex jobMutex;
    std::condition_variable jobCv;
    std::deque<std::function<void()>> jobs;
    bool jobsClosed = false;
    std::atomic<int> previewRequest{ 0 };
    std::thread sampleThread([&] {
        for (;;)
        {
            std::function<void()> job;
            {
                std::unique_lock<std::mutex> lock(jobMutex);
                jobCv.wait(lock, [&] { return jobsClosed || !jobs.empty(); });
                if (jobs.empty()) return;
                job = std::move(jobs.front());
                jobs.pop_front();
            }
            job();
        }
    });
    auto enqueue = [&](std::function<void()> job) {
        {
            std::lock_guard<std::mutex> lock(jobMutex);
            jobs.push_back(std::move(job));
        }
        jobCv.notify_one();
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
            std::vector<std::string> problems;
            models.publish(parseModel(project, samples, problems));
            for (const auto& p : problems) sendLine("{\"t\":\"error\",\"message\":" + jsonEscape(juce::String(p)) + "}");
            engine.sequencer.setBpm(static_cast<double>(project["tempo"]));
        }
        else if (type == "play") engine.sequencer.setPlaying(true);
        else if (type == "stop")
        {
            engine.cutSamples();
            engine.sequencer.setPlaying(false);
            engine.sequencer.requestSeek(0.0);
        }
        else if (type == "seek") engine.sequencer.requestSeek(static_cast<double>(msg["tick"]));
        else if (type == "setTempo") engine.sequencer.setBpm(static_cast<double>(msg["bpm"]));
        else if (type == "setMetronome") engine.setMetronome(static_cast<bool>(msg["on"]));
        else if (type == "preview")
            engine.pushPreview({ std::clamp(static_cast<int>(msg["slot"]), 0, kMaxSlots - 1), std::clamp(static_cast<int>(msg["pitch"]), 0, 127),
                                 std::clamp(static_cast<int>(msg["velocity"]), 1, 127), static_cast<bool>(msg["on"]) });
        else if (type == "exportWav") startExport(msg["id"].toString(), msg["path"].toString(), static_cast<double>(msg["tailSeconds"]));
        else if (type == "analyzeSample")
        {
            const juce::String id = msg["id"].toString();
            const std::string path = msg["path"].toString().toStdString();
            enqueue([&, id, path] {
                std::string error;
                const auto data = samples.get(path, error);
                if (data == nullptr)
                {
                    sendLine("{\"t\":\"sampleInfo\",\"id\":" + jsonEscape(id) + ",\"ok\":false,\"message\":" + jsonEscape(juce::String(error)) + "}");
                    return;
                }
                std::string peaks = "[";
                const auto p = samplePeaks(*data);
                for (size_t i = 0; i < p.size(); ++i) peaks += (i ? "," : "") + std::to_string(p[i]);
                peaks += "]";
                char buf[256];
                std::snprintf(buf, sizeof(buf), ",\"ok\":true,\"durationSec\":%.4f,\"sampleRate\":%.0f,\"channels\":%d,\"frames\":%lld,\"peak\":%.5f,\"peaks\":",
                              static_cast<double>(data->frames) / data->sampleRate, data->sampleRate, data->channels, static_cast<long long>(data->frames),
                              static_cast<double>(data->peak));
                sendLine("{\"t\":\"sampleInfo\",\"id\":" + jsonEscape(id) + buf + peaks + "}");
            });
        }
        else if (type == "previewSample")
        {
            const std::string path = msg["path"].toString().toStdString();
            const float gain = std::clamp(static_cast<float>(static_cast<double>(msg["gain"])), 0.0f, 2.0f);
            const int request = ++previewRequest;
            enqueue([&, path, gain, request] {
                if (request != previewRequest.load()) return; // a newer click already replaced this one
                std::string error;
                const auto data = samples.get(path, error);
                if (data == nullptr)
                {
                    sendLine("{\"t\":\"error\",\"message\":" + jsonEscape(juce::String("preview: " + error)) + "}");
                    return;
                }
                if (request != previewRequest.load()) return;
                samples.hold(data);
                engine.preview.start(data.get(), gain);
            });
        }
        else if (type == "stopPreview")
        {
            ++previewRequest; // cancels a preview that is still loading
            engine.preview.stop();
        }
        else if (type == "hello") sendLine(readyBuf);
    }

    cancelExport = true;
    if (exportThread.joinable()) exportThread.join();
    {
        std::lock_guard<std::mutex> lock(jobMutex);
        jobsClosed = true;
    }
    jobCv.notify_one();
    sampleThread.join();
    running = false;
    statusThread.join();
    deviceManager.removeAudioCallback(&engine);
    deviceManager.closeAudioDevice();
    return 0;
}
