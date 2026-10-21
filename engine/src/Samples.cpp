#include "Samples.h"
#include "signalsmith-stretch.h"
#include <algorithm>
#include <cmath>

std::shared_ptr<SampleData> loadSample(const juce::File& file, std::string& error)
{
    if (!file.existsAsFile())
    {
        error = "file not found";
        return nullptr;
    }
    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(file));
    if (reader == nullptr)
    {
        error = "unsupported or damaged audio file";
        return nullptr;
    }
    if (reader->sampleRate < 8000.0 || reader->sampleRate > 384000.0 || reader->numChannels < 1 || reader->lengthInSamples <= 0)
    {
        error = "unusable audio format";
        return nullptr;
    }
    if (static_cast<double>(reader->lengthInSamples) / reader->sampleRate > kMaxSampleSeconds)
    {
        error = "sample is longer than 15 minutes";
        return nullptr;
    }

    auto data = std::make_shared<SampleData>();
    data->sampleRate = reader->sampleRate;
    data->frames = reader->lengthInSamples;
    data->channels = reader->numChannels >= 2 ? 2 : 1;
    const int n = static_cast<int>(data->frames);

    juce::AudioBuffer<float> buf(static_cast<int>(std::min<unsigned>(reader->numChannels, 2u)), n);
    if (!reader->read(&buf, 0, n, 0, true, true))
    {
        error = "could not read the audio data";
        return nullptr;
    }
    data->left.assign(buf.getReadPointer(0), buf.getReadPointer(0) + n);
    if (data->channels == 2) data->right.assign(buf.getReadPointer(1), buf.getReadPointer(1) + n);

    float peak = 0.0f;
    for (float v : data->left) peak = std::max(peak, std::fabs(v));
    for (float v : data->right) peak = std::max(peak, std::fabs(v));
    if (!std::isfinite(peak))
    {
        error = "audio contains invalid values";
        return nullptr;
    }
    data->peak = peak;
    return data;
}

std::vector<int> samplePeaks(const SampleData& s, int buckets)
{
    std::vector<float> raw(static_cast<size_t>(buckets), 0.0f);
    float global = 0.0f;
    for (int b = 0; b < buckets; ++b)
    {
        const int64_t from = s.frames * b / buckets;
        const int64_t to = std::max<int64_t>(from + 1, s.frames * (b + 1) / buckets);
        float m = 0.0f;
        for (int64_t i = from; i < to && i < s.frames; ++i)
        {
            m = std::max(m, std::fabs(s.left[static_cast<size_t>(i)]));
            if (!s.right.empty()) m = std::max(m, std::fabs(s.right[static_cast<size_t>(i)]));
        }
        raw[static_cast<size_t>(b)] = m;
        global = std::max(global, m);
    }
    std::vector<int> out(static_cast<size_t>(buckets), 0);
    if (global > 0.0f)
        for (int b = 0; b < buckets; ++b) out[static_cast<size_t>(b)] = static_cast<int>(std::lround(raw[static_cast<size_t>(b)] / global * 255.0f));
    return out;
}

// ------------------------------------------------------------------------------------------------ SampleStore
std::shared_ptr<SampleData> SampleStore::get(const std::string& path, std::string& error)
{
    {
        std::lock_guard<std::mutex> lock(mutex);
        const auto it = cache.find(path);
        if (it != cache.end())
        {
            lru.erase(std::remove(lru.begin(), lru.end(), path), lru.end());
            lru.push_back(path);
            return it->second;
        }
    }
    auto data = loadSample(juce::File(juce::String::fromUTF8(path.c_str())), error);
    if (data == nullptr) return nullptr;
    std::lock_guard<std::mutex> lock(mutex);
    cache[path] = data;
    lru.push_back(path);
    while (lru.size() > 24) // about 24 recent samples; one still playing stays alive through `retired`
    {
        retired.push_back({ cache[lru.front()], juce::Time::getMillisecondCounter() });
        cache.erase(lru.front());
        lru.pop_front();
    }
    return data;
}

void SampleStore::keep(std::shared_ptr<const SampleData> s)
{
    if (s == nullptr) return;
    std::lock_guard<std::mutex> lock(mutex);
    retired.push_back({ std::move(s), juce::Time::getMillisecondCounter() });
}

void SampleStore::hold(std::shared_ptr<SampleData> s)
{
    std::lock_guard<std::mutex> lock(mutex);
    if (held != nullptr && held != s) retired.push_back({ held, juce::Time::getMillisecondCounter() });
    held = std::move(s);
}

void SampleStore::purge()
{
    std::lock_guard<std::mutex> lock(mutex);
    const auto now = juce::Time::getMillisecondCounter();
    for (size_t i = 0; i < retired.size();)
    {
        // Free only when nothing else holds it, it has been idle a while, and no audio voice is reading it.
        if (now - retired[i].at > 3000 && retired[i].data.use_count() == 1 && retired[i].data->voices.load(std::memory_order_acquire) == 0)
            retired.erase(retired.begin() + static_cast<long>(i));
        else ++i;
    }
}

