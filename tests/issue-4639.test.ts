// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4639) ES5-standalone String/RegExp constructor+prototype surface.
//
// Four families landed, each pinned by the test262 row that measured it:
//
//   C1 — `new String(obj)` ran the STRUCTURAL ToString instead of the object's
//        own/inherited `toString`. Root cause is in the fnctor escape gate, not
//        in the wrapper lowering: `getUseClassification` gates its
//        "any/unknown-typed parameter ⇒ dynamic" clause on
//        `ts.isCallExpression`, which is FALSE for a `NewExpression`, so no
//        CONSTRUCTOR argument was ever classified and the instance kept its
//        bespoke struct.
//   C2 — `<Builtin>.<unknownProp>` was a Codegen error. It is now the ordinary
//        [[Get]]: the builtin's carrier, then its [[Prototype]].
//   C6a — a `Function`-typed replacement fell in NEITHER `replace` arm, because
//        the oracle names `Function` before it looks for call signatures.
//   C6b — a VOID replacer contributed JS **null**, not `undefined`, and a
//        nullish SEARCH value produced an empty needle.
//
// ## Why the pins drive `runTest262File`, not a bare `compile()`
//
// Same reason #4485/#4621 record: the test262 lane injects a harness
// (`deferTopLevelInit`, the `$262` prelude, a tag-bearing `Test262Error`) that
// changes which lowering fires. C1 is the sharpest example here — its defect is
// invisible to a bare probe that does not also produce the escaping shape.
//
// ## One short `it` per row
//
// Copied from #4485/#4621: a row costs a full compile, and batching rows into
// few long `it`s starves vitest's worker RPC under parallel-agent load.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const HARNESS = join(__dirname, "..", "test262", "harness", "assert.js");
const TEST262 = existsSync(HARNESS);

/**
 * (#4003 CI-LOAD MITIGATION, as in `tests/issue-4621.test.ts` where it is
 * measured A/B.) `runTest262File` compiles AND runs a standalone module
 * synchronously inside the vitest worker; a couple of dozen of those back to
 * back starve the worker's event loop, so queued birpc reporter calls miss their
 * deadline and vitest aborts with `Timeout calling "onTaskUpdate"` — exiting
 * NONZERO while every assertion PASSED. Two rounds because a single
 * `setImmediate` still lands ahead of some queued I/O callbacks.
 */
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

function pinRow(rel: string, note?: string): void {
  it(`${rel}${note ? ` — ${note}` : ""}`, { timeout: 60_000 }, async () => {
    const abs = join(__dirname, "..", "test262", "test", rel);
    const r = await runTest262File(abs, "issue-4639", 30_000, "standalone");
    expect(`${r.status}: ${r.error ?? ""}`).toBe("pass: ");
  });
}

/**
 * The inverse, for a MEASURED residual: the row must STILL fail, so a later fix
 * trips this pin instead of leaving the residual table in
 * `plan/issues/4639-string-regexp-ctor-proto-surface.md` stale.
 */
function pinResidualRow(rel: string, why: string): void {
  it(`still fails: ${rel} (${why})`, { timeout: 60_000 }, async () => {
    const abs = join(__dirname, "..", "test262", "test", rel);
    const r = await runTest262File(abs, "issue-4639", 30_000, "standalone");
    expect(r.status).not.toBe("pass");
  });
}

