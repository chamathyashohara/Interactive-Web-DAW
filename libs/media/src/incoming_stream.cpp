#include "rr/media/incoming_stream.hpp"

#include <cmath>
#include <cstring>

#include "rr/shared/clock.hpp"

namespace rr::media {
namespace {

template <typename T>
void store_max(std::atomic<T>& a, T v) noexcept {
    T cur = a.load(std::memory_order_relaxed);
    while (v > cur && !a.compare_exchange_weak(cur, v, std::memory_order_relaxed)) {
    }
}

}  // namespace

void IncomingStream::set_gain_db(float db) noexcept {
    if (!(db >= kMinGainDb)) {
        db = kMinGainDb;
    }
    if (db > kMaxGainDb) {
        db = kMaxGainDb;
    }
    gain_db_.store(db);
    gain_linear_.store(std::pow(10.0f, db / 20.0f));
}

bool IncomingStream::create(const IncomingConfig& config, std::string& error) {
    error = validate(config.playout);
    if (!error.empty()) {
        return false;
    }
    if (config.stream_id != kStreamProducerMic && config.stream_id != kStreamPerformerMic) {
        error = "unknown stream id " + std::to_string(config.stream_id);
        return false;
    }
    if (!decoder_.create(error)) {
        return false;
    }
    cfg_ = config;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        arrival_ = ArrivalStats{};
        queue_full_drops_ = eos_ = bad_frames_ = test_dropped_ = 0;
        last_packet_ns_ = last_eos_ns_ = 0;
        remote_muted_ = false;
        receive_impairment_ = Impairment(config.test_receive_impairment);
    }
    while (queue_.read(&cb_packet_, 1) == 1) {
    }
    jb_ = JitterBuffer(config.playout.target_frames, config.playout.stall_limit);
    pcm_len_ = pcm_pos_ = 0;
    frame_samples_ = 480;
    was_enabled_ = false;
    target_frames_.store(config.playout.target_frames);
    set_gain_db(config.playout.gain_db);
    return true;
}

bool IncomingStream::on_audio(const MediaHeader& h, const std::uint8_t* payload, std::int64_t now) {
    // The Opus packet must describe one allowed frame (2.5..20 ms at 48 kHz).
    const int samples = OpusLiveDecoder::packet_samples(payload, h.payload_len);
    std::lock_guard<std::mutex> lock(mutex_);
    if (samples <= 0 || !is_allowed_frame(static_cast<std::uint32_t>(samples))) {
        ++bad_frames_;
        return false;
    }
    if (receive_impairment_.settings().active() && receive_impairment_.next() == Impairment::Action::Drop) {
        ++test_dropped_;
        return true;
    }
    const ArrivalStats::Result r = arrival_.on_packet(h.seq, h.media_index, now);
    if (r == ArrivalStats::Result::Duplicate) {
        return true;  // counted in the arrival statistics
    }
    if (r == ArrivalStats::Result::Restart) {
        rx_packet_.kind = JbPacket::StreamReset;
        rx_packet_.len = 0;
        if (!queue_.try_write_all(&rx_packet_, 1)) {
            ++queue_full_drops_;
        }
    }
    last_packet_ns_ = now;
    remote_muted_ = (h.flags & kFlagMuted) != 0;
    rx_packet_.kind = JbPacket::Audio;
    rx_packet_.seq = h.seq;
    rx_packet_.media_index = h.media_index;
    rx_packet_.arrival_ns = now;
    rx_packet_.len = h.payload_len;
    std::memcpy(rx_packet_.data, payload, h.payload_len);
    if (!queue_.try_write_all(&rx_packet_, 1)) {
        ++queue_full_drops_;
    }
    return true;
}

void IncomingStream::on_end_of_stream() {
    std::lock_guard<std::mutex> lock(mutex_);
    ++eos_;
    last_eos_ns_ = time::monotonic_ns();
    arrival_.on_end_of_stream();
    rx_packet_.kind = JbPacket::StreamReset;
    rx_packet_.len = 0;
    if (!queue_.try_write_all(&rx_packet_, 1)) {
        ++queue_full_drops_;
    }
}

