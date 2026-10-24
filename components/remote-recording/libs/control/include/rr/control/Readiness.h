#pragma once

// Readiness checklist (Stage 9): every item is shown on both PCs, passing ones included, so the
// producer can see exactly why a start is refused. Mandatory items must all pass before Record.
//
// Local items come from the recorder port (device, engine, folder, disk, other recording) and
// the session controller (consent, connection, clock offset). The performer sends its items to
// the producer in READY_STATUS (tag ReadyChecks, protocol 1.1) as "id=0|1" pairs; the details
// travel in the existing Reasons text.

#include <cstdint>
#include <string>
#include <vector>

enum class ReadyItem : uint8_t
{
    InputDevice = 0,        // an input device is open
    EngineHealthy = 1,      // capture callbacks arriving, no device fault, required sample rate
    FolderWritable = 2,     // the recordings folder exists and a test file can be written
    DiskSpace = 3,          // free space >= max take length at the device format + 1 MB (REC-09 policy)
    NoActiveRecording = 4,  // no other local take is open
    Consent = 5,            // this person gave recording consent (the performer's arm action)
    Connected = 6,          // control link connected to the other PC
    ClockOffset = 7,        // performer: enough clock-offset samples to convert the start time
};

struct ReadinessCheck
{
    ReadyItem item = ReadyItem::InputDevice;
    bool ok = false;
    bool mandatory = true;
    std::string detail;  // e.g. "51 200 MB free, 1 320 MB needed"
};

const char* readyItemId(ReadyItem item) noexcept;     // "input", "engine", ...
const char* readyItemLabel(ReadyItem item) noexcept;  // "Input device open", ...
bool readyItemFromId(const std::string& id, ReadyItem& out) noexcept;

/** "input=1,engine=1,folder=0,..." (fits the 256-byte string limit for all items). */
std::string encodeChecks(const std::vector<ReadinessCheck>& checks);
/** Unknown ids are skipped (a newer peer may send more items). */
std::vector<ReadinessCheck> decodeChecks(const std::string& text);

bool allMandatoryOk(const std::vector<ReadinessCheck>& checks) noexcept;