describe.skipIf(!TEST262)("#4639 C1 — new String(obj) runs the object's ToString", () => {
  // `function F(){}; F.prototype.toString = function(){return "tostr"};
  //  new String(new F()) == "tostr"`. Measured on this branch's base: the SAME
  // instance answered "tostr" through `String(o)` and "[object Object]" through
  // `new String(o)`, in ONE module — a per-VALUE divergence, so the fix is in
  // the escape classification of the constructor argument.
  pinRow("built-ins/String/S15.5.2.1_A1_T10.js", "inherited toString on the ctor argument");

  // (Cross-lane, #4637.) The SAME classification change, observed on the shape
  // dev-4637's `CROSS-LANE PREDICTION` pin carries: a constructor with a
  // FUNCTION-VALUED prototype whose instance appears ONLY as a `new` argument,
  // read back through a field. `G.prototype === P` is `false` on the campaign
  // tip and `true` here.
  //
  // Provenance, measured three ways rather than inferred — the sequence matters
  // because two lanes reached two WRONG conclusions from partial arms first:
  //   - dev-4637 measured their base vs their branch: identical, so they
  //     concluded pre-existing and unaffected. Correct about their arms.
  //   - I measured only my branch, saw `true`, and wrongly inferred their
  //     branch introduced it. A regression claim from a one-armed measurement.
  //   - Neither pair of arms contained the OTHER lane's change. Revert here:
  //     base `false` → branch `true`, and reverting ONLY
  //     `fnctor-escape-gate.ts` flips it back — so C1 is the cause, and the
  //     defect is pre-existing on the tip AND fixed by this change-set.
  //
  // This is the first half of the composition their prediction states: C1 makes
  // this site escape-gate-approved and the prototype identity read correctly.
  // It does NOT show their A1 arm links the function-valued prototype — that is
  // their arm and their pin. If their pin is still red after both land, the two
  // halves did not compose.
  pinSource(
    "argonly-instantiation-function-valued-prototype",
    "var P = function () {};\n" +
      "function G() {}\n" +
      "G.prototype = P;\n" +
      "function H(x) {\n" +
      "  this.wrapped = x;\n" +
      "}\n" +
      "var h = new H(new G());\n" +
      "var w = h.wrapped;\n" +
      'assert.sameValue(G.prototype === P, true, "G.prototype === P");\n' +
      'assert.sameValue(w instanceof G, true, "w instanceof G");\n',
    "arg-only instantiation keeps function-valued prototype identity",
  );
});

describe.skipIf(!TEST262)("#4639 C2 — <Builtin>.<unknownProp> is a read, not a Codegen error", () => {
  // `Function.prototype.indicator = 1; String.indicator === 1` — the INHERITED
  // read across `String`'s [[Prototype]] (§20.2.3). Both of these were
  // `compile_error`, i.e. the whole file was lost over a read the spec answers
  // in one hop.
  pinRow("built-ins/String/S15.5.3_A2_T2.js", "String inherits Function.prototype expando");
  pinRow("built-ins/RegExp/S15.10.5_A2_T2.js", "RegExp inherits Function.prototype expando");
  // The other half of the same arm: a property the builtin simply does not have
  // (`Math.NaN`) is `undefined`, not a refusal.
  pinRow("built-ins/RegExp/prototype/exec/S15.10.6.2_A4_T7.js", "Math.NaN reads undefined");
});

describe.skipIf(!TEST262)("#4639 C6 — replace with a Function replacement / nullish search", () => {
  // `new String("undefined").replace(x, Function("return arguments[1]+42;"))`.
  // EVAL-TIER DEPENDENT: the module mints a function from a body string, which
  // the CI `quality` lane's REFUSAL provider throws on by design. Accept pass OR
  // that specific refusal — the pin still trips if the compile error returns (a
  // `Codegen error: … RegExp or symbol-protocol search value` is neither).
  it(
    "built-ins/String/prototype/replace/S15.5.4.11_A1_T6.js — Function() replacement (tier-tolerant)",
    { timeout: 60_000 },
    async () => {
      const abs = join(__dirname, "..", "test262", "test", "built-ins/String/prototype/replace/S15.5.4.11_A1_T6.js");
      const r = await runTest262File(abs, "issue-4639", 30_000, "standalone");
      const ok = r.status === "pass" || /dynamic code evaluation is not supported/.test(r.error ?? "");
      expect(ok, `${r.status}: ${r.error ?? ""}`).toBe(true);
    },
  );
  // The two C6b halves, without an eval dependency, as direct regression guards
  // on rows that already passed and must keep passing: a string search with a
  // string-returning replacer, and the `$`-substitution engine.
  pinRow("built-ins/String/prototype/replace/S15.5.4.11_A1_T1.js", "control — plain string replace");
});

