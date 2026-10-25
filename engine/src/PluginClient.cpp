#ifndef NOMINMAX
#define NOMINMAX
#endif
#include "PluginClient.h"
#include <algorithm>
#include <cstring>
#ifdef _WIN32
#include <windows.h>
#endif

namespace
{
std::atomic<int> sessionCounter{ 0 };
constexpr int kRingFrames = plugipc::kMaxFrames * 4;
constexpr int64_t kStartTimeoutMs = 45000; // a big plugin can take a while to load
constexpr int64_t kHangTimeoutMs = 5000;   // the host loop bumps its heartbeat every ~20 ms; this long without it = stuck
} // namespace

PluginClient::PluginClient(std::string hostExePath, std::string pluginFile, std::string stateFilePath, double sampleRate, bool blocking)
    : hostExe(std::move(hostExePath)), path(std::move(pluginFile)), stateFile(std::move(stateFilePath)), sr(sampleRate), blockingMode(blocking)
{
    ringL.assign(static_cast<size_t>(kRingFrames), 0.0f);
    ringR.assign(static_cast<size_t>(kRingFrames), 0.0f);
#ifdef _WIN32
    sessionId = std::to_string(static_cast<unsigned long>(GetCurrentProcessId())) + "_" + std::to_string(++sessionCounter);
#else
    sessionId = "0_" + std::to_string(++sessionCounter);
#endif
    if (!blockingMode) // only the live host is edited; the export host just plays the settings it is given
        stateOutFile = juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("daw_pluginout_" + juce::String(sessionId) + ".bin").getFullPathName().toStdString();
}

PluginClient::~PluginClient()
{
    shutdown();
    if (!stateOutFile.empty()) juce::File(juce::String::fromUTF8(stateOutFile.c_str())).deleteFile();
}

void PluginClient::openEditor()
{
    if (sh != nullptr && st.load(std::memory_order_acquire) == PluginState::Ready) sh->openEditorSeq.fetch_add(1, std::memory_order_release);
}
bool PluginClient::editorOpen() const { return sh != nullptr && sh->editorOpen.load(std::memory_order_acquire) != 0; }

bool PluginClient::takeSavedState(std::string& state)
{
    if (sh == nullptr) return false;
    const uint32_t seq = sh->stateSeq.load(std::memory_order_acquire);
    if (seq == seenStateSeq) return false;
    seenStateSeq = seq;
    juce::MemoryBlock data;
    if (!juce::File(juce::String::fromUTF8(stateOutFile.c_str())).loadFileAsData(data) || data.getSize() == 0) return false;
    state = juce::Base64::toBase64(data.getData(), data.getSize()).toStdString();
    return true;
}

std::string PluginClient::message() const
{
    std::lock_guard<std::mutex> lock(msgMutex);
    return msg;
}
std::string PluginClient::pluginName() const
{
    return (sh != nullptr && sh->name[0] != '\0') ? std::string(sh->name) : std::string();
}
uint64_t PluginClient::heartbeat() const { return sh != nullptr ? sh->hostBeat.load(std::memory_order_relaxed) : 0; }

