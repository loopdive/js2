// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3265 (subtask of #3182) — god-file split smoke test. The standalone Proxy
// meta-object dispatch subsystem (`ensureProxyRuntime` + `fillProxyDispatch` +
// the 12 `PROXY_CALL_*` driver-name consts) was extracted VERBATIM out of
// `src/codegen/object-runtime.ts` into the sibling module
// `src/codegen/object-runtime-proxy.ts`. The extraction is a pure relocation
// (byte-identity IDENTICAL across gc/standalone/wasi is the acceptance gate);
// this test guards that a standalone Proxy program still compiles, validates,
// instantiates host-free, and runs — i.e. that the reserve-then-fill wiring
// across the module boundary (`ensureProxyRuntime` reserves the drivers,
// `fillProxyDispatch` fills them at FINALIZE) is intact after the move.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  // Host-free instantiation: the standalone proxy runtime must not demand env.* imports.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3265 object-runtime Proxy subsystem extraction (smoke)", () => {
  it("exposes the opt-in private Proxy RTT probe without running traps", async () => {
    expect(
      await runStandalone(`function __runtime_is_proxy(_value: any): boolean { return false; }
        export function test(): number {
          let traps = 0;
          const proxy: any = new Proxy({}, {
            get() { traps++; return undefined; },
          });
          const plain: any = {};
          return __runtime_is_proxy(proxy) && !__runtime_is_proxy(plain) && traps === 0 ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("get trap fires (exercises __proxy_get_dispatch + PROXY_CALL_GET driver fill)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({}, { get(t: any, k: any, r: any) { return 42; } });
        return p.anything;
      }`),
    ).toBe(42);
  });

  it("has trap fires for the 'in' operator (exercises __proxy_has_dispatch + PROXY_CALL_HAS)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({}, { has(t: any, k: any) { return true; } });
        return ("missing" in p) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("absent trap forwards [[Get]] to the target transparently", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const target: any = { x: 7 };
        const p: any = new Proxy(target, {});
        return p.x;
      }`),
    ).toBe(7);
  });

  it("gc/host lane still compiles the same proxy program (lane untouched by the move)", async () => {
    const r = await compile(
      `export function test(): number {
        const p: any = new Proxy({}, { get(t: any, k: any, r: any) { return 42; } });
        return p.anything;
      }`,
      {},
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});
