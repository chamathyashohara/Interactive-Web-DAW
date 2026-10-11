#include "rr/transfer/take_receiver.hpp"

#include <algorithm>
#include <cstdio>
#include <system_error>

#include "rr/audio/file_io.hpp"
#include "rr/audio/wav_inspect.hpp"
#include "rr/network/control_link.hpp"
#include "rr/shared/clock.hpp"
#include "rr/shared/error_codes.hpp"
#include "rr/shared/json_escape.hpp"
#include "rr/transfer/transfer_files.hpp"
#include "rr/transfer/transfer_protocol.hpp"
#include "xconn.hpp"

namespace rr::xfer {
namespace {

std::int64_t ms_ns(std::uint32_t ms) {
    return static_cast<std::int64_t>(ms) * 1000000;
}

std::string take_tag(std::uint32_t take) {
    return "take " + std::to_string(take) + " transfer: ";
}

std::uint16_t code_of(ErrorCode c) {
    return static_cast<std::uint16_t>(c);
}

// Renames `p` to "<p>.<what>-<n>" without replacing anything (received data is never deleted).
std::string set_aside(const std::filesystem::path& p, const char* what) {
    std::error_code ec;
    if (!std::filesystem::exists(p, ec)) {
        return {};
    }
    for (int n = 1; n < 1000; ++n) {
        std::filesystem::path to = p;
        to += "." + std::string(what) + "-" + std::to_string(n);
        std::string err;
        if (!std::filesystem::exists(to, ec) && audio::rename_no_replace(p, to, err)) {
            return audio::path_to_utf8(to);
        }
    }
    return {};
}

}  // namespace

const char* transfer_state_name(TransferState s) noexcept {
    switch (s) {
        case TransferState::Queued: return "queued";
        case TransferState::Transferring: return "transferring";
        case TransferState::Retrying: return "paused/retrying";
        case TransferState::Verifying: return "verifying";
        case TransferState::Verified: return "VERIFIED";
        case TransferState::Failed: return "FAILED";
    }
    return "unknown";
}

bool transfer_state_final(TransferState s) noexcept {
    return s == TransferState::Verified || s == TransferState::Failed;
}

// ---------------------------------------------------------------------------------------------
struct ReceiverImpl {
    struct Job {
        TransferView v;
        std::string token;
        std::uint64_t expected_frames = 0;
        ReceivePaths paths;
        bool have_offer = false;
        XMsg offer;               // first accepted OFFER (a later one must match it)
        std::uint32_t next = 0;   // next chunk needed
        PartialFile file;
        std::int64_t retry_deadline = 0;
        std::uint32_t same_chunk_rejects = 0;
        bool discarding = false;  // after a NACK: drop chunks until `next` arrives again
        std::uint32_t since_ack = 0;
    };
    enum class Phase { AwaitHello, AwaitOffer, Receiving, Closing };
    struct Conn {
        detail::XConn x;
        std::string peer;
        Phase phase = Phase::AwaitHello;
        std::int64_t deadline = 0;
        std::int64_t last_rx = 0;
        std::uint32_t take = 0;
        std::uint32_t chunks_this_conn = 0;
    };

    TakeReceiver& r;
    net::TcpSocket listener;
    std::map<std::uint32_t, Job> jobs;
    std::unique_ptr<Conn> conn;

    explicit ReceiverImpl(TakeReceiver& owner) : r(owner) {}

    void publish(Job& j) { r.set_view(j.v); }

    void abort_conn(const std::string& text, ErrorCode code) {
        if (!conn) {
            return;
        }
        XMsg a;
        a.type = XType::Abort;
        a.code = code_of(code);
        a.text = text;
        conn->x.send(a);
        conn->x.close_after_flush(500);
        conn.reset();
    }

    void finish_conn() {
        if (conn) {
            conn->x.close_after_flush(500);
            conn.reset();
        }
    }

    void fail(Job& j, const std::string& why) {
        j.file.close();
        j.v.state = TransferState::Failed;
        j.v.detail = why;
        j.v.finished_ns = time::monotonic_ns();
        r.history(take_tag(j.v.take_id) + "FAILED: " + why + " (the performer's original is unchanged)");
        r.log_.log(log::Level::Warn, "transfer", "failed", why, {{"take", std::to_string(j.v.take_id)}});
        publish(j);
    }

    void persist(Job& j) {
        std::string err;
        if (!j.file.flush_to_disk(err)) {
            r.history(take_tag(j.v.take_id) + "flush failed: " + err);
        }
        Journal jr;
        jr.session_id = r.params_.session_id;
        jr.take_id = j.v.take_id;
        jr.file_bytes = j.offer.file_bytes;
        jr.sha256_hex = to_hex(j.offer.file_sha);
        jr.chunk_bytes = j.offer.chunk_bytes;
        jr.chunks_done = j.next;
        if (!write_journal(j.paths.journal, jr, err)) {
            r.history(take_tag(j.v.take_id) + err);
        }
    }

