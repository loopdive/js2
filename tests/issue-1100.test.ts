// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1100 — Wasm-native Proxy meta-object protocol, standalone Phase 1.
//
// In `--target standalone` there is no host `Proxy`; `new Proxy(target, handler)`
// previously hard-errored ("Proxy not supported in standalone mode"). Phase 1
// lands a pure-Wasm meta-object protocol for the four highest-impact traps —
// `get`, `set`, `has` — plus the §28.2.1.1 non-object construction throw. The
// trap closures are read off an OPEN-object handler at construction
// (`__proxy_create`) and invoked through the existing closure-call bridge
// (`__apply_closure`) with the handler bound as `this` (§10.5.x). A `$Proxy` is a
// standalone WasmGC struct discriminated by `ref.test $Proxy` front-guards
// prepended to `__extern_get`/`__extern_set`/`__extern_has`; a missing trap
// forwards to the ordinary operation on the target.
//
// Spec: ECMA-262 §28.2.1.1 (ProxyCreate), §10.5.8/9/7 ([[Get]]/[[Set]]/[[Has]]).
//
// NOTE: these programs bind the proxy to a `const p: any` local so member access
// lowers to the dynamic `__extern_get`/`__extern_set`/`__extern_has` boundary
// (the path test262's untyped JS always takes). A statically-typed proxy local
// would lower to a closed struct.get against the target's inferred shape, which
// bypasses the proxy meta-object — out of scope for Phase 1.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#1100 standalone Proxy Phase 1 — get trap", () => {
  it("get trap intercepts a property read (returns trap result, not target)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({ x: 5 }, { get: (t: any, k: any) => 42 });
        return p.x;
      }`),
    ).toBe(42);
  });

  it("get trap receives the target and can read through it", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({ x: 7 }, { get: (t: any, k: any) => t.x });
        return p.anyKey;
      }`),
    ).toBe(7);
  });

  it("absent get trap forwards to the target", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({ x: 7 }, {});
        return p.x;
      }`),
    ).toBe(7);
  });
});

describe("#1100 standalone Proxy Phase 1 — set trap", () => {
  it("set trap intercepts a property write", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let captured = 0;
        const p: any = new Proxy({ x: 1 }, { set: (t: any, k: any, v: any) => { captured = v; return true; } });
        p.x = 77;
        return captured;
      }`),
    ).toBe(77);
  });

  it("absent set trap forwards the write to the target", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({ x: 1 }, {});
        p.x = 9;
        return p.x;
      }`),
    ).toBe(9);
  });
});

describe("#1100 standalone Proxy Phase 1 — has trap", () => {
  it("has trap intercepts the `in` operator", async () => {
    expect(
      await runStandalone(`export function test(): boolean {
        const p: any = new Proxy({}, { has: (t: any, k: any) => true });
        return "anyKey" in p;
      }`),
    ).toBe(1);
  });

  it("absent has trap forwards to the target", async () => {
    expect(
      await runStandalone(`export function test(): boolean {
        const p: any = new Proxy({ x: 1 }, {});
        return "x" in p;
      }`),
    ).toBe(1);
  });
});

describe("#1100 standalone Proxy Phase 1 — construction", () => {
  it("a standalone `new Proxy` compiles and validates (no hard error)", async () => {
    // Previously emitted "Codegen error: Proxy not supported in standalone mode".
    const r = await compile(`export function test(): number { const p: any = new Proxy({ x: 1 }, {}); return p.x; }`, {
      target: "standalone",
    });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  it("new Proxy with a null target throws a catchable TypeError (§28.2.1.1)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        try {
          const t: any = null;
          const p: any = new Proxy(t, {});
          return -1;
        } catch (e: any) {
          return 7;
        }
      }`),
    ).toBe(7);
  });
});
