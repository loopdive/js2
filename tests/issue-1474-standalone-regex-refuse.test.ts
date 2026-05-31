// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1474 Phase 1 — refuse-and-document.
 *
 * RegExp delegates entirely to the JS host engine; there is no Wasm-native
 * regex engine yet. In `--target standalone` (pure WasmGC, no JS host), any
 * regex literal, `new RegExp(...)` / `RegExp(...)` call, or host-routed string
 * method that builds/consumes a RegExp must fail at compile time with a clear
 * `#1474` message and a source location — rather than emitting an
 * `env::RegExp_new` import that fails at `wasmtime instantiate`.
 *
 * Phase 2 (a pure-Wasm NFA engine) is a separate follow-up issue.
 */

async function expectRefused(src: string): Promise<ReturnType<typeof compile>> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, `expected compile failure, got success for:\n${src}`).toBe(false);
  expect(r.errors.length).toBeGreaterThan(0);
  expect(r.errors.some((e) => /#1474/.test(e.message))).toBe(true);
  // Source location must be reported (line > 0).
  const refusal = r.errors.find((e) => /#1474/.test(e.message))!;
  expect(refusal.line).toBeGreaterThan(0);
  return r;
}

describe("#1474 --target standalone refuses RegExp", () => {
  it("rejects a regex literal", async () => {
    await expectRefused(`export function f(s: string): boolean { return /\\d+/.test(s); }`);
  });

  it("rejects a flagged regex literal", async () => {
    await expectRefused(`export function f(s: string): string { return s.replace(/a/g, "b"); }`);
  });

  it("rejects new RegExp(...)", async () => {
    await expectRefused(`export function f(p: string): boolean { return new RegExp(p, "g").test("x"); }`);
  });

  it("rejects RegExp(...) called without new", async () => {
    await expectRefused(`export function f(p: string): boolean { const r = RegExp(p); return r.test("x"); }`);
  });

  it("rejects s.match(regexLiteral)", async () => {
    await expectRefused(`export function f(s: string): boolean { return s.match(/\\d+/) !== null; }`);
  });

  it("rejects s.matchAll(regexLiteral)", async () => {
    await expectRefused(`export function f(s: string): number { return [...s.matchAll(/\\d/g)].length; }`);
  });

  it("rejects s.search(regexLiteral)", async () => {
    await expectRefused(`export function f(s: string): number { return s.search(/\\d/); }`);
  });

  it("rejects s.split(regexArg)", async () => {
    await expectRefused(`export function f(s: string): number { const r = /,/; return s.split(r).length; }`);
  });

  it("rejects s.replace(regexArg, ...)", async () => {
    await expectRefused(`export function f(s: string): string { const r = /a/g; return s.replace(r, "b"); }`);
  });

  it("emits no env::RegExp_new import when refused", async () => {
    const r = await compile(`export function f(s: string): boolean { return /\\d+/.test(s); }`, {
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
