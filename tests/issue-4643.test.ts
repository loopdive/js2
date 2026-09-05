// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4643) The `[[Prototype]]` of a `new F()` instance that never lands in an
// `$Object`, `--target standalone`.
//
// Two independent defects, both measured on this branch's base (campaign head
// `52cb0a6a6`) and both required by the issue's three-row table:
//
//   W — THE WRITE. `F.prototype = <function>` stored the raw CALLABLE into the
//       per-fnctor prototype global (`fnctor-prototype.ts`), which is the
//       `[[Prototype]]` LINK every consumer of that global already assumes is an
//       `$Object`. `__extern_get`'s fnctor arm therefore ref.tested, missed, and
//       an inherited read answered `undefined` (before the lead's mitigation the
//       same arm ref.CAST and the read was an uncatchable trap — #4639's pin).
//       Fixed by canonicalizing the stored value to #4637's own-property bag and
//       mapping it back on the way out, so `F.prototype === P` still holds.
//
//   C — THE CHAIN START. An approved constructor's instance is a `__fnctor_<F>`
//       STRUCT, not an `$Object`; it has no `$proto` field at all.
//       `__getPrototypeOf` / `__isPrototypeOf` tested `$Object` and stopped, so
//       `Object.getPrototypeOf(inst)` was `null` and `P.isPrototypeOf(inst)` was
//       `false` — for EVERY such instance. The `OBJ` pins below are the control
//       that proves this half is NOT function-specific: with an object-literal
//       prototype the base answers `null`/`false` too, so W alone cannot move
//       those two rows (the issue file's "one cause, three wrong answers" is
//       corrected there with this measurement).
//
// ## Why the pins drive `runTest262File` and not a bare `compile()`
//
// The shape only exists in the test262 lane: it needs #4639's C1 escape-gate
// classification of a `NewExpression` ARGUMENT (`new H(new G())`), which the
// injected harness + `deferTopLevelInit` produce and a bare probe does not.
// Same reason `tests/issue-4639.test.ts` records.
//
// ## Every pin EXERCISES the operation
//
// The lesson this issue exists because of (brief, methodology item 7): a pin
// that asserts a shape is not a pin that exercises the shape. Each source below
// performs the read / the `isPrototypeOf` call / the `getPrototypeOf` call and
// throws on the wrong answer.
//
// No source mints a function from a body string, so this suite needs no
// eval-tier arm (identical under `JS2WASM_EVAL_ENGINE=interpreter`).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const HARNESS = join(__dirname, "..", "test262", "harness", "assert.js");
const TEST262 = existsSync(HARNESS);

/** (#4003 CI-LOAD MITIGATION, copied from `tests/issue-4639.test.ts`.) */
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

/** The arg-only instantiation shape, with a FUNCTION-valued prototype. */
const FN_PRE = `var P = function () {};
P.marker = "m";
function G() {}
G.prototype = P;
function H(x) { this.wrapped = x; }
var h = new H(new G());
var w = h.wrapped;
`;

/** The same shape with an OBJECT-valued prototype — the control for half C. */
const OBJ_PRE = `var P = { marker: "m" };
function G() {}
G.prototype = P;
function H(x) { this.wrapped = x; }
var h = new H(new G());
var w = h.wrapped;
`;

/**
 * One synthetic source per `it`, run through the test262 lane so it gets the
 * harness every measurement in this issue used. ONE observable per module: the
 * defect is about object identity, and batching observables into one compiled
 * module is the in-process pollution confound (#3673) the brief warns about.
 */
function pinSource(name: string, source: string, note: string): void {
  it(`${name} — ${note}`, { timeout: 60_000 }, async () => {
    const dir = join(__dirname, "..", ".tmp", "issue-4643-pins");
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, `${name}.js`);
    writeFileSync(abs, source);
    const r = await runTest262File(abs, "issue-4643", 30_000, "standalone");
    expect(`${r.status}: ${r.error ?? ""}`).toBe("pass: ");
  });
}

/** The inverse, for a MEASURED residual — it must STILL fail. */
function pinResidualSource(name: string, source: string, why: string): void {
  it(`still fails: ${name} (${why})`, { timeout: 60_000 }, async () => {
    const dir = join(__dirname, "..", ".tmp", "issue-4643-pins");
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, `${name}.js`);
    writeFileSync(abs, source);
    const r = await runTest262File(abs, "issue-4643", 30_000, "standalone");
    expect(r.status).not.toBe("pass");
  });
}

describe.skipIf(!TEST262)("#4643 — the three-row table (function-valued prototype, arg-only)", () => {
  // Row 1 (W). Base: `undefined`. The inherited read now resolves through the
  // callable's own-property bag, which IS the `$Object` the walk needs.
  pinSource(
    "fn-proto-argonly-inherited-read",
    `${FN_PRE}if (w.marker !== "m") throw new Test262Error("marker: " + w.marker);\n`,
    "W — an inherited read through a function-valued prototype answers the property",
  );

  // Row 2 (C). Base: `false`.
  pinSource(
    "fn-proto-argonly-is-prototype-of",
    `${FN_PRE}if (P.isPrototypeOf(w) !== true) throw new Test262Error("isPrototypeOf: " + P.isPrototypeOf(w));\n`,
    "C — the instance's chain starts at its constructor's prototype",
  );

  // Row 3 (C + W's reverse map). Base: `null`. The reverse map is what keeps
  // this from becoming a WRONG answer (the internal bag) where the base had a
  // merely missing one — the #4637 A1 absent-not-wrong rule.
  pinSource(
    "fn-proto-argonly-get-prototype-of",
    `${FN_PRE}var g = Object.getPrototypeOf(w);
if (g !== P) throw new Test262Error("getPrototypeOf is not P (null? " + (g === null) + ")");\n`,
    "C+W — getPrototypeOf answers the FUNCTION, never the internal bag",
  );

  // REGRESSION GUARD (green on base): `instanceof` is answered by the struct-arm
  // `ref.test $__fnctor_G`, OR'd with `__isPrototypeOf`. Half C changes that
  // second operand from 0 to 1, so this pin is the check that the `i32.or` still
  // means what it meant.
  pinSource(
    "fn-proto-argonly-instanceof-guard",
    `${FN_PRE}if (!(w instanceof G)) throw new Test262Error("instanceof");\n`,
    "REGRESSION GUARD (green on base) — instanceof unchanged",
  );
});

