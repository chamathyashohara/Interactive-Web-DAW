# ADR-012: Security scope is a LAN-only unencrypted prototype, with established libraries only for the future

- **Status:** Proposed · **Traces:** SEC-01…03, LATER-02, RO NFR7, D-13

## Decision (PP1)
- There is **no encryption and no authentication**. The pairing code only prevents *accidental* cross-connection. It does not protect against anyone on the same network.
- **Shown everywhere:** both apps, the README and `NOTICE.txt` state: "LAN prototype: audio and control are not encrypted. Use only on a trusted private network."
- Ports listen on the LAN interfaces, because the two PCs must reach each other. The Windows profile must be *Private*. **Never forward these ports to the internet.**
- **Defence in depth that costs nothing:**
  - accept media and control only from the paired peer's address;
  - check every length, range and type before use;
  - cap frame sizes;
  - name received files on the receiving side;
  - allow one performer per session;
  - limit failed pairing attempts (5, prov.) before the pairing code must be regenerated.

## Future security stage (separate design, not decided here)
- **Control:** TLS via Qt's `QSslSocket`. Authentication could be a certificate fingerprint shown on both screens and compared by the users, or PSK if the backend supports it.
- **Media:** DTLS (`QDtls`), if the chosen backend implements it, or an established AEAD library with keys from the TLS session.
- **Unknown:** the Qt pages checked do not list which features Schannel supports. **Query `QSslSocket::isFeatureSupported` before deciding.**
- **No custom cryptography under any circumstances.** SHA-256 for take checks uses Windows CNG (ADR-014).