ReceiverReport IncomingStream::make_report(bool closing, std::uint32_t invalid_packets) const {
    ReceiverReport r;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const ArrivalSnapshot a = arrival_.snapshot();
        r.received = a.received;
        r.lost_estimate = a.lost_estimate;
        r.duplicates = static_cast<std::uint32_t>(a.duplicates);
        r.reordered = static_cast<std::uint32_t>(a.reordered);
        r.jitter_us = static_cast<std::uint32_t>(a.jitter_ms * 1000.0);
    }
    r.invalid_packets = invalid_packets;
    r.late = static_cast<std::uint32_t>(cb_late_.load());
    r.jb_fill = cb_held_.load();
    r.jb_target = cb_target_.load();
    r.underruns = static_cast<std::uint32_t>(cb_underruns_.load());
    r.concealed = static_cast<std::uint32_t>(cb_concealed_.load());
    r.decode_errors = static_cast<std::uint32_t>(cb_decode_errors_.load());
    r.flags = (output_enabled_.load() ? ReceiverReport::kFlagPlaying : 0u) | (closing ? ReceiverReport::kFlagClosing : 0u);
    return r;
}

bool IncomingStream::next_frame() noexcept {
    const JitterBuffer::Pull r = jb_.pull(cb_packet_);
    int n = 0;
    switch (r) {
        case JitterBuffer::Pull::Filling:
            return false;
        case JitterBuffer::Pull::Packet:
            n = decoder_.decode(cb_packet_.data, cb_packet_.len, pcm_, OpusLiveDecoder::kMaxFrameSamples);
            if (n <= 0) {
                cb_decode_errors_.fetch_add(1, std::memory_order_relaxed);
                n = decoder_.conceal(pcm_, frame_samples_);
                cb_concealed_.fetch_add(1, std::memory_order_relaxed);
            } else {
                frame_samples_ = static_cast<std::uint32_t>(n);
            }
            break;
        case JitterBuffer::Pull::Lost:
        case JitterBuffer::Pull::Underrun:
            // Opus PLC: an estimate for the LIVE monitor only. It restores nothing in any recording.
            n = decoder_.conceal(pcm_, frame_samples_);
            cb_concealed_.fetch_add(1, std::memory_order_relaxed);
            break;
    }
    if (n <= 0) {
        std::memset(pcm_, 0, sizeof(float) * frame_samples_);
        n = static_cast<int>(frame_samples_);
    }
    pcm_len_ = static_cast<std::uint32_t>(n);
    pcm_pos_ = 0;
    return true;
}

void IncomingStream::render_add(float* out, std::uint32_t frames, std::uint32_t channels, std::uint32_t sample_rate) noexcept {
    const std::int64_t t0 = time::monotonic_ns();
    cb_callbacks_.fetch_add(1, std::memory_order_relaxed);
    cb_last_render_ns_.store(t0, std::memory_order_relaxed);

    const bool enabled = output_enabled_.load(std::memory_order_acquire);
    if (sample_rate != kLiveSampleRate || !enabled) {
        if (sample_rate != kLiveSampleRate) {
            cb_wrong_rate_.fetch_add(1, std::memory_order_relaxed);
        }
        // Not playing: keep the queue empty and start fresh when playing again.
        while (queue_.read(&cb_packet_, 1) == 1) {
        }
        if (was_enabled_) {
            jb_.reset();
            pcm_len_ = pcm_pos_ = 0;
            decoder_.reset();
            was_enabled_ = false;
        }
        cb_jb_playing_.store(false, std::memory_order_relaxed);
        cb_held_.store(0, std::memory_order_relaxed);
        return;
    }
    was_enabled_ = true;

    jb_.set_target(target_frames_.load(std::memory_order_relaxed));
    jb_.set_drift_pulls(frame_samples_ > 0 ? kLiveSampleRate / frame_samples_ : 100);  // about 1 s
    while (queue_.read(&cb_packet_, 1) == 1) {
        if (cb_packet_.kind == JbPacket::StreamReset) {
            jb_.reset();
            pcm_len_ = pcm_pos_ = 0;
            decoder_.reset();
        } else {
            jb_.insert(cb_packet_);
        }
    }
    store_max(cb_max_held_, jb_.held());

    const float gain = gain_linear_.load(std::memory_order_relaxed);
    std::uint32_t done = 0;
    while (done < frames) {
        if (pcm_pos_ >= pcm_len_ && !next_frame()) {
            break;  // filling: no live contribution for the rest of this block
        }
        const std::uint32_t n = (frames - done) < (pcm_len_ - pcm_pos_) ? (frames - done) : (pcm_len_ - pcm_pos_);
        for (std::uint32_t i = 0; i < n; ++i) {
            const float v = pcm_[pcm_pos_ + i] * gain;
            const float a = std::fabs(v);
            if (a > window_peak_) {
                window_peak_ = a;
            }
            float* frame = out + static_cast<std::size_t>(done + i) * channels;
            for (std::uint32_t c = 0; c < channels; ++c) {
                frame[c] += v;
            }
        }
        pcm_pos_ += n;
        done += n;
    }
    cb_frames_out_.fetch_add(done, std::memory_order_relaxed);
    window_frames_ += frames;
    if (window_frames_ >= kLiveSampleRate) {
        cb_peak_.store(window_peak_, std::memory_order_relaxed);
        window_peak_ = 0.0f;
        window_frames_ = 0;
    }

    const JitterStats& s = jb_.stats();
    cb_jb_playing_.store(jb_.playing(), std::memory_order_relaxed);
    cb_held_.store(jb_.held(), std::memory_order_relaxed);
    cb_target_.store(jb_.target(), std::memory_order_relaxed);
    cb_accepted_.store(s.accepted, std::memory_order_relaxed);
    cb_late_.store(s.late, std::memory_order_relaxed);
    cb_dups_.store(s.duplicates, std::memory_order_relaxed);
    cb_too_early_.store(s.too_early_resets, std::memory_order_relaxed);
    cb_played_.store(s.played, std::memory_order_relaxed);
    cb_lost_.store(s.lost, std::memory_order_relaxed);
    cb_underruns_.store(s.underruns, std::memory_order_relaxed);
    cb_rebuffers_.store(s.rebuffers, std::memory_order_relaxed);
    cb_drift_.store(s.drift_skips, std::memory_order_relaxed);
    cb_catchup_.store(s.catchup_frames, std::memory_order_relaxed);
    cb_resyncs_.store(s.resyncs, std::memory_order_relaxed);
    cb_resets_.store(s.resets, std::memory_order_relaxed);
    cb_frame_samples_.store(frame_samples_, std::memory_order_relaxed);
    store_max(cb_max_render_ns_, time::monotonic_ns() - t0);
}