describe.skipIf(!TEST262)("#4643 — the `.prototype` slot keeps the FUNCTION's identity", () => {
  // The write now stores the bag, so the READ has to map back or `F.prototype`
  // would answer an object the program can never name. Base: true (this is the
  // property the fix must NOT break); it is a guard on the reverse map, and it
  // FAILS on a build that canonicalizes the write without the read.
  pinSource(
    "fn-proto-static-read-identity",
    `${FN_PRE}if (G.prototype !== P) throw new Test262Error("G.prototype !== P");
if (G.prototype.marker !== "m") throw new Test262Error("G.prototype.marker: " + G.prototype.marker);\n`,
    "GUARD — the static read is the function, not the proto-view",
  );

  // §13.15.2: an assignment evaluates to the ASSIGNED value. The write path now
  // stores a different value than it yields, so the two must be pinned apart.
  pinSource(
    "fn-proto-assignment-value",
    `var P = function () {};
P.marker = "m";
function G() {}
var assigned = (G.prototype = P);
if (assigned !== P) throw new Test262Error("assignment value is not P");
if (assigned.marker !== "m") throw new Test262Error("assigned.marker: " + assigned.marker);\n`,
    "GUARD — `(F.prototype = P)` evaluates to P, not to the stored view",
  );
});

describe.skipIf(!TEST262)("#4643 C — the chain start is not function-specific (OBJECT-valued control)", () => {
  // These two are the measurement that corrects the issue's premise: with an
  // object literal as the prototype, the base answered `null` / `false` for the
  // very same shape, so half W could not have been their cause.
  pinSource(
    "obj-proto-argonly-get-prototype-of",
    `${OBJ_PRE}var g = Object.getPrototypeOf(w);
if (g !== P) throw new Test262Error("getPrototypeOf is not P (null? " + (g === null) + ")");\n`,
    "an object-valued prototype was equally unreachable on base",
  );
  pinSource(
    "obj-proto-argonly-is-prototype-of",
    `${OBJ_PRE}if (P.isPrototypeOf(w) !== true) throw new Test262Error("isPrototypeOf: " + P.isPrototypeOf(w));\n`,
    "…and equally false",
  );
  // The inherited READ already worked for an object-valued prototype (only the
  // callable store broke it), so this one is a guard, not a demonstration.
  pinSource(
    "obj-proto-argonly-inherited-read-guard",
    `${OBJ_PRE}if (w.marker !== "m") throw new Test262Error("marker: " + w.marker);\n`,
    "REGRESSION GUARD (green on base) — the object-valued read still works",
  );
});

describe.skipIf(!TEST262)("#4643 — §20.1.3.3 discrimination (the new first-link compare)", () => {
  // The chain-start arm seeds `cur` with the instance's prototype and compares
  // THAT link before the loop steps — because the loop deliberately steps first,
  // so that an `$Object` candidate never matches ITSELF. A seed that skipped the
  // compare would make row 2 false again; a loop that stopped stepping first
  // would make `o.isPrototypeOf(o)` wrongly true. This pin holds both ends.
  //
  // UNFOLDABLE ON PURPOSE: the receivers come out of an array indexed by a
  // loop-carried counter, so no call-site specialisation can constant-fold the
  // predicate away and leave the pin green whatever the runtime does. The
  // expected string is position-sensitive with unequal values, so neither a
  // blanket-`true` nor a blanket-`false` build satisfies it.
  pinSource(
    "chain-start-discrimination",
    `var P = function () {};
P.marker = "m";
function G() {}
G.prototype = P;
function Q() {}
function H(x) { this.wrapped = x; }
var h = new H(new G());
var w = h.wrapped;
var q = new H(new Q()).wrapped;
var plain = {};
var recvs = [P, P, plain, plain];
var vals = [w, q, plain, w];
var out = "";
var i = 0;
while (i < 4) {
  out += recvs[i].isPrototypeOf(vals[i]);
  out += "|";
  i = i + 1;
}
assert.sameValue(out, "true|false|false|false|", "P/w, P/other-instance, self, plain/w");\n`,
    "true for the real link, false for a foreign instance, for SELF, and for a stranger",
  );
});

describe.skipIf(!TEST262)("#4643 — measured residuals", () => {
  // `in` is prototype-inclusive (§7.3.12) but `__extern_has` has no fnctor
  // chain-start arm — the third member of half C's family, deliberately NOT
  // widened here: that helper also feeds `for…in` liveness re-checks, and the
  // own-only predicates it sits next to carry the #4017 −684 warning in
  // `object-runtime.ts`. Measured false for BOTH the function-valued and the
  // object-valued prototype, so it is the same generic gap, not a callable one.
  pinResidualSource(
    "fn-proto-argonly-in-operator",
    `${FN_PRE}if (!("marker" in w)) throw new Test262Error("in");\n`,
    "`in` has no fnctor chain-start arm (generic: fails for an object-valued prototype too)",
  );
});
