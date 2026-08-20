// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2980 conservative Promise-lane fallback, as refined by #3132 PR-2
 * (rewritten by #3558 — the original assertions guarded superseded behavior
 * and sat red for 10 days, invisible to per-PR CI).
 *
 * History of the gate this file guards
 * (`widenAsyncGenFallback` in src/codegen/async-scheduler.ts):
 *  - #2980 (2026-07-09, `b66d7e2`): ANY async generator in the module kept
 *    BOTH standalone carrier gates OFF (`moduleHasAsyncGen`) so a native
 *    `$Promise` never fed the legacy `__gen_*` host buffer (the 07-09
 *    async-generator −4). Measured via the `JS2WASM_ASYNC_CARRIER_WIDEN` env
 *    toggle, which this file originally set.
 *  - 2026-07-10: the widen FLIPPED to production (`2a2aa49`/PR #2867) and the
 *    env toggle was RETIRED — the on-arm is now the default standalone
 *    behavior, so setting the env is a no-op.
 *  - #3132 PR-2 (2026-07-13, `90ba2a8`/PR #3013): the blanket fallback was
 *    refined to `moduleHasNonDrivableAsyncGen` — a module whose async gens are
 *    ALL drivable under the carrier keeps the carrier ON (native `$Promise`,
 *    NO host imports: the host-free floor). Only a module with at least one
 *    NON-drivable gen (method exclusions / rest param / unbounded body /
 *    unsafe spill / stem collision) still falls back to the host lane, because
 *    only there a legacy `__gen_*` buffer exists to mix into.
 *
 * So the CURRENT invariants, asserted from the binary's import section:
 *  1. all-drivable async-gen module → native carrier, ZERO imports;
 *  2. non-drivable async-gen module → the generator host lane fires
 *     (legacy `__gen_*` imports present), while standalone exception handling
 *     remains native (`__get_caught_exception` absent; #2997);
 *  3. non-async-gen module → native carrier, no host Promise imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function standaloneBinaryImports(src: string): Promise<string[]> {
  const r = await compile(src, { fileName: "t.ts", target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  return WebAssembly.Module.imports(new WebAssembly.Module(r.binary)).map((i) => `${i.module}.${i.name}`);
}

describe("#2980/#3132 Promise-lane carrier gates (standalone, post-widen)", () => {
  it("all-drivable async-gen module: Promise.reject stays NATIVE (#3132 PR-2 — no host imports at all)", async () => {
    const imports = await standaloneBinaryImports(`
      export async function* g() { yield Promise.reject(new Error("x")); }
    `);
    // The whole point of the #3132 PR-2 refinement: an all-drivable module
    // keeps the carrier ON and loses every env.* import (host-free floor).
    expect(imports).toEqual([]);
  });

  it("all-drivable async-gen module: a Promise.resolve elsewhere ALSO stays native", async () => {
    const imports = await standaloneBinaryImports(`
      async function* g(): AsyncGenerator<number> { yield 1; }
      export async function f(): Promise<number> {
        const p = await Promise.resolve(7);
        for await (const x of g()) { /* drive */ void x; }
        return p;
      }
    `);
    expect(imports).toEqual([]);
  });

  it("NON-drivable async-gen module (stem collision): the #2980 host fallback still fires", async () => {
    // Two object-literal async-gen methods share the stem `g` → the second is
    // non-drivable (stem collision) → `moduleHasNonDrivableAsyncGen` → both
    // carrier gates OFF → the gens run on the legacy `__gen_*` HOST buffer.
    // This is the still-live #2980 lane: the module must be host-consistent
    // (legacy buffer imports present), never a native $Promise mixed into it.
    const imports = await standaloneBinaryImports(`
      const o1 = { async *g(): AsyncGenerator<number> { yield 1; } };
      const o2 = { async *g(): AsyncGenerator<number> { yield 2; } };
      export async function f(): Promise<number> {
        const p = await Promise.resolve(7);
        for await (const x of o1.g()) { void x; }
        for await (const x of o2.g()) { void x; }
        return p;
      }
    `);
    expect(imports).toContain("env.__gen_next");
    // #2997 moves standalone exception handling to standardized Wasm EH even
    // when an unrelated generator shape still requires the legacy host buffer.
    expect(imports).not.toContain("env.__get_caught_exception");
  });

  it("NON-async-gen module: Promise.reject stays NATIVE (widen wins, unchanged since #2980)", async () => {
    const imports = await standaloneBinaryImports(`
      export async function f(): Promise<number> {
        try { await Promise.reject(new Error("x")); return 0; } catch (e) { return 1; }
      }
    `);
    expect(imports).not.toContain("env.Promise_reject");
    expect(imports).not.toContain("env.Promise_resolve");
  });

  it("the 5 A/B async-gen regressions compile host-consistently (spot-check one)", async () => {
    // named-yield-promise-reject-next shape: rejecting yield + close, .next().then().
    const r = await compile(
      `
      let error = 1;
      let callCount = 0;
      var gen = async function* g() { callCount += 1; yield Promise.reject(error); yield 2; };
      export function test(): number { const it: any = gen(); void it; return callCount; }
    `,
      { fileName: "t.ts", target: "standalone", nativeStrings: true },
    );
    expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
  });
});
