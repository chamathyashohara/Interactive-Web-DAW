#include "Export.h"
#include "AudioEngine.h"
#include <juce_audio_formats/juce_audio_formats.h>
#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

int64_t songFrames(const PlaybackModel& model, double sampleRate)
{
    if (model.loopTicks <= 0 || model.tempo <= 0.0 || model.ppq <= 0)
        return 0;
    return static_cast<int64_t>(std::ceil(static_cast<double>(model.loopTicks) * 60.0 * sampleRate / (model.tempo * model.ppq) - 1e-9));
}

int64_t renderSong(const PlaybackModel& model, double sampleRate, double tailSeconds, const BlockSink& sink,
                   const std::function<void(double)>& progress, const std::atomic<bool>* cancel, const BlockProbe& probe)
{
    const int64_t song = songFrames(model, sampleRate);
    if (song <= 0)
        return 0;
    const int64_t tail = static_cast<int64_t>(std::llround(std::max(0.0, tailSeconds) * sampleRate));
    const int64_t total = song + tail;
    constexpr int kBlock = 512;

    auto engine = std::make_unique<AudioEngine>();
    engine->prepare(sampleRate, kBlock);
    engine->sequencer.setModel(&model);
    engine->sequencer.setBpm(model.tempo);
    engine->sequencer.setPlaying(true);

    // Plugin tracks: start a private host per plugin in BLOCKING mode so each block waits for the plugin (exact timing, no latency).
    // A plugin that fails to start is left silent in the file; the live hosts are never used for an export.
    engine->setUseModelPlugins(false);
    std::vector<std::unique_ptr<PluginClient>> exportHosts;
    const std::string hostExe = findPluginHostExe();
    for (const auto& tr : model.tracks)
    {
        if (tr.instrument != kPlugin || tr.pluginPath.empty() || hostExe.empty()) continue;
        auto client = std::make_unique<PluginClient>(hostExe, tr.pluginPath, writePluginStateFile(tr.pluginState), sampleRate, true);
        if (!client->launch()) continue;
        const auto t0 = juce::Time::getMillisecondCounter();
        while (client->state() == PluginState::Starting && juce::Time::getMillisecondCounter() - t0 < 60000)
        {
            if (cancel != nullptr && cancel->load()) { engine->sequencer.setModel(nullptr); return -1; }
            client->poll();
            juce::Thread::sleep(20);
        }
        if (client->state() == PluginState::Ready) engine->setPluginOverride(tr.slot, client.get());
        exportHosts.push_back(std::move(client));
    }

    std::vector<float> left(kBlock), right(kBlock), preL(kBlock), preR(kBlock);
    float* out[2] = { left.data(), right.data() };
    if (probe)
    {
        engine->preClipTapL = preL.data();
        engine->preClipTapR = preR.data();
    }

    int64_t done = 0;
    bool stopped = false;
    while (done < total)
    {
        if (cancel != nullptr && cancel->load())
        {
            engine->sequencer.setModel(nullptr);
            return -1;
        }
        if (!stopped && done >= song)
        {
            engine->sequencer.setPlaying(false); // song over: let releases ring out during the tail
            stopped = true;
        }
        int64_t n = std::min<int64_t>(kBlock, total - done);
        if (!stopped)
            n = std::min<int64_t>(n, song - done); // never straddle the song end
        const int block = static_cast<int>(n);
        engine->process(out, 2, block);
        if (probe) probe(*engine, preL.data(), preR.data(), block);
        sink(left.data(), right.data(), block);
        done += block;
        if (progress && (done % (kBlock * 40) < kBlock || done == total))
            progress(static_cast<double>(done) / static_cast<double>(total));
    }
    engine->sequencer.setModel(nullptr);
    for (auto& h : exportHosts) h->shutdown();
    return done;
}

