# Live recording in the DAW (Component 4 -> the DAW)

Component 4 (remote recording, `components/remote-recording`) is two separate Qt programs: **Producer Studio** and **Performer Client**.
Qt windows cannot be placed inside the DAW's window, so the DAW does not embed them. Its **Live recording** button (next to Collaborate)
is a small lab that opens the right program and brings the recordings back into the project. **Component 4 itself is unchanged.**

## What the tab does

1. **Who are you?** Two buttons, **I'm the Producer** (opens Producer Studio) and **I'm the Singer** (opens Performer Client), each as its own window.
   The programs are found in `components/remote-recording/build/**` (a Release build first); if they are not built the tab says so, and
   **Locate…** points it at the `.exe` (remembered in the user-data folder). Build steps: `components/remote-recording/docs/build/WINDOWS_BUILD.md`
   (needs MSVC and Qt 6; Qt is not needed for the DAW itself).
2. **Recordings.** The tab watches the folder the recorder saves into (`Music\RemoteRecording`, the recorder's own default; **Change…** if it was moved).
   A finished WAV (its size has stopped changing) is listed with **Add to project**. That copies it into the sound library as a pack called
   "Recording <name>" (the original is untouched) and puts it on a **new sample track at the start of the song**. It respects Beginner mode:
   adding sounds stays locked until its lesson, and the tab names the lesson. **Add a recording file…** adds any WAV by hand.
3. **This room (same network only).** When you are in a collaboration session on one network, the Producer types the address, port (52000 by
   default) and pairing code that Producer Studio shows and presses **Share with the room**. Everyone else's tab shows them with Copy buttons, ready
   to paste into Performer Client (it asks for exactly: producer address, TCP port, pairing code). A pairing code works once and lasts 10 minutes, so
   for a second singer the Producer presses **New pairing code** in Producer Studio and **Update** here. The note disappears when the Producer leaves
   or presses **Stop sharing**; people who join later still get it. If the room is over the internet (a server that is not on a private address), the tab
   says live recording needs everyone on the same network, and the two programs still work on their own. Online recording is left to Component 4's owner.

Collaboration side: a small "note in the room" message (`share`) was added to `@daw/collab` (protocol, server, client; `packages/collab/test/share.test.ts`)
and `isLanHost` decides what counts as the same network. These two are new in `packages/collab` only; the standalone `components/collaboration` copy does not have them.

## Limits to know

- The Qt programs take no start-up options, so the DAW cannot fill the address and code in for the Singer; they are copied by hand.
- Both audio programs use the sound card at once; this was not tested (a headphone-wearing singer avoids the backing track bleeding into the mic).
  There is no shared start time between the DAW's playback and a take.
- In a collaboration session the new track refers to the recording by library id only, so other people see the track but not its audio until a
  file-sharing channel exists (the audio is on the Producer's PC).
- Checked with the **real** programs on one PC (Qt 6.11.3, MSVC 19.44, Release build; Component 4's own 171 tests pass): the DAW finds both under
  `components/remote-recording/build/msvc-x64/bin/Release` and the two buttons open them as running windows. The automated tests still use a stand-in
  program and generated WAV files, so they run without Qt. A full session between the real programs, started from the DAW, and anything on two PCs, have not been tried.

## Building the two programs (one time per PC)

Needs Visual Studio 2022 Build Tools (C++), CMake and Qt 6.11.3 for MSVC 2022 (Core, Gui, Widgets, Svg). Put Qt in a folder and set `RR_QT_DIR` to it, then in
`components/remote-recording`: `cmake --preset msvc-x64` and `cmake --build --preset msvc-x64-release`. Full guide: `components/remote-recording/docs/build/WINDOWS_BUILD.md`.

## Tests

- `npm test` (`apps/desktop/src/main/recording/recording.test.ts`, `packages/collab/test/share.test.ts`, `address.test.ts`)
- `node apps/desktop/e2e/recording.mjs` (15 checks): buttons, missing program, Locate, folder watching, Add to project, the engine plays the take, Beginner-mode lock.
- `node apps/desktop/e2e/recording-room.mjs` (12 checks): two windows, Producer shares, a Singer who joins later sees it, update, stop, session end.
