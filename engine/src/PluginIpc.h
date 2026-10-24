#pragma once
#include <atomic>
#include <cstdint>
#include <string>

/**
 * Shared-memory protocol between the engine and one plugin host process (`daw_pluginhost`).
 *
 * Why a separate process: a plugin is someone else's code and can crash or hang (Spire segfaults when hosted in-process).
 * Out of process, a dead plugin only silences its own track; the engine keeps playing.
 *
 * The audio path never blocks: each engine block writes its MIDI into a ring slot and signals the host, and reads the audio the
 * host finished for an EARLIER block (about one block of latency; exports use a blocking mode with no latency). Plain C++ and
 * atomics only, so both programs (and the tests) share this one header.
 */
namespace plugipc
{
constexpr uint32_t kMagic = 0x58474C50; // "PLGX"
constexpr uint32_t kVersion = 1;
constexpr int kSlots = 8;        // ring depth (blocks in flight)
constexpr int kMaxFrames = 4096; // most frames one block may carry
constexpr int kMaxMidi = 512;    // most MIDI events one block may carry

struct MidiEv
{
    int32_t offset; // sample offset inside the block
    uint8_t status, data1, data2, pad;
};

struct Slot
{
    uint32_t frames;
    uint32_t midiCount;
    MidiEv midi[kMaxMidi];
    float left[kMaxFrames];
    float right[kMaxFrames];
};

enum HostState : uint32_t { kStarting = 0, kReady = 1, kFailed = 2 };

struct Shared
{
    uint32_t magic;
    uint32_t version;
    uint32_t sampleRate;
    uint32_t enginePid; // the host exits when this process is gone
    std::atomic<uint32_t> hostState;
    std::atomic<uint32_t> latencySamples;
    std::atomic<uint64_t> requestSeq; // engine -> host: blocks submitted
    std::atomic<uint64_t> doneSeq;    // host -> engine: blocks finished
    std::atomic<uint64_t> hostBeat;   // the host bumps this every loop (a stuck host stops moving it)
    std::atomic<uint32_t> quit;
    char error[256];
    char name[128];
    Slot slots[kSlots];
};

inline std::string mapName(const std::string& id) { return "Local\\daw_plug_" + id + "_map"; }
inline std::string requestEventName(const std::string& id) { return "Local\\daw_plug_" + id + "_req"; }
inline std::string doneEventName(const std::string& id) { return "Local\\daw_plug_" + id + "_done"; }
} // namespace plugipc
