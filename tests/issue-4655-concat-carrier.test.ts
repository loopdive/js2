// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4655, `built-ins/Array/prototype` bucket) `Array.prototype.concat` — the
// RESULT CARRIER and the PROTOTYPE CHAIN.
//
// A separate file from `tests/issue-4655.test.ts` (the `toLocaleString`
// element-step wave) on purpose: same issue, different root, and keeping them
// apart means neither wave's revert-verification touches the other's pins.
//
// Two roots, both measured on the campaign tip before any edit:
//
//  1. **The result SLOT.** `x.concat(y)` with a non-array `y` already lowered
//     correctly through the §23.1.3.1 native spec loop and answered
//     `x.concat(y)[1] === y` **true** — read straight off the call expression.
//     Stored into a `var`, the same call answered **false**: TypeScript types
//     the binding from the lib signature `concat(...items): number[]`, so the
//     `$ObjVec` externref was coerced through the per-vec materializer, which
//     ToNumber'd every element. `[0].concat(new Object(), new Array(1,2), -1,
//     true, "NaN")` came out `[0, NaN, 1, 2, -1, 1, NaN]` — the `true` boxing
//     as `1` and the string `"NaN"` as a real NaN is what identifies the
//     mechanism as a per-element ToNumber rather than a lost value.
//
//  2. **The prototype chain.** The typed vec fast path copies the receiver's
//     own backing with `array.copy` and never performs `Get(O, k)`, so an index
//     living on `Array.prototype` / `Object.prototype` was invisible to it —
//     while a DIRECT read of the same index already walked the chain correctly.
//     Same disagreement, same gate (`ctx.protoIndexDirty`) and same fix shape as
//     `array-join-proto-hole.ts` (#4491 lane J) for `join`.
//
// ## Why the controls are load-bearing
//
// Root 1's obvious reading — "the concat lowering drops non-numeric elements" —
// is WRONG, and only the no-store control distinguishes it: the same call read
// off the call expression is already correct. Root 2's obvious reading — "the
// inherited index is never seen" — is also wrong: the no-concat control shows
// the direct read walking the chain. Each pin below therefore carries the cell
// that discriminates its root from the plausible neighbour (campaign brief,
// methodology 8).
//
// ## Why these pins drive `runTest262File`
//
// Same reason as #4485/#4621/#4639/#4641/#4655-wave-1: the test262 lane injects
// a harness (`deferTopLevelInit`, the `$262` prelude, a tag-bearing
// `Test262Error`) that changes which lowering fires, and a bare `compile()`
// probe disagrees with the lane in both directions.
//
// ## Unfoldability, and its ONE exception here
//
// Every array under test is BUILT from a runtime-carried counter so no fold can
// answer without emitting the operation. The exception is deliberate: the
// STATEMENT SHAPE `var arr = <receiver>.concat(<args>)` is preserved verbatim,
// because the defect IS that spelling — the slot. #4655's own R8 records a pin
// that was rewritten for unfoldability, landed in a cell that WORKS, and
// reported green while its corpus row stayed red. Loop-carry the values; do not
// loop-carry the statement whose shape is the subject.
//
// That is not a theoretical caution here — the first draft of the prototype-chain
// pins below built their receiver as `var a = []; a[0] = 0; a.length = 3` instead
// of the corpus spelling `var a = [0]; a.length = 3`, and FIVE of them went red on
// the fix arm, including a control that is supposed to pass on both arms. The two
// spellings do not produce the same carrier: with the loop-built one, even the
// DIRECT read `a[2]` fails to see `Array.prototype[2]` and `a[1]` reads `0`
// instead of absent. So the receivers below stay array LITERALS and only the
// element values are loop-carried (`[__n - 3]` is `[0]`).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const HARNESS = join(__dirname, "..", "test262", "harness", "assert.js");
const TEST262 = existsSync(HARNESS);

/**
 * (#4003 CI-LOAD MITIGATION, as in `tests/issue-4655.test.ts`.) `runTest262File`
 * compiles AND runs a standalone module synchronously inside the vitest worker;
 * a couple of dozen back to back starve the worker's event loop, so queued
 * birpc reporter calls miss their deadline and vitest aborts with
 * `Timeout calling "onTaskUpdate"` — exiting NONZERO while every assertion
 * PASSED.
 */
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

/** A runtime-carried counter (=== 3), so no arm below can be constant-folded. */
const LOOP_CARRIED = `var __n = 0; for (var __i = 0; __i < 3; __i++) { __n += __i; } /* __n === 3 */`;

function pinRow(rel: string, note: string): void {
  it.skipIf(!TEST262)(`${rel} — ${note}`, { timeout: 60_000 }, async () => {
    const abs = join(__dirname, "..", "test262", "test", rel);
    const r = await runTest262File(abs, "issue-4655-concat", 30_000, "standalone");
    expect(`${r.status}: ${r.error ?? ""}`).toBe("pass: ");
  });
}

