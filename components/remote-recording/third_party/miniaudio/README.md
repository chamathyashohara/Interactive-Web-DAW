# miniaudio (vendored)

| Item | Value |
|---|---|
| Version | 0.11.25 (`MA_VERSION_REVISION 25`) |
| Source | `https://raw.githubusercontent.com/mackron/miniaudio/0.11.25/miniaudio.h` and `/LICENSE` |
| Downloaded | 11 October 2026 |
| SHA-256 `miniaudio.h` | `ac7af4de748b7e26b777f37e01cee313a308a7296a3eb080e2906b320cc55c89` |
| SHA-256 `LICENSE` | `457f1b500e0adf6bc059edddfa78a2f62012e7c3bb43476c20e0bd23b25ba0eb` |
| Licence | Public domain (Unlicense) or MIT No Attribution, at the user's choice (see `LICENSE`) |
| Modified? | **No.** The file is byte-identical to upstream. The implementation is compiled from `libs/audio/src/miniaudio_impl.c`. |

API fields used by `libs/audio` were checked against this exact header (Stage 4):
- `wasapi.noAutoConvertSRC`, `noDefaultQualitySRC`, `noAutoStreamRouting`;
- `notificationCallback`;
- `capture.internalFormat`, `internalChannels`, `internalSampleRate`, `internalPeriodSizeInFrames`, `internalPeriods`;
- `ma_context_get_devices`, `ma_device_init`, `ma_device_start`, `ma_device_stop`, `ma_device_uninit`, `ma_device_get_state`.

To check integrity: `certutil -hashfile third_party\miniaudio\miniaudio.h SHA256`
