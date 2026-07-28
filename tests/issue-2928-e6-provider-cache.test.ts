// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2928 E6 — the shared runtime-eval provider seam: source assembly and the
 * disk cache the Test262 runner links from. The HEAVY end-to-end proof (real
 * Acorn compile + link + canaries) lives in
 * tests/issue-2928-runtime-acorn.test.ts; this file covers the cheap
 * distribution plumbing so a drift (renamed export, broken strip, cache
 * key/path instability) fails fast without a multi-minute compile.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  RUNTIME_EVAL_IMPORT_MODULE,
  buildRuntimeEvalProviderSource,
  readCachedRuntimeEvalProvider,
  runtimeEvalProviderCacheKey,
  runtimeEvalProviderCachePath,
  writeCachedRuntimeEvalProvider,
} from "../scripts/runtime-eval-provider.mjs";

describe("#2928 E6 — runtime-eval provider seam", () => {
  it("assembles the provider as one import-clean source unit with the published exports", () => {
    const source = buildRuntimeEvalProviderSource();
    // The published `js2wasm:runtime-eval` surface.
    expect(source).toContain("function __runtime_new_function(");
    expect(source).toContain("function __runtime_indirect_eval(");
    // The interpreter entry points behind it.
    expect(source).toContain("function createDynamicFunction(");
    expect(source).toContain("function executeIndirectEval(");
    // Build-time positive controls must be present so the prebuild can refuse
    // a broken provider before caching it.
    expect(source).toContain("function __runtime_eval_canary(");
    expect(source).toContain("function __runtime_positive_corpus_canary(");
    // Module syntax must be stripped — the provider is ONE ordered-initializer
    // unit, not a module graph.
    expect(source).not.toMatch(/^import /m);
    expect(source).not.toMatch(/^export \{/m);
  });

  it("namespace constant matches the codegen import module", () => {
    expect(RUNTIME_EVAL_IMPORT_MODULE).toBe("js2wasm:runtime-eval");
  });

  it("cache key is stable and sensitive to source + bundle hash", () => {
    const a = runtimeEvalProviderCacheKey("source-a", "bundle-1");
    expect(runtimeEvalProviderCacheKey("source-a", "bundle-1")).toBe(a);
    expect(runtimeEvalProviderCacheKey("source-b", "bundle-1")).not.toBe(a);
    expect(runtimeEvalProviderCacheKey("source-a", "bundle-2")).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("cache write + read round-trips atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-eval-provider-test-"));
    try {
      const key = runtimeEvalProviderCacheKey("round-trip", "bundle");
      expect(readCachedRuntimeEvalProvider(dir, key)).toBeNull();
      const payload = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const written = writeCachedRuntimeEvalProvider(dir, key, payload);
      expect(written).toBe(runtimeEvalProviderCachePath(dir, key));
      const back = readCachedRuntimeEvalProvider(dir, key);
      expect(back).not.toBeNull();
      expect(Buffer.compare(back!, payload)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
