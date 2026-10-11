#include "rr/media/live_sender.hpp"

#include <algorithm>

#include "rr/shared/clock.hpp"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <timeapi.h>
#endif

namespace rr::media {

LiveSender::LiveSender(log::Logger* logger) : log_(logger) {}

LiveSender::~LiveSender() {
    stop();
}

bool LiveSender::start(const LiveSenderConfig& config, audio::LiveTap& tap, std::string& error) {
    stop();
    if (config.session_id == 0 || config.media_port == 0) {
        error = "live sender needs a session id and a media port";
        return false;
    }
    if (!net::init_sockets(error)) {
        return false;
    }
    if (!net::parse_endpoint(config.expected_peer_address, 1, expected_peer_)) {
        error = "live sender: the performer's address is not known yet";
        return false;
    }
    if (!encoder_.create(config.codec, error)) {
        return false;
    }
    if (!socket_.bind_on(config.bind_address, config.media_port, error)) {
        return false;
    }
    cfg_ = config;
    tap_ = &tap;
    impairment_ = Impairment(config.test_impairment);
    frame_.assign(config.codec.frame_samples, 0.0f);
    scratch_.assign(4096, 0.0f);
    held_back_.clear();
    streaming_.store(false);
    {
        std::lock_guard<std::mutex> lock(mutex_);
        peer_known_ = false;
        peer_ = net::Endpoint{};
        last_report_ns_ = 0;
        counters_ = LiveSenderStats{};
        counters_.opus_version = opus_version();
        counters_.application = opus_application_name(config.codec.application);
        counters_.frame_samples = config.codec.frame_samples;
        counters_.bitrate_bps = encoder_.actual_bitrate();
        counters_.complexity = encoder_.actual_complexity();
        counters_.lookahead_samples = encoder_.lookahead_samples();
    }
    stop_requested_.store(false);
    running_.store(true);
    thread_ = std::thread([this] { thread_main(); });
    if (log_ != nullptr) {
        log_->log(log::Level::Info, "live", "sender_started", "live sender started",
                  {{"local", socket_.local_endpoint().text()},
                   {"expected_peer", config.expected_peer_address},
                   {"codec", opus_version()},
                   {"application", opus_application_name(config.codec.application)},
                   {"frame_samples", std::to_string(config.codec.frame_samples)},
                   {"bitrate_bps", std::to_string(encoder_.actual_bitrate())},
                   {"complexity", std::to_string(encoder_.actual_complexity())},
                   {"cbr", config.codec.constant_bitrate ? "1" : "0"},
                   {"lookahead_samples", std::to_string(encoder_.lookahead_samples())},
                   {"test_impairment", config.test_impairment.active() ? "ON (test only)" : "off"}});
    }
    return true;
}

void LiveSender::stop() {
    if (thread_.joinable()) {
        stop_requested_.store(true);
        thread_.join();
        if (log_ != nullptr) {
            const auto s = stats();
            log_->log(log::Level::Info, "live", "sender_stopped", "live sender stopped",
                      {{"packets_sent", std::to_string(s.packets_sent)},
                       {"send_errors", std::to_string(s.send_errors)},
                       {"tap_gap_frames", std::to_string(s.tap_gap_frames)},
                       {"backlog_trim_frames", std::to_string(s.backlog_trim_frames)}});
        }
    }
    if (tap_ != nullptr) {
        tap_->set_enabled(false);
    }
    socket_.close();
    running_.store(false);
}

void LiveSender::discard_tap(std::size_t samples) {
    auto& ring = tap_->ring();
    while (samples > 0) {
        const std::size_t n = ring.read(scratch_.data(), std::min(samples, scratch_.size()));
        if (n == 0) {
            break;
        }
        samples -= n;
    }
}

void LiveSender::send_packet(const std::uint8_t* datagram, std::size_t size, bool audio) {
    std::string error;
    std::unique_lock<std::mutex> lock(mutex_);
    const net::Endpoint to = peer_;
    lock.unlock();
    const long n = socket_.send_to(to, datagram, size, error);
    lock.lock();
    if (n == static_cast<long>(size)) {
        if (audio) {
            ++counters_.packets_sent;  // AUDIO only, comparable with the receiver's count
        }
        counters_.bytes_sent += size;
    } else {
        ++counters_.send_errors;
    }
}

void LiveSender::send_end_of_stream() {
    MediaHeader h;
    h.type = PacketType::EndOfStream;
    h.seq = seq_;
    h.media_index = media_index_;
    h.session_id = cfg_.session_id;
    h.flags = 0;
    std::uint8_t datagram[kHeaderBytes];
    const std::size_t n = write_packet(h, nullptr, 0, datagram, sizeof datagram);
    send_packet(datagram, n, false);
    send_packet(datagram, n, false);  // twice: UDP may lose one (the receiver also copes without it)
    std::lock_guard<std::mutex> lock(mutex_);
    ++counters_.end_of_stream_sent;
}

void LiveSender::receive_reports(std::int64_t now) {
    std::uint8_t buffer[net::UdpSocket::kMaxDatagram];
    for (int i = 0; i < 64; ++i) {
        net::Endpoint from;
        std::string error;
        const long n = socket_.recv_from(buffer, sizeof buffer, from, error);
        if (n == 0) {
            break;
        }
        std::lock_guard<std::mutex> lock(mutex_);
        if (n == -3) {
            ++counters_.invalid.oversized;
            continue;
        }
        if (n < 0) {
            break;
        }
        if (from.ip != expected_peer_.ip) {
            ++counters_.invalid.src_rejected;
            continue;
        }
        MediaHeader h;
        const std::uint8_t* payload = nullptr;
        const PacketCheck check = parse_packet(buffer, static_cast<std::size_t>(n), cfg_.session_id, h, payload);
        if (check != PacketCheck::Ok) {
            counters_.invalid.count(check);
            continue;
        }
        if (h.type != PacketType::ReceiverReport) {
            ++counters_.invalid.bad_type;  // the producer receives reports only
            continue;
        }
        const ReceiverReport r = read_report(payload);
        ++counters_.reports_received;
        counters_.last_report = r;
        counters_.has_report = true;
        last_report_ns_ = now;
        if ((r.flags & ReceiverReport::kFlagClosing) != 0) {
            if (peer_known_ && log_ != nullptr) {
                log_->log(log::Level::Info, "live", "peer_closed", "performer stopped listening",
                          {{"peer", peer_.text()}});
            }
            peer_known_ = false;
        } else if (!peer_known_ || peer_ != from) {
            peer_known_ = true;
            peer_ = from;
            if (log_ != nullptr) {
                log_->log(log::Level::Info, "live", "peer_learned", "performer media endpoint learned from its report",
                          {{"peer", from.text()}});
            }
        }
    }
}

void LiveSender::thread_main() {
#ifdef _WIN32
    // 1 ms timer resolution while live audio runs, so select() wakes promptly (default ~15.6 ms).
    timeBeginPeriod(1);
#endif
    while (!stop_requested_.load()) {
        socket_.wait_readable(1);
        const std::int64_t now = time::monotonic_ns();
        receive_reports(now);

        bool peer_known = false;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (peer_known_ && now - last_report_ns_ > static_cast<std::int64_t>(cfg_.peer_timeout_ms) * 1000000) {
                peer_known_ = false;
                ++counters_.peer_timeouts;
                if (log_ != nullptr) {
                    log_->log(log::Level::Warn, "live", "peer_timeout", "no receiver report: live sending paused",
                              {{"peer", peer_.text()}});
                }
            }
            peer_known = peer_known_;
        }
        const bool want = sending_.load() && peer_known;
        auto& ring = tap_->ring();

        if (want && !streaming_) {
            encoder_.reset();
            seq_ = 0;
            media_index_ = 0;
            held_back_.clear();
            tap_drop_base_ = tap_->dropped_frames();
            discard_tap(ring.read_available());
            tap_->set_enabled(true);
            streaming_.store(true);
            std::lock_guard<std::mutex> lock(mutex_);
            ++counters_.streams_started;
        } else if (!want && streaming_) {
            tap_->set_enabled(false);
            streaming_.store(false);
            if (peer_known) {
                send_end_of_stream();
            }
        }
        if (!streaming_) {
            discard_tap(ring.read_available());
            continue;
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
                }
            }
            if (bytes > 0) {
                MediaHeader h;
                h.type = PacketType::Audio;
                h.seq = seq_;
                h.media_index = media_index_;
                h.session_id = cfg_.session_id;
                h.flags = kCodecOpus;
                std::uint8_t packet[kMaxDatagramBytes];
                const std::size_t n = write_packet(h, opus_packet, static_cast<std::size_t>(bytes), packet, sizeof packet);
                const bool had_held = !held_back_.empty();
                switch (cfg_.test_impairment.active() ? impairment_.next() : Impairment::Action::Send) {
                    case Impairment::Action::Send:
                        send_packet(packet, n);
                        break;
                    case Impairment::Action::Drop: {
                        std::lock_guard<std::mutex> lock(mutex_);
                        ++counters_.test_dropped;
                        break;
                    }
                    case Impairment::Action::Duplicate: {
                        send_packet(packet, n);
                        send_packet(packet, n);
                        std::lock_guard<std::mutex> lock(mutex_);
                        ++counters_.test_duplicated;
                        break;
                    }
                    case Impairment::Action::HoldBack:
                        if (had_held) {
                            send_packet(packet, n);  // one held packet at a time
                        } else {
                            held_back_.assign(packet, packet + n);
                            std::lock_guard<std::mutex> lock(mutex_);
                            ++counters_.test_reordered;
                        }
                        break;
                }
                // A held-back packet goes out after the packet that followed it.
                if (had_held) {
                    send_packet(held_back_.data(), held_back_.size());
                    held_back_.clear();
                }
            }
            ++seq_;  // also for a failed encode: the receiver sees a loss, not a silent shift
            media_index_ += frame;
        }
    }
    if (streaming_) {
        tap_->set_enabled(false);
        bool peer_known = false;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            peer_known = peer_known_;
        }
        if (peer_known) {
            send_end_of_stream();
        }
        streaming_.store(false);
    }
#ifdef _WIN32
    timeEndPeriod(1);
#endif
}

LiveSenderStats LiveSender::stats() const {
    std::lock_guard<std::mutex> lock(mutex_);
    LiveSenderStats s = counters_;
    s.running = running_.load();
    s.sending_enabled = sending_.load();
    s.streaming = streaming_.load();
    s.local_endpoint = socket_.valid() ? socket_.local_endpoint().text() : std::string();
    s.peer_known = peer_known_;
    s.peer_endpoint = peer_known_ ? peer_.text() : std::string();
    const std::int64_t now = time::monotonic_ns();
    s.last_report_age_ms = last_report_ns_ == 0 ? -1.0 : static_cast<double>(now - last_report_ns_) / 1e6;
    if (tap_ != nullptr) {
        s.tap = tap_->stats();
    }
    return s;
}

}  // namespace rr::media