ExportResult exportWav(const PlaybackModel& model, const juce::File& file, double sampleRate, double tailSeconds,
                       const std::function<void(double)>& progress, const std::atomic<bool>* cancel)
{
    ExportResult result;
    if (songFrames(model, sampleRate) <= 0)
    {
        result.error = "nothing to export (empty song)";
        return result;
    }

    file.deleteFile(); // createOutputStream would append to an existing file
    std::unique_ptr<juce::FileOutputStream> stream(file.createOutputStream());
    if (stream == nullptr || stream->failedToOpen())
    {
        result.error = "cannot write to " + file.getFullPathName().toStdString();
        return result;
    }

    juce::WavAudioFormat wav;
    std::unique_ptr<juce::AudioFormatWriter> writer(wav.createWriterFor(stream.get(), sampleRate, 2, 24, {}, 0));
    if (writer == nullptr)
    {
        result.error = "cannot create WAV writer";
        return result;
    }
    stream.release(); // the writer owns the stream now

    bool writeFailed = false;
    const auto sink = [&](const float* l, const float* r, int n) {
        const float* channels[2] = { l, r };
        if (!writer->writeFromFloatArrays(channels, 2, n))
            writeFailed = true;
        for (int i = 0; i < n; ++i)
            result.peak = std::max({ result.peak, static_cast<double>(std::fabs(l[i])), static_cast<double>(std::fabs(r[i])) });
    };

    const int64_t frames = renderSong(model, sampleRate, tailSeconds, sink, progress, cancel);
    writer.reset(); // flushes and finalises the header
    if (frames < 0)
    {
        file.deleteFile();
        result.error = "cancelled";
        return result;
    }
    if (writeFailed)
    {
        result.error = "disk write failed";
        return result;
    }
    result.ok = true;
    result.frames = frames;
    return result;
}

// ---------------------------------------------------------------------------------------------------------------- analysis

TruePeakMeter::TruePeakMeter()
{
    // The newest sample is hist[kTaps - 1]; the value between hist[5] and hist[6] at fraction p is a Hann-windowed sinc over all taps.
    const double pi = 3.14159265358979323846;
    for (int phase = 0; phase < 3; ++phase)
    {
        const double p = 0.25 * (phase + 1);
        const double centre = 5.0 + p;
        double sum = 0.0;
        double raw[kTaps] = {};
        for (int k = 0; k < kTaps; ++k)
        {
            const double d = centre - k;
            const double sinc = std::fabs(d) < 1e-9 ? 1.0 : std::sin(pi * d) / (pi * d);
            const double w = std::fabs(d) < 6.0 ? 0.5 * (1.0 + std::cos(pi * d / 6.0)) : 0.0;
            raw[k] = sinc * w;
            sum += raw[k];
        }
        for (int k = 0; k < kTaps; ++k) coef[phase][k] = static_cast<float>(raw[k] / sum); // exact at DC
    }
}

void TruePeakMeter::process(const float* x, int n)
{
    for (int i = 0; i < n; ++i)
    {
        for (int k = 0; k < kTaps - 1; ++k) hist[k] = hist[k + 1];
        hist[kTaps - 1] = x[i];
        maxPeak = std::max(maxPeak, std::fabs(x[i]));
        if (++filled < kTaps) continue;
        for (int phase = 0; phase < 3; ++phase)
        {
            float v = 0.0f;
            for (int k = 0; k < kTaps; ++k) v += coef[phase][k] * hist[k];
            maxPeak = std::max(maxPeak, std::fabs(v));
        }
    }
}

MixAnalysisResult analyzeMixOffline(const PlaybackModel& model, double sampleRate, double tailSeconds, const std::function<void(double)>& progress, const std::atomic<bool>* cancel)
{
    MixAnalysisResult r;
    r.sampleRate = sampleRate;
    r.bus.assign(kMaxSlots, 0.0f);
    r.sumSq.assign(kMaxSlots, 0.0);
    r.slotFrames.assign(kMaxSlots, 0);
    if (songFrames(model, sampleRate) <= 0)
    {
        r.error = "nothing to analyse (empty song)";
        return r;
    }
    TruePeakMeter tpL, tpR;
    const auto probe = [&](AudioEngine& e, const float* pl, const float* pr, int n) {
        tpL.process(pl, n);
        tpR.process(pr, n);
        for (int s = 0; s < kMaxSlots; ++s)
        {
            r.bus[static_cast<size_t>(s)] = std::max(r.bus[static_cast<size_t>(s)], e.slotBusPeak[s].exchange(0.0f));
            r.sumSq[static_cast<size_t>(s)] += e.slotSumSq[s].exchange(0.0);
            r.slotFrames[static_cast<size_t>(s)] += e.slotFrames[s].exchange(0);
        }
        r.prePeak = std::max(r.prePeak, e.masterPrePeak.exchange(0.0f));
        r.outPeak = std::max({ r.outPeak, e.masterPeakL.exchange(0.0f), e.masterPeakR.exchange(0.0f) });
        r.softClips += e.softClipSamples.exchange(0);
        r.overs += e.overSamples.exchange(0);
    };
    const int64_t frames = renderSong(model, sampleRate, tailSeconds, [](const float*, const float*, int) {}, progress, cancel, probe);
    if (frames < 0)
    {
        r.error = "cancelled";
        return r;
    }
    r.truePeak = std::max(tpL.peak(), tpR.peak());
    r.frames = frames;
    r.ok = true;
    return r;
}
