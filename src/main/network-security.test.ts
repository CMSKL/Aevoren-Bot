import { describe, expect, it } from "vitest";
import { assertSafeNetworkUrl, fetchPinnedBuffered, unsafeNetworkAddress } from "./network-security";

describe("network security", () => {
  it("recognizes private, loopback, link-local and reserved addresses", () => {
    for (const address of ["0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.1.2", "172.16.0.1", "192.0.2.1", "192.168.1.2", "198.18.0.1", "198.51.100.2", "203.0.113.1", "100.64.0.1", "224.0.0.1", "::", "::1", "fd00::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1"]) {
      expect(unsafeNetworkAddress(address), address).toBe(true);
    }
    expect(unsafeNetworkAddress("8.8.8.8")).toBe(false);
    expect(unsafeNetworkAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("rejects unsafe schemes, credentials and loopback targets before fetching", async () => {
    await expect(assertSafeNetworkUrl("http://example.com/")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(assertSafeNetworkUrl("https://user:secret@example.com/")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(assertSafeNetworkUrl("https://127.0.0.1/")).rejects.toMatchObject({ code: "NETWORK_TOOL_UNAVAILABLE" });
    await expect(assertSafeNetworkUrl("https://[::1]/")).rejects.toMatchObject({ code: "NETWORK_TOOL_UNAVAILABLE" });
    await expect(assertSafeNetworkUrl("http://localhost:3000/", true)).resolves.toMatchObject({ hostname: "localhost" });
  });

  it("rejects a public-looking hostname when any DNS answer is private", async () => {
    await expect(assertSafeNetworkUrl(
      "https://public.example/page",
      false,
      async () => [{ address: "93.184.216.34" }, { address: "10.0.0.2" }],
    )).rejects.toMatchObject({ code: "NETWORK_TOOL_UNAVAILABLE" });
    await expect(assertSafeNetworkUrl(
      "https://public.example/page",
      false,
      async () => [{ address: "93.184.216.34" }],
    )).resolves.toMatchObject({ hostname: "public.example" });
  });

  it("allows synthetic DNS proxy addresses only behind a hostname, never as a literal target", async () => {
    await expect(assertSafeNetworkUrl(
      "https://public.example/page",
      false,
      async () => [{ address: "198.18.0.10", family: 4 }],
    )).resolves.toMatchObject({ hostname: "public.example" });
    await expect(assertSafeNetworkUrl("https://198.18.0.10/page")).rejects.toMatchObject({ code: "NETWORK_TOOL_UNAVAILABLE" });
  });

  it("buffers bounded OAuth metadata and blocks private non-loopback endpoints", async () => {
    await expect(fetchPinnedBuffered("https://127.0.0.2/oauth", undefined, false)).rejects.toMatchObject({ code: "NETWORK_TOOL_UNAVAILABLE" });
    await expect(fetchPinnedBuffered("http://127.0.0.1:1/oauth", undefined, true)).rejects.toBeTruthy();
  });
});
