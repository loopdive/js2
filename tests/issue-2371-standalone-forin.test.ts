// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2371 — standalone for-in must not leak `env::__for_in_*` host imports.
 *
 * `for (const k in obj)` in `--target standalone` previously registered four
 * unsatisfiable JS-host imports (`__for_in_keys/_len/_get/_has`), so the module
 * failed to instantiate against an empty host. The host-import finalizer
 * (`declarations.ts`) lacked the `!ctx.standalone && !ctx.wasi` guard its
 * sibling iterator finalizers carry.
 *
 * Slice 1 (this fix): gate the imports off in standalone, and refuse for-in with
 * a clear compile-time diagnostic instead of a naive static-property unroll —
 * a correct native for-in needs runtime key enumeration AND dynamic
 * property-read-by-runtime-key (tracked as the #2371 follow-up). Refusing is
 * strictly better than the prior un-instantiable module and does not regress any
 * test262 standalone pass count.
 *
 * Host mode is unaffected: the `__for_in_*` imports are still registered and the
 * JS-host enumeration path is unchanged.
 */

const FORIN_IMPORT_RE = /^env::__for_in_(keys|len|get|has)$/;

async function standaloneImports(src: string): Promise<{ success: boolean; ce?: string; forInLeaks: string[] }> {
  const r = await compile(src, { target: "standalone", nativeStrings: true });
  if (!r.success) {
    return { success: false, ce: r.errors.map((e) => e.message).join("\n"), forInLeaks: [] };
  }
  const leaks = r.imports.map((i) => `${i.module}::${i.name}`).filter((l) => FORIN_IMPORT_RE.test(l));
  return { success: true, forInLeaks: leaks };
}

describe("#2371 — standalone for-in does not leak __for_in_* host imports", () => {
  it("object-literal for-in: no host import (refused with a CE, not a leak)", async () => {
    const r = await standaloneImports(
      `export function test(): number { const o = { a: 1, b: 2, c: 3 }; let n = 0; for (const k in o) n++; return n; }`,
    );
    expect(r.success).toBe(false);
    expect(r.ce).toMatch(/for-in is not yet supported in standalone/);
    expect(r.forInLeaks).toEqual([]);
  });

  it("array for-in: no host import (refused with a CE, not a leak)", async () => {
    const r = await standaloneImports(
      `export function test(): number { const a = [10, 20, 30]; let n = 0; for (const k in a) n++; return n; }`,
    );
    expect(r.success).toBe(false);
    expect(r.ce).toMatch(/for-in is not yet supported in standalone/);
    expect(r.forInLeaks).toEqual([]);
  });

  it("any-typed for-in: no host import (refused with a CE, not a leak)", async () => {
    const r = await standaloneImports(
      `export function test(): number { const o: any = { a: 1, b: 2 }; let n = 0; for (const k in o) n++; return n; }`,
    );
    expect(r.success).toBe(false);
    expect(r.ce).toMatch(/for-in is not yet supported in standalone/);
    expect(r.forInLeaks).toEqual([]);
  });

  it("class-instance for-in: no host import (refused with a CE, not a leak)", async () => {
    const r = await standaloneImports(
      `class C { x = 1; y = 2; } export function test(): number { const c = new C(); let n = 0; for (const k in c) n++; return n; }`,
    );
    expect(r.success).toBe(false);
    expect(r.ce).toMatch(/for-in is not yet supported in standalone/);
    expect(r.forInLeaks).toEqual([]);
  });

  it("a program WITHOUT for-in compiles clean in standalone (no spurious import / CE)", async () => {
    const r = await standaloneImports(`export function test(): number { const o = { a: 5, b: 7 }; return o.a + o.b; }`);
    expect(r.success, r.ce).toBe(true);
    expect(r.forInLeaks).toEqual([]);
  });
});

describe("#2371 — host mode for-in is unchanged", () => {
  it("host mode still registers the __for_in_* imports and compiles", async () => {
    const r = await compile(
      `export function test(): number { const o: any = { a: 1, b: 2 }; let n = 0; for (const k in o) n++; return n; }`,
      {},
    );
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
    const forIn = r.imports.map((i) => `${i.module}::${i.name}`).filter((l) => FORIN_IMPORT_RE.test(l));
    // All four host enumeration imports remain in host mode.
    expect(forIn.sort()).toEqual(["env::__for_in_get", "env::__for_in_has", "env::__for_in_keys", "env::__for_in_len"]);
  });
});
