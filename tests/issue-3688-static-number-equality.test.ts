/**
 * #3688 — statically-`number` equality must not go through the generic ladder.
 *
 * DIAGNOSIS (this is why the fix is a HINT, not a new lowering arm).
 * `compileBinaryExpression` computes a `numericHint` and passes it DOWN into
 * both operand emitters, but the `isNumericOp` list that guards it contains
 * `+ - * / %`, the four relationals and the six bitwise ops and NOT
 * `=== !== == !=`. So equality compiled its operands in their *natural*
 * representation. For an operand whose natural representation is boxed — the
 * legacy element-access path emits `array.get` → `__box_number` → externref so
 * it can express the out-of-bounds `undefined` — the typed dispatch then saw
 * externref × f64, boxed the f64 side too, and fell into the inline
 * abstract-equality cascade, which ends in `__str_flatten` ×2 + `__str_equals`:
 * an object→string conversion and a STRING COMPARISON for `tk[i] === 40`.
 *
 * The same expression with `<` instead of `===` already compiled to a bare
 * `array.get` + `f64.lt`, purely because `<` is in `isNumericOp`. So the fast
 * arm was not missing and was not mis-ordered — the operands simply never
 * arrived unboxed. Hinting the operands is therefore the WHOLE-CHAIN fix
 * (#3673's law: narrowing a comparison while its operands stay boxed measured
 * as a 2.7x pessimization in round 36); the element read is produced unboxed in
 * the first place rather than boxed and then unboxed back.
 *
 * CARVE-OUT. TypeScript index signatures are unsound: `tk[9]` is typed `number`
 * but is `undefined` at runtime, and the f64 lowering represents that as NaN.
 * NaN and undefined agree under every operator the hint already covered, but
 * DISAGREE under equality in exactly one pairing — `undefined === undefined` is
 * true, `NaN === NaN` is false. Measured on this tree: an unrefined gate flipped
 * `s.tk[9] === s.tk[8]` from true to false. The gate therefore also requires at
 * least one operand that can never be `undefined` (a literal, a computed
 * arithmetic result, or an f64/i32/i64 local slot), which keeps every
 * `tk[i] === <code>` site and costs only element-vs-element. `JS2WASM_STATIC_
 * NUMBER_EQ=0` restores the pre-#3688 lowering for differential testing.
 *
 * The pins below are in three groups:
 *   (1) SHAPE — disassembly assertions that the narrowed site emits no
 *       `__box_number`, no unbox, and no string comparison, with a positive
 *       control (a genuinely dynamic operand) proving the ladder still exists
 *       and the pin would otherwise have caught it;
 *   (2) SEMANTICS — §7.2.15 for `NaN` (`NaN !== NaN`) and signed zero
 *       (`+0 === -0`), which is exactly what `f64.eq` gives, plus `Object.is`
 *       as the contrast case that must NOT follow `f64.eq`;
 *   (3) NON-GOALS — mixed-type and dynamic/boxed operands must keep the
 *       generic path, since narrowing those would change observable results.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function build(source: string, opts: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await buildInner(source, opts);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}

async function buildInner(source: string, opts: Record<string, unknown> = {}) {
  const r = await compile(source, {
    fileName: "t.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    emitWat: true,
    ...opts,
  });
  expect(r.success).toBe(true);
  const module = await WebAssembly.compile(r.binary as BufferSource);
  expect(WebAssembly.Module.imports(module).length).toBe(0);
  const { exports } = await WebAssembly.instantiate(module, {});
  return { wat: r.wat ?? "", exports: exports as Record<string, (...a: never[]) => unknown> };
}

/**
 * Body of one function, with `call N` resolved to the callee's name so the
 * assertions can talk about `__box_number` / `__str_equals` rather than indices.
 */
