import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { DomainError, ErrorCode } from "../types.js";
import { defaultFetchImpl, fetchImageFromUrl, isBlockedAddress, type FetchLike, type PinnedAddress } from "./image-url.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/** Build a minimal fetch-like Response from a Buffer, streaming it through
 * a real ReadableStream so the byte-cap-enforcing reader path is exercised
 * exactly as it would be against the real global fetch. */
function makeResponse(
  status: number,
  bytes: Buffer,
  headers: Record<string, string> = {},
): Awaited<ReturnType<FetchLike>> {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
  return {
    status,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    body,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

function makeRedirect(status: number, location: string): Awaited<ReturnType<FetchLike>> {
  return makeResponse(status, Buffer.alloc(0), { location });
}

function chatGptPublicContentUrl(id: string): string {
  const encoded = Buffer.from(JSON.stringify({ id })).toString("base64url");
  return `https://chatgpt.com/backend-api/estuary/public_content/enc/${encoded}`;
}

/** DNS lookup stub: maps hostname -> resolved addresses, for tests that
 * don't want to depend on real DNS. */
function stubLookup(map: Record<string, Array<{ address: string; family: number }>>) {
  return async (hostname: string) => {
    const found = map[hostname];
    if (!found) throw new Error(`no stub DNS entry for ${hostname}`);
    return found;
  };
}

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local/metadata, and unspecified addresses", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("10.0.0.5")).toBe(true);
    expect(isBlockedAddress("172.16.0.1")).toBe(true);
    expect(isBlockedAddress("192.168.1.1")).toBe(true);
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("0.0.0.0")).toBe(true);
    expect(isBlockedAddress("::1")).toBe(true);
    expect(isBlockedAddress("fe80::1")).toBe(true);
    expect(isBlockedAddress("fc00::1")).toBe(true);
  });

  it("blocks CGNAT (RFC 6598, e.g. Alibaba Cloud metadata 100.100.100.200)", () => {
    expect(isBlockedAddress("100.64.0.1")).toBe(true);
    expect(isBlockedAddress("100.100.100.200")).toBe(true);
    expect(isBlockedAddress("100.127.255.254")).toBe(true);
  });

  it("blocks 6to4 anycast relay (192.88.99.0/24)", () => {
    expect(isBlockedAddress("192.88.99.1")).toBe(true);
  });

  it("blocks hex-group IPv4-mapped IPv6 addresses (::ffff:0:0/96), not just dotted form", () => {
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true); // ::ffff:127.0.0.1
    expect(isBlockedAddress("::ffff:a9fe:a9fe")).toBe(true); // ::ffff:169.254.169.254
  });

  it("blocks IPv6 transition/tunneling ranges (NAT64, 6to4, Teredo)", () => {
    expect(isBlockedAddress("64:ff9b::a9fe:a9fe")).toBe(true); // NAT64, 64:ff9b::/96
    expect(isBlockedAddress("2002::1")).toBe(true); // 6to4, 2002::/16
    expect(isBlockedAddress("2001::1")).toBe(true); // Teredo, 2001::/32
    expect(isBlockedAddress("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toBe(true); // Teredo
  });

  it("allows a normal public address", () => {
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("2606:4700::1")).toBe(false);
  });
});

