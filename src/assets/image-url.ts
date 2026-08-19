import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { DomainError, ErrorCode } from "../types.js";
import { detect, type SavedImage } from "./images.js";

/**
 * Server-side "fetch an image URL and save it" intake path
 * (save_image_from_url, src/server/tools.ts) — the device-agnostic
 * counterpart to the local-only intake paths in image-intake.ts. Because
 * this fetches a URL that ultimately comes from model/user input (ChatGPT
 * passes whatever URL it was given as a tool arg), the URL is untrusted
 * input and this module is the SSRF defense boundary: every hostname is
 * DNS-resolved and IP-range-checked before *and after* following each
 * redirect, so an attacker cannot use this tool to reach loopback, private,
 * link-local, or cloud-metadata addresses (e.g. 169.254.169.254) — whether
 * directly or via an HTTP redirect that only resolves to an internal
 * address after the initial request.
 */

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const MAX_SHARE_PAGE_BYTES_TO_PARSE = 2 * 1024 * 1024;
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export interface FetchImageResult {
  bytes: Buffer;
  mime: SavedImage["mime"];
}

/** An address validated (range-checked) by `assertHostAllowed`/`assertUrlAllowed`
 * at time-of-check. Passed through to `fetchImpl` as `pinnedAddresses` so the
 * connection at time-of-use is forced onto one of these exact addresses
 * instead of re-resolving the hostname (which would reopen the DNS-rebinding
 * TOCTOU window: a validated public IP could otherwise be swapped for a
 * private/metadata one by the time the connection is actually made). */
export interface PinnedAddress {
  address: string;
  family: number;
}

/** Injectable subset of the global `fetch` signature this module needs,
 * so tests can supply a mock implementation without a network. `pinnedAddresses`
 * carries the exact addresses validated for this hostname/hop — a real
 * `fetchImpl` MUST connect only to one of these (see `defaultFetchImpl`),
 * never re-resolve the hostname itself. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; redirect?: "manual"; pinnedAddresses?: PinnedAddress[] },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface FetchImageOptions {
  /** Injectable fetch implementation; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable DNS resolver (all=true style); defaults to node:dns/promises lookup. */
  lookupImpl?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

// ---------------------------------------------------------------------------
// IP-range checks (SSRF core)
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  return ((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range ?? "0.0.0.0") & mask);
}

const BLOCKED_IPV4_CIDRS = [
  "127.0.0.0/8", // loopback
  "10.0.0.0/8", // private
  "172.16.0.0/12", // private
  "192.168.0.0/16", // private
  "169.254.0.0/16", // link-local / cloud metadata (169.254.169.254)
  "0.0.0.0/8", // "this network" / unspecified-ish
  "100.64.0.0/10", // RFC 6598 CGNAT/shared address space (e.g. Alibaba Cloud metadata 100.100.100.200)
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // TEST-NET-1
  "192.88.99.0/24", // 6to4 anycast relay (RFC 3068)
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24", // TEST-NET-3
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved
];

/** Whether an IPv6 address falls in a blocked range: loopback (::1),
 * unspecified (::), link-local (fe80::/10), unique-local/ULA (fc00::/7), an
 * IPv4-mapped address (::ffff:a.b.c.d or its hex-group equivalent, e.g.
 * ::ffff:7f00:1) whose embedded IPv4 is blocked, or an IPv6
 * transition/tunneling range that can carry traffic to/through an internal
 * IPv4 address: NAT64 (64:ff9b::/96), 6to4 (2002::/16), or Teredo
 * (2001::/32). */
