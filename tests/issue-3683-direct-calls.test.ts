/**
 * #3683 S3 — direct-call devirtualization between typed twins.
 *
 * Inside a typed twin, `this.<m>(...)` on a write-once prototype method of the
 * SAME fnctor lowers to `local.get <this>; <args>; call $__dc_<F>_<m>_<n>` —
 * one direct call with native-typed arguments — instead of the
 * `__call_m_*` → `__method_cache_lookup` → `__call_fn_method_N` → `call_ref`
 * bridge that the #3673 round-25 profile measured at ≈13% of the parse.
 *
 * The pins cover the two ways this can go wrong:
 *   (1) a devirtualized call must be OBSERVATIONALLY identical to the dynamic
 *       one — same value, same side-effect ORDER, same `this` inside nested
 *       calls, same behaviour under recursion; and
 *   (2) every construct the analysis cannot prove must DECLINE and keep the
 *       dynamic lowering (reassigned slots, own-property shadows, arity skew,
 *       detached receivers, `arguments`, optional calls).
 *
 * `JS2WASM_DIRECT_CALLS=0` is the whole-slice kill-switch: it reverts the twin
 * receiver-parameter ABI as well as the call sites.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type CompileOut = { wat: string; run: () => unknown; bytes: number };

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
    // Standalone means host-free: a devirtualized call must not have smuggled
    // in an import.
    expect(WebAssembly.Module.imports(module).length).toBe(0);
    const { exports } = await WebAssembly.instantiate(module, {});
    return {
      wat: r.wat ?? "",
      bytes: r.binary?.length ?? 0,
      run: () => (exports as { test: () => unknown }).test(),
    };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}

/** Compile with S3 on and off; both must produce the same observable result. */
async function bothLanes(source: string): Promise<{ direct: CompileOut; dynamic: CompileOut }> {
  const direct = await build(source);
  const dynamic = await build(source, { JS2WASM_DIRECT_CALLS: "0" });
  return { direct, dynamic };
}

/** Did `F.m` get a direct-call trampoline? */
function devirtualized(out: CompileOut, className: string, method: string): boolean {
  return new RegExp(`__dc_${className}_${method}_\\d`).test(out.wat);
}