/**
 * A pin whose SOURCE is synthetic — no test262 row covers it — but which still
 * runs through `runTest262File` so it gets the same injected harness every other
 * pin here does (see the file header for why a bare `compile()` disagrees with
 * the lane in both directions). `runTest262File` takes any absolute path.
 */
function pinSource(name: string, source: string, note: string): void {
  it(`${name} — ${note}`, { timeout: 60_000 }, async () => {
    const dir = join(__dirname, "..", ".tmp", "issue-4639-pins");
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, `${name}.js`);
    writeFileSync(abs, source);
    const r = await runTest262File(abs, "issue-4639", 30_000, "standalone");
    expect(`${r.status}: ${r.error ?? ""}`).toBe("pass: ");
  });
}

describe.skipIf(!TEST262)("#4639 C2 — CANARY: the key on which C2 and #4637's arm MEET", () => {
  // (Cross-lane, dev-4637's `issue-4637`.) The three C2 pins above all use
  // NON-`prototype` keys (`indicator`, `NaN`). But `propName === "prototype"`
  // DOES reach the C2 arm — the `emitLazyNativeProtoGet` fast path above it
  // falls through for any builtin with no registerable proto brand — so C2
  // emits `__object_hasOwn(carrier, "prototype")`, the exact interned literal
  // dev-4637's `spliceClosurePrototypeEdgeHasOwn` prologue keys on. Their arm
  // declines here because `__closure_proto_of(carrier)` is null (a
  // `__new_plain_object` carrier is not a `__fn_closure_*` / `__class_*`
  // singleton), so the two are separated by the RECEIVER predicate ALONE.
  //
  // Without this pin, nothing in either lane's file exercises that key through
  // this arm: mine used other keys, theirs used other receivers. Two files
  // blind to the same contact point from opposite ends.
  //
  // Also a plain regression pin for two flips measured BOTH arms (base
  // `81445abf7`): each was `Codegen error: <B>.prototype built-in static
  // property value read is not supported` and is now the spec `undefined`.
  // `Math` and `Proxy` are not constructors, so §10.3 gives them no
  // `prototype` — the carrier has no own one and `%Object.prototype%` has none
  // either.
  pinSource(
    "builtin-no-brand-prototype",
    'assert.sameValue(Math.prototype, undefined, "Math.prototype");\n' +
      'assert.sameValue(Proxy.prototype, undefined, "Proxy.prototype");\n',
    "Math/Proxy .prototype reach the C2 arm with key `prototype`",
  );

  // REGRESSION GUARD (green on base) — and it exists because the pin ABOVE,
  // which fails on base and so is a real test of the C2 arm, is NEVERTHELESS
  // INSENSITIVE to the cross-lane interaction it is named for.
  //
  // Why: for a no-brand builtin BOTH branches of the arm's `if` answer
  // `undefined` — the carrier has no own `prototype`, and `%Object.prototype%`
  // has none either. So if dev-4637's prologue ever wrongly answered `1` for a
  // carrier receiver, the arm would take the `then` branch, read
  // `__extern_get(carrier, "prototype")`, and still produce `undefined`. The
  // canary would stay green through exactly the regression it watches for.
  //
  // This pin is the discriminating one: `hasOwnProperty` has a two-valued
  // answer, it routes through the SAME `__object_hasOwn` / `__hasOwnProperty`
  // their prologue splices, and it uses both receiver kinds — a NAMESPACE
  // carrier with no own `prototype` (§10.3: `Math` is not a constructor) and a
  // CONSTRUCTOR carrier that has one (seeded by `pushBuiltinCtorOwnPropSeed`).
  // A splice that stopped declining on carriers flips the `Math` half
  // false → true and trips this.
  //
  // Measured BOTH arms, `false|true` on each, so it is labelled a guard rather
  // than presented as a demonstration of this change-set — the distinction
  // dev-4637 had to introduce on `issue-4637` after two of their pins turned
  // out to be the wrong category.
  //
  // RECEIVER IS RUNTIME-SELECTED ON PURPOSE. The first cut of this guard used
  // the syntactic `Math.hasOwnProperty("prototype")`, and its whole value rests
  // on the claim "this routes through the `__object_hasOwn`/`__hasOwnProperty`
  // dev-4637 splices". A syntactic receiver + literal key is exactly the shape a
  // compile-time fold would claim, and if it folds, the guard never reaches the
  // helper and guards NOTHING — green whatever their arm does. Rather than prove
  // the fold does not happen, the pin is written so it cannot matter: the
  // receiver comes out of an array indexed by a loop-carried counter, which no
  // call-site specialisation can constant-fold. (Applying dev-4637's
  // delete-the-interaction test to my own pin — see the issue file.)
  //
  // THE THREE ASSERTIONS POINT IN DIFFERENT DIRECTIONS, which is what makes
  // bundling them safe here — the hazard dev-4637 hit was a negative control
  // bundled with a positive, where a build wrong on BOTH still totals correctly.
  // Expected `false|true|false` is position-sensitive with unequal values, so
  // neither a blanket-`true` nor a blanket-`false` build can satisfy it.
  pinSource(
    "carrier-hasown-prototype-guard",
    "var recvs = [Math, String];\n" +
      'var out = "";\n' +
      "var i = 0;\n" +
      "while (i < 2) {\n" +
      '  out += recvs[i].hasOwnProperty("prototype");\n' +
      '  out += "|";\n' +
      "  i = i + 1;\n" +
      "}\n" +
      'out += Math.hasOwnProperty("zzz");\n' +
      'assert.sameValue(out, "false|true|false", "carrier hasOwn(prototype) + negative control");\n',
    "REGRESSION GUARD (green on base) — unfoldable receiver, discriminating answer",
  );
});

