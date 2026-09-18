import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { AevorenBotError } from "./errors";

export type NetworkAddress = { address: string; family?: number };
export type NetworkHostResolver = (hostname: string) => Promise<NetworkAddress[]>;
export type SafeNetworkTarget = { url: URL; addresses: NetworkAddress[] };

const resolveHost: NetworkHostResolver = async (hostname) => lookup(hostname, { all: true, verbatim: true });

export function unsafeNetworkAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/u, "");
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    const [a, b, c] = parts;
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 ||
      a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2)) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
      a === 203 && b === 0 && c === 113 || a === 100 && b! >= 64 && b! <= 127 || a! >= 224;
  }
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") ||
    normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") ||
    normalized.startsWith("fec") || normalized.startsWith("fed") || normalized.startsWith("fee") || normalized.startsWith("fef") ||
    normalized.startsWith("ff") || normalized.startsWith("2001:db8:") || normalized.startsWith("100:");
}

function syntheticProxyAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/u, "");
  if (isIP(normalized) !== 4) return false;
  const [a, b] = normalized.split(".").map(Number);
  return a === 198 && (b === 18 || b === 19);
}

export async function resolveSafeNetworkUrl(
  value: string,
  allowLoopback = false,
  resolver: NetworkHostResolver = resolveHost,
): Promise<SafeNetworkTarget> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AevorenBotError("INVALID_REQUEST");
  }
  if (url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:")) throw new AevorenBotError("INVALID_REQUEST");
  if (url.username || url.password) throw new AevorenBotError("INVALID_REQUEST");
  const hostname = url.hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (loopback) {
    if (allowLoopback) return {
      url,
      addresses: [{ address: hostname === "localhost" ? "127.0.0.1" : hostname, family: hostname === "::1" ? 6 : 4 }],
    };
    throw new AevorenBotError("NETWORK_TOOL_UNAVAILABLE");
  }
  if (isIP(hostname) && unsafeNetworkAddress(hostname)) throw new AevorenBotError("NETWORK_TOOL_UNAVAILABLE");
  try {
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolver(hostname);
    const hostnameIsLiteral = isIP(hostname) !== 0;
    if (addresses.length === 0 || addresses.some((entry) => (
      unsafeNetworkAddress(entry.address) && (hostnameIsLiteral || !syntheticProxyAddress(entry.address))
    ))) {
      throw new AevorenBotError("NETWORK_TOOL_UNAVAILABLE");
    }
    return { url, addresses };
  } catch (error) {
    if (error instanceof AevorenBotError) throw error;
    throw new AevorenBotError("NETWORK_TOOL_UNAVAILABLE");
  }
}

export function createPinnedLookup(target: SafeNetworkTarget): LookupFunction {
  return (_hostname, options, callback) => {
    const normalized = target.addresses.map((entry) => ({
      address: entry.address,
      family: entry.family === 4 || entry.family === 6 ? entry.family : isIP(entry.address),
    }));
    if (options.all) {
      callback(null, normalized);
      return;
    }
    const preferred = options.family === 4 || options.family === 6
      ? normalized.find((entry) => entry.family === options.family) ?? normalized[0]
      : normalized[0];
    if (!preferred) {
      callback(Object.assign(new Error("No validated network address"), { code: "ENOTFOUND" }), "", 0);
      return;
    }
    callback(null, preferred.address, preferred.family);
  };
}

export async function assertSafeNetworkUrl(
  value: string,
  allowLoopback = false,
  resolver: NetworkHostResolver = resolveHost,
): Promise<URL> {
  return (await resolveSafeNetworkUrl(value, allowLoopback, resolver)).url;
}

export async function fetchPinnedBuffered(
  input: string | URL,
  init: RequestInit | undefined,
  allowLoopback: boolean,
  maximumBytes = 1_048_576,
): Promise<Response> {
  const target = await resolveSafeNetworkUrl(input.toString(), allowLoopback);
  const dispatcher = new Agent({ connect: { lookup: createPinnedLookup(target) } });
  try {
    const response = await undiciFetch(target.url, {
      ...(init ?? {}),
      redirect: "error",
      dispatcher,
    } as Parameters<typeof undiciFetch>[1]);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maximumBytes) throw new AevorenBotError("NETWORK_TOOL_RESPONSE_INVALID");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw new AevorenBotError("NETWORK_TOOL_RESPONSE_INVALID");
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers as unknown as HeadersInit),
    });
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}
