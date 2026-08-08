/**
 * #3683 S4a — provably-numeric fnctor fields get a PHYSICAL f64 slot.
 *
 * S2 made `this.pos` inside a typed-`this` twin a bare `struct.get`, but the
 * field still derived `externref`, so the twin handed back a BOXED value the
 * consumer immediately unboxed. `analyzeNumericPropertyNames` replaces the
 * "first constructor write types the field" guess with a whole-program "every
 * write to this NAME is numeric" verdict, and `deriveFnctorFields` promotes the
 * slot to f64.
 *
 * Every pin is a DIFFERENTIAL against `JS2WASM_NUMERIC_FIELDS=0`, which
 * reproduces the pre-S4a shapes. That matters: in a small program the checker
 * often types a field f64 on its own, so an absolute `toBe("f64")` would pass
 * without the promotion having done anything. Comparing the two lanes isolates
 * exactly what this slice changed, and asserts that the observable result is
 * the same in both (with one deliberate, documented exception).
 *
 * The pins cover the three ways this can go wrong:
 *   (1) the analysis must DEMOTE on any non-numeric write anywhere, including
 *       through an unrelated class or a plain object literal (it is name-keyed);
 *   (2) every carve-out a raw slot cannot express — presence tracking, `delete`
 *       sentinels, boolean brands, computed writes through `this` — must keep
 *       the boxed carrier, and each has a positive control proving the pin
 *       would otherwise have promoted;
 *   (3) a promoted slot must read/write identically through BOTH lanes: the
 *       twin's inline `struct.get`/`struct.set` and the generic member
 *       dispatchers (`__get_member_<p>` / `__set_member_<p>`).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

interface Lane {
  wat: string;
  result: unknown;
}

async function buildLane(source: string, env: Record<string, string>): Promise<Lane> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const r = await compile(source, { fileName: "t.ts", skipSemanticDiagnostics: true, target: "standalone" });
    expect(r.success).toBe(true);
    const module = await WebAssembly.compile(r.binary as BufferSource);
    expect(WebAssembly.Module.imports(module).length).toBe(0);
    const { exports } = await WebAssembly.instantiate(module, {});
    return { wat: r.wat ?? "", result: (exports as Record<string, () => unknown>).test?.() };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}

/**
 * Compile with the promotion ON and OFF.
 *
 * (#743 defaults flip, 2026-08-08) BOTH lanes pin
 * `JS2WASM_FNCTOR_CTOR_PARAM_TYPES=0`. This suite's whole method is a
 * differential whose OFF lane reproduces the PRE-S4a field shapes, and
 * `expectPromoted` asserts that lane is still `externref`. The #743 ctor-param
 * narrowing reaches some of the same slots by a different route, so with it ON
 * the control lane is no longer pre-S4a and nine pins failed on their BASELINE
 * assertion — which would have read as "S4a broke" when S4a had not moved.
 *
 * Holding it off in both lanes keeps this suite measuring exactly one variable,
 * which is what it is for. The #743 × S4a interaction is deliberately NOT
 * covered here: the two passes reach an f64 slot under different proofs
 * (name-keyed whole-program vs ctor-param call-site agreement) and the
 * difference between them is recorded in plan/issues/743-*.md, not smuggled
 * into a suite that would then be testing two things at once.
 */
async function lanes(source: string): Promise<{ on: Lane; off: Lane }> {
  return {
    on: await buildLane(source, { JS2WASM_FNCTOR_CTOR_PARAM_TYPES: "0" }),
    off: await buildLane(source, { JS2WASM_NUMERIC_FIELDS: "0", JS2WASM_FNCTOR_CTOR_PARAM_TYPES: "0" }),
  };
}

/**
 * The declared wasm type of `$__fnctor_<klass>.<field>`, read out of the emitted
 * type section — so a pin fails when the PHYSICAL slot regresses, not merely
 * when an analysis verdict moves.
 */
function fieldType(wat: string, klass: string, field: string): string | undefined {
  const line = wat.split("\n").find((l) => l.includes(`$__fnctor_${klass}`) && l.includes("(struct"));
  // Hidden companion fields carry a leading `$` of their own, so a field name
  // can contain `$` — escape before it becomes a regex anchor.
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = line?.match(new RegExp(`\\(field \\$${escaped} \\(mut ([^)]*)\\)\\)`));
  return match?.[1];
}

