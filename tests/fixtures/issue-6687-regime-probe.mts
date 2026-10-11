// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6687 — out-of-process probe for tests/issue-6687-native-regime-async-gen-meth-dstr.test.ts.
// A native-regime compile of the assembled test262 harness exceeds the 512 MB
// Vitest fork, so the test runs this script with a larger heap. Prints one JSON
// array: per (file, profile) the validation error (null = valid) and a sha256.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { compile } from "../../src/index.ts";
import { assembleOriginalHarness } from "../test262-original-harness.ts";
import { parseMeta } from "../test262-runner.ts";

const PROFILES: Record<string, { opts: Record<string, unknown>; regimeEnv: boolean }> = {
  regime: { opts: { semanticProviders: "native-first" }, regimeEnv: true },
  standalone: { opts: { target: "standalone" }, regimeEnv: false },
  default: { opts: {}, regimeEnv: false },
};

const [filesArg = "", profilesArg = "regime,standalone,default"] = process.argv.slice(2);
const out: { file: string; profile: string; error: string | null; sha256?: string }[] = [];
for (const file of filesArg.split(",").filter(Boolean)) {
  const src = readFileSync(`test262/test/${file}`, "utf-8");
  const source = assembleOriginalHarness(src, parseMeta(src) as never).primary.source;
  for (const profile of profilesArg.split(",")) {
    const p = PROFILES[profile]!;
    if (p.regimeEnv) process.env.JS2WASM_NATIVE_REGIME_JS = "1";
    else delete process.env.JS2WASM_NATIVE_REGIME_JS;
    const r = await compile(source, {
      skipSemanticDiagnostics: true,
      inferModuleStrictArguments: false,
      ...p.opts,
    } as never);
    if (!r.success) {
      out.push({ file, profile, error: `compile error: ${r.errors?.[0]?.message}` });
      continue;
    }
    let error: string | null = null;
    try {
      new WebAssembly.Module(r.binary);
    } catch (e) {
      error = (e as Error).message;
    }
    out.push({ file, profile, error, sha256: createHash("sha256").update(r.binary).digest("hex") });
  }
}
process.stdout.write(JSON.stringify(out));
