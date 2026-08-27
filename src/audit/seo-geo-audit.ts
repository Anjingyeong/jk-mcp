import { DomainError, ErrorCode } from "../types.js";
import {
  assertUrlAllowed,
  defaultFetchImpl,
  defaultLookup,
  type FetchLike,
  type LookupFn,
} from "../assets/image-url.js";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;
const AUDIT_USER_AGENT = "Mozilla/5.0 (compatible; JK-SEO-GEO-Audit/0.1)";

export type SeoGeoArea = "seo" | "crawlability" | "structuredData" | "geoCitability";
export type SeoGeoSeverity = "high" | "medium" | "low" | "info";

export interface SeoGeoIssue {
  severity: SeoGeoSeverity;
  area: SeoGeoArea;
  check: string;
  evidence: string;
  recommendation: string;
}

export interface SeoGeoResourceProbe {
  url: string;
  status: number | null;
  exists: boolean;
  note?: string;
}

export interface SeoGeoAuditResources {
  robots: SeoGeoResourceProbe & {
    globalDisallow?: boolean;
    sitemapUrls?: string[];
    aiCrawlerBlocks?: string[];
  };
  sitemap: SeoGeoResourceProbe;
  llmsTxt: SeoGeoResourceProbe;
}

export interface SeoGeoAuditResult {
  url: string;
  finalUrl: string;
  fetchedAt: string;
  httpStatus: number;
  score: {
    total: number;
    seo: number;
    crawlability: number;
    structuredData: number;
    geoCitability: number;
    grade: "A" | "B" | "C" | "D" | "F";
  };
  signals: {
    title: string | null;
    titleLength: number;
    metaDescription: string | null;
    metaDescriptionLength: number;
    canonical: string | null;
    lang: string | null;
    h1Count: number;
    h2Count: number;
    questionHeadingCount: number;
    wordCount: number;
    internalLinkCount: number;
    externalLinkCount: number;
    jsonLdCount: number;
    schemaTypes: string[];
    hasAuthor: boolean;
    hasDate: boolean;
    hasOpenGraph: boolean;
    hasViewport: boolean;
    noindex: boolean;
    structuredBlockKinds: string[];
    quantitativeSignalCount: number;
    firstParagraph: string | null;
  };
  resources: SeoGeoAuditResources;
  issues: SeoGeoIssue[];
  priorities: SeoGeoIssue[];
  caveat: string;
}

export interface SeoGeoAuditOptions {
  fetchImpl?: FetchLike;
  lookupImpl?: LookupFn;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

interface TextFetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  text: string;
}

interface AnalysisInput {
  requestedUrl: string;
  finalUrl: string;
  httpStatus: number;
  html: string;
  resources: SeoGeoAuditResources;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function cleanText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    const key = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (key) out[key] = decodeHtmlEntities(value.trim());
  }
  return out;
}

function firstTagText(html: string, tagName: string): string | null {
  const match = html.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  const text = match?.[1] ? cleanText(match[1]) : "";
  return text || null;
}

function allTagText(html: string, tagName: string): string[] {
  return [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi"))]
    .map((match) => cleanText(match[1] ?? ""))
    .filter(Boolean);
}

function metaContent(html: string, keys: string[]): string | null {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const key = (attrs.name ?? attrs.property ?? attrs["http-equiv"] ?? "").toLowerCase();
    if (wanted.has(key) && attrs.content?.trim()) return attrs.content.trim();
  }
  return null;
}

function linkHref(html: string, relName: string): string | null {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    if (rel.includes(relName.toLowerCase()) && attrs.href?.trim()) return attrs.href.trim();
  }
  return null;
}

function htmlLang(html: string): string | null {
  const match = html.match(/<html\b[^>]*>/i);
  if (!match) return null;
  return attributes(match[0]).lang?.trim() || null;
}

