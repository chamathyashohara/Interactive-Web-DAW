// Stage 11: verified post-session take transfer (ADR-020).
//
// TEST FILES - NOT RECORDINGS. The takes are written by the real WavWriter from a synthetic
// counter signal; the transfers run over real TCP on 127.0.0.1 (both ends in this process).

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <optional>
#include <thread>

#include "rr/audio/take_naming.hpp"
#include "rr/audio/wav_inspect.hpp"
#include "rr/audio/wav_writer.hpp"
#include "rr/shared/clock.hpp"
#include "rr/shared/log.hpp"
#include "rr/transfer/sha256.hpp"
#include "rr/transfer/take_receiver.hpp"
#include "rr/transfer/take_sender.hpp"
#include "rr/transfer/transfer_files.hpp"
#include "rr/transfer/transfer_protocol.hpp"
#include "test_support.hpp"

using namespace rr::xfer;
using namespace std::chrono_literals;

namespace {

std::vector<std::uint8_t> read_all(const std::filesystem::path& p) {
    std::ifstream in(p, std::ios::binary);
    return std::vector<std::uint8_t>((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

// A finalised float32 WAV of `frames` frames (counter signal) at `path`.
std::filesystem::path make_take(const std::filesystem::path& path, std::uint64_t frames, std::uint32_t channels = 1) {
    rr::audio::WavWriter w;
    rr::audio::WavFormat fmt;
    fmt.sample_rate = 48000;
    fmt.channels = channels;
    REQUIRE(w.open(path, fmt));
    std::vector<float> block(static_cast<std::size_t>(frames) * channels);
    for (std::uint64_t i = 0; i < frames; ++i) {
        for (std::uint32_t c = 0; c < channels; ++c) {
            block[static_cast<std::size_t>(i) * channels + c] = rr::test::counter_sample(i, c);
        }
    }
    REQUIRE(w.write_frames(block.data(), frames));
    REQUIRE(w.finalise());
    return path;
}

bool same_bytes(const std::filesystem::path& a, const std::filesystem::path& b) {
    return std::filesystem::exists(a) && std::filesystem::exists(b) && read_all(a) == read_all(b);
}

std::string file_sha(const std::filesystem::path& p) {
    Digest d{};
    std::uint64_t n = 0;
    std::string err;
    REQUIRE(sha256_file(p, d, n, err));
    return to_hex(d);
}

// A copy (the vectors returned by transfers() are temporaries).
std::optional<TransferView> find(const std::vector<TransferView>& vs, std::uint32_t take) {
    for (const auto& v : vs) {
        if (v.take_id == take) {
            return v;
        }
    }
    return std::nullopt;
}

bool wait_for(const std::function<bool()>& cond, std::chrono::milliseconds limit = 20000ms) {
    const auto until = std::chrono::steady_clock::now() + limit;
    while (std::chrono::steady_clock::now() < until) {
        if (cond()) {
            return true;
        }
        std::this_thread::sleep_for(5ms);
    }
    return cond();
}

std::uint16_t next_port() {
    static std::uint16_t p = 53100;
    return ++p;
}

// Producer + performer transfer ends on loopback, small chunks so a short take has many chunks.
struct Rig {
    rr::log::Logger log;
    std::filesystem::path root = rr::test::fresh_temp_dir("xfer");
    std::filesystem::path perf_dir = root / "performer";
    std::filesystem::path recv_dir = root / "producer" / "from_performer";
    std::string session = rr::audio::make_session_id();
    std::uint16_t port = next_port();
    std::unique_ptr<TakeReceiver> rx;
    std::unique_ptr<TakeSender> tx;

    Rig() {
        std::filesystem::create_directories(perf_dir);
        start_receiver();
        SenderParams sp;
        sp.chunk_bytes = 1024;
        sp.retry_interval_ms = 100;
        sp.give_up_after_ms = 5000;
        sp.reply_timeout_ms = 3000;
        tx = std::make_unique<TakeSender>(sp, log);
    }
    std::uint32_t resume_wait_ms = 5000;
    void start_receiver() {
        ReceiverParams rp;
        rp.bind_address = "127.0.0.1";
        rp.port = port;
        rp.session_id = session;
        rp.resume_wait_ms = resume_wait_ms;
        rp.ack_every_chunks = 4;
        rx = std::make_unique<TakeReceiver>(rp, log);
        std::string err;
        REQUIRE(rx->start(err));
        rx->set_allowed_peer("127.0.0.1");
    }
    std::filesystem::path take_file(std::uint32_t take) const {
        return perf_dir / (rr::audio::take_stem(take, rr::Role::Performer, session) + ".wav");
    }
    SendJob job(std::uint32_t take, const std::string& token) const {
        SendJob j;
        j.host = "127.0.0.1";
        j.port = port;
        j.session_id = session;
        j.token = token;
        j.take_id = take;
        j.file = take_file(take);
        return j;
    }
    std::string request(std::uint32_t take, std::uint64_t frames) {
        std::string token;
        std::string err;
        REQUIRE(rx->expect(take, frames, recv_dir, token, err));
        return token;
    }
    // Runs one send to its end; returns {producer view, performer view}.
    std::pair<TransferView, TransferView> send(std::uint32_t take, const std::string& token) {
        std::string err;
        REQUIRE(tx->start(job(take, token), err));
        REQUIRE(wait_for([&] { return !tx->busy(); }));
        // The producer's view settles right after its RESULT.
        wait_for([&] {
            const auto v = find(rx->transfers(), take);
            return v && transfer_state_final(v->state);
        }, 3000ms);
        // Set RR_XFER_TRACE=1 to print both sides' history (diagnosis).
        const bool trace = std::getenv("RR_XFER_TRACE") != nullptr;
        for (const auto& line : rx->take_history()) {
            if (trace) {
                std::fprintf(stderr, "producer  %s\n", line.c_str());
            }
        }
        for (const auto& line : tx->take_history()) {
            if (trace) {
                std::fprintf(stderr, "performer %s\n", line.c_str());
            }
        }
        const auto p = find(rx->transfers(), take);
        const auto r = find(tx->transfers(), take);
        REQUIRE(r.has_value());
        return {p ? *p : TransferView{}, *r};
    }
    ~Rig() {
        tx.reset();
        rx.reset();
        log.stop();
    }
};

}  // namespace

// ---------------------------------------------------------------------------------------------
TEST_CASE("SHA-256 via Windows CNG matches the FIPS 180-2 test vectors", "[transfer]") {
    Digest d{};
    std::string err;
    REQUIRE(sha256("", 0, d, err));
    CHECK(to_hex(d) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    REQUIRE(sha256("abc", 3, d, err));
    CHECK(to_hex(d) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const std::string m = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    Sha256 h;
    REQUIRE(h.init(err));
    REQUIRE(h.update(m.data(), 10, err));
    REQUIRE(h.update(m.data() + 10, m.size() - 10, err));
    REQUIRE(h.finish(d, err));
    CHECK(to_hex(d) == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    Digest back{};
    CHECK(from_hex(to_hex(d), back));
    CHECK(back == d);
    CHECK_FALSE(from_hex("xyz", back));
}

TEST_CASE("RRXF messages round-trip and malformed input is rejected", "[transfer]") {
    XMsg o;
    o.type = XType::Offer;
    o.take_id = 7;
    o.file_bytes = 123456;
    o.chunk_bytes = 32768;
    o.chunk_count = chunk_count_for(123456, 32768);
    o.file_sha[0] = 0xAB;
    o.sample_rate = 48000;
    o.channels = 1;
    o.bits = 32;
    o.format_tag = 3;
    o.frames = 30000;
    o.name = "take07_performer_ab12cd34.wav";
    XDecoder dec;
    const auto bytes = encode(o);
    dec.feed(bytes.data(), bytes.size() - 1);
    XMsg out;
    std::string err;
    CHECK(dec.next(out, err) == XDecoder::Result::NeedMore);
    dec.feed(bytes.data() + bytes.size() - 1, 1);
    REQUIRE(dec.next(out, err) == XDecoder::Result::Message);
    CHECK(out.type == XType::Offer);
    CHECK(out.chunk_count == 4);
    CHECK(out.file_sha == o.file_sha);
    CHECK(out.name == o.name);

    XMsg c;
    c.type = XType::Chunk;
    c.index = 3;
    c.data.assign(1000, 0x5A);
    const auto cb = encode(c);
    XDecoder d2;
    d2.feed(cb.data(), cb.size());
    REQUIRE(d2.next(out, err) == XDecoder::Result::Message);
    CHECK(out.data.size() == 1000);

    // Oversize length, non-zero reserved field, unknown type, trailing bytes, wrong magic.
    auto expect_error = [](std::vector<std::uint8_t> b) {
        XDecoder d;
        d.feed(b.data(), b.size());
        XMsg m;
        std::string e;
        return d.next(m, e) == XDecoder::Result::Error;
    };
    CHECK(expect_error({0x7F, 0xFF, 0xFF, 0xFF, 0, 1, 0, 0}));
    auto res = cb;
    res[6] = 1;
    CHECK(expect_error(res));
    CHECK(expect_error({0, 0, 0, 4, 0, 99, 0, 0}));
    XMsg a;
    a.type = XType::Ack;
    auto ack = encode(a);
    ack[3] = static_cast<std::uint8_t>(ack[3] + 1);
    ack.push_back(0);
    CHECK(expect_error(ack));
    XMsg h;
    h.type = XType::Hello;
    h.session_id = "ab12cd34";
    h.token = std::string(32, 'a');
    auto hb = encode(h);
    hb[8] = 'X';
    CHECK(expect_error(hb));
}

TEST_CASE("received files are named by the producer; network names cannot reach the file system", "[transfer]") {
    const std::filesystem::path dir = rr::test::fresh_temp_dir("xfer_names");
    ReceivePaths p;
    std::string err;
    REQUIRE(make_receive_paths(dir, "ab12cd34", 7, p, err));
    CHECK(p.final_wav.filename() == "take07_performer_ab12cd34.wav");
    CHECK(path_is_inside(dir, p.partial));
    CHECK_FALSE(make_receive_paths(dir, "../../x1", 7, p, err));
    CHECK_FALSE(make_receive_paths(dir, "AB12CD34", 7, p, err));
    CHECK_FALSE(make_receive_paths(dir, "ab12cd34", 0, p, err));
    CHECK_FALSE(make_receive_paths(dir, "ab12cd34", 1000, p, err));
    CHECK_FALSE(path_is_inside(dir, dir / ".." / "evil.wav"));
    CHECK_FALSE(path_is_inside(dir, dir));
    CHECK_FALSE(path_is_inside(dir, std::filesystem::path("C:/Windows/evil.wav")));
    CHECK(display_safe_name("..\\..\\Windows\\evil.wav") == "evil.wav");
    CHECK(display_safe_name("../../") == "(unnamed)");
    CHECK(display_safe_name("..") == "_.");  // never "." or ".."
    CHECK(display_safe_name("a b:c?.wav") == "a_b_c_.wav");
}

TEST_CASE("the resume journal is strict: anything torn or foreign means start again", "[transfer]") {
    Journal j;
    j.session_id = "ab12cd34";
    j.take_id = 3;
    j.file_bytes = 99999;
    j.sha256_hex = std::string(64, 'f');
    j.chunk_bytes = 1024;
    j.chunks_done = 42;
    const auto back = parse_journal(journal_text(j));
    REQUIRE(back);
    CHECK(back->chunks_done == 42);
    std::string torn = journal_text(j);
    torn.resize(torn.size() - 5);
    CHECK_FALSE(parse_journal(torn));
    CHECK_FALSE(parse_journal("rr-transfer-journal 2\n"));
    CHECK_FALSE(parse_journal(""));
}

#ifdef _WIN32
TEST_CASE("the original is opened read-only and other writers are refused while it is open", "[transfer]") {
    const auto dir = rr::test::fresh_temp_dir("xfer_ro");
    const auto f = make_take(dir / "take01_performer_ab12cd34.wav", 4800);
    const auto before = read_all(f);
    {
        ReadOnlyFile ro;
        std::string err;
        REQUIRE(ro.open(f, err));
        std::ofstream w(f, std::ios::binary | std::ios::app);
        CHECK_FALSE(w.is_open());  // sharing violation: no writer while the transfer holds it
    }
    CHECK(read_all(f) == before);
    // A partial file is created exclusively and never replaces an existing file.
    PartialFile pf;
    std::string err;
    REQUIRE(pf.open(dir / "x.partial", 0, err));
    REQUIRE(pf.write_at(0, "abc", 3, err));
    pf.close();
    CHECK(read_all(dir / "x.partial").size() == 3);
}
#endif

// ---------------------------------------------------------------------------------------------
TEST_CASE("normal transfer: the copy is VERIFIED, identical, and the original is unchanged", "[transfer]") {
    Rig r;
    const auto src = make_take(r.take_file(1), 48000);  // 1 s, 192 KB -> 188 chunks of 1 KiB
    const auto before = read_all(src);
    const auto token = r.request(1, 48000);
    const auto [prod, perf] = r.send(1, token);
    CHECK(prod.state == TransferState::Verified);
    CHECK(perf.state == TransferState::Verified);
    CHECK(perf.source_unchanged);
    CHECK(perf.sha256_hex == file_sha(src));
    CHECK(prod.connections == 1);
    CHECK(prod.resumes == 0);
    CHECK(prod.frames == 48000);
    CHECK(prod.sample_rate == 48000);
    CHECK(prod.duration_s == 1.0);
    CHECK(prod.frames_vs_report == "match");
    ReceivePaths p;
    std::string err;
    REQUIRE(make_receive_paths(r.recv_dir, r.session, 1, p, err));
    CHECK(read_all(p.final_wav) == before);
    CHECK(read_all(src) == before);
    CHECK(std::filesystem::exists(p.record));
    CHECK_FALSE(std::filesystem::exists(p.partial));
    CHECK_FALSE(std::filesystem::exists(p.journal));
    CHECK(rr::audio::inspect_wav(p.final_wav).is_complete_float_wav());
}

TEST_CASE("interrupted by the performer: the transfer resumes from the saved chunk and verifies", "[transfer]") {
    Rig r;
    const auto src = make_take(r.take_file(2), 48000);
    const auto token = r.request(2, 48000);
    r.tx->test_drop_after_chunks(60);
    const auto [prod, perf] = r.send(2, token);
    CHECK(prod.state == TransferState::Verified);
    CHECK(prod.connections >= 2);
    CHECK(prod.resumes >= 1);
    CHECK(prod.resumed_from_chunk > 0);
    CHECK(prod.resumed_from_chunk <= 60);
    CHECK(perf.source_unchanged);
    ReceivePaths p;
    std::string err;
    REQUIRE(make_receive_paths(r.recv_dir, r.session, 2, p, err));
    CHECK(same_bytes(p.final_wav, src));
}

TEST_CASE("interrupted by the producer: the performer reconnects and resumes", "[transfer]") {
    Rig r;
    const auto src = make_take(r.take_file(3), 48000);
    const auto token = r.request(3, 48000);
    r.rx->test_drop_after_chunks(70);
    const auto [prod, perf] = r.send(3, token);
    CHECK(prod.state == TransferState::Verified);
    CHECK(prod.resumes >= 1);
    CHECK(perf.resumes >= 1);
    CHECK(perf.source_unchanged);
}

TEST_CASE("a producer restart resumes from the journal on disk", "[transfer]") {
    Rig r;
    make_take(r.take_file(4), 48000);
    auto token = r.request(4, 48000);
    // Sender: waits 3 s before reconnecting and gives up after 0.6 s of trouble, so the first
    // send ends FAILED while the producer service is down.
    r.tx = std::make_unique<TakeSender>(SenderParams{1024, 5000, 3000, 3000, 600, 1, 256 * 1024}, r.log);
    r.tx->test_drop_after_chunks(50);
    std::string err;
    REQUIRE(r.tx->start(r.job(4, token), err));
    REQUIRE(wait_for([&] {
        const auto v = find(r.rx->transfers(), 4);
        return v && v->state == TransferState::Retrying;
    }));
    r.rx->stop();  // the producer app closes while the transfer is paused
    r.rx.reset();
    REQUIRE(wait_for([&] { return !r.tx->busy(); }));
    CHECK(find(r.tx->transfers(), 4)->state == TransferState::Failed);
    // A new producer service (same session folder) is asked again: it resumes from its journal.
    r.port = next_port();
    r.start_receiver();
    token = r.request(4, 48000);
    r.tx = std::make_unique<TakeSender>(SenderParams{1024, 5000, 3000, 100, 5000, 1, 256 * 1024}, r.log);
    const auto [prod, perf] = r.send(4, token);
    CHECK(prod.state == TransferState::Verified);
    CHECK(prod.resumed_from_chunk > 0);
    CHECK(perf.source_unchanged);
}

TEST_CASE("a chunk damaged in transit is rejected by its hash and sent again", "[transfer]") {
    Rig r;
    const auto src = make_take(r.take_file(5), 24000);
    const auto token = r.request(5, 24000);
    r.tx->test_corrupt_chunk(10);
    const auto [prod, perf] = r.send(5, token);
    CHECK(prod.state == TransferState::Verified);
    CHECK(prod.chunk_rejects == 1);
    CHECK(perf.chunk_rejects == 1);
    ReceivePaths p;
    std::string err;
    REQUIRE(make_receive_paths(r.recv_dir, r.session, 5, p, err));
    CHECK(same_bytes(p.final_wav, src));
}

TEST_CASE("a whole-file hash mismatch is never VERIFIED; one clean resend verifies", "[transfer]") {
    Rig r;
    const auto src = make_take(r.take_file(6), 24000);
    const auto token = r.request(6, 24000);
    r.tx->test_corrupt_consistent(5, false);
    const auto [prod, perf] = r.send(6, token);
    CHECK(prod.state == TransferState::Verified);
    CHECK(prod.hash_failures == 1);
    CHECK(perf.hash_failures == 1);
    ReceivePaths p;
    std::string err;
    REQUIRE(make_receive_paths(r.recv_dir, r.session, 6, p, err));
    CHECK(same_bytes(p.final_wav, src));
    // The rejected copy was set aside, not deleted.
    std::filesystem::path aside = p.partial;
    aside += ".rejected-1";
    CHECK(std::filesystem::exists(aside));
}

TEST_CASE("persistent corruption ends FAILED, with no final file and the original intact", "[transfer]") {
    Rig r;
    const auto src = make_take(r.take_file(7), 24000);
    const auto before = read_all(src);
    const auto token = r.request(7, 24000);
    r.tx->test_corrupt_consistent(5, true);
    const auto [prod, perf] = r.send(7, token);
    CHECK(prod.state == TransferState::Failed);
    CHECK(perf.state == TransferState::Failed);
    CHECK(prod.hash_failures == 2);
    ReceivePaths p;
    std::string err;
    REQUIRE(make_receive_paths(r.recv_dir, r.session, 7, p, err));
    CHECK_FALSE(std::filesystem::exists(p.final_wav));
    CHECK(read_all(src) == before);
    CHECK(perf.source_unchanged);
}

TEST_CASE("duplicate requests: refused while queued; after VERIFIED nothing is rewritten", "[transfer]") {
    Rig r;
    make_take(r.take_file(8), 12000);
    const auto token = r.request(8, 12000);
    std::string t2;
    std::string err;
    CHECK_FALSE(r.rx->expect(8, 12000, r.recv_dir, t2, err));  // already queued
    auto first = r.send(8, token);
    REQUIRE(first.first.state == TransferState::Verified);
    ReceivePaths p;
    REQUIRE(make_receive_paths(r.recv_dir, r.session, 8, p, err));
    const auto mtime = std::filesystem::last_write_time(p.final_wav);
    const auto token2 = r.request(8, 12000);
    auto second = r.send(8, token2);
    CHECK(second.first.state == TransferState::Verified);
    CHECK(second.first.already_verified);
    CHECK(second.first.frames == 12000);  // the existing copy was format-checked again, not just hashed
    CHECK(second.first.frames_vs_report == "match");
    CHECK(second.second.already_verified);
    CHECK(std::filesystem::last_write_time(p.final_wav) == mtime);
    // Only one copy, one record.
    std::size_t wavs = 0;
    for (const auto& e : std::filesystem::directory_iterator(r.recv_dir)) {
        wavs += e.path().extension() == ".wav" ? 1 : 0;
    }
    CHECK(wavs == 1);
}

TEST_CASE("a different existing file is never overwritten", "[transfer]") {
    Rig r;
    make_take(r.take_file(9), 12000);
    ReceivePaths p;
    std::string err;
    REQUIRE(make_receive_paths(r.recv_dir, r.session, 9, p, err));
    std::filesystem::create_directories(r.recv_dir);
    make_take(p.final_wav, 100);  // something else already has the name
    const auto before = read_all(p.final_wav);
    const auto token = r.request(9, 12000);
    const auto [prod, perf] = r.send(9, token);
    CHECK(prod.state == TransferState::Failed);
    CHECK(perf.state == TransferState::Failed);
    CHECK(read_all(p.final_wav) == before);
}

TEST_CASE("wrong session, wrong token and unrequested takes are refused and nothing is written", "[transfer]") {
    Rig r;
    make_take(r.take_file(10), 4800);
    make_take(r.take_file(11), 4800);
    const auto token = r.request(10, 4800);
    SECTION("wrong session") {
        r.tx->test_override_hello("deadbeef", "");
        const auto res = r.send(10, token);
        CHECK(res.second.state == TransferState::Failed);
        CHECK(res.first.state == TransferState::Queued);  // still waiting for the real performer
    }
    SECTION("wrong token") {
        r.tx->test_override_hello("", std::string(32, '0'));
        const auto res = r.send(10, token);
        CHECK(res.second.state == TransferState::Failed);
        CHECK(res.first.state == TransferState::Queued);
    }
    SECTION("take not requested") {
        std::string err;
        REQUIRE(r.tx->start(r.job(11, token), err));
        REQUIRE(wait_for([&] { return !r.tx->busy(); }));
        CHECK(find(r.tx->transfers(), 11)->state == TransferState::Failed);
        CHECK_FALSE(find(r.rx->transfers(), 11).has_value());
    }
    const bool wrote_something = std::filesystem::exists(r.recv_dir) && !std::filesystem::is_empty(r.recv_dir);
    CHECK_FALSE(wrote_something);
}

TEST_CASE("a file that is not a valid WAV is never VERIFIED", "[transfer]") {
    Rig r;
    {
        std::ofstream junk(r.take_file(12), std::ios::binary);
        for (int i = 0; i < 5000; ++i) {
            junk.put(static_cast<char>(i * 7));
        }
    }
    SECTION("the performer refuses to send it") {
        const auto token = r.request(12, 0);
        const auto res = r.send(12, token);
        CHECK(res.second.state == TransferState::Failed);
        CHECK(res.first.state == TransferState::Queued);
    }
    SECTION("the producer's own check refuses it even when the hash matches") {
        r.tx->test_skip_wav_check(true);
        const auto token = r.request(12, 0);
        const auto res = r.send(12, token);
        CHECK(res.first.state == TransferState::Failed);
        CHECK(res.second.state == TransferState::Failed);
        ReceivePaths p;
        std::string err;
        REQUIRE(make_receive_paths(r.recv_dir, r.session, 12, p, err));
        CHECK_FALSE(std::filesystem::exists(p.final_wav));
    }
}

TEST_CASE("connections from any address other than the joined performer are refused", "[transfer]") {
    Rig r;
    make_take(r.take_file(13), 4800);
    r.rx->set_allowed_peer("10.11.12.13");
    const auto token = r.request(13, 4800);
    r.tx = std::make_unique<TakeSender>(SenderParams{1024, 1000, 1000, 100, 1500, 1, 256 * 1024}, r.log);
    const auto res = r.send(13, token);
    CHECK(res.second.state == TransferState::Failed);
    CHECK(res.first.state == TransferState::Queued);
    CHECK(r.rx->refused_connections() >= 1);
}

TEST_CASE("a request the performer never acts on ends FAILED instead of blocking the producer", "[transfer]") {
    Rig r;
    r.rx->stop();
    r.rx.reset();
    r.resume_wait_ms = 400;
    r.port = next_port();
    r.start_receiver();
    r.request(14, 4800);
    CHECK(r.rx->any_active());
    REQUIRE(wait_for([&] {
        const auto v = find(r.rx->transfers(), 14);
        return v && v->state == TransferState::Failed;
    }, 3000ms));
    CHECK_FALSE(r.rx->any_active());
    CHECK(find(r.rx->transfers(), 14)->detail.find("did not start sending") != std::string::npos);
}