async function runSource(name: string, source: string): Promise<string> {
  const dir = join(__dirname, "..", ".tmp", "issue-4655-concat-pins");
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `${name}.js`);
  writeFileSync(abs, source);
  const r = await runTest262File(abs, "issue-4655-concat", 30_000, "standalone");
  return `${r.status}: ${r.error ?? ""}`;
}

function pinSource(name: string, source: string, note: string): void {
  it.skipIf(!TEST262)(`${name} — ${note}`, { timeout: 60_000 }, async () => {
    expect(await runSource(name, source)).toBe("pass: ");
  });
}

/** An `it.fails` residual: the shape STILL fails, and the suite says so. */
function failSource(name: string, source: string, note: string): void {
  it.skipIf(!TEST262).fails(`RESIDUAL ${name} — ${note}`, { timeout: 60_000 }, async () => {
    expect(await runSource(name, source)).toBe("pass: ");
  });
}

describe("#4655 — Array.prototype.concat result carrier", () => {
  pinRow(
    "built-ins/Array/prototype/concat/S15.4.4.4_A1_T2.js",
    "mixed object/primitive operands survive the result slot",
  );

  pinSource(
    "object-element-survives-the-var-slot",
    `${LOOP_CARRIED}
     var y = new Object();
     var x = [];
     for (var i = 0; i < __n; i++) { x[i] = i; }
     var arr = x.concat(y, "s");
     assert.sameValue(arr.length, 5, "length: " + arr.length);
     assert.sameValue(arr[3], y, "arr[3] must BE y, not ToNumber(y)");
     assert.sameValue(arr[4], "s", "arr[4] must stay the string");
     assert.sameValue(arr[0], 0, "arr[0]");`,
    "the value the lowering already produced must survive the binding it lands in",
  );

  pinSource(
    "control-the-same-call-read-without-a-slot",
    `${LOOP_CARRIED}
     var y = new Object();
     var x = [];
     for (var i = 0; i < __n; i++) { x[i] = i; }
     assert.sameValue(x.concat(y, "s")[3], y, "read off the call expression");`,
    "CONTROL: correct on BOTH arms — this is what proves the defect was the slot, not the lowering",
  );

  pinSource(
    "boolean-and-string-operands-are-not-tonumbered",
    `${LOOP_CARRIED}
     var x = [];
     for (var i = 0; i < __n; i++) { x[i] = i; }
     var arr = x.concat(true, "NaN");
     assert.sameValue(arr[3], true, "true must not box as 1");
     assert.sameValue(arr[4], "NaN", 'the STRING "NaN" must not become a NaN number');`,
    "the two observers that identify the mechanism as a per-element ToNumber",
  );

  pinSource(
    "control-dense-numeric-concat-is-unchanged",
    `${LOOP_CARRIED}
     var a = [];
     var b = [];
     for (var i = 0; i < __n; i++) { a[i] = i; b[i] = i + 10; }
     var r = a.concat(b);
     assert.sameValue(r.length, 6, "length: " + r.length);
     assert.sameValue(r[0], 0, "r[0]");
     assert.sameValue(r[3], 10, "r[3]");
     assert.sameValue(r[5], 12, "r[5]");
     assert.sameValue(r.join("|"), "0|1|2|10|11|12", "joined: " + r.join("|"));`,
    "CONTROL: the single-array-argument typed fast path is deliberately NOT widened",
  );
});