#ifdef _WIN32
bool PluginClient::launch()
{
    shutdown(); // a restart starts from nothing
    const juce::File exe(juce::String::fromUTF8(hostExe.c_str()));
    auto fail = [&](const std::string& why) {
        std::lock_guard<std::mutex> lock(msgMutex);
        msg = why;
        st.store(PluginState::Failed, std::memory_order_release);
        return false;
    };
    if (!exe.existsAsFile()) return fail("the plugin host program (daw_pluginhost.exe) was not found next to the engine");

    HANDLE m = CreateFileMappingA(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, static_cast<DWORD>(sizeof(plugipc::Shared)), plugipc::mapName(sessionId).c_str());
    if (m == nullptr) return fail("could not create shared memory for the plugin");
    auto* shared = static_cast<plugipc::Shared*>(MapViewOfFile(m, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(plugipc::Shared)));
    if (shared == nullptr)
    {
        CloseHandle(m);
        return fail("could not map shared memory for the plugin");
    }
    std::memset(static_cast<void*>(shared), 0, sizeof(plugipc::Shared)); // fresh mapping is zeroed already; be explicit before the host opens it
    shared->magic = plugipc::kMagic;
    shared->version = plugipc::kVersion;
    shared->sampleRate = static_cast<uint32_t>(sr);
    shared->enginePid = static_cast<uint32_t>(GetCurrentProcessId());
    HANDLE rq = CreateEventA(nullptr, FALSE, FALSE, plugipc::requestEventName(sessionId).c_str());
    HANDLE dn = CreateEventA(nullptr, FALSE, FALSE, plugipc::doneEventName(sessionId).c_str());

    map = m;
    sh = shared;
    reqEvent = rq;
    doneEvent = dn;

    juce::StringArray args;
    args.add(exe.getFullPathName());
    args.add("--id"); args.add(sessionId);
    args.add("--plugin"); args.add(juce::String::fromUTF8(path.c_str()));
    args.add("--sr"); args.add(juce::String(static_cast<int>(sr)));
    args.add("--engine-pid"); args.add(juce::String(static_cast<int>(GetCurrentProcessId())));
    // a restarted host starts from the newest settings the user made, not the ones the project had when the plugin was added
    const bool haveNewer = !stateOutFile.empty() && juce::File(juce::String::fromUTF8(stateOutFile.c_str())).existsAsFile();
    const std::string& startState = haveNewer ? stateOutFile : stateFile;
    if (!startState.empty()) { args.add("--state"); args.add(juce::String::fromUTF8(startState.c_str())); }
    if (!stateOutFile.empty()) { args.add("--state-out"); args.add(juce::String::fromUTF8(stateOutFile.c_str())); }
    child = std::make_unique<juce::ChildProcess>();
    if (!child->start(args))
    {
        shutdown();
        return fail("could not start the plugin host program");
    }

    submitted = drained = 0;
    seenStateSeq = 0; // the new shared memory starts counting again
    ringHead = ringCount = 0;
    primed = false;
    launchedAtMs = static_cast<int64_t>(juce::Time::getMillisecondCounterHiRes());
    lastBeat = 0;
    lastBeatChangeMs = launchedAtMs;
    { std::lock_guard<std::mutex> lock(msgMutex); msg.clear(); }
    st.store(PluginState::Starting, std::memory_order_release);
    return true;
}

void PluginClient::shutdown()
{
    st.store(PluginState::Failed, std::memory_order_release); // the audio thread stops touching the shared memory
    juce::Thread::sleep(40);                                  // let a block that was already inside process() finish
    if (sh != nullptr) sh->quit.store(1, std::memory_order_release);
    if (reqEvent != nullptr) SetEvent(static_cast<HANDLE>(reqEvent));
    if (child != nullptr)
    {
        const auto t0 = juce::Time::getMillisecondCounter();
        while (child->isRunning() && juce::Time::getMillisecondCounter() - t0 < 1500) juce::Thread::sleep(10);
        if (child->isRunning()) child->kill();
        child.reset();
    }
    if (sh != nullptr) UnmapViewOfFile(sh);
    if (map != nullptr) CloseHandle(static_cast<HANDLE>(map));
    if (reqEvent != nullptr) CloseHandle(static_cast<HANDLE>(reqEvent));
    if (doneEvent != nullptr) CloseHandle(static_cast<HANDLE>(doneEvent));
    sh = nullptr;
    map = reqEvent = doneEvent = nullptr;
}

