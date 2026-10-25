#include "PluginTest.h"
#include "PluginClient.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <juce_core/juce_core.h>
#include <vector>

int runPluginTest(const std::string& pluginPath, bool crash)
{
    const std::string host = findPluginHostExe();
    if (host.empty())
    {
        std::printf("{\"t\":\"plugintest\",\"ok\":false,\"error\":\"daw_pluginhost.exe not found\"}\n");
        return 1;
    }
    constexpr int block = 480, rate = 48000;
    PluginClient client(host, pluginPath, "", rate, false);
    if (!client.launch())
    {
        std::printf("{\"t\":\"plugintest\",\"ok\":false,\"error\":\"%s\"}\n", client.message().c_str());
        return 1;
    }
    const auto t0 = juce::Time::getMillisecondCounter();
    while (client.state() == PluginState::Starting && juce::Time::getMillisecondCounter() - t0 < 60000)
    {
        client.poll();
        juce::Thread::sleep(20);
    }
    if (client.state() != PluginState::Ready)
    {
        std::printf("{\"t\":\"plugintest\",\"ok\":false,\"state\":%d,\"error\":\"%s\"}\n", static_cast<int>(client.state()), client.message().c_str());
        return 1;
    }
    const std::string name = client.pluginName();

    // play like the engine does: one block every 10 ms, the note held for 1.5 s
    std::vector<float> l(block), r(block);
    float peakBefore = 0.0f, peakAfterKill = 0.0f;
    const int total = crash ? 260 : 200, killAt = 100;
    for (int b = 0; b < total; ++b)
    {
        plugipc::MidiEv ev[2];
        int n = 0;
        if (b == 0) ev[n++] = { 0, 0x90, 60, 100, 0 };
        if (b == 150) ev[n++] = { 0, 0x80, 60, 0, 0 };
        if (crash && b == killAt) client.killHostForTest();
        client.process(ev, n, block, l.data(), r.data());
        client.poll();
        float pk = 0.0f;
        for (int i = 0; i < block; ++i) pk = std::max(pk, std::max(std::fabs(l[static_cast<size_t>(i)]), std::fabs(r[static_cast<size_t>(i)])));
        if (b >= 20 && b < killAt) peakBefore = std::max(peakBefore, pk);
        if (crash && b >= killAt + 30) peakAfterKill = std::max(peakAfterKill, pk);
        juce::Thread::sleep(10);
    }
    const bool audible = peakBefore > 0.001f;
    const bool silentAfter = !crash || peakAfterKill < 1.0e-6f;
    const bool survived = !crash || (client.state() == PluginState::Crashed && silentAfter);
    (void) rate;
    std::printf("{\"t\":\"plugintest\",\"ok\":true,\"name\":\"%s\",\"audible\":%s,\"peak\":%.5f,\"underruns\":%llu,\"dropped\":%llu,\"crashTest\":%s,\"stateAfter\":%d,\"silentAfterCrash\":%s}\n",
                name.c_str(), audible ? "true" : "false", peakBefore, static_cast<unsigned long long>(client.underruns()), static_cast<unsigned long long>(client.droppedBlocks()),
                crash ? "true" : "false", static_cast<int>(client.state()), silentAfter ? "true" : "false");
    return (audible && survived) ? 0 : 2;
}