    // Connection gone while a job was active: keep what is on disk, wait for the performer.
    // `abort_code` != Ok: tell the performer why before closing (protocol problem on this side).
    void connection_lost(std::string why, ErrorCode abort_code = ErrorCode::Ok) {  // by value: callers pass conn-owned text
        if (!conn) {
            return;
        }
        const std::uint32_t take = conn->take;
        const Phase phase = conn->phase;
        if (abort_code != ErrorCode::Ok) {
            XMsg a;
            a.type = XType::Abort;
            a.code = code_of(abort_code);
            a.text = why;
            conn->x.send(a);
            conn->x.close_after_flush(500);
        } else {
            conn->x.close();
        }
        conn.reset();
        auto it = jobs.find(take);
        if (it == jobs.end() || transfer_state_final(it->second.v.state) || phase == Phase::AwaitHello) {
            return;
        }
        Job& j = it->second;
        if (j.v.state == TransferState::Transferring && j.file.is_open()) {
            persist(j);
        }
        j.file.close();
        j.v.state = TransferState::Retrying;
        j.v.detail = "connection lost (" + why + "); waiting for the performer to resume";
        j.retry_deadline = time::monotonic_ns() + ms_ns(r.params_.resume_wait_ms);
        r.history(take_tag(take) + "PAUSED: " + why + "; " + std::to_string(j.next) + " of " +
                  std::to_string(j.v.chunks_total) + " chunks kept on disk");
        r.log_.log(log::Level::Warn, "transfer", "connection_lost", why,
                   {{"take", std::to_string(take)}, {"chunks_kept", std::to_string(j.next)}});
        publish(j);
    }

    void accept_new() {
        for (;;) {
            std::string peer;
            std::string err;
            net::TcpSocket s = listener.accept_pending(peer, err);
            if (!s.valid()) {
                return;
            }
            std::string allowed;
            {
                std::lock_guard<std::mutex> lock(r.mutex_);
                allowed = r.allowed_peer_;
            }
            detail::XConn x(std::move(s));
            if (allowed.empty() || peer != allowed) {
                std::uint64_t n = 0;
                {
                    std::lock_guard<std::mutex> lock(r.mutex_);
                    n = ++r.refused_connections_;
                }
                if (n <= 3 || n % 100 == 0) {  // rate-limited: a stranger must not flood the log
                    r.log_.log(log::Level::Warn, "transfer", "connection_refused", "not the joined performer's address",
                               {{"from", peer}, {"refused_so_far", std::to_string(n)}});
                    r.history("transfer connection from " + peer + " refused (not the joined performer; " +
                              std::to_string(n) + " so far)");
                }
                x.close();  // no reply to strangers
                continue;
            }
            if (conn) {
                XMsg a;
                a.type = XType::Abort;
                a.code = code_of(ErrorCode::Busy);
                a.text = "another transfer is running";
                x.send(a);
                x.close_after_flush(200);
                continue;
            }
            conn = std::make_unique<Conn>();
            conn->x.reset(std::move(x.socket()));
            conn->peer = peer;
            conn->phase = Phase::AwaitHello;
            conn->deadline = time::monotonic_ns() + ms_ns(r.params_.hello_timeout_ms);
            conn->last_rx = time::monotonic_ns();
        }
    }

    void take_inbox() {
        std::deque<TakeReceiver::Expectation> in;
        std::deque<std::pair<std::uint32_t, std::string>> cancels;
        {
            std::lock_guard<std::mutex> lock(r.mutex_);
            in.swap(r.inbox_);
            cancels.swap(r.cancels_);
        }
        for (auto& e : in) {
            jobs.erase(e.take_id);  // a repeated request starts a fresh job (files on disk decide the resume point)
            Job& j = jobs[e.take_id];
            j.token = e.token;
            j.expected_frames = e.expected_frames;
            j.v.take_id = e.take_id;
            j.v.state = TransferState::Queued;
            j.v.started_ns = time::monotonic_ns();
            j.retry_deadline = j.v.started_ns + ms_ns(r.params_.resume_wait_ms);  // QUEUED must not last forever
            std::string err;
            if (!make_receive_paths(e.dir, r.params_.session_id, e.take_id, j.paths, err)) {
                fail(j, err);
                continue;
            }
            j.v.file = audio::path_to_utf8(j.paths.partial);
            j.v.detail = "waiting for the performer";
            publish(j);
        }
        // After the new requests, so a cancel issued right after expect() is not lost.
        for (const auto& [take, why] : cancels) {
            auto it = jobs.find(take);
            if (it == jobs.end() || transfer_state_final(it->second.v.state)) {
                continue;
            }
            if (conn && conn->take == take) {
                if (it->second.file.is_open()) {
                    persist(it->second);
                }
                abort_conn(why, ErrorCode::Cancelled);
            }
            fail(it->second, why);
        }
    }