describe("fetchImageFromUrl — success path (mocked fetch, offline)", () => {
  it("returns bytes + mime for a fake PNG served over https", async () => {
    const fetchImpl: FetchLike = async () => makeResponse(200, PNG_1X1, { "content-type": "image/png" });
    const lookupImpl = stubLookup({ "example.com": [{ address: "93.184.216.34", family: 4 }] });

    const result = await fetchImageFromUrl("https://example.com/cat.png", { fetchImpl, lookupImpl });

    expect(result.mime).toBe("image/png");
    expect(result.bytes.equals(PNG_1X1)).toBe(true);
  });

  it("follows a redirect that lands on an allowed public host", async () => {
    let call = 0;
    const fetchImpl: FetchLike = async () => {
      call++;
      if (call === 1) return makeRedirect(302, "https://cdn.example.com/cat.png");
      return makeResponse(200, PNG_1X1, { "content-type": "image/png" });
    };
    const lookupImpl = stubLookup({
      "example.com": [{ address: "93.184.216.34", family: 4 }],
      "cdn.example.com": [{ address: "93.184.216.35", family: 4 }],
    });

    const result = await fetchImageFromUrl("https://example.com/redirect", { fetchImpl, lookupImpl });
    expect(result.mime).toBe("image/png");
    expect(call).toBe(2);
  });

  it("resolves a ChatGPT image share page to its public image URL", async () => {
    const calls: string[] = [];
    const imageUrl = "https://chatgpt.com/backend-api/estuary/public_content/enc/abc?x=1&y=2";
    const shareHtml = Buffer.from(
      `<!doctype html><meta property="og:image" content="${imageUrl.replace(/&/g, "&amp;")}">`,
    );
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      if (url === "https://chatgpt.com/s/m_testshare") {
        return makeResponse(200, shareHtml, { "content-type": "text/html; charset=utf-8" });
      }
      return makeResponse(200, PNG_1X1, { "content-type": "image/png" });
    };
    const lookupImpl = stubLookup({ "chatgpt.com": [{ address: "93.184.216.34", family: 4 }] });

    const result = await fetchImageFromUrl("https://chatgpt.com/s/m_testshare", { fetchImpl, lookupImpl });

    expect(result.mime).toBe("image/png");
    expect(result.bytes.equals(PNG_1X1)).toBe(true);
    expect(calls).toEqual(["https://chatgpt.com/s/m_testshare", imageUrl]);
  });

  it("prefers the original file URL over ChatGPT share-page preview variants", async () => {
    const originalUrl = chatGptPublicContentUrl("m_share:file_abc123");
    const unfurlUrl = chatGptPublicContentUrl("m_share:sediment://one#file_abc123#unfurl");
    const mediumUrl = chatGptPublicContentUrl("m_share:sediment://two#file_abc123#md");
    const calls: string[] = [];
    const shareHtml = Buffer.from(
      `<!doctype html>
      <meta property="og:image" content="${unfurlUrl}">
      <script>${JSON.stringify({ mediumUrl, originalUrl })}</script>`,
    );
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      if (url === "https://chatgpt.com/s/m_prefers_original") {
        return makeResponse(200, shareHtml, { "content-type": "text/html; charset=utf-8" });
      }
      return makeResponse(200, PNG_1X1, { "content-type": "image/png" });
    };
    const lookupImpl = stubLookup({ "chatgpt.com": [{ address: "93.184.216.34", family: 4 }] });

    const result = await fetchImageFromUrl("https://chatgpt.com/s/m_prefers_original", { fetchImpl, lookupImpl });

    expect(result.mime).toBe("image/png");
    expect(calls).toEqual(["https://chatgpt.com/s/m_prefers_original", originalUrl]);
  });

  it("falls back when preferred ChatGPT share-page image candidates are unavailable", async () => {
    const originalUrl = chatGptPublicContentUrl("m_share:file_abc123");
    const mediumUrl = chatGptPublicContentUrl("m_share:sediment://two#file_abc123#md");
    const unfurlUrl = chatGptPublicContentUrl("m_share:sediment://one#file_abc123#unfurl");
    const calls: string[] = [];
    const shareHtml = Buffer.from(
      `<!doctype html>
      <meta property="og:image" content="${unfurlUrl}">
      <script>${JSON.stringify({ originalUrl, mediumUrl })}</script>`,
    );
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      if (url === "https://chatgpt.com/s/m_fallback") {
        return makeResponse(200, shareHtml, { "content-type": "text/html; charset=utf-8" });
      }
      if (url === originalUrl || url === mediumUrl) {
        return makeResponse(500, Buffer.from('{"error":"temporarily unavailable"}'), { "content-type": "application/json" });
      }
      return makeResponse(200, PNG_1X1, { "content-type": "image/png" });
    };
    const lookupImpl = stubLookup({ "chatgpt.com": [{ address: "93.184.216.34", family: 4 }] });

    const result = await fetchImageFromUrl("https://chatgpt.com/s/m_fallback", { fetchImpl, lookupImpl });

    expect(result.mime).toBe("image/png");
    expect(calls).toEqual(["https://chatgpt.com/s/m_fallback", originalUrl, mediumUrl, unfurlUrl]);
  });

  it("does not resolve arbitrary non-ChatGPT HTML pages to og:image", async () => {
    const html = Buffer.from('<meta property="og:image" content="https://cdn.example.com/cat.png">');
    const fetchImpl: FetchLike = async () => makeResponse(200, html, { "content-type": "text/html; charset=utf-8" });
    const lookupImpl = stubLookup({ "example.com": [{ address: "93.184.216.34", family: 4 }] });

    await expect(fetchImageFromUrl("https://example.com/share", { fetchImpl, lookupImpl })).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
    });
  });
});