/**
 * The declared types of the struct's presence companions, in field order.
 *
 * Presence tracking used to emit one boolean companion per field, named
 * `$$has_<f>`; it is now a PACKED WORD (`$$presence_0`, one bit per tracked
 * field). This helper asks "is this struct presence-tracked at all", which is
 * the question the pins actually need, so a future re-packing or renumbering
 * changes one function instead of every assertion.
 */
function presenceWordTypes(wat: string, klass: string): string[] {
  const line = wat.split("\n").find((l) => l.includes(`$__fnctor_${klass}`) && l.includes("(struct"));
  return [...(line ?? "").matchAll(/\(field \$\$presence_\d+ \(mut ([^)]*)\)\)/g)].map((m) => m[1]!);
}

/** `field` moved from the boxed carrier to a raw f64 because of this slice. */
function expectPromoted(l: { on: Lane; off: Lane }, klass: string, field: string): void {
  expect(fieldType(l.off.wat, klass, field)).toBe("externref");
  expect(fieldType(l.on.wat, klass, field)).toBe("f64");
}

/** `field` is untouched by this slice — both lanes emit the same carrier. */
function expectUnchanged(l: { on: Lane; off: Lane }, klass: string, field: string): void {
  expect(fieldType(l.on.wat, klass, field)).toBe(fieldType(l.off.wat, klass, field));
}

