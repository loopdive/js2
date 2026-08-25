// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2949 slice 3b — unify the explicit `any` annotation onto `dynamic`.
//
// Before this slice, `x: any` mapped to externref in ALL modes (the #1228
// "any" ResolvedKind + resolvePositionType's AnyKeyword arm), which had two
// measured defects (slice-2 session, WAT-diff evidence in the issue file):
//
//   1. FAST-MODE ABI DIVERGENCE: legacy `resolveWasmType`'s any-arm is
//      mode-split (fast → `ref_null $AnyValue`, host → externref), so an
//      IR-claimed `f(x: any): any` had a DIFFERENT fast-mode signature than
//      legacy callers/callees expect (and any-annotated class methods hit
//      the typeIdx-parity guard for the same reason).
//   2. CLAIM-THEN-DEMOTE: the "any" kind claimed every any-param function
//      unconditionally and relied on from-ast throwing for non-move uses.
//
// Now AnyKeyword resolves `dynamic` in both the selector and
// `resolvePositionType`: any-annotated positions share the unannotated
// dynamics' carrier (legacy-ABI-lockstep via resolveDynamic), the move-only
// scan gates uses PRE-claim, and gate 6 keeps the claims compile-twice under
// JS2WASM_IR_FIRST. `any[]` ELEMENTS deliberately keep the externref vec
// representation (element rep is #2379/#1852 territory) — byte-preserving.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/index.js";
import { buildTypeMap } from "../src/ir/propagate.js";
import { buildImports } from "../src/runtime.js";

/** Selector verdict with a real checker-backed TypeMap (production shape —
 *  same harness as the slice-2 tests; the unannotated-dynamic arms need the
 *  propagation lattice, annotation-only sources don't). */
function selectionFor(source: string): { claimed: Set<string>; fallbacks: Map<string, string> } {
  const host = ts.createCompilerHost({});
  const sfRaw = ts.createSourceFile("t.ts", source, ts.ScriptTarget.ES2022, true);
  const program = ts.createProgram({
    rootNames: ["t.ts"],
    options: { allowJs: true },
    host: {
      ...host,
      getSourceFile: (fn, lv) => (fn === "t.ts" ? sfRaw : host.getSourceFile(fn, lv)),
      fileExists: (fn) => fn === "t.ts" || host.fileExists(fn),
      readFile: (fn) => (fn === "t.ts" ? source : host.readFile(fn)),
    },
  });
  const sf = program.getSourceFile("t.ts")!;
  const typeMap = buildTypeMap(sf, program.getTypeChecker());
  const sel = planIrCompilation(sf, { experimentalIR: true, trackFallbacks: true }, typeMap);
  const fallbacks = new Map<string, string>();
  for (const fb of sel.fallbacks ?? []) fallbacks.set(fb.name, fb.reason);
  return { claimed: new Set(sel.funcs), fallbacks };
}

async function compileStrict(source: string, opts: Record<string, unknown> = {}) {
  const r = await compile(source, { fileName: "t.ts", ...opts });
  expect(r.success, r.errors[0]?.message).toBe(true);
  // Zero post-claim demotions — the any→dynamic unification must be
  // exactly as build-proof as the unannotated dynamic path.
  expect(r.irPostClaimErrors ?? []).toEqual([]);
  return r;
}

async function instantiate(r: Awaited<ReturnType<typeof compile>>): Promise<Record<string, Function>> {
  const built = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
  });
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

/** The `(func $f …` header line (signature) from the WAT. */
function funcHeader(wat: string, name: string): string | undefined {
  return wat.split("\n").find((l) => l.includes(`(func $${name} `) || l.includes(`(func $${name}(`));
}

// ---------------------------------------------------------------------------
// Selector — any-annotated shapes route through the dynamic gate
// ---------------------------------------------------------------------------