IncomingStats IncomingStream::stats() const {
    IncomingStats s;
    s.stream_id = cfg_.stream_id;
    const std::int64_t now = time::monotonic_ns();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        s.arrival = arrival_.snapshot();
        s.queue_full_drops = queue_full_drops_;
        s.end_of_stream = eos_;
        s.bad_frames = bad_frames_;
        s.test_dropped = test_dropped_;
        s.last_packet_age_ms = last_packet_ns_ == 0 ? -1.0 : static_cast<double>(now - last_packet_ns_) / 1e6;
        s.remote_muted = remote_muted_;
        s.remote_streaming = last_packet_ns_ != 0 && last_packet_ns_ > last_eos_ns_ && now - last_packet_ns_ < 1000000000;
    }
    s.output_enabled = output_enabled_.load();
    s.jb_playing = cb_jb_playing_.load();
    s.jb_held = cb_held_.load();
    s.jb_max_held = cb_max_held_.load();
    s.jb_target = cb_target_.load();
    s.jb.accepted = cb_accepted_.load();
    s.jb.late = cb_late_.load();
    s.jb.duplicates = cb_dups_.load();
    s.jb.too_early_resets = cb_too_early_.load();
    s.jb.played = cb_played_.load();
    s.jb.lost = cb_lost_.load();
    s.jb.underruns = cb_underruns_.load();
    s.jb.rebuffers = cb_rebuffers_.load();
    s.jb.drift_skips = cb_drift_.load();
    s.jb.catchup_frames = cb_catchup_.load();
    s.jb.resyncs = cb_resyncs_.load();
    s.jb.resets = cb_resets_.load();
    s.concealed = cb_concealed_.load();
    s.decode_errors = cb_decode_errors_.load();
    s.render_callbacks = cb_callbacks_.load();
    s.wrong_rate_callbacks = cb_wrong_rate_.load();
    s.frames_output = cb_frames_out_.load();
    s.max_render_ns = cb_max_render_ns_.load();
    const std::int64_t last = cb_last_render_ns_.load();
    s.last_render_age_ms = last == 0 ? -1.0 : static_cast<double>(now - last) / 1e6;
    s.last_frame_samples = cb_frame_samples_.load();
    s.gain_db = gain_db_.load();
    const float peak = cb_peak_.load();
    s.output_peak_dbfs = peak > 1e-10f ? 20.0f * std::log10(peak) : -200.0f;  // below -200 dBFS = silent
    return s;
}

}  // namespace rr::media