describe.skipIf(!TEST262)("#4639 — measured residuals (see the issue's Residuals table)", () => {
  // These two callable-receiver rows are green on current upstream; retain
  // them as positive controls so the C1 partition does not regress.
  pinRow("built-ins/String/S15.5.2.1_A1_T11.js", "C1 control — function object with own valueOf/toString");
  pinRow("built-ins/String/S15.5.2.1_A1_T8.js", "C1 control — replaced Function.prototype.toString");
  // C3: prototype constructor carriers now route through the intrinsic
  // String/Object/Error constructor paths. The Error row also checks that a
  // live Error.prototype.toString replacement remains visible on the newly
  // constructed instance.
  pinRow(
    "built-ins/String/prototype/constructor/S15.5.4.1_A1_T2.js",
    "C3 — String prototype constructor is constructable",
  );
  pinRow(
    "built-ins/Object/prototype/constructor/S15.2.4.1_A1_T2.js",
    "C3 — Object prototype constructor is constructable",
  );
  pinRow(
    "built-ins/Error/prototype/constructor/S15.11.4.1_A1_T2.js",
    "C3 — Error prototype constructor is constructable",
  );
  // RegExp's counterpart landed in upstream PR #4867 before this branch was
  // rebased; keep it as a positive upstream control alongside our three rows.
  pinRow("built-ins/RegExp/prototype/S15.10.6.1_A1_T2.js", "C3 — RegExp counterpart fixed upstream in PR #4867");
  // C4: bounded deletion updates the RegExp prototype member tombstone without
  // seeding accessors into the brand companion.
  pinRow("built-ins/RegExp/prototype/global/S15.10.7.2_A9.js", "C4 — bounded proto accessor delete");
  pinRow("built-ins/RegExp/prototype/ignoreCase/S15.10.7.3_A9.js", "C4 — bounded proto accessor delete");
  pinRow("built-ins/RegExp/prototype/multiline/S15.10.7.4_A9.js", "C4 — bounded proto accessor delete");
  // C5/T15 landed upstream in PR #4882; retain it as a positive control.
  pinRow("built-ins/RegExp/S15.10.2.8_A3_T15.js", "C5 — dynamic pattern fixed upstream in PR #4882");
});

