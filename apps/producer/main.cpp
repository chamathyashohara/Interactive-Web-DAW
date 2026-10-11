// ProducerStudio.exe entry point. Qt supplies WinMain for this WIN32 executable.
#include "rr/ui/app_runner.hpp"

int main(int argc, char* argv[]) {
    return rr::ui::run_application(rr::Role::Producer, argc, argv);
}
