/**
 * #6651 lane SG1 — three independent one-to-three-row generator defects on
 * `--target standalone`, batched under one control run.
 *
 * Each `describe` below is one cause. Every case was run against the reverted
 * sources (file-copy A/B, all three artifacts rebuilt per side, adapter key
 * confirming the revert) before the fix; the RED/GREEN state on base is recorded
 * per case.
 *
 * 1. **§27.5.3 GeneratorValidate `executing` guard** — the guard
 *    (`nativeGeneratorExecutingCheck`) and its flag maintenance already existed
 *    in full and were wired at all five entry points; the FIELD was minted only
 *    for generators carrying a delegation site, so a plain generator had no
 *    re-entrancy check at all. 3 standalone rows (`GeneratorPrototype/{next,
 *    return,throw}/from-state-executing.js`), 1 of which also failed on host.
 *
 * 2. **§27.5.1.5 iteration-result `[[Prototype]]`** — the native lane represents
 *    `{value, done}` as a closed WasmGC struct with no `$proto` link, so
 *    `Object.getPrototypeOf(g().next())` answered `null` while
 *    `hasOwnProperty(result, "value")` already answered correctly. 1 row.
 *
 * 3. **§19.2.1.3 step 5.d eval var/lex conflict inside a generator** — the
 *    direct-eval binding pre-pass is applied to function DECLARATIONS, but a
 *    generator body is compiled into a synthetic resume function, so the
 *    lexical-name set was empty and the SyntaxError was never raised. 2 rows,
 *    both of which also failed on host. The plain-function and arrow-function
 *    members of the same test262 family PASSED on base — that asymmetry is what
 *    localised it — and they are pinned here as negative controls.
 *
 * DELIBERATELY NOT FIXED. Two were pinned below in their spec-WRONG state
 * so a later lane trips an assertion instead of moving the boundary silently:
 * calling `%GeneratorFunction%` (CreateDynamicFunction — slice A9 moved that
 * boundary, and its case now pins the new provider linkage), and `yield *` before
 * a newline (invalid Wasm from a `yield*` delegation-slot type disagreement —
 * costs `statements/generators/yield-star-before-newline.js`).
 *
 * A THIRD is diagnosed but deliberately NOT pinned, because its wrong answer is
 * not reachable from this harness: `delete` on a closed-struct own property
 * removes nothing (#4098's un-shipped visibility stage), which costs
 * `object/method-definition/{generator,name}-property-desc.js`. In this compile
 * lane that program answers spec-correctly under both goals — measured — so the
 * case below pins THAT correctness and records the reproduction recipe rather
 * than asserting a wrong answer it cannot produce.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown };

/**
 * `sloppy: true` sets `inferModuleStrictArguments: false` — the flag the test262
 * harness passes for a SCRIPT test. It is required for the §19.2.1.3 cases: the
 * eval var/lex collision rule applies to a SLOPPY direct eval only (the check is
 * gated on `!evalIsStrict`), and a bare `.ts` compilation unit carrying the
 * synthetic `export function test()` is inferred STRICT. Without it every eval
 * case here is vacuous — measured: the plain-function control, which passes as a
 * test262 row, answered "no throw" in this harness until the flag was added.
 */
async function run(src: string, opts: { sloppy?: boolean } = {}): Promise<unknown> {
  const options = {
    fileName: "t.ts",
    target: "standalone" as const,
    ...(opts.sloppy ? { inferModuleStrictArguments: false } : {}),
  };
  const r = (await compile(src, options)) as unknown as Compiled & { importObject?: WebAssembly.Imports };
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 400)}`).toBe(true);
  // Instantiating with NO import object is itself the host-free assertion.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#6651 SG1 · §27.5.3 GeneratorValidate — [[GeneratorState]] `executing`", () => {
  it("re-entrant .return() from inside the body throws TypeError", async () => {
    // RED on base: answered 1 (the call returned normally, no throw).
    const src = `let iter: any;