    void on_hello(XMsg& m) {
        if (m.session_id != r.params_.session_id) {
            r.log_.log(log::Level::Warn, "transfer", "hello_refused", "wrong session",
                       {{"got", m.session_id}, {"take", std::to_string(m.take_id)}});
            r.history("transfer HELLO for another session (" + m.session_id + ") refused; nothing written");
            abort_conn("wrong session", ErrorCode::TransferRefused);
            return;
        }
        auto it = jobs.find(m.take_id);
        if (it == jobs.end() || transfer_state_final(it->second.v.state)) {
            r.history("transfer HELLO for take " + std::to_string(m.take_id) + " refused: not requested");
            r.log_.log(log::Level::Warn, "transfer", "hello_refused", "take not requested", {{"take", std::to_string(m.take_id)}});
            abort_conn("no transfer was requested for this take", ErrorCode::UnknownTake);
            return;
        }
        if (m.token != it->second.token) {
            // The token itself is never logged.
            r.history(take_tag(m.take_id) + "HELLO with a wrong token refused; nothing written");
            r.log_.log(log::Level::Warn, "transfer", "hello_refused", "wrong token", {{"take", std::to_string(m.take_id)}});
            abort_conn("wrong transfer token", ErrorCode::TransferRefused);
            return;
        }
        conn->take = m.take_id;
        conn->phase = Phase::AwaitOffer;
        conn->deadline = time::monotonic_ns() + ms_ns(r.params_.hello_timeout_ms);
        ++it->second.v.connections;
        publish(it->second);
    }

    // Checks the offer itself (no file access). Returns an error text, empty if acceptable.
    std::string check_offer(const Job& j, const XMsg& o) {
        if (o.take_id != j.v.take_id) return "offer for a different take";
        if (o.file_bytes < 44 || o.file_bytes > 0xFFFFFFFFull + 8) return "file size out of range";
        if (o.chunk_bytes < kMinChunkBytes || o.chunk_bytes > kMaxChunkBytes) return "chunk size out of range";
        if (o.chunk_count != chunk_count_for(o.file_bytes, o.chunk_bytes)) return "chunk count does not match the size";
        if (!(o.format_tag == 3 || o.format_tag == 0xFFFE) || o.bits != 32) return "not a 32-bit float WAV";
        if (o.channels < 1 || o.channels > 32 || o.sample_rate < 8000 || o.sample_rate > 384000) return "format out of range";
        if (o.frames * o.channels * 4ull > o.file_bytes) return "frame count larger than the file";
        if (j.expected_frames != 0 && o.frames != j.expected_frames) {
            return "offered " + std::to_string(o.frames) + " frames but the performer reported " +
                   std::to_string(j.expected_frames) + " in TAKE_FINALISED";
        }
        if (j.have_offer && (o.file_bytes != j.offer.file_bytes || o.file_sha != j.offer.file_sha ||
                             o.chunk_bytes != j.offer.chunk_bytes)) {
            return "the performer's file differs from the one this transfer started with";
        }
        return {};
    }