describe("fetchImageFromUrl — SSRF hardening", () => {
  const fetchShouldNotBeCalled: FetchLike = async () => {
    throw new Error("fetch should not have been called");
  };

  it("rejects http://127.0.0.1 (literal loopback IP, no DNS needed)", async () => {
    await expect(
      fetchImageFromUrl("http://127.0.0.1/x.png", { fetchImpl: fetchShouldNotBeCalled, lookupImpl: stubLookup({}) }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });

  it("rejects http://169.254.169.254 (cloud metadata)", async () => {
    await expect(
      fetchImageFromUrl("http://169.254.169.254/latest/meta-data", {
        fetchImpl: fetchShouldNotBeCalled,
        lookupImpl: stubLookup({}),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });

  it("rejects http://10.0.0.5 (private range)", async () => {
    await expect(
      fetchImageFromUrl("http://10.0.0.5/x.png", { fetchImpl: fetchShouldNotBeCalled, lookupImpl: stubLookup({}) }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });

  it("rejects file:///etc/passwd (disallowed scheme)", async () => {
    await expect(
      fetchImageFromUrl("file:///etc/passwd", { fetchImpl: fetchShouldNotBeCalled, lookupImpl: stubLookup({}) }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });

  it("rejects a hostname that DNS-resolves to a loopback address (rebinding-style)", async () => {
    const lookupImpl = stubLookup({ "evil.example.com": [{ address: "127.0.0.1", family: 4 }] });
    await expect(
      fetchImageFromUrl("https://evil.example.com/x.png", { fetchImpl: fetchShouldNotBeCalled, lookupImpl }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });

  it("rejects a redirect that lands on 127.0.0.1", async () => {
    const fetchImpl: FetchLike = async () => makeRedirect(302, "http://127.0.0.1:8080/admin");
    const lookupImpl = stubLookup({ "example.com": [{ address: "93.184.216.34", family: 4 }] });

    await expect(
      fetchImageFromUrl("https://example.com/redirect-to-internal", { fetchImpl, lookupImpl }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });

  it("rejects a redirect chain exceeding maxRedirects", async () => {
    let call = 0;
    const fetchImpl: FetchLike = async () => {
      call++;
      return makeRedirect(302, `https://example.com/hop${call}`);
    };
    const lookupImpl = stubLookup({ "example.com": [{ address: "93.184.216.34", family: 4 }] });

    await expect(
      fetchImageFromUrl("https://example.com/start", { fetchImpl, lookupImpl, maxRedirects: 3 }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });

  it("rejects non-image bytes even with an image/png Content-Type header", async () => {
    const fetchImpl: FetchLike = async () => makeResponse(200, Buffer.from("not an image"), { "content-type": "image/png" });
    const lookupImpl = stubLookup({ "example.com": [{ address: "93.184.216.34", family: 4 }] });

    await expect(
      fetchImageFromUrl("https://example.com/fake.png", { fetchImpl, lookupImpl }),
    ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_MEDIA_TYPE });
  });

  it("rejects a body over the byte cap (streamed, aborts before buffering it all)", async () => {
    const big = Buffer.alloc(2048, 1);
    const fetchImpl: FetchLike = async () => makeResponse(200, big, { "content-type": "image/png" });
    const lookupImpl = stubLookup({ "example.com": [{ address: "93.184.216.34", family: 4 }] });

    await expect(
      fetchImageFromUrl("https://example.com/huge.png", { fetchImpl, lookupImpl, maxBytes: 1024 }),
    ).rejects.toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED });
  });

  it("rejects up front via Content-Length header before reading the body", async () => {
    const fetchImpl: FetchLike = async () =>
      makeResponse(200, PNG_1X1, { "content-type": "image/png", "content-length": String(100 * 1024 * 1024) });
    const lookupImpl = stubLookup({ "example.com": [{ address: "93.184.216.34", family: 4 }] });

    await expect(
      fetchImageFromUrl("https://example.com/huge.png", { fetchImpl, lookupImpl, maxBytes: 50 * 1024 * 1024 }),
    ).rejects.toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED });
  });

  it("wraps a DomainError instance check for host-not-resolvable", async () => {
    const lookupImpl = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(
      fetchImageFromUrl("https://does-not-resolve.invalid/x.png", { fetchImpl: fetchShouldNotBeCalled, lookupImpl }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});

describe("fetchImageFromUrl — DNS rebinding (TOCTOU) regression", () => {
  const PUBLIC_ADDRESS: PinnedAddress = { address: "93.184.216.34", family: 4 };
  const PRIVATE_ADDRESS: PinnedAddress = { address: "10.0.0.1", family: 4 };
  const METADATA_ADDRESS: PinnedAddress = { address: "169.254.169.254", family: 4 };

  /** Simulates an attacker-controlled authoritative DNS server: the
   * validation-time lookup (T0, used by assertHostAllowed) answers with a
   * public address, but a second, independent "connect-time resolver" would
   * answer with a private/metadata address if anything actually asked it
   * again. Before the fix, the real connection (fetchImpl -> global fetch)
   * re-resolved the hostname itself and would have received this rebound
   * answer; the fetchImpl stub below asserts that never happens. */
  function makeRebindingLookup() {
    let connectTimeResolverCalls = 0;
    return {
      // T0: what assertHostAllowed sees.
      validationLookup: async (hostname: string) => {
        if (hostname !== "rebind.attacker.example") throw new Error(`unexpected host ${hostname}`);
        return [PUBLIC_ADDRESS];
      },
      // T1: what a naive re-resolving connection would see if it ever
      // resolved the hostname again. Must never be invoked by fetchImpl.
      connectTimeResolve: () => {
        connectTimeResolverCalls++;
        return METADATA_ADDRESS;
      },
      getConnectTimeResolverCalls: () => connectTimeResolverCalls,
    };
  }

  it("connects using only the validated (T0) address, never re-resolving the hostname at connect time", async () => {
    const rebinding = makeRebindingLookup();
    let receivedPinnedAddresses: PinnedAddress[] | undefined;

    const fetchImpl: FetchLike = async (_url, init) => {
      receivedPinnedAddresses = init?.pinnedAddresses;
      // A vulnerable implementation would re-resolve the hostname here
      // (e.g. by handing the URL string to global fetch/undici). Simulate
      // that temptation explicitly and prove it's never exercised: the
      // fix must supply pinnedAddresses so this stub has no need to call
      // the rebinding resolver at all.
      if (!init?.pinnedAddresses || init.pinnedAddresses.length === 0) {
        rebinding.connectTimeResolve(); // would happen in the vulnerable path
      }
      return makeResponse(200, PNG_1X1, { "content-type": "image/png" });
    };

    const result = await fetchImageFromUrl("https://rebind.attacker.example/x.png", {
      fetchImpl,
      lookupImpl: rebinding.validationLookup,
    });

    expect(result.mime).toBe("image/png");
    // Connection must be pinned to exactly the T0-validated public address —
    // never to the rebound private/metadata address.
    expect(receivedPinnedAddresses).toEqual([PUBLIC_ADDRESS]);
    expect(receivedPinnedAddresses).not.toContainEqual(METADATA_ADDRESS);
    // The rebinding ("connect-time") resolver must never have been called.
    expect(rebinding.getConnectTimeResolverCalls()).toBe(0);
  });

  it("blocks outright when the validation-time (T0) lookup itself resolves to a private address", async () => {
    const lookupImpl = stubLookup({ "evil.rebind.example": [PRIVATE_ADDRESS] });
    const fetchShouldNotBeCalled: FetchLike = async () => {
      throw new Error("fetch should not have been called");
    };

    await expect(
      fetchImageFromUrl("https://evil.rebind.example/x.png", { fetchImpl: fetchShouldNotBeCalled, lookupImpl }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });

  it("re-pins to the redirect hop's own validated address, not the original hop's address", async () => {
    const lookupImpl = stubLookup({
      "example.com": [PUBLIC_ADDRESS],
      "cdn.example.com": [{ address: "93.184.216.99", family: 4 }],
    });
    const pinnedPerCall: Array<PinnedAddress[] | undefined> = [];
    let call = 0;
    const fetchImpl: FetchLike = async (_url, init) => {
      call++;
      pinnedPerCall.push(init?.pinnedAddresses);
      if (call === 1) return makeRedirect(302, "https://cdn.example.com/cat.png");
      return makeResponse(200, PNG_1X1, { "content-type": "image/png" });
    };

    const result = await fetchImageFromUrl("https://example.com/redirect", { fetchImpl, lookupImpl });

    expect(result.mime).toBe("image/png");
    expect(pinnedPerCall).toEqual([[PUBLIC_ADDRESS], [{ address: "93.184.216.99", family: 4 }]]);
  });

  it("rejects a redirect hop whose validation-time lookup resolves to a private address (redirect-based rebinding)", async () => {
    const lookupImpl = stubLookup({
      "example.com": [PUBLIC_ADDRESS],
      "internal.evil.example": [PRIVATE_ADDRESS],
    });
    const fetchImpl: FetchLike = async () => makeRedirect(302, "http://internal.evil.example/x");

    await expect(
      fetchImageFromUrl("https://example.com/redirect-rebind", { fetchImpl, lookupImpl }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });

  it("pins both address families when the validated host resolves to IPv6 and IPv4 (happy-eyeballs)", async () => {
    const ipv6: PinnedAddress = { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 };
    const lookupImpl = stubLookup({ "dual-stack.example": [ipv6, PUBLIC_ADDRESS] });
    let receivedPinnedAddresses: PinnedAddress[] | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      receivedPinnedAddresses = init?.pinnedAddresses;
      return makeResponse(200, PNG_1X1, { "content-type": "image/png" });
    };

    const result = await fetchImageFromUrl("https://dual-stack.example/x.png", { fetchImpl, lookupImpl });

    expect(result.mime).toBe("image/png");
    expect(receivedPinnedAddresses).toEqual([ipv6, PUBLIC_ADDRESS]);
  });

  it("pin invariant: addresses passed to fetchImpl are always a subset of what the validation lookup returned", async () => {
    const validatedAddresses = [
      { address: "203.0.113.9", family: 4 },
      { address: "203.0.113.10", family: 4 },
    ];
    // Note: these are TEST-NET-3 addresses, blocked by this module's own
    // range checks — swap in genuinely public addresses if this invariant
    // check is ever extended to assert a successful fetch too. Here we only
    // care that whatever set assertHostAllowed validates is exactly what
    // gets pinned, using a host that DOES resolve to allowed addresses.
    const allowedAddresses = [
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ];
    void validatedAddresses;
    const lookupImpl = stubLookup({ "multi-a.example": allowedAddresses });
    let receivedPinnedAddresses: PinnedAddress[] | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      receivedPinnedAddresses = init?.pinnedAddresses;
      return makeResponse(200, PNG_1X1, { "content-type": "image/png" });
    };

    await fetchImageFromUrl("https://multi-a.example/x.png", { fetchImpl, lookupImpl });

    expect(receivedPinnedAddresses).toBeDefined();
    for (const pinned of receivedPinnedAddresses ?? []) {
      expect(allowedAddresses).toContainEqual(pinned);
    }
  });

  it("defaultFetchImpl connects to the pinned IP while preserving the original Host header (CDN/SNI compatibility)", async () => {
    let receivedHost: string | undefined;
    const server = createServer((req, res) => {
      receivedHost = req.headers.host;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected AddressInfo");
    const port = address.port;

    try {
      // The URL's hostname is a fake public-looking name; it never gets
      // resolved for real. The pinned address is the loopback address the
      // local test server is actually listening on. If the fix regressed
      // and defaultFetchImpl re-resolved the hostname instead of honoring
      // the pin, this request would fail (fake host doesn't resolve) rather
      // than reaching the local server.
      const res = await defaultFetchImpl(`http://cdn.example.com:${port}/`, {
        pinnedAddresses: [{ address: "127.0.0.1", family: 4 }],
      });
      expect(res.status).toBe(200);
      // Host header must reflect the original hostname, not the pinned IP —
      // this is what keeps virtual-hosted CDNs / SNI routing / cert
      // validation working.
      expect(receivedHost).toBe(`cdn.example.com:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