describe.skipIf(!TEST262)("#4639 C3 — prototype constructor identity controls", () => {
  pinSource(
    "builtin-prototype-constructors-direct-and-multihop",
    `var s = new String.prototype.constructor("choosing one");
assert.sameValue(s == "choosing one", true, "direct String.prototype.constructor");
var objectCtor = Object.prototype.constructor;
var objectAlias = objectCtor;
var o = new objectAlias();
assert.sameValue(o.constructor, Object, "multi-hop Object constructor");
var errorCtor = Error.prototype.constructor;
var errorAlias = errorCtor;
var e = new errorAlias();
assert.sameValue(e.constructor, Error, "multi-hop Error constructor");`,
    "direct and immutable multi-hop aliases use the matching builtin constructor",
  );
});

describe.skipIf(!TEST262)("#4639/#4637 — the C1-reachable function-valued-prototype TRAP (cross-lane)", () => {
  // (2026-08-23, found by dev-4639 post-stand-down, verified by dev-4637 on the
  // merged head.) C1 makes the arg-only-instantiation site reachable; with a
  // FUNCTION-valued prototype (`G.prototype = P`), `$proto` holds a raw
  // callable written by a path that bypasses #4637's `__object_create`
  // canonicalization, and `__extern_get`'s fnctor-proto-start arm ref.cast it
  // to `$Object` — an UNCATCHABLE `illegal cast` trap on any inherited read.
  // Fixed by test-before-cast in `object-runtime.ts` (the miss arm = the tip's
  // graceful `undefined`). This pin EXERCISES the read (the lesson of this
  // thread: a pin that asserts a shape is not a pin that exercises it) and
  // fails again if the naked cast is ever reintroduced.
  pinSource(
    "fn-proto-argonly-inherited-read-no-trap",
    `var P = function () {};
P.marker = "m";
function G() {}
G.prototype = P;
function H(x) { this.wrapped = x; }
var h = new H(new G());
var w = h.wrapped;
var v = w.marker;
if (typeof v === "string" && v !== "m") throw new Test262Error("unexpected marker: " + v);`,
    "inherited read through a function-valued prototype completes (no trap)",
  );

  // The CORRECT answers for the same shape. Filed as a successor `it.fails`
  // here; FLIPPED POSITIVE by #4643, which is also where the "one cause, three
  // wrong readings" reading of it is corrected — measured there, the three rows
  // had TWO causes: the raw callable stored into the per-fnctor prototype global
  // (the read), and `__getPrototypeOf`/`__isPrototypeOf` having no chain start
  // for a `__fnctor_<F>` instance struct at all (the other two, which were
  // equally wrong for an OBJECT-valued prototype and so could not have shared
  // the callable's cause).
  it("SUCCESSOR (fixed by #4643): the same shape answers correctly", { timeout: 60_000 }, async () => {
    const dir = join(__dirname, "..", ".tmp", "issue-4639-pins");
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, "fn-proto-argonly-correct.js");
    writeFileSync(
      abs,
      `var P = function () {};
P.marker = "m";
function G() {}
G.prototype = P;
function H(x) { this.wrapped = x; }
var h = new H(new G());
var w = h.wrapped;
if (w.marker !== "m") throw new Test262Error("marker: " + w.marker);
if (!P.isPrototypeOf(w)) throw new Test262Error("isPrototypeOf");
if (Object.getPrototypeOf(w) !== P) throw new Test262Error("getPrototypeOf");`,
    );
    const r = await runTest262File(abs, "issue-4639", 30_000, "standalone");
    expect(`${r.status}: ${r.error ?? ""}`).toBe("pass: ");
  });
});