function parseJsonLd(html: string): { count: number; types: string[]; hasAuthor: boolean; hasDate: boolean } {
  const values: unknown[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = attributes(`<script ${match[1] ?? ""}>`);
    if ((attrs.type ?? "").toLowerCase() !== "application/ld+json") continue;
    const raw = (match[2] ?? "").trim();
    if (!raw) continue;
    try {
      values.push(JSON.parse(raw));
    } catch {
      // Invalid JSON-LD is reported through the count/type gap rather than
      // failing the entire page audit.
    }
  }

  const types = new Set<string>();
  let hasAuthor = false;
  let hasDate = false;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    const rawType = obj["@type"];
    if (typeof rawType === "string") types.add(rawType);
    if (Array.isArray(rawType)) rawType.filter((v): v is string => typeof v === "string").forEach((v) => types.add(v));
    if (obj.author || obj.creator) hasAuthor = true;
    if (obj.datePublished || obj.dateModified || obj.uploadDate) hasDate = true;
    Object.values(obj).forEach(visit);
  };
  values.forEach(visit);
  return { count: values.length, types: [...types].sort(), hasAuthor, hasDate };
}

function visibleText(html: string): string {
  return cleanText(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " "),
  );
}

function countWords(text: string): number {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function resolveLinks(html: string, finalUrl: string): { internal: number; external: number } {
  let origin: string;
  try {
    origin = new URL(finalUrl).origin;
  } catch {
    return { internal: 0, external: 0 };
  }
  const internal = new Set<string>();
  const external = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attributes(match[0]).href;
    if (!href || /^(?:#|javascript:|mailto:|tel:)/i.test(href)) continue;
    try {
      const url = new URL(href, finalUrl);
      if (!/^https?:$/.test(url.protocol)) continue;
      (url.origin === origin ? internal : external).add(url.toString());
    } catch {
      // Ignore malformed links; they are outside this lightweight audit.
    }
  }
  return { internal: internal.size, external: external.size };
}

function extractFirstParagraph(html: string): string | null {
  for (const paragraph of allTagText(html, "p")) {
    if (paragraph.length >= 40) return paragraph.slice(0, 500);
  }
  return null;
}

function structuredBlockKinds(html: string): string[] {
  const kinds: string[] = [];
  if (/<(?:ul|ol)\b/i.test(html)) kinds.push("list");
  if (/<table\b/i.test(html)) kinds.push("table");
  if (/<(?:pre|code)\b/i.test(html)) kinds.push("code");
  if (/<blockquote\b/i.test(html)) kinds.push("blockquote");
  return kinds;
}

function quantitativeSignalCount(text: string): number {
  const matches = text.match(/(?:\b\d+(?:[.,]\d+)?\s*(?:%|ms|s|sec|seconds?|분|초|시간|원|만원|MB|GB|KB|x|배)\b)|(?:\b20\d{2}[-./]\d{1,2}[-./]\d{1,2}\b)/gi);
  return matches?.length ?? 0;
}

function isQuestionHeading(value: string): boolean {
  return /\?$|？$|^(?:왜|어떻게|무엇|뭐|언제|어디|누가|어떤|how|why|what|when|where|who)\b/i.test(value.trim());
}

function normalizeCanonical(raw: string | null, finalUrl: string): string | null {
  if (!raw) return null;
  try {
    return new URL(raw, finalUrl).toString();
  } catch {
    return raw;
  }
}

function grade(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function severityRank(severity: SeoGeoSeverity): number {
  return { high: 0, medium: 1, low: 2, info: 3 }[severity];
}

export function analyzeSeoGeoHtml(input: AnalysisInput): SeoGeoAuditResult {
  const { html, finalUrl, resources } = input;
  const title = firstTagText(html, "title");
  const metaDescription = metaContent(html, ["description"]);
  const canonical = normalizeCanonical(linkHref(html, "canonical"), finalUrl);
  const lang = htmlLang(html);
  const h1s = allTagText(html, "h1");
  const h2s = allTagText(html, "h2");
  const jsonLd = parseJsonLd(html);
  const text = visibleText(html);
  const links = resolveLinks(html, finalUrl);
  const firstParagraph = extractFirstParagraph(html);
  const blockKinds = structuredBlockKinds(html);
  const metaRobots = (metaContent(html, ["robots", "googlebot"]) ?? "").toLowerCase();
  const noindex = /(?:^|[,\s])noindex(?:[,\s]|$)/.test(metaRobots);
  const hasViewport = Boolean(metaContent(html, ["viewport"]));
  const hasOpenGraph = Boolean(
    metaContent(html, ["og:title"]) && metaContent(html, ["og:description"]) && metaContent(html, ["og:image"]),
  );
  const hasAuthor = Boolean(jsonLd.hasAuthor || metaContent(html, ["author", "article:author"]));
  const hasDate = Boolean(
    jsonLd.hasDate || metaContent(html, ["article:published_time", "article:modified_time", "date", "datepublished"]),
  );
  const wordCount = countWords(text);
  const questionHeadingCount = h2s.filter(isQuestionHeading).length;
  const quantitativeSignals = quantitativeSignalCount(text);
  const issues: SeoGeoIssue[] = [];
  const addIssue = (
    severity: SeoGeoSeverity,
    area: SeoGeoArea,
    check: string,
    evidence: string,
    recommendation: string,
  ): void => {
    issues.push({ severity, area, check, evidence, recommendation });
  };

  let seo = 0;
  if (title) seo += 5;
  else addIssue("high", "seo", "title", "<title> not found", "Add a unique page title that describes the page topic.");
  if (title && title.length >= 15 && title.length <= 70) seo += 3;
  else if (title) addIssue("low", "seo", "title-length", `${title.length} characters`, "Keep the title concise enough for search results while retaining the main topic.");
  if (metaDescription) seo += 5;
  else addIssue("medium", "seo", "meta-description", "meta description not found", "Add a concrete summary describing what the reader will get from the page.");
  if (metaDescription && metaDescription.length >= 60 && metaDescription.length <= 180) seo += 3;
  else if (metaDescription) addIssue("low", "seo", "meta-description-length", `${metaDescription.length} characters`, "Use a useful, non-stuffed description of roughly one to two sentences.");
  if (canonical) seo += 4;
  else addIssue("medium", "seo", "canonical", "canonical link not found", "Add rel=canonical when you control the page template.");
  if (h1s.length === 1) seo += 4;
  else addIssue("medium", "seo", "h1", `${h1s.length} H1 elements`, "Use one clear primary H1 that matches the page topic.");
  if (lang) seo += 2;
  else addIssue("low", "seo", "html-lang", "html lang attribute not found", "Set the document language on the html element.");
  if (hasViewport) seo += 2;
  else addIssue("low", "seo", "viewport", "viewport meta not found", "Add a responsive viewport meta tag for mobile rendering.");
  if (hasOpenGraph) seo += 4;
  else addIssue("low", "seo", "open-graph", "og:title/og:description/og:image set is incomplete", "Add Open Graph title, description, and image for reliable sharing previews.");
  if (!noindex) seo += 3;
  else addIssue("high", "seo", "indexability", "meta robots contains noindex", "Remove noindex if this page is intended to appear in search.");

  let crawlability = 0;
  if (resources.robots.exists && !resources.robots.globalDisallow) crawlability += 5;
  else if (resources.robots.globalDisallow) addIssue("high", "crawlability", "robots", "robots.txt globally disallows /", "Allow crawling for public content that should be discoverable.");
  else addIssue("low", "crawlability", "robots", resources.robots.note ?? "robots.txt not confirmed", "Confirm robots.txt does not accidentally block public content.");
  if (resources.sitemap.exists || (resources.robots.sitemapUrls?.length ?? 0) > 0) crawlability += 5;
  else addIssue("medium", "crawlability", "sitemap", "no reachable or declared sitemap confirmed", "Expose a sitemap and reference it from robots.txt when possible.");
  if (links.internal >= 3) crawlability += 3;
  else addIssue("medium", "crawlability", "internal-links", `${links.internal} distinct internal links`, "Link the page from related content and add useful internal navigation.");
  if (new URL(finalUrl).protocol === "https:") crawlability += 3;
  else addIssue("high", "crawlability", "https", finalUrl, "Serve the public page over HTTPS.");
  if (!canonical) {
    // canonical absence is already an SEO issue; do not duplicate it here.
  } else {
    try {
      if (new URL(canonical).origin === new URL(finalUrl).origin) crawlability += 2;
      else addIssue("low", "crawlability", "canonical-origin", canonical, "Confirm the cross-origin canonical is intentional.");
    } catch {
      addIssue("medium", "crawlability", "canonical-validity", canonical, "Use an absolute or resolvable canonical URL.");
    }
  }
  if (input.httpStatus >= 200 && input.httpStatus < 300) crawlability += 2;

  let structuredData = 0;
  if (jsonLd.count > 0) structuredData += 6;
  else addIssue("low", "structuredData", "json-ld", "no valid JSON-LD block found", "Add schema only when it accurately represents visible page content; do not treat schema as a GEO shortcut.");
  const usefulTypes = new Set(["Article", "BlogPosting", "TechArticle", "WebPage", "ProfilePage", "Organization", "Person", "BreadcrumbList", "FAQPage", "HowTo"]);
  if (jsonLd.types.some((type) => usefulTypes.has(type))) structuredData += 4;
  else if (jsonLd.count > 0) addIssue("low", "structuredData", "schema-type", jsonLd.types.join(", ") || "no @type found", "Use schema types that truthfully match the visible page.");
  if (hasAuthor && hasDate) structuredData += 3;
  else addIssue("medium", "structuredData", "provenance", `author=${hasAuthor}, date=${hasDate}`, "Make authorship and publish/update dates explicit when the content is editorial or technical.");
  if (jsonLd.types.includes("BreadcrumbList")) structuredData += 2;
  else addIssue("info", "structuredData", "breadcrumbs", "BreadcrumbList not found", "Breadcrumb schema is optional; add it only if the page has real breadcrumb navigation.");

  let geoCitability = 0;
  if (wordCount >= 500) geoCitability += 5;
  else addIssue("medium", "geoCitability", "content-depth", `${wordCount} whitespace-delimited tokens`, "Add firsthand details, concrete explanations, and evidence where the topic benefits from depth.");
  if (h2s.length >= 3) geoCitability += 4;
  else addIssue("medium", "geoCitability", "section-structure", `${h2s.length} H2 sections`, "Break the page into descriptive sections that answer distinct reader questions.");
  if (links.external >= 2) geoCitability += 4;
  else addIssue("medium", "geoCitability", "outbound-evidence", `${links.external} distinct external links`, "Cite primary or authoritative sources for claims that readers may want to verify.");
  if (blockKinds.length >= 2) geoCitability += 4;
  else addIssue("low", "geoCitability", "extractable-structure", blockKinds.join(", ") || "no list/table/code/blockquote blocks", "Use lists, tables, code, or quotations where they genuinely make facts easier to extract and verify.");
  if (firstParagraph && firstParagraph.length >= 60 && firstParagraph.length <= 500) geoCitability += 3;
  else addIssue("low", "geoCitability", "answer-first", firstParagraph ? `${firstParagraph.length} characters in first substantial paragraph` : "no substantial opening paragraph found", "State the page's main answer or purpose early, then expand with evidence.");
  if (hasAuthor) geoCitability += 3;
  else addIssue("medium", "geoCitability", "author", "author signal not found", "Expose a real author/profile identity for firsthand or expert content.");
  if (hasDate) geoCitability += 2;
  else addIssue("low", "geoCitability", "freshness", "publish/update date signal not found", "Show a publish or last-updated date when freshness matters.");
  if (quantitativeSignals >= 2) geoCitability += 3;
  else addIssue("low", "geoCitability", "specificity", `${quantitativeSignals} quantitative/date signals`, "Prefer concrete measurements, dates, versions, or counts over vague claims when available.");
  if (questionHeadingCount >= 1) geoCitability += 2;
  else addIssue("info", "geoCitability", "query-shaped-sections", "no question-shaped H2 found", "Question-style headings are optional; use them only when they match real reader queries.");

  const total = seo + crawlability + structuredData + geoCitability;
  if (!resources.llmsTxt.exists) {
    addIssue(
      "info",
      "geoCitability",
      "llms-txt",
      resources.llmsTxt.note ?? "llms.txt not found",
      "Optional only: llms.txt can document important pages for tools that choose to read it, but this audit gives it no ranking/citation points.",
    );
  }
  if ((resources.robots.aiCrawlerBlocks?.length ?? 0) > 0) {
    addIssue(
      "info",
      "crawlability",
      "ai-crawler-policy",
      `robots.txt blocks: ${resources.robots.aiCrawlerBlocks?.join(", ")}`,
      "Review whether blocking these crawlers matches your content and licensing policy; do not change it solely for a score.",
    );
  }

  const priorities = [...issues]
    .filter((issue) => issue.severity !== "info")
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, 8);

  return {
    url: input.requestedUrl,
    finalUrl,
    fetchedAt: new Date().toISOString(),
    httpStatus: input.httpStatus,
    score: {
      total,
      seo,
      crawlability,
      structuredData,
      geoCitability,
      grade: grade(total),
    },
    signals: {
      title,
      titleLength: title?.length ?? 0,
      metaDescription,
      metaDescriptionLength: metaDescription?.length ?? 0,
      canonical,
      lang,
      h1Count: h1s.length,
      h2Count: h2s.length,
      questionHeadingCount,
      wordCount,
      internalLinkCount: links.internal,
      externalLinkCount: links.external,
      jsonLdCount: jsonLd.count,
      schemaTypes: jsonLd.types,
      hasAuthor,
      hasDate,
      hasOpenGraph,
      hasViewport,
      noindex,
      structuredBlockKinds: blockKinds,
      quantitativeSignalCount: quantitativeSignals,
      firstParagraph,
    },
    resources,
    issues,
    priorities,
    caveat:
      "Heuristic readiness audit, not a search ranking or AI-citation guarantee. It inspects fetched static HTML and public discovery files; client-rendered metadata/content may require browser E2E verification.",
  };
}

async function readBodyWithLimit(
  response: Awaited<ReturnType<FetchLike>>,
  maxBytes: number,
  controller: AbortController,
): Promise<Buffer> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new DomainError(ErrorCode.QUOTA_EXCEEDED, `Response exceeds ${Math.floor(maxBytes / 1024)}KB audit limit`);
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw new DomainError(ErrorCode.QUOTA_EXCEEDED, `Response exceeds ${Math.floor(maxBytes / 1024)}KB audit limit`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function fetchPublicText(rawUrl: string, options: SeoGeoAuditOptions): Promise<TextFetchResult> {
  const fetchImpl = options.fetchImpl ?? defaultFetchImpl;
  const lookupImpl = options.lookupImpl ?? defaultLookup;
  const maxBytes = options.maxBytes ?? MAX_TEXT_BYTES;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  let validated = await assertUrlAllowed(rawUrl, lookupImpl);
  let currentUrl = validated.url;
  let pinnedAddresses = validated.addresses;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; ; hop++) {
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await fetchImpl(currentUrl.toString(), {
          signal: controller.signal,
          redirect: "manual",
          pinnedAddresses,
          headers: {
            "user-agent": AUDIT_USER_AGENT,
            accept: "text/html,application/xhtml+xml,text/plain,application/xml,text/xml;q=0.9,*/*;q=0.5",
            "accept-encoding": "identity",
          },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new DomainError(ErrorCode.TIMEOUT, `URL audit fetch timed out after ${timeoutMs}ms`, { url: currentUrl.toString() });
        }
        throw new DomainError(ErrorCode.PERMISSION_DENIED, `Could not fetch public URL: ${error instanceof Error ? error.message : String(error)}`, {
          url: currentUrl.toString(),
        });
      }
      if (response.status >= 300 && response.status < 400) {
        if (hop >= maxRedirects) {
          throw new DomainError(ErrorCode.PERMISSION_DENIED, `Too many redirects (max ${maxRedirects})`, { url: currentUrl.toString() });
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new DomainError(ErrorCode.PERMISSION_DENIED, "Redirect response missing Location header", { url: currentUrl.toString() });
        }
        const nextUrl = new URL(location, currentUrl).toString();
        validated = await assertUrlAllowed(nextUrl, lookupImpl);
        currentUrl = validated.url;
        pinnedAddresses = validated.addresses;
        continue;
      }
      const contentLength = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new DomainError(ErrorCode.QUOTA_EXCEEDED, `Response exceeds ${Math.floor(maxBytes / 1024)}KB audit limit`, {
          bytes: contentLength,
        });
      }
      const bytes = await readBodyWithLimit(response, maxBytes, controller);
      return {
        requestedUrl: rawUrl,
        finalUrl: currentUrl.toString(),
        status: response.status,
        contentType: response.headers.get("content-type"),
        text: bytes.toString("utf8"),
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

function parseRobots(text: string): {
  globalDisallow: boolean;
  sitemapUrls: string[];
  aiCrawlerBlocks: string[];
} {
  const sitemapUrls = [...text.matchAll(/^\s*sitemap\s*:\s*(\S+)\s*$/gim)].map((match) => match[1] ?? "").filter(Boolean);
  const groups: Array<{ agents: string[]; disallows: string[] }> = [];
  let current: { agents: string[]; disallows: string[] } = { agents: [], disallows: [] };
  let hasDirective = false;
  const flush = (): void => {
    if (current.agents.length > 0) groups.push(current);
    current = { agents: [], disallows: [] };
    hasDirective = false;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = (match[1] ?? "").trim().toLowerCase();
    const value = (match[2] ?? "").trim();
    if (key === "user-agent") {
      if (hasDirective) flush();
      current.agents.push(value.toLowerCase());
    } else if (key === "disallow" && current.agents.length > 0) {
      hasDirective = true;
      current.disallows.push(value);
    } else if (current.agents.length > 0 && key !== "sitemap") {
      hasDirective = true;
    }
  }
  flush();
  const blocksRoot = (group: { disallows: string[] }) => group.disallows.some((path) => path.trim() === "/");
  const globalDisallow = groups.some((group) => group.agents.includes("*") && blocksRoot(group));
  const aiAgents = ["gptbot", "chatgpt-user", "claudebot", "perplexitybot", "google-extended", "ccbot"];
  const aiCrawlerBlocks = aiAgents.filter((agent) => groups.some((group) => group.agents.includes(agent) && blocksRoot(group)));
  return { globalDisallow, sitemapUrls, aiCrawlerBlocks };
}

async function probeResource(url: string, options: SeoGeoAuditOptions): Promise<TextFetchResult | null> {
  try {
    const result = await fetchPublicText(url, { ...options, maxBytes: Math.min(options.maxBytes ?? MAX_TEXT_BYTES, 512 * 1024) });
    return result;
  } catch {
    return null;
  }
}

export async function auditSeoGeoUrl(url: string, options: SeoGeoAuditOptions = {}): Promise<SeoGeoAuditResult> {
  const main = await fetchPublicText(url, options);
  if (main.status < 200 || main.status >= 300) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `URL returned HTTP ${main.status}`, { url: main.finalUrl, status: main.status });
  }
  const contentType = (main.contentType ?? "").toLowerCase();
  if (contentType && !/(?:text\/html|application\/xhtml\+xml)/.test(contentType)) {
    throw new DomainError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, `Expected HTML but received ${main.contentType}`, { url: main.finalUrl });
  }

  const origin = new URL(main.finalUrl).origin;
  const robotsUrl = new URL("/robots.txt", origin).toString();
  const robotsResult = await probeResource(robotsUrl, options);
  const robotsParsed = robotsResult && robotsResult.status >= 200 && robotsResult.status < 300
    ? parseRobots(robotsResult.text)
    : { globalDisallow: false, sitemapUrls: [], aiCrawlerBlocks: [] };
  const declaredSitemap = robotsParsed.sitemapUrls[0];
  const sitemapUrl = declaredSitemap ? new URL(declaredSitemap, origin).toString() : new URL("/sitemap.xml", origin).toString();
  const llmsUrl = new URL("/llms.txt", origin).toString();
  const [sitemapResult, llmsResult] = await Promise.all([
    probeResource(sitemapUrl, options),
    probeResource(llmsUrl, options),
  ]);

  const robotsExists = Boolean(robotsResult && robotsResult.status >= 200 && robotsResult.status < 300);
  const sitemapExists = Boolean(
    sitemapResult && sitemapResult.status >= 200 && sitemapResult.status < 300 && /<(?:urlset|sitemapindex)\b/i.test(sitemapResult.text),
  );
  const llmsExists = Boolean(llmsResult && llmsResult.status >= 200 && llmsResult.status < 300 && llmsResult.text.trim().length > 0);
  const resources: SeoGeoAuditResources = {
    robots: {
      url: robotsUrl,
      status: robotsResult?.status ?? null,
      exists: robotsExists,
      globalDisallow: robotsParsed.globalDisallow,
      sitemapUrls: robotsParsed.sitemapUrls,
      aiCrawlerBlocks: robotsParsed.aiCrawlerBlocks,
      note: robotsExists ? undefined : "robots.txt was not reachable with a successful response",
    },
    sitemap: {
      url: sitemapUrl,
      status: sitemapResult?.status ?? null,
      exists: sitemapExists,
      note: sitemapExists ? undefined : "no valid urlset/sitemapindex was confirmed at the declared/default sitemap URL",
    },
    llmsTxt: {
      url: llmsUrl,
      status: llmsResult?.status ?? null,
      exists: llmsExists,
      note: llmsExists ? undefined : "llms.txt was not confirmed; this is informational and does not reduce the numeric score",
    },
  };

  return analyzeSeoGeoHtml({
    requestedUrl: url,
    finalUrl: main.finalUrl,
    httpStatus: main.status,
    html: main.text,
    resources,
  });
}
