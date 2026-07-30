// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { foldGroundCallsInMultiFiles } from "../src/compiler/ground-call-fold.js";
import { compileMulti } from "../src/index.js";
// @ts-expect-error — dogfood setup is intentionally plain ESM.
import { setupCookie } from "./dogfood/setup-cookie.mjs";

const HEADER = "a=1; b=2; c=3; d=4; e=5; f=6; g=7; h=8";
const BENCHMARK_EXPORT = "__npmCompatStandaloneBenchmark";

function cookieSource(): string {
  return readFileSync(setupCookie().entryModulePath, "utf8");
}

function driver(header = HEADER): string {
  return `
import { parseCookie } from "./cookie.js";

function cookieOperation() {
  var parsed = parseCookie(${JSON.stringify(header)});
  return parsed.a === "1" && parsed.h === "8" ? 1 : 0;
}

/** @param {number} iterations */
export function ${BENCHMARK_EXPORT}(iterations) {
  var checksum = 0;
  for (var index = 0; index < iterations; index++) {
    checksum += cookieOperation();
  }
  return checksum;
}`;
}

describe("#3779 cookie standalone ground folding", () => {
  it("proves the real pinned cookie observation and removes the dead module", () => {
    const source = cookieSource();
    const result = foldGroundCallsInMultiFiles({ "cookie.js": source, "benchmark.mjs": driver() }, "benchmark.mjs");

    expect(result.folded).toBe(1);
    expect(result.files["benchmark.mjs"]).toHaveLength(driver().length);
    expect(result.files["cookie.js"]).toHaveLength(source.length);
    expect(result.files["benchmark.mjs"]).not.toContain("parseCookie");
    expect(result.files["benchmark.mjs"]).toContain("checksum += 1");
    expect(result.files["cookie.js"]?.trim()).toBe("");
  });

  it("keeps the scalar batch on IR in a host-free standalone binary", async () => {
    const result = await compileMulti({ "cookie.js": cookieSource(), "benchmark.mjs": driver() }, "benchmark.mjs", {
      allowJs: true,
      skipSemanticDiagnostics: true,
      optimize: 4,
      target: "standalone",
    });

    expect(result.success).toBe(true);
    expect(result.binary?.length).toBeGreaterThan(0);
    expect(result.irCompiledFuncs).toContain(BENCHMARK_EXPORT);
    const module = await WebAssembly.compile(result.binary!);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    const batch = instance.exports[BENCHMARK_EXPORT] as (iterations: number) => number;
    expect(batch(0)).toBe(0);
    expect(batch(10)).toBe(10);
  });

  it("does not fold the unsupported URI-decoder path", () => {
    const result = foldGroundCallsInMultiFiles(
      { "cookie.js": cookieSource(), "benchmark.mjs": driver("a=%31; h=8") },
      "benchmark.mjs",
    );
    expect(result.folded).toBe(0);
  });
});
