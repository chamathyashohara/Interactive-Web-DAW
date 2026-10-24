#pragma once
#include "PluginIpc.h"
#include <atomic>
#include <functional>
#include <juce_core/juce_core.h>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

/** Where daw_pluginhost.exe is: DAW_PLUGINHOST_PATH, next to the engine, or in the build's sibling artefacts folder. Empty if not found. */
std::string findPluginHostExe();

enum class PluginState : int { Starting = 0, Ready = 1, Crashed = 2, Failed = 3 };

/**
 * The engine's end of one plugin host process: launches `daw_pluginhost`, exchanges blocks with it through shared memory, and
 * watches whether it is alive. Everything except `process` runs off the audio thread. `process` never blocks (live mode): if the
 * host is not ready or is late, that block is silence and the engine carries on.
 */
class PluginClient
{
public:
    /** `blocking` = wait for the host each block (offline export: exact timing, no latency). */
    PluginClient(std::string hostExe, std::string pluginPath, std::string stateFile, double sampleRate, bool blocking);
    ~PluginClient();

    /** Creates the shared memory and starts the host (returns at once; the plugin loads in the background). False if it cannot start. */
    bool launch();
    /** Updates the state from the host (ready / failed) and the child process (crashed). Call regularly off the audio thread. */
    void poll();
    /** Asks the host to quit and waits briefly, then makes sure it is gone. */
    void shutdown();

    PluginState state() const { return st.load(std::memory_order_acquire); }
    std::string message() const;
    std::string pluginPath() const { return path; }
    std::string pluginName() const;
    bool blocking() const { return blockingMode; }
    uint64_t underruns() const { return underrunCount.load(std::memory_order_relaxed); }
    uint64_t droppedBlocks() const { return droppedCount.load(std::memory_order_relaxed); }
    uint64_t heartbeat() const;

    /** Tests only: terminates the host process to simulate a plugin crash. */
    void killHostForTest();

    /** Audio thread: sends this block's MIDI and fills `outL/outR` with plugin audio (zeros when not ready). */
    void process(const plugipc::MidiEv* midi, int midiCount, int frames, float* outL, float* outR);

private:
    void drain();

    std::string hostExe, path, stateFile, sessionId;
    double sr;
    bool blockingMode;
    void* map = nullptr;        // HANDLE
    void* reqEvent = nullptr;   // HANDLE
    void* doneEvent = nullptr;  // HANDLE
    plugipc::Shared* sh = nullptr;
    std::unique_ptr<juce::ChildProcess> child;
    std::atomic<PluginState> st{ PluginState::Starting };
    mutable std::mutex msgMutex;
    std::string msg;
    int64_t launchedAtMs = 0;
    uint64_t lastBeat = 0;
    int64_t lastBeatChangeMs = 0;

    // audio-thread state
    uint64_t submitted = 0, drained = 0;
    std::vector<float> ringL, ringR;
    int ringHead = 0, ringCount = 0;
    bool primed = false;
    std::atomic<uint64_t> underrunCount{ 0 }, droppedCount{ 0 };
};

/**
 * Owns the plugin clients, one per plugin track slot, so a host process survives the many project reloads (every edit republishes
 * the model). A watcher thread polls them and reports crashes; a crashed plugin restarts a couple of times, then stays off.
 */
class PluginManager
{
public:
    struct Wanted
    {
        int slot;
        std::string path;
        std::string stateB64; // the plugin's saved settings, base64 ("" = none)
    };
    /** state changes for the UI: slot, state, plugin name, message */
    using Report = std::function<void(int slot, PluginState, const std::string& name, const std::string& message)>;

    PluginManager(std::string hostExe, Report report);
    ~PluginManager();

    void setFormat(double sampleRate) { sr = sampleRate; }
    bool hostAvailable() const;
    /** Starts clients for new plugin tracks, keeps the ones unchanged, retires the ones no longer wanted. */
    void reconcile(const std::vector<Wanted>& wanted);
    PluginClient* clientFor(int slot);
    void shutdownAll();

private:
    struct Entry
    {
        int slot = 0;
        std::string path, stateB64;
        std::unique_ptr<PluginClient> client;
        PluginState reported = PluginState::Starting;
        int restarts = 0;
    };
    void watch();
    std::unique_ptr<PluginClient> makeClient(const Wanted& w);

    std::string hostExe;
    Report report;
    double sr = 48000.0;
    std::mutex mutex;
    std::vector<std::unique_ptr<Entry>> entries;
    std::vector<std::pair<int64_t, std::unique_ptr<PluginClient>>> retired; // freed a few seconds after the audio thread can no longer see them
    std::atomic<bool> stopWatching{ false };
    std::unique_ptr<juce::Thread> watcher;
};
