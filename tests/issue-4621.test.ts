// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4621) ES5-standalone smalls sweep. The issue named seven families; the
// LIVE re-measurement on this branch's base found a much smaller — and partly
// different — failing population than its 2026-08-16 map, so the pins below are
// organised by what was actually measured, not by the map:
//
//   B — §19.1.1-19.1.3 strict assignment to a non-writable global VALUE
//       property (`NaN = 12`, `undefined = 12`). Property spelling already
//       threw (#4484 C); the BARE-IDENTIFIER spelling had no arm.
//   C — `Date` as a bare value read `null` (#4485's own recorded residual).
//   D — operator smalls: `switch (null) { case null: }` missed its own case;
//       `switch ()` / `case :` compiled and RAN instead of failing to parse;
//       ToString(null) rendered "[object Object]" at the object-addition
//       boundary; `"str" == {obj}` never called ToPrimitive; `new new Math()`
//       produced `undefined` instead of throwing.
//   H — a module containing a property NAMED `eval` was poisoned into
//       runtime-eval carrier mode by the dead-binding elider, which then routed
//       a top-level `myObj.i = 6` through an unseeded global environment record.
//
//   F (comment compile-timeouts) and G (`Math.random` host-import CE) were
//   listed as failures by the issue and BOTH PASS on this branch's base —
//   re-measured at the 10 s CI timeout, not the 15 s sweep timeout. They are
//   pinned here as controls so the staleness is recorded rather than re-derived.
//
// ## Why the pins drive `runTest262File`, not a bare `compile()`
//
// Same reason as #4485's file: the test262 lane injects a harness
// (`deferTopLevelInit`, the `$262` prelude, a tag-bearing `Test262Error`) that
// changes which lowering fires, and a bare probe DISAGREES with the lane in both
// directions. Family H is the sharpest example measured here — the defect does
// NOT reproduce under a bare `compile()` at all, because it needs a dead harness
// binding to revive.
//
// ## One short `it` per row
//
// Copied verbatim from #4485's file, for the reason recorded there: a row costs
// a full compile, and batching rows into few long `it`s starves vitest's worker
// RPC under parallel-agent load (`onTaskUpdate` timeout with every test green).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const HARNESS = join(__dirname, "..", "test262", "harness", "assert.js");
const TEST262 = existsSync(HARNESS);

function pinRow(rel: string, note?: string): void {
  it(`${rel}${note ? ` — ${note}` : ""}`, { timeout: 60_000 }, async () => {
    const abs = join(__dirname, "..", "test262", "test", rel);
    const r = await runTest262File(abs, "issue-4621", 30_000, "standalone");
    expect(`${r.status}: ${r.error ?? ""}`).toBe("pass: ");
  });
}

/**
 * The inverse, for a MEASURED residual: the row must STILL fail, so a later fix
 * trips this pin instead of silently passing and leaving the residual table in
 * `plan/issues/4621-es5-smalls-sweep-lexer-eval-strict.md` stale.
 */
function pinResidualRow(rel: string, why: string): void {
  it(`still fails: ${rel} (${why})`, { timeout: 60_000 }, async () => {
    const abs = join(__dirname, "..", "test262", "test", rel);
    const r = await runTest262File(abs, "issue-4621", 30_000, "standalone");
    expect(r.status).not.toBe("pass");
  });
}

describe.skipIf(!TEST262)("#4621 B — strict write to a non-writable global value property", () => {
  // `assert.throws(TypeError, function () { NaN = 12; })` reported "no exception
  // was thrown at all". The arm sits on the IDENTIFIER assignment path and is
  // gated on `resolveUnshadowedGlobalIdentifier`, so a parameter named `NaN`
  // keeps its ordinary (legal) write.
  pinRow("built-ins/global/10.2.1.1.3-4-16-s.js", "NaN = 12 throws in strict code");
  pinRow("built-ins/global/10.2.1.1.3-4-18-s.js", "undefined = 12 throws in strict code");
});

describe.skipIf(!TEST262)("#4621 C — Date is a real value, not null", () => {
  // Both rows walk the same 15 constructor globals and only `Date` was `null`;
  // every other name in the list already had a carrier. Adding `Date` to
  // `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` changes ONLY the bare-value read.
  pinRow("built-ins/global/S10.2.3_A1.1_T3.js", "global code — Date !== null");
  pinRow("built-ins/global/S10.2.3_A1.2_T3.js", "function code — Date !== null");
  // The sibling that already passed: a regression guard on the same walk.
  pinRow("built-ins/global/S10.2.3_A1.3_T3.js", "control — was already passing");
});

describe.skipIf(!TEST262)("#4621 D — switch: null cases and the two grammar violations", () => {
  // `switch (null) { case null: }` took `default`: the standalone strict-equality
  // cascade ends in a `ref.test (ref eq)` identity arm, and `ref.test` on a NULL
  // answers 0, so two nulls could never compare equal.
  pinRow("language/statements/switch/S12.11_A1_T3.js", "case null / NaN / Infinity dispatch");
  pinRow("language/statements/switch/S12.11_A1_T4.js", "same, function-scoped");
  // `switch ()` and `case :` — TypeScript reports "Expression expected" (1109),
  // but that code is TOLERATED in compiler.ts (#537), so both compiled and RAN,
  // tripping their own `$DONOTEVALUATE()` sentinel. Re-raised as an early error
  // for exactly the two parser-recovered zero-width shapes.
  pinRow("language/statements/switch/S12.11_A3_T1.js", "switch() is a SyntaxError");
  pinRow("language/statements/switch/S12.11_A3_T4.js", "case: is a SyntaxError");
  // Siblings that already failed to parse — the guard must not have changed how
  // an ordinary malformed switch is rejected.
  pinRow("language/statements/switch/S12.11_A3_T2.js", "control — already rejected");
  pinRow("language/statements/switch/S12.11_A3_T5.js", "control — already rejected");
});