    void on_offer(XMsg& m) {
        Job& j = jobs[conn->take];
        const std::string bad = check_offer(j, m);
        if (!bad.empty()) {
            abort_conn(bad, ErrorCode::TransferRefused);
            fail(j, "offer refused: " + bad);
            return;
        }
        j.offer = m;
        j.offer.data.clear();
        j.have_offer = true;
        j.v.bytes_total = m.file_bytes;
        j.v.chunks_total = m.chunk_count;
        j.v.chunk_bytes = m.chunk_bytes;
        j.v.sha256_hex = to_hex(m.file_sha);
        const std::string tag = take_tag(j.v.take_id);
        std::error_code ec;
        std::filesystem::create_directories(j.paths.dir, ec);

        // Never overwrite: an existing final copy is either identical (duplicate request) or a conflict.
        if (std::filesystem::exists(j.paths.final_wav, ec)) {
            Digest have{};
            std::uint64_t n = 0;
            std::string err;
            if (sha256_file(j.paths.final_wav, have, n, err) && have == m.file_sha && n == m.file_bytes &&
                check_wav(j, j.paths.final_wav).empty()) {
                XMsg res;
                res.type = XType::Result;
                res.take_id = j.v.take_id;
                res.code = 0;
                res.already = true;
                res.text = "an identical verified copy already exists; nothing was rewritten";
                conn->x.send(res);
                finish_conn();
                j.v.state = TransferState::Verified;
                j.v.already_verified = true;
                j.v.bytes_done = m.file_bytes;
                j.v.chunks_done = m.chunk_count;
                j.v.file = audio::path_to_utf8(j.paths.final_wav);
                j.v.detail = res.text;
                j.v.finished_ns = time::monotonic_ns();
                r.history(tag + "duplicate request: identical verified copy already present (SHA-256 " + j.v.sha256_hex + ")");
                r.log_.log(log::Level::Info, "transfer", "duplicate_verified", res.text, {{"take", std::to_string(j.v.take_id)}});
                publish(j);
                return;
            }
            const std::string why = "a different file already exists for this take (" + audio::path_to_utf8(j.paths.final_wav) +
                                    "); it was not overwritten";
            abort_conn(why, ErrorCode::TransferRefused);
            fail(j, why);
            return;
        }
        if (audio::available_disk_bytes(j.paths.dir) < m.file_bytes + (1u << 20)) {
            abort_conn("not enough disk space on the producer PC", ErrorCode::DiskSpace);
            fail(j, "not enough disk space for " + std::to_string(m.file_bytes) + " bytes");
            return;
        }
        // Resume point: the journal must describe exactly this session, take and file.
        std::uint32_t next = 0;
        const auto jr = read_journal(j.paths.journal);
        const bool partial_exists = std::filesystem::exists(j.paths.partial, ec);
        if (partial_exists && jr && jr->session_id == r.params_.session_id && jr->take_id == j.v.take_id &&
            jr->file_bytes == m.file_bytes && jr->sha256_hex == j.v.sha256_hex && jr->chunk_bytes == m.chunk_bytes) {
            const std::uint64_t on_disk = std::filesystem::file_size(j.paths.partial, ec);
            const std::uint64_t whole = ec ? 0 : on_disk / m.chunk_bytes;
            next = static_cast<std::uint32_t>(std::min<std::uint64_t>({jr->chunks_done, whole, m.chunk_count}));
        } else if (partial_exists) {
            const std::string aside = set_aside(j.paths.partial, "stale");
            r.history(tag + "an unrelated partial file was set aside (" + aside + "); starting from chunk 0");
        }
        std::string err;
        if (!j.file.open(j.paths.partial, static_cast<std::uint64_t>(next) * m.chunk_bytes, err)) {
            abort_conn("producer cannot write the copy", ErrorCode::DiskWrite);
            fail(j, err);
            return;
        }
        j.next = next;
        j.discarding = false;
        j.same_chunk_rejects = 0;
        j.since_ack = 0;
        persist(j);
        XMsg res;
        res.type = XType::Resume;
        res.take_id = j.v.take_id;
        res.next_chunk = next;
        res.code = 0;
        conn->x.send(res);
        conn->phase = Phase::Receiving;
        j.v.state = TransferState::Transferring;
        j.v.resumed_from_chunk = next;
        if (next > 0) {
            ++j.v.resumes;
        }
        j.v.chunks_done = next;
        j.v.bytes_done = std::min<std::uint64_t>(static_cast<std::uint64_t>(next) * m.chunk_bytes, m.file_bytes);
        j.v.detail = next > 0 ? "resumed from chunk " + std::to_string(next) : "receiving";
        r.history(tag + (next > 0 ? "RESUMED from chunk " + std::to_string(next) + " of " + std::to_string(m.chunk_count)
                                  : "started: " + std::to_string(m.file_bytes) + " bytes in " + std::to_string(m.chunk_count) +
                                        " chunks, '" + display_safe_name(m.name) + "'"));
        r.log_.log(log::Level::Info, "transfer", next > 0 ? "resumed" : "started", "offer accepted",
                   {{"take", std::to_string(j.v.take_id)}, {"bytes", std::to_string(m.file_bytes)},
                    {"chunks", std::to_string(m.chunk_count)}, {"from_chunk", std::to_string(next)},
                    {"sha256", j.v.sha256_hex}});
        publish(j);
    }