function* g() {
  try {
    iter.return(42);
    return;
  } catch (e: any) {
    if (e instanceof TypeError) throw new Error("__ok__");
    throw new Error("wrong-error");
  }
}
export function test(): number {
  iter = g();
  let r = 0;
  try { iter.next(); } catch (e: any) { if (e.message === "__ok__") r |= 1; else r |= 8; }
  return r;
}`;
    expect(await run(src)).toBe(1);
  });

  it("re-entrant .throw() from inside the body throws TypeError, not the argument", async () => {
    // RED on base: rethrew the ARGUMENT — a number — which is exactly what
    // test262 reports as "Thrown value was not an object!".
    const src = `let iter: any;
function* g() {
  try {
    iter.throw(42);
    return;
  } catch (e: any) {
    if (e instanceof TypeError) throw new Error("__ok__");
    throw new Error("threw-non-typeerror");
  }
}
export function test(): number {
  iter = g();
  let r = 0;
  try { iter.next(); } catch (e: any) { if (e.message === "__ok__") r |= 1; else r |= 8; }
  return r;
}`;
    expect(await run(src)).toBe(1);
  });

  it("re-entrant .next() from inside the body throws TypeError instead of recursing", async () => {
    // RED on base: RangeError "Maximum call stack size exceeded" — the guard's
    // absence made this unbounded recursion, not merely a wrong answer.
    const src = `let iter: any;
function* g() {
  try {
    iter.next();
    return;
  } catch (e: any) {
    if (e instanceof TypeError) throw new Error("__ok__");
    throw new Error("wrong-error");
  }
}
export function test(): number {
  iter = g();
  let r = 0;
  try { iter.next(); } catch (e: any) { if (e.message === "__ok__") r |= 1; else r |= 8; }
  return r;
}`;
    expect(await run(src)).toBe(1);
  });

  it("CONTROL — a generator that is NOT executing still accepts next/return/throw", async () => {
    // GREEN on base. The guard must refuse ONLY the `executing` state; a
    // suspended or completed generator keeps its ordinary answers, and a
    // delegating generator (which already had the field) is unchanged.
    const src = `function* g() { yield 1; yield 2; }
function* d() { yield* g(); }
export function test(): number {
  let r = 0;
  const a: any = g();
  if (a.next().value === 1) r |= 1;
  if (a.return(9).done === true) r |= 2;
  if (a.next().done === true) r |= 4;
  const b: any = g();
  b.next();
  try { b.throw(new Error("x")); } catch (e: any) { if (e.message === "x") r |= 8; }
  const c: any = d();
  if (c.next().value === 1 && c.next().value === 2 && c.next().done === true) r |= 16;
  return r;
}`;
    expect(await run(src)).toBe(31);
  });
});

describe("#6651 SG1 · §27.5.1.5 iteration result is an ordinary object", () => {
  it("getPrototypeOf(g().next()) is the one %Object.prototype%", async () => {
    // RED on base: answered `null` (bit 4 unset, bit 8 set).
    const src = `function* g() {}
export function test(): number {
  const result: any = g().next();
  let r = 0;
  if (Object.prototype.hasOwnProperty.call(result, "value")) r |= 1;
  if (Object.prototype.hasOwnProperty.call(result, "done")) r |= 2;
  if (Object.getPrototypeOf(result) === Object.prototype) r |= 4;
  if (Object.getPrototypeOf(result) !== null) r |= 8;
  return r;
}`;
    expect(await run(src)).toBe(15);
  });

  it("holds for a yielding generator and for a result that crossed a binding", async () => {
    // RED on base. The second half is the reason the fix is a RUNTIME `ref.test`
    // arm and not a static fold: through an `any` binding the struct identity is
    // erased from the static type, which is exactly the corpus spelling.
    const src = `function* g() { yield "s"; }
function idy(v: any): any { return v; }
export function test(): number {
  const it: any = g();
  const first: any = it.next();
  const viaCall: any = idy(it.next());
  let r = 0;
  if (Object.getPrototypeOf(first) === Object.prototype) r |= 1;
  if (Object.getPrototypeOf(viaCall) === Object.prototype) r |= 2;
  return r;
}`;
    expect(await run(src)).toBe(3);
  });

  it("CONTROL — the arm claims ONLY the result struct, not the generator itself", async () => {
    // GREEN on base, and it is the guard that the `ref.test` chain did not
    // widen: a generator object's own [[Prototype]] is %GeneratorPrototype%,
    // which must stay distinct from %Object.prototype%.
    const src = `function* g() { yield 1; }
