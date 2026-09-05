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
import { afterEach, describe, expect, it } from "vitest";
import { selectCachedRuntimeEvalProvider } from "../scripts/runtime-eval-provider.mjs";
import { runTest262File } from "./test262-runner.js";

const HARNESS = join(__dirname, "..", "test262", "harness", "assert.js");
const TEST262 = existsSync(HARNESS);

/**
 * (#4784) Is a LINKABLE `js2wasm:runtime-eval` provider available for the
 * engine this process selected?
 *
 * Several rows below drive test262 files whose module carries the module-level
 * `js2wasm:runtime-eval` import. With no provider they do not merely answer
 * wrong — they cannot INSTANTIATE, so the row reports a confusing
 * assertion failure about `Date !== null` whose real cause is a missing build
 * artifact. That is a prerequisite of the environment, not a claim about the
 * compiler, so it must SKIP with an actionable message rather than fail.
 *
 * This is deliberately a question about the SELECTED engine, not about any one
 * artifact: `JS2WASM_EVAL_ENGINE` defaults to `quickjs`, whose artifact a plain
 * dev container never builds, while CI's root-test lanes (`ci.yml`'s changed-
 * root-test gate and `issue-tests.yml`) both set `JS2WASM_EVAL_ENGINE:
 * interpreter` and prebuild the refusal provider. So this gate is FALSE only on
 * an unprovisioned local box and stays TRUE in CI — it cannot silently disarm
 * the rows where they are meant to gate.
 */
