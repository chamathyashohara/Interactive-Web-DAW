import { describe, expect, it } from "vitest";
import { isLanHost, parseServerAddress } from "../src/shared/serverAddress";

describe("isLanHost: is the server on the same local network?", () => {
  it("private and loopback addresses are the same network, with or without a scheme or port", () => {
    for (const a of ["192.168.1.5", "192.168.1.5:4000", "ws://192.168.0.20:52000", "http://10.0.0.7:4000/", "172.16.4.1", "172.31.255.1", "127.0.0.1:4311", "ws://localhost:4000", "169.254.10.2"]) {
      expect(isLanHost(a), a).toBe(true);
    }
  });
  it("tunnels, domains and public addresses are another network", () => {
    for (const a of ["https://abc.trycloudflare.com", "wss://collab.example.com", "collab.example.com:443", "8.8.8.8", "172.32.0.1", "172.15.0.1", "193.168.1.1", "ws://203.0.113.9:4000", "300.168.1.1", ""]) {
      expect(isLanHost(a), a).toBe(false);
    }
  });
  it("agrees with how a typed address becomes a server link", () => {
    expect(isLanHost(parseServerAddress("192.168.1.5").ws)).toBe(true);
    expect(isLanHost(parseServerAddress("https://abc.trycloudflare.com").ws)).toBe(false);
  });
});
