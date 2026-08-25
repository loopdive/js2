// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #2949 slice 2 — dynamic producers + selector (move-only surface).
//
// Slice 1 (merged, PR #2486) added the `{kind:"dynamic", tag?}` IrType leaf,
// verifier rules R1–R4, and the `resolveDynamic()` lowering contract. This
// slice adds the first PRODUCERS: unannotated params/returns whose propagated
// lattice type is `unknown`/`dynamic` now resolve to `IrType.dynamic` instead
// of rejecting the function (`param-type-not-resolvable` /
// `return-type-not-resolvable`).
//
// The claim is gated by the MOVE-ONLY scan (`dynamicUsesAreMoveOnly` in
// select.ts): slice 2 has no box/unbox/tag.test lowering, so a dynamic value
// may only move — return position, dyn-arg → dyn-param of a local direct
// call, const/let alias. Anything else keeps the existing rejection bucket.
// Precision here is load-bearing: claim-then-demote would be a hard error
// under JS2WASM_IR_FIRST (skipped-slot contract, #2138) and noise in the
// #1923 post-claim metering. These tests pin BOTH sides: what claims must
// build + run correctly with ZERO post-claim demotions, and what must NOT
// claim.
//
// ABI: dynamic lowers through `resolveDynamic()` = legacy `resolveWasmType`'s
// any/unknown arm (fast/standalone: `ref_null $AnyValue`; host: externref),
// so IR-claimed and legacy-compiled functions agree on signatures by
// construction — asserted below by comparing the emitted `func $f` header
// against an `experimentalIR: false` compile of the same source.

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/index.js";
import { buildTypeMap } from "../src/ir/propagate.js";
import { buildImports } from "../src/runtime.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Selector verdict with a real checker-backed TypeMap (production shape). */
function selectionFor(source: string): {
  claimed: Set<string>;
  fallbacks: Map<string, string>;
} {
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
  // Zero post-claim demotions — the move-only scan must be build-proof.
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
// Selector — what claims
// ---------------------------------------------------------------------------

describe("#2949 slice 2 — selector claims move-only dynamic shapes", () => {
  it("unannotated identity claims (param + return dynamic)", () => {
    const { claimed } = selectionFor(`export function f(x) { return x; }`);
    expect(claimed.has("f")).toBe(true);
  });

  it("pass-through chain claims (dyn-arg → dyn-param, dyn return)", () => {
    const { claimed } = selectionFor(`
      function g(x) { return x; }
      export function f(x) { return g(x); }
    `);
    expect(claimed.has("g")).toBe(true);
    expect(claimed.has("f")).toBe(true);
  });

  it("const alias of a dynamic param claims", () => {
    const { claimed } = selectionFor(`export function f(x) { const y = x; return y; }`);
    expect(claimed.has("f")).toBe(true);
  });

  it("unused dynamic param with concrete return claims", () => {
    const { claimed } = selectionFor(`export function f(x) { return 1; }`);
    expect(claimed.has("f")).toBe(true);
  });

  it("statement-position dyn call (result dropped) claims", () => {
    const { claimed } = selectionFor(`
      function g(x) { return x; }
      export function f(x): number { g(x); return 1; }
    `);
    expect(claimed.has("f")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Selector precision — every dynamic-use shape reaches a CLEAN terminal state
// ---------------------------------------------------------------------------
//
// (#4613) This section used to pin a literal rejection bucket per shape
// (`param-type-not-resolvable` for all five). Three of those five pins rotted
// on main as the dynamic producers landed — the shapes now CLAIM, and one
// still-rejected shape moved to a more precise bucket:
//
//   truthiness of a dyn param   → claims  (#2949 S5.1 `dyn.truthy`)
//   `a === b` on dyn params     → claims  (#2949 S5.2 `dyn.eq`)
//   dyn arg → concrete param    → claims  (the param is call-site narrowed to
//                                          the callee's concrete ABI, so it is
//                                          not dynamic at all any more)
//   `x()` on a dyn param        → rejects, now `call-resolution-unsupported`
//                                 (the phase-1 call-target scan declines
//                                  before the move-only scan is consulted)
//
// A literal-string pin cannot survive that, and blanket-updating it to
// whatever main reports would launder a future regression. So the assertions
// are re-grounded on the invariant they actually defend — the TERMINAL OUTCOME
// CLASS, which is what #2138 (IR-first skipped-slot contract) and #1923
// (post-claim metering) care about:
//
//   "claim"  → claimed pre-build AND builds with ZERO post-claim demotions
//   "reject" → NOT claimed, recorded as a PRE-CLAIM fallback, in a bucket that
//              is still an open capability gap (never laundered into a
//              deferred/wont-fix one)
//
// The forbidden middle is claim-then-demote. Bucket names may keep moving;
// this shape may not.

/**
 * Buckets that mean "the project has decided not to pursue this shape".
 * A dynamic-use rejection landing in one of these would hide a live producer
 * gap behind a wont-fix label, so they are the one thing a `reject` verdict
 * must NOT be. Mirrors the `deferred` rows of the IR-fallback budget table
 * (CLAUDE.md) / `scripts/gen-ir-adoption.mjs`.
 */
const DEFERRED_BUCKETS = new Set([
  "deferred-feature",
  "async-generator",
  "async-function",
  "type-parameters",
  "non-export-modifier",
  "unnamed",
]);

describe("#2949 slice 2 — every dynamic-use shape reaches a clean terminal state", () => {
  // [label, source, expected outcome class, bucket observed on main 2026-08-22]
  const shapes: Array<[string, string, "claim" | "reject", string]> = [
    ["arithmetic on dyn param", `export function f(x) { return x + 1; }`, "reject", "param-type-not-resolvable"],
    [
      "truthiness test of dyn param",
      `export function f(x) { if (x) { return x; } else { return x; } }`,
      "claim",
      "— flipped by #2949 S5.1 (dyn.truthy); lowering + runtime pinned in tests/issue-2949-s5-1-truthiness.test.ts, claim pinned in tests/issue-2949-s5-p-claim-flip.test.ts (`truth`)",
    ],
    // NOTE: `return x.foo` (property access on a dyn param) was rejected in
    // slice 2, but #3053 U2 opens the selector scan for dynamic member/element
    // reads (routed through `__dyn_member_get`), so it now CLAIMS. The flip is
    // asserted positively in tests/issue-3053-u2-claim-flip.test.ts.
    [
      "mixed dynamic/concrete returns",
      `export function f(x) { if (x === 1) { return x; } else { return 0; } }`,
      "reject",
      "param-type-not-resolvable",
    ],
    [
      "dyn arg into a concrete (annotated) param",
      `function g(n: number): number { return n; }
       export function f(x) { return g(x); }`,
      "claim",
      "— `x` is call-site narrowed to g's f64 ABI (`func $f (type 1)` == g's type), so this is no longer a dynamic use; the mechanism is pinned in tests/issue-2949-s5-p-claim-flip.test.ts (`hexToInt`)",
    ],
    ["calling the dyn value itself", `export function f(x) { return x(); }`, "reject", "call-resolution-unsupported"],
    ["destructured dynamic param", `export function f({ a }) { return a; }`, "reject", "param-type-not-resolvable"],
  ];

  for (const [label, src, outcome, note] of shapes) {
    it(`${label} → ${outcome} (${note})`, async () => {
      const { claimed, fallbacks } = selectionFor(src);
      if (outcome === "claim") {
        expect(claimed.has("f")).toBe(true);
        expect(fallbacks.has("f")).toBe(false);
        // The half that makes a claim legitimate: it must BUILD without the
        // post-claim demotion channel firing.
        const r = await compileStrict(src);
        expect(r.irCompiledFuncs ?? []).toContain("f");
        return;
      }
      expect(claimed.has("f")).toBe(false);
      // A pre-claim decline, recorded — not a post-claim demote, and not a
      // silent disappearance.
      const reason = fallbacks.get("f");
      expect(reason, `${label} must record a pre-claim fallback reason`).toBeDefined();
      expect(DEFERRED_BUCKETS.has(reason!), `${label} bucketed as deferred: ${reason}`).toBe(false);
      // Declining costs nothing post-claim: the legacy body compiles clean.
      const r = await compileStrict(src);
      expect(r.irCompiledFuncs ?? []).not.toContain("f");
    });
  }
});

// ---------------------------------------------------------------------------
// Build + run — round-trip with zero demotions, JS-semantics-correct
// ---------------------------------------------------------------------------

describe("#2949 slice 2 — claimed shapes build (no demotions) and run correctly", () => {
  const shapes: Array<[string, string]> = [
    ["identity", `export function f(x) { return x; }`],
    ["pass-through", `function g(x) { return x; }\nexport function f(x) { return g(x); }`],
    ["const alias", `export function f(x) { const y = x; return y; }`],
  ];

  for (const [label, src] of shapes) {
    it(`${label} — host mode: identity across number/string/null/undefined/object/bool`, async () => {
      const r = await compileStrict(src);
      const exports = await instantiate(r);
      const obj = { a: 1 };
      expect(exports.f!(42)).toBe(42);
      expect(exports.f!("hello")).toBe("hello");
      expect(exports.f!(null)).toBe(null);
      expect(exports.f!(true)).toBe(true);
      expect(exports.f!(obj)).toBe(obj);
    });

    it(`${label} — fast mode compiles with zero demotions`, async () => {
      await compileStrict(src, { fast: true });
    });
  }

  it("unused dyn param + concrete return runs", async () => {
    const r = await compileStrict(`export function f(x) { return 1; }`);
    const exports = await instantiate(r);
    expect(exports.f!("whatever")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ABI lockstep — IR-claimed signature equals the legacy signature
// ---------------------------------------------------------------------------

describe("#2949 slice 2 — dynamic carrier equals the legacy any/unknown ABI", () => {
  const src = `export function f(x) { return x; }`;

  it("host mode: same `func $f` header as experimentalIR:false", async () => {
    const ir = await compileStrict(src);
    const legacy = await compile(src, { fileName: "t.ts", experimentalIR: false });
    expect(legacy.success).toBe(true);
    expect(funcHeader(ir.wat, "f")).toBeDefined();
    expect(funcHeader(ir.wat, "f")).toBe(funcHeader(legacy.wat, "f"));
  });

  it("fast mode: same `func $f` header as experimentalIR:false (ref_null $AnyValue, NOT externref)", async () => {
    const ir = await compileStrict(src, { fast: true });
    const legacy = await compile(src, { fileName: "t.ts", fast: true, experimentalIR: false });
    expect(legacy.success).toBe(true);
    const irHeader = funcHeader(ir.wat, "f");
    expect(irHeader).toBeDefined();
    expect(irHeader).toBe(funcHeader(legacy.wat, "f"));
    // The carrier must be a concrete ref (the $AnyValue box), not externref —
    // the explicit-`any` externref asymmetry must not leak into dynamic.
    expect(irHeader).not.toContain("externref");
  });
});

// ---------------------------------------------------------------------------
// IR-first gate 6 — dynamic claims stay compile-twice under the flag
// ---------------------------------------------------------------------------

describe("#2949 slice 2 — IR-first skip-set gate 6", () => {
  it("dynamic-signature functions are claimed but NOT legacy-skipped under JS2WASM_IR_FIRST=1", async () => {
    const src = `export function f(x) { return x; }\nexport function t(n: number): number { return n + 1; }`;
    vi.stubEnv("JS2WASM_IR_FIRST", "1");
    try {
      const r = await compile(src, { fileName: "t.ts" });
      expect(r.success).toBe(true);
      expect(r.irPostClaimErrors ?? []).toEqual([]);
      const skipped = r.irFirstSkipped ?? [];
      // gate 6: the dynamic function keeps its legacy body (compile-twice)…
      expect(skipped).not.toContain("f");
      // …while a typed function is still skipped (gate 6 is surgical).
      expect(skipped).toContain("t");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
