import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isSecretPath, redact } from "./secrets.js";

describe("isSecretPath", () => {
  it("blocks .env and .env.* files", () => {
    expect(isSecretPath("/proj/.env")).toBe(true);
    expect(isSecretPath("/proj/.env.local")).toBe(true);
    expect(isSecretPath("/proj/.env.production")).toBe(true);
  });

  it("blocks pem/key/p12/pfx/keystore files", () => {
    expect(isSecretPath("/proj/certs/server.pem")).toBe(true);
    expect(isSecretPath("/proj/certs/server.key")).toBe(true);
    expect(isSecretPath("/proj/certs/bundle.p12")).toBe(true);
    expect(isSecretPath("/proj/certs/bundle.pfx")).toBe(true);
    expect(isSecretPath("/proj/app.keystore")).toBe(true);
  });

  it("blocks id_rsa* files", () => {
    expect(isSecretPath("/home/user/.ssh/id_rsa")).toBe(true);
    expect(isSecretPath("/home/user/.ssh/id_rsa.pub")).toBe(true);
  });

  it("blocks .npmrc", () => {
    expect(isSecretPath("/proj/.npmrc")).toBe(true);
  });

  it("blocks anything with token/secret/credential in the name", () => {
    expect(isSecretPath("/proj/config/api_token.json")).toBe(true);
    expect(isSecretPath("/proj/secrets.yaml")).toBe(true);
    expect(isSecretPath("/proj/credentials.json")).toBe(true);
  });

  it("blocks .aws/.ssh/.config/gcloud directory contents", () => {
    expect(isSecretPath(path.join("/home/user", ".aws", "credentials"))).toBe(true);
    expect(isSecretPath(path.join("/home/user", ".ssh", "config"))).toBe(true);
    expect(isSecretPath(path.join("/home/user", ".config", "gcloud", "legacy_credentials"))).toBe(
      true,
    );
  });

  it("this specific symlink/secret path used by the escape test is blocked", () => {
    // Directly exercises the fixture referenced by the task description:
    // a path within a denylisted directory must be blocked regardless of
    // how it was reached (symlink or not) — the read guard is path-based.
    expect(isSecretPath("/proj/.ssh/id_rsa")).toBe(true);
  });

  it("allows ordinary source files", () => {
    expect(isSecretPath("/proj/src/index.ts")).toBe(false);
    expect(isSecretPath("/proj/README.md")).toBe(false);
    expect(isSecretPath("/proj/package.json")).toBe(false);
  });
});

describe("redact", () => {
  it("masks a fake AWS access key id", () => {
    const text = "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    const out = redact(text);
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[REDACTED]");
  });

  it("masks a fake AWS secret access key assignment", () => {
    const text = "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const out = redact(text);
    expect(out).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(out).toContain("[REDACTED]");
  });

  it("masks a fake GCP API key", () => {
    const text = "const key = 'AIzaSyD-1234567890abcdefghijklmnopqrstuv';";
    const out = redact(text);
    expect(out).not.toContain("AIzaSyD-1234567890abcdefghijklmnopqrstuv");
  });

  it("masks DATABASE_URL assignments", () => {
    const text = "DATABASE_URL=postgres://user:pass@localhost:5432/dbname";
    const out = redact(text);
    expect(out).not.toContain("postgres://user:pass@localhost:5432/dbname");
    expect(out).toContain("DATABASE_URL=");
    expect(out).toContain("[REDACTED]");
  });

  it("masks generic connection-string credentials", () => {
    const text = "mongodb://admin:sup3rSecretPW@cluster0.example.net:27017/app";
    const out = redact(text);
    expect(out).not.toContain("sup3rSecretPW");
    expect(out).toContain("admin:[REDACTED]@");
  });

  it("masks a PEM private key block", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumnAxuNbaBcAAJq7O2t7HGh6h",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redact(`before\n${pem}\nafter`);
    expect(out).not.toContain("MIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumnAxuNbaBcAAJq7O2t7HGh6h");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("masks generic key=value secret assignments", () => {
    const text = 'api_key: "sk_live_51H8xyzABCDEFGHIJKLMNOP"';
    const out = redact(text);
    expect(out).not.toContain("sk_live_51H8xyzABCDEFGHIJKLMNOP");
  });

  it("masks Authorization: Bearer tokens", () => {
    const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";
    const out = redact(text);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig");
    expect(out).toContain("Bearer [REDACTED]");
  });

  it("masks generic high-entropy tokens not caught by specific rules", () => {
    const text = "leaked=Zx9Qp2Kv8Lm3Nc7Bt1Ry5Ws0Ju4Ha6Fd";
    const out = redact(text);
    expect(out).not.toContain("Zx9Qp2Kv8Lm3Nc7Bt1Ry5Ws0Ju4Ha6Fd");
  });

  it("leaves ordinary prose and code untouched", () => {
    const text = "function add(a, b) {\n  return a + b;\n}\n// this is a normal comment";
    expect(redact(text)).toBe(text);
  });
});