function funcBody(wat: string, name: string): string {
  const lines = wat.split("\n");
  const names: string[] = [];
  for (const l of lines) {
    const imp = /^\s*\(import "[^"]*" "([^"]+)" \(func/.exec(l);
    if (imp) {
      names.push(imp[1]!);
      continue;
    }
    const fn = /^\s*\(func \$([^\s()]+)/.exec(l);
    if (fn) names.push(fn[1]!);
  }
  const start = lines.findIndex((l) => new RegExp(`\\(func \\$${name}[\\s()]`).test(l));
  expect(start, `func $${name} not found`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  let depth = 0;
  let seen = false;
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i]!;
    const cm = /\bcall (\d+)\b/.exec(raw);
    out.push(cm ? `${raw}   ;; ${names[Number(cm[1])] ?? "?"}` : raw);
    for (const ch of raw) {
      if (ch === "(") {
        depth++;
        seen = true;
      } else if (ch === ")") depth--;
    }
    if (seen && depth <= 0) break;
  }
  return out.join("\n");
}

/** Helpers whose presence means the generic abstract-equality ladder was reached. */
const LADDER = ["__box_number", "__unbox_number", "__str_equals", "__str_flatten", "__typeof_bigint", "__to_bigint"];

function expectNoLadder(body: string) {
  for (const helper of LADDER) expect(body, `expected no ${helper}`).not.toContain(helper);
}

// The shape from #3673 round 38: a tokenizer comparing the current code unit
// against a literal, with the buffer reached through a class field. This is the
// exact expression that emitted 2 `__box_number` + 2 `__unbox_number` +
// `__str_flatten` ×2 + `__str_equals` before the fix.
const TOKENIZER_SHAPE = `type i32 = number;
class St {
  tk: number[];
  pos: i32;
  constructor(t: number[]) { this.tk = t; this.pos = 0; }
}
export function eqLit(s: St): boolean { return s.tk[s.pos] === 40; }
export function neLit(s: St): boolean { return s.tk[s.pos] !== 40; }
export function ltLit(s: St): boolean { return s.tk[s.pos] < 40; }
export function eqExpr(s: St, j: i32): boolean { return s.tk[s.pos] === j + 1; }
export function eqElem(s: St, j: i32): boolean { return s.tk[s.pos] === s.tk[j]; }
export function test(): i32 {
  const s: St = new St([40, 41, 32]);
  let acc: i32 = 0;
  if (eqLit(s)) acc = acc + 1;
  if (neLit(s)) acc = acc + 10;
  if (ltLit(s)) acc = acc + 100;
  if (eqElem(s, 0)) acc = acc + 1000;
  if (eqExpr(s, 39)) acc = acc + 10000;
  return acc;
}`;

describe("#3688 shape — the narrowed site emits no boxing and no string compare", () => {
  it("`tk[i] === 40` through a class field compiles to array.get + f64.eq", async () => {
    const { wat, exports } = await build(TOKENIZER_SHAPE);
    const body = funcBody(wat, "eqLit");
    expectNoLadder(body);
    expect(body).toContain("array.get");
    expect(body).toContain("f64.eq");
    // Result still correct: tk[0] === 40 true, !== 40 false, < 40 false,
    // tk[0] === tk[0] true, tk[0] === 39+1 true.
    expect(exports.test!()).toBe(11001);
  });

  it("`!==` shares the ladder and gets the same treatment (f64.ne)", async () => {
    const { wat } = await build(TOKENIZER_SHAPE);
    const body = funcBody(wat, "neLit");
    expectNoLadder(body);
    expect(body).toContain("f64.ne");
  });

  it("a computed operand (`tk[i] === j + 1`) counts as never-undefined and narrows", async () => {
    const { wat } = await build(TOKENIZER_SHAPE);
    const body = funcBody(wat, "eqExpr");
    expectNoLadder(body);
    expect(body).toContain("f64.eq");
  });

  it("CARVE-OUT — element vs element keeps the generic path (both sides may be undefined)", async () => {
    // TS index signatures are unsound: `tk[9]` is typed `number` but is
    // `undefined` at runtime. The f64 lowering represents that as NaN, and
    // `undefined === undefined` is TRUE while `NaN === NaN` is FALSE — the one
    // pairing where the two lowerings disagree. Narrowing therefore requires at
    // least one operand that can never be undefined; element-vs-element has
    // none, so it deliberately keeps the boxed comparison. See the semantic pin
    // below for the observable behaviour this protects.
    const { wat } = await build(TOKENIZER_SHAPE);
    const body = funcBody(wat, "eqElem");
    // NB: the generic ladder contains an `f64.eq` of its own inside the
    // typeof-number arm, so "did not narrow" is asserted via the BOXING, which
    // only the generic path emits.
    expect(body).toContain("__box_number");
    expect(body).toContain("__unbox_number");
  });

  it("relational was ALREADY narrow — equality now matches it", async () => {
    // The control that identified the root cause: `<` differed from `===` on a
    // byte-identical expression only because `<` is in `isNumericOp`.
    const { wat } = await build(TOKENIZER_SHAPE);
    expectNoLadder(funcBody(wat, "ltLit"));
    expect(funcBody(wat, "ltLit")).toContain("f64.lt");
  });

  it("DIFFERENTIAL — with the narrowing OFF the same site emits the full ladder", async () => {
    // `JS2WASM_STATIC_NUMBER_EQ=0` reproduces the pre-#3688 lowering, so this
    // pin shows exactly what the change bought AND that the same source still
    // answers identically both ways. Without it, the shape assertions above
    // could be satisfied by a source the checker happened to type f64 anyway.
    const off = await build(TOKENIZER_SHAPE, {}, { JS2WASM_STATIC_NUMBER_EQ: "0" });
    const on = await build(TOKENIZER_SHAPE);
    const offBody = funcBody(off.wat, "eqLit");
    expect(offBody).toContain("__box_number");
    expect(offBody).toContain("__str_equals");
    expect(funcBody(on.wat, "eqLit")).not.toContain("__box_number");
    // Same observable answer through both lowerings.
    expect(on.exports.test!()).toBe(off.exports.test!());
  });

  it("POSITIVE CONTROL — a dynamic operand still reaches the generic ladder", async () => {
    // Without this, the pins above could pass because the ladder was deleted
    // outright rather than bypassed for proven-numeric operands.
    const { wat } = await build(`
export function dyn(a: any, b: any): boolean { return a === b; }
export function test(): number { return dyn(1, 1) ? 1 : 0; }`);
    const body = funcBody(wat, "dyn");
    const reached = LADDER.some((h) => body.includes(h)) || body.includes("__any_strict_eq");
    expect(reached, "dynamic `===` must still use the generic path").toBe(true);
  });
});

describe("#3688 semantics — §7.2.15 for NaN and signed zero", () => {
  it("NaN !== NaN, and NaN === NaN is false, on the narrowed path", async () => {
    const { exports } = await build(`type i32 = number;
class St { tk: number[]; constructor(t: number[]) { this.tk = t; } }
export function test(): i32 {
  const s: St = new St([NaN, 0, -0]);
  let acc: i32 = 0;
  if (s.tk[0] === s.tk[0]) acc = acc + 1;      // NaN === NaN  -> false
  if (s.tk[0] !== s.tk[0]) acc = acc + 10;     // NaN !== NaN  -> true
  const n: number = NaN;
  if (n === n) acc = acc + 100;                // false
  if (n !== n) acc = acc + 1000;               // true
  return acc;
}`);
    expect(exports.test!()).toBe(1010);
  });

  it("+0 === -0 is true and +0 !== -0 is false on the narrowed path", async () => {
    const { exports } = await build(`type i32 = number;
class St { tk: number[]; constructor(t: number[]) { this.tk = t; } }
export function test(): i32 {
  const s: St = new St([0, -0]);
  let acc: i32 = 0;
  if (s.tk[0] === s.tk[1]) acc = acc + 1;      // +0 === -0 -> true
  if (s.tk[0] !== s.tk[1]) acc = acc + 10;     // false
  const p: number = 0;
  const m: number = -0;
  if (p === m) acc = acc + 100;                // true
  if (m === p) acc = acc + 1000;               // true
  return acc;
}`);
    expect(exports.test!()).toBe(1101);
  });

  it("Object.is keeps SameValue — it must NOT follow f64.eq", async () => {
    // The contrast case: `f64.eq` is the right answer for `===` precisely
    // because §7.2.15 is Number::equal, NOT SameValue. If a future change
    // routed `Object.is` through the same narrowing, these flip.
    const { exports } = await build(`
export function test(): number {
  let acc: number = 0;
  if (Object.is(NaN, NaN)) acc = acc + 1;      // true
  if (Object.is(0, -0)) acc = acc + 10;        // false
  return acc;
}`);
    expect(exports.test!()).toBe(1);
  });

  it("loose `==` between two numbers agrees with `===` (SameType, §7.2.15 step 1)", async () => {
    const { exports } = await build(`type i32 = number;
class St { tk: number[]; constructor(t: number[]) { this.tk = t; } }
export function test(): i32 {
  const s: St = new St([40, 40, NaN]);
  let acc: i32 = 0;
  if (s.tk[0] == s.tk[1]) acc = acc + 1;       // true
  if (s.tk[2] == s.tk[2]) acc = acc + 10;      // NaN == NaN -> false
  if (s.tk[2] != s.tk[2]) acc = acc + 100;     // true
  return acc;
}`);
    expect(exports.test!()).toBe(101);
  });

  it("fractional values are compared exactly (no i32 truncation)", async () => {
    // Guards the choice NOT to extend the i32 terms of the hint to equality:
    // `1.2 === 1.8` under an i32 hint would truncate both to 1 and answer true.
    const { exports } = await build(`type i32 = number;
class St { tk: number[]; constructor(t: number[]) { this.tk = t; } }
export function test(): i32 {
  const s: St = new St([1.2, 1.8, 1.2]);
  let acc: i32 = 0;
  if (s.tk[0] === s.tk[1]) acc = acc + 1;      // 1.2 === 1.8 -> false
  if (s.tk[0] === s.tk[2]) acc = acc + 10;     // true
  const a: number = 1.5;
  const b: number = 1.9;
  if (a === b) acc = acc + 100;                // false
  return acc;
}`);
    expect(exports.test!()).toBe(10);
  });
});

describe("#3688 non-goals — dynamic and mixed-type equality is unchanged", () => {
  it("mixed-type comparisons stay generic and keep their answers", async () => {
    const { exports } = await build(`
export function test(): number {
  let acc: number = 0;
  const n: number = 1;
  const s: string = "1";
  if ((n as any) === (s as any)) acc = acc + 1;        // === across types -> false
  if ((n as any) == (s as any)) acc = acc + 10;        // == coerces -> true
  if ((n as any) === (true as any)) acc = acc + 100;   // false
  if ((n as any) == (true as any)) acc = acc + 1000;   // true
  return acc;
}`);
    expect(exports.test!()).toBe(1010);
  });

  it("`number | undefined` operands are left exactly as they were", async () => {
    // `isNumberType` rejects unions, so the gate never fires here. The lane
    // that DOES apply — the compiler's own pre-existing choice to give a
    // `number | undefined` parameter an f64 slot, which is why
    // `cmp(undefined, undefined)` already answered false before #3688 — is out
    // of scope and must be untouched. Asserted differentially so this pin
    // tracks "unchanged", not "correct".
    const src = `
export function cmp(a: number | undefined, b: number | undefined): boolean { return a === b; }
export function test(): number {
  let acc: number = 0;
  if (cmp(1, 1)) acc = acc + 1;
  if (cmp(1, 2)) acc = acc + 10;
  return acc;
}`;
    const on = await build(src);
    const off = await build(src, {}, { JS2WASM_STATIC_NUMBER_EQ: "0" });
    expect(funcBody(on.wat, "cmp")).toBe(funcBody(off.wat, "cmp"));
    expect(on.exports.test!()).toBe(off.exports.test!());
    expect(on.exports.test!()).toBe(1);
  });

  it("out-of-bounds reads still compare as `undefined`, not as NaN", async () => {
    // The behaviour the carve-out exists to preserve. `s.tk[9] === s.tk[8]` is
    // `undefined === undefined` in JS, i.e. TRUE; a narrowed f64 compare would
    // answer FALSE. Measured against the pre-#3688 tree: unrefined narrowing
    // flipped this pin, the refined gate leaves it untouched.
    const { exports } = await build(`type i32 = number;
class St { tk: number[]; constructor(t: number[]) { this.tk = t; } }
export function test(): i32 {
  const s: St = new St([1, 2, 3]);
  let acc: i32 = 0;
  if (s.tk[9] === s.tk[8]) acc = acc + 1;     // undefined === undefined -> true
  if (s.tk[9] === 40) acc = acc + 10;         // undefined === 40 -> false (narrowed: NaN === 40, also false)
  if (s.tk[9] !== 40) acc = acc + 100;        // true, on both lowerings
  return acc;
}`);
    expect(exports.test!()).toBe(101);
  });

  it("string and boolean equality is untouched", async () => {
    const { exports } = await build(`
export function test(): number {
  let acc: number = 0;
  const a: string = "ab";
  const b: string = "a" + "b";
  if (a === b) acc = acc + 1;
  const t: boolean = true;
  if (t === true) acc = acc + 10;
  if ((a as any) === (b as any)) acc = acc + 100;
  return acc;
}`);
    expect(exports.test!()).toBe(111);
  });

  it("object identity equality is untouched", async () => {
    const { exports } = await build(`
class C { v: number; constructor(v: number) { this.v = v; } }
export function test(): number {
  let acc: number = 0;
  const x: C = new C(1);
  const y: C = new C(1);
  const z: C = x;
  if (x === y) acc = acc + 1;    // distinct allocations -> false
  if (x === z) acc = acc + 10;   // same reference -> true
  if (x !== y) acc = acc + 100;  // true
  return acc;
}`);
    expect(exports.test!()).toBe(110);
  });

  it("wrapper objects keep object-identity equality, not numeric", async () => {
    const { exports } = await build(`
export function test(): number {
  let acc: number = 0;
  const a: any = new Number(1);
  const b: any = new Number(1);
  if (a === b) acc = acc + 1;    // distinct objects -> false
  if (a === a) acc = acc + 10;   // true
  if (a == 1) acc = acc + 100;   // ToPrimitive -> true
  return acc;
}`);
    expect(exports.test!()).toBe(110);
  });
});