void PluginClient::poll()
{
    const PluginState now = st.load(std::memory_order_acquire);
    if (sh == nullptr || child == nullptr) return;
    const int64_t t = static_cast<int64_t>(juce::Time::getMillisecondCounterHiRes());
    const bool running = child->isRunning();

    if (now == PluginState::Starting)
    {
        const uint32_t hs = sh->hostState.load(std::memory_order_acquire);
        if (hs == plugipc::kReady) { st.store(PluginState::Ready, std::memory_order_release); return; }
        if (hs == plugipc::kFailed)
        {
            std::lock_guard<std::mutex> lock(msgMutex);
            msg = sh->error[0] != '\0' ? std::string(sh->error) : std::string("the plugin could not be loaded");
            st.store(PluginState::Failed, std::memory_order_release);
            return;
        }
        if (!running)
        {
            std::lock_guard<std::mutex> lock(msgMutex);
            msg = "the plugin crashed while loading";
            st.store(PluginState::Crashed, std::memory_order_release);
        }
        else if (t - launchedAtMs > kStartTimeoutMs)
        {
            child->kill();
            std::lock_guard<std::mutex> lock(msgMutex);
            msg = "the plugin took too long to load";
            st.store(PluginState::Failed, std::memory_order_release);
        }
        return;
    }
    if (now == PluginState::Ready)
    {
        if (!running)
        {
            std::lock_guard<std::mutex> lock(msgMutex);
            msg = "the plugin crashed";
            st.store(PluginState::Crashed, std::memory_order_release);
            return;
        }
        const uint64_t beat = sh->hostBeat.load(std::memory_order_relaxed);
        if (beat != lastBeat) { lastBeat = beat; lastBeatChangeMs = t; }
        else if (t - lastBeatChangeMs > kHangTimeoutMs)
        {
            child->kill();
            std::lock_guard<std::mutex> lock(msgMutex);
            msg = "the plugin stopped responding";
            st.store(PluginState::Crashed, std::memory_order_release);
        }
    }
}

void PluginClient::drain()
{
    const uint64_t done = sh->doneSeq.load(std::memory_order_acquire);
    while (drained < done)
    {
        const plugipc::Slot& slot = sh->slots[drained % plugipc::kSlots];
        const int frames = static_cast<int>(std::min<uint32_t>(slot.frames, plugipc::kMaxFrames));
        for (int i = 0; i < frames; ++i)
        {
            if (ringCount >= kRingFrames) { ringHead = (ringHead + 1) % kRingFrames; --ringCount; } // too far behind: drop the oldest
            const int idx = (ringHead + ringCount) % kRingFrames;
            ringL[static_cast<size_t>(idx)] = slot.left[i];
            ringR[static_cast<size_t>(idx)] = slot.right[i];
            ++ringCount;
        }
        ++drained;
    }
}

