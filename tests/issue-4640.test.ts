// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4640) ES5-standalone statements/expressions smalls, round 3.
//
// The issue named seven families (D1–D7). What the LIVE re-measurement on this
// branch's base found differs from the map in three places that matter, and the
// pins below are organised by what was measured:
//
//   D7 — `Date(...)` WITHOUT `new`. §21.4.2.1 returns ToDateString(now), a
//        String. The compiler had no arm at all, so the call answered
//        `ref.null.extern` while the checker typed it `string` — and the next
//        `Date.parse(...)` illegal-cast TRAPPED. A CRASH, not a wrong answer.
//
//   D1 — calling / `new`-ing a nullish VALUE. The map said the thrown thing was
//        `[object Object]` instead of a TypeError instance. It was not: NOTHING
//        was thrown. The `[object Object]` is the test's own `Test262Error`,
//        raised on the line AFTER the call that should have thrown and then
//        rendered by its own catch block. The error-instance lowering
//        (`emitThrowTypeError`) was already correct.
//
//   D3 — the map read this as "6/8-deep nested loops drop a declaration" and
//        suggested reducing depth to find a cliff. There is no cliff and no
//        depth dependence: `x = 1; x++` fails at depth ZERO. Read-modify-write
//        on a sloppy implicit global was broken two independent ways (a static
//        ReferenceError for `++`, a local-carrier concat lane for `+=`), and the
//        deepest loop body is simply the first place either one executes.
//
// The `it.fails` block records residuals MEASURED on this branch with the fix
// in, each with the owner it belongs to. They are pins, not aspirations: if one
// starts passing, this file goes red and the residual list is stale.
//
// ## Why the pins drive `runTest262File`, not a bare `compile()`
//
// Same reason as #4485/#4621: the test262 lane injects a harness
// (`deferTopLevelInit`, the `$262` prelude, a tag-bearing `Test262Error`) that
// changes which lowering fires, and a bare probe disagrees with the lane in both
// directions.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const HARNESS = join(__dirname, "..", "test262", "harness", "assert.js");
const TEST262 = existsSync(HARNESS);

/**
 * (#4003 CI-LOAD MITIGATION, copied from `tests/issue-4621.test.ts` where it is
 * measured A/B.) `runTest262File` compiles AND runs a standalone module
 * synchronously inside the vitest worker; a couple of dozen back to back starve
 * the worker's event loop, so queued birpc reporter calls miss their deadline
 * and vitest aborts with `Timeout calling "onTaskUpdate"` — exiting NONZERO
 * while every assertion PASSED.
 */
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

function pinRow(rel: string, note?: string): void {
  it(`${rel}${note ? ` — ${note}` : ""}`, { timeout: 60_000 }, async () => {
    const abs = join(__dirname, "..", "test262", "test", rel);
    const r = await runTest262File(abs, "issue-4640", 30_000, "standalone");
    expect(`${r.status}: ${r.error ?? ""}`).toBe("pass: ");
  });
}

function pinResidual(rel: string, owner: string): void {
  it.fails(`RESIDUAL ${rel} — ${owner}`, { timeout: 60_000 }, async () => {
    const abs = join(__dirname, "..", "test262", "test", rel);
    const r = await runTest262File(abs, "issue-4640", 30_000, "standalone");
    expect(`${r.status}: ${r.error ?? ""}`).toBe("pass: ");
  });
}

