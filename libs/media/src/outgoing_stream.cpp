#include "rr/media/outgoing_stream.hpp"

#include <algorithm>

#include "rr/shared/clock.hpp"

namespace rr::media {

bool OutgoingStream::create(const OutgoingConfig& config, audio::LiveTap& tap, std::string& error) {
    if (config.session_id == 0) {
        error = "outgoing stream needs a session id";
        return false;
    }
    if (config.stream_id != kStreamProducerMic && config.stream_id != kStreamPerformerMic) {
        error = "unknown stream id " + std::to_string(config.stream_id);
        return false;
    }
    if (!encoder_.create(config.codec, error)) {
        return false;
    }
    cfg_ = config;
    tap_ = &tap;
    impairment_ = Impairment(config.test_impairment);
    frame_.assign(config.codec.frame_samples, 0.0f);
    scratch_.assign(4096, 0.0f);
    held_back_.clear();
    seq_ = 0;
    media_index_ = 0;
    streaming_.store(false);
    std::lock_guard<std::mutex> lock(mutex_);
    counters_ = OutgoingStats{};
    counters_.stream_id = config.stream_id;
    counters_.opus_version = opus_version();
    counters_.application = opus_application_name(config.codec.application);
    counters_.frame_samples = config.codec.frame_samples;
    counters_.bitrate_bps = encoder_.actual_bitrate();
    counters_.complexity = encoder_.actual_complexity();
    counters_.lookahead_samples = encoder_.lookahead_samples();
    return true;
}

void OutgoingStream::discard_tap(std::size_t samples) {
    auto& ring = tap_->ring();
    while (samples > 0) {
        const std::size_t n = ring.read(scratch_.data(), std::min(samples, scratch_.size()));
        if (n == 0) {
            break;
        }
        samples -= n;
    }
}

void OutgoingStream::send_counted(const SendFn& send, const std::uint8_t* d, std::size_t n, bool audio) {
    const bool ok = send(d, n);
    std::lock_guard<std::mutex> lock(mutex_);
    if (ok) {
        if (audio) {
            ++counters_.packets_sent;  // AUDIO only, comparable with the receiver's count
        }
        counters_.bytes_sent += n;
    } else {
        ++counters_.send_errors;
    }
}

void OutgoingStream::send_end_of_stream(const SendFn& send) {
    MediaHeader h;
    h.type = PacketType::EndOfStream;
    h.seq = seq_;
    h.media_index = media_index_;
    h.session_id = cfg_.session_id;
    h.stream_id = cfg_.stream_id;
    h.flags = 0;
    std::uint8_t datagram[kHeaderBytes];
    const std::size_t n = write_packet(h, nullptr, 0, datagram, sizeof datagram);
    send_counted(send, datagram, n, false);
    send_counted(send, datagram, n, false);  // twice: UDP may lose one (the receiver also copes without it)
    std::lock_guard<std::mutex> lock(mutex_);
    ++counters_.end_of_stream_sent;
}

void OutgoingStream::finish(bool can_send, const SendFn& send) {
    if (tap_ == nullptr) {
        return;
    }
    tap_->set_enabled(false);
    if (streaming_.load()) {
        if (can_send) {
            send_end_of_stream(send);
        }
        streaming_.store(false);
    }
}

void OutgoingStream::pump(bool allowed, const SendFn& send) {
    if (tap_ == nullptr) {
        return;
    }
    const bool want = enabled_.load() && allowed;
    auto& ring = tap_->ring();
    if (want && !streaming_.load()) {
        // A new stream for the codec, but seq and media_index CONTINUE for the endpoint's lifetime:
        // after a pause (switched off, or the peer was unreachable) the receiver must not mistake
        // the new packets for old ones (Stage 8 run D4b). They start at 0 only in create().
        encoder_.reset();
        held_back_.clear();
        tap_drop_base_ = tap_->dropped_frames();
        discard_tap(ring.read_available());
        tap_->set_enabled(true);
        streaming_.store(true);
        std::lock_guard<std::mutex> lock(mutex_);
        ++counters_.streams_started;
    } else if (!want && streaming_.load()) {
        tap_->set_enabled(false);
        streaming_.store(false);
        if (allowed) {
            send_end_of_stream(send);
        }
    }
    if (!streaming_.load()) {
        discard_tap(ring.read_available());
        return;
    }

    // A tap overflow is a gap in the live stream: advance the sample counter so the receiver
    // can see it (approximate position: within one loop iteration).
    const std::uint64_t dropped = tap_->dropped_frames();
    if (dropped > tap_drop_base_) {
        media_index_ += dropped - tap_drop_base_;
        std::lock_guard<std::mutex> lock(mutex_);
        counters_.tap_gap_frames += dropped - tap_drop_base_;
    }
    tap_drop_base_ = dropped;

    const std::size_t frame = cfg_.codec.frame_samples;
    const std::size_t available = ring.read_available();
    if (available > frame * cfg_.max_backlog_frames) {
        const std::size_t excess = available - frame;
        discard_tap(excess);
        media_index_ += excess;
        std::lock_guard<std::mutex> lock(mutex_);
        counters_.backlog_trim_frames += excess;
    }

    while (ring.read_available() >= frame) {
        ring.read(frame_.data(), frame);
        const bool muted = muted_.load();
        if (muted) {
            // Mute affects only what is SENT. The capture, the tap timing and the local
            // recording continue unchanged.
            std::fill(frame_.begin(), frame_.end(), 0.0f);
        }
        std::uint8_t opus_packet[kMaxOpusPacketBytes];
        const std::int64_t t0 = time::monotonic_ns();
        const int bytes = encoder_.encode(frame_.data(), opus_packet, sizeof opus_packet);
        const std::int64_t took = time::monotonic_ns() - t0;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            counters_.max_encode_ns = std::max(counters_.max_encode_ns, took);
            if (bytes <= 0) {
                ++counters_.encode_errors;
            } else {
                ++counters_.frames_encoded;
                if (muted) {
                    ++counters_.muted_frames;
                }
            }
        }
        if (bytes > 0) {
            MediaHeader h;
            h.type = PacketType::Audio;
            h.seq = seq_;
            h.media_index = media_index_;
            h.session_id = cfg_.session_id;
            h.stream_id = cfg_.stream_id;
            h.flags = static_cast<std::uint8_t>(kCodecOpus | (muted ? kFlagMuted : 0u));
            std::uint8_t packet[kMaxDatagramBytes];
            const std::size_t n = write_packet(h, opus_packet, static_cast<std::size_t>(bytes), packet, sizeof packet);
            const bool had_held = !held_back_.empty();
            switch (cfg_.test_impairment.active() ? impairment_.next() : Impairment::Action::Send) {
                case Impairment::Action::Send:
                    send_counted(send, packet, n, true);
                    break;
                case Impairment::Action::Drop: {
                    std::lock_guard<std::mutex> lock(mutex_);
                    ++counters_.test_dropped;
                    break;
                }
                case Impairment::Action::Duplicate: {
                    send_counted(send, packet, n, true);
                    send_counted(send, packet, n, true);
                    std::lock_guard<std::mutex> lock(mutex_);
                    ++counters_.test_duplicated;
                    break;
                }
                case Impairment::Action::HoldBack:
                    if (had_held) {
                        send_counted(send, packet, n, true);  // one held packet at a time
                    } else {
                        held_back_.assign(packet, packet + n);
                        std::lock_guard<std::mutex> lock(mutex_);
                        ++counters_.test_reordered;
                    }
                    break;
            }
            // A held-back packet goes out after the packet that followed it.
            if (had_held) {
                send_counted(send, held_back_.data(), held_back_.size(), true);
                held_back_.clear();
            }
        }
        ++seq_;  // also for a failed encode: the receiver sees a loss, not a silent shift
        media_index_ += frame;
    }
}

OutgoingStats OutgoingStream::stats() const {
    std::lock_guard<std::mutex> lock(mutex_);
    OutgoingStats s = counters_;
    s.enabled = enabled_.load();
    s.muted = muted_.load();
    s.streaming = streaming_.load();
    if (tap_ != nullptr) {
        s.tap = tap_->stats();
    }
    return s;
}

}  // namespace rr::media
