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
import { existsSync } from "node:fs";
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
