#include "rr/transfer/take_sender.hpp"

#include <algorithm>
#include <chrono>

#include "rr/audio/file_io.hpp"
#include "rr/audio/wav_inspect.hpp"
#include "rr/network/socket.hpp"
#include "rr/shared/clock.hpp"
#include "rr/shared/error_codes.hpp"
#include "rr/transfer/sha256.hpp"
#include "rr/transfer/transfer_files.hpp"
#include "rr/transfer/transfer_protocol.hpp"
#include "xconn.hpp"

namespace rr::xfer {
namespace {

std::int64_t ms_ns(std::uint32_t ms) {
    return static_cast<std::int64_t>(ms) * 1000000;
}

bool hash_open_file(ReadOnlyFile& f, Digest& out, std::string& error) {
    Sha256 h;
    if (!h.init(error)) {
        return false;
    }
    std::vector<std::uint8_t> buf(1 << 20);
    std::uint64_t at = 0;
    for (;;) {
        std::size_t got = 0;
        if (!f.read_at(at, buf.data(), buf.size(), got, error)) {
            return false;
        }
        if (got == 0) {
            break;
        }
        if (!h.update(buf.data(), got, error)) {
            return false;
        }
        at += got;
    }
    return h.finish(out, error);
}

enum class Outcome { Verified, HashMismatch, Lost, Failed, Stopped };

}  // namespace

TakeSender::TakeSender(SenderParams params, log::Logger& logger) : params_(params), log_(logger) {
    params_.chunk_bytes = std::min(kMaxChunkBytes, std::max(kMinChunkBytes, params_.chunk_bytes));
}

TakeSender::~TakeSender() {
    stop();
}

bool TakeSender::start(const SendJob& job, std::string& error) {
    if (busy_.load()) {
        error = "another take is being sent";
        return false;
    }
    if (thread_.joinable()) {
        thread_.join();
    }
    {
        // A take sent again on request replaces its row; the producer decides whether the copy
        // it already has is identical ("already verified") or a conflict.
        std::lock_guard<std::mutex> lock(mutex_);
        TransferView v;
        v.take_id = job.take_id;
        v.state = TransferState::Queued;
        v.file = audio::path_to_utf8(job.file);
        v.detail = "preparing";
        views_[job.take_id] = v;
    }
    stop_.store(false);
    busy_.store(true);
    thread_ = std::thread([this, job] { run(job); });
    return true;
}

void TakeSender::stop() {
    stop_.store(true);
    if (thread_.joinable()) {
        thread_.join();
    }
}

void TakeSender::run(SendJob job) {
    const std::string tag = "take " + std::to_string(job.take_id) + " send: ";
    TransferView v;
    v.take_id = job.take_id;
    v.state = TransferState::Queued;
    v.file = audio::path_to_utf8(job.file);
    v.started_ns = time::monotonic_ns();
    v.detail = "checking the file and computing its SHA-256";
    set_view(v);

    ReadOnlyFile f;
    std::string err;
    auto finish = [&](TransferState st, const std::string& detail) {
        // The original must be exactly as it was: hash it again through the same read-only handle.
        if (f.is_open() && !v.sha256_hex.empty()) {  // only comparable once the "before" hash exists
            Digest after{};
            std::string herr;
            if (hash_open_file(f, after, herr)) {
                v.source_sha_after_hex = to_hex(after);
                v.source_unchanged = !v.sha256_hex.empty() && v.source_sha_after_hex == v.sha256_hex;
            }
        }
        f.close();
        v.state = st;
        v.detail = detail;
        v.finished_ns = time::monotonic_ns();
        set_view(v);
        history(tag + transfer_state_name(st) + ": " + detail + (v.source_sha_after_hex.empty()
                    ? std::string()
                    : std::string("; original ") + (v.source_unchanged ? "unchanged" : "CHANGED") +
                          " (SHA-256 after " + v.source_sha_after_hex + ")"));
        log_.log(st == TransferState::Verified ? log::Level::Info : log::Level::Warn, "transfer",
                 st == TransferState::Verified ? "send_verified" : "send_failed", detail,
                 {{"take", std::to_string(job.take_id)}, {"sha256", v.sha256_hex},
                  {"original_unchanged", v.source_unchanged ? "yes" : "no"},
                  {"connections", std::to_string(v.connections)}});
        busy_.store(false);
    };

    if (!f.open(job.file, err)) {
        finish(TransferState::Failed, "cannot open the take: " + err);
        return;
    }
    const audio::WavInfo w = audio::inspect_wav(job.file);
    const bool skip = test_skip_wav_check_.load();
    if (!skip && !w.is_complete_float_wav()) {
        finish(TransferState::Failed, "not a finalised float32 WAV; nothing was sent");
        return;
    }
    Digest src{};
    if (!hash_open_file(f, src, err)) {
        finish(TransferState::Failed, "cannot hash the take: " + err);
        return;
    }
    const std::uint32_t cb = params_.chunk_bytes;
    XMsg offer;
    offer.type = XType::Offer;
    offer.take_id = job.take_id;
    offer.file_bytes = f.size();
    offer.chunk_bytes = cb;
    offer.chunk_count = chunk_count_for(f.size(), cb);
    offer.file_sha = src;
    if (skip && !w.is_complete_float_wav()) {
        // TEST: pretend it is a mono float WAV so only the producer's final check can catch it.
        offer.format_tag = 3;
        offer.bits = 32;
        offer.channels = 1;
        offer.sample_rate = 48000;
        offer.frames = f.size() > 44 ? (f.size() - 44) / 4 : 0;
    } else {
        offer.format_tag = w.format_tag;
        offer.bits = static_cast<std::uint16_t>(w.bits_per_sample);
        offer.channels = static_cast<std::uint16_t>(w.channels);
        offer.sample_rate = w.sample_rate;
        offer.frames = w.frames;
    }
    offer.take_status = job.take_status;
    offer.name = audio::path_to_utf8(job.file.filename());
    v.sha256_hex = to_hex(src);
    v.bytes_total = f.size();
    v.chunk_bytes = cb;
    v.chunks_total = offer.chunk_count;
    v.frames = offer.frames;
    v.sample_rate = offer.sample_rate;
    v.channels = offer.channels;
    v.detail = "connecting to the producer";
    set_view(v);
    history(tag + "QUEUED: " + std::to_string(v.bytes_total) + " bytes, SHA-256 " + v.sha256_hex + " (original opened read-only)");

    std::string hello_session = job.session_id;
    std::string hello_token = job.token;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!test_session_.empty()) {
            hello_session = test_session_;
        }
        if (!test_token_.empty()) {
            hello_token = test_token_;
        }
    }

    std::uint32_t restarts = 0;
    std::int64_t trouble_since = 0;
    std::vector<std::uint8_t> buf(cb);
    while (!stop_.load()) {
        const std::int64_t now = time::monotonic_ns();
        if (trouble_since != 0 && now - trouble_since > ms_ns(params_.give_up_after_ms)) {
            finish(TransferState::Failed, "could not complete the transfer for " +
                                              std::to_string(params_.give_up_after_ms / 1000) + " s; last problem: " + v.detail);
            return;
        }
        // ---- connect ----
        net::TcpSocket s;
        bool connected = false;
        if (s.connect_start(job.host, job.port, err)) {
            const std::int64_t until = time::monotonic_ns() + ms_ns(params_.connect_timeout_ms);
            while (!stop_.load() && time::monotonic_ns() < until) {
                const int r = s.connect_finished(err);
                if (r == 1) {
                    connected = true;
                    break;
                }
                if (r < 0) {
                    break;
                }
                std::vector<net::TcpSocket*> wr{&s};
                net::TcpSocket::wait({}, wr, 20);
            }
            if (!connected && err.empty()) {
                err = "timed out";
            }
        }
        if (!connected) {
            if (trouble_since == 0) {
                trouble_since = now;
            }
            v.state = TransferState::Retrying;
            v.detail = "cannot reach the producer (" + err + "); retrying";
            set_view(v);
            std::this_thread::sleep_for(std::chrono::milliseconds(params_.retry_interval_ms));
            continue;
        }
        ++v.connections;
        detail::XConn c(std::move(s));
        XMsg hello;
        hello.type = XType::Hello;
        hello.session_id = hello_session;
        hello.token = hello_token;
        hello.take_id = job.take_id;
        c.send(hello);
        c.send(offer);

        // ---- one connection ----
        Outcome out = Outcome::Lost;
        std::string why;
        bool already = false;
        bool resumed = false;
        std::uint32_t next_send = 0;
        bool done_sent = false;
        std::uint32_t sent_here = 0;
        std::int64_t drop_at = 0;  // TEST: cut the connection once the queued chunks are delivered
        std::uint32_t acked = 0;
        std::int64_t last_rx = time::monotonic_ns();
        const std::int64_t result_wait = ms_ns(params_.reply_timeout_ms) +
                                         static_cast<std::int64_t>(v.bytes_total / (20ull << 20)) * 1000000000LL;
        while (!stop_.load()) {
            if (resumed) {
                while (drop_at == 0 && !done_sent && next_send < offer.chunk_count &&
                       c.pending_out() < params_.max_queued_bytes) {
                    const std::uint64_t off = static_cast<std::uint64_t>(next_send) * cb;
                    std::size_t got = 0;
                    const std::size_t want = static_cast<std::size_t>(std::min<std::uint64_t>(cb, v.bytes_total - off));
                    if (!f.read_at(off, buf.data(), want, got, err) || got != want) {
                        why = "cannot read the take: " + (err.empty() ? std::string("short read") : err);
                        out = Outcome::Failed;
                        break;
                    }
                    XMsg ch;
                    ch.type = XType::Chunk;
                    ch.index = next_send;
                    ch.data.assign(buf.begin(), buf.begin() + static_cast<std::ptrdiff_t>(want));
                    if (test_consistent_index_.load() == next_send + 1) {
                        ch.data[0] ^= 0x01;  // TEST: wrong data with a matching chunk hash
                        if (!test_consistent_always_.load()) {
                            test_consistent_index_.store(0);
                        }
                        history(tag + "TEST: chunk " + std::to_string(next_send) + " altered before hashing");
                    }
                    sha256(ch.data.data(), ch.data.size(), ch.chunk_sha, err);
                    if (test_corrupt_chunk_.load() == next_send + 1) {
                        ch.data[ch.data.size() / 2] ^= 0x01;  // TEST: damaged after hashing
                        test_corrupt_chunk_.store(0);
                        history(tag + "TEST: chunk " + std::to_string(next_send) + " damaged after hashing");
                    }
                    c.send(ch);
                    ++next_send;
                    ++sent_here;
                    const std::uint32_t drop = test_drop_after_.load();
                    if (drop != 0 && sent_here == drop) {
                        // Stop queuing; the connection is cut once the producer has acknowledged
                        // these chunks (or after 2 s), like a network that dies mid-file.
                        test_drop_after_.store(0);
                        drop_at = time::monotonic_ns() + ms_ns(2000);
                    }
                }
                if (out == Outcome::Failed) {
                    break;
                }
                if (drop_at != 0 && ((c.pending_out() == 0 && acked + 8 >= next_send) || time::monotonic_ns() > drop_at)) {
                    history(tag + "TEST: performer drops the connection after " + std::to_string(sent_here) +
                            " chunks (" + std::to_string(acked) + " acknowledged)");
                    c.close();
                    why = "test: connection dropped by the performer";
                    out = Outcome::Lost;
                    break;
                }
                if (!done_sent && next_send == offer.chunk_count) {
                    XMsg d;
                    d.type = XType::Done;
                    d.take_id = job.take_id;
                    c.send(d);
                    done_sent = true;
                    v.state = TransferState::Verifying;
                    v.detail = "all chunks sent; the producer is verifying";
                    set_view(v);
                }
            }
            std::deque<XMsg> in;
            const bool alive = c.pump(20, in);
            bool end = false;
            for (auto& m : in) {
                last_rx = time::monotonic_ns();
                if (m.type == XType::Resume && !resumed) {
                    if (m.code != 0) {
                        why = "producer refused: " + m.text;
                        out = Outcome::Failed;
                        end = true;
                        break;
                    }
                    if (m.next_chunk > offer.chunk_count) {
                        why = "producer asked for a chunk beyond the end";
                        out = Outcome::Failed;
                        end = true;
                        break;
                    }
                    resumed = true;
                    next_send = m.next_chunk;
                    v.resumed_from_chunk = next_send;
                    if (next_send > 0) {
                        ++v.resumes;
                    }
                    v.chunks_done = next_send;
                    v.state = TransferState::Transferring;
                    v.detail = next_send > 0 ? "resumed from chunk " + std::to_string(next_send) : "sending";
                    set_view(v);
                    history(tag + (next_send > 0 ? "RESUMING from chunk " + std::to_string(next_send) : std::string("TRANSFERRING")));
                    trouble_since = 0;
                } else if (m.type == XType::Ack) {
                    acked = m.next_chunk;
                    v.chunks_done = std::min(m.next_chunk, offer.chunk_count);
                    v.bytes_done = std::min<std::uint64_t>(static_cast<std::uint64_t>(v.chunks_done) * cb, v.bytes_total);
                    trouble_since = 0;
                    set_view(v);
                } else if (m.type == XType::Nack) {
                    ++v.chunk_rejects;
                    history(tag + "producer rejected chunk " + std::to_string(m.next_chunk) + "; sending again from there");
                    next_send = std::min(m.next_chunk, offer.chunk_count);
                    done_sent = false;
                    v.state = TransferState::Transferring;
                } else if (m.type == XType::Result) {
                    if (m.code == 0) {
                        out = Outcome::Verified;
                        already = m.already;
                    } else if (m.code == static_cast<std::uint16_t>(ErrorCode::TransferHashMismatch)) {
                        out = Outcome::HashMismatch;
                    } else {
                        out = Outcome::Failed;
                    }
                    why = m.text;
                    end = true;
                    break;
                } else if (m.type == XType::Abort) {
                    why = "producer: " + m.text;
                    out = m.code == static_cast<std::uint16_t>(ErrorCode::Busy) ? Outcome::Lost : Outcome::Failed;
                    end = true;
                    break;
                }
            }
            if (end) {
                break;
            }
            if (!alive) {
                why = c.error();
                out = Outcome::Lost;
                break;
            }
            const std::int64_t quiet = time::monotonic_ns() - last_rx;
            if (!done_sent && quiet > ms_ns(params_.reply_timeout_ms)) {
                why = "no reply from the producer for " + std::to_string(params_.reply_timeout_ms / 1000) + " s";
                out = Outcome::Lost;
                break;
            }
            if (done_sent && quiet > result_wait) {
                why = "no verification result from the producer";
                out = Outcome::Lost;
                break;
            }
        }
        if (stop_.load()) {
            c.close();
            finish(TransferState::Failed, "stopped on this PC before the producer verified the copy");
            return;
        }
        switch (out) {
        case Outcome::Verified:
            c.close_after_flush(200);
            v.already_verified = already;
            v.bytes_done = v.bytes_total;
            v.chunks_done = v.chunks_total;
            finish(TransferState::Verified, "the producer verified the copy" +
                                                std::string(already ? " (it already had an identical one)" : "") + ": " + why);
            return;
        case Outcome::HashMismatch:
            c.close_after_flush(200);
            ++v.hash_failures;
            if (restarts < params_.max_hash_restarts) {
                ++restarts;
                v.state = TransferState::Retrying;
                v.detail = "producer found a whole-file SHA-256 mismatch; sending again from the start";
                set_view(v);
                history(tag + "producer reported SHA-256 MISMATCH (" + why + "); sending again");
                continue;
            }
            finish(TransferState::Failed, "whole-file SHA-256 mismatch again: " + why);
            return;
        case Outcome::Failed:
            c.close_after_flush(200);
            finish(TransferState::Failed, why);
            return;
        case Outcome::Lost:
        case Outcome::Stopped:
            c.close();
            if (trouble_since == 0) {
                trouble_since = time::monotonic_ns();
            }
            v.state = TransferState::Retrying;
            v.detail = "connection lost (" + why + "); retrying";
            set_view(v);
            history(tag + "PAUSED: " + why + "; retrying in " + std::to_string(params_.retry_interval_ms) + " ms");
            std::this_thread::sleep_for(std::chrono::milliseconds(params_.retry_interval_ms));
            continue;
        }
    }
    finish(TransferState::Failed, "stopped on this PC before the producer verified the copy");
}

void TakeSender::set_view(const TransferView& v) {
    std::lock_guard<std::mutex> lock(mutex_);
    views_[v.take_id] = v;
}

void TakeSender::history(const std::string& line) {
    std::lock_guard<std::mutex> lock(mutex_);
    history_.push_back(time::format_utc_iso8601_ms(time::utc_now_ms()).substr(11, 12) + "  " + line);
    if (history_.size() > 500) {
        history_.pop_front();
    }
}

std::vector<TransferView> TakeSender::transfers() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<TransferView> out;
    for (const auto& [take, v] : views_) {
        out.push_back(v);
    }
    return out;
}

std::vector<std::string> TakeSender::take_history() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<std::string> out(history_.begin(), history_.end());
    history_.clear();
    return out;
}

}  // namespace rr::xfer
