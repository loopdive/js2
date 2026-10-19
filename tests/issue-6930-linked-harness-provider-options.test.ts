// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6930 — the linked-harness provider must be compiled under the same
// semantic-provider policy as the test body, and keyed by it. Before the fix
// the provider options dropped `semanticProviders`, so a native-first (regime)
// body was linked to a host-assisted prefix and every row failed to
// instantiate (`__js2wasm_link_error_ctor_Error`).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildHarnessProvider, harnessProviderCacheKey } from "../src/test262-harness-provider.ts";
import {
  harnessProviderCompileOptions,
  harnessProviderMemoKey,
  harnessProviderRegimeTag,
  test262HarnessProviderCacheDir,
  test262HarnessProviderLaneCacheDir,
} from "../scripts/test262-harness-cache.mjs";

const PREFIX = "function assert(c) { if (!c) throw new Error('x'); }\n";

describe("#6930 linked-harness provider options carry the semantic-provider policy", () => {
  it("host lane options are unchanged (no semanticProviders field)", () => {
    const options = harnessProviderCompileOptions(undefined);
    expect(options).toEqual({ hostBridge: "always", allowJs: true, emitWat: false, skipSemanticDiagnostics: true });
    expect(harnessProviderCompileOptions(undefined, "auto")).toEqual(options);
  });

  // (#6708 S6) native-first is the default lane: it spells nothing, like the
  // body; only the host-assisted control lane carries the policy.
  it("host-assisted options carry semanticProviders, like the body; native-first is the default", () => {
    expect(harnessProviderCompileOptions(undefined, "native-first")).toEqual(harnessProviderCompileOptions(undefined));
    expect(harnessProviderCompileOptions(undefined, "host-assisted").semanticProviders).toBe("host-assisted");
    expect(harnessProviderCompileOptions("standalone", "host-assisted")).toMatchObject({
      target: "standalone",
      semanticProviders: "host-assisted",
    });
  });

  it("the content-addressed cache key separates host and native-first providers", () => {
    const host = harnessProviderCacheKey({
      harnessPrefix: PREFIX,
      compileOptions: harnessProviderCompileOptions(undefined),
    });
    const auto = harnessProviderCacheKey({
      harnessPrefix: PREFIX,
      compileOptions: harnessProviderCompileOptions(undefined, "auto"),
    });
    const native = harnessProviderCacheKey({
      harnessPrefix: PREFIX,
      compileOptions: harnessProviderCompileOptions(undefined, "native-first"),
    });
    const hostAssisted = harnessProviderCacheKey({
      harnessPrefix: PREFIX,
      compileOptions: harnessProviderCompileOptions(undefined, "host-assisted"),
    });
    expect(auto).toBe(host);
    expect(native).toBe(host);
    expect(hostAssisted).not.toBe(host);
  });

  it("the worker memo key separates policy and the regime kill switch", () => {
    const env = {};
    const regime = harnessProviderMemoKey(PREFIX, undefined, "auto", env);
    const hostAssisted = harnessProviderMemoKey(PREFIX, undefined, "host-assisted", env);
    const regimeOff = harnessProviderMemoKey(PREFIX, undefined, "auto", { JS2WASM_NATIVE_REGIME_JS: "0" });
    expect(new Set([regime, hostAssisted, regimeOff]).size).toBe(3);
    expect(harnessProviderMemoKey(PREFIX, undefined, "native-first", env)).toBe(regime);
    // (#6708) The kill switch only matters for the default (native-first) lane.
    expect(harnessProviderMemoKey(PREFIX, undefined, "host-assisted", { JS2WASM_NATIVE_REGIME_JS: "0" })).toBe(
      hostAssisted,
    );
    expect(harnessProviderRegimeTag("host-assisted", { JS2WASM_NATIVE_REGIME_JS: "0" })).toBe("");
    expect(harnessProviderRegimeTag("auto", {})).toBe("");
    expect(harnessProviderRegimeTag("auto", { JS2WASM_NATIVE_REGIME_JS: "0" })).not.toBe("");
    expect(harnessProviderRegimeTag("native-first", { JS2WASM_NATIVE_REGIME_JS: "0" })).not.toBe("");
  });

  it("only a regime-off native-first lane moves to its own cache directory", () => {
    const env = { TEST262_BUNDLE_HASH: "fixed" };
    const root = "/cache-root";
    const host = test262HarnessProviderLaneCacheDir({ root, env });
    expect(host).toBe(test262HarnessProviderCacheDir({ root, env }));
    expect(test262HarnessProviderLaneCacheDir({ root, semanticProviders: "native-first", env })).toBe(host);
    expect(
      test262HarnessProviderLaneCacheDir({
        root,
        semanticProviders: "native-first",
        env: { ...env, JS2WASM_NATIVE_REGIME_JS: "0" },
      }),
    ).not.toBe(host);
  });
});

describe("#6930 a native-first provider exports the regime ABI the body imports", () => {
  it("exports the #6723 D4 Error-family carrier cells only under native-first (the default)", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "js2wasm-6930-"));
    try {
      const exportsOf = async (semanticProviders: string) => {
        const provider = await buildHarnessProvider({
          harnessPrefix: PREFIX,
          cacheDir,
          compileOptions: harnessProviderCompileOptions(undefined, semanticProviders),
        });
        return WebAssembly.Module.exports(new WebAssembly.Module(provider.artifact.binary)).map((e) => e.name);
      };
      const CELL = "__js2wasm_link_error_ctor_Error";
      expect(await exportsOf("host-assisted")).not.toContain(CELL);
      expect(await exportsOf("auto")).toContain(CELL);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }, 120_000);
});
