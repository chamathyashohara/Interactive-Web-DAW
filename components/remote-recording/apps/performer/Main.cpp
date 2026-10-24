// PerformerClient.exe entry point. Qt supplies WinMain for this WIN32 executable.
#include "rr/ui/AppRunner.h"

int main(int argc, char* argv[])
{
    return runApplication(Role::Performer, argc, argv);
}
