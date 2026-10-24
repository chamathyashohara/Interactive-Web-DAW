#pragma once

/** Offline sequencer + mixer tests (no audio device). Returns 0 on success. Prints a JSON summary to stdout. */
int runSelfTest();

/** Offline CPU-cost benchmark of the full render path at block sizes 64..1024 (no audio device). */
int runBenchmark();
