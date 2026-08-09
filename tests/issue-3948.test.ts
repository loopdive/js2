/**
 * #3948 — object-literal methods never registered optional-parameter metadata,
 * so `maybeSetArgcForKnownCall` no-op'd at every `o.m()` call site and the
 * callee's param-default prologue read the `-1` "unknown caller" sentinel.
 *
 * Two independent guards, kill-switched separately (2026-08-01):
 *
 *   (A) `literals.ts` — register `ctx.funcOptionalParams` for object-literal
 *       methods. Revert it alone and the generator modules below still emit
 *       ZERO host imports and still instantiate with `{}` — they just return
 *       the inert `0` instead of the default. Import-set-only acceptance would
 *       green that; only the value assertions catch it.
 *
 *   (B) `generators-native.ts` — lift the #2581 object-literal
 *       default-param bail in `isNativeGeneratorCandidate`. Revert it alone and
 *       every standalone generator case below fails at instantiation with
 *       `Import #0 "env": module is not an object or function`.
 *
 * The host-lane assertions are the wider defect (#3949): `{ m(a = 5) }.m()`
 * evaluated to 0 in the DEFAULT target too, with no generator involved — which
 * also falsifies #2581's stated justification for the bail ("the eager-buffer
 * host path applies defaults correctly, so route there").
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

const HOST_GEN_IMPORTS =
  /__create_generator|__gen_create_buffer|__gen_next|__gen_push|__gen_result|__gen_return|__get_caught_exception/;

type Compiled = {
  success: boolean;
  binary: Uint8Array;
  errors?: unknown;
  imports?: { module: string; name: string }[];
  importObject?: WebAssembly.Imports;
};

async function compileLane(src: string, lane: "standalone" | "host"): Promise<Compiled> {
  // NOTE: `{ standalone: true }` is rejected by buildCodegenOptions (#86) and used
  // to silently run the gc-host lane, which makes a "standalone" test vacuous.
  const opts = lane === "standalone" ? { fileName: "t.ts", target: "standalone" as const } : { fileName: "t.ts" };
  const r = (await compile(src, opts)) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  return r;
}

/** Standalone run. Instantiating with NO import object is itself the leak assertion. */
async function runStandalone(src: string): Promise<unknown> {
  const r = await compileLane(src, "standalone");
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

async function runHost(src: string): Promise<unknown> {
  const r = await compileLane(src, "host");
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

async function standaloneImportNames(src: string): Promise<string> {
  const r = await compileLane(src, "standalone");
  return (r.imports ?? []).map((i) => `${i.module}::${i.name}`).join(",");
}

// ---------------------------------------------------------------------------
// (B) the leak — object-literal generator methods with a parameter default
// ---------------------------------------------------------------------------

describe("#3948 standalone: object-literal generator methods with a param default", () => {
  it("emits no host generator imports for an identifier default", async () => {
    const names = await standaloneImportNames(
      `const o = { *m(a: number = 5) { yield a; } };
       export function test(): number { return o.m().next().value as number; }`,
    );
    expect(names).not.toMatch(HOST_GEN_IMPORTS);
    expect(names).toBe("");
  });

  it("emits no host generator imports for a whole-param binding-pattern default", async () => {
    const names = await standaloneImportNames(
      `const o = { *m({ x }: { x: number } = { x: 23 }) { yield x; } };
       export function test(): number { return o.m().next().value as number; }`,
    );
    expect(names).not.toMatch(HOST_GEN_IMPORTS);
  });

  // --- value assertions: a host-free module that reads an inert default is
  // --- exactly the failure the import-set gate cannot see.

  it("applies an identifier default when the argument is omitted", async () => {
    expect(
      await runStandalone(
        `const o = { *m(a: number = 5) { yield a; } };
         export function test(): number { return o.m().next().value as number; }`,
      ),
    ).toBe(5);
  });

  it("skips the default when an argument is supplied", async () => {
    expect(
      await runStandalone(
        `const o = { *m(a: number = 5) { yield a; } };
         export function test(): number { return o.m(7).next().value as number; }`,
      ),
    ).toBe(7);
  });

  it("applies a later param's default when an earlier one is supplied", async () => {
    expect(
      await runStandalone(
        `const o = { *m(a: number, b: number = 5) { yield a + b; } };
         export function test(): number { return o.m(1).next().value as number; }`,
      ),
    ).toBe(6);
  });

  it("applies a whole-param binding-pattern default", async () => {
    expect(
      await runStandalone(
        `const o = { *m({ x }: { x: number } = { x: 23 }) { yield x; } };
         export function test(): number { return o.m().next().value as number; }`,
      ),
    ).toBe(23);
  });

  it("prefers a supplied argument over a binding-pattern default", async () => {
    expect(
      await runStandalone(
        `const o = { *m({ x }: { x: number } = { x: 23 }) { yield x; } };
         export function test(): number { return o.m({ x: 4 }).next().value as number; }`,
      ),
    ).toBe(4);
  });

  it("applies a non-constant expression default", async () => {
    expect(
      await runStandalone(
        `function mk(): number { return 11; }
         const o = { *m(a: number = mk()) { yield a; } };
         export function test(): number { return o.m().next().value as number; }`,
      ),
    ).toBe(11);
  });

  it("applies a string default (a ref-typed param, not the argc/f64 path)", async () => {
    expect(
      await runStandalone(
        `const o = { *m(a: string = "hi") { yield a.length; } };
         export function test(): number { return o.m().next().value as number; }`,
      ),
    ).toBe(2);
  });

  // --- the suspension assertion: proves the generator STATE round-trips the
  // --- defaulted binding, not just that the initial load happened to be right.

  it("still sees the defaulted binding after a suspension", async () => {
    expect(
      await runStandalone(
        `const o = { *m(a: number = 5) { yield a; yield a + 1; } };
         export function test(): number {
           const it = o.m();
           it.next();
           return it.next().value as number;
         }`,
      ),
    ).toBe(6);
  });

  it("evaluates the default at call time, not at generator creation (§27.5)", async () => {
    // `mk()` must have run exactly once when `o.m()` returns, and the BODY must
    // not have run at all — the eager-buffer path violated both.
    expect(
      await runStandalone(
        `let calls = 0;
         let bodyRan = 0;
         function mk(): number { calls = calls + 1; return 11; }
         const o = { *m(a: number = mk()) { bodyRan = bodyRan + 1; yield a; } };
         export function test(): number {
           const it = o.m();
           return calls * 10 + bodyRan;
         }`,
      ),
    ).toBe(10);
  });

  // --- #2938/#1557 class: two sibling literals sharing a method name must each
  // --- run their OWN default, not the first literal's.

  it("keeps sibling object literals' defaults distinct", async () => {
    const src = (which: string) =>
      `const a = { *m(v: number = 1) { yield v; } };
       const b = { *m(v: number = 2) { yield v; } };
       export function test(): number { return ${which}.m().next().value as number; }`;
    expect(await runStandalone(src("a"))).toBe(1);
    expect(await runStandalone(src("b"))).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// (A) the wider defect — NON-generator object-literal methods, both lanes
// ---------------------------------------------------------------------------

describe("#3948/#3949 object-literal method parameter defaults (non-generator)", () => {
  const identDefault = `const o = { m(a: number = 5) { return a; } };
     export function test(): number { return o.m(); }`;
  const secondDefault = `const o = { m(a: number, b: number = 5) { return a + b; } };
     export function test(): number { return o.m(1); }`;

  it("applies the default when the argument is omitted — standalone", async () => {
    expect(await runStandalone(identDefault)).toBe(5);
  });

  it("applies the default when the argument is omitted — host lane", async () => {
    expect(await runHost(identDefault)).toBe(5);
  });

  it("applies a later param's default — standalone", async () => {
    expect(await runStandalone(secondDefault)).toBe(6);
  });

  it("applies a later param's default — host lane", async () => {
    expect(await runHost(secondDefault)).toBe(6);
  });

  it("still prefers a supplied argument", async () => {
    expect(
      await runStandalone(
        `const o = { m(a: number = 5) { return a; } };
         export function test(): number { return o.m(7); }`,
      ),
    ).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Deliberately-unchanged shapes — documented residuals, asserted so a future
// change that moves them is visible rather than silent.
// ---------------------------------------------------------------------------

describe("#3948 documented residuals", () => {
  it("keeps `?`-optional generator methods on the host path (value-rep gap)", async () => {
    // With the argc registration in place the admission gate COULD accept this,
    // but `a?: number` lowers to a bare f64 with no `undefined` inhabitant, so
    // the missing-arg branch has nothing to bind and the body reads 0, not 42.
    // Admitting it would trade a leak for a wrong value. Measured, not inherited.
    const names = await standaloneImportNames(
      `const o = { *m(a?: number) { yield a === undefined ? 42 : a; } };
       export function test(): number { return o.m().next().value as number; }`,
    );
    expect(names).toMatch(HOST_GEN_IMPORTS);
  });

  it("leaves object literals without defaults byte-identical in shape (no imports)", async () => {
    const names = await standaloneImportNames(
      `const o = { *m(a: number) { yield a; } };
       export function test(): number { return o.m(3).next().value as number; }`,
    );
    expect(names).toBe("");
  });
});