    void on_chunk(XMsg& m) {
        Job& j = jobs[conn->take];
        if (j.discarding && m.index != j.next) {
            return;  // still in flight from before the NACK
        }
        j.discarding = false;
        if (m.index != j.next || j.next >= j.offer.chunk_count) {
            connection_lost("chunk " + std::to_string(m.index) + " out of order", ErrorCode::ProtocolMalformed);
            return;
        }
        const std::uint64_t offset = static_cast<std::uint64_t>(m.index) * j.offer.chunk_bytes;
        const std::uint64_t want = std::min<std::uint64_t>(j.offer.chunk_bytes, j.offer.file_bytes - offset);
        Digest d{};
        std::string err;
        const bool ok = m.data.size() == want && sha256(m.data.data(), m.data.size(), d, err) && d == m.chunk_sha;
        if (!ok) {
            ++j.v.chunk_rejects;
            ++j.same_chunk_rejects;
            r.history(take_tag(j.v.take_id) + "chunk " + std::to_string(m.index) + " failed its SHA-256 check; asked again");
            r.log_.log(log::Level::Warn, "transfer", "chunk_rejected", "chunk hash mismatch",
                       {{"take", std::to_string(j.v.take_id)}, {"chunk", std::to_string(m.index)}});
            if (j.same_chunk_rejects >= r.params_.max_same_chunk_rejects) {
                persist(j);
                abort_conn("chunk failed its check repeatedly", ErrorCode::TransferHashMismatch);
                fail(j, "chunk " + std::to_string(m.index) + " failed its SHA-256 check " +
                            std::to_string(j.same_chunk_rejects) + " times");
                return;
            }
            XMsg n;
            n.type = XType::Nack;
            n.next_chunk = j.next;
            n.code = code_of(ErrorCode::TransferHashMismatch);
            conn->x.send(n);
            j.discarding = true;
            publish(j);
            return;
        }
        if (!j.file.write_at(offset, m.data.data(), m.data.size(), err)) {
            abort_conn("producer cannot write the copy", ErrorCode::DiskWrite);
            fail(j, err);
            return;
        }
        ++j.next;
        j.same_chunk_rejects = 0;
        ++j.since_ack;
        ++conn->chunks_this_conn;
        j.v.chunks_done = j.next;
        j.v.bytes_done = std::min<std::uint64_t>(static_cast<std::uint64_t>(j.next) * j.offer.chunk_bytes, j.offer.file_bytes);
        if (j.since_ack >= r.params_.ack_every_chunks || j.next == j.offer.chunk_count) {
            persist(j);
            XMsg a;
            a.type = XType::Ack;
            a.next_chunk = j.next;
            conn->x.send(a);
            j.since_ack = 0;
            publish(j);
        }
        const std::uint32_t drop = r.test_drop_after_.load();
        if (drop != 0 && conn->chunks_this_conn == drop) {
            r.test_drop_after_.store(0);
            r.history(take_tag(j.v.take_id) + "TEST: producer drops the transfer connection");
            connection_lost("test: connection dropped by the producer");
        }
    }

    void on_done(XMsg& m) {
        Job& j = jobs[conn->take];
        if (j.discarding) {
            return;  // sent before our NACK arrived; a new DONE follows the resent chunks
        }
        if (m.take_id != j.v.take_id || j.next != j.offer.chunk_count) {
            connection_lost("DONE before all chunks arrived", ErrorCode::ProtocolMalformed);
            return;
        }
        persist(j);
        j.file.close();
        j.v.state = TransferState::Verifying;
        j.v.detail = "checking SHA-256 of the file on disk and the WAV structure";
        publish(j);
        r.history(take_tag(j.v.take_id) + "all " + std::to_string(j.offer.chunk_count) + " chunks received; VERIFYING");
        XMsg res;
        res.type = XType::Result;
        res.take_id = j.v.take_id;
        verify(j, res);
        conn->x.send(res);
        finish_conn();
    }

    // The file-format half of VERIFIED: a complete float32 WAV whose format and frame count match
    // the offer and the performer's TAKE_FINALISED report. Fills the view's facts. Empty = passed.
    std::string check_wav(Job& j, const std::filesystem::path& file) {
        const audio::WavInfo w = audio::inspect_wav(file);
        std::string bad;
        if (!w.is_complete_float_wav()) {
            bad = "not a complete float32 WAV";
            for (const auto& p : w.problems) {
                bad += "; " + p;
            }
        } else if (w.sample_rate != j.offer.sample_rate || w.channels != j.offer.channels) {
            bad = "WAV format differs from the offer";
        } else if (w.frames != j.offer.frames) {
            bad = "WAV has " + std::to_string(w.frames) + " frames, the offer said " + std::to_string(j.offer.frames);
        } else if (j.expected_frames != 0 && w.frames != j.expected_frames) {
            bad = "WAV has " + std::to_string(w.frames) + " frames, TAKE_FINALISED said " + std::to_string(j.expected_frames);
        }
        if (bad.empty()) {
            j.v.sample_rate = w.sample_rate;
            j.v.channels = w.channels;
            j.v.bits = w.bits_per_sample;
            j.v.frames = w.frames;
            j.v.duration_s = w.sample_rate ? static_cast<double>(w.frames) / w.sample_rate : 0.0;
            j.v.frames_vs_report = j.expected_frames == 0 ? "no report" : "match";
        }
        return bad;
    }

