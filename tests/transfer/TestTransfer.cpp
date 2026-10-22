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

#include "rr/audio/TakeNaming.h"
#include "rr/audio/WavInspect.h"
#include "rr/audio/WavWriter.h"
#include "rr/shared/Clock.h"
#include "rr/shared/Log.h"
#include "rr/transfer/Sha256.h"
#include "rr/transfer/TakeReceiver.h"
#include "rr/transfer/TakeSender.h"
#include "rr/transfer/TransferFiles.h"
#include "rr/transfer/TransferProtocol.h"
#include "TestSupport.h"

using namespace std::chrono_literals;

namespace
{

std::vector<uint8_t> readAll(const std::filesystem::path& p)
{
    std::ifstream in(p, std::ios::binary);
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

// A finalised float32 WAV of `frames` frames (counter signal) at `path`.
std::filesystem::path makeTake(const std::filesystem::path& path, uint64_t frames, uint32_t channels = 1)
{
    WavWriter w;
    WavFormat fmt;
    fmt.sampleRate = 48000;
    fmt.channels = channels;
    REQUIRE(w.open(path, fmt));
    std::vector<float> block(static_cast<size_t>(frames) * channels);
    for (uint64_t i = 0; i < frames; ++i)
    {
        for (uint32_t c = 0; c < channels; ++c)
        {
            block[static_cast<size_t>(i) * channels + c] = counterSample(i, c);
        }
    }
    REQUIRE(w.writeFrames(block.data(), frames));
    REQUIRE(w.finalise());
    return path;
}

bool sameBytes(const std::filesystem::path& a, const std::filesystem::path& b)
{
    return std::filesystem::exists(a) && std::filesystem::exists(b) && readAll(a) == readAll(b);
}

std::string fileSha(const std::filesystem::path& p)
{
    Digest d{};
    uint64_t n = 0;
    std::string err;
    REQUIRE(sha256File(p, d, n, err));
    return toHex(d);
}

// A copy (the vectors returned by transfers() are temporaries).
std::optional<TransferView> find(const std::vector<TransferView>& vs, uint32_t take)
{
    for (const auto& v : vs)
    {
        if (v.takeId == take)
        {
            return v;
        }
    }
    return std::nullopt;
}

bool wait_for(const std::function<bool()>& cond, std::chrono::milliseconds limit = 20000ms)
{
    const auto until = std::chrono::steady_clock::now() + limit;
    while (std::chrono::steady_clock::now() < until)
    {
        if (cond())
        {
            return true;
        }
        std::this_thread::sleep_for(5ms);
    }
    return cond();
}

uint16_t nextPort()
{
    static uint16_t p = 53100;
    return ++p;
}

// Producer + performer transfer ends on loopback, small chunks so a short take has many chunks.
struct Rig
{
    Logger log;
    std::filesystem::path root = freshTempDir("xfer");
    std::filesystem::path perfDir = root / "performer";
    std::filesystem::path recvDir = root / "producer" / "from_performer";
    std::string session = makeSessionId();
    uint16_t port = nextPort();
    std::unique_ptr<TakeReceiver> rx;
    std::unique_ptr<TakeSender> tx;

    Rig()
    {
        std::filesystem::create_directories(perfDir);
        startReceiver();
        SenderParams sp;
        sp.chunkBytes = 1024;
        sp.retryIntervalMs = 100;
        sp.giveUpAfterMs = 5000;
        sp.replyTimeoutMs = 3000;
        tx = std::make_unique<TakeSender>(sp, log);
    }
    uint32_t resumeWaitMs = 5000;
    void startReceiver()
    {
        ReceiverParams rp;
        rp.bindAddress = "127.0.0.1";
        rp.port = port;
        rp.sessionId = session;
        rp.resumeWaitMs = resumeWaitMs;
        rp.ackEveryChunks = 4;
        rx = std::make_unique<TakeReceiver>(rp, log);
        std::string err;
        REQUIRE(rx->start(err));
        rx->setAllowedPeer("127.0.0.1");
    }
    std::filesystem::path takeFile(uint32_t take) const
    {
        return perfDir / (takeStem(take, Role::Performer, session) + ".wav");
    }
    SendJob job(uint32_t take, const std::string& token) const
    {
        SendJob j;
        j.host = "127.0.0.1";
        j.port = port;
        j.sessionId = session;
        j.token = token;
        j.takeId = take;
        j.file = takeFile(take);
        return j;
    }
    std::string request(uint32_t take, uint64_t frames)
    {
        std::string token;
        std::string err;
        REQUIRE(rx->expect(take, frames, recvDir, token, err));
        return token;
    }
    // Runs one send to its end; returns {producer view, performer view}.
    std::pair<TransferView, TransferView> send(uint32_t take, const std::string& token)
    {
        std::string err;
        REQUIRE(tx->start(job(take, token), err));
        REQUIRE(wait_for([&] { return !tx->isBusy(); }));
        // The producer's view settles right after its RESULT.
        wait_for([&] {
            const auto v = find(rx->transfers(), take);
            return v && transferStateFinal(v->state);
        }, 3000ms);
        // Set RR_XFER_TRACE=1 to print both sides' history (diagnosis).
#ifdef _WIN32
        char* env = nullptr;
        size_t envLen = 0;
        const bool trace = _dupenv_s(&env, &envLen, "RR_XFER_TRACE") == 0 && env != nullptr;
        std::free(env);
#else
        const bool trace = std::getenv("RR_XFER_TRACE") != nullptr;
#endif
        for (const auto& line : rx->takeHistory())
        {
            if (trace)
            {
                std::fprintf(stderr, "producer  %s\n", line.c_str());
            }
        }
        for (const auto& line : tx->takeHistory())
        {
            if (trace)
            {
                std::fprintf(stderr, "performer %s\n", line.c_str());
            }
        }
        const auto p = find(rx->transfers(), take);
        const auto r = find(tx->transfers(), take);
        REQUIRE(r.has_value());
        return {p ? *p : TransferView{}, *r};
    }
    ~Rig()
    {
        tx.reset();
        rx.reset();
        log.stop();
    }
};

}  // namespace

// ---------------------------------------------------------------------------------------------
TEST_CASE("SHA-256 via Windows CNG matches the FIPS 180-2 test vectors", "[transfer]")
{
    Digest d{};
    std::string err;
    REQUIRE(sha256("", 0, d, err));
    CHECK(toHex(d) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    REQUIRE(sha256("abc", 3, d, err));
    CHECK(toHex(d) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const std::string m = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    Sha256 h;
    REQUIRE(h.init(err));
    REQUIRE(h.update(m.data(), 10, err));
    REQUIRE(h.update(m.data() + 10, m.size() - 10, err));
    REQUIRE(h.finish(d, err));
    CHECK(toHex(d) == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    Digest back{};
    CHECK(fromHex(toHex(d), back));
    CHECK(back == d);
    CHECK_FALSE(fromHex("xyz", back));
}

TEST_CASE("RRXF messages round-trip and malformed input is rejected", "[transfer]")
{
    XMsg o;
    o.type = XType::Offer;
    o.takeId = 7;
    o.fileBytes = 123456;
    o.chunkBytes = 32768;
    o.chunkCount = chunkCountFor(123456, 32768);
    o.fileSha[0] = 0xAB;
    o.sampleRate = 48000;
    o.channels = 1;
    o.bits = 32;
    o.formatTag = 3;
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
    CHECK(out.chunkCount == 4);
    CHECK(out.fileSha == o.fileSha);
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
    auto expectError = [](std::vector<uint8_t> b)
    {
        XDecoder d;
        d.feed(b.data(), b.size());
        XMsg m;
        std::string e;
        return d.next(m, e) == XDecoder::Result::Error;
    };
    CHECK(expectError({0x7F, 0xFF, 0xFF, 0xFF, 0, 1, 0, 0}));
    auto res = cb;
    res[6] = 1;
    CHECK(expectError(res));
    CHECK(expectError({0, 0, 0, 4, 0, 99, 0, 0}));
    XMsg a;
    a.type = XType::Ack;
    auto ack = encode(a);
    ack[3] = static_cast<uint8_t>(ack[3] + 1);
    ack.push_back(0);
    CHECK(expectError(ack));
    XMsg h;
    h.type = XType::Hello;
    h.sessionId = "ab12cd34";
    h.token = std::string(32, 'a');
    auto hb = encode(h);
    hb[8] = 'X';
    CHECK(expectError(hb));
}

TEST_CASE("received files are named by the producer; network names cannot reach the file system", "[transfer]")
{
    const std::filesystem::path dir = freshTempDir("xfer_names");
    ReceivePaths p;
    std::string err;
    REQUIRE(makeReceivePaths(dir, "ab12cd34", 7, p, err));
    CHECK(p.finalWav.filename() == "take07_performer_ab12cd34.wav");
    CHECK(pathIsInside(dir, p.partial));
    CHECK_FALSE(makeReceivePaths(dir, "../../x1", 7, p, err));
    CHECK_FALSE(makeReceivePaths(dir, "AB12CD34", 7, p, err));
    CHECK_FALSE(makeReceivePaths(dir, "ab12cd34", 0, p, err));
    CHECK_FALSE(makeReceivePaths(dir, "ab12cd34", 1000, p, err));
    CHECK_FALSE(pathIsInside(dir, dir / ".." / "evil.wav"));
    CHECK_FALSE(pathIsInside(dir, dir));
    CHECK_FALSE(pathIsInside(dir, std::filesystem::path("C:/Windows/evil.wav")));
    CHECK(displaySafeName("..\\..\\Windows\\evil.wav") == "evil.wav");
    CHECK(displaySafeName("../../") == "(unnamed)");
    CHECK(displaySafeName("..") == "_.");  // never "." or ".."
    CHECK(displaySafeName("a b:c?.wav") == "a_b_c_.wav");
}

TEST_CASE("the resume journal is strict: anything torn or foreign means start again", "[transfer]")
{
    Journal j;
    j.sessionId = "ab12cd34";
    j.takeId = 3;
    j.fileBytes = 99999;
    j.sha256Hex = std::string(64, 'f');
    j.chunkBytes = 1024;
    j.chunksDone = 42;
    const auto back = parseJournal(journalText(j));
    REQUIRE(back);
    CHECK(back->chunksDone == 42);
    std::string torn = journalText(j);
    torn.resize(torn.size() - 5);
    CHECK_FALSE(parseJournal(torn));
    CHECK_FALSE(parseJournal("rr-transfer-journal 2\n"));
    CHECK_FALSE(parseJournal(""));
}

#ifdef _WIN32
TEST_CASE("the original is opened read-only and other writers are refused while it is open", "[transfer]")
{
    const auto dir = freshTempDir("xfer_ro");
    const auto f = makeTake(dir / "take01_performer_ab12cd34.wav", 4800);
    const auto before = readAll(f);
    {
        ReadOnlyFile ro;
        std::string err;
        REQUIRE(ro.open(f, err));
        std::ofstream w(f, std::ios::binary | std::ios::app);
        CHECK_FALSE(w.is_open());  // sharing violation: no writer while the transfer holds it
    }
    CHECK(readAll(f) == before);
    // A partial file is created exclusively and never replaces an existing file.
    PartialFile pf;
    std::string err;
    REQUIRE(pf.open(dir / "x.partial", 0, err));
    REQUIRE(pf.writeAt(0, "abc", 3, err));
    pf.close();
    CHECK(readAll(dir / "x.partial").size() == 3);
}
#endif

// ---------------------------------------------------------------------------------------------
TEST_CASE("normal transfer: the copy is VERIFIED, identical, and the original is unchanged", "[transfer]")
{
    Rig r;
    const auto src = makeTake(r.takeFile(1), 48000);  // 1 s, 192 KB -> 188 chunks of 1 KiB
    const auto before = readAll(src);
    const auto token = r.request(1, 48000);
    const auto [prod, perf] = r.send(1, token);
    CHECK(prod.state == TransferState::Verified);
    CHECK(perf.state == TransferState::Verified);
    CHECK(perf.sourceUnchanged);
    CHECK(perf.sha256Hex == fileSha(src));
    CHECK(prod.connections == 1);
    CHECK(prod.resumes == 0);
    CHECK(prod.frames == 48000);
    CHECK(prod.sampleRate == 48000);
    CHECK(prod.durationS == 1.0);
    CHECK(prod.framesVsReport == "match");
    ReceivePaths p;
    std::string err;
    REQUIRE(makeReceivePaths(r.recvDir, r.session, 1, p, err));
    CHECK(readAll(p.finalWav) == before);
    CHECK(readAll(src) == before);
    CHECK(std::filesystem::exists(p.record));
    CHECK_FALSE(std::filesystem::exists(p.partial));
    CHECK_FALSE(std::filesystem::exists(p.journal));
    CHECK(inspectWav(p.finalWav).isCompleteFloatWav());
}

TEST_CASE("interrupted by the performer: the transfer resumes from the saved chunk and verifies", "[transfer]")
{
    Rig r;
    const auto src = makeTake(r.takeFile(2), 48000);
    const auto token = r.request(2, 48000);
    r.tx->testDropAfterChunks(60);
    const auto [prod, perf] = r.send(2, token);
    CHECK(prod.state == TransferState::Verified);
    CHECK(prod.connections >= 2);
    CHECK(prod.resumes >= 1);
    CHECK(prod.resumedFromChunk > 0);
    CHECK(prod.resumedFromChunk <= 60);
    CHECK(perf.sourceUnchanged);
    ReceivePaths p;
    std::string err;
    REQUIRE(makeReceivePaths(r.recvDir, r.session, 2, p, err));
    CHECK(sameBytes(p.finalWav, src));
}

TEST_CASE("interrupted by the producer: the performer reconnects and resumes", "[transfer]")
{
    Rig r;
    const auto src = makeTake(r.takeFile(3), 48000);
    const auto token = r.request(3, 48000);
    r.rx->testDropAfterChunks(70);
    const auto [prod, perf] = r.send(3, token);
    CHECK(prod.state == TransferState::Verified);
    CHECK(prod.resumes >= 1);
    CHECK(perf.resumes >= 1);
    CHECK(perf.sourceUnchanged);
}

TEST_CASE("a producer restart resumes from the journal on disk", "[transfer]")
{
    Rig r;
    makeTake(r.takeFile(4), 48000);
    auto token = r.request(4, 48000);
    // Sender: waits 3 s before reconnecting and gives up after 0.6 s of trouble, so the first
    // send ends FAILED while the producer service is down.
    r.tx = std::make_unique<TakeSender>(SenderParams{1024, 5000, 3000, 3000, 600, 1, 256 * 1024}, r.log);
    r.tx->testDropAfterChunks(50);
    std::string err;
    REQUIRE(r.tx->start(r.job(4, token), err));
    REQUIRE(wait_for([&] {
        const auto v = find(r.rx->transfers(), 4);
        return v && v->state == TransferState::Retrying;
    }));
    r.rx->stop();  // the producer app closes while the transfer is paused
    r.rx.reset();
    REQUIRE(wait_for([&] { return !r.tx->isBusy(); }));
    CHECK(find(r.tx->transfers(), 4)->state == TransferState::Failed);
    // A new producer service (same session folder) is asked again: it resumes from its journal.
    r.port = nextPort();
    r.startReceiver();
    token = r.request(4, 48000);
    r.tx = std::make_unique<TakeSender>(SenderParams{1024, 5000, 3000, 100, 5000, 1, 256 * 1024}, r.log);
    const auto [prod, perf] = r.send(4, token);
    CHECK(prod.state == TransferState::Verified);
    CHECK(prod.resumedFromChunk > 0);
    CHECK(perf.sourceUnchanged);
}

TEST_CASE("a chunk damaged in transit is rejected by its hash and sent again", "[transfer]")
{
    Rig r;
    const auto src = makeTake(r.takeFile(5), 24000);
    const auto token = r.request(5, 24000);
    r.tx->testCorruptChunk(10);
    const auto [prod, perf] = r.send(5, token);
    CHECK(prod.state == TransferState::Verified);
    CHECK(prod.chunkRejects == 1);
    CHECK(perf.chunkRejects == 1);
    ReceivePaths p;
    std::string err;
    REQUIRE(makeReceivePaths(r.recvDir, r.session, 5, p, err));
    CHECK(sameBytes(p.finalWav, src));
}

TEST_CASE("a whole-file hash mismatch is never VERIFIED; one clean resend verifies", "[transfer]")
{
    Rig r;
    const auto src = makeTake(r.takeFile(6), 24000);
    const auto token = r.request(6, 24000);
    r.tx->testCorruptConsistent(5, false);
    const auto [prod, perf] = r.send(6, token);
    CHECK(prod.state == TransferState::Verified);
    CHECK(prod.hashFailures == 1);
    CHECK(perf.hashFailures == 1);
    ReceivePaths p;
    std::string err;
    REQUIRE(makeReceivePaths(r.recvDir, r.session, 6, p, err));
    CHECK(sameBytes(p.finalWav, src));
    // The rejected copy was set aside, not deleted.
    std::filesystem::path aside = p.partial;
    aside += ".rejected-1";
    CHECK(std::filesystem::exists(aside));
}

TEST_CASE("persistent corruption ends FAILED, with no final file and the original intact", "[transfer]")
{
    Rig r;
    const auto src = makeTake(r.takeFile(7), 24000);
    const auto before = readAll(src);
    const auto token = r.request(7, 24000);
    r.tx->testCorruptConsistent(5, true);
    const auto [prod, perf] = r.send(7, token);
    CHECK(prod.state == TransferState::Failed);
    CHECK(perf.state == TransferState::Failed);
    CHECK(prod.hashFailures == 2);
    ReceivePaths p;
    std::string err;
    REQUIRE(makeReceivePaths(r.recvDir, r.session, 7, p, err));
    CHECK_FALSE(std::filesystem::exists(p.finalWav));
    CHECK(readAll(src) == before);
    CHECK(perf.sourceUnchanged);
}

TEST_CASE("duplicate requests: refused while queued; after VERIFIED nothing is rewritten", "[transfer]")
{
    Rig r;
    makeTake(r.takeFile(8), 12000);
    const auto token = r.request(8, 12000);
    std::string t2;
    std::string err;
    CHECK_FALSE(r.rx->expect(8, 12000, r.recvDir, t2, err));  // already queued
    auto first = r.send(8, token);
    REQUIRE(first.first.state == TransferState::Verified);
    ReceivePaths p;
    REQUIRE(makeReceivePaths(r.recvDir, r.session, 8, p, err));
    const auto mtime = std::filesystem::last_write_time(p.finalWav);
    const auto token2 = r.request(8, 12000);
    auto second = r.send(8, token2);
    CHECK(second.first.state == TransferState::Verified);
    CHECK(second.first.alreadyVerified);
    CHECK(second.first.frames == 12000);  // the existing copy was format-checked again, not just hashed
    CHECK(second.first.framesVsReport == "match");
    CHECK(second.second.alreadyVerified);
    CHECK(std::filesystem::last_write_time(p.finalWav) == mtime);
    // Only one copy, one record.
    size_t wavs = 0;
    for (const auto& e : std::filesystem::directory_iterator(r.recvDir))
    {
        wavs += e.path().extension() == ".wav" ? 1 : 0;
    }
    CHECK(wavs == 1);
}

TEST_CASE("a different existing file is never overwritten", "[transfer]")
{
    Rig r;
    makeTake(r.takeFile(9), 12000);
    ReceivePaths p;
    std::string err;
    REQUIRE(makeReceivePaths(r.recvDir, r.session, 9, p, err));
    std::filesystem::create_directories(r.recvDir);
    makeTake(p.finalWav, 100);  // something else already has the name
    const auto before = readAll(p.finalWav);
    const auto token = r.request(9, 12000);
    const auto [prod, perf] = r.send(9, token);
    CHECK(prod.state == TransferState::Failed);
    CHECK(perf.state == TransferState::Failed);
    CHECK(readAll(p.finalWav) == before);
}

TEST_CASE("wrong session, wrong token and unrequested takes are refused and nothing is written", "[transfer]")
{
    Rig r;
    makeTake(r.takeFile(10), 4800);
    makeTake(r.takeFile(11), 4800);
    const auto token = r.request(10, 4800);
    SECTION("wrong session")
    {
        r.tx->testOverrideHello("deadbeef", "");
        const auto res = r.send(10, token);
        CHECK(res.second.state == TransferState::Failed);
        CHECK(res.first.state == TransferState::Queued);  // still waiting for the real performer
    }
    SECTION("wrong token")
    {
        r.tx->testOverrideHello("", std::string(32, '0'));
        const auto res = r.send(10, token);
        CHECK(res.second.state == TransferState::Failed);
        CHECK(res.first.state == TransferState::Queued);
    }
    SECTION("take not requested")
    {
        std::string err;
        REQUIRE(r.tx->start(r.job(11, token), err));
        REQUIRE(wait_for([&] { return !r.tx->isBusy(); }));
        CHECK(find(r.tx->transfers(), 11)->state == TransferState::Failed);
        CHECK_FALSE(find(r.rx->transfers(), 11).has_value());
    }
    const bool wroteSomething = std::filesystem::exists(r.recvDir) && !std::filesystem::is_empty(r.recvDir);
    CHECK_FALSE(wroteSomething);
}

TEST_CASE("a file that is not a valid WAV is never VERIFIED", "[transfer]")
{
    Rig r;
    {
        std::ofstream junk(r.takeFile(12), std::ios::binary);
        for (int i = 0; i < 5000; ++i)
        {
            junk.put(static_cast<char>(i * 7));
        }
    }
    SECTION("the performer refuses to send it")
    {
        const auto token = r.request(12, 0);
        const auto res = r.send(12, token);
        CHECK(res.second.state == TransferState::Failed);
        CHECK(res.first.state == TransferState::Queued);
    }
    SECTION("the producer's own check refuses it even when the hash matches")
    {
        r.tx->testSkipWavCheck(true);
        const auto token = r.request(12, 0);
        const auto res = r.send(12, token);
        CHECK(res.first.state == TransferState::Failed);
        CHECK(res.second.state == TransferState::Failed);
        ReceivePaths p;
        std::string err;
        REQUIRE(makeReceivePaths(r.recvDir, r.session, 12, p, err));
        CHECK_FALSE(std::filesystem::exists(p.finalWav));
    }
}

TEST_CASE("connections from any address other than the joined performer are refused", "[transfer]")
{
    Rig r;
    makeTake(r.takeFile(13), 4800);
    r.rx->setAllowedPeer("10.11.12.13");
    const auto token = r.request(13, 4800);
    r.tx = std::make_unique<TakeSender>(SenderParams{1024, 1000, 1000, 100, 1500, 1, 256 * 1024}, r.log);
    const auto res = r.send(13, token);
    CHECK(res.second.state == TransferState::Failed);
    CHECK(res.first.state == TransferState::Queued);
    CHECK(r.rx->getRefusedConnections() >= 1);
}

TEST_CASE("a request the performer never acts on ends FAILED instead of blocking the producer", "[transfer]")
{
    Rig r;
    r.rx->stop();
    r.rx.reset();
    r.resumeWaitMs = 400;
    r.port = nextPort();
    r.startReceiver();
    r.request(14, 4800);
    CHECK(r.rx->anyActive());
    REQUIRE(wait_for([&] {
        const auto v = find(r.rx->transfers(), 14);
        return v && v->state == TransferState::Failed;
    }, 3000ms));
    CHECK_FALSE(r.rx->anyActive());
    CHECK(find(r.rx->transfers(), 14)->detail.find("did not start sending") != std::string::npos);
}
