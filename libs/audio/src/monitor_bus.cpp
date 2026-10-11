#include "rr/audio/monitor_bus.hpp"

#include <cmath>

#include "rr/shared/clock.hpp"
#include "rr/shared/realtime_guard.hpp"

namespace rr::audio {
namespace {

constexpr double kTwoPi = 6.283185307179586;

std::uint32_t ms_to_frames(std::uint32_t rate, std::uint32_t ms) {
    return static_cast<std::uint32_t>(static_cast<std::uint64_t>(rate) * ms / 1000);
}

}  // namespace

MonitorBus::MonitorBus(std::uint32_t sample_rate, std::uint32_t capacity_ms, std::uint32_t target_ms)
    : sample_rate_(sample_rate == 0 ? 48000 : sample_rate),
      target_frames_(ms_to_frames(sample_rate_, target_ms == 0 ? 1 : target_ms)),
      ring_(static_cast<std::size_t>(ms_to_frames(sample_rate_, capacity_ms < 2 * target_ms ? 2 * target_ms : capacity_ms)) * 2),
      capture_scratch_(static_cast<std::size_t>(kMaxBlockFrames) * 2, 0.0f),
      render_scratch_(static_cast<std::size_t>(kMaxBlockFrames) * 2, 0.0f) {}

void MonitorBus::set_gain_db(float db) noexcept {
    if (db < -60.0f) {
        db = -60.0f;
    }
    if (db > 12.0f) {
        db = 12.0f;
    }
    gain_db_.store(db, std::memory_order_relaxed);
    gain_linear_.store(std::pow(10.0f, db / 20.0f), std::memory_order_relaxed);
}

void MonitorBus::start_test_tone(float frequency_hz, float level_dbfs, float seconds) noexcept {
    tone_frequency_.store(frequency_hz, std::memory_order_relaxed);
    tone_amplitude_.store(std::pow(10.0f, level_dbfs / 20.0f), std::memory_order_relaxed);
    tone_frames_left_.store(static_cast<std::uint64_t>(seconds * static_cast<float>(sample_rate_)),
                            std::memory_order_release);
}

void MonitorBus::push_capture(const float* in, std::uint32_t frames, std::uint32_t channels) noexcept {
    if (!enabled_.load(std::memory_order_acquire) || in == nullptr || channels == 0) {
        return;
    }
    rt::ScopedRealtimeThread realtime;
    std::uint32_t done = 0;
    while (done < frames) {
        const std::uint32_t n = (frames - done) < kMaxBlockFrames ? (frames - done) : kMaxBlockFrames;
        const float* src = in + static_cast<std::size_t>(done) * channels;
        for (std::uint32_t f = 0; f < n; ++f) {
            const float l = src[static_cast<std::size_t>(f) * channels];
            const float r = channels >= 2 ? src[static_cast<std::size_t>(f) * channels + 1] : l;
            capture_scratch_[2 * static_cast<std::size_t>(f)] = l;
            capture_scratch_[2 * static_cast<std::size_t>(f) + 1] = r;
        }
        if (!ring_.try_write_all(capture_scratch_.data(), static_cast<std::size_t>(n) * 2)) {
            overflow_events_.fetch_add(1, std::memory_order_relaxed);
            overflow_frames_.fetch_add(n, std::memory_order_relaxed);
        }
        pushed_frames_.fetch_add(n, std::memory_order_relaxed);
        done += n;
    }
}

void MonitorBus::render(float* out, std::uint32_t frames, std::uint32_t out_channels) noexcept {
    if (out == nullptr || out_channels == 0) {
        return;
    }
    rt::ScopedRealtimeThread realtime;
    const std::int64_t start = time::monotonic_ns();
    const bool enabled = enabled_.load(std::memory_order_acquire);
    const float gain = gain_linear_.load(std::memory_order_relaxed);
    const std::size_t samples_out = static_cast<std::size_t>(frames) * out_channels;
    for (std::size_t i = 0; i < samples_out; ++i) {
        out[i] = 0.0f;
    }

    if (!enabled) {
        // Not monitoring: discard anything buffered so re-enabling starts fresh and short.
        std::size_t available = ring_.read_available();
        while (available > 0) {
            const std::size_t got = ring_.read(render_scratch_.data(),
                                               available < render_scratch_.size() ? available : render_scratch_.size());
            if (got == 0) {
                break;
            }
            available -= got;
        }
        playing_ = false;
        over_target_renders_ = 0;
    } else {
        std::size_t available_frames = ring_.read_available() / 2;
        if (!playing_) {
            if (available_frames >= target_frames_) {
                playing_ = true;
                prefill_events_.fetch_add(1, std::memory_order_relaxed);
                // Start exactly at the target latency: audio that piled up while the output was
                // not running (device (re)start, underrun recovery) is older than needed. Dropping
                // it here keeps monitor delay at the target instead of carrying the backlog.
                std::size_t excess = available_frames - target_frames_;
                if (excess > 0) {
                    start_trim_frames_.fetch_add(excess, std::memory_order_relaxed);
                }
                while (excess > 0) {
                    const std::size_t chunk = excess < kMaxBlockFrames ? excess : kMaxBlockFrames;
                    const std::size_t got = ring_.read(render_scratch_.data(), chunk * 2) / 2;
                    if (got == 0) {
                        break;
                    }
                    excess -= got;
                }
                available_frames = ring_.read_available() / 2;
            }
        }
        if (playing_) {
            // Drift: if more than target + 4 blocks stays buffered for 50 renders in a row, drop
            // the excess down to the target (counted). Keeps monitor latency bounded.
            if (available_frames > static_cast<std::size_t>(target_frames_) + 4u * frames) {
                if (++over_target_renders_ >= 50) {
                    std::size_t excess = available_frames - target_frames_;
                    drift_trim_events_.fetch_add(1, std::memory_order_relaxed);
                    drift_trim_frames_.fetch_add(excess, std::memory_order_relaxed);
                    while (excess > 0) {
                        const std::size_t chunk = excess < kMaxBlockFrames ? excess : kMaxBlockFrames;
                        const std::size_t got = ring_.read(render_scratch_.data(), chunk * 2) / 2;
                        if (got == 0) {
                            break;
                        }
                        excess -= got;
                    }
                    available_frames = ring_.read_available() / 2;
                    over_target_renders_ = 0;
                }
            } else {
                over_target_renders_ = 0;
            }

            std::uint32_t written = 0;
            while (written < frames) {
                const std::uint32_t want = (frames - written) < kMaxBlockFrames ? (frames - written) : kMaxBlockFrames;
                const std::uint32_t got =
                    static_cast<std::uint32_t>(ring_.read(render_scratch_.data(), static_cast<std::size_t>(want) * 2) / 2);
                for (std::uint32_t f = 0; f < got; ++f) {
                    const float l = render_scratch_[2 * static_cast<std::size_t>(f)] * gain;
                    const float r = render_scratch_[2 * static_cast<std::size_t>(f) + 1] * gain;
                    float* o = out + static_cast<std::size_t>(written + f) * out_channels;
                    if (out_channels == 1) {
                        o[0] = 0.5f * (l + r);
                    } else {
                        o[0] = l;
                        o[1] = r;
                    }
                }
                written += got;
                if (got < want) {
                    // Ran dry: the rest of this block stays silent; refill to the target first.
                    underrun_events_.fetch_add(1, std::memory_order_relaxed);
                    underrun_frames_.fetch_add(frames - written, std::memory_order_relaxed);
                    playing_ = false;
                    over_target_renders_ = 0;
                    break;
                }
            }
        }
    }

    // Output test tone (mixed on top; independent of monitoring).
    std::uint64_t tone_left = tone_frames_left_.load(std::memory_order_acquire);
    if (tone_left > 0) {
        const std::uint32_t n = tone_left < frames ? static_cast<std::uint32_t>(tone_left) : frames;
        const double step = kTwoPi * static_cast<double>(tone_frequency_.load(std::memory_order_relaxed)) / sample_rate_;
        const float amplitude = tone_amplitude_.load(std::memory_order_relaxed);
        for (std::uint32_t f = 0; f < n; ++f) {
            const float v = amplitude * static_cast<float>(std::sin(tone_phase_));
            tone_phase_ += step;
            if (tone_phase_ > kTwoPi) {
                tone_phase_ -= kTwoPi;
            }
            float* o = out + static_cast<std::size_t>(f) * out_channels;
            for (std::uint32_t c = 0; c < out_channels && c < 2; ++c) {
                o[c] += v;
            }
        }
        // A new tone requested meanwhile wins; otherwise count down.
        tone_frames_left_.compare_exchange_strong(tone_left, tone_left - n, std::memory_order_acq_rel);
    }

    const auto fill = static_cast<std::uint32_t>(ring_.read_available() / 2);
    fill_frames_.store(fill, std::memory_order_relaxed);
    if (fill > max_fill_frames_.load(std::memory_order_relaxed)) {
        max_fill_frames_.store(fill, std::memory_order_relaxed);
    }
    played_frames_.fetch_add(frames, std::memory_order_relaxed);
    render_callbacks_.fetch_add(1, std::memory_order_relaxed);
    const std::int64_t duration = time::monotonic_ns() - start;
    if (duration > max_render_ns_.load(std::memory_order_relaxed)) {
        max_render_ns_.store(duration, std::memory_order_relaxed);
    }
}

MonitorStats MonitorBus::stats() const noexcept {
    MonitorStats s;
    s.pushed_frames = pushed_frames_.load(std::memory_order_relaxed);
    s.overflow_events = overflow_events_.load(std::memory_order_relaxed);
    s.overflow_frames = overflow_frames_.load(std::memory_order_relaxed);
    s.played_frames = played_frames_.load(std::memory_order_relaxed);
    s.render_callbacks = render_callbacks_.load(std::memory_order_relaxed);
    s.underrun_events = underrun_events_.load(std::memory_order_relaxed);
    s.underrun_frames = underrun_frames_.load(std::memory_order_relaxed);
    s.prefill_events = prefill_events_.load(std::memory_order_relaxed);
    s.start_trim_frames = start_trim_frames_.load(std::memory_order_relaxed);
    s.drift_trim_events = drift_trim_events_.load(std::memory_order_relaxed);
    s.drift_trim_frames = drift_trim_frames_.load(std::memory_order_relaxed);
    s.fill_frames = fill_frames_.load(std::memory_order_relaxed);
    s.max_fill_frames = max_fill_frames_.load(std::memory_order_relaxed);
    s.target_frames = target_frames_;
    s.capacity_frames = static_cast<std::uint32_t>(ring_.capacity() / 2);
    s.max_render_ns = max_render_ns_.load(std::memory_order_relaxed);
    return s;
}

}  // namespace rr::audio
