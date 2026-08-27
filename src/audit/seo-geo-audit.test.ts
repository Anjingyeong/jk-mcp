import { describe, expect, it } from "vitest";
import { ErrorCode } from "../types.js";
import { analyzeSeoGeoHtml, auditSeoGeoUrl, type SeoGeoAuditResources } from "./seo-geo-audit.js";

function resources(overrides: Partial<SeoGeoAuditResources> = {}): SeoGeoAuditResources {
  return {
    robots: {
      url: "https://example.com/robots.txt",
      status: 200,
      exists: true,
      globalDisallow: false,
      sitemapUrls: ["https://example.com/sitemap.xml"],
      aiCrawlerBlocks: [],
      ...overrides.robots,
    },
    sitemap: {
      url: "https://example.com/sitemap.xml",
      status: 200,
      exists: true,
      ...overrides.sitemap,
    },
    llmsTxt: {
      url: "https://example.com/llms.txt",
      status: 404,
      exists: false,
      ...overrides.llmsTxt,
    },
  };
}

const longBody = Array.from(
  { length: 560 },
  (_, index) => `evidence${index} ${index % 5 === 0 ? `${index}%` : "detail"}`,
).join(" ");

const strongHtml = `<!doctype html>
<html lang="ko">
<head>
  <title>ChatGPT 로컬 개발 하네스 JK 구조와 실제 운영 개발기</title>
  <meta name="description" content="ChatGPT와 로컬 개발환경을 연결한 JK의 구조, 작업 세션, 검증 루프, Windows와 OCI 운영 경험을 실제 구현 근거와 함께 정리한 개발기입니다.">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta property="og:title" content="JK 개발기">
  <meta property="og:description" content="JK 구조와 운영 경험">
  <meta property="og:image" content="https://example.com/cover.png">
  <link rel="canonical" href="https://example.com/jk-devlog">
  <script type="application/ld+json">{
    "@context":"https://schema.org",
    "@graph":[
      {"@type":"TechArticle","headline":"JK 개발기","author":{"@type":"Person","name":"Author"},"datePublished":"2026-08-21","dateModified":"2026-08-21"},
      {"@type":"BreadcrumbList","itemListElement":[]}
    ]
  }</script>
</head>
<body>
  <h1>ChatGPT를 내 로컬 개발환경에 붙여봤다</h1>
  <p>JK는 ChatGPT의 추론과 실제 로컬 파일, 테스트, Git 실행 사이를 연결하고 결과를 검증하기 위해 만든 로컬 개발 하네스다. 2026-08-21 기준으로 Windows와 OCI를 함께 운영하고 있다.</p>
  <h2>왜 별도 하네스가 필요했나?</h2><p>${longBody}</p>
  <h2>어떻게 안전하게 실행하나?</h2><ul><li>project boundary</li><li>hash validation</li></ul>
  <h2>검증은 어떻게 하나?</h2><pre><code>npm test</code></pre>
  <a href="/one">one</a><a href="/two">two</a><a href="/three">three</a>
  <a href="https://developers.google.com/search/docs">Google Search docs</a>
  <a href="https://schema.org/TechArticle">Schema.org</a>
</body></html>`;

describe("SEO/GEO readiness analysis", () => {
  it("scores a well-structured evidence-rich page highly", () => {
    const audit = analyzeSeoGeoHtml({
      requestedUrl: "https://example.com/jk-devlog",
      finalUrl: "https://example.com/jk-devlog",
      httpStatus: 200,
      html: strongHtml,
      resources: resources(),
    });

    expect(audit.score.total).toBeGreaterThanOrEqual(90);
    expect(audit.score.seo).toBe(35);
    expect(audit.score.crawlability).toBe(20);
    expect(audit.signals.schemaTypes).toContain("TechArticle");
    expect(audit.signals.hasAuthor).toBe(true);
    expect(audit.priorities.some((issue) => issue.check === "llms-txt")).toBe(false);
  });

  it("returns prioritized evidence-backed fixes for a thin page", () => {
    const audit = analyzeSeoGeoHtml({
      requestedUrl: "https://example.com/thin",
      finalUrl: "https://example.com/thin",
      httpStatus: 200,
      html: "<html><head><title>x</title></head><body><h1>Thin</h1><p>short</p></body></html>",
      resources: resources({
        robots: { url: "https://example.com/robots.txt", status: 404, exists: false },
        sitemap: { url: "https://example.com/sitemap.xml", status: 404, exists: false },
      }),
    });

    expect(audit.score.total).toBeLessThan(50);
    expect(audit.priorities.length).toBeGreaterThan(0);
    expect(audit.issues.some((issue) => issue.check === "meta-description")).toBe(true);
    expect(audit.issues.some((issue) => issue.check === "content-depth")).toBe(true);
  });

  it("does not award numeric points for llms.txt presence", () => {
    const absent = analyzeSeoGeoHtml({
      requestedUrl: "https://example.com/jk-devlog",
      finalUrl: "https://example.com/jk-devlog",
      httpStatus: 200,
      html: strongHtml,
      resources: resources({ llmsTxt: { url: "https://example.com/llms.txt", status: 404, exists: false } }),
    });
    const present = analyzeSeoGeoHtml({
      requestedUrl: "https://example.com/jk-devlog",
      finalUrl: "https://example.com/jk-devlog",
      httpStatus: 200,
      html: strongHtml,
      resources: resources({ llmsTxt: { url: "https://example.com/llms.txt", status: 200, exists: true } }),
    });

    expect(present.score.total).toBe(absent.score.total);
    expect(absent.issues.some((issue) => issue.check === "llms-txt" && issue.severity === "info")).toBe(true);
  });
});

describe("SEO/GEO URL fetch safety", () => {
  it("blocks private/loopback DNS targets before fetch", async () => {
    let fetchCalled = false;
    await expect(
      auditSeoGeoUrl("https://example.com/article", {
        lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
        fetchImpl: async () => {
          fetchCalled = true;
          throw new Error("fetch should not be called");
        },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
    expect(fetchCalled).toBe(false);
  });
});