function namedFunctionBody(out: CompileOut, name: string): string {
  // Include the delimiter so `__dc_P_m_1` does not accidentally select the
  // guarded `__dc_P_m_1_g` sibling when both are present.
  const start = out.wat.indexOf(`(func $${name} `);
  expect(start).toBeGreaterThanOrEqual(0);
  const tail = out.wat.slice(start + 1);
  const next = tail.search(/\n\s*\(func \$/);
  return out.wat.slice(start, next < 0 ? undefined : start + 1 + next);
}

describe("#3683 S3 — direct-call devirtualization", () => {
  it("devirtualizes this.m() inside a twin and agrees with the dynamic lowering", async () => {
    const src = `var P = function P(n) { this.pos = n; };
var pp = P.prototype;
pp.bump = function (k) { this.pos = this.pos + k; return this.pos; };
pp.twice = function (k) { return this.bump(k) + this.bump(k); };
export function test(): number { var p = new P(0); return p.twice(3); }`;
    const { direct, dynamic } = await bothLanes(src);
    expect(devirtualized(direct, "P", "bump")).toBe(true);
    expect(devirtualized(dynamic, "P", "bump")).toBe(false);
    // bump(3) -> 3, bump(3) -> 6 => 9. The value is the point: the callee
    // MUTATES the receiver, so a wrong `this` would be visible.
    expect(direct.run()).toBe(9);
    expect(dynamic.run()).toBe(9);
  });

  it("carries bare this in the typed receiver and removes the ambient receiver frame", async () => {
    const src = `var P = function P() {};
var pp = P.prototype;
pp.same = function (value) { return value === this ? 1 : 0; };
pp.go = function () { return this.same(this); };
export function test(): number { return new P().go(); }`;
    const direct = await build(src);
    const framed = await build(src, {
      JS2WASM_TWIN_RECEIVER_PARAM: "0",
      JS2WASM_ELIDE_UNUSED_ARGC_FRAME: "0",
    });
    expect(direct.run()).toBe(1);
    expect(framed.run()).toBe(1);

    const directTrampoline = namedFunctionBody(direct, "__dc_P_same_1");
    const framedTrampoline = namedFunctionBody(framed, "__dc_P_same_1");
    // This method has neither defaults nor `arguments`, so the optimized twin
    // needs no ambient frame writes. The control retains argc enter/leave plus
    // save/install/restore of `__current_this`.
    expect(directTrampoline.match(/global\.set/g) ?? []).toHaveLength(0);
    expect(framedTrampoline.match(/global\.set/g) ?? []).toHaveLength(4);
  });

  it("preserves side-effect ORDER across devirtualized calls", async () => {
    // The log is a base-10 digit trail rather than a string: a native string
    // crosses the standalone boundary as an opaque externref, so a number is
    // the only shape a host assertion can read exactly.
    const src = `var P = function P() { this.log = 0; };
var pp = P.prototype;
pp.note = function (d) { this.log = this.log * 10 + d; return this.log; };
pp.order = function () { this.note(1); this.note(2); return this.note(3); };
export function test(): number { var p = new P(); return p.order(); }`;
    const { direct, dynamic } = await bothLanes(src);
    expect(devirtualized(direct, "P", "note")).toBe(true);
    // 1, then 2, then 3 — appended in that order, so the trail reads 123. A
    // reordered or dropped call cannot produce this number.
    expect(direct.run()).toBe(123);
    expect(dynamic.run()).toBe(direct.run());
  });

  it("evaluates arguments left-to-right, before the receiver is installed", async () => {
    const src = `var P = function P() { this.log = 0; };
var pp = P.prototype;
pp.tag = function (d) { this.log = this.log * 10 + d; return d; };
pp.take = function (a, b) { return this.log; };
pp.go = function () { return this.take(this.tag(1), this.tag(2)); };
export function test(): number { var p = new P(); return p.go(); }`;
    const { direct } = await bothLanes(src);
    // Both argument sub-calls run BEFORE `take`'s body, in source order, so the
    // trail reads 12 — which is also what node answers for this program.
    //
    // The DYNAMIC lane is deliberately not compared here: it answers `NaN` on
    // this branch's base for a devirtualization-independent reason (a
    // dispatcher-read `this.log` after two nested `__call_m_*` frames). S3
    // happens to fix it by keeping the receiver in a register; pinning lane
    // agreement would pin the pre-existing bug instead.
    expect(direct.run()).toBe(12);
  });

  it("recurses through devirtualized calls (self- and mutual recursion)", async () => {
    const src = `var P = function P() { this.n = 0; };
var pp = P.prototype;
pp.down = function (n) { if (n <= 0) { return 0; } return n + this.down(n - 1); };
pp.even = function (n) { if (n === 0) { return 1; } return this.odd(n - 1); };
pp.odd = function (n) { if (n === 0) { return 0; } return this.even(n - 1); };
export function test(): number { var p = new P(); return p.down(10) * 100 + p.even(7) * 10 + p.odd(7); }`;
    const { direct, dynamic } = await bothLanes(src);
    expect(devirtualized(direct, "P", "down")).toBe(true);
    // `even` calls `odd`, defined LATER in the file — the forward reference the
    // reserve-then-fill trampoline exists for.
    expect(devirtualized(direct, "P", "odd")).toBe(true);
    expect(direct.run()).toBe(55 * 100 + 0 * 10 + 1);
    expect(dynamic.run()).toBe(direct.run());
  });

  it("calls a captured write-once method body directly while retaining its live closure", async () => {
    const src = `var bias = 7;
var adjust = function (k) { return k + bias; };
var P = function P(v) { this.v = v; };
var pp = P.prototype;
pp.add = function (k) { return this.v + adjust(k); };
pp.go = function (k) { return this.add(k); };
export function test(): number {
  var p = new P(1);
  var before = p.go(2);
  bias = 20;
  return before * 100 + p.go(2);
}`;
    const { direct, dynamic } = await bothLanes(src);
    expect(devirtualized(direct, "P", "add")).toBe(true);
    const directValue = direct.run();
    const dynamicValue = dynamic.run();
    expect(directValue).toBe(1023);
    expect(dynamicValue).toBe(directValue);

    const start = direct.wat.indexOf("(func $__dc_P_add_1");
    expect(start).toBeGreaterThanOrEqual(0);
    const trampoline = direct.wat.slice(start, start + 1800);
    // The WAT renderer currently numbers internal globals/functions. Pin the
    // structural distinction: test the retained closure global, reload that
    // SAME global in the hit arm, and call the lifted body directly. The miss
    // arm remains the legacy dispatcher for pre-initialization safety.
    expect(trampoline).toMatch(
      /global\.get (\d+)\s+ref\.is_null\s+i32\.eqz[\s\S]*?\(then\s+global\.get \1\s+ref\.as_non_null[\s\S]*?call \d+/,
    );
  });

  it("devirtualizes guarded this-calls inside a captured generic method body", async () => {
    const src = `var bias = 4;
var adjust = function (k) { return k + bias; };
var P = function P(v) { this.v = v; };
var pp = P.prototype;
pp.add = function (k) { return this.v + k; };
pp.go = function (k) { return this.add(adjust(k)); };
export function test(): number {
  var p = new P(3);
  var before = p.go(2);
  bias = 10;
  return before * 100 + p.go(2);
}`;
    const { direct, dynamic } = await bothLanes(src);
    expect(direct.wat).toMatch(/\(func \$__dc_P_add_1_g\b/);
    expect(dynamic.wat).not.toMatch(/\(func \$__dc_P_add_1_g\b/);
    const directValue = direct.run();
    const dynamicValue = dynamic.run();
    expect(directValue).toBe(915);
    expect(dynamicValue).toBe(directValue);
  });

  it("keeps .call / .apply detached receivers on the generic (non-twin) body", async () => {
    const src = `var P = function P(n) { this.pos = n; };
var pp = P.prototype;
pp.bump = function (k) { this.pos = this.pos + k; return this.pos; };
pp.twice = function (k) { return this.bump(k) + this.bump(k); };
export function test(): number {
  var p = new P(0);
  var inside = p.twice(3);
  var plain = { pos: 100 };
  var viaCall = pp.bump.call(plain, 5);
  var viaApply = pp.bump.apply(plain, [7]);
  return inside * 100000 + viaCall * 100 + viaApply;
}`;
    const { direct, dynamic } = await bothLanes(src);
    // 9 inside, 105 via .call on the plain object, 112 via .apply after it.
    expect(direct.run()).toBe(9 * 100000 + 105 * 100 + 112);
    expect(dynamic.run()).toBe(direct.run());
  });

  it("declines a REASSIGNED prototype method (no write-once verdict)", async () => {
    const src = `var P = function P(n) { this.pos = n; };
var pp = P.prototype;
pp.bump = function (k) { this.pos = this.pos + k; return this.pos; };
pp.call2 = function (k) { return this.bump(k); };
pp.bump = function (k) { this.pos = this.pos + k * 10; return this.pos; };
export function test(): number { var p = new P(0); return p.call2(3); }`;
    const { direct, dynamic } = await bothLanes(src);
    expect(devirtualized(direct, "P", "bump")).toBe(false);
    // The SECOND definition must win — the whole reason a reassigned slot
    // cannot be devirtualized.
    expect(direct.run()).toBe(30);
    expect(dynamic.run()).toBe(30);
  });

  it("declines on OVER-application; under-application is padded (S3b)", async () => {
    const src = `var P = function P() { this.v = 0; };
var pp = P.prototype;
pp.two = function (a, b) { if (b === undefined) { return 1; } return 2; };
pp.under = function () { return this.two(1); };
pp.over = function () { return this.two(1, 2, 3); };
pp.exact = function () { return this.two(1, 2); };
export function test(): number { var p = new P(); return p.under() * 100 + p.over() * 10 + p.exact(); }`;
    const { direct, dynamic } = await bothLanes(src);
    // `exact` devirtualizes, and since #3683 S3b so does `under` — through its
    // own arity-1 trampoline, which materializes the missing formal as the
    // canonical `undefined` (see tests/issue-3683-arity-padding.test.ts).
    // `over` still keeps the dynamic path: the extra arguments must be evaluated
    // for their side effects and routed into the `__extras_argv` vector, which
    // is a separate protocol from padding.
    expect(direct.wat).toMatch(/__dc_P_two_2/);
    expect(direct.wat).toMatch(/__dc_P_two_1\b/);
    expect(direct.wat).not.toMatch(/__dc_P_two_3/);
    // The observable answer is unchanged by S3b — that is the whole point.
    expect(direct.run()).toBe(1 * 100 + 2 * 10 + 2);
    expect(dynamic.run()).toBe(direct.run());
    // …and the S3-only lowering of the same program answers it too.
    const nopad = await build(src, { JS2WASM_DIRECT_CALLS: "nopad" });
    expect(nopad.wat).not.toMatch(/__dc_P_two_1\b/);
    expect(nopad.run()).toBe(direct.run());
  });

  it("declines when an own INSTANCE field shadows the method name", async () => {
    const src = `var P = function P(f) { this.hook = f; this.v = 5; };
var pp = P.prototype;
pp.hook = function () { return 1; };
pp.go = function () { return this.hook(); };
export function test(): number { var p = new P(function () { return 42; }); return p.go(); }`;
    const { direct, dynamic } = await bothLanes(src);
    expect(devirtualized(direct, "P", "hook")).toBe(false);
    // The own field must win over the prototype slot.
    expect(direct.run()).toBe(42);
    expect(dynamic.run()).toBe(42);
  });

  it("declines a callee that reads `arguments` (the extras protocol)", async () => {
    const src = `var P = function P() { this.v = 0; };
var pp = P.prototype;
pp.count = function (a) { return arguments.length + a; };
pp.go = function () { return this.count(5); };
export function test(): number { var p = new P(); return p.go(); }`;
    const { direct, dynamic } = await bothLanes(src);
    expect(devirtualized(direct, "P", "count")).toBe(false);
    expect(direct.run()).toBe(6);
    expect(dynamic.run()).toBe(6);
  });

  it("declines an optional call `this.m?.()`", async () => {
    const src = `var P = function P() { this.v = 3; };
var pp = P.prototype;
pp.get = function (k) { return this.v + k; };
pp.go = function () { return this.get?.(4); };
export function test(): number { var p = new P(); return p.go(); }`;
    const { direct, dynamic } = await bothLanes(src);
    expect(devirtualized(direct, "P", "get")).toBe(false);
    // The absolute value is deliberately NOT asserted: `this.m?.()` on a
    // prototype method answers 0 rather than 7 on this branch's BASE too — a
    // pre-existing gap, unrelated to S3. What S3 owes is that declining leaves
    // the lowering untouched, which is what lane agreement pins.
    expect(direct.run()).toBe(dynamic.run());
  });

  it("does not devirtualize a call on a NON-`this` receiver", async () => {
    const src = `var P = function P(n) { this.pos = n; this.peer = null; };
var pp = P.prototype;
pp.bump = function (k) { this.pos = this.pos + k; return this.pos; };
pp.viaPeer = function (k) { return this.peer.bump(k); };
export function test(): number {
  var a = new P(0); var b = new P(100);
  a.peer = b;
  return a.viaPeer(5);
}`;
    const { direct, dynamic } = await bothLanes(src);
    // The devirtualized receiver must be `this`, never a field read — the
    // shape proof is the twin's own cast and does not extend to `this.peer`.
    expect(direct.run()).toBe(105);
    expect(dynamic.run()).toBe(105);
  });

  it("keeps `this` correct inside a callee that itself calls back out", async () => {
    const src = `var P = function P(id) { this.id = id; this.trace = 0; };
var pp = P.prototype;
pp.mark = function () { this.trace = this.trace * 10 + this.id; return this.trace; };
pp.inner = function () { return this.mark(); };
pp.outer = function (other) { this.mark(); other.inner(); this.mark(); return this.trace * 1000 + other.trace; };
export function test(): number {
  var a = new P(1); var b = new P(2);
  return a.outer(b);
}`;
    const { direct, dynamic } = await bothLanes(src);
    // `other.inner()` is NOT devirtualized (the receiver is not `this`), so it
    // takes the dynamic bridge, which installs `b` into `__current_this`. The
    // trampoline's save/restore is what guarantees `a`'s frame still sees `a`
    // for the SECOND `this.mark()`.
    expect(devirtualized(direct, "P", "mark")).toBe(true);
    expect(direct.run()).toBe(11 * 1000 + 2);
    expect(dynamic.run()).toBe(direct.run());
  });

  it("carries native-typed arguments and results without a boxing round-trip", async () => {
    const src = `var P = function P(n) { this.pos = n; };
var pp = P.prototype;
pp.add = function (a, b) { return a + b + this.pos; };
pp.go = function () { return this.add(1.5, 2.25); };
export function test(): number { var p = new P(0.25); return p.go(); }`;
    const { direct, dynamic } = await bothLanes(src);
    expect(devirtualized(direct, "P", "add")).toBe(true);
    expect(direct.run()).toBe(4);
    expect(dynamic.run()).toBe(4);
  });

  it("devirtualizes a VOID-returning callee (the tokenizer's hottest shape)", async () => {
    // `this.next()` / `this.expect(...)` return nothing, so the twin has no
    // wasm result and the trampoline yields none either; the call site answers
    // VOID_RESULT and `compileExpression` materializes whatever the consuming
    // context needs. Statement position, value position (→ `undefined`) and a
    // `void`-typed comparison are all exercised.
    const src = `var P = function P() { this.v = 0; };
var pp = P.prototype;
pp.step = function (d) { this.v = this.v * 10 + d; };
pp.go = function () {
  this.step(1);
  var r = this.step(2);
  this.step(3);
  return this.v * 10 + (r === undefined ? 7 : 0);
};
export function test(): number { var p = new P(); return p.go(); }`;
    const { direct, dynamic } = await bothLanes(src);
    expect(devirtualized(direct, "P", "step")).toBe(true);
    // node answers 1237. S3 matches it; the DYNAMIC lane answers 1230 on this
    // branch's base — `var r = this.step(2)` does not observe `undefined` when
    // the call crosses `__call_m_*`. So this is one of two places where S3
    // *fixes* a pre-existing divergence rather than preserving it, and the pin
    // records the JS-correct value on both sides of that difference.
    expect(direct.run()).toBe(1237);
    expect(dynamic.run()).toBe(1230);
  });

  it("kill-switch reproduces the pre-S3 output byte-for-byte", async () => {
    // Two independent compiles under `JS2WASM_DIRECT_CALLS=0` must be
    // identical, and must differ from the S3 build — i.e. the switch is
    // deterministic and actually load-bearing. (The cross-commit identity to
    // the S2 tip is asserted in the issue's implementation notes; here we pin
    // that the switch reverts BOTH the call sites and the twin ABI.)
    const src = `var P = function P(n) { this.pos = n; };
var pp = P.prototype;
pp.bump = function (k) { this.pos = this.pos + k; return this.pos; };
pp.twice = function (k) { return this.bump(k) + this.bump(k); };
export function test(): number { var p = new P(0); return p.twice(3); }`;
    const off1 = await build(src, { JS2WASM_DIRECT_CALLS: "0" });
    const off2 = await build(src, { JS2WASM_DIRECT_CALLS: "0" });
    const on = await build(src);
    expect(off1.wat).toBe(off2.wat);
    expect(off1.wat).not.toBe(on.wat);
    // Under the kill-switch the twin keeps the S2 `__self` ABI, so its prologue
    // reads `__current_this` again instead of taking the receiver as param 0.
    expect(off1.wat).toMatch(/__typed_this/);
    expect(off1.run()).toBe(on.run());
  });

  it("still admits a twin (and its direct calls) when the class has many methods", async () => {
    // Guards the funcMap/name plumbing: the trampoline resolves its callee by
    // NAME at finalize, so a class whose twins are minted across many closures
    // must still pair each trampoline with the right twin.
    const methods = Array.from(
      { length: 12 },
      (_, i) => `pp.m${i} = function (k) { this.v = this.v + k + ${i}; return this.v; };`,
    ).join("\n");
    const calls = Array.from({ length: 12 }, (_, i) => `this.m${i}(1)`).join(" + ");
    const src = `var P = function P() { this.v = 0; };
var pp = P.prototype;
${methods}
pp.all = function () { return ${calls}; };
export function test(): number { var p = new P(); return p.all(); }`;
    const { direct, dynamic } = await bothLanes(src);
    for (let i = 0; i < 12; i++) expect(devirtualized(direct, "P", `m${i}`)).toBe(true);
    expect(direct.run()).toBe(dynamic.run());
  });
});
