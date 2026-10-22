# ADR-004: UI with Qt 6 Widgets (and Qt Network), dynamically linked under LGPL-3.0

- **Status:** Proposed. **Depends on OQ-05.** · **Traces:** APP-01, STA-*, DEV-*, D-06

## Facts checked on 11 Oct 2026
- **Versions:** the Qt release table lists 6.11.3 as the latest 6.11 patch, with standard support until 2027-03-17. 6.12.0 is the newest. 6.8 LTS patches are commercial-only.
- **Platforms:** the Qt 6.12 supported-platforms page lists Windows 10 (1809+) and 11 x64 with MSVC 2022 and MinGW-w64 15.1, and says 6.12 is "the last release to support Windows 10".
- **Licence:** Qt's licensing page lists GPLv3-only modules (for example Qt Graphs, Qt HTTP Server, Qt Network Authorization). **Core, Gui, Widgets and Network are not in that list.**
- **LGPL obligations** (Qt's page):
  - deliver the complete Qt source, or a written offer, "even if the library has not been modified at all";
  - link dynamically (recommended);
  - let the user relink and replace the libraries, with enough installation information to do it;
  - include the LGPL text and a prominent notice;
  - add no restrictions on the recipient's LGPL rights.

## Decision
- Use **Qt 6.11.3**, package `msvc2022_64`, modules **Core, Gui, Widgets and Network only**. Use no GPL-only modules, and link Qt **dynamically**.
- **Deployment folder:**
  - `LICENSES/`: LGPL-3.0 and GPL-3.0, plus Qt's third-party notices taken from the SBOM shipped with Qt (6.8+);
  - `NOTICE.txt`: names Qt, its version and where to get the source;
  - an About-box notice.
- **UI thread rule:** it renders snapshots and sends commands. It never blocks on the engine or the network.

## Risks
- These obligations apply as soon as the binaries are given to anyone. The checklist is part of the I-1 packaging task.
- Moving 6.11 → 6.12 later is low-risk for Widgets code.

## Alternatives
- **Win32 / WinUI:** more code for the same widgets.
- **Dear ImGui:** not native widgets.
- **JUCE GUI:** GPL or commercial licence.