describe("#3683 S4a — numeric fnctor field promotion", () => {
  it("promotes an acorn-shaped tokenizer slot and keeps the result identical", async () => {
    // `this.pos = startPos` is the exact shape that makes acorn's hottest field
    // derive externref: the FIRST constructor write is an opaque parameter.
    const l = await lanes(
      `var P = function P(startPos) { this.pos = startPos; this.start = 0; this.hits = 0; };
var pp = P.prototype;
pp.advance = function (n) { this.start = this.pos; this.pos += n; this.hits++; return this.pos; };
pp.run = function () { this.advance(1); this.advance(2); this.advance(4); return this.pos * 1000 + this.start * 10 + this.hits; };
var p = new P(0);
export function test(): number { return p.run(); }`,
    );
    expectPromoted(l, "P", "pos");
    expect(l.on.result).toBe(7033); // pos 7, start 3, hits 3
    expect(l.on.result).toBe(l.off.result);
  });

  it("demotes on a non-numeric write to the same NAME in an unrelated class", async () => {
    const promotable = `var A = function A(n) { this.tag = n; };
var a = new A(1);
a.tag = 5;
export function test(): number { return 1; }`;
    // Positive control: on its own, `tag` promotes.
    expectPromoted(await lanes(promotable), "A", "tag");

    // Adding a class that writes a STRING `tag` demotes it program-wide.
    const l = await lanes(
      `var A = function A(n) { this.tag = n; };
var B = function B() { this.tag = "x"; };
var a = new A(1); var b = new B();
a.tag = 5;
export function test(): number { return typeof b.tag === "string" ? 1 : 0; }`,
    );
    expectUnchanged(l, "A", "tag");
    expect(l.on.result).toBe(1);
    expect(l.on.result).toBe(l.off.result);
  });

  it("demotes on a plain object-literal write of the same name", async () => {
    const l = await lanes(
      `var A = function A(n) { this.width = n; };
var opts = { width: "wide" };
var a = new A(1);
a.width = 5;
export function test(): number { return typeof opts.width === "string" ? 1 : 0; }`,
    );
    expectUnchanged(l, "A", "width");
    expect(l.on.result).toBe(1);
    expect(l.on.result).toBe(l.off.result);
  });

  it("a slot that keeps its carrier still round-trips a string", async () => {
    const l = await lanes(
      `var A = function A(n) { this.slot = n; };
var a = new A(1);
a.slot = "text";
export function test(): number { return typeof a.slot === "string" && a.slot === "text" ? 42 : -1; }`,
    );
    expectUnchanged(l, "A", "slot");
    expect(l.on.result).toBe(42);
    expect(l.on.result).toBe(l.off.result);
  });

  it("excludes presence-tracked (conditionally assigned) slots", async () => {
    // The dispatcher's presence check answers `undefined` for an unset slot,
    // which a raw f64 cannot express — so the promotion must skip it.
    const conditional = `var A = function A(n, flag) { this.n = n; if (flag) { this.maybe = n; } };
var a = new A(1, 1);
a.maybe = 3;
a.n = 4;
export function test(): number { return 1; }`;
    const l = await lanes(conditional);
    // Corroboration that the fixture really IS presence-tracked — without it
    // `expectUnchanged` could pass vacuously, on a field that was never a
    // promotion candidate. This asserted `$$has_maybe` until 2026-08-09;
    // presence became a packed word (`$$presence_0`) at some point before then
    // and the assertion had been reading `undefined` ever since. Verified
    // against pristine upstream/main @ d0019f86e: same failure, same value, so
    // this is main-side drift and not a flag interaction.
    expect(presenceWordTypes(l.on.wat, "A")).toEqual(["i32"]);
    expectUnchanged(l, "A", "maybe");
    // Positive control: the SAME field, assigned unconditionally, promotes.
    const unconditional = conditional.replace("if (flag) { this.maybe = n; }", "this.maybe = n;");
    expectPromoted(await lanes(unconditional), "A", "maybe");
  });

  it("excludes a slot that is a `delete` target anywhere in the program", async () => {
    const withDelete = `var A = function A(n) { this.gone = n; };
var a = new A(1); var b = new A(2);
a.gone = 3;
delete b.gone;
export function test(): number { return 1; }`;
    expectUnchanged(await lanes(withDelete), "A", "gone");
    // Positive control: drop the `delete` and the same slot promotes.
    expectPromoted(await lanes(withDelete.replace("delete b.gone;", "")), "A", "gone");
  });

  it("leaves boolean-only slots to the #2847 boolean brand", async () => {
    // An unbranded f64 would make `b.flag === false` answer false where JS says
    // true, so a boolean write set must never reach the numeric promotion.
    const l = await lanes(
      `var A = function A(v) { this.flag = v; };
var a = new A(1); var b = new A(0);
a.flag = true; b.flag = false;
export function test(): number { return (b.flag === false ? 10 : 0) + (a.flag === true ? 5 : 0); }`,
    );
    expectUnchanged(l, "A", "flag");
    expect(l.on.result).toBe(15);
    expect(l.on.result).toBe(l.off.result);
  });

  it("a computed write through `this` poisons the whole analysis", async () => {
    const poisoned = `var A = function A(n, k) { this.n = n; this[k] = "surprise"; };
var a = new A(1, "n");
a.n = 4;
export function test(): number { return 1; }`;
    expectUnchanged(await lanes(poisoned), "A", "n");
    // Positive control: without the computed write the same slot promotes.
    expectPromoted(await lanes(poisoned.replace(' this[k] = "surprise";', "")), "A", "n");
  });

  it("a SAME-KEY copy (`a[k] = b[k]`) does not poison — it is name-preserving", async () => {
    // Acorn's `copyNode`: `for (var prop in node) newNode[prop] = node[prop]`.
    // Whatever name it writes, it writes the value read from that same name, so
    // a name-keyed verdict survives it.
    const l = await lanes(
      `var A = function A(n) { this.n = n; };
function copy(src) { var dst = new A(0); for (var prop in src) { dst[prop] = src[prop]; } return dst; }
var a = new A(1);
a.n = 5;
export function test(): number { var c = copy(a); return typeof c.n === "number" ? 1 : 0; }`,
    );
    expectPromoted(l, "A", "n");
    expect(l.on.result).toBe(l.off.result);
  });

  it("promoted slots stay coherent through BOTH lanes (twin inline + dispatcher)", async () => {
    // `viaTwin` reads/writes `this.<f>` inside an admitted prototype method (the
    // S2 inline `struct.get`/`struct.set` branches); `viaDispatch` does the same
    // through an `any`-typed receiver, i.e. the generic `__get_member_<p>` /
    // `__set_member_<p>` dispatchers. Read, write, `+=` and `++` must all agree.
    const l = await lanes(
      `var A = function A(n) { this.a = n; this.b = n; };
var pp = A.prototype;
pp.viaTwin = function () { this.a = this.a + 10; this.b += 3; this.a++; return this.a * 100 + this.b; };
function viaDispatch(o) { o.a = o.a + 10; o.b += 3; o.a++; return o.a * 100 + o.b; }
var x = new A(1); var y = new A(1);
export function test(): number { var t = x.viaTwin(); var d = viaDispatch(y); return t === d ? t : -1; }`,
    );
    expectPromoted(l, "A", "a");
    expectPromoted(l, "A", "b");
    expect(l.on.result).toBe(1204); // a = 1+10+1 = 12, b = 1+3 = 4
    expect(l.on.result).toBe(l.off.result);
  });

  it("a promoted slot behaves the same with typed-`this` twins disabled", async () => {
    const source = `var P = function P(startPos) { this.pos = startPos; };
var pp = P.prototype;
pp.bump = function (n) { this.pos += n; return this.pos; };
var p = new P(0);
export function test(): number { return p.bump(2) + p.bump(3); }`;
    const twin = await buildLane(source, {});
    const noTwin = await buildLane(source, { JS2WASM_TYPED_THIS: "0" });
    expect(fieldType(twin.wat, "P", "pos")).toBe("f64");
    expect(twin.result).toBe(noTwin.result);
  });

  it("DOCUMENTED DIVERGENCE: a write through an opaque parameter ToNumber-coerces", async () => {
    // The analysis' single trust boundary. `this.pos = startPos` is a bare
    // parameter read, so `pos` is still promoted (that is what unblocks acorn's
    // whole tokenizer); a caller passing a string therefore stores `Number("5")`
    // where real JS keeps `"5"`. It is the same narrowing today's derivation
    // already makes for any field it types from a single write — `awaitPos` is
    // f64 today for exactly that reason — but it is a real divergence, so it is
    // pinned here and can never change by accident.
    const l = await lanes(
      `var P = function P(startPos) { this.pos = startPos; };
var pp = P.prototype;
pp.kind = function () { return typeof this.pos === "number" && this.pos === 5 ? 1 : 0; };
var warm = new P(0);
warm.pos = 1;
var p = new P("5");
export function test(): number { return p.kind(); }`,
    );
    expectPromoted(l, "P", "pos");
    expect(l.on.result).toBe(1); // promoted: ToNumber("5") === 5
    expect(l.off.result).toBe(0); // unpromoted: the string survives
  });

  it("a promoted slot still marshals through the reflection arms", async () => {
    // `fillClosedStructExternGetArms` and the hasOwn / getOwnPropertyDescriptor
    // / ownKeys arms all read the slot generically. A promoted f64 has to box
    // on the way out of each of them exactly as the boxed carrier did.
    const l = await lanes(
      `var P = function P(startPos) { this.pos = startPos; };
var p = new P(0);
p.pos = 7;
export function test(): number {
  var viaComputed = p["pos"];
  var d = Object.getOwnPropertyDescriptor(p, "pos");
  var keys = Object.keys(p);
  return (viaComputed === 7 ? 1 : 0)
    + (Object.prototype.hasOwnProperty.call(p, "pos") ? 2 : 0)
    + (d !== undefined && d.value === 7 ? 4 : 0)
    + (keys.length === 1 && keys[0] === "pos" ? 8 : 0)
    + (JSON.stringify(p) === "{\\"pos\\":7}" ? 16 : 0);
}`,
    );
    expectPromoted(l, "P", "pos");
    // The claim is COHERENCE, not completeness: the two lanes must answer
    // identically. Asserting the ideal 31 here would pin unrelated bugs rather
    // than this slice, so the absolute value records which arms work TODAY:
    //
    //   1  computed read `p["pos"]`                      works
    //   2  hasOwnProperty                                works
    //   8  Object.keys                                   works (gained since
    //                                                    this pin was written)
    //   4  getOwnPropertyDescriptor().value              still a gap
    //   16 JSON.stringify                                still a gap
    //
    // = 11. It said 3 until 2026-08-09; `Object.keys` over a standalone fnctor
    // instance started working and nothing updated the number, so the pin had
    // been red on main. Verified against pristine upstream/main @ d0019f86e —
    // same failure, same value — and 11 is stable across all four
    // derivation-flag configurations, so it is not a flag interaction.
    expect(l.on.result).toBe(l.off.result);
    expect(l.on.result).toBe(11);
  });

  it("a promoted slot enumerates and reads back through `for…in`", async () => {
    const l = await lanes(
      `var P = function P(startPos) { this.pos = startPos; };
var p = new P(0);
p.pos = 9;
export function test(): number {
  var sum = 0; var seen = 0;
  for (var k in p) { seen++; sum += p[k]; }
  return seen * 100 + sum;
}`,
    );
    expectPromoted(l, "P", "pos");
    expect(l.on.result).toBe(l.off.result);
  });

  it("host mode is untouched by the promotion", async () => {
    // The trust boundary is only defensible where the module owns every write.
    // A JS host can hand the module anything, so the host lane never promotes.
    const r = await compile(
      `var P = function P(startPos) { this.pos = startPos; };
var p = new P(0);
p.pos = 1;
export function test(): number { return 1; }`,
      { fileName: "t.ts", skipSemanticDiagnostics: true },
    );
    expect(r.success).toBe(true);
    expect(fieldType(r.wat ?? "", "P", "pos")).toBe("externref");
  });
});