describe.skipIf(!TEST262)("#4640 statements/expressions smalls round 3 (standalone)", () => {
  describe("D7 — `Date(...)` without `new` (§21.4.2.1)", () => {
    // The CRASH row. `isEqual(Date(), (new Date()).toString())` fed the null
    // externref to `__date_parse`, whose first act is `any.convert_extern` +
    // `ref.cast` — "illegal cast in __date_parse()", not a wrong answer.
    pinRow("built-ins/Date/S15.9.2.1_A2.js", "was: illegal cast in __date_parse");
  });

  describe("D1 — calling / constructing a nullish value (§13.3.6.1, §13.3.5.1)", () => {
    pinRow("language/expressions/call/S11.2.3_A3_T4.js", "var x = undefined; x() → TypeError");
    pinRow("language/expressions/call/S11.2.3_A3_T5.js", "var x = null; x() → TypeError");
    pinRow("language/expressions/new/S11.2.2_A3_T4.js", "var x = undefined; new x → TypeError");
    pinRow("language/expressions/new/S11.2.2_A3_T5.js", "var x = null; new x → TypeError");
  });

  describe("D3 — read-modify-write on a sloppy implicit global", () => {
    // Nine- and seven-deep nested `for (indexN = 0; …; indexN++)` over implicit
    // globals with an `__str += …` accumulator. Both defects fire in the same
    // file, which is why the reported symptom was "the innermost index is not
    // defined" AND (once that was fixed) "__str is empty".
    pinRow("language/statements/for/S12.6.3_A10_T1.js", "nine nested var-loops");
    pinRow("language/statements/for/S12.6.3_A10.1_T1.js", "seven nested var-loops");
  });

  describe("escalated to #4641 and landed there — mixed-return `T | undefined`", () => {
    // Was `it.fails` here: `myfunc3(){ x3++; return; return x3; }` answered `0`
    // because the wasm result was `f64` and a bare `return;` pushed that type's
    // zero. #4641 widens a mixed-return DECLARATION's result to externref.
    pinRow("language/statements/return/S12.9_A5.js", "bare `return;` answers undefined, not 0 (#4641)");
  });

  describe("residuals measured on this branch (each with an owner)", () => {
    // ── D1 remainder: a MEMBER callee, which needs a runtime IsCallable test.
    // Deliberately not attempted here: the member-read lane answers `null` for
    // shapes that are our own gap as often as the program's, so a throw there
    // converts compiler gaps into hard runtime failures. Owner: the call-lane
    // /#4519 member-guard line.
    pinResidual("language/expressions/call/11.2.3-3_3.js", "callee-ref must throw BEFORE args (#4519 line)");
    pinResidual("language/expressions/call/11.2.3-3_4.js", "runtime IsCallable on a member callee (#4519 line)");
    pinRow("language/expressions/call/11.2.3-3_8.js", "runtime IsCallable on `this.bar` (#4519 line)");

    // ── Mixed-return functions. This escalation was filed as #4641 and the
    // RETURN-slot half has since LANDED there: a declaration whose checker
    // return type is a union containing `undefined` now widens its wasm result
    // to externref, so a bare `return;` carries the canonical `undefined`
    // instead of `f64.const 0`. `S12.9_A5` therefore moved OUT of this residual
    // list and into a passing pin above (see `tests/issue-4641.test.ts` for the
    // full family + the measured residuals that did NOT land: the local slot,
    // concrete-ref carriers, function expressions).
    //
    // `S8.1_A2_T2` stays a residual: it is the same family read through a
    // DIFFERENT slot (`var x = f(); x === void 0`), i.e. the `number|undefined`
    // LOCAL collapse, which is #3580 S3/S4 and not part of #4641's landing.
    pinResidual("language/types/undefined/S8.1_A2_T2.js", "void-call result !== `void 0` (#3580 local-slot collapse)");

    // ── D4. `11.1.5-0-1/2` mint the accessors with `eval("o = {get foo(){…}}")`
    // — the object literal is never seen by this compiler at all, so the family
    // is the runtime-eval lane's, not the object-literal lane's. `S11.1.5_A2`
    // fails only on CHECK#2 (`new Boolean(true)` through a literal property):
    // wrapper-object identity, the #4481 value-identity wall.
    pinResidual("language/expressions/object/11.1.5-0-1.js", "accessors minted by eval (runtime-eval lane)");
    pinResidual("language/expressions/object/11.1.5-0-2.js", "accessors minted by eval (runtime-eval lane)");
    pinResidual("language/expressions/object/S11.1.5_A2.js", "wrapper-object identity (#4481 value-identity)");

    // ── D5. `Object.defineProperty(Object.prototype, "x", {get(){return this}})`
    // then `(5).x` in STRICT mode: the getter must receive the UNBOXED primitive
    // as `this`. Same family #4620 named (primitive-`this`), plus the
    // #4491 defineProperty-on-Object.prototype MOP.
    pinResidual("language/function-code/10.4.3-1-103.js", "primitive `this` in a proto accessor (#4620/#4491)");
    pinResidual("language/function-code/10.4.3-1-104.js", "primitive `this` in a proto accessor (#4620/#4491)");
    pinResidual("language/function-code/10.4.3-1-106.js", "primitive `this` in a proto accessor (#4620/#4491)");

    // ── A hoisted `var x = true;` read BEFORE its declaration answers `false`,
    // not `undefined`: the hoisted slot is an i32 boolean and its zero value is
    // `false`. Same value-representation wall as the mixed-return rows.
    pinResidual("language/types/boolean/S8.3_A1_T1.js", "hoisted var reads its type's zero (value-rep)");
  });
});
