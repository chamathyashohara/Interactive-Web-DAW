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
                   const std::function<void(double)>& progress, const std::atomic<bool>* cancel)
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

    std::vector<float> left(kBlock), right(kBlock);
    float* out[2] = { left.data(), right.data() };

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
        sink(left.data(), right.data(), block);
        done += block;
        if (progress && (done % (kBlock * 40) < kBlock || done == total))
            progress(static_cast<double>(done) / static_cast<double>(total));
    }
    engine->sequencer.setModel(nullptr);
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
