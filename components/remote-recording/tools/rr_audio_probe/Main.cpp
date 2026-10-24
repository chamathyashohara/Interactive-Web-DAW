// rr_audio_probe: command-line check of the real capture and local-recording path, without
// the GUI. Uses exactly the same library code as the two apps (rr_audio).
//
//   rr_audio_probe --list
//   rr_audio_probe --record <seconds> --out <folder> [--device <index>] [--any-rate] [--role producer|performer]
//   rr_audio_probe --monitor <seconds> [--device <in>] [--output <out>] [--gain-db <g>] [--any-rate]
//                  [--reopen-input-at <second>]   (re-opens the input while the output runs)
//   rr_audio_probe --tone <seconds> [--output <out>] [--level-dbfs <l>]   (plays a test tone)
//   rr_audio_probe --inspect <file.wav | file.wav.partial>
//   rr_audio_probe --recover <file.wav.partial>
//
// Exit code 0 = success, 1 = failure (message on stderr), 2 = usage error.

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

#include "rr/audio/AudioEngine.h"
#include "rr/audio/FileIo.h"
#include "rr/audio/TakeNaming.h"
#include "rr/audio/WavInspect.h"
#include "rr/shared/BuildInfo.h"
#include "rr/shared/Clock.h"

namespace
{

int usage()
{
    std::fprintf(stderr,
                 "usage:\n"
                 "  rr_audio_probe --list\n"
                 "  rr_audio_probe --record <seconds> --out <folder> [--device <index>] [--any-rate]"
                 " [--role producer|performer]\n"
                 "  rr_audio_probe --monitor <seconds> [--device <in>] [--output <out>] [--gain-db <g>] [--any-rate]\n"
                 "  rr_audio_probe --tone <seconds> [--output <out>] [--level-dbfs <l>]\n"
                 "  rr_audio_probe --inspect <file>\n"
                 "  rr_audio_probe --recover <file.wav.partial>\n");
    return 2;
}

double toDbfs(float peak)
{
    return peak > 1e-6f ? 20.0 * std::log10(static_cast<double>(peak)) : -120.0;
}

void printInfo(const std::filesystem::path& path, const WavInfo& info)
{
    std::printf("file: %s\n", pathToUtf8(path).c_str());
    std::printf("  valid finished float32 WAV: %s\n", info.isCompleteFloatWav() ? "YES" : "NO");
    std::printf("  format tag %u, %u ch, %u Hz, %u bits, block %u\n", info.formatTag, info.channels,
                info.sampleRate, info.bitsPerSample, info.blockAlign);
    std::printf("  file %llu bytes, data offset %llu, data in header %llu, data present %llu\n",
                static_cast<unsigned long long>(info.fileBytes), static_cast<unsigned long long>(info.dataOffset),
                static_cast<unsigned long long>(info.dataBytesInHeader),
                static_cast<unsigned long long>(info.dataBytesInFile));
    std::printf("  frames %llu (fact %llu), duration %.3f s\n", static_cast<unsigned long long>(info.frames),
                static_cast<unsigned long long>(info.factFrames),
                info.sampleRate ? static_cast<double>(info.frames) / info.sampleRate : 0.0);
    for (const auto& p : info.problems)
    {
        std::printf("  problem: %s\n", p.c_str());
    }
}

int listDevices()
{
    AudioEngine engine;
    std::string error;
    if (!engine.initialise(error))
    {
        std::fprintf(stderr, "%s\n", error.c_str());
        return 1;
    }
    std::printf("backend: %s\n\nINPUT devices:\n", engine.backendName().c_str());
    for (const auto& d : engine.captureDevices(error))
    {
        std::printf("  %2zu  %s%s\n", d.index, d.name.c_str(), d.isDefault ? "   [default]" : "");
    }
    std::printf("\nOUTPUT devices:\n");
    for (const auto& d : engine.playbackDevices(error))
    {
        std::printf("  %2zu  %s%s\n", d.index, d.name.c_str(), d.isDefault ? "   [default]" : "");
    }
    return error.empty() ? 0 : 1;
}

int record(double seconds, const std::filesystem::path& outRoot, long deviceIndex, bool anyRate, Role role)
{
    AudioEngine engine;
    std::string error;
    if (!engine.initialise(error))
    {
        std::fprintf(stderr, "%s\n", error.c_str());
        return 1;
    }
    const auto devices = engine.captureDevices(error);
    if (devices.empty())
    {
        std::fprintf(stderr, "no input devices found %s\n", error.c_str());
        return 1;
    }
    size_t index = 0;
    if (deviceIndex >= 0)
    {
        index = static_cast<size_t>(deviceIndex);
    }
    else
    {
        for (const auto& d : devices)
        {
            if (d.isDefault)
            {
                index = d.index;
            }
        }
    }
    if (index >= devices.size())
    {
        std::fprintf(stderr, "no input device %zu\n", index);
        return 1;
    }

    CaptureOptions options;
    options.requiredSampleRate = anyRate ? 0 : 48000;
    if (!engine.openCapture(index, options, RecorderOptions{}, error))
    {
        std::fprintf(stderr, "open failed: %s\n", error.c_str());
        return 1;
    }
    const CaptureDescription& desc = engine.captureDescription();
    std::printf("device: [%zu] %s via %s\n", index, desc.deviceName.c_str(), desc.backend.c_str());
    std::printf("format written: float32, %u ch, %u Hz\n", desc.channels, desc.sampleRate);
    std::printf("device internal: %s, %u ch, %u Hz, period %u frames x %u\n", desc.deviceInternalFormat.c_str(),
                desc.deviceInternalChannels, desc.deviceInternalRate, desc.devicePeriodFrames,
                desc.devicePeriods);
    for (const auto& note : desc.conversionNotes)
    {
        std::printf("note: %s\n", note.c_str());
    }

    const std::string sessionId = makeSessionId();
    const std::filesystem::path sessionDir =
        outRoot / sessionFolderName(utcNowMs(), sessionId);
    std::error_code ec;
    std::filesystem::create_directories(sessionDir, ec);
    if (ec)
    {
        std::fprintf(stderr, "cannot create %s: %s\n", pathToUtf8(sessionDir).c_str(), ec.message().c_str());
        return 1;
    }

    TakeRequest request;
    request.sessionDir = sessionDir;
    request.takeNumber = nextFreeTakeNumber(sessionDir, role, sessionId);
    request.role = role;
    request.sessionId = sessionId;
    request.appVersion = buildInfo().version + " (rr_audio_probe)";
    request.maxTakeSeconds = 1800;
    request.capture = desc;
    if (!engine.recorder()->beginTake(request, error))
    {
        std::fprintf(stderr, "begin take failed: %s\n", error.c_str());
        return 1;
    }

    const auto start = std::chrono::steady_clock::now();
    double nextReport = 1.0;
    std::vector<float> peaks(desc.channels, 0.0f);
    while (true)
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        for (uint32_t c = 0; c < desc.channels; ++c)
        {
            const float p = engine.ingest()->takeLevels(c).peak;
            if (p > peaks[c])
            {
                peaks[c] = p;
            }
        }
        const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
        if (elapsed >= nextReport)
        {
            const RecorderStatus st = engine.recorder()->status();
            std::printf("t=%4.1fs state=%s frames=%llu peak dBFS:", elapsed, recorderStateName(st.state),
                        static_cast<unsigned long long>(st.framesWritten));
            for (uint32_t c = 0; c < desc.channels; ++c)
            {
                std::printf(" ch%u %.1f", c + 1, toDbfs(peaks[c]));
                peaks[c] = 0.0f;
            }
            std::printf("\n");
            nextReport += 1.0;
        }
        if (elapsed >= seconds)
        {
            break;
        }
    }
    engine.recorder()->endTake(StopReason::User);
    std::vector<TakeMetadata> results;
    for (int i = 0; i < 300 && results.empty(); ++i)
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        results = engine.recorder()->takeFinished();
    }
    const IngestStats stats = engine.ingest()->stats();
    engine.closeCapture();
    if (results.empty())
    {
        std::fprintf(stderr, "take did not finish within 3 s\n");
        return 1;
    }
    const TakeMetadata& m = results.front();
    std::printf("\nresult: status=%s finalised=%s stop=%s frames=%llu duration=%.3fs has_gaps=%s\n",
                std::string(takeStatusName(m.status)).c_str(), m.finalised ? "yes" : "NO",
                m.stopReason.c_str(), static_cast<unsigned long long>(m.frames), m.durationSeconds(),
                m.hasGaps ? "YES" : "no");
    if (!m.error.empty())
    {
        std::printf("error: %s\n", m.error.c_str());
    }
    std::printf("capture stats: callbacks=%llu frames=%llu overruns=%llu (frames %llu) timing_anomalies=%llu "
                "clipped=%llu max_callback_us=%.1f\n",
                static_cast<unsigned long long>(stats.callbacks), static_cast<unsigned long long>(stats.framesCaptured),
                static_cast<unsigned long long>(stats.overrunEvents), static_cast<unsigned long long>(stats.overrunFrames),
                static_cast<unsigned long long>(stats.timingAnomalies), static_cast<unsigned long long>(stats.clippedSamples),
                static_cast<double>(stats.maxCallbackNs) / 1000.0);
    std::printf("metadata: %s\n", pathToUtf8(sessionDir / m.metadataFileName).c_str());
    const std::filesystem::path wav = sessionDir / (m.finalised ? m.fileName : m.partialFileName);
    const WavInfo info = inspectWav(wav);
    printInfo(wav, info);
    const bool framesMatch = info.frames == m.frames;
    std::printf("frames in file == metadata: %s\n", framesMatch ? "yes" : "NO");
    return (m.status == TakeStatus::Complete && info.isCompleteFloatWav() && framesMatch) ? 0 : 1;
}