function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4OrUnspecified(mapped[1] ?? "");

  // ::ffff:0:0/96 (hex-group form of the IPv4-mapped range above): the same
  // embedded IPv4 written as two hex groups instead of a dotted quad, e.g.
  // ::ffff:7f00:1 === ::ffff:127.0.0.1 and ::ffff:a9fe:a9fe ===
  // ::ffff:169.254.169.254. Defense in depth — decode the hex groups back
  // to a dotted IPv4 and check it exactly like the dotted form.
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1] ?? "0", 16);
    const lo = Number.parseInt(mappedHex[2] ?? "0", 16);
    const embeddedIpv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIpv4OrUnspecified(embeddedIpv4);
  }

  // fe80::/10 link-local: first 10 bits are 1111111010.
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  // fc00::/7 unique local: first 7 bits are 1111110.
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
  // 64:ff9b::/96 NAT64 well-known prefix: groups 1-2 ("64", "ff9b") are
  // non-zero so they're never elided by "::" compression, making a literal
  // prefix match safe regardless of how the trailing embedded IPv4 groups
  // are written.
  if (/^64:ff9b:/.test(normalized)) return true;
  // 2002::/16 6to4: group 1 ("2002") is non-zero and thus always literal.
  if (/^2002:/.test(normalized)) return true;
  // 2001::/32 Teredo: group 1 ("2001") is always literal; group 2 must be
  // zero for the address to be in this /32, whether written out ("2001:0:"
  // / "2001:0000:") or elided via "::" ("2001::").
  if (/^2001:0*(:|$)/.test(normalized)) return true;

  return false;
}

function isBlockedIpv4OrUnspecified(ip: string): boolean {
  if (ip === "0.0.0.0") return true;
  return BLOCKED_IPV4_CIDRS.some((cidr) => ipv4InCidr(ip, cidr));
}

/** True if `ip` is loopback/private/link-local/metadata/unspecified and
 * therefore must never be reached by a server-side fetch of an
 * externally-supplied URL. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4OrUnspecified(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // not a valid IP at all — fail closed
}

// ---------------------------------------------------------------------------
// Host validation
// ---------------------------------------------------------------------------

type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Resolve `hostname` and reject if it's a literal blocked IP or resolves to
 * any blocked address (DNS rebinding / multi-A-record defense: ALL resolved
 * addresses are checked, not just the first).
 *
 * Returns the exact validated addresses so the caller can pin the actual
 * connection to them — resolving again at connect time (as a bare
 * `fetch(hostname)` would) reopens the DNS-rebinding TOCTOU window this
 * function exists to close.
 *
 * @throws {DomainError} PERMISSION_DENIED if the host is/resolves to a
 *   blocked address, or resolution fails outright.
 */
async function assertHostAllowed(hostname: string, lookupImpl: LookupFn): Promise<PinnedAddress[]> {
  // Literal IP host (e.g. http://169.254.169.254/) — check directly, no DNS.
  if (isIP(hostname)) {
    const family = isIP(hostname);
    if (isBlockedAddress(hostname)) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, `URL host resolves to a blocked address: ${hostname}`, {
        hostname,
      });
    }
    return [{ address: hostname, family }];
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupImpl(hostname);
  } catch (err) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Could not resolve host: ${hostname}`, {
      hostname,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  if (addresses.length === 0) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Host resolved to no addresses: ${hostname}`, { hostname });
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new DomainError(
        ErrorCode.PERMISSION_DENIED,
        `URL host "${hostname}" resolves to a blocked address (${address})`,
        { hostname, address },
      );
    }
  }
  return addresses;
}

/**
 * Validate a candidate URL's scheme and (via DNS) its resolved address(es)
 * before it is ever used to open a connection.
 *
 * Returns the parsed URL together with the exact validated addresses, so the
 * connection can be pinned to them (see `PinnedAddress`).
 *
 * @throws {DomainError} PERMISSION_DENIED if the scheme is not http/https or
 *   the host is/resolves to a blocked address; INVALID_IMAGE_DATA if the
 *   string isn't a parseable URL.
 */
async function assertUrlAllowed(rawUrl: string, lookupImpl: LookupFn): Promise<{ url: URL; addresses: PinnedAddress[] }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new DomainError(ErrorCode.INVALID_IMAGE_DATA, `Not a valid URL: ${rawUrl}`, { url: rawUrl });
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `URL scheme not allowed: ${parsed.protocol}`, {
      url: rawUrl,
      scheme: parsed.protocol,
    });
  }
  const addresses = await assertHostAllowed(parsed.hostname, lookupImpl);
  return { url: parsed, addresses };
}

