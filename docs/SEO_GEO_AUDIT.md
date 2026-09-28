# JK SEO/GEO URL Audit

JK can audit a public page URL for search-engine and AI-answer readiness without installing a separate SEO/GEO service.

## Usage

Natural language is the default interface:

```text
@jk https://example.com/post/123 SEO/GEO 검사해줘.
문제 근거와 우선순위 높은 수정부터 알려줘.
```

The underlying tool/action is `seo_geo_audit` and accepts one field:

```json
{
  "url": "https://example.com/post/123"
}
```

## What it checks

The audit returns four transparent readiness scores totaling 100 points:

- SEO: title, description, canonical, H1, language, viewport, Open Graph, indexability
- Crawlability: robots.txt, sitemap, internal links, HTTPS, canonical consistency, HTTP success
- Structured data: valid JSON-LD, useful schema types, author/date provenance, breadcrumbs when present
- GEO citability: content depth, section structure, outbound evidence links, extractable blocks, answer-first opening, author/date, quantitative specificity

It also probes public discovery resources at the page origin:

- `/robots.txt`
- a sitemap declared by robots.txt, otherwise `/sitemap.xml`
- `/llms.txt`

`llms.txt` is reported as an informational signal only. Its presence does **not** add numeric points, because the audit should not imply that an optional convention guarantees AI citations or rankings.

## Output

The result includes:

- total and category scores
- extracted evidence such as title, H1/H2 counts, canonical URL, JSON-LD types, author/date signals, link counts, and content structure
- robots/sitemap/llms.txt probe status
- issues with severity, evidence, and a concrete recommendation
- a short prioritized list of the most important non-informational fixes

The score is a **readiness heuristic**, not a ranking or AI-citation prediction. Static HTML is inspected; heavily client-rendered pages may need browser E2E verification as a follow-up.

## Network safety

The URL fetch reuses JK's existing public-URL safety boundary:

- only `http` and `https`
- DNS resolution before connection
- loopback/private/link-local/metadata/reserved ranges blocked
- all resolved addresses checked
- DNS-pinned connection to reduce rebinding/TOCTOU risk
- every redirect target revalidated
- response size and fetch timeout limits

This makes `seo_geo_audit` suitable for user-provided public URLs without turning it into a general internal-network fetch primitive.
