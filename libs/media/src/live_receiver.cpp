#include "rr/media/live_receiver.hpp"

#include <cmath>
#include <cstring>

#include "rr/shared/clock.hpp"

namespace rr::media {
namespace {

float db_to_linear(float db) noexcept {
    return std::pow(10.0f, db / 20.0f);
}

template <typename T>
void store_max(std::atomic<T>& a, T v) noexcept {
    T cur = a.load(std::memory_order_relaxed);
    while (v > cur && !a.compare_exchange_weak(cur, v, std::memory_order_relaxed)) {
    }
}

}  // namespace

LiveReceiver::LiveReceiver(log::Logger* logger) : log_(logger) {}

LiveReceiver::~LiveReceiver() {
    stop();
}

void LiveReceiver::set_gain_db(float db) noexcept {
    if (!(db >= kMinGainDb)) {
        db = kMinGainDb;
    }
    if (db > kMaxGainDb) {
        db = kMaxGainDb;
    }
    gain_db_.store(db);
    gain_linear_.store(db_to_linear(db));
}

bool LiveReceiver::start(const LiveReceiverConfig& config, std::string& error) {
    stop();
    error = validate(config.playout);
    if (!error.empty()) {
        return false;
    }
    if (config.session_id == 0 || config.media_port == 0) {
        error = "live receiver needs a session id and a media port";
        return false;
    }
    if (!net::init_sockets(error)) {
        return false;
    }
    if (!net::parse_endpoint(config.producer_host, config.media_port, producer_)) {
        error = "not an IPv4 address: " + config.producer_host;
        return false;
    }
    if (!decoder_.create(error)) {
        return false;
    }
    if (!socket_.connect_to(config.producer_host, config.media_port, error)) {
        return false;
    }
    cfg_ = config;
    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        arrival_ = ArrivalStats{};
        invalid_ = InvalidCounts{};
        queue_full_drops_ = eos_ = reports_sent_ = report_errors_ = test_dropped_ = 0;
        last_packet_ns_ = 0;
        report_seq_ = 0;
        receive_impairment_ = Impairment(config.test_receive_impairment);
    }
    // Drop anything left in the queue from an earlier run (no consumer is attached yet).
    while (queue_.read(&cb_packet_, 1) == 1) {
    }
    jb_ = JitterBuffer(config.playout.target_frames, config.playout.stall_limit);
    pcm_len_ = pcm_pos_ = 0;
    frame_samples_ = 480;
    was_enabled_ = false;
    target_frames_.store(config.playout.target_frames);
    set_gain_db(config.playout.gain_db);
    stop_requested_.store(false);
    running_.store(true);
    thread_ = std::thread([this] { thread_main(); });
    if (log_ != nullptr) {
        log_->log(log::Level::Info, "live", "receiver_started", "live receiver started",
                  {{"producer", producer_.text()}, {"local", socket_.local_endpoint().text()},
                   {"jitter_target_frames", std::to_string(config.playout.target_frames)},
                   {"gain_db", std::to_string(config.playout.gain_db)}});
    }
    return true;
}

void LiveReceiver::stop() {
    if (thread_.joinable()) {
        stop_requested_.store(true);
        thread_.join();
        if (log_ != nullptr) {
            const auto s = stats();
            log_->log(log::Level::Info, "live", "receiver_stopped", "live receiver stopped",
                      {{"received", std::to_string(s.arrival.received)},
                       {"lost_estimate", std::to_string(s.arrival.lost_estimate)},
                       {"late", std::to_string(s.jb.late)},
                       {"underruns", std::to_string(s.jb.underruns)},
                       {"invalid", std::to_string(s.invalid.total())}});
        }
    }
    socket_.close();
    running_.store(false);
}

void LiveReceiver::thread_main() {
    std::uint8_t buffer[net::UdpSocket::kMaxDatagram];
    std::int64_t next_report = time::monotonic_ns();
    while (!stop_requested_.load()) {
        socket_.wait_readable(20);
        for (int i = 0; i < 256; ++i) {
            net::Endpoint from;
            std::string error;
            const long n = socket_.recv_from(buffer, sizeof buffer, from, error);
            if (n == 0) {
                break;
            }
            const std::int64_t now = time::monotonic_ns();
            if (n == -3) {
                std::lock_guard<std::mutex> lock(stats_mutex_);
                ++invalid_.oversized;
                continue;
            }
            if (n < 0) {
                if (log_ != nullptr) {
                    log_->log(log::Level::Warn, "live", "receive_error", error);
                }
                break;
            }
            handle_datagram(buffer, n, from, now);
        }
        const std::int64_t now = time::monotonic_ns();
        if (now >= next_report) {
            send_report(false);
            next_report = now + static_cast<std::int64_t>(cfg_.report_interval_ms) * 1000000;
        }
    }
    // Tell the producer to stop sending (twice: UDP may lose one; the producer also times out).
    send_report(true);
    send_report(true);
}

