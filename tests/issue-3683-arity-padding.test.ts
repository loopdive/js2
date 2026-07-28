/**
 * #3683 S3b — arity-padding trampolines for direct-call devirtualization.
 *
 * S3 devirtualized only EXACT-arity `this.m(...)` sites and declined 428
 * under-applied ones on acorn — the single largest remaining decline bucket, and
 * the common JS shape (`this.parseIdent()` into a method declared with formals).
 * S3b keys the trampoline by CALL-SITE arity and materializes the missing
 * arguments inside it.
 *
 * ## What these pins actually protect
 *
 * The hazard is not "does the call happen" — it is that a padded call must
 * reproduce, exactly, the two pieces of state the dynamic bridge leaves for the
 * callee body:
 *
 *   1. **the missing argument's VALUE** — the canonical `undefined` externref
 *      (`__apply_closure`'s `ARG_OF(k)` out-of-bounds answer), which is DISTINCT
 *      from `null`: a defaulted parameter fires on `undefined` and must NOT fire
 *      on an explicitly passed `null` (§10.2.11 / #1025);
 *   2. **`__argc`** — the CALL-SITE count. Every `f64`/`i32` formal's default
 *      check is argc-driven (`emitParamDefaultArgMissingCheck`), not
 *      value-driven, so writing `formals` there instead would silently flip
 *      default-parameter presence for every under-applied call in the program.
 *
 * Both are therefore pinned by OBSERVATION (the value a body computes, and the
 * side effect a default expression performs), lane-by-lane, rather than by
 * inspecting the emitted wasm.
 *
 * `JS2WASM_DIRECT_CALLS=0` is the whole-slice kill-switch; `=nopad` is the S3b
 * isolation switch — S3's exact-arity devirtualization with every under-applied
 * site declined, i.e. the S3-only module.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type CompileOut = { wat: string; bytes: number; binary: Uint8Array; run: () => unknown };

async function build(source: string, env?: Record<string, string>): Promise<CompileOut> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const r = await compile(source, { fileName: "t.ts", skipSemanticDiagnostics: true, target: "standalone" });
    expect(r.errors ?? []).toEqual([]);
    expect(r.binary?.length ?? 0).toBeGreaterThan(0);
    const module = await WebAssembly.compile(r.binary as BufferSource);
    // Standalone means host-free: padding must not have smuggled in an import.
    expect(WebAssembly.Module.imports(module).length).toBe(0);
    const { exports } = await WebAssembly.instantiate(module, {});
    return {
      wat: r.wat ?? "",
      bytes: r.binary?.length ?? 0,
      binary: r.binary as Uint8Array,
      run: () => (exports as { test: () => unknown }).test(),
    };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}

/**
 * The three lanes every semantic pin compares:
 *   `direct` — S3b (padding on), `legacy` — no devirtualization at all,
 *   `nopad`  — S3 only, so an under-applied site takes the legacy lowering while
 *              its exact-arity neighbours stay devirtualized.
 * Agreement across all three is what makes a padded call indistinguishable.
 */
async function lanes(source: string): Promise<{ direct: CompileOut; legacy: CompileOut; nopad: CompileOut }> {
  return {
    direct: await build(source),
    legacy: await build(source, { JS2WASM_DIRECT_CALLS: "0" }),
    nopad: await build(source, { JS2WASM_DIRECT_CALLS: "nopad" }),
  };
}

/** Did `F.m` get a direct-call trampoline for a CALL-SITE arity of `n`? */
function tramp(out: CompileOut, className: string, method: string, n: number): boolean {
  return new RegExp(`__dc_${className}_${method}_${n}\\b`).test(out.wat);
}