// ---------------------------------------------------------------------------
// Pinned connection (DNS-rebinding defense)
// ---------------------------------------------------------------------------
//
// `assertUrlAllowed`/`assertHostAllowed` above validate a hostname's resolved
// addresses at time-of-check (T0). If the actual connection is later made by
// handing the *hostname* to something that does its own DNS resolution (e.g.
// global `fetch`), that resolution happens at time-of-use (T1) and can return
// a different, attacker-controlled address (DNS rebinding: authoritative DNS
// under attacker control, short/zero TTL). The fix is to never let the
// connection re-resolve the hostname: `defaultFetchImpl` below uses node:http
// /node:https with a `lookup` override that can only ever return the exact
// addresses `assertUrlAllowed` already validated, so T1 is constrained to a
// subset of T0. The URL (and therefore the Host header / TLS SNI) is never
// rewritten to a bare IP, so virtual-hosted CDNs and certificate validation
// keep working unchanged.

/** Build a `net.LookupFunction` that can only ever resolve to `addresses` —
 * the exact set validated by `assertHostAllowed` — regardless of what real
 * DNS would return for the hostname at connect time. This is what pins the
 * connection to the validated address(es) and closes the TOCTOU window. */
function pinnedLookup(addresses: PinnedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const first = addresses[0];
    if (!first) {
      callback(new Error("no pinned addresses available"), "");
      return;
    }
    if (typeof options === "object" && options !== null && options.all) {
      callback(
        null,
        addresses.map((a) => ({ address: a.address, family: a.family })),
      );
      return;
    }
    callback(null, first.address, first.family);
  };
}

/** Default `FetchLike` implementation. Deliberately built on node:http/https
 * (rather than global `fetch`/undici) so the `lookup` option can pin the TCP
 * connection to the caller-validated `pinnedAddresses` — global `fetch` has
 * no supported way to prevent it from re-resolving the hostname itself. */