void LiveReceiver::handle_datagram(const std::uint8_t* data, long size, const net::Endpoint& from, std::int64_t now) {
    std::lock_guard<std::mutex> lock(stats_mutex_);
    // Step 1: source. The socket is connected, so the kernel already filters; checked anyway.
    if (from != producer_) {
        ++invalid_.src_rejected;
        return;
    }
    MediaHeader h;
    const std::uint8_t* payload = nullptr;
    const PacketCheck check = parse_packet(data, static_cast<std::size_t>(size), cfg_.session_id, h, payload);
    if (check != PacketCheck::Ok) {
        invalid_.count(check);
        return;
    }
    if (h.type == PacketType::ReceiverReport) {
        ++invalid_.bad_type;  // reports travel performer -> producer only
        return;
    }
    if (h.type == PacketType::EndOfStream) {
        ++eos_;
        arrival_.on_end_of_stream();
        rx_packet_.kind = JbPacket::StreamReset;
        rx_packet_.len = 0;
        if (!queue_.try_write_all(&rx_packet_, 1)) {
            ++queue_full_drops_;
        }
        return;
    }
    // Audio: the Opus packet must describe one allowed frame (2.5..20 ms at 48 kHz).
    const int samples = OpusLiveDecoder::packet_samples(payload, h.payload_len);
    if (samples <= 0 || !is_allowed_frame(static_cast<std::uint32_t>(samples))) {
        ++invalid_.bad_payload;
        return;
    }
    if (receive_impairment_.settings().active()) {
        const auto action = receive_impairment_.next();
        if (action == Impairment::Action::Drop) {
            ++test_dropped_;
            return;
        }
    }
    const ArrivalStats::Result r = arrival_.on_packet(h.seq, h.media_index, now);
    if (r == ArrivalStats::Result::Duplicate) {
        return;  // counted in arrival stats
    }
    if (r == ArrivalStats::Result::Restart) {
        rx_packet_.kind = JbPacket::StreamReset;
        rx_packet_.len = 0;
        if (!queue_.try_write_all(&rx_packet_, 1)) {
            ++queue_full_drops_;
        }
    }
    last_packet_ns_ = now;
    rx_packet_.kind = JbPacket::Audio;
    rx_packet_.seq = h.seq;
    rx_packet_.media_index = h.media_index;
    rx_packet_.arrival_ns = now;
    rx_packet_.len = h.payload_len;
    std::memcpy(rx_packet_.data, payload, h.payload_len);
    if (!queue_.try_write_all(&rx_packet_, 1)) {
        ++queue_full_drops_;
    }
}

void LiveReceiver::send_report(bool closing) {
    ReceiverReport r;
    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        const ArrivalSnapshot a = arrival_.snapshot();
        r.received = a.received;
        r.lost_estimate = a.lost_estimate;
        r.duplicates = static_cast<std::uint32_t>(a.duplicates);
        r.reordered = static_cast<std::uint32_t>(a.reordered);
        r.jitter_us = static_cast<std::uint32_t>(a.jitter_ms * 1000.0);
        r.invalid_packets = static_cast<std::uint32_t>(invalid_.total());
    }
    r.late = static_cast<std::uint32_t>(cb_late_.load());
    r.jb_fill = cb_held_.load();
    r.jb_target = cb_target_.load();
    r.underruns = static_cast<std::uint32_t>(cb_underruns_.load());
    r.concealed = static_cast<std::uint32_t>(cb_concealed_.load());
    r.decode_errors = static_cast<std::uint32_t>(cb_decode_errors_.load());
    r.flags = (output_enabled_.load() ? ReceiverReport::kFlagPlaying : 0u) | (closing ? ReceiverReport::kFlagClosing : 0u);

    std::uint8_t payload[ReceiverReport::kBytes];
    write_report(r, payload);
    MediaHeader h;
    h.type = PacketType::ReceiverReport;
    h.session_id = cfg_.session_id;
    h.stream_id = kStreamProducerMic;
    h.flags = 0;
    std::uint8_t datagram[kHeaderBytes + ReceiverReport::kBytes];
    std::string error;
    std::lock_guard<std::mutex> lock(stats_mutex_);
    h.seq = report_seq_++;
    const std::size_t n = write_packet(h, payload, sizeof payload, datagram, sizeof datagram);
    if (socket_.send(datagram, n, error) == static_cast<long>(n)) {
        ++reports_sent_;
    } else {
        ++report_errors_;
    }
}

bool LiveReceiver::next_frame() noexcept {
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

void LiveReceiver::render_add(float* out, std::uint32_t frames, std::uint32_t channels, std::uint32_t sample_rate) noexcept {
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
    // Queue -> jitter buffer (bounded: the queue holds at most 64).
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
            break;  // filling: the rest of this block stays as it is (no live contribution)
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
    cb_resets_.store(s.resets, std::memory_order_relaxed);
    cb_frame_samples_.store(frame_samples_, std::memory_order_relaxed);
    store_max(cb_max_render_ns_, time::monotonic_ns() - t0);
}

LiveReceiverStats LiveReceiver::stats() const {
    LiveReceiverStats s;
    s.running = running_.load();
    s.producer_endpoint = producer_.text();
    s.local_endpoint = socket_.valid() ? socket_.local_endpoint().text() : std::string();
    const std::int64_t now = time::monotonic_ns();
    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        s.arrival = arrival_.snapshot();
        s.invalid = invalid_;
        s.queue_full_drops = queue_full_drops_;
        s.end_of_stream = eos_;
        s.reports_sent = reports_sent_;
        s.report_send_errors = report_errors_;
        s.test_dropped = test_dropped_;
        s.last_packet_age_ms = last_packet_ns_ == 0 ? -1.0 : static_cast<double>(now - last_packet_ns_) / 1e6;
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
