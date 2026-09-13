// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2805 — the symmetric WRITE side of #2800. A top-level `new X(objLiteral)`
// whose constructor writes `this.<field> = …` on an `any`-typed `this` dropped
// the write at MODULE-INIT in gc/host mode (the struct kept its 0/null default),
// while the identical construction at RUNTIME worked.
//
// Root cause (same as #2800, write side): a `delete`-using module
// (`ctx.moduleUsesDelete`) routes an `any`-receiver property WRITE through
// `tryEmitDeleteAwareDynamicSet` → the strict host setter `__extern_set_strict`
// → `_safeSet` → `getExports()?.__sset_<field>` (#2731). gc/host runs
// `__module_init` via the Wasm `start` section, INSIDE `WebAssembly.instantiate`,
// BEFORE the host wires the struct setters via `__setExports` — so at init
// `getExports()` is undefined and the field write is silently dropped.
//
// Fix: mirror #2800's read-side `__in_module_init` flag gate in
// `tryEmitDeleteAwareDynamicSet` — during init write the slot host-free via the
// `__set_member_<name>` dispatcher (native `struct.set`; #2664); at runtime keep
// the tombstone/order-aware host `__extern_set_strict` (#2731 preserved).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(source: string): Promise<Record<string, (...a: unknown[]) => unknown>> {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const built = buildImports(result.imports, undefined, result.stringPool) as unknown as {
    setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, built as unknown as WebAssembly.Imports);
  // Mirror production wiring: exports are wired AFTER instantiate (the start
  // section / module-init has already run by this point).
  built.setInstance?.(instance);
  return instance.exports as unknown as Record<string, (...a: unknown[]) => unknown>;
}

describe("#2805 init-time any-receiver field WRITE at module-init", () => {
  it("a top-level `new X(objLiteral)` ctor `this.<f> = conf.<f>` write lands at init (delete-using module)", async () => {
    // `delete` forces ctx.moduleUsesDelete → the ctor's `this.zz = conf.zz` and
    // `this.label = label` route through the delete-aware dynamic WRITE. `x` is
    // constructed at MODULE-INIT (top-level const), where the host struct setters
    // are not yet wired. Pre-fix the writes were dropped → x.zz === 0, x.label
    // === null. The IDENTICAL construction inside `mk()` runs at RUNTIME and
    // always worked.
    const e = await runHost(`
      function VI(label, conf) { this.label = label; this.zz = conf.zz || 0; }
      function useDelete(o: any): void { delete o.x; }
      const x: any = new VI("a", { zz: 9 });
      function mk(): any { return new VI("b", { zz: 9 }); }
      export function topLevelZz(): number { return x.zz; }
      export function topLevelLabel(): any { return x.label; }
      export function runtimeZz(): number { return mk().zz; }
      export function du(o: any): void { useDelete(o); }
    `);
    expect(e.topLevelZz()).toBe(9); // init-time write now lands (was 0)
    expect(e.topLevelLabel()).toBe("a"); // init-time string write lands (was null)
    expect(e.runtimeZz()).toBe(9); // runtime write still works
  });

  it("preserves the #2731 delete-tombstone WRITE at runtime: delete o.a; o.a = 9; for-in sees a re-added last", async () => {
    // The runtime arm must keep the tombstone/order-aware host `__extern_set_strict`
    // so a re-added key is re-inserted at for-in END, not resurrected in place.
    const e = await runHost(`
      export function test(): string {
        const o: any = { a: 1, b: 2 };
        delete o.a;
        o.a = 9;               // re-add → must land at the END of for-in order
        let s = "";
        for (const k in o) s += k;
        return s;
      }
    `);
    expect(e.test()).toBe("ba"); // b first (a was deleted then re-added last)
  });

  it("delete-free module is unaffected: init-time ctor write lands via the native fast path", async () => {
    // No `delete` → ctx.moduleUsesDelete is false → the write never routes through
    // the delete-aware path (native struct.set), which already worked at init.
    const e = await runHost(`
      function VI(label, conf) { this.label = label; this.zz = conf.zz || 0; }
      const x: any = new VI("a", { zz: 7 });
      export function topLevelZz(): number { return x.zz; }
    `);
    expect(e.topLevelZz()).toBe(7);
  });
});