    void verify(Job& j, XMsg& res) {
        const std::string tag = take_tag(j.v.take_id);
        Digest d{};
        std::uint64_t n = 0;
        std::string err;
        if (!sha256_file(j.paths.partial, d, n, err)) {
            res.code = code_of(ErrorCode::DiskWrite);
            res.text = "producer could not read back the copy: " + err;
            fail(j, res.text);
            return;
        }
        if (n != j.offer.file_bytes || d != j.offer.file_sha) {
            ++j.v.hash_failures;
            const std::string aside = set_aside(j.paths.partial, "rejected");
            std::error_code ec;
            std::filesystem::remove(j.paths.journal, ec);  // transfer bookkeeping only
            j.next = 0;
            res.code = code_of(ErrorCode::TransferHashMismatch);
            res.text = "whole-file SHA-256 mismatch: expected " + to_hex(j.offer.file_sha) + ", got " + to_hex(d) +
                       " (" + std::to_string(n) + " bytes)";
            r.log_.log(log::Level::Warn, "transfer", "hash_mismatch", res.text, {{"take", std::to_string(j.v.take_id)}, {"set_aside", aside}});
            if (j.v.hash_failures >= r.params_.max_hash_failures) {
                fail(j, res.text + "; rejected copy kept as " + aside);
            } else {
                j.v.state = TransferState::Retrying;
                j.v.detail = res.text + "; the performer will send the file again";
                j.retry_deadline = time::monotonic_ns() + ms_ns(r.params_.resume_wait_ms);
                r.history(tag + "SHA-256 MISMATCH, rejected copy kept as " + aside + "; retrying from the start");
                publish(j);
            }
            return;
        }
        const std::string bad = check_wav(j, j.paths.partial);
        if (!bad.empty()) {
            const std::string aside = set_aside(j.paths.partial, "rejected");
            std::error_code ec;
            std::filesystem::remove(j.paths.journal, ec);
            res.code = code_of(ErrorCode::TransferInvalidFile);
            res.text = "hash matched but the WAV check failed: " + bad;
            fail(j, res.text + "; kept as " + aside);
            return;
        }
        if (!audio::rename_no_replace(j.paths.partial, j.paths.final_wav, err)) {
            res.code = code_of(ErrorCode::TransferRefused);
            res.text = "could not move the copy to its final name without replacing a file: " + err;
            fail(j, res.text);
            return;
        }
        std::error_code ec;
        std::filesystem::remove(j.paths.journal, ec);
        j.v.file = audio::path_to_utf8(j.paths.final_wav);
        j.v.bytes_done = n;
        j.v.state = TransferState::Verified;
        j.v.finished_ns = time::monotonic_ns();
        char dur[32];
        std::snprintf(dur, sizeof dur, "%.3f", j.v.duration_s);
        j.v.detail = "SHA-256 and WAV checks passed";
        // Record next to the copy (written once; never replaces anything).
        std::string rec = "{\n";
        rec += "  \"what\": \"verified copy of the performer's take (the original stays on the performer's PC)\",\n";
        rec += "  \"session_id\": \"" + r.params_.session_id + "\",\n";
        rec += "  \"take_id\": " + std::to_string(j.v.take_id) + ",\n";
        rec += "  \"file\": \"" + json_escape(audio::path_to_utf8(j.paths.final_wav.filename())) + "\",\n";
        rec += "  \"name_sent_by_performer\": \"" + json_escape(display_safe_name(j.offer.name)) + "\",\n";
        rec += "  \"bytes\": " + std::to_string(n) + ",\n";
        rec += "  \"sha256\": \"" + j.v.sha256_hex + "\",\n";
        rec += "  \"sha256_checked_on\": \"bytes on the producer's disk after the transfer\",\n";
        rec += "  \"sample_rate\": " + std::to_string(j.v.sample_rate) + ",\n";
        rec += "  \"channels\": " + std::to_string(j.v.channels) + ",\n";
        rec += "  \"bits\": " + std::to_string(j.v.bits) + ",\n";
        rec += "  \"frames\": " + std::to_string(j.v.frames) + ",\n";
        rec += "  \"duration_s\": " + std::string(dur) + ",\n";
        rec += "  \"frames_vs_take_finalised\": \"" + j.v.frames_vs_report + "\",\n";
        rec += "  \"chunks\": " + std::to_string(j.offer.chunk_count) + ",\n";
        rec += "  \"chunk_bytes\": " + std::to_string(j.offer.chunk_bytes) + ",\n";
        rec += "  \"connections\": " + std::to_string(j.v.connections) + ",\n";
        rec += "  \"resumes\": " + std::to_string(j.v.resumes) + ",\n";
        rec += "  \"chunk_rejects\": " + std::to_string(j.v.chunk_rejects) + ",\n";
        rec += "  \"hash_failures\": " + std::to_string(j.v.hash_failures) + ",\n";
        rec += "  \"verified_utc\": \"" + time::format_utc_iso8601_ms(time::utc_now_ms()) + "\"\n}\n";
        if (!audio::write_text_file_atomically(j.paths.record, rec, err)) {
            r.history(take_tag(j.v.take_id) + "note: transfer record not written: " + err);
        }
        res.code = 0;
        res.text = "SHA-256 " + j.v.sha256_hex + " matched; WAV " + std::to_string(j.v.frames) + " frames, " +
                   std::to_string(j.v.sample_rate) + " Hz, " + std::to_string(j.v.channels) + " ch";
        r.history(tag + "VERIFIED: " + j.v.file + " (" + std::to_string(n) + " bytes, SHA-256 " + j.v.sha256_hex + ", " +
                  std::to_string(j.v.frames) + " frames = " + dur + " s, " + std::to_string(j.v.sample_rate) + " Hz, " +
                  std::to_string(j.v.channels) + " ch float32)");
        r.log_.log(log::Level::Info, "transfer", "verified", "copy verified",
                   {{"take", std::to_string(j.v.take_id)}, {"bytes", std::to_string(n)}, {"sha256", j.v.sha256_hex},
                    {"frames", std::to_string(j.v.frames)}, {"connections", std::to_string(j.v.connections)},
                    {"resumes", std::to_string(j.v.resumes)}, {"chunk_rejects", std::to_string(j.v.chunk_rejects)},
                    {"hash_failures", std::to_string(j.v.hash_failures)}});
        publish(j);
    }