size_t defaultIndex(const std::vector<DeviceInfo>& devices)
{
    for (const auto& d : devices)
    {
        if (d.isDefault)
        {
            return d.index;
        }
    }
    return 0;
}

// Capture -> monitor bus -> output for `seconds`, or (toneOnly) just a test tone. Prints one
// line of buffer/level counters per second and the engine report at the end.
int monitor(double seconds, long input, long output, float gainDb, bool anyRate, bool toneOnly, float toneDbfs,
            int reopenInputAt)
            {
    AudioEngine engine;
    std::string error;
    if (!engine.initialise(error))
    {
        std::fprintf(stderr, "%s\n", error.c_str());
        return 1;
    }
    const auto inputs = engine.captureDevices(error);
    const auto outputs = engine.playbackDevices(error);
    if (outputs.empty() || (!toneOnly && inputs.empty()))
    {
        std::fprintf(stderr, "missing devices %s\n", error.c_str());
        return 1;
    }
    const size_t inIndex = input >= 0 ? static_cast<size_t>(input) : defaultIndex(inputs);
    const size_t outIndex = output >= 0 ? static_cast<size_t>(output) : defaultIndex(outputs);
    if (!toneOnly)
    {
        CaptureOptions options;
        options.requiredSampleRate = anyRate ? 0 : 48000;
        if (!engine.openCapture(inIndex, options, RecorderOptions{}, error))
        {
            std::fprintf(stderr, "input: %s\n", error.c_str());
            return 1;
        }
    }
    if (!engine.openPlayback(outIndex, PlaybackOptions{}, error))
    {
        std::fprintf(stderr, "output: %s\n", error.c_str());
        return 1;
    }
    const PlaybackDescription& pd = engine.playbackDescription();
    std::printf("input:  %s\noutput: %s (renders %u Hz, %u ch; device stream %s, %u Hz, %u ch)\n",
                toneOnly ? "(none: tone only)" : engine.captureDescription().deviceName.c_str(),
                pd.deviceName.c_str(), pd.sampleRate, pd.channels, pd.deviceInternalFormat.c_str(),
                pd.deviceInternalRate, pd.deviceInternalChannels);
    for (const auto& n : pd.notes)
    {
        std::printf("monitor note: %s\n", n.c_str());
    }
    engine.monitor().setGainDb(gainDb);
    if (toneOnly)
    {
        engine.monitor().startTestTone(440.0f, toneDbfs, static_cast<float>(seconds));
    }
    else
    {
        engine.monitor().setEnabled(true);
    }
    const auto start = std::chrono::steady_clock::now();
    const int wholeSeconds = static_cast<int>(std::ceil(seconds));
    for (int second = 1; second <= wholeSeconds; ++second)
    {
        std::this_thread::sleep_until(start + std::chrono::seconds(second));
        if (second == reopenInputAt && !toneOnly)
        {
            CaptureOptions options;
            options.requiredSampleRate = anyRate ? 0 : 48000;
            const bool ok = engine.openCapture(inIndex, options, RecorderOptions{}, error);
            std::printf("t=%2ds RE-OPENED INPUT while output running: %s %s (output open: %s)\n", second,
                        ok ? "ok" : "FAILED", error.c_str(), engine.playbackOpen() ? "yes" : "NO");
            error.clear();
        }
        const MonitorStats m = engine.monitor().stats();
        const double rate = engine.monitor().getSampleRate();
        std::printf("t=%2ds monitor fill %.1f ms (max %.1f) underruns %llu overflows %llu trims %llu played %llu",
                    second, 1000.0 * m.fillFrames / rate, 1000.0 * m.maxFillFrames / rate,
                    static_cast<unsigned long long>(m.underrunEvents), static_cast<unsigned long long>(m.overflowEvents),
                    static_cast<unsigned long long>(m.driftTrimEvents), static_cast<unsigned long long>(m.playedFrames));
        if (CaptureIngest* ingest = engine.ingest())
        {
            const ChannelLevels l = ingest->takeLevels(0);
            std::printf(" | in ch1 peak %.1f rms %.1f dBFS clip %llu", toDbfs(l.peak), toDbfs(l.rms),
                        static_cast<unsigned long long>(l.clipped));
        }
        std::printf("\n");
    }
    std::printf("\nengine report:\n%s\n", engineReportJson(engine).c_str());
    engine.monitor().setEnabled(false);
    const MonitorStats finalStats = engine.monitor().stats();
    const bool faults = engine.playbackFault() != DeviceFault::None || engine.captureFault() != DeviceFault::None;
    engine.closePlayback();
    engine.closeCapture();
    return (!faults && finalStats.renderCallbacks > 0) ? 0 : 1;
}

}  // namespace