void PluginClient::process(const plugipc::MidiEv* midi, int midiCount, int frames, float* outL, float* outR)
{
    if (st.load(std::memory_order_acquire) != PluginState::Ready || sh == nullptr || frames <= 0 || frames > plugipc::kMaxFrames)
    {
        std::memset(outL, 0, sizeof(float) * static_cast<size_t>(std::max(0, frames)));
        std::memset(outR, 0, sizeof(float) * static_cast<size_t>(std::max(0, frames)));
        return;
    }
    drain();
    // submit this block (unless the host is a full ring behind: then drop this block rather than overwrite what it is reading)
    if (submitted - sh->doneSeq.load(std::memory_order_acquire) < static_cast<uint64_t>(plugipc::kSlots - 1))
    {
        plugipc::Slot& slot = sh->slots[submitted % plugipc::kSlots];
        slot.frames = static_cast<uint32_t>(frames);
        slot.midiCount = static_cast<uint32_t>(std::min(midiCount, plugipc::kMaxMidi));
        if (slot.midiCount > 0) std::memcpy(slot.midi, midi, sizeof(plugipc::MidiEv) * slot.midiCount);
        ++submitted;
        sh->requestSeq.store(submitted, std::memory_order_release);
        SetEvent(static_cast<HANDLE>(reqEvent));
    }
    else droppedCount.fetch_add(1, std::memory_order_relaxed);

    if (blockingMode)
    {
        // offline render: wait (up to a few seconds) for the host to finish exactly this block, so the audio is on time
        const int64_t t0 = static_cast<int64_t>(juce::Time::getMillisecondCounterHiRes());
        while (sh->doneSeq.load(std::memory_order_acquire) < submitted && static_cast<int64_t>(juce::Time::getMillisecondCounterHiRes()) - t0 < 8000)
            WaitForSingleObject(static_cast<HANDLE>(doneEvent), 20);
        drain();
    }
    else if (!primed)
    {
        // live: the first block has nothing to read yet; start one block behind so steady state never runs dry
        for (int i = 0; i < frames; ++i)
        {
            const int idx = (ringHead + ringCount) % kRingFrames;
            ringL[static_cast<size_t>(idx)] = 0.0f;
            ringR[static_cast<size_t>(idx)] = 0.0f;
            ++ringCount;
        }
        primed = true;
    }

    for (int i = 0; i < frames; ++i)
    {
        if (ringCount > 0)
        {
            outL[i] = ringL[static_cast<size_t>(ringHead)];
            outR[i] = ringR[static_cast<size_t>(ringHead)];
            ringHead = (ringHead + 1) % kRingFrames;
            --ringCount;
        }
        else
        {
            outL[i] = outR[i] = 0.0f;
            underrunCount.fetch_add(1, std::memory_order_relaxed);
        }
    }
}
void PluginClient::killHostForTest()
{
    if (child != nullptr) child->kill();
}
#else
void PluginClient::killHostForTest() {}
bool PluginClient::launch() { st.store(PluginState::Failed, std::memory_order_release); return false; }
void PluginClient::shutdown() {}
void PluginClient::poll() {}
void PluginClient::drain() {}
void PluginClient::process(const plugipc::MidiEv*, int, int frames, float* outL, float* outR)
{
    std::memset(outL, 0, sizeof(float) * static_cast<size_t>(std::max(0, frames)));
    std::memset(outR, 0, sizeof(float) * static_cast<size_t>(std::max(0, frames)));
}
#endif

// ---------------------------------------------------------------------------------------------------------------- manager

PluginManager::PluginManager(std::string hostExePath, Report reportFn, SavedReport savedFn)
    : hostExe(std::move(hostExePath)), report(std::move(reportFn)), savedReport(std::move(savedFn))
{
    struct Watcher : juce::Thread
    {
        PluginManager& owner;
        explicit Watcher(PluginManager& o) : juce::Thread("plugin watcher"), owner(o) {}
        void run() override
        {
            while (!threadShouldExit())
            {
                owner.watch();
                wait(100);
            }
        }
    };
    watcher = std::make_unique<Watcher>(*this);
    watcher->startThread();
}

PluginManager::~PluginManager()
{
    watcher->stopThread(2000);
    shutdownAll();
}

bool PluginManager::hostAvailable() const { return juce::File(juce::String::fromUTF8(hostExe.c_str())).existsAsFile(); }

std::unique_ptr<PluginClient> PluginManager::makeClient(const Wanted& w)
{
    const std::string stateFile = writePluginStateFile(w.stateB64);
    auto client = std::make_unique<PluginClient>(hostExe, w.path, stateFile, sr, false);
    client->launch();
    return client;
}

void PluginManager::reconcile(const std::vector<Wanted>& wanted)
{
    std::lock_guard<std::mutex> lock(mutex);
    const int64_t now = static_cast<int64_t>(juce::Time::getMillisecondCounterHiRes());
    // keep what is unchanged, retire what is gone or changed
    for (auto it = entries.begin(); it != entries.end();)
    {
        const auto w = std::find_if(wanted.begin(), wanted.end(), [&](const Wanted& x) { return x.slot == (*it)->slot && x.path == (*it)->path; });
        if (w == wanted.end())
        {
            retired.emplace_back(now, std::move((*it)->client));
            it = entries.erase(it);
        }
        else
            ++it;
    }
    for (const auto& w : wanted)
    {
        if (std::any_of(entries.begin(), entries.end(), [&](const auto& e) { return e->slot == w.slot; })) continue;
        auto e = std::make_unique<Entry>();
        e->slot = w.slot;
        e->path = w.path;
        e->stateB64 = w.stateB64;
        e->client = makeClient(w);
        entries.push_back(std::move(e));
    }
}