describe.skipIf(!TEST262)("#4621 D — ToString(null) at the object-addition boundary", () => {
  // `new String("1") + null` produced "1[object Object]". Any addition with an
  // OBJECT operand routes through `addition-to-primitive.ts`, which boxes both
  // sides to anyref and lands in `__any_to_string`; a RAW null ref there fell
  // past the tag-0 arm (that one only fires for an `$AnyValue` BOX) to the
  // "[object Object]" terminal. All-primitive spellings (`"" + null`) fold
  // statically and were always right, which is what hid it.
  pinRow("language/expressions/addition/S11.6.1_A3.2_T2.4.js", "String object + null");
});

describe.skipIf(!TEST262)("#4621 D — abstract equality calls ToPrimitive on an object RHS", () => {
  // `"+1" == {valueOf(){return 1}, toString(){return {}}}` answered false with an
  // EMPTY call log — neither method ran. The static-string-LEFT route excluded
  // only an `any`/`unknown` right operand from its content-compare fast path; a
  // right operand with a real OBJECT type still took it. §7.2.15 step 9 requires
  // `x == ToPrimitive(y)`.
  pinRow("language/expressions/equals/S11.9.1_A7.9.js", "string == object → ToPrimitive");
  pinRow("language/expressions/does-not-equals/S11.9.2_A7.8.js", "the != twin");
});

describe.skipIf(!TEST262)("#4621 D — new on a nested non-constructor", () => {
  // `new Math`, `new Math()` and `var x = new Math(); new x()` all threw already;
  // only `new new Math()` produced `undefined`. The generic non-constructable
  // guard cannot reach it — `new Math()` has an ERROR type, so the oracle fact is
  // `any`, which that guard rightly refuses to act on.
  pinRow("language/expressions/new/S11.2.2_A4_T5.js", "new new Math() throws TypeError");
  // The four siblings that already passed, as a guard on the same arm's ordering.
  pinRow("language/expressions/new/S11.2.2_A4_T1.js", "control");
  pinRow("language/expressions/new/S11.2.2_A4_T4.js", "control");
});

describe.skipIf(!TEST262)("#4621 H — a property named `eval` must not poison the module", () => {
  // The dead-binding elider counted EVERY identifier spelled `eval`/`Function`,
  // including a member name (`e.eval()`) and an object-literal key
  // (`{ eval: fn }`), as an escaped evaluator. One such mention revives every
  // dropped candidate — including the `$262.evalScript` shim, whose own computed
  // `eval` puts the module in runtime-eval carrier mode. This file's failure was
  // therefore NOT in the catch clause the error pointed at: it was the later
  // top-level `myObj.i = 6`, routed through a global environment record whose
  // realm object was never seeded.
  pinRow("language/statements/throw/S12.13_A2_T6.js", "throw an object with an `eval` property");
});

describe.skipIf(!TEST262)("#4621 F/G — the issue's map was stale; both already pass", () => {
  // Both re-measured at the 10 s CI timeout on this branch's base BEFORE any
  // edit. F was filed as a 10 s compile timeout (65,536 evals of a comment) and
  // G as a standalone `env::Math_random` host-import CE; neither reproduces.
  pinRow("language/comments/S7.4_A5.js", "F control — single-line comment battery");
  pinRow("language/comments/S7.4_A6.js", "F control — multi-line comment battery");
  pinRow("built-ins/Math/random/S15.8.2.14_A1.js", "G control — Math.random standalone");
});

describe.skipIf(!TEST262)("#4621 — measured residuals (must still fail)", () => {
  // H's second row. `throw obj` PRESERVES identity for a plain object, an array,
  // a constructor instance and an Error — but NOT for an object literal carrying
  // a `valueOf` or `toString` override, which loses identity at the externref
  // boundary of a CALL or a THROW (array slots and object slots keep it). So
  // CHECK#5's `catch (e) { e.i = 10 }` writes to a copy. Owner: the
  // value-representation / to-primitive-carrier lane.
  pinResidualRow("language/statements/try/S12.14_A18_T6.js", "valueOf-object loses identity across throw");

  // Family E, and its root cause is NOT eval: `delete <name>` inside a `with`
  // whose target is a proven closed object literal answers `true` and deletes
  // NOTHING. The plain `with (o) { del = delete q1 }` control reproduces it
  // without any eval, and the qualified `delete o.q1` works. Owner: the
  // with-scope / closed-struct presence lane.
  pinResidualRow("language/statements/with/S12.10_A5_T4.js", "static with-scope delete is a no-op");
  pinResidualRow("language/statements/with/S12.10_A5_T5.js", "same, array-valued property");

  // `in` does not walk a REASSIGNED prototype (`Robin.prototype = __proto`),
  // while the value read, `hasOwnProperty` and the own-name `in` are all correct.
  pinResidualRow("language/expressions/in/S8.12.6_A2_T2.js", "in misses a reassigned prototype");

  // Family A. Not a `.source` bug alone: the `_T2` rows run ~65,500 runtime
  // evals, and a loop of that size does not finish inside the 10 s budget even
  // with every `.source` read removed (measured: still running past 290 s).
  // Owner: runtime-eval throughput, not the regexp literal path.
  pinResidualRow("language/literals/regexp/S7.8.5_A1.1_T2.js", "65k-eval loop exceeds the timeout");
});