describe("#3683 S3b — arity-padding trampolines", () => {
  it("pads an under-applied call whose missing formal has a DEFAULT", async () => {
    // Both arities of the same method appear, so the module carries two
    // trampolines and each must apply the default correctly for its own arity.
    const src = `var P = function P() { this.v = 0; };
var pp = P.prototype;
pp.m = function (a, b = 5) { return a * 10 + b; };
pp.one = function () { return this.m(1); };
pp.two = function () { return this.m(1, 2); };
export function test(): number { var p = new P(); return p.one() * 1000 + p.two(); }`;
    const { direct, legacy, nopad } = await lanes(src);
    expect(tramp(direct, "P", "m", 1)).toBe(true);
    expect(tramp(direct, "P", "m", 2)).toBe(true);
    expect(tramp(nopad, "P", "m", 1)).toBe(false);
    expect(tramp(nopad, "P", "m", 2)).toBe(true);
    // node: m(1) -> 1*10+5 = 15, m(1,2) -> 12 => 15012.
    expect(direct.run()).toBe(15012);
    expect(legacy.run()).toBe(15012);
    expect(nopad.run()).toBe(15012);
  });

  it("distinguishes a PADDED `undefined` from an explicitly passed `null`", async () => {
    // The single most load-bearing pin in the file. A default fires on
    // `undefined` and never on `null`, so padding with `ref.null.extern` instead
    // of the canonical `$undefined` singleton would make the two arities
    // indistinguishable — and would be invisible in every other test here.
    const src = `var P = function P() { this.v = 0; };
var pp = P.prototype;
// 1 = "the default fired", 2 = "the argument came through as given". The
// discriminator is deliberately computed INSIDE the callee: returning the raw
// \`null\` instead would compare lanes on the null-return coercion, which is a
// separate (and pre-existing) divergence.
pp.m = function (a, b = 5) { if (b === 5) { return 1; } return 2; };
pp.padded = function () { return this.m(1); };
pp.explicitNull = function () { return this.m(1, null); };
pp.explicitUndef = function () { return this.m(1, undefined); };
export function test(): number {
  var p = new P();
  return p.padded() * 100 + p.explicitNull() * 10 + p.explicitUndef();
}`;
    const { direct, legacy, nopad } = await lanes(src);
    expect(tramp(direct, "P", "m", 1)).toBe(true);
    // node: 1, 2, 1.
    //
    // Read the FIRST digit as the pad's identity proof: a `ref.null.extern` pad
    // would leave `__extern_is_undefined` false (null is a DISTINCT value under
    // the #2106 singleton regime), the default would not fire, and `padded`
    // would answer 2 like `explicitNull` does. The MIDDLE digit is the converse
    // proof: an explicit `null` must NOT be turned into the default.
    expect(direct.run()).toBe(1 * 100 + 2 * 10 + 1);
    // S3 (padding-independent) already devirtualizes the EXACT-arity
    // `this.m(1, undefined)`, so `nopad` agrees. The fully dynamic lane answers
    // 122: an EXPLICIT `undefined` argument does not fire the callee's default
    // when it crosses `__call_m_*`. That is a pre-existing divergence from node
    // (reproducible with a plain top-level `p.m(1, undefined)` on every lane),
    // so the value is recorded per lane rather than averaged into an agreement
    // assertion — the two digits S3b owns (padded=1, explicit-null=2) are
    // identical on all three.
    expect(nopad.run()).toBe(1 * 100 + 2 * 10 + 1);
    expect(legacy.run()).toBe(1 * 100 + 2 * 10 + 2);
  });

  it("reads an under-applied formal with NO default as `undefined`", async () => {
    const src = `var P = function P() { this.v = 0; };
var pp = P.prototype;
pp.m = function (a, b, c) {
  var n = 0;
  if (b === undefined) { n = n + 20; }
  if (c === undefined) { n = n + 3; }
  return a + n;
};
pp.go = function () { return this.m(100); };
export function test(): number { var p = new P(); return p.go(); }`;
    const { direct, legacy, nopad } = await lanes(src);
    expect(tramp(direct, "P", "m", 1)).toBe(true);
    expect(direct.run()).toBe(123);
    expect(legacy.run()).toBe(123);
    expect(nopad.run()).toBe(123);
  });

  it("pads a ZERO-argument call into a multi-formal method", async () => {
    // `arity = 0` is the degenerate padding case: the trampoline has no user
    // parameter at all and synthesizes the whole argument list.
    const src = `var P = function P() { this.v = 7; };
var pp = P.prototype;
pp.m = function (a, b, c) {
  if (a === undefined && b === undefined && c === undefined) { return this.v; }
  return 0;
};
pp.go = function () { return this.m(); };
export function test(): number { var p = new P(); return p.go(); }`;
    const { direct, legacy, nopad } = await lanes(src);
    expect(tramp(direct, "P", "m", 0)).toBe(true);
    expect(direct.run()).toBe(7);
    expect(legacy.run()).toBe(7);
    expect(nopad.run()).toBe(7);
  });

  it("runs a SIDE-EFFECTING default expression exactly once, only when absent", async () => {
    // The counter is the instrument: a default that runs twice, or runs when the
    // argument WAS supplied, changes `this.n` and is visible in the result.
    const src = `var P = function P() { this.n = 0; };
var pp = P.prototype;
pp.tick = function () { this.n = this.n + 1; return 7; };
pp.m = function (a, b = this.tick()) { return a * 10 + b; };
pp.go = function () {
  var padded = this.m(1);
  var supplied = this.m(2, 3);
  return padded * 10000 + supplied * 100 + this.n;
};
export function test(): number { var p = new P(); return p.go(); }`;
    const { direct, legacy, nopad } = await lanes(src);
    expect(tramp(direct, "P", "m", 1)).toBe(true);
    // node: padded -> 1*10+7 = 17, supplied -> 23, ticks -> 1 => 172301.
    expect(direct.run()).toBe(17 * 10000 + 23 * 100 + 1);
    expect(legacy.run()).toBe(direct.run());
    expect(nopad.run()).toBe(direct.run());
  });

  it("pads recursive and mutually recursive under-applied calls", async () => {
    // `down` is BOTH the under-applied entry (arity 1) and the exact-arity
    // recursive edge (arity 2) — two trampolines onto one twin, the forward
    // reference the reserve-then-fill design exists for.
    const src = `var P = function P() { this.v = 0; };
var pp = P.prototype;
pp.down = function (n, acc) {
  if (acc === undefined) { acc = 0; }
  if (n <= 0) { return acc; }
  return this.down(n - 1, acc + n);
};
pp.even = function (n, depth) { if (n === 0) { return 1; } return this.odd(n - 1); };
pp.odd = function (n, depth) { if (n === 0) { return 0; } return this.even(n - 1); };
pp.go = function () { return this.down(5) * 100 + this.even(7) * 10 + this.odd(7); };
export function test(): number { var p = new P(); return p.go(); }`;
    const { direct, legacy, nopad } = await lanes(src);
    expect(tramp(direct, "P", "down", 1)).toBe(true);
    expect(tramp(direct, "P", "down", 2)).toBe(true);
    // `even` calls `odd`, declared LATER, under-applied (1 of 2 formals).
    expect(tramp(direct, "P", "odd", 1)).toBe(true);
    // node: down(5) -> 15, even(7) -> 0, odd(7) -> 1 => 1501.
    expect(direct.run()).toBe(15 * 100 + 0 * 10 + 1);
    expect(legacy.run()).toBe(direct.run());
    expect(nopad.run()).toBe(direct.run());
  });

  it("applies an f64-typed default through the ARGC path, not a value test", async () => {
    // A `number`-annotated formal lowers to a raw f64 param, whose default check
    // is `emitParamDefaultArgMissingCheck` — pure `__argc` arithmetic. This is
    // the pin that fails if the trampoline writes `formals` into `__argc`
    // instead of the call-site count (the default would then never fire).
    const src = `var P = function P() { this.v = 0; };
var pp = P.prototype;
pp.m = function (a: number, b: number = 5): number { return a * 10 + b; };
pp.one = function () { return this.m(1); };
pp.two = function () { return this.m(1, 2); };
export function test(): number { var p = new P(); return p.one() * 1000 + p.two(); }`;
    const { direct, legacy, nopad } = await lanes(src);
    expect(tramp(direct, "P", "m", 1)).toBe(true);
    expect(direct.run()).toBe(15012);
    expect(legacy.run()).toBe(15012);
    expect(nopad.run()).toBe(15012);
  });

  it("declines a padded slot that is NATIVE-typed with no default", async () => {
    // The body READS the raw bits of such a slot, whose legacy production is
    // `__unbox_number(<undefined>)` — a NaN that `i32.trunc_f64_s` would trap
    // on. Reproducing that is not worth a devirtualization, so the site keeps
    // the dynamic lowering; the exact-arity neighbour still devirtualizes.
    const src = `var P = function P() { this.v = 0; };
var pp = P.prototype;
pp.m = function (a: number, b: number): number { if (b !== b) { return 1; } return 2; };
pp.under = function () { return this.m(1); };
pp.exact = function () { return this.m(1, 2); };
export function test(): number { var p = new P(); return p.under() * 10 + p.exact(); }`;
    const { direct, legacy, nopad } = await lanes(src);
    expect(tramp(direct, "P", "m", 1)).toBe(false);
    expect(tramp(direct, "P", "m", 2)).toBe(true);
    expect(direct.run()).toBe(legacy.run());
    expect(direct.run()).toBe(nopad.run());
  });

  it("keeps OVER-application declined (the extras vector is a separate protocol)", async () => {
    const src = `var P = function P() { this.v = 0; };
var pp = P.prototype;
pp.two = function (a, b) { if (b === undefined) { return 1; } return 2; };
pp.over = function () { return this.two(1, 2, 3); };
pp.under = function () { return this.two(1); };
export function test(): number { var p = new P(); return p.over() * 10 + p.under(); }`;
    const { direct, legacy, nopad } = await lanes(src);
    expect(tramp(direct, "P", "two", 3)).toBe(false);
    expect(tramp(direct, "P", "two", 1)).toBe(true);
    expect(direct.run()).toBe(21);
    expect(legacy.run()).toBe(21);
    expect(nopad.run()).toBe(21);
  });

  it("leaves `arguments.length` intact for a neighbouring dynamic call", async () => {
    // A body reading `arguments` is never devirtualized (the extras protocol),
    // so its `arguments.length` still comes from the dynamic bridge. What S3b
    // owes is that the padded trampoline's `__argc` write/reset does not leak
    // into it — the calls are interleaved so a leaked value would be visible.
    const src = `var P = function P() { this.v = 0; };
var pp = P.prototype;
pp.pad = function (a, b) { if (b === undefined) { return 1; } return 2; };
pp.count = function (a, b, c) { return arguments.length; };
pp.go = function () {
  var x = this.pad(1);
  var y = this.count(1, 2);
  var z = this.pad(1);
  return x * 100 + y * 10 + z;
};
export function test(): number { var p = new P(); return p.go(); }`;
    const { direct, legacy, nopad } = await lanes(src);
    expect(tramp(direct, "P", "pad", 1)).toBe(true);
    expect(tramp(direct, "P", "count", 2)).toBe(false);
    // node: 1, 2, 1 => 121.
    expect(direct.run()).toBe(121);
    expect(legacy.run()).toBe(121);
    expect(nopad.run()).toBe(121);
  });

  it("keeps a detached (.call/.apply) under-applied receiver on the generic body", async () => {
    // The padding lives in the trampoline, which only in-twin `this.m(...)`
    // sites reach. A `.call` on a foreign object must still take the generic
    // body and its own dynamic widening.
    const src = `var P = function P(n) { this.pos = n; };
var pp = P.prototype;
pp.bump = function (k, extra) { if (k === undefined) { k = 1; } this.pos = this.pos + k; return this.pos; };
pp.inside = function () { return this.bump(); };
export function test(): number {
  var p = new P(0);
  var a = p.inside();
  var plain = { pos: 100 };
  var b = pp.bump.call(plain);
  var c = pp.bump.apply(plain, [5]);
  return a * 1000000 + b * 1000 + c;
}`;
    const { direct, legacy, nopad } = await lanes(src);
    // node: 1, then 101 on the plain object, then 106.
    expect(direct.run()).toBe(1 * 1000000 + 101 * 1000 + 106);
    expect(legacy.run()).toBe(direct.run());
    expect(nopad.run()).toBe(direct.run());
  });

  it("`nopad` reproduces the S3-only module and is byte-stable", async () => {
    // Two properties in one: (a) with only exact-arity sites, S3b and S3 are the
    // SAME module byte-for-byte — padding is inert where it does not apply; and
    // (b) with an under-applied site present, `nopad` really declines it, so the
    // A/B that measures S3b's delta is measuring the padding and nothing else.
    const exactOnly = `var P = function P() { this.v = 0; };
var pp = P.prototype;
pp.two = function (a, b) { if (b === undefined) { return 1; } return 2; };
pp.exact = function () { return this.two(1, 2); };
export function test(): number { var p = new P(); return p.exact(); }`;
    const on = await build(exactOnly);
    const nopad = await build(exactOnly, { JS2WASM_DIRECT_CALLS: "nopad" });
    expect(Buffer.from(nopad.binary).equals(Buffer.from(on.binary))).toBe(true);

    const mixed = `var P = function P() { this.v = 0; };
var pp = P.prototype;
pp.two = function (a, b) { if (b === undefined) { return 1; } return 2; };
pp.under = function () { return this.two(1); };
pp.exact = function () { return this.two(1, 2); };
export function test(): number { var p = new P(); return p.under() * 10 + p.exact(); }`;
    const mixedOn = await build(mixed);
    const mixedNopad1 = await build(mixed, { JS2WASM_DIRECT_CALLS: "nopad" });
    const mixedNopad2 = await build(mixed, { JS2WASM_DIRECT_CALLS: "nopad" });
    expect(tramp(mixedOn, "P", "two", 1)).toBe(true);
    expect(tramp(mixedNopad1, "P", "two", 1)).toBe(false);
    expect(tramp(mixedNopad1, "P", "two", 2)).toBe(true);
    // Deterministic — the isolation build is a usable control arm.
    expect(Buffer.from(mixedNopad1.binary).equals(Buffer.from(mixedNopad2.binary))).toBe(true);
    expect(Buffer.from(mixedNopad1.binary).equals(Buffer.from(mixedOn.binary))).toBe(false);
    expect(mixedOn.run()).toBe(12);
    expect(mixedNopad1.run()).toBe(12);
  });

  it("kill-switch still reproduces the pre-S3 lowering with padding available", async () => {
    const src = `var P = function P() { this.v = 0; };
var pp = P.prototype;
pp.m = function (a, b = 5) { return a * 10 + b; };
pp.go = function () { return this.m(1); };
export function test(): number { var p = new P(); return p.go(); }`;
    const off1 = await build(src, { JS2WASM_DIRECT_CALLS: "0" });
    const off2 = await build(src, { JS2WASM_DIRECT_CALLS: "0" });
    const on = await build(src);
    expect(Buffer.from(off1.binary).equals(Buffer.from(off2.binary))).toBe(true);
    expect(Buffer.from(off1.binary).equals(Buffer.from(on.binary))).toBe(false);
    // Under the kill-switch the twin keeps the S2 `__self` ABI.
    expect(off1.wat).toMatch(/__typed_this/);
    expect(off1.run()).toBe(15);
    expect(on.run()).toBe(15);
  });

  it("a padded call is SMALLER than the bridge it replaces", async () => {
    // Not a perf claim — a structural one: the trampoline is shared, so N padded
    // sites cost one instruction each plus one copy of the pad, which must not
    // exceed the `__call_m_*` sequence they removed.
    const calls = Array.from({ length: 10 }, () => `this.m(1)`).join(" + ");
    const src = `var P = function P() { this.v = 0; };
var pp = P.prototype;
pp.m = function (a, b, c) { if (b === undefined) { return a; } return 0; };
pp.go = function () { return ${calls}; };
export function test(): number { var p = new P(); return p.go(); }`;
    const on = await build(src);
    const nopad = await build(src, { JS2WASM_DIRECT_CALLS: "nopad" });
    expect(on.run()).toBe(10);
    expect(nopad.run()).toBe(10);
    expect(on.bytes).toBeLessThan(nopad.bytes);
  });
});
