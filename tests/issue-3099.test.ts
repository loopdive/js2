// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3099 — any-context object-literal METHOD-SHORTHAND props must materialize as
// runtime own properties on `$Object`.
//
// An object literal compiled on the any-context `$Object` route
// (`compileObjectLiteralAsExternref`) previously stored `PropertyAssignment`
// props (including arrow-function values) as runtime own properties via
// `__extern_set` but SKIPPED `MethodDeclaration` (method shorthand). So a
// standalone Proxy handler written in test262's dominant method-shorthand style
// (`{ get(t, k) { … } }`) had its trap read (`__extern_get(handler, "get")`)
// MISS at runtime, and every dispatch silently forwarded to the target — while
// the arrow-property form (`{ get: (t, k) => … }`) worked. This dark spot capped
// the entire 12-trap standalone Proxy substrate for the common handler shape, and
// also hid shorthand `h[k]` reads / `Object.keys` enumeration of method-bearing
// any-context literals.
//
// Fix: a MethodDeclaration arm in `compileObjectLiteralAsExternref` materializes
// the method as a runtime own-property closure (mirroring the sibling arm in
// `compileObjectLiteralWithAccessors`), and the standalone any-context routing
// gate now diverts plain-named-method-bearing literals to that $Object route.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3099 method-shorthand props materialize as runtime own properties (standalone)", () => {
  it("Proxy get trap fires for a method-shorthand handler", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({ a: 1 }, { get(t: any, k: any) { return 42; } });
        return p.a;
      }`),
    ).toBe(42);
  });

  it("Proxy has trap fires for a method-shorthand handler", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({}, { has(t: any, k: any) { return true; } });
        return ("z" in p) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Proxy set trap fires for a method-shorthand handler", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let stored = 0;
        const p: any = new Proxy({}, { set(t: any, k: any, v: any) { stored = v; return true; } });
        p.x = 99;
        return stored;
      }`),
    ).toBe(99);
  });

  it("Proxy deleteProperty trap fires for a method-shorthand handler", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let hit = 0;
        const p: any = new Proxy({ a: 1 }, { deleteProperty(t: any, k: any) { hit = 1; return true; } });
        delete p.a;
        return hit;
      }`),
    ).toBe(1);
  });

  it("arrow-property handler still fires (control — unchanged)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({ a: 1 }, { get: (t: any, k: any) => 42 });
        return p.a;
      }`),
    ).toBe(42);
  });

  it("shorthand method is a runtime own property — read via computed key", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const h: any = { m() { return 3; } };
        const k: any = "m";
        const f: any = h[k];
        return typeof f === "function" ? f() : -1;
      }`),
    ).toBe(3);
  });

  it("shorthand method is enumerated by Object.keys", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const h: any = { m() { return 3; } };
        return Object.keys(h).length;
      }`),
    ).toBe(1);
  });

  it("static method access (h.m()) still works after routing to $Object", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const h: any = { m() { return 7; } };
        return h.m();
      }`),
    ).toBe(7);
  });

  it("shorthand method reads `this` correctly", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const h: any = { v: 5, get2() { return this.v + 1; } };
        return h.get2();
      }`),
    ).toBe(6);
  });

  it("mixed data + shorthand method any-context literal — data reads intact", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const h: any = { a: 10, m() { return 20; }, b: 30 };
        const k1: any = "a"; const k3: any = "b";
        return h[k1] + h[k3];
      }`),
    ).toBe(40);
  });

  it("shorthand next() iterator drives a manual iteration loop", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const iter: any = { i: 0, next() { this.i++; return { value: this.i, done: this.i > 3 }; } };
        let sum = 0;
        let r: any = iter.next();
        while (!r.done) { sum += r.value; r = iter.next(); }
        return sum;
      }`),
    ).toBe(6);
  });
});

describe("#3099 host lane still compiles a method-shorthand handler", () => {
  it("a method-shorthand Proxy handler compiles and validates in host mode", async () => {
    const r = await compile(
      `export function test(): number {
        const p: any = new Proxy({ a: 1 }, { get(t: any, k: any) { return 42; } });
        return p.a;
      }`,
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});
