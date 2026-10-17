// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #3053 U2 — the claim-flip (#2949 S5.P for dynamic property/element reads).
//
// U0 built the unified reader carrier `__dyn_member_get`; U1 wired it into the
// IR member-read path (byte-inert-off-path: the selector still rejected every
// dynamic-receiver read). U2 OPENS `select.ts` `dynamicUsesAreMoveOnly` for a
// dynamic member/element receiver, so a `dyn.name` / `dyn[key]` read now CLAIMS
// and emits `[call __dyn_member_get]` — the #2949 claim-rate finally moves.
//
// Two load-bearing correctness properties this suite pins:
//
//  1. CARRIER MODE-SPLIT ALIGNMENT (U2 prerequisite). `ensureDynMemberGet` keys
//     its body on `ctx.fast` — the SAME predicate `resolveDynamic` /
//     `makeDynamicLowering` use for the carrier ValType — so the emitted body's
//     ABI always matches the carrier: gc `$AnyValue` when fast, externref host
//     wrapper otherwise. Every claimed config emits a VALID, aligned module.
//
//  2. FAST HOST-JS-STRING GATE. The ONE config where the gc `$AnyValue` body is
//     unsound is `fast && !standalone && !wasi` (the carrier is `$AnyValue` yet
//     strings are host js-string externrefs, so the native honest classifier
//     mis-tags reads). There the selector must give a CLEAN pre-claim rejection
//     (`dynMemberReadBuildable:false`), never a claim-then-demote.
//
// Anti-vacuity: the claim assertions below are matched by real host-mode RUNs
// that check value + tag + object identity, and a contrast case proves an
// out-of-contract index shape still rejects (no false claim).

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/index.js";
import { buildTypeMap } from "../src/ir/propagate.js";
import { buildImports } from "../src/runtime.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function selectionFor(
  source: string,
  opts: { dynMemberReadBuildable?: boolean } = {},
): { claimed: Set<string>; fallbacks: Map<string, string> } {
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
  const sel = planIrCompilation(
    sf,
    { experimentalIR: true, trackFallbacks: true, dynMemberReadBuildable: opts.dynMemberReadBuildable },
    typeMap,
  );
  const fallbacks = new Map<string, string>();
  for (const fb of sel.fallbacks ?? []) fallbacks.set(fb.name, fb.reason);
  return { claimed: new Set(sel.funcs), fallbacks };
}