PluginClient* PluginManager::clientFor(int slot)
{
    std::lock_guard<std::mutex> lock(mutex);
    for (auto& e : entries)
        if (e->slot == slot) return e->client.get();
    return nullptr;
}

void PluginManager::openEditor(int slot)
{
    std::lock_guard<std::mutex> lock(mutex);
    for (auto& e : entries)
        if (e->slot == slot) e->client->openEditor();
}

void PluginManager::watch()
{
    std::vector<std::pair<int, std::string>> saved;
    std::vector<std::pair<int, PluginState>> changes;
    std::vector<std::string> names, messages;
    {
        std::lock_guard<std::mutex> lock(mutex);
        const int64_t now = static_cast<int64_t>(juce::Time::getMillisecondCounterHiRes());
        for (auto& e : entries)
        {
            e->client->poll();
            if (std::string st; e->client->takeSavedState(st)) saved.emplace_back(e->slot, std::move(st));
            const PluginState s = e->client->state();
            if (s != e->reported)
            {
                e->reported = s;
                changes.emplace_back(e->slot, s);
                names.push_back(e->client->pluginName());
                messages.push_back(e->client->message());
            }
            // a crashed plugin gets two more tries (a plugin that crashes on load every time stays off)
            if (s == PluginState::Crashed && e->restarts < 2)
            {
                ++e->restarts;
                e->client->launch();
                e->reported = PluginState::Starting;
            }
        }
        // free retired clients a few seconds after they stopped being referenced by any published model
        for (auto it = retired.begin(); it != retired.end();)
            it = (now - it->first > 5000) ? retired.erase(it) : it + 1;
    }
    for (size_t i = 0; i < changes.size(); ++i)
        if (report) report(changes[i].first, changes[i].second, names[i], messages[i]);
    for (const auto& s : saved)
        if (savedReport) savedReport(s.first, s.second);
}

void PluginManager::shutdownAll()
{
    std::lock_guard<std::mutex> lock(mutex);
    for (auto& e : entries) e->client->shutdown();
    entries.clear();
    retired.clear();
}

std::string findPluginHostExe()
{
    if (const juce::String env = juce::SystemStats::getEnvironmentVariable("DAW_PLUGINHOST_PATH", {}); env.isNotEmpty() && juce::File(env).existsAsFile())
        return env.toStdString();
    const juce::File exe = juce::File::getSpecialLocation(juce::File::currentExecutableFile);
    const juce::File sameDir = exe.getSiblingFile("daw_pluginhost.exe");
    if (sameDir.existsAsFile()) return sameDir.getFullPathName().toStdString();
    // build layout: <build>/daw_engine_artefacts/<Config>/daw_engine.exe  ->  <build>/daw_pluginhost_artefacts/<Config>/daw_pluginhost.exe
    const juce::File config = exe.getParentDirectory();
    const juce::File build = config.getParentDirectory().getParentDirectory();
    const juce::File sibling = build.getChildFile("daw_pluginhost_artefacts").getChildFile(config.getFileName()).getChildFile("daw_pluginhost.exe");
    return sibling.existsAsFile() ? sibling.getFullPathName().toStdString() : std::string();
}

std::string writePluginStateFile(const std::string& stateB64)
{
    if (stateB64.empty()) return {};
    juce::MemoryOutputStream out;
    if (!juce::Base64::convertFromBase64(out, juce::String(stateB64))) return {};
    const juce::File f = juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("daw_pluginstate_" + juce::String(juce::Random::getSystemRandom().nextInt64()) + ".bin");
    return f.replaceWithData(out.getData(), out.getDataSize()) ? f.getFullPathName().toStdString() : std::string();
}