// Exported (in addition to being the internal default) so tests can drive
// it directly against a local server and confirm the pinned `lookup` option
// actually constrains the connection while leaving the Host header/TLS SNI
// untouched — see image-url.test.ts's "Host/SNI preserved" test.
export const defaultFetchImpl: FetchLike = (url, init) => {
  const pinnedAddresses = init?.pinnedAddresses;
  if (!pinnedAddresses || pinnedAddresses.length === 0) {
    // Internal invariant: every call site in this module validates the URL
    // via assertUrlAllowed (which yields addresses) before fetching, so this
    // only fires on a programming error, never on attacker input.
    return Promise.reject(new Error("defaultFetchImpl requires pinnedAddresses"));
  }
  const parsed = new URL(url);
  const requestFn = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = requestFn(
      parsed,
      {
        method: "GET",
        lookup: pinnedLookup(pinnedAddresses),
        signal: init?.signal,
      },
      (res) => {
        const headerMap = new Map<string, string>();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          headerMap.set(key.toLowerCase(), Array.isArray(value) ? value.join(", ") : value);
        }
        const body = Readable.toWeb(res) as ReadableStream<Uint8Array>;
        resolve({
          status: res.statusCode ?? 0,
          headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
          body,
          arrayBuffer: async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of res) chunks.push(chunk as Buffer);
            const buf = Buffer.concat(chunks);
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
};

// ---------------------------------------------------------------------------
// Fetch + validate
// ---------------------------------------------------------------------------

async function readBodyWithLimit(
  res: { body: ReadableStream<Uint8Array> | null; arrayBuffer(): Promise<ArrayBuffer> },
  maxBytes: number,
): Promise<Buffer> {
  if (!res.body || typeof (res.body as ReadableStream<Uint8Array>).getReader !== "function") {
    // Fallback for fetch-like implementations (or mocks) without a usable
    // stream — read whole body then enforce the limit after the fact. Real
    // global fetch always provides a streamable body, so this path is only
    // exercised by simplified test doubles.
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new DomainError(ErrorCode.QUOTA_EXCEEDED, `Image exceeds ${Math.floor(maxBytes / (1024 * 1024))}MB limit`, {
        bytes: buf.length,
      });
    }
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new DomainError(ErrorCode.QUOTA_EXCEEDED, `Image exceeds ${Math.floor(maxBytes / (1024 * 1024))}MB limit`, {
          bytes: total,
        });
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function metaAttribute(tag: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  const match = tag.match(pattern);
  return match?.[2] ? decodeHtmlAttribute(match[2]) : undefined;
}

function isChatGptImageSharePage(url: URL): boolean {
  return url.protocol === "https:" && url.hostname === "chatgpt.com" && /^\/s\/m_[A-Za-z0-9_-]+$/.test(url.pathname);
}

function decodeBase64UrlJson(segment: string): unknown {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function chatGptPublicContentId(url: string): string | undefined {
  const match = url.match(/\/backend-api\/estuary\/public_content\/enc\/([^/?#]+)/);
  if (!match?.[1]) return undefined;
  try {
    const decoded = decodeBase64UrlJson(match[1]);
    if (typeof decoded === "object" && decoded !== null && "id" in decoded) {
      const id = (decoded as { id?: unknown }).id;
      return typeof id === "string" ? id : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function scoreChatGptShareImageCandidate(url: string): number {
  const id = chatGptPublicContentId(url);
  if (!id) return 0;
  if (/#thumbnail\b/.test(id)) return -20;
  if (/#unfurl\b/.test(id)) return -10;
  if (/#md\b/.test(id)) return 10;
  if (/:file_[A-Za-z0-9]+$/.test(id)) return 100;
  if (id.includes(":file_")) return 80;
  return 0;
}

function uniqueUrls(urls: string[]): string[] {
  return [...new Set(urls)];
}

function resolveChatGptShareImageUrls(currentUrl: URL, contentType: string | null, bytes: Buffer): string[] {
  if (!isChatGptImageSharePage(currentUrl)) return [];
  if (bytes.length > MAX_SHARE_PAGE_BYTES_TO_PARSE) return [];
  if (contentType && !contentType.toLowerCase().includes("text/html")) return [];

  const html = bytes.toString("utf8");
  const publicContentUrls = uniqueUrls(
    [...html.matchAll(/https:\/\/chatgpt\.com\/backend-api\/estuary\/public_content\/enc\/[A-Za-z0-9_-]+/g)].map((match) =>
      decodeHtmlAttribute(match[0]),
    ),
  );
  const publicCandidates = publicContentUrls
    .map((url) => ({ url, score: scoreChatGptShareImageCandidate(url) }))
    .filter((candidate) => candidate.score !== 0)
    .sort((a, b) => b.score - a.score)
    .map((candidate) => new URL(candidate.url, currentUrl).toString());

  const metaCandidates: string[] = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const property = (metaAttribute(tag, "property") ?? metaAttribute(tag, "name"))?.toLowerCase();
    if (property !== "og:image" && property !== "og:image:secure_url" && property !== "twitter:image") continue;
    const content = metaAttribute(tag, "content");
    if (content) metaCandidates.push(new URL(content, currentUrl).toString());
  }
  return uniqueUrls([...publicCandidates, ...metaCandidates]);
}

/**
 * Fetch an image from `url` with full SSRF hardening and return its raw
 * bytes plus detected MIME type. This is the sole network-touching entry
 * point used by save_image_from_url.
 *
 * Hardening applied (all mandatory, not configurable by the caller):
 *  - Only http/https schemes are followed.
 *  - Every hostname (initial URL and each redirect hop) is DNS-resolved and
 *    every resolved address is checked against loopback/private/link-local/
 *    metadata/unspecified ranges before any connection is made.
 *  - At most `maxRedirects` (default 3) redirects are followed; redirects
 *    are fetched manually (`redirect: "manual"`) so each Location header is
 *    re-validated exactly like the original URL before being followed.
 *  - A `timeoutMs` (default 15s) aborts a hung/slow origin.
 *  - The response body is capped at `maxBytes` (default 50MB), aborting the
 *    stream as soon as the limit is exceeded rather than buffering it all.
 *  - The downloaded bytes are validated against known image magic bytes
 *    (images.detect) regardless of any Content-Type header the origin sent.
 *
 * @throws {DomainError} PERMISSION_DENIED for disallowed scheme/host/redirect
 *   target; QUOTA_EXCEEDED if the body exceeds maxBytes; TIMEOUT if the
 *   fetch does not complete in time; UNSUPPORTED_MEDIA_TYPE if the
 *   downloaded bytes are not a recognized image format.
 */
export async function fetchImageFromUrl(url: string, opts: FetchImageOptions = {}): Promise<FetchImageResult> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? defaultFetchImpl;
  const lookupImpl: LookupFn = opts.lookupImpl ?? defaultLookup;
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;

  let { url: currentUrl, addresses: pinnedAddresses } = await assertUrlAllowed(url, lookupImpl);
  let shareCandidateUrls: string[] = [];
  const tryNextShareCandidate = async (): Promise<boolean> => {
    const nextUrl = shareCandidateUrls.shift();
    if (!nextUrl) return false;
    const validated = await assertUrlAllowed(nextUrl, lookupImpl);
    currentUrl = validated.url;
    pinnedAddresses = validated.addresses;
    return true;
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let hop = 0; ; hop++) {
      let res;
      try {
        res = await fetchImpl(currentUrl.toString(), {
          signal: controller.signal,
          redirect: "manual",
          pinnedAddresses,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new DomainError(ErrorCode.TIMEOUT, `Fetching image timed out after ${timeoutMs}ms`, { url: currentUrl.toString() });
        }
        if (await tryNextShareCandidate()) continue;
        throw new DomainError(ErrorCode.INVALID_IMAGE_DATA, `Failed to fetch image URL: ${err instanceof Error ? err.message : String(err)}`, {
          url: currentUrl.toString(),
        });
      }

      const isRedirect = res.status >= 300 && res.status < 400;
      if (isRedirect) {
        if (hop >= maxRedirects) {
          throw new DomainError(ErrorCode.PERMISSION_DENIED, `Too many redirects (max ${maxRedirects})`, {
            url: currentUrl.toString(),
          });
        }
        const location = res.headers.get("location");
        if (!location) {
          throw new DomainError(ErrorCode.INVALID_IMAGE_DATA, "Redirect response missing Location header", {
            url: currentUrl.toString(),
            status: res.status,
          });
        }
        const nextUrl = new URL(location, currentUrl);
        // Re-validate scheme + resolved IP of the redirect target exactly
        // like the original URL — this is what blocks "redirect to
        // internal" SSRF bypasses. The returned addresses re-pin the next
        // hop's connection too.
        const validatedRedirect = await assertUrlAllowed(nextUrl.toString(), lookupImpl);
        currentUrl = validatedRedirect.url;
        pinnedAddresses = validatedRedirect.addresses;
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        if (await tryNextShareCandidate()) continue;
        throw new DomainError(ErrorCode.INVALID_IMAGE_DATA, `Image URL returned HTTP ${res.status}`, {
          url: currentUrl.toString(),
          status: res.status,
        });
      }

      const contentLengthHeader = res.headers.get("content-length");
      if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          throw new DomainError(ErrorCode.QUOTA_EXCEEDED, `Image exceeds ${Math.floor(maxBytes / (1024 * 1024))}MB limit`, {
            bytes: contentLength,
          });
        }
      }

      const bytes = await readBodyWithLimit(res, maxBytes);
      if (bytes.length === 0) {
        if (await tryNextShareCandidate()) continue;
        throw new DomainError(ErrorCode.INVALID_IMAGE_DATA, "Image URL returned an empty body", {
          url: currentUrl.toString(),
        });
      }
      // Validate magic bytes regardless of Content-Type — an untrusted
      // origin can lie about Content-Type, so this is the real gate.
      let detected: ReturnType<typeof detect>;
      try {
        detected = detect(bytes);
      } catch (err) {
        const resolvedImageUrls = resolveChatGptShareImageUrls(currentUrl, res.headers.get("content-type"), bytes);
        if (resolvedImageUrls.length > 0) {
          const firstResolvedUrl = resolvedImageUrls[0];
          if (!firstResolvedUrl) continue;
          shareCandidateUrls = resolvedImageUrls.slice(1);
          const validatedCandidate = await assertUrlAllowed(firstResolvedUrl, lookupImpl);
          currentUrl = validatedCandidate.url;
          pinnedAddresses = validatedCandidate.addresses;
          continue;
        }
        if (await tryNextShareCandidate()) continue;
        throw err;
      }
      return { bytes, mime: detected.mime };
    }
  } finally {
    clearTimeout(timer);
  }
}
