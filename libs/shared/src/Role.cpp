#include "rr/shared/Role.h"

std::string_view roleId(Role role) noexcept
{
    switch (role)
    {
    case Role::Producer: return "producer";
    case Role::Performer: return "performer";
    }
    return "unknown";
}

std::string_view roleDisplayName(Role role) noexcept
{
    switch (role)
    {
    case Role::Producer: return "Producer Studio";
    case Role::Performer: return "Performer Client";
    }
    return "Unknown role";
}

std::string_view roleExecutableName(Role role) noexcept
{
    switch (role)
    {
    case Role::Producer: return "ProducerStudio";
    case Role::Performer: return "PerformerClient";
    }
    return "Unknown";
}

std::string_view roleSummary(Role role) noexcept
{
    switch (role)
    {
    case Role::Producer:
        return "Creates the session, controls recording start and stop, and talks to the performer.";
    case Role::Performer:
        return "Joins the producer's session, records its own microphone locally, and talks to the producer.";
    }
    return "";
}