int main(int argc, char* argv[])
{
    if (argc < 2)
    {
        return usage();
    }
    const std::string cmd = argv[1];
    if (cmd == "--list")
    {
        return listDevices();
    }
    if (cmd == "--inspect" && argc == 3)
    {
        const WavInfo info = inspectWav(argv[2]);
        printInfo(argv[2], info);
        return info.isCompleteFloatWav() ? 0 : 1;
    }
    if (cmd == "--recover" && argc == 3)
    {
        const RecoveryResult r = recoverPartial(argv[2]);
        if (!r.ok)
        {
            std::fprintf(stderr, "recovery failed: %s\n", r.error.c_str());
            return 1;
        }
        std::printf("recovered %llu frames into %s (dropped %llu trailing bytes); original kept\n",
                    static_cast<unsigned long long>(r.frames), pathToUtf8(r.recoveredPath).c_str(),
                    static_cast<unsigned long long>(r.trailingBytesDropped));
        return 0;
    }
    if (cmd == "--monitor" || cmd == "--tone")
    {
        double seconds = 0;
        long input = -1;
        long output = -1;
        float gainDb = 0.0f;
        float levelDbfs = -20.0f;
        bool anyRate = false;
        int reopenAt = -1;
        for (int i = 1; i < argc; ++i)
        {
            const std::string a = argv[i];
            if (a == "--reopen-input-at" && i + 1 < argc)
            {
                reopenAt = std::atoi(argv[++i]);
            }
            else if ((a == "--monitor" || a == "--tone") && i + 1 < argc)
            {
                seconds = std::atof(argv[++i]);
            }
            else if (a == "--device" && i + 1 < argc)
            {
                input = std::atol(argv[++i]);
            }
            else if (a == "--output" && i + 1 < argc)
            {
                output = std::atol(argv[++i]);
            }
            else if (a == "--gain-db" && i + 1 < argc)
            {
                gainDb = static_cast<float>(std::atof(argv[++i]));
            }
            else if (a == "--level-dbfs" && i + 1 < argc)
            {
                levelDbfs = static_cast<float>(std::atof(argv[++i]));
            }
            else if (a == "--any-rate")
            {
                anyRate = true;
            }
            else
            {
                return usage();
            }
        }
        if (seconds <= 0)
        {
            return usage();
        }
        return monitor(seconds, input, output, gainDb, anyRate, cmd == "--tone", levelDbfs, reopenAt);
    }
    if (cmd == "--record")
    {
        double seconds = 0;
        std::filesystem::path out;
        long device = -1;
        bool anyRate = false;
        Role role = Role::Producer;
        for (int i = 1; i < argc; ++i)
        {
            const std::string a = argv[i];
            if (a == "--record" && i + 1 < argc)
            {
                seconds = std::atof(argv[++i]);
            }
            else if (a == "--out" && i + 1 < argc)
            {
                out = argv[++i];
            }
            else if (a == "--device" && i + 1 < argc)
            {
                device = std::atol(argv[++i]);
            }
            else if (a == "--any-rate")
            {
                anyRate = true;
            }
            else if (a == "--role" && i + 1 < argc)
            {
                role = std::strcmp(argv[++i], "performer") == 0 ? Role::Performer : Role::Producer;
            }
            else
            {
                return usage();
            }
        }
        if (seconds <= 0 || out.empty())
        {
            return usage();
        }
        return record(seconds, out, device, anyRate, role);
    }
    return usage();
}