    void handle(XMsg& m) {
        if (!conn) {
            return;
        }
        conn->last_rx = time::monotonic_ns();
        switch (conn->phase) {
        case Phase::AwaitHello:
            if (m.type != XType::Hello) {
                abort_conn("expected HELLO", ErrorCode::ProtocolMalformed);
                return;
            }
            on_hello(m);
            return;
        case Phase::AwaitOffer:
            if (m.type == XType::Abort) {
                connection_lost("performer aborted: " + m.text);
                return;
            }
            if (m.type != XType::Offer) {
                abort_conn("expected OFFER", ErrorCode::ProtocolMalformed);
                return;
            }
            on_offer(m);
            return;
        case Phase::Receiving:
            if (m.type == XType::Chunk) {
                on_chunk(m);
            } else if (m.type == XType::Done) {
                on_done(m);
            } else if (m.type == XType::Abort) {
                connection_lost("performer aborted: " + m.text);
            } else {
                connection_lost(std::string("unexpected ") + xtype_name(m.type), ErrorCode::ProtocolMalformed);
            }
            return;
        case Phase::Closing:
            return;
        }
    }

    void timers() {
        const std::int64_t now = time::monotonic_ns();
        if (conn) {
            if ((conn->phase == Phase::AwaitHello || conn->phase == Phase::AwaitOffer) && now > conn->deadline) {
                if (conn->phase == Phase::AwaitHello) {
                    abort_conn("no HELLO", ErrorCode::Timeout);
                } else {
                    connection_lost("no OFFER in time");
                }
            } else if (conn && conn->phase == Phase::Receiving && now - conn->last_rx > ms_ns(r.params_.idle_timeout_ms)) {
                connection_lost("no data for " + std::to_string(r.params_.idle_timeout_ms / 1000) + " s");
            }
        }
        for (auto& [take, j] : jobs) {
            if (j.v.state == TransferState::Queued && now > j.retry_deadline && !(conn && conn->take == take)) {
                fail(j, "the performer did not start sending within " + std::to_string(r.params_.resume_wait_ms / 1000) +
                            " s (refused, failed or not reachable)");
            }
            if (j.v.state == TransferState::Retrying && now > j.retry_deadline && !(conn && conn->take == take)) {
                fail(j, "the performer did not resume within " + std::to_string(r.params_.resume_wait_ms / 1000) +
                            " s; " + std::to_string(j.next) + " chunks kept, a new request resumes from there");
            }
        }
    }
};

// ---------------------------------------------------------------------------------------------
TakeReceiver::TakeReceiver(ReceiverParams params, log::Logger& logger)
    : params_(std::move(params)), log_(logger), impl_(std::make_unique<ReceiverImpl>(*this)) {}

TakeReceiver::~TakeReceiver() {
    stop();
}

bool TakeReceiver::start(std::string& error) {
    if (running_.load()) {
        return true;
    }
    if (params_.bind_address.empty() || params_.bind_address == "0.0.0.0") {
        error = "the transfer listener needs one explicit interface address";
        return false;
    }
    if (!net::init_sockets(error) || !impl_->listener.listen_on(params_.bind_address, params_.port, error)) {
        return false;
    }
    running_.store(true);
    thread_ = std::thread([this] { run(); });
    log_.log(log::Level::Info, "transfer", "listening", "take transfer listener started",
             {{"address", params_.bind_address}, {"port", std::to_string(params_.port)}});
    history("transfer listener on " + params_.bind_address + ":" + std::to_string(params_.port) +
            " (only the joined performer may connect)");
    return true;
}

void TakeReceiver::stop() {
    if (!running_.exchange(false)) {
        return;
    }
    if (thread_.joinable()) {
        thread_.join();
    }
    impl_->listener.close();
}

void TakeReceiver::run() {
    while (running_.load()) {
        impl_->take_inbox();
        impl_->accept_new();
        if (impl_->conn) {
            std::deque<XMsg> in;
            const bool alive = impl_->conn->x.pump(20, in);
            for (auto& m : in) {
                impl_->handle(m);
                if (!impl_->conn) {
                    break;
                }
            }
            if (!alive && impl_->conn) {
                impl_->connection_lost(impl_->conn->x.error());
            }
        } else {
            std::vector<net::TcpSocket*> rd{&impl_->listener};
            net::TcpSocket::wait(rd, {}, 20);
        }
        impl_->timers();
    }
    if (impl_->conn) {
        impl_->connection_lost("producer stopped the transfer service");
    }
    for (auto& [take, j] : impl_->jobs) {
        j.file.close();
    }
}

void TakeReceiver::set_allowed_peer(const std::string& ipv4) {
    std::lock_guard<std::mutex> lock(mutex_);
    allowed_peer_ = ipv4;
}

bool TakeReceiver::expect(std::uint32_t take_id, std::uint64_t expected_frames, const std::filesystem::path& dir,
                          std::string& token, std::string& error) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = views_.find(take_id);
    if (it != views_.end() && !transfer_state_final(it->second.state)) {
        error = "a transfer of take " + std::to_string(take_id) + " is already " + transfer_state_name(it->second.state);
        return false;
    }
    for (const auto& e : inbox_) {
        if (e.take_id == take_id) {
            error = "a transfer of take " + std::to_string(take_id) + " is already queued";
            return false;
        }
    }
    token = net::make_random_token(kTokenChars);
    inbox_.push_back(Expectation{take_id, expected_frames, dir, token});
    TransferView v;
    v.take_id = take_id;
    v.state = TransferState::Queued;
    v.detail = "requested";
    views_[take_id] = v;
    history_.push_back(time::format_utc_iso8601_ms(time::utc_now_ms()).substr(11, 12) + "  take " +
                       std::to_string(take_id) + " transfer: QUEUED (requested from the performer)");
    return true;
}