const EVAL_PROVIDER: { ok: boolean; detail: string } = (() => {
  try {
    const selection = selectCachedRuntimeEvalProvider() as { module: unknown; message: string };
    return { ok: selection.module !== null, detail: selection.message };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
})();

if (TEST262 && !EVAL_PROVIDER.ok) {
  console.warn(
    `[issue-4621] SKIPPING the eval-provider-dependent rows: no linkable js2wasm:runtime-eval ` +
      `provider for the selected engine.\n  reason: ${EVAL_PROVIDER.detail}\n` +
      `  to run them here: JS2WASM_EVAL_ENGINE=interpreter node --import tsx ` +
      `scripts/build-runtime-eval-provider.mjs --refusal-only, then re-run with ` +
      `JS2WASM_EVAL_ENGINE=interpreter (this is what CI's root-test lanes do).`,
  );
}

/**
 * (#4003 CI-LOAD MITIGATION, copied from `es5-standalone-harness-selftests.test.ts`
 * where it is measured A/B.) `runTest262File` compiles AND runs a standalone
 * module synchronously inside the vitest worker; a couple of dozen of those back
 * to back starve the worker's event loop, so the birpc reporter calls queued
 * during those blocking spans miss their deadline and vitest aborts with
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` — exiting NONZERO while every
 * assertion PASSED. Measured on THIS file, 2026-08-23: without the hook, exit 1
 * with 27/27 green and 1 unhandled error; with it, exit 0.
 *
 * Two rounds because a single `setImmediate` still lands ahead of some queued
 * I/O callbacks (the same reason `tests/test262-runner.ts` uses two).
 */
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

function pinRow(rel: string, note?: string, opts: { needsEvalProvider?: boolean } = {}): void {
  const row = it.skipIf(opts.needsEvalProvider === true && !EVAL_PROVIDER.ok);
  row(`${rel}${note ? ` — ${note}` : ""}`, { timeout: 60_000 }, async () => {
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
  pinRow("built-ins/global/S10.2.3_A1.1_T3.js", "global code — Date !== null", { needsEvalProvider: true });
  pinRow("built-ins/global/S10.2.3_A1.2_T3.js", "function code — Date !== null", { needsEvalProvider: true });
  // The sibling that already passed: a regression guard on the same walk.
  // A1.3 is the EVAL-CODE variant, so it needs a linked runtime-eval provider —
  // present locally (quickjs artifact) but NOT in CI's `quality` tier, where the
  // row fails with the #2928 standalone refusal. Accept pass OR that specific
  // refusal: the pin still trips if the Date-carrier walk regresses (a
  // `Test262Error: Date === null` is neither), without being tier-dependent.
  it.skipIf(!EVAL_PROVIDER.ok)(
    "built-ins/global/S10.2.3_A1.3_T3.js — control (eval-code variant, tier-tolerant)",
    { timeout: 60_000 },
    async () => {
      const abs = join(__dirname, "..", "test262", "test", "built-ins/global/S10.2.3_A1.3_T3.js");
      const r = await runTest262File(abs, "issue-4621", 30_000, "standalone");
      const ok = r.status === "pass" || /dynamic code evaluation is not supported/.test(r.error ?? "");
      expect(ok, `${r.status}: ${r.error ?? ""}`).toBe(true);
    },
  );
});

describe.skipIf(!TEST262)("#4621 C — the Date carrier's own surface", () => {
  // The carrier is what makes these answerable at all: `length`/`name`/
  // `prototype` are seeded on it by `pushBuiltinCtorOwnPropSeed`, so the whole
  // §20.2.4 descriptor surface came along with the two `S10.2.3` rows this issue
  // set out to fix. Measured on the `built-ins/Date` constructor surface (all 78
  // top-level rows, plus a stride sample of `prototype/`): 151/213 → 164/213,
  // zero regressions.
  pinRow("built-ins/Date/is-a-constructor.js", "Date has [[Construct]]");
  pinRow("built-ins/Date/name.js", "Date.name descriptor");
  pinRow("built-ins/Date/S15.9.4_A1.js", "Date.prototype descriptor");
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

describe.skipIf(!TEST262)("#4621 G — Math.random is host-free standalone", () => {
  pinRow("built-ins/Math/random/S15.8.2.14_A1.js", "native standalone generator");

  // F (`language/comments/S7.4_A{5,6}`) is DELIBERATELY NOT PINNED HERE, and the
  // reason is a measurement, not squeamishness. Both rows pass at the 10 s CI
  // timeout in a FRESH process — measured on the base before any edit and again
  // on this tree — so the issue's "compile timeout" filing is stale. But each
  // runs ~65,536 runtime evals, which makes them the most load-sensitive rows in
  // the suite: inside this vitest file, after two dozen prior compiles in the
  // same worker, both exceeded a 60 s per-test timeout and took the whole FILE
  // down with an `onTaskUpdate` RPC timeout. A pin whose verdict tracks machine
  // load is not evidence about the compiler, so the finding is recorded in
  // `plan/issues/4621-es5-smalls-sweep-lexer-eval-strict.md` instead.
});

describe.skipIf(!TEST262)("#4621 — measured residuals (must still fail)", () => {
  // H's second row, HEALED — flipped positive 2026-08-28 (#4784).
  //
  // The residual read: `throw obj` PRESERVES identity for a plain object, an
  // array, a constructor instance and an Error — but NOT for an object literal
  // carrying a `valueOf`/`toString` override, which lost identity at the
  // externref boundary of a CALL or a THROW, so CHECK#5's
  // `catch (e) { e.i = 10 }` wrote to a copy. The value-representation /
  // to-primitive-carrier lane has since closed that gap.
  //
  // Verified tier-INDEPENDENT before flipping, which is what makes the flip
  // safe: the row is `pass` with NO runtime-eval provider at all (tier NONE)
  // and with the REFUSAL provider linked. It reaches `e.eval()` as an ordinary
  // OWN property of the thrown object literal, never the dynamic evaluator, so
  // its verdict does not track the provider tier the way its C-group
  // neighbours do.
  pinRow("language/statements/try/S12.14_A18_T6.js", "valueOf-object keeps identity across throw");

  // Family E — was pinned residual ("static with-scope delete is a no-op"),
  // HEALED by #4519 in the same merge cycle (its member-get guard corpus sweep
  // lists this exact row fail→pass). The pin tripped at merge time — the
  // designed mechanism — and is flipped positive. Aggregate composition also
  // healed the array-valued _T5 twin, so both are positive pins now.
  pinRow("language/statements/with/S12.10_A5_T4.js", "healed by #4519 member-get guard");
  pinRow("language/statements/with/S12.10_A5_T5.js", "array-valued twin healed in the aggregate branch");

  // The composed prototype work now walks a reassigned prototype for `in`.
  pinRow("language/expressions/in/S8.12.6_A2_T2.js", "reassigned prototype is visible to in");

  // The aggregate runtime-eval work has removed the old throughput wall for
  // this exact 65k-loop row; keep it positive so the stale residual cannot
  // return unnoticed.
  pinRow("language/literals/regexp/S7.8.5_A1.1_T2.js", "65k eval loop now completes", { needsEvalProvider: true });
});
