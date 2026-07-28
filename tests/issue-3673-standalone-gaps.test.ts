/**
 * #3673 — standalone-lane correctness gaps found by bisecting the compiled-acorn
 * corpus failures (the `tests/dogfood/` pipeline parses all 17 fixtures exactly
 * on the JS-host lane, but six failed standalone).
 *
 * Each `describe` pins one root cause with (a) the minimal shape and (b) the
 * acorn shape that surfaced it, so a regression names the fixture it breaks.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function runStandalone(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "t.ts", skipSemanticDiagnostics: true, target: "standalone" });
  expect(r.binary?.length ?? 0).toBeGreaterThan(0);
  const module = await WebAssembly.compile(r.binary as BufferSource);
  expect(WebAssembly.Module.imports(module).length).toBe(0);
  const { exports } = await WebAssembly.instantiate(module, {});
  return (exports as { test?: () => unknown }).test?.();
}

describe("#3673 — String.prototype.substr on a dynamic receiver", () => {
  // `substr` is Annex-B, so it is deliberately absent from STRING_METHODS (that
  // table doubles as the JS-host `string_<method>` import manifest) — but a
  // native `__str_substr` arm exists, so the guarded any-receiver gate has to
  // admit the name explicitly (as it already did for `charCodeAt`).
  it("returns the requested slice, not the empty string", async () => {
    const got = await runStandalone(`export function test(): number {
  const s: any = "abcdef";
  const t: any = s.substr(1, 3);
  return t.length * 1000 + t.charCodeAt(0);
}`);
    expect(got).toBe(3098); // "bcd" — length 3, 'b' === 98
  });

  it("an omitted length runs to the end of the string", async () => {
    const got = await runStandalone(`export function test(): number {
  const s: any = "abcdef";
  return s.substr(2).length;
}`);
    expect(got).toBe(4);
  });

  it("a negative start counts back from the end (§B.2.2.1)", async () => {
    const got = await runStandalone(`export function test(): number {
  const s: any = "abcdef";
  const t: any = s.substr(-2, 1);
  return t.charCodeAt(0);
}`);
    expect(got).toBe(101); // "e"
  });

  it("acorn's octal-escape reader: substr(...).match(/^[0-7]+/)[0]", async () => {
    // `escapes-unicode.js` threw "Cannot access property on null or undefined"
    // because substr yielded "" and the match therefore returned null.
    const got = await runStandalone(`export function test(): number {
  const o: any = { input: "x102y" };
  const m: any = o.input.substr(1, 3).match(/^[0-7]+/);
  return m === null ? -1 : m[0].length;
}`);
    expect(got).toBe(3);
  });
});

describe("#3673 — `x | 0` on a dynamic value is ToInt32(ToNumber(x))", () => {
  // The old lowering preferred `parseFloat` whenever the module happened to have
  // registered it, which both broke the semantics and TRAPPED standalone (the
  // native parseFloat opens with an unguarded `ref.cast $AnyString`).
  it("a boxed number operand does not trap when parseFloat is also in the module", async () => {
    const got = await runStandalone(`export function test(): number {
  const o: any = { v: 5 };
  const x: any = o.v;
  const alsoUseParseFloat = parseFloat("1.5");
  return (x | 0) + alsoUseParseFloat;
}`);
    expect(got).toBe(6.5);
  });

  it("'10abc' | 0 is 0 (ToNumber → NaN), not parseFloat's 10", async () => {
    const got = await runStandalone(`export function test(): number {
  const o: any = { v: "10abc" };
  const x: any = o.v;
  const alsoUseParseFloat = parseFloat("1.5");
  return (x | 0) * 1000 + alsoUseParseFloat;
}`);
    expect(got).toBe(1.5);
  });

  it("'0x10' | 0 is 16 (StringToNumber understands the radix prefix)", async () => {
    const got = await runStandalone(`export function test(): number {
  const o: any = { v: "0x10" };
  const x: any = o.v;
  const alsoUseParseFloat = parseFloat("1.5");
  return (x | 0) * 1000 + alsoUseParseFloat;
}`);
    expect(got).toBe(16001.5);
  });

  it("truncates toward zero, and null/undefined become 0", async () => {
    const got = await runStandalone(`export function test(): number {
  const o: any = { a: 7.9, b: null };
  return (o.a | 0) * 100 + (o.b | 0) + (o.missing | 0);
}`);
    expect(got).toBe(700);
  });

  it("acorn's RegExpValidationState.reset shape: this.start = start | 0", async () => {
    // Every regex literal trapped with "illegal cast" here.
    const got = await runStandalone(`function State(this: any) { this.start = 0; }
(State as any).prototype.reset = function (start: any) { this.start = start | 0; return this.start; };
export function test(): number {
  const s: any = new (State as any)();
  const alsoUseParseFloat = parseFloat("0.5");
  return s.reset(3) + alsoUseParseFloat;
}`);
    expect(got).toBe(3.5);
  });
});

describe("#3673 — a user method may share a String.prototype method name", () => {
  // The guarded any-receiver string lowering answered a `ref.test $AnyString`
  // MISS with "the spec default for the result type". For an object that
  // defines the same method that is a silent wrong answer: acorn's
  // `RegExpValidationState.prototype.at` collides with `String.prototype.at`,
  // so `state.at(i)` read back 0 instead of the -1 end-of-input sentinel and
  // `regexp_eatPatternCharacters` spun forever on every `u`-flag regex.
  it("dispatches to the user's `at`, not to the string sentinel", async () => {
    const got = await runStandalone(`function St(this: any) { this.pos = 5; this.source = "ab"; }
(St as any).prototype.at = function (i: any) { if (i >= 2) { return -1; } return 55; };
(St as any).prototype.at2 = function (i: any, f: any) { if (i >= 2) { return -1; } return 55; };
export function test(): number {
  const st: any = new (St as any)();
  return st.at(st.pos);
}
export function testOther(): number {
  const st: any = new (St as any)();
  return st.at2(0, false);
}`);
    expect(got).toBe(-1);
  });

  // KNOWN RESIDUAL (#3673) — deliberately recorded as a failing expectation so
  // it flips loudly the day it is fixed, rather than sitting hidden.
  //
  // The collision fallback routes the `ref.test $AnyString` miss through the
  // `__call_m_<name>_<arity>` closed dispatcher. That dispatcher resolves
  // closed structs, open `$Object`s, and fnctor prototype methods that the
  // method cache has already seen — but in a module where this is the ONLY
  // call site of a prototype-assigned fnctor method, its arms come up empty
  // and the terminal `ref.null.extern` unboxes to 0. Add a second call site
  // (the test above) and it resolves. acorn itself is never this shape (every
  // `RegExpValidationState` method has many call sites), so this does not
  // affect the corpus; the real repair is teaching the dispatcher to enumerate
  // fnctor prototype methods at finalize, which lives in the fnctor/typed-this
  // machinery.
  it.fails("single-call-site fnctor prototype method still loses to the string sentinel", async () => {
    const got = await runStandalone(`function St(this: any) { this.pos = 5; this.source = "ab"; }
(St as any).prototype.at = function (i: any) { if (i >= 2) { return -1; } return 55; };
export function test(): number {
  const st: any = new (St as any)();
  return st.at(st.pos);
}`);
    expect(got).toBe(-1);
  });

  it("works through a second method that forwards to it (state.current())", async () => {
    const got = await runStandalone(`function St(this: any) { this.pos = 5; this.source = "ab"; }
(St as any).prototype.at = function (i: any) { if (i >= 2) { return -1; } return 55; };
(St as any).prototype.current = function () { return this.at(this.pos); };
export function test(): number {
  const st: any = new (St as any)();
  return st.current();
}`);
    expect(got).toBe(-1);
  });

  it("the end-of-input loop terminates (the eatPatternCharacters shape)", async () => {
    const got = await runStandalone(`function St(this: any) { this.pos = 0; this.source = "ab"; }
(St as any).prototype.at = function (i: any) { const s: any = this.source; if (i >= s.length) { return -1; } return s.charCodeAt(i); };
(St as any).prototype.current = function () { return this.at(this.pos); };
(St as any).prototype.advance = function () { this.pos = this.pos + 1; return 0; };
export function test(): number {
  const st: any = new (St as any)();
  let ch: any;
  let n = 0;
  while ((ch = st.current()) !== -1) { st.advance(); n = n + 1; if (n > 20) { return -99; } }
  return n;
}`);
    expect(got).toBe(2);
  });

  it("a REAL string receiver still gets String.prototype.at", async () => {
    // The collision fallback must not cost the string case its answer.
    const got = await runStandalone(`function St(this: any) { this.pos = 0; }
(St as any).prototype.at = function (i: any) { return -1; };
export function test(): number {
  const o: any = { v: "abcdef" };
  const s: any = o.v;
  return s.at(1) === "b" ? 1 : 0;
}`);
    expect(got).toBe(1);
  });

  it("a name NO user method shadows keeps its native lowering", async () => {
    const got = await runStandalone(`export function test(): number {
  const o: any = { v: "abcdef" };
  const s: any = o.v;
  return s.charCodeAt(1);
}`);
    expect(got).toBe(98);
  });
});

describe("#3673 — `obj.prop += rhs` on a dynamic receiver is JS `+`, not f64.add", () => {
  // #2850 fixed this for the JS-host lane only; standalone kept an
  // unconditional `__unbox_number → f64.add → __box_number`, so every dynamic
  // string `+=` became NaN.
  it("string += string concatenates", async () => {
    const got = await runStandalone(`export function test(): number {
  const o: any = { s: "ab" };
  o.s += "cd";
  const v: any = o.s;
  return v.length * 1000 + v.charCodeAt(3);
}`);
    expect(got).toBe(4100); // "abcd" — length 4, 'd' === 100
  });

  it("string += number stringifies the number (§13.15.3)", async () => {
    const got = await runStandalone(`export function test(): number {
  const o: any = { s: "x" };
  o.s += 5;
  const v: any = o.s;
  return v.length;
}`);
    expect(got).toBe(2);
  });

  it("numeric += stays numeric", async () => {
    const got = await runStandalone(`export function test(): number {
  const o: any = { n: 1 };
  o.n += 5;
  return o.n;
}`);
    expect(got).toBe(6);
  });

  it("the other compound operators are untouched", async () => {
    const got = await runStandalone(`export function test(): number {
  const o: any = { n: 2 };
  o.n *= 4;
  o.n -= 1;
  return o.n;
}`);
    expect(got).toBe(7);
  });

  it("acorn's regexp identifier accumulator: state.lastStringValue += ch", async () => {
    // With the numeric `+=`, both named groups keyed the SAME `groupNames`
    // entry (NaN), so `/(?<year>…)-(?<month>…)/` raised "Duplicate capture
    // group name".
    const got = await runStandalone(`export function test(): number {
  const state: any = { lastStringValue: "", groupNames: {} };
  state.lastStringValue = "";
  state.lastStringValue += "y";
  state.lastStringValue += "ear";
  const first: any = state.lastStringValue;
  state.groupNames[first] = 1;
  state.lastStringValue = "";
  state.lastStringValue += "m";
  state.lastStringValue += "onth";
  const second: any = state.lastStringValue;
  const duplicate: any = state.groupNames[second];
  return duplicate === undefined ? first.length * 100 + second.length : -1;
}`);
    expect(got).toBe(405); // "year" (4) and "month" (5) are distinct keys
  });
});