export function test(): number {
  const it: any = g();
  let r = 0;
  if (Object.getPrototypeOf(it) !== Object.prototype) r |= 1;
  if (Object.getPrototypeOf({}) === Object.prototype) r |= 2;
  if (Object.getPrototypeOf(Object.create(null)) === null) r |= 4;
  return r;
}`;
    expect(await run(src)).toBe(7);
  });
});

describe("#6651 SG1 · §19.2.1.3 step 5.d — eval `var` across a generator-body `let`", () => {
  it("a direct eval declaring a var that collides with a body `let` throws SyntaxError", async () => {
    // RED on base: no exception at all (the resume function's lexical-name set
    // was empty, so the collision could not be detected).
    const src = `function* g() {
  let x;
  eval("var x;");
}
export function test(): number {
  const iter: any = g();
  let r = 0;
  try { iter.next(); } catch (e: any) { if (e instanceof SyntaxError) r |= 1; else r |= 8; }
  return r;
}`;
    expect(await run(src, { sloppy: true })).toBe(1);
  });

  it("the same for a generator EXPRESSION, and for a `const` / nested block", async () => {
    // RED on base for all three.
    const src = `const ge = function* () {
  let x;
  eval("var x;");
};
function* gc() {
  const y = 1;
  eval("var y;");
}
function* gb() {
  {
    let z;
    eval("var z;");
  }
}
export function test(): number {
  let r = 0;
  try { (ge() as any).next(); } catch (e: any) { if (e instanceof SyntaxError) r |= 1; }
  try { (gc() as any).next(); } catch (e: any) { if (e instanceof SyntaxError) r |= 2; }
  try { (gb() as any).next(); } catch (e: any) { if (e instanceof SyntaxError) r |= 4; }
  return r;
}`;
    expect(await run(src, { sloppy: true })).toBe(7);
  });

  it("CONTROL — a `var` or a NON-COLLIDING name must NOT throw", async () => {
    // GREEN on base, and the case a careless fix breaks: the conflict is only
    // with a LEXICAL declaration. A same-named `var` lives in the very
    // VariableEnvironment the eval declaration targets, so it is legal, and an
    // unrelated name is never a conflict.
    const src = `function* gv() {
  var x = 1;
  eval("var x;");
  yield x;
}
function* gn() {
  let a;
  eval("var b;");
  yield 1;
}
export function test(): number {
  let r = 0;
  try { (gv() as any).next(); r |= 1; } catch (e: any) { r |= 16; }
  try { (gn() as any).next(); r |= 2; } catch (e: any) { r |= 32; }
  return r;
}`;
    expect(await run(src, { sloppy: true })).toBe(3);
  });

  it("CONTROL — the plain-function and arrow members of the family are unchanged", async () => {
    // GREEN on base (these are the test262 rows that already PASSED, and the
    // asymmetry that localised the defect). The syntactic fallback must not
    // change them: it runs only when the reified set is empty.
    const src = `function f() {
  let x;
  eval("var x;");
}
const af = () => {
  let y;
  eval("var y;");
};
export function test(): number {
  let r = 0;
  try { f(); } catch (e: any) { if (e instanceof SyntaxError) r |= 1; }
  try { af(); } catch (e: any) { if (e instanceof SyntaxError) r |= 2; }
  return r;
}`;
    expect(await run(src, { sloppy: true })).toBe(3);
  });

  it("CONTROL — an outer function's `let` is not an intervening record for a nested eval", async () => {
    // GREEN on base. The syntactic walk stops at the nearest function-like
    // ancestor: a direct eval inside the nested function targets THAT
    // function's VariableEnvironment, so the generator's `let x` is not a
    // conflict and this must not throw.
    const src = `function* g() {
  let x;
  const inner = function () {
    eval("var x;");
    return 5;
  };
  yield inner();
}
export function test(): number {
  let r = 0;
  try { r = ((g() as any).next().value as number) === 5 ? 1 : 4; } catch (e: any) { r = 8; }
  return r;
}`;
    expect(await run(src, { sloppy: true })).toBe(1);
  });
});

describe("#6651 SG1 · residuals pinned in their current (spec-WRONG) state", () => {
  it("`delete` of an object-literal method is CORRECT in this lane — the residual is harness-shaped", async () => {
    // This case is deliberately NOT a pin of the wrong answer, because the wrong
    // answer is not reachable here. The two
    // `object/method-definition/{generator,name}-property-desc.js` rows fail on
    // standalone for a real reason: `delete o.method` reports TRUE, the property
    // survives, and `hasOwnProperty` keeps answering from the closed-struct
    // shape. Isolated with `runTest262File` on a hand-instrumented copy of the
    // row, the failing step is `propertyHelper.js`'s `isConfigurable`, and the
    // observed bits were `delResult=true stillOwn=true typeofAfter=function`.
    // A `ref.test`-guarded clearField DOES execute (proved with an injected
    // `unreachable`), so the field is reset — the read and `hasOwnProperty` just
    // do not consult it. That is #4098's un-shipped own-property VISIBILITY
    // stage, whose ordering law forbids shipping visibility before deletability,
    // and a class instance reproduces it identically, so it is not generator
    // work at all. Left for that lane.
    //
    // Under BOTH goals of this compile lane the same program answers the
    // spec-correct 1 — measured, which is why no pin is claimed. What IS pinned
    // is that correctness, so a regression in the reachable lane trips here.
    const src = `export function test(): number {
  const o: any = { *method() {} };
  let r = 0;
  if ((delete o.method) === true) r |= 1;
  if (Object.prototype.hasOwnProperty.call(o, "method")) r |= 2;
  if (typeof o.method === "function") r |= 4;
  const p: any = { m() {} };
  delete p.m;
  if (Object.prototype.hasOwnProperty.call(p, "m")) r |= 8;
  return r;
}`;
    expect(await run(src)).toBe(1);
    expect(await run(src, { sloppy: true })).toBe(1);
  });

  it("BOUNDARY MOVED (#6651 A9) — calling %GeneratorFunction% now links the runtime-eval provider", async () => {
    // This case used to pin the spec-WRONG answer (15: the call yielded a
    // non-callable object). Slice A9 routes the call to the realm's own
    // CreateDynamicFunction, so the module can no longer instantiate with the
    // empty import object this harness uses: it imports exactly the two provider
    // entries, and nothing else. The behaviour itself is pinned against a linked
    // provider in `issue-6651-a9-generator-function.test.ts`.
    const src = `export function test(): number {
  const GF: any = Object.getPrototypeOf(function* () {}).constructor;
  const made: any = GF("x", "");
  return typeof made === "function" ? 1 : 0;
}`;
    const r = (await compile(src, { fileName: "t.ts", target: "standalone" })) as unknown as Compiled;
    expect(r.success).toBe(true);
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary)).map((i) => `${i.module}::${i.name}`);
    expect(imports.sort()).toEqual([
      "js2wasm:runtime-eval::__runtime_apply_interpreted",
      "js2wasm:runtime-eval::__runtime_indirect_eval",
    ]);
  });

  it("PINNED WRONG — `yield *` before a newline emits INVALID Wasm", async () => {
    // Pre-existing (recorded by slice A1, re-verified by this lane against the
    // current tree): the module fails WASM VALIDATION with
    //   __gen_resume_g: local.tee[0] expected (ref null N), found ref.as_non_null of (ref eq)
    // i.e. the #2170 `yield*` delegation SLOT is laid out at the resolved inner
    // state type while the emit site produces the unresolved `eqref` form — a
    // two-pass disagreement in the hottest `yield*` path. Left alone
    // deliberately rather than risking every delegation site for one row; it
    // costs `statements/generators/yield-star-before-newline.js`.
    const src = `function* g() {
  yield *
  g2();
}
function* g2() {}
export function test(): number {
  const r: any = g().next();
  return r.done === true ? 1 : 0;
}`;
    await expect(run(src)).rejects.toThrow(/CompileError|local\.tee/);
  });
});
