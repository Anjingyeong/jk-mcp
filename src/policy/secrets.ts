import * as path from "node:path";

/**
 * Path-pattern denylist (PRD §9.4 DENY_READ). Patterns are matched against
 * both the basename and the path segments so that directory-scoped globs
 * like ".aws/*" or ".ssh/*" match regardless of where the project root is
 * mounted.
 */
const DENY_BASENAME_PATTERNS: RegExp[] = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa.*$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^\.npmrc$/i,
  /token/i,
  /secret/i,
  /credential/i,
  /\.keystore$/i,
];

/** Directory-scoped patterns: any file inside one of these dirs is denied. */
const DENY_DIR_SEGMENTS: string[] = [".aws", ".ssh", "gcloud"];

/**
 * Check whether an absolute path matches the secret-read denylist (PRD
 * §9.4): .env, *.pem, *.key, id_rsa*, .npmrc, *token*, *secret*,
 * *credential*, .aws/*, .ssh/*, .config/gcloud/*, *.keystore, etc.
 */
export function isSecretPath(abs: string): boolean {
  const normalized = abs.split(path.sep).join("/");
  const segments = normalized.split("/").filter((s) => s.length > 0);
  const basename = segments[segments.length - 1] ?? "";

  if (DENY_BASENAME_PATTERNS.some((re) => re.test(basename))) {
    return true;
  }

  // Directory-scoped: .aws/*, .ssh/*, .config/gcloud/* — any path with one
  // of these directories as an ancestor segment (not the leaf itself, since
  // the leaf's own basename patterns are already covered above; but a bare
  // directory entry should also be denied for consistency).
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (seg !== undefined && DENY_DIR_SEGMENTS.includes(seg)) {
      return true;
    }
  }
  // Also catch the case where the path IS exactly one of the sensitive
  // directories (no children referenced).
  if (segments.length > 0) {
    const last = segments[segments.length - 1];
    if (last !== undefined && DENY_DIR_SEGMENTS.includes(last)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// redact()
// ---------------------------------------------------------------------------

const MASK = "[REDACTED]";

/** AWS access key id, e.g. AKIAABCDEFGHIJKLMNOP */
const AWS_ACCESS_KEY_RE = /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g;

/** AWS secret access key assignment (heuristic: 40-char base64-ish value). */
const AWS_SECRET_ASSIGN_RE =
  /\b((?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*)([A-Za-z0-9/+=]{40})\b/g;

/** GCP API key, e.g. AIzaSy... (39 chars total). */
const GCP_API_KEY_RE = /\bAIza[0-9A-Za-z\-_]{35}\b/g;

/** GCP service-account-style "private_key_id"/"client_secret" JSON fields. */
const GCP_JSON_FIELD_RE =
  /("(?:private_key_id|client_secret|client_email)"\s*:\s*")([^"]*)(")/g;

/** DATABASE_URL=... (and similar *_URL connection strings with credentials). */
const DATABASE_URL_RE =
  /\b((?:DATABASE_URL|DB_URL|POSTGRES_URL|MYSQL_URL|MONGO(?:DB)?_URI)\s*=\s*)(\S+)/gi;

/** Generic connection-string form: scheme://user:pass@host */
const CONN_STRING_CREDS_RE = /\b([a-zA-Z][\w+.-]*:\/\/)([^:\/\s]+):([^@\/\s]+)@/g;

/** PEM private key block, e.g. -----BEGIN RSA PRIVATE KEY----- ... -----END ... -----. */
const PEM_BLOCK_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** Generic bearer/token assignment: token=..., secret=..., apikey=... */
const GENERIC_KV_SECRET_RE =
  /\b((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd)\s*[:=]\s*)(['"]?)([A-Za-z0-9\-_./+=]{8,})\2/gi;

/** Bearer token in an Authorization header. */
const BEARER_RE = /\b(Bearer\s+)([A-Za-z0-9\-_.~+/]{10,}=*)/gi;

/**
 * Generic high-entropy token heuristic: a long run (>=32 chars) of
 * base64/hex-like characters with a mix of upper/lower/digit, not already
 * caught by a more specific rule above. Deliberately conservative to avoid
 * mass false positives on ordinary code/prose.
 */
function maskHighEntropyTokens(text: string): string {
  return text.replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g, (match) => {
    // Skip if it looks like a normal word run (all-lowercase, no digits) —
    // reduces false positives on long identifiers/URLs made of words only.
    const hasDigit = /\d/.test(match);
    const hasUpper = /[A-Z]/.test(match);
    const hasLower = /[a-z]/.test(match);
    const varietyScore = [hasDigit, hasUpper, hasLower].filter(Boolean).length;
    if (varietyScore < 2) return match;

    // Skip common non-secret high-entropy-looking strings: hex-only hashes
    // are still worth masking (could be a token), so we don't special-case
    // those out. But skip things that are clearly hyphenated slugs/paths.
    if (match.includes("/") && !hasDigit) return match;

    return MASK;
  });
}

/**
 * Mask likely secret material (AWS/GCP keys, DATABASE_URL, PEM private key
 * blocks, generic high-entropy tokens) from text before it is returned to
 * the model (PRD §9.4 outputGuard).
 */
export function redact(text: string): string {
  let out = text;

  out = out.replace(PEM_BLOCK_RE, MASK);
  out = out.replace(AWS_ACCESS_KEY_RE, MASK);
  out = out.replace(AWS_SECRET_ASSIGN_RE, (_m, prefix: string) => `${prefix}${MASK}`);
  out = out.replace(GCP_API_KEY_RE, MASK);
  out = out.replace(
    GCP_JSON_FIELD_RE,
    (_m, prefix: string, _val: string, suffix: string) => `${prefix}${MASK}${suffix}`,
  );
  out = out.replace(DATABASE_URL_RE, (_m, prefix: string) => `${prefix}${MASK}`);
  out = out.replace(
    CONN_STRING_CREDS_RE,
    (_m, scheme: string, user: string) => `${scheme}${user}:${MASK}@`,
  );
  out = out.replace(BEARER_RE, (_m, prefix: string) => `${prefix}${MASK}`);
  out = out.replace(
    GENERIC_KV_SECRET_RE,
    (_m, prefix: string, quote: string) => `${prefix}${quote}${MASK}${quote}`,
  );
  out = maskHighEntropyTokens(out);

  return out;
}