void TakeReceiver::cancel(std::uint32_t take_id, const std::string& why) {
    std::lock_guard<std::mutex> lock(mutex_);
    cancels_.emplace_back(take_id, why);
    auto it = views_.find(take_id);
    if (it != views_.end() && !transfer_state_final(it->second.state) && !running_.load()) {
        it->second.state = TransferState::Failed;
        it->second.detail = why;
    }
}

bool TakeReceiver::any_active() const {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& [take, v] : views_) {
        if (!transfer_state_final(v.state)) {
            return true;
        }
    }
    return false;
}

void TakeReceiver::set_view(const TransferView& v) {
    std::lock_guard<std::mutex> lock(mutex_);
    views_[v.take_id] = v;
}

void TakeReceiver::history(const std::string& line) {
    std::lock_guard<std::mutex> lock(mutex_);
    history_.push_back(time::format_utc_iso8601_ms(time::utc_now_ms()).substr(11, 12) + "  " + line);
    if (history_.size() > 500) {
        history_.pop_front();
    }
}

std::vector<TransferView> TakeReceiver::transfers() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<TransferView> out;
    for (const auto& [take, v] : views_) {
        out.push_back(v);
    }
    return out;
}

std::vector<std::string> TakeReceiver::take_history() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<std::string> out(history_.begin(), history_.end());
    history_.clear();
    return out;
}

std::uint64_t TakeReceiver::refused_connections() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return refused_connections_;
}

}  // namespace rr::xfer
