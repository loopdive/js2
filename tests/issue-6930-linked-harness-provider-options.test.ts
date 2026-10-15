// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6930 — the linked-harness provider must be compiled under the same
// semantic-provider policy as the test body. Before the fix a native-first
// (regime) body was linked to a host-assisted prefix and every row failed to
// instantiate (`__js2wasm_link_error_ctor_Error`). (#6979) The regime is now the
// only policy, so provider and body agree by construction and no policy field
// is spelled or keyed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildHarnessProvider } from "../src/test262-harness-provider.ts";
import {
  harnessProviderCompileOptions,
  harnessProviderMemoKey,
  test262HarnessProviderCacheDir,
  test262HarnessProviderLaneCacheDir,
} from "../scripts/test262-harness-cache.mjs";

const PREFIX = "function assert(c) { if (!c) throw new Error('x'); }\n";

describe("#6930 linked-harness provider options", () => {
  it("host lane options spell no semantic-provider policy", () => {
    expect(harnessProviderCompileOptions(undefined)).toEqual({
      hostBridge: "always",
      allowJs: true,
      emitWat: false,
      skipSemanticDiagnostics: true,
    });
    expect(harnessProviderCompileOptions("standalone")).toMatchObject({ target: "standalone" });
    expect(harnessProviderCompileOptions("standalone")).not.toHaveProperty("semanticProviders");
  });

  it("the worker memo key separates targets and prefixes only", () => {
    const host = harnessProviderMemoKey(PREFIX, undefined);
    expect(harnessProviderMemoKey(PREFIX, "standalone")).not.toBe(host);
    expect(harnessProviderMemoKey(`${PREFIX}\n`, undefined)).not.toBe(host);
    expect(harnessProviderMemoKey(PREFIX, undefined)).toBe(host);
  });

  it("the lane cache directory is the shared provider cache root", () => {
    const env = { TEST262_BUNDLE_HASH: "fixed" };
    const root = "/cache-root";
    expect(test262HarnessProviderLaneCacheDir({ root, env })).toBe(test262HarnessProviderCacheDir({ root, env }));
  });
});

describe("#6930 the provider exports the regime ABI the body imports", () => {
  it("exports the #6723 D4 Error-family carrier cells", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "js2wasm-6930-"));
    try {
      const provider = await buildHarnessProvider({
        harnessPrefix: PREFIX,
        cacheDir,
        compileOptions: harnessProviderCompileOptions(undefined),
      });
      const names = WebAssembly.Module.exports(new WebAssembly.Module(provider.artifact.binary)).map((e) => e.name);
      expect(names).toContain("__js2wasm_link_error_ctor_Error");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }, 120_000);
});