describe("#4655 — Array.prototype.concat and the prototype chain", () => {
  pinSource(
    "inherited-index-crosses-concat",
    `${LOOP_CARRIED}
     Array.prototype[2] = __n;
     var a = [__n - 3];
     a.length = 3;
     var b = a.concat();
     assert.sameValue(b.length, 3, "length: " + b.length);
     assert.sameValue(b[0], 0, "b[0]");
     assert.sameValue(b[1], undefined, "b[1] is genuinely absent, not a marker");
     assert.sameValue(b[2], __n, "b[2] must be the value Get(a, 2) resolved on Array.prototype");`,
    "§23.1.3.1 step 5.c.ii is Get(E, k) — a full [[Get]] with the prototype walk",
  );

  pinSource(
    "inherited-index-via-Object-prototype-crosses-concat",
    `${LOOP_CARRIED}
     Object.prototype[2] = __n;
     var a = [__n - 3];
     a.length = 3;
     var b = a.concat();
     assert.sameValue(b[2], __n, "b[2] must resolve two links up the chain");`,
    "the same walk one link further — Array.prototype then Object.prototype",
  );

  pinSource(
    "control-the-same-index-read-without-concat",
    `${LOOP_CARRIED}
     Array.prototype[2] = __n;
     var a = [__n - 3];
     a.length = 3;
     assert.sameValue(a[2], __n, "the DIRECT read already walks the chain");
     assert.sameValue(a[1], undefined, "and still reports a real hole absent");
     assert.sameValue(a.hasOwnProperty("2"), false, "without making it an own property");`,
    "CONTROL: correct on BOTH arms — the read path and the copy path disagreed, only the copy path moved",
  );

  pinSource(
    "control-no-prototype-index-write-keeps-the-fast-path-correct",
    `${LOOP_CARRIED}
     var a = [__n - 3, __n - 2, __n - 1];
     a.length = 5;
     var b = a.concat();
     assert.sameValue(b.length, 5, "length: " + b.length);
     assert.sameValue(b[2], __n - 1, "b[2]");
     assert.sameValue(b[3] === undefined, true, "b[3] absent (inline comparison)");
     assert.sameValue(b[4] === undefined, true, "b[4] absent (inline comparison)");`,
    "CONTROL: with the gate CLEAR the copy path is untouched and still correct",
  );

  // ── R-B: #4638's absent marker survives `===` and not a boxing boundary ────
  // The pin above deliberately uses the INLINE `b[3] === undefined`. Passing the
  // same element to `assert.sameValue` boxes it first, and the boxed answer is
  // `NaN` — measured on this arm (`.tmp/probes/c18-absent-tail-boxing.js`):
  // `inline3=true boxed3=NOT-absent (NaN)`, in a module where the gate is CLEAR
  // and NEITHER half of this change can execute (0 arguments, no prototype-index
  // write). So #4638's `emitConcatResultBacking` marker is only half observable:
  // the comparison fold reads it, the f64→externref box does not.
  //
  // This is the ROOT of `A3_T{2,3}`'s BASE failure (`b[1] expected undefined,
  // got NaN`). The fix above sidesteps it for gate-DIRTY modules by making the
  // result an `$ObjVec`, where absence is a null externref — it does not repair
  // the marker, and gate-clear modules keep it.
  //
  // The seam already exists: `coerceType`'s `f64 → externref` arm selects
  // `undefSentinelAwareBoxInstrs` for an f64 branded `{ undefSentinel: true }`,
  // and its own comment names "a value read from a slot that genuinely holds
  // `undefined`" as the intended trigger — an f64 vec element read is one.
  // Not taken here: that brand is a value-rep decision reaching every f64 vec
  // element read boxed to `any`, and this issue has no measurement for it.
  // Owner: value-rep (with #4491 T11 / #4638).
  failSource(
    "absent-concat-tail-observed-through-a-boxing-boundary",
    `${LOOP_CARRIED}
     var a = [__n - 3, __n - 2, __n - 1];
     a.length = 5;
     var b = a.concat();
     assert.sameValue(b[3], undefined, "b[3] boxed into a call argument");`,
    "the #4638 absent marker reads absent inline and NaN once boxed",
  );
});

describe("#4655 — retired concat carrier residuals", () => {
  // §23.1.3.1 step 5.c.ii uses CreateDataPropertyOrThrow: copied indices are
  // own properties, while holes remain absent. Keep both halves pinned.
  pinSource(
    "presence-on-a-concat-result",
    `${LOOP_CARRIED}
     Array.prototype[2] = __n;
     var a = [__n - 3];
     a.length = 3;
     var b = a.concat();
     assert.sameValue(b.hasOwnProperty("2"), true, "a copied index is an OWN property of the result");
     assert.sameValue(b.hasOwnProperty("1"), false, "a genuinely absent index is not");`,
    "copied indices are visible as own properties on the dynamic concat result",
  );
  pinSource(
    "control-presence-residual-values-are-right",
    `${LOOP_CARRIED}
     Array.prototype[2] = __n;
     var a = [__n - 3];
     a.length = 3;
     var b = a.concat();
     assert.sameValue(b[2], __n, "the VALUE half of the same row is fixed");
     assert.sameValue(b[1], undefined, "and the absent index still reads absent");`,
    "the value half agrees with the own-property observation",
  );

  // A lone elision and an elision with a populated sibling must both remain
  // holes when their arrays are spread into the concat result.
  pinSource(
    "lone-elision-literal-as-a-concat-operand",
    `${LOOP_CARRIED}
     var x = [];
     x[1] = __n;
     var arr = x.concat([], [,]);
     assert.sameValue(arr.length, 3, "length: " + arr.length);
     assert.sameValue(arr[0], undefined, "arr[0]");
     assert.sameValue(arr[1], __n, "arr[1]");
     assert.sameValue(arr[2], undefined, "arr[2] — the lone elision");`,
    "an operand literal whose only element is an elision preserves its absence crossing concat",
  );
  pinSource(
    "control-elision-with-a-non-hole-sibling",
    `${LOOP_CARRIED}
     var r = [1].concat([, __n], 0);
     assert.sameValue(r.length, 4, "length: " + r.length);
     assert.sameValue(r[1], undefined, "the elision spreads as absent when it has a sibling");
     assert.sameValue(r[2], __n, "and the sibling itself survives");`,
    "an elision with a non-hole sibling follows the same absence rule",
  );
});
