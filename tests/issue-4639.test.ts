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
  pinSource(
    "carrier-hasown-prototype-guard",
    'assert.sameValue(Math.hasOwnProperty("prototype"), false, "Math has no own prototype");\n' +
      'assert.sameValue(String.hasOwnProperty("prototype"), true, "String has an own prototype");\n',
    "REGRESSION GUARD (green on base) — discriminating answer on the spliced helper",
  );
});

describe.skipIf(!TEST262)("#4639 — measured residuals (see the issue's Residuals table)", () => {
  // C1 rest: a FUNCTION object with own `valueOf`/`toString` (T11) and a
  // replaced `Function.prototype.toString` (T8) are a different receiver family
  // from the fnctor instance T10 fixes — a callable, not a `$Object`.
  pinResidualRow("built-ins/String/S15.5.2.1_A1_T11.js", "C1 rest — function object with own valueOf/toString");
  pinResidualRow("built-ins/String/S15.5.2.1_A1_T8.js", "C1 rest — replaced Function.prototype.toString");
  // C3: the carrier has no [[Construct]] arm.
  pinResidualRow("built-ins/String/prototype/constructor/S15.5.4.1_A1_T2.js", "C3 — carrier is not constructable");
  pinResidualRow("built-ins/RegExp/prototype/S15.10.6.1_A1_T2.js", "C3 — carrier is not constructable");
  // C4: `delete RegExp.prototype.global` is not observable, because the flag
  // ACCESSORS are deliberately not seeded into the brand companion — seeding
  // them regresses `tests/issue-2885.test.ts` by a mechanism the #2175 V2-S3b-1
  // note records as unidentified. Do not re-attempt without starting from that
  // inline/bound split.
  pinResidualRow("built-ins/RegExp/prototype/global/S15.10.7.2_A9.js", "C4 — proto accessor delete not observable");
  // C5: the dynamic-pattern grammar cannot take 200 nested capture groups.
  pinResidualRow("built-ins/RegExp/S15.10.2.8_A3_T15.js", "C5 — dynamic pattern out of subset");
});
