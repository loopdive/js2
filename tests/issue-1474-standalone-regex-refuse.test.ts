// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1474 Phase 1 — refuse-and-document.
 *
 * RegExp used to delegate entirely to the JS host engine. In `--target
 * standalone` (pure WasmGC, no JS host), forms outside #682's reduced native
 * literal-substring subset must still fail at compile time with a clear `#1474`
 * message and a source location — rather than emitting an `env::RegExp_new`
 * import that fails at `wasmtime instantiate`.
 *
 * Phase 2 (a pure-Wasm NFA engine) is a separate follow-up issue.
 */

async function expectRefused(src: string): Promise<ReturnType<typeof compile>> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, `expected compile failure, got success for:\n${src}`).toBe(false);
  expect(r.errors.length).toBeGreaterThan(0);
  // #1539 narrowed the standalone-RegExp refusals; the residual ones cite
  // either #1474 (String-method gate) or #1539 (engine subset).
  const cite = /#1474|#1539/;
  expect(r.errors.some((e) => cite.test(e.message))).toBe(true);
  // Source location must be reported (line > 0).
  const refusal = r.errors.find((e) => cite.test(e.message))!;
  expect(refusal.line).toBeGreaterThan(0);
  return r;
}

// #1539 Phase 2a narrowed these refusals: a static-pattern `RegExp.prototype.
// test` now compiles to the pure-WasmGC backtracking VM (see
// tests/issue-1539-standalone-regex.test.ts). The cases below are the residual
// forms that are STILL refused — dynamic patterns, capture-materializing
// String.prototype regex methods, and out-of-subset pattern features.
describe("#1474/#1539 --target standalone still refuses (narrowed)", () => {
  it("rejects new RegExp(dynamicPattern, ...)", async () => {
    await expectRefused(`export function f(p: string): boolean { return new RegExp(p, "g").test("x"); }`);
  });

  it("rejects RegExp(dynamicPattern) called without new", async () => {
    await expectRefused(`export function f(p: string): boolean { const r = RegExp(p); return r.test("x"); }`);
  });

  it("compiles non-global s.match(regexLiteral) — capture-array Phase 2b slice", async () => {
    const r = await compile(`export function f(s: string): boolean { return s.match(/\\d+/) !== null; }`, {
      target: "standalone",
    });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  });

  // #1913 landed global String.match (§22.2.6.8 step 6) on the pure-WasmGC
  // matcher — it now compiles instead of refusing. (Equivalence vs native
  // global match lives in tests/issue-1913.test.ts.)
  it("compiles global s.match(regexLiteral) — all-match semantics (#1913)", async () => {
    const r = await compile(
      `export function f(s: string): number { const m = s.match(/\\d+/g); return m === null ? -1 : m.length; }`,
      { target: "standalone" },
    );
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  });

  // #2161 landed global String.matchAll(/re/g) on the pure-WasmGC matcher as an
  // iterable vec of capture-arrays — the for-of form now compiles instead of
  // refusing. (Behavior coverage lives in tests/issue-2161-matchall.test.ts.)
  it("compiles global s.matchAll(/re/g) for-of — iterable of capture arrays (#2161)", async () => {
    const r = await compile(
      `export function f(s: string): number { let n = 0; for (const m of s.matchAll(/\\d/g)) n++; return n; }`,
      { target: "standalone" },
    );
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  });

  it("rejects non-global s.matchAll(/re/) — runtime TypeError per §22.1.3.13 (#2161 narrowed)", async () => {
    await expectRefused(
      `export function f(s: string): number { let n = 0; for (const m of s.matchAll(/\\d/)) n++; return n; }`,
    );
  });

  // #1539 Phase 2b landed `String.prototype.search(/re/)` on the pure-WasmGC
  // matcher — it now compiles instead of refusing. (Equivalence vs native
  // `search` lives in tests/issue-1539-standalone-regex.test.ts.)
  it("compiles s.search(regexLiteral) — String method (Phase 2b)", async () => {
    const r = await compile(`export function f(s: string): number { return s.search(/\\d/); }`, {
      target: "standalone",
    });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  });

  it("compiles s.split(regexArg) — non-capturing Phase 2c slice", async () => {
    const r = await compile(`export function f(s: string): number { const r = /,/; return s.split(r).length; }`, {
      target: "standalone",
    });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  });

  it("compiles s.replace(regexArg, literal) — Phase 2c slice", async () => {
    const r = await compile(`export function f(s: string): string { const r = /a/g; return s.replace(r, "b"); }`, {
      target: "standalone",
    });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  });

  it("emits no env::RegExp_new import when refused", async () => {
    const r = await compile(`export function f(p: string): boolean { return new RegExp(p, "g").test("x"); }`, {
      target: "standalone",
    });
    expect(r.success).toBe(false);
    const labels = r.imports.map((i) => `${i.module}::${i.name}`);
    expect(labels.some((l) => /RegExp_new/.test(l))).toBe(false);
  });
});

describe("#1474 default (JS-host) mode unchanged", () => {
  it("compiles a regex literal in default mode", async () => {
    const r = await compile(`export function f(s: string): boolean { return /\\d+/.test(s); }`, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });

  it("compiles s.replace(regex, ...) in default mode", async () => {
    const r = await compile(`export function f(s: string): string { return s.replace(/a/g, "b"); }`, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });

  it("compiles new RegExp(...) in default mode", async () => {
    const r = await compile(`export function f(p: string): boolean { return new RegExp(p, "g").test("x"); }`, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });

  it("standalone string methods without regex still compile", async () => {
    const r = await compile(`export function f(s: string): string { return s.replace("a", "b").split(",")[0]!; }`, {
      target: "standalone",
    });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
