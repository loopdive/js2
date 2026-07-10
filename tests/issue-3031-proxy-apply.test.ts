// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3031 (apply slice) — standalone Proxy `apply` trap + dynamic-apply dispatch.
//
// The 12th and last dark Proxy trap: `apply` was WIRED at `__proxy_create`
// since #1100 ($ProxyTraps field 3) but never DISPATCHED — no MOP entry point
// invoked it. Three stacked root causes on the standalone dynamic-apply path
// (`p(...)` on an `any`-typed callee, `tryEmitInlineDynamicCall`):
//
//   1. Stale captured `__box_number`/`__unbox_number` indices: captured BEFORE
//      the `__get_undefined` late-import insertion, so every dispatch arm baked
//      `call <box-1>` (= `__str_to_number`) and the module FAILED VALIDATION
//      ("call[0] expected externref, found call_ref of type f64") — for BOTH
//      handler shapes, and for arrow handlers long before #3099.
//   2. The arity-pad path leaked an `env.__get_undefined` host import into
//      standalone modules (bypassed `ensureGetUndefined`'s gate), making them
//      un-instantiable host-free even when otherwise valid.
//   3. No `$Proxy` arm existed in the dispatch at all, and the `__apply_closure`
//      bridge had no $Proxy front-guard — a proxy callee fell through every
//      closure-shape `ref.test` to the `ref.null.extern` default.
//
// The fix follows the ratified §0.1 ladder (front-guard the shared helper):
// `__proxy_apply_dispatch` (§10.5.12 [[Call]]) + a $Proxy front-guard on
// `__apply_closure` + an OUTERMOST `ref.test $Proxy` arm at the inline
// dynamic-call site, armed only when the module can contain a live $Proxy.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  // Host-free instantiation is part of the contract (root cause 2): the module
  // must not demand env.* imports for the dynamic-apply path.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3031 standalone Proxy apply trap (§10.5.12 [[Call]])", () => {
  it("apply trap fires for a METHOD-SHORTHAND handler (the 12th trap — 12/12 parity)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function target(a: any, b: any): any { return 100; }
        const p: any = new Proxy(target, { apply(t: any, thisArg: any, args: any) { return 42; } });
        return p(1, 2);
      }`),
    ).toBe(42);
  });

  it("apply trap fires for an ARROW-PROPERTY handler", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function target(a: any, b: any): any { return 100; }
        const p: any = new Proxy(target, { apply: (t: any, thisArg: any, args: any) => 42 });
        return p(1, 2);
      }`),
    ).toBe(42);
  });

  it("trap receives the argumentsList — length and indexed reads", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function target(): any { return 0; }
        const p: any = new Proxy(target, { apply(t: any, thisArg: any, args: any) { return args.length * 100 + args[0] + args[1]; } });
        return p(10, 20);
      }`),
    ).toBe(230);
  });

  it("trap receives the target as a callable first argument", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function target(a: any, b: any): any { return a * b; }
        const p: any = new Proxy(target, { apply(t: any, thisArg: any, args: any) { return t(args[0], args[1]) + 1; } });
        return p(6, 7);
      }`),
    ).toBe(43);
  });

  it("trap receives thisArgument = undefined for a bare call", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function target(): any { return 0; }
        const p: any = new Proxy(target, { apply(t: any, thisArg: any, args: any) { return thisArg === undefined ? 1 : 0; } });
        return p();
      }`),
    ).toBe(1);
  });

  it("absent apply trap forwards Call(target, thisArg, args) transparently (§10.5.12 step 6)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function target(a: any, b: any): any { return a + b; }
        const p: any = new Proxy(target, {});
        return p(40, 2);
      }`),
    ).toBe(42);
  });

  it("proxy-of-proxy unwraps one [[Call]] hop at a time", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function target(a: any): any { return a; }
        const inner: any = new Proxy(target, { apply(t: any, thisArg: any, args: any) { return args[0] + 1; } });
        const outer: any = new Proxy(inner, {});
        return outer(41);
      }`),
    ).toBe(42);
  });

  it("a proxy stored as an object member is callable as a method (the __apply_closure front-guard)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function target(a: any): any { return a * 2; }
        const p: any = new Proxy(target, { apply(t: any, thisArg: any, args: any) { return args[0] + 5; } });
        const o: any = { m: 0 };
        o.m = p;
        return o.m(10);
      }`),
    ).toBe(15);
  });

  it("bare dynamic apply of a plain closure is unchanged (no proxy arm interference)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function target(a: any, b: any): any { return 100; }
        const f: any = target;
        return f(1, 2);
      }`),
    ).toBe(100);
  });

  it("over-arity pad no longer leaks env.__get_undefined into standalone (root cause 2)", async () => {
    // A 3-formal handler called with 2 args exercises the undefined-pad path.
    const r = await compile(
      `export function test(): number {
        function target(a: any, b: any): any { return 100; }
        const p: any = new Proxy(target, { apply(t: any, thisArg: any, args: any) { return 42; } });
        return p(1, 2);
      }`,
      { target: "standalone" },
    );
    expect(r.success).toBe(true);
    const mod = new WebAssembly.Module(r.binary);
    const envImports = WebAssembly.Module.imports(mod).filter((i) => i.module === "env");
    expect(envImports.map((i) => i.name)).not.toContain("__get_undefined");
  });

  it("gc/host lane still compiles the same program (lane untouched — K1 owns host apply)", async () => {
    const r = await compile(
      `export function test(): number {
        function target(a: any, b: any): any { return 100; }
        const p: any = new Proxy(target, { apply(t: any, thisArg: any, args: any) { return 42; } });
        return p(1, 2);
      }`,
      {},
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});
