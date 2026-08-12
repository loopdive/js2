// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2928 E6 — the shared runtime-eval provider seam: source assembly and the
 * disk cache the Test262 runner links from. The HEAVY end-to-end proof (real
 * Acorn compile + link + canaries) lives in
 * tests/issue-2928-runtime-acorn.test.ts; this file covers the cheap
 * distribution plumbing so a drift (renamed export, broken strip, cache
 * key/path instability) fails fast without a multi-minute compile.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    expect(source).toContain("function __runtime_direct_eval(");
    expect(source).toContain("function __runtime_apply_interpreted(");
    // The interpreter entry points behind it.
    expect(source).toContain("function createDynamicFunction(");
    expect(source).toContain("function executeIndirectEval(");
    expect(source).toContain("function executeDirectEval(");
    // Build-time positive controls must be present so the prebuild can refuse
    // a broken provider before caching it.
    expect(source).toContain("function __runtime_eval_canary(");
    expect(source).toContain("function __runtime_direct_eval_canary(");
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

  it("publishes one full provider artifact and requires it in every standalone CI shard", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/test262-sharded.yml"), "utf8");
    expect(workflow).toContain("runtime-eval-provider:");
    expect(workflow).toContain("node scripts/build-runtime-eval-provider.mjs\n");
    expect(workflow).toContain("path: .test262-cache/runtime-eval-provider-*.wasm");
    expect(workflow).toContain("uses: actions/upload-artifact@v6");
    expect(workflow).toContain("uses: actions/download-artifact@v7");
    expect(workflow).toContain("TEST262_FULL_RUNTIME_EVAL:");
    expect(workflow.match(/--require-full-cache/g)).toHaveLength(2);
    expect(workflow).not.toContain("Prebuild refusal runtime-eval provider (#2928)");
  });

  // (#4242/#4354) refresh-baseline.yml promotes the SAME standalone baseline
  // as test262-sharded.yml, so it must build and select the QuickJS default.
  // A provider on disk without the matching selector is a green no-op; assert
  // both halves so scheduled refreshes cannot silently publish another tier.
  it("measures the default QuickJS tier in refresh-baseline too", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/refresh-baseline.yml"), "utf8");
    expect(workflow).toContain("JS2WASM_EVAL_ENGINE: quickjs");
    expect(workflow).toContain("TEST262_FULL_RUNTIME_EVAL:");
    expect(workflow).toContain("node scripts/build-quickjs-eval-provider.mjs\n");
    expect(workflow).not.toContain("node scripts/build-runtime-eval-provider.mjs\n");
  });

  // (#4354) …and builds it ONCE, fanning the artifact out to the 57 standalone
  // shards. `--require-cache` is the integrity half: a broken fan-out cannot
  // silently fall back to the interpreter or refusal tier.
  it("builds the refresh-baseline provider once and fans it out to the shards", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/refresh-baseline.yml"), "utf8");
    expect(workflow).toContain("runtime-eval-provider:");
    expect(workflow).toContain(".test262-cache/quickjs-artifact-*/");
    expect(workflow).toContain(".test262-cache/quickjs-eval-adapter-*.wasm");
    expect(workflow).toContain("uses: actions/upload-artifact@v6");
    expect(workflow).toContain("uses: actions/download-artifact@v7");
    expect(workflow).toContain("build-quickjs-eval-provider.mjs --require-cache");
    expect(workflow).toContain("needs: [validate-inputs, runtime-eval-provider]");
  });
});
