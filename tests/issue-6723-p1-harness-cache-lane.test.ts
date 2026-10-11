// #6723 P1/P2 — the harness-provider cache is keyed on the compiler bundle, and
// the standalone linked oracle is reachable ONLY through an explicit opt-in.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  test262CompilerBundleHash,
  test262HarnessProviderCacheDir,
  test262OracleLane,
} from "../scripts/test262-harness-cache.mjs";

function scriptsDirWith(bundle: string): string {
  const dir = mkdtempSync(join(tmpdir(), "js2wasm-6723-bundle-"));
  writeFileSync(join(dir, "compiler-bundle.mjs"), bundle);
  return dir;
}

describe("#6723 P1 harness-provider cache key", () => {
  it("a different compiler bundle gets a different cache directory under the same root", () => {
    const env = { JS2WASM_TEST262_HARNESS_CACHE: "/cache/root" };
    const a = test262HarnessProviderCacheDir({ env, scriptsDir: scriptsDirWith("export const v = 1;") });
    const b = test262HarnessProviderCacheDir({ env, scriptsDir: scriptsDirWith("export const v = 2;") });
    expect(a).not.toBe(b);
    expect(a.startsWith(join("/cache/root", "bundle-"))).toBe(true);
    expect(b.startsWith(join("/cache/root", "bundle-"))).toBe(true);
  });

  it("the same bundle is stable, and the override stays the root", () => {
    const scriptsDir = scriptsDirWith("export const v = 3;");
    const env = { JS2WASM_TEST262_HARNESS_CACHE: "/x" };
    const hash = test262CompilerBundleHash({ env, scriptsDir });
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(test262HarnessProviderCacheDir({ env, scriptsDir })).toBe(join("/x", `bundle-${hash}`));
    expect(test262HarnessProviderCacheDir({ env, scriptsDir })).toBe(join("/x", `bundle-${hash}`));
  });

  it("an explicit root wins over the env override; TEST262_BUNDLE_HASH wins over the file", () => {
    const env = { JS2WASM_TEST262_HARNESS_CACHE: "/env", TEST262_BUNDLE_HASH: "ci-digest" };
    expect(test262HarnessProviderCacheDir({ root: "/arg", env })).toBe(join("/arg", "bundle-ci-digest"));
    expect(test262HarnessProviderCacheDir({ env })).toBe(join("/env", "bundle-ci-digest"));
  });

  it("the tmpdir default is also bundle-keyed", () => {
    const dir = test262HarnessProviderCacheDir({ env: { TEST262_BUNDLE_HASH: "h" } });
    expect(dir).toBe(join(tmpdir(), "js2wasm-test262-harness-cache", "bundle-h"));
  });
});

describe("#6723 P2 oracle-lane opt-in", () => {
  // The pre-#6723 gate, verbatim, as the reference the default must match.
  const legacy = (oracleMode: string | undefined, target: string | undefined) =>
    oracleMode === "fast" && target === undefined
      ? "fast-nativeharness"
      : oracleMode === "linked" && target === undefined
        ? "linked-harness"
        : "honest";

  it("with TEST262_STANDALONE_LINKED unset, every mode x target matches the old gate", () => {
    for (const oracleMode of [undefined, "", "fast", "linked", "honest"]) {
      for (const target of [undefined, "standalone", "wasi", "linear"]) {
        expect(test262OracleLane({ oracleMode, target })).toBe(legacy(oracleMode, target));
        expect(test262OracleLane({ oracleMode, target, standaloneLinked: "0" })).toBe(legacy(oracleMode, target));
      }
    }
  });

  it("the opt-in admits linked on standalone only, and only in linked mode", () => {
    const on = "1";
    expect(test262OracleLane({ oracleMode: "linked", target: "standalone", standaloneLinked: on })).toBe(
      "linked-harness",
    );
    expect(test262OracleLane({ oracleMode: undefined, target: "standalone", standaloneLinked: on })).toBe("honest");
    expect(test262OracleLane({ oracleMode: "fast", target: "standalone", standaloneLinked: on })).toBe("honest");
    expect(test262OracleLane({ oracleMode: "linked", target: "wasi", standaloneLinked: on })).toBe("honest");
    expect(test262OracleLane({ oracleMode: "linked", target: "linear", standaloneLinked: on })).toBe("honest");
    expect(test262OracleLane({ oracleMode: "linked", target: undefined, standaloneLinked: on })).toBe("linked-harness");
  });
});