async function compileStrict(source: string, opts: Record<string, unknown> = {}) {
  const r = await compile(source, { fileName: "t.ts", ...opts });
  expect(r.success, r.errors[0]?.message).toBe(true);
  // The claim-flip must be build-proof — zero post-claim demotions (the
  // JS2WASM_IR_FIRST skipped-slot contract, #2138).
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

// ---------------------------------------------------------------------------
// Selector — the claim-flip (what U2 now CLAIMS)
// ---------------------------------------------------------------------------

describe("#3053 U2 — selector opens dynamic member/element reads (the claim-flip)", () => {
  const claims: Array<[string, string, string]> = [
    ["named read `return o.x`", `export function f(o) { return o.x; }`, "f"],
    ["dynamic-index read `return o[i]`", `export function f(o, i) { return o[i]; }`, "f"],
    ["numeric-literal index `return o[0]`", `export function f(o) { return o[0]; }`, "f"],
    ["string-literal key return o['k']", `export function f(o) { return o["k"]; }`, "f"],
    ["alias of a member read `const y = o.x; return y`", `export function f(o) { const y = o.x; return y; }`, "f"],
    ["chained read `return o.a.b`", `export function f(o) { return o.a.b; }`, "f"],
    ["member read into a dyn-param call", `function g(v) { return v; }\nexport function f(o) { return g(o.x); }`, "f"],
    // (#7014 wave 15) Moved here from the REJECTS list: `o.x + 1` used to need
    // an unbox the move-only surface lacked. The IR now lowers dynamic `+` on a
    // member read — re-measured 2026-10-17 on upstream main 0727e2985b: `f` is
    // claimed with no post-claim error, and f({x:1}) === 2, f({x:"a"}) === "a1",
    // f({}) is NaN in both the host and standalone lanes, as in JS.
    ["member read into arithmetic `o.x + 1`", `export function f(o) { return o.x + 1; }`, "f"],
  ];
  for (const [label, src, fn] of claims) {
    it(`CLAIMS: ${label}`, () => {
      const { claimed, fallbacks } = selectionFor(src);
      expect(claimed.has(fn), `expected ${fn} claimed; fallback=${fallbacks.get(fn)}`).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Selector — precision: out-of-contract shapes still reject (no claim-then-demote)
// ---------------------------------------------------------------------------

describe("#3053 U2 — precision: member reads outside the producer contract still reject", () => {
  const rejected: Array<[string, string]> = [
    // Dynamic arithmetic in the index (`i-1`) has no dynamic-arith producer —
    // must NOT claim (would demote).
    ["dynamic-arithmetic index `o[i-1]`", `export function f(o, i) { return o[i - 1]; }`],
    // Bare `o.x;` in statement position with a concrete return keeps rejecting a
    // non-move dyn use (result neither moved nor dropped-as-call).
    ["member read as a bare statement value", `export function f(o) { o.x; return 1; }`],
  ];
  for (const [label, src] of rejected) {
    it(`REJECTS: ${label}`, () => {
      const { claimed } = selectionFor(src);
      expect(claimed.has("f")).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Config gate — fast host-js-string must NOT claim (clean pre-claim rejection)
// ---------------------------------------------------------------------------

describe("#3053 U2 — fast host-js-string gate (dynMemberReadBuildable=false)", () => {
  it("a dynamic member read that CLAIMS in a sound config REJECTS when the gc body is unsound", () => {
    const src = `export function f(o) { return o.x; }`;
    expect(selectionFor(src, { dynMemberReadBuildable: true }).claimed.has("f")).toBe(true);
    const gated = selectionFor(src, { dynMemberReadBuildable: false });
    expect(gated.claimed.has("f")).toBe(false);
    expect(gated.fallbacks.get("f")).toBe("param-type-not-resolvable");
  });

  it("the real fast+host-js-string compile does NOT claim + emits a valid module", async () => {
    const r = await compileStrict(`export function f(o) { return o.x; }`, { fast: true });
    expect(r.irCompiledFuncs ?? []).not.toContain("f");
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Carrier alignment — every claimed config emits a valid, aligned module
// ---------------------------------------------------------------------------

describe("#3053 U2 — carrier mode-split alignment across configs", () => {
  const SRC = `
    export function fwd(o) { return o.x; }
    export function idx(o, i) { return o[i]; }
    export function lit(o) { return o[0]; }
  `;
  const soundConfigs: Array<[string, Record<string, unknown>]> = [
    ["fast+standalone (gc $AnyValue)", { target: "standalone", fast: true }],
    ["default-host (externref)", {}],
    ["nonfast+standalone (externref wrapper)", { target: "standalone" }],
    ["nonfast+wasi (externref wrapper)", { target: "wasi" }],
  ];
  for (const [label, opts] of soundConfigs) {
    it(`claims + emits valid Wasm: ${label}`, async () => {
      const r = await compileStrict(SRC, opts);
      expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
      for (const fn of ["fwd", "idx", "lit"]) {
        expect(r.irCompiledFuncs ?? [], `${fn} must claim in ${label}`).toContain(fn);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Behavior + identity — the claim-flip is non-vacuous and correct (host run)
// ---------------------------------------------------------------------------

describe("#3053 U2 — claimed member reads run correctly (value + identity)", () => {
  it("named / indexed / literal reads return the right values", async () => {
    const r = await compileStrict(`
      export function fwd(o) { return o.x; }
      export function idx(o, i) { return o[i]; }
      export function lit(o) { return o[0]; }
    `);
    // All three IR-claimed (proves we execute the __dyn_member_get path).
    for (const fn of ["fwd", "idx", "lit"]) expect(r.irCompiledFuncs ?? []).toContain(fn);
    const ex = await instantiate(r);
    const obj: any = { x: 42, foo: "bar", 0: "zero" };
    expect(ex.fwd!(obj)).toBe(42);
    expect(ex.idx!(obj, "foo")).toBe("bar");
    expect(ex.idx!(["a", "b", "c"], 1)).toBe("b");
    expect(ex.lit!(["z"])).toBe("z");
  });

  it("preserves OBJECT IDENTITY through the carrier (the #3037 CS3 ride-on)", async () => {
    const r = await compileStrict(`export function fwd(o) { return o.x; }`);
    expect(r.irCompiledFuncs ?? []).toContain("fwd");
    const ex = await instantiate(r);
    const inner = { a: 1 };
    const outer = { x: inner };
    expect(ex.fwd!(outer)).toBe(inner); // same ref, not a tag-5 copy
  });

  it("preserves string + number values by content", async () => {
    const r = await compileStrict(`export function fwd(o) { return o.v; }`);
    const ex = await instantiate(r);
    expect(ex.fwd!({ v: "hello" })).toBe("hello");
    expect(ex.fwd!({ v: 7 })).toBe(7);
  });
});
