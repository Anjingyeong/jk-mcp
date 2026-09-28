import { readFileSync } from "node:fs";
import { z } from "zod";

// Both source and compiled runtime modules are one directory below package.json.
export const RUNTIME_VERSION = z.object({ version: z.string().min(1) }).parse(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
).version;