// ---------------------------------------------------------------------------------------------- SamplePreview
void SamplePreview::prepare(double rate)
{
    deviceRate = rate;
    fadeInStep = static_cast<float>(1.0 / (0.001 * rate));   // 1 ms
    fadeOutStep = static_cast<float>(1.0 / (0.006 * rate));  // 6 ms
    cur = Voice();
    old = Voice();
    frac.store(-1.0f);
}

void SamplePreview::start(const SampleData* data, float gain)
{
    pendingGain.store(gain, std::memory_order_relaxed);
    pendingData.store(data, std::memory_order_release);
    pendingSerial.fetch_add(1, std::memory_order_release);
}

void SamplePreview::stop()
{
    stopSerial.fetch_add(1, std::memory_order_release);
}

void SamplePreview::mix(Voice& v, float* L, float* R, int n, bool& finished)
{
    finished = false;
    const SampleData& d = *v.data;
    const double step = d.sampleRate / deviceRate;
    for (int i = 0; i < n; ++i)
    {
        const auto i0 = static_cast<int64_t>(v.pos);
        if (i0 >= d.frames - 1)
        {
            finished = true;
            return;
        }
        const float t = static_cast<float>(v.pos - static_cast<double>(i0));
        const float l = d.left[static_cast<size_t>(i0)] * (1.0f - t) + d.left[static_cast<size_t>(i0 + 1)] * t;
        float r = l;
        if (!d.right.empty()) r = d.right[static_cast<size_t>(i0)] * (1.0f - t) + d.right[static_cast<size_t>(i0 + 1)] * t;
        if (v.fadingOut)
        {
            v.env -= fadeOutStep;
            if (v.env <= 0.0f)
            {
                finished = true;
                return;
            }
        }
        else if (v.env < 1.0f) v.env = std::min(1.0f, v.env + fadeInStep);
        const float g = v.gain * v.env;
        L[i] += l * g;
        R[i] += r * g;
        v.pos += step;
    }
}

void SamplePreview::renderAdd(float* L, float* R, int n)
{
    const int serial = pendingSerial.load(std::memory_order_acquire);
    if (serial != seenSerial)
    {
        seenSerial = serial;
        const SampleData* d = pendingData.load(std::memory_order_acquire);
        if (cur.data != nullptr)
        {
            old = cur;
            old.fadingOut = true;
        }
        cur = Voice();
        cur.data = d;
        cur.gain = pendingGain.load(std::memory_order_relaxed);
    }
    const int stopped = stopSerial.load(std::memory_order_acquire);
    if (stopped != seenStop)
    {
        seenStop = stopped;
        if (cur.data != nullptr) cur.fadingOut = true;
    }

    bool finished = false;
    if (old.data != nullptr)
    {
        mix(old, L, R, n, finished);
        if (finished) old = Voice();
    }
    if (cur.data != nullptr)
    {
        mix(cur, L, R, n, finished);
        if (finished)
        {
            cur = Voice();
            frac.store(-1.0f, std::memory_order_relaxed);
        }
        else frac.store(static_cast<float>(cur.pos / static_cast<double>(cur.data->frames)), std::memory_order_relaxed);
    }
}

// ---------------------------------------------------------------------------------------------- SampleVoices
void SampleVoices::prepare(double rate)
{
    deviceRate = rate;
    fadeInStep = static_cast<float>(1.0 / (0.001 * rate));
    fadeOutStep = static_cast<float>(1.0 / (0.006 * rate));
    for (auto& x : v) x = Voice();
    active = 0;
}

void SampleVoices::end(Voice& x)
{
    if (x.data != nullptr)
    {
        x.data->voices.fetch_sub(1, std::memory_order_release);
        x.data = nullptr;
        --active;
    }
}

void SampleVoices::trigger(const SampleData* d, int pitch, int velocity, bool gate)
{
    if (d == nullptr || d->frames < 2) return;
    int slot = -1;
    for (int i = 0; i < kVoices; ++i)
        if (v[i].data == nullptr) { slot = i; break; }
    if (slot < 0) // all busy: take the voice that has played the longest
    {
        double far = -1.0;
        for (int i = 0; i < kVoices; ++i)
            if (v[i].pos > far) { far = v[i].pos; slot = i; }
        end(v[slot]);
    }
    d->voices.fetch_add(1, std::memory_order_acq_rel);
    Voice& x = v[slot];
    x = Voice();
    x.data = d;
    x.step = d->sampleRate / deviceRate * std::pow(2.0, (pitch - 60) / 12.0);
    x.gain = static_cast<float>(velocity) / 127.0f;
    x.pitch = pitch;
    x.gate = gate;
    ++active;
}

void SampleVoices::release(int pitch)
{
    for (auto& x : v)
        if (x.data != nullptr && x.gate && x.pitch == pitch) x.fading = true;
}

void SampleVoices::cut()
{
    for (auto& x : v)
        if (x.data != nullptr) x.fading = true;
}

