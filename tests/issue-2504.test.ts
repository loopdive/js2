// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2504 regression guard — `console.log(<string>)` under `--target standalone`
// must compile to VALID, host-free Wasm.
//
// The bug: `ensureNativeStringExternBridge`'s `__str_to_extern` body baked a
// stale (import-shift-desynced) funcIdx for `__str_from_mem`, so any native
// string passed to a host-externref SINK (console.log) produced an invalid
// module ("not enough arguments on the stack for call (need 3, got 2)"). Cured
// by the late-import-shift reconcile lineage (#1677/#1903/#2039). This guard
// pins the fix so it can't silently regress.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function validStandalone(src: string): Promise<void> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  expect(r.imports ?? [], "console.log(string) must stay host-free in standalone").toEqual([]);
  // instantiates without a host import object
  await WebAssembly.instantiate(r.binary, {});
}

describe("#2504 — console.log(string) emits valid host-free Wasm in standalone", () => {
  it('console.log("hi")', async () => {
    await validStandalone(`console.log("hi");`);
  });

  it("console.log(string variable)", async () => {
    await validStandalone(`const s = "hi"; console.log(s);`);
  });

  it("console.log(array.join(...)) — the original array.join carrier", async () => {
    await validStandalone(`const a = [3, 1, 2]; console.log(a.join(","));`);
  });

  it("console.log(string) inside an exported function", async () => {
    await validStandalone(`export function f(): void { const a = [3, 1, 2]; console.log(a.join(",")); }`);
  });

  it("console.log(number) still valid", async () => {
    await validStandalone(`console.log(42);`);
  });
});
