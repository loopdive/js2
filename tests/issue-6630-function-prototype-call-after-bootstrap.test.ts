// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6630 — an ordinary closure's `.call`/`.apply`/`.bind` must keep working
// after ANYTHING materializes `%Function.prototype%` earlier in the same
// module (a direct `Function.prototype` read, or a transitive trigger like
// `Object.getPrototypeOf` on an `any`-typed iterator).
//
// Root cause (see plan/issues/6630-*.md "S43 findings" / "S44 findings"):
// once `%Function.prototype%` exists as a real `$Object` and is wired as a
// closure's `[[Prototype]]`, a GENERIC own-property read of `call`/`apply`/
// `bind` off that closure legitimately walks the chain and finds the
// companion's seeded own-property — which, before this fix, was always the
// #2984 Phase-2 refusal closure (`makeGlue`'s `Function` arm wired no real
// body for these three members). Every "own-property miss ⇒ take the
// closure-specific fast path" guard in `closure-call-fast.ts` /
// `closure-props.ts` then sees a HIT and defers to that refusal instead.
//
// This file pins the fix (real, receiver-polymorphic bodies in
// function-proto-invokers.ts) with the minimal repro plus two other trigger
// shapes, alongside a same-calls-no-bootstrap CONTROL that must already
// pass on the pre-fix tree too (proving the fix didn't change the untouched
// case) and a Function.prototype.toString/hasInstance CONTROL (proving the
// makeGlue ladder ordering wasn't disturbed).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<{ value: number; hostImports: string[] }> {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    deferTopLevelInit: true,
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const module = await WebAssembly.compile(result.binary);
  const hostImports = WebAssembly.Module.imports(module).map((i) => `${i.module}::${i.name}`);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  const tag = exports.__exn_tag as WebAssembly.Tag | undefined;
  try {
    const value = (exports.test as () => number)();
    return { value, hostImports };
  } catch (e) {
    if (e instanceof WebAssembly.Exception && tag) {
      let payload: unknown;
      try {
        payload = e.getArg(tag, 0);
      } catch {
        payload = "<undecodable>";
      }
      throw new Error(`uncaught wasm exception: ${String((payload as { message?: unknown })?.message ?? payload)}`);
    }
    throw e;
  }
}

describe("#6630 — closure .call/.apply/.bind survive %Function.prototype% materialization", () => {
  it("g.call(o) after a direct Function.prototype read (the minimal repro)", async () => {
    const { value, hostImports } = await runStandalone(
      `var fp = Function.prototype;
       function g(this: any) { return this; }
       var o: any = {};
       export function test(): number { return (g as any).call(o) === o ? 1 : 0; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(1);
  });

  it("g.apply(obj, [1]) after a direct Function.prototype read", async () => {
    const { value, hostImports } = await runStandalone(
      `var fp = Function.prototype;
       function g(this: any, a: any) { return this === obj && a === 1 ? 1 : 0; }
       var obj: any = {};
       export function test(): number { return (g as any).apply(obj, [1]); }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(1);
  });

  it("g.bind(obj)() after a direct Function.prototype read", async () => {
    // `.bind` is read as a VALUE first (`var b = (g as any).bind`, not a
    // `g.bind(...)` call-site literal, which a syntactic `compileFunctionBind`
    // provider — a SEPARATE mechanism from the native-proto glue this fix
    // touches — could intercept before ever reaching it) so this genuinely
    // exercises the same member-value-read path the `.call`/`.apply`
    // witnesses above do. Invoked via `.call(g, obj)` to preserve the
    // receiver a bare `b(obj)` would lose (§20.2.3.2 step 2 would throw
    // "Bind method called on incompatible target" for an unbound `this`,
    // which is not what this witness is testing).
    const { value, hostImports } = await runStandalone(
      `var fp = Function.prototype;
       function g(this: any) { return this === obj ? 1 : 0; }
       var obj: any = {};
       var b: any = (g as any).bind;
       var bound: any = (b as any).call(g, obj);
       export function test(): number { return bound(); }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(1);
  });

  it("g.call(o) after an Object.getPrototypeOf(<any-typed iterator>) trigger", async () => {
    const { value, hostImports } = await runStandalone(
      `var iter: any = [1, 2, 3].values();
       var p = Object.getPrototypeOf(iter);
       function g(this: any) { return this; }
       var o: any = {};
       export function test(): number { return p !== null && (g as any).call(o) === o ? 1 : 0; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(1);
  });

  it("CONTROL: g.call(o) with no bootstrap trigger at all", async () => {
    const { value, hostImports } = await runStandalone(
      `function g(this: any) { return this; }
       var o: any = {};
       export function test(): number { return (g as any).call(o) === o ? 1 : 0; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(1);
  });

  it("CONTROL: Function.prototype.toString stays unaffected (makeGlue ladder ordering)", async () => {
    const { value, hostImports } = await runStandalone(
      `var fp = Function.prototype;
       function g(this: any) { return this; }
       var o: any = {};
       var score = 0;
       if (typeof (g as any).toString() === "string") score += 1;
       // Still exercises the fixed path in the same module.
       if ((g as any).call(o) === o) score += 2;
       export function test(): number { return score; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(3);
  });
});