void SampleVoices::render(float* L, float* R, int n)
{
    for (auto& x : v)
    {
        if (x.data == nullptr) continue;
        const SampleData& d = *x.data;
        const bool stereo = !d.right.empty();
        int i = 0;
        for (; i < n; ++i)
        {
            const auto i0 = static_cast<int64_t>(x.pos);
            if (i0 >= d.frames - 1) break;
            const float t = static_cast<float>(x.pos - static_cast<double>(i0));
            const float l = d.left[static_cast<size_t>(i0)] * (1.0f - t) + d.left[static_cast<size_t>(i0 + 1)] * t;
            const float r = stereo ? d.right[static_cast<size_t>(i0)] * (1.0f - t) + d.right[static_cast<size_t>(i0 + 1)] * t : l;
            if (x.fading)
            {
                x.env -= fadeOutStep;
                if (x.env <= 0.0f) break;
            }
            else if (x.env < 1.0f) x.env = std::min(1.0f, x.env + fadeInStep);
            const float g = x.gain * x.env;
            L[i] += l * g;
            R[i] += r * g;
            x.pos += x.step;
        }
        if (i < n || static_cast<int64_t>(x.pos) >= d.frames - 1) end(x);
    }
}

// ------------------------------------------------------------------------------------------------ stretching
std::shared_ptr<SampleData> stretchSample(const SampleData& src, double ratio, std::string& error)
{
    if (!(ratio >= 0.25 && ratio <= 4.0))
    {
        error = "tempo change is outside what can be stretched (0.25x to 4x)";
        return nullptr;
    }
    const int ch = src.channels;
    const int64_t outN = std::llround(static_cast<double>(src.frames) / ratio);
    if (outN < 2)
    {
        error = "sample is too short to stretch";
        return nullptr;
    }
    signalsmith::stretch::SignalsmithStretch<float> st(12345); // fixed seed: the same input always gives the same audio
    st.presetDefault(ch, static_cast<float>(src.sampleRate));

    // Input with silence after the end, so the stretcher can finish the last sound.
    const int64_t pad = static_cast<int64_t>(st.inputLatency()) + st.blockSamples() * 2 + static_cast<int64_t>(ratio * st.outputLatency()) + 64;
    std::vector<std::vector<float>> in(static_cast<size_t>(ch));
    for (int c = 0; c < ch; ++c)
    {
        const auto& s = c == 0 ? src.left : src.right;
        in[static_cast<size_t>(c)].assign(static_cast<size_t>(src.frames + pad), 0.0f);
        std::copy(s.begin(), s.end(), in[static_cast<size_t>(c)].begin());
    }
    std::vector<const float*> inPtr(static_cast<size_t>(ch));
    for (int c = 0; c < ch; ++c) inPtr[static_cast<size_t>(c)] = in[static_cast<size_t>(c)].data();

    auto out = std::make_shared<SampleData>();
    out->sampleRate = src.sampleRate;
    out->channels = ch;
    out->frames = outN;
    out->left.assign(static_cast<size_t>(outN), 0.0f);
    if (ch == 2) out->right.assign(static_cast<size_t>(outN), 0.0f);
    std::vector<float*> outPtr(static_cast<size_t>(ch));
    outPtr[0] = out->left.data();
    if (ch == 2) outPtr[1] = out->right.data();

    // Align the output to the start of the sound, then stretch the rest in one pass.
    st.reset();
    const int seekLen = st.outputSeekLength(ratio);
    st.outputSeek(inPtr.data(), seekLen);
    std::vector<const float*> rest(static_cast<size_t>(ch));
    for (int c = 0; c < ch; ++c) rest[static_cast<size_t>(c)] = inPtr[static_cast<size_t>(c)] + seekLen;
    const int inSamples = static_cast<int>(std::llround(static_cast<double>(outN) * ratio)); // exactly `ratio` input per output, so beats stay on the grid
    st.process(rest.data(), inSamples, outPtr.data(), static_cast<int>(outN));

    float peak = 0.0f;
    for (float v : out->left)
    {
        if (!std::isfinite(v)) { error = "stretching produced invalid audio"; return nullptr; }
        peak = std::max(peak, std::fabs(v));
    }
    for (float v : out->right) peak = std::max(peak, std::fabs(v));
    out->peak = peak;
    return out;
}

std::shared_ptr<SampleData> SampleStore::getStretched(const std::string& path, double ratio, std::string& error)
{
    char key[32];
    std::snprintf(key, sizeof(key), "@%.5f", ratio);
    const std::string cacheKey = path + key;
    {
        std::lock_guard<std::mutex> lock(mutex);
        const auto it = cache.find(cacheKey);
        if (it != cache.end())
        {
            lru.erase(std::remove(lru.begin(), lru.end(), cacheKey), lru.end());
            lru.push_back(cacheKey);
            return it->second;
        }
    }
    const auto base = get(path, error);
    if (base == nullptr) return nullptr;
    auto data = stretchSample(*base, ratio, error);
    if (data == nullptr) return nullptr;
    std::lock_guard<std::mutex> lock(mutex);
    cache[cacheKey] = data;
    lru.push_back(cacheKey);
    while (lru.size() > 24)
    {
        retired.push_back({ cache[lru.front()], juce::Time::getMillisecondCounter() });
        cache.erase(lru.front());
        lru.pop_front();
    }
    return data;
}
