// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6693 — a method called by name on a receiver whose type is unknown at
// compile time, with FEWER or MORE arguments than it declares, under
// `--target standalone`.
//
// The by-name dispatcher `__call_m_<name>_<argc>` admitted a method as an arm
// only when the call's argument count covered every formal lacking a `?`/
// constant-default marker, and never when the call over-applied. Otherwise it
// fell to the open-`$Object` fallback and threw `called value is not a
// function` — marked's `this.parser.parseInline(e)` against
// `parseInline(e, t = this.renderer)`. Every case below answered -1 on the
// parent tree (measured by file-copy revert of closed-method-dispatch.ts and
// zero-arg-method-pad.ts); Node answers 1 for all of them.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    hostBridge: "off",
    fileName: "/p.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
  } as Parameters<typeof compile>[1]);
  if (!result.success) throw new Error(`compile failed: ${result.errors?.[0]?.message}`);
  const module = await WebAssembly.compile(result.binary as Uint8Array);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { test: () => number }).test();
}

const wrap = (body: string, expr: string) =>
  `${body}\nexport function test() { try { return (${expr}) ? 1 : 0; } catch (e) { return -1; } }`;

describe("#6693 — standalone by-name method dispatch follows JS call arity", () => {
  it("under-applies a method whose omitted formal has no default (issue repro)", async () => {
    const src = wrap(
      `var R = class { p; go(e) { return this.p.inl(e); } };
       var P = class { r; constructor() { this.r = new R(); this.r.p = this; } inl(e, t) { return "n" + e.length; } };`,
      `new P().r.go([1, 2]) === "n2"`,
    );
    await expect(runStandalone(src)).resolves.toBe(1);
  });

  it("runs an expression default on a class-typed formal (marked's parseInline shape)", async () => {
    const src = wrap(
      `var R = class { p; go(e) { return this.p.inl(e); } };
       var Q = class { x = 5; };
       var P = class { r; q; constructor() { this.q = new Q(); this.r = new R(); this.r.p = this; }
         inl(e, t = this.q) { return "n" + e.length + t.x; } };`,
      `new P().r.go([1, 2]) === "n25"`,
    );
    await expect(runStandalone(src)).resolves.toBe(1);
  });

  it("omitted formals read `undefined`, including a numeric one", async () => {
    const src = wrap(
      `var S = class { p; go(e) { return this.p.m(e); } };
       var T = class { s; constructor() { this.s = new S(); this.s.p = this; }
         m(e, n, u) { return "" + e + (n === undefined) + (u === undefined); } };
       var W = class { p; go(e) { return this.p.k(e); } };
       var X = class { s; constructor() { this.s = new W(); this.s.p = this; }
         k(e, n) { return n === undefined ? e + 1 : e + n; } };`,
      `new T().s.go(7) === "7truetrue" && new X().s.go(7) === 8`,
    );
    await expect(runStandalone(src)).resolves.toBe(1);
  });

  it("over-applies: extra arguments are evaluated and dropped", async () => {
    const src = wrap(
      `var log = "";
       function mark(x) { log += x; return x; }
       var U = class { p; go(e) { return this.p.m3(e, mark(1), mark(2)); } };
       var V = class { s; constructor() { this.s = new U(); this.s.p = this; } m3(e) { return "" + e; } };`,
      `new V().s.go(7) === "7" && log === "12"`,
    );
    await expect(runStandalone(src)).resolves.toBe(1);
  });

  it("object-literal methods through an untyped parameter", async () => {
    const src = wrap(
      `const o = { m4(a, b) { return "" + a + (b === undefined); }, m5(a, b = "d") { return "" + a + b; } };
       const f = (x) => x.m4(1) + x.m5(2);`,
      `f(o) === "1true2d"`,
    );
    await expect(runStandalone(src)).resolves.toBe(1);
  });
});