describe("#2949 s3b — selector: `any` is dynamic", () => {
  it("move-shaped any functions stay claimed (the #1228 surface)", () => {
    const { claimed } = selectionFor(`
      export function takesAny(x: any): number { return 1; }
      export function pass(x: any): any { return x; }
      function noop(x: any): number { return 1; }
      export function helper(x: any, y: any): void { noop(x); noop(y); }
    `);
    expect(claimed.has("takesAny")).toBe(true);
    expect(claimed.has("pass")).toBe(true);
    expect(claimed.has("noop")).toBe(true);
    expect(claimed.has("helper")).toBe(true);
  });

  // (#4613) This used to assert that `a === b` on two `any` params rejects
  // pre-claim with `param-type-not-resolvable`. #2949 S5.2 landed `dyn.eq`,
  // so that shape now CLAIMS — the literal pin rotted. What 3b actually
  // bought was the removal of the claim-then-demote CHANNEL: pre-3b the
  // `"any"` ResolvedKind claimed every any-param function unconditionally and
  // relied on a from-ast throw to unwind it. That invariant is intact and is
  // what is asserted now, over both sides of the family: a shape that claims
  // must build clean, and a shape the IR cannot lower must decline BEFORE the
  // claim, never after it.
  it("any-annotated dynamic uses never claim-then-demote (the channel 3b removed)", async () => {
    // Side A — landed producer: `===` on any params claims, and the claim
    // survives the build with zero post-claim demotions. (The dyn.eq lowering
    // and its runtime are pinned in tests/issue-2949-s5-2-eq.test.ts; the
    // claim flip in tests/issue-2949-s5-p-claim-flip.test.ts (`isModifier`).)
    const eqSrc = `
      export function isSame(a: any, b: any): number {
        if (a === b) { return 1; }
        return 0;
      }
    `;
    const eq = selectionFor(eqSrc);
    expect(eq.claimed.has("isSame")).toBe(true);
    expect(eq.fallbacks.has("isSame")).toBe(false);
    const built = await compileStrict(eqSrc); // asserts irPostClaimErrors == []
    expect(built.irCompiledFuncs ?? []).toContain("isSame");

    // Side B — shapes the IR still cannot lower decline PRE-claim, with a
    // recorded reason, and cost nothing post-claim. The bucket STRING is
    // deliberately not pinned (it moved from `param-type-not-resolvable` to
    // the more precise call/constructor-resolution buckets as the phase-1
    // scans landed); the pre-claim-ness is the invariant.
    const stillRejected: Array<[string, string]> = [
      ["calling an any param", `export function f(a: any): number { return a(); }`],
      ["constructing from an any param", `export function f(a: any): number { const o = new a(); return 1; }`],
    ];
    for (const [label, src] of stillRejected) {
      const { claimed, fallbacks } = selectionFor(src);
      expect(claimed.has("f"), label).toBe(false);
      expect(fallbacks.get("f"), `${label} must record a pre-claim fallback reason`).toBeDefined();
      const r = await compileStrict(src); // no post-claim demotion for a declined shape
      expect(r.irCompiledFuncs ?? [], label).not.toContain("f");
    }
  });

  it("mixed any/unannotated pass-through chains claim (one dynamic world)", () => {
    const { claimed } = selectionFor(`
      function g(x) { return x; }
      export function f(x: any): any { return g(x); }
    `);
    expect(claimed.has("g")).toBe(true);
    expect(claimed.has("f")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ABI — the fast-mode divergence is FIXED
// ---------------------------------------------------------------------------

describe("#2949 s3b — `any` shares legacy's mode-split ABI", () => {
  const src = `export function f(x: any): any { return x; }`;

  it("host mode: same `func $f` header as experimentalIR:false (externref, unchanged)", async () => {
    const ir = await compileStrict(src, { wat: true });
    const legacy = await compile(src, { fileName: "t.ts", experimentalIR: false, wat: true });
    expect(legacy.success).toBe(true);
    expect(funcHeader(ir.wat, "f")).toBeDefined();
    expect(funcHeader(ir.wat, "f")).toBe(funcHeader(legacy.wat, "f"));
  });

  it("fast mode: same `func $f` header as experimentalIR:false — the FIX (was externref, now $AnyValue ref)", async () => {
    const ir = await compileStrict(src, { fast: true, wat: true });
    const legacy = await compile(src, { fileName: "t.ts", fast: true, experimentalIR: false, wat: true });
    expect(legacy.success).toBe(true);
    const irHeader = funcHeader(ir.wat, "f");
    expect(irHeader).toBeDefined();
    expect(irHeader).toBe(funcHeader(legacy.wat, "f"));
    // The pre-3b divergence was exactly this: externref where legacy had the
    // $AnyValue carrier.
    expect(irHeader).not.toContain("externref");
  });
});

// ---------------------------------------------------------------------------
// Cross-front-end exposure — pinned facts
// ---------------------------------------------------------------------------

describe("#2949 s3b — mixed legacy/IR call edges", () => {
  it("call-graph closure PREVENTS a legacy top-level caller of an IR any-callee (pinned)", () => {
    // Probed during this slice: when a non-claimable function (`driver`,
    // `===` on any) calls a claimable any-function, the selector's
    // call-graph-closure rule evicts the callee too — so mixed
    // legacy-caller → IR-callee TOP-LEVEL edges cannot exist. The fast-mode
    // ABI unification's cross-front-end exposure is therefore at the
    // EXPORT boundary, method claims (typeIdx parity), and future producer
    // widenings — not top-level direct calls. Pin the eviction so a future
    // call-graph relaxation revisits the ABI story consciously.
    const { claimed, fallbacks } = selectionFor(`
      export function pass(x: any): any { return x; }
      export function driver(): number {
        const v: any = 7;
        const r: any = pass(v);
        if (r === v) { return 1; }
        return 0;
      }
    `);
    expect(claimed.has("pass")).toBe(false);
    expect(claimed.has("driver")).toBe(false);
    expect(fallbacks.get("pass")).toBe("call-graph-closure");
    // Without the legacy caller, the same callee claims.
    const solo = selectionFor(`export function pass(x: any): any { return x; }`);
    expect(solo.claimed.has("pass")).toBe(true);
  });

  it("claimed any-functions run identity in host mode; fast mode compiles with zero demotions", async () => {
    // Same proof standard as slice 2: fast-mode RUNTIME entry into an
    // any-signature export needs a JS-constructible carrier ($AnyValue is
    // not), so fast mode is proven at compile + header level and host mode
    // at runtime.
    const src = `export function pass(x: any): any { return x; }`;
    const host = await compileStrict(src);
    const hx = await instantiate(host);
    for (const v of [42, "hello", null, undefined, true]) {
      expect((hx.pass as (v: unknown) => unknown)(v)).toBe(v);
    }
    const obj = { a: 1 };
    expect((hx.pass as (v: unknown) => unknown)(obj)).toBe(obj);
    await compileStrict(src, { fast: true }); // zero demotions asserted inside
  });
});

// ---------------------------------------------------------------------------
// any[] — element representation preserved
// ---------------------------------------------------------------------------

describe("#2949 s3b — any[] keeps the externref vec element rep", () => {
  const src = `export function count(xs: any[]): number { return xs.length; }`;

  it("an any[]-param function still claims and keeps the legacy vec signature (host)", async () => {
    // (A runnable in-module caller is not IR-expressible yet — an `any[]`
    // local declaration body-shape-rejects the caller and the call-graph
    // closure then evicts `count` too — so the proof is claim + build +
    // byte-level signature parity with legacy, which is what the element-rep
    // preservation is about.)
    const { claimed } = selectionFor(src);
    expect(claimed.has("count")).toBe(true);
    // Host mode: IR and legacy agree on the vec-of-externref signature —
    // unchanged by 3b, and the IR keeps the body it built.
    const ir = await compileStrict(src, { wat: true });
    expect(ir.irCompiledFuncs ?? []).toContain("count");
    const legacy = await compile(src, { fileName: "t.ts", experimentalIR: false, wat: true });
    expect(legacy.success).toBe(true);
    expect(funcHeader(ir.wat, "count")).toBeDefined();
    expect(funcHeader(ir.wat, "count")).toBe(funcHeader(legacy.wat, "count"));
  });

  // (#4613 / #4615) 3b asserted `irPostClaimErrors == []` for the FAST lane
  // too. That went red on main at 7ecb4ee3a (`fix(#3536)`), which extended the
  // patch-time typeIdx-parity guard to top-level FunctionDeclarations. The
  // guard did not create a defect — it exposed one 3b had already recorded in
  // prose: in fast mode the IR resolves a different vec/result ABI for `any[]`
  // than legacy does. Pre-#3536 (measured at a017055f4) the IR silently
  // SHIPPED that divergence — IR `(param (ref null 2)) (result f64)` against
  // legacy `(param (ref null 36)) (result i32)` — and reported zero demotions.
  //
  // So the honest pin for the fast lane is not "zero demotions" (that would be
  // asserting a fix nobody made) and not "whatever main prints" (that would
  // launder the next regression). It is the SAFETY property the guard buys:
  // the divergence is caught, the withdrawal is SOFT, and legacy's ABI is what
  // ships. Tracked as #4615 — when that lands, this pin fails and must be
  // tightened back to zero demotions.
  it("fast mode: the ABI divergence is caught by the parity guard, not shipped (pinned gap #4615)", async () => {
    const ir = await compile(src, { fileName: "t.ts", fast: true, wat: true });
    expect(ir.success, ir.errors[0]?.message).toBe(true);
    // Soft withdrawal on the warning channel — a `build` demotion, NOT a hard
    // invariant violation and NOT a failed compile.
    const demotions = ir.irPostClaimErrors ?? [];
    expect(demotions.map((d) => `${d.kind}:${d.func}`)).toEqual(["build:count"]);
    expect(demotions[0]!.message).toContain("typeIdx parity mismatch");
    expect(demotions[0]!.message).toContain("keeping legacy body");
    // The claim really is withdrawn, and legacy's signature is what ships.
    expect(ir.irCompiledFuncs ?? []).not.toContain("count");
    const legacy = await compile(src, { fileName: "t.ts", fast: true, experimentalIR: false, wat: true });
    expect(legacy.success).toBe(true);
    expect(funcHeader(ir.wat, "count")).toBeDefined();
    expect(funcHeader(ir.wat, "count")).toBe(funcHeader(legacy.wat, "count"));
    // …and the module the guard let through is valid Wasm (the whole point of
    // #3536: pre-guard, a mismatched patch could emit an invalid module).
    expect(() => new WebAssembly.Module(ir.binary)).not.toThrow();
  });
});
