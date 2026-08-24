// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4641) The return-slot half of `T | undefined`.
//
//   function f(c) { if (c) return; return 5; }
//   f(true)   // was 0, spec says undefined
//
// TS infers `f`'s return type as `5 | undefined`; `resolveWasmType`'s union arm
// strips the nullish member, so the wasm result was `f64` and both "no value"
// emit sites pushed that type's ZERO — a perfectly legal JS value, so nothing
// downstream could tell the absent value from a returned `0`.
//
// ## Why these pins drive `runTest262File`, not a bare `compile()`
//
// Same reason as #4485/#4621/#4639/#4640: the test262 lane injects a harness
// (`deferTopLevelInit`, the `$262` prelude, a tag-bearing `Test262Error`) that
// changes which lowering fires, and a bare probe disagrees with the lane in
// both directions.
//
// ## Why every pin below is loop-carried
//
// A pin that asserts a shape is not a pin that exercises the shape. Written as
// `f(true)` with a literal argument, a constant-folding pass can answer the
// call without ever emitting the bare-`return;` path, and the pin would stay
// green with the fix reverted. Every assertion here drives the call from a
// loop-carried index, so the branch is a runtime one and the default-value emit
// site is genuinely reached. Verified by reverting
// `src/codegen/mixed-return-widening.ts`'s call site — see `## Test Results` in
// the issue file for the per-pin before/after.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
    const r = await runTest262File(abs, "issue-4641", 30_000, "standalone");
    expect(`${r.status}: ${r.error ?? ""}`).toBe("pass: ");
  });
}

/**
 * A pin whose SOURCE is synthetic — no test262 row covers the shape — run
 * through `runTest262File` so it gets the same injected harness every corpus
 * pin does. `runTest262File` takes any absolute path.
 */
function pinSource(name: string, source: string, note: string): void {
  it(`${name} — ${note}`, { timeout: 60_000 }, async () => {
    const dir = join(__dirname, "..", ".tmp", "issue-4641-pins");
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, `${name}.js`);
    writeFileSync(abs, source);
    const r = await runTest262File(abs, "issue-4641", 30_000, "standalone");
    expect(`${r.status}: ${r.error ?? ""}`).toBe("pass: ");
  });
}

function pinResidual(name: string, source: string, owner: string): void {
  it.fails(`RESIDUAL ${name} — ${owner}`, { timeout: 60_000 }, async () => {
    const dir = join(__dirname, "..", ".tmp", "issue-4641-pins");
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, `${name}.js`);
    writeFileSync(abs, source);
    const r = await runTest262File(abs, "issue-4641", 30_000, "standalone");
    expect(`${r.status}: ${r.error ?? ""}`).toBe("pass: ");
  });
}

function residualRow(rel: string, owner: string): void {
  it.fails(`RESIDUAL ${rel} — ${owner}`, { timeout: 60_000 }, async () => {
    const abs = join(__dirname, "..", "test262", "test", rel);
    const r = await runTest262File(abs, "issue-4641", 30_000, "standalone");
    expect(`${r.status}: ${r.error ?? ""}`).toBe("pass: ");
  });
}

describe.skipIf(!TEST262)("#4641 mixed-return `T | undefined` (standalone)", () => {
  // The row dev-4640 pinned `it.fails` and escalated. CHECK#3 is
  // `myfunc3()!==undefined` where `myfunc3` is `x3++; return; return x3;` — a
  // bare `return;` in a function that also returns a number.
  pinRow("language/statements/return/S12.9_A5.js", "bare `return;` answers undefined, not 0");

  // ── The bare-`return;` emit site (statements/control-flow.ts) ──
  // NOTE the shape: the call sits IN the observation position, not behind a
  // `var v = pick(i)`. That is not cosmetic — see the local-slot residual at the
  // bottom of this file. A `number | undefined` LOCAL still collapses to `f64`
  // (#3580 S3), so storing the widened result unboxes it to a plain NaN and the
  // identity is lost before the comparison. This branch fixes the RETURN slot;
  // the local slot is a different, larger change.
  pinSource(
    "bare-return-value-identity",
    "function pick(i) {\n" +
      "  if (i % 2 === 0) return;\n" +
      "  return i * 10;\n" +
      "}\n" +
      "var out = '';\n" +
      "for (var i = 0; i < 4; i++) {\n" +
      "  out += (pick(i) === undefined ? 'U' : String(pick(i))) + ',';\n" +
      "}\n" +
      "assert.sameValue(out, 'U,10,U,30,', 'bare return must answer undefined, not 0');\n",
    "loop-carried: `=== undefined` on every other call",
  );

  // The `=== undefined` question alone is answerable by the sNaN sentinel
  // (`binary-ops.ts:790` compares UNDEF_F64_BITS bit-for-bit, brand-blind), so
  // it does NOT distinguish widening from the sentinel. `typeof` does: the
  // sentinel answers "number" there, the widened carrier answers "undefined".
  // That is the pin that holds the CHOSEN mechanism in place.
  pinSource(
    "bare-return-typeof",
    "function pick(i) {\n" +
      "  if (i % 2 === 0) return;\n" +
      "  return i * 10;\n" +
      "}\n" +
      "var t = '';\n" +
      "for (var i = 0; i < 2; i++) {\n" +
      "  t += typeof pick(i) + ',';\n" +
      "}\n" +
      "assert.sameValue(t, 'undefined,number,', 'typeof must see undefined, not number');\n",
    "loop-carried: typeof separates widening from the sNaN sentinel",
  );

  // ToString is the third consumer #2142's decision rule names, and the second
  // one the sentinel cannot reach (it renders "NaN").
  pinSource(
    "bare-return-tostring",
    "function pick(i) {\n" +
      "  if (i % 2 === 0) return;\n" +
      "  return i * 10;\n" +
      "}\n" +
      "var s = '';\n" +
      "for (var i = 0; i < 2; i++) {\n" +
      "  s += String(pick(i)) + ',';\n" +
      "}\n" +
      "assert.sameValue(s, 'undefined,10,', 'String() must render undefined, not NaN or 0');\n",
    "loop-carried: ToString separates widening from the sNaN sentinel",
  );

  // ── The fall-off-the-end emit site (function-body.ts) ──
  // 264 of the 301 mixed-return function bodies in the test262 corpus reach the
  // defect this way, not through a syntactic `return;` (census: .tmp/
  // census-es5-syntactic.mts). Same defect, different emit site — so it needs
  // its own pin.
  pinSource(
    "fall-off-value-identity",
    "function pick(i) {\n" +
      "  if (i % 2 === 1) {\n" +
      "    return i * 10;\n" +
      "  }\n" +
      "}\n" +
      "var out = '';\n" +
      "for (var i = 0; i < 4; i++) {\n" +
      "  out += (pick(i) === undefined ? 'U' : String(pick(i))) + ',';\n" +
      "}\n" +
      "assert.sameValue(out, 'U,10,U,30,', 'fall-off must answer undefined, not 0');\n",
    "loop-carried: no syntactic `return;` at all",
  );

  // The arithmetic leg: `undefined + 1` is NaN, `0 + 1` was 1. This is the
  // observable that a program silently gets WRONG today rather than merely
  // rendering oddly.
  pinSource(
    "mixed-return-arithmetic",
    "function pick(i) {\n" +
      "  if (i % 2 === 0) return;\n" +
      "  return i * 10;\n" +
      "}\n" +
      "var n = 0;\n" +
      "var nan = 0;\n" +
      "for (var i = 0; i < 4; i++) {\n" +
      "  var v = pick(i) + 1;\n" +
      "  if (v !== v) nan++;\n" +
      "  else n += v;\n" +
      "}\n" +
      "assert.sameValue(nan, 2, 'undefined + 1 must be NaN twice');\n" +
      "assert.sameValue(n, 42, '10+1 plus 30+1');\n",
    "loop-carried: ToNumber(undefined) is NaN, not 0",
  );

  // The i32 leg. `true | undefined` is the shape BOTH real-world hits in the
  // #4641 census actually have (lodash `lodash.js` @792 and @8565), and it is
  // the one the sNaN sentinel could never have served — there is no spare i32
  // bit pattern that is safe for a carrier shared by booleans and numbers.
  pinSource(
    "bare-return-boolean-carrier",
    "function pick(i) {\n" +
      "  if (i % 2 === 0) return;\n" +
      "  return true;\n" +
      "}\n" +
      "var out = '';\n" +
      "for (var i = 0; i < 2; i++) {\n" +
      "  out += (pick(i) === undefined ? 'U' : String(pick(i))) + ',';\n" +
      "}\n" +
      "assert.sameValue(out, 'U,true,', 'bare return must not answer `false`');\n",
    "loop-carried: `true | undefined` (i32 carrier) — was `false`",
  );

  // ── REGRESSION GUARDS (green on base, must stay green) ──
  // The widening predicate fires only on a checker type that CONTAINS
  // `undefined`. These two shapes must keep their scalar carrier, and the
  // second is the one a loosened predicate would break first.
  pinSource(
    "unconditional-numeric-return-unchanged",
    "function add(a, b) {\n" +
      "  return a + b;\n" +
      "}\n" +
      "var total = 0;\n" +
      "for (var i = 0; i < 4; i++) {\n" +
      "  total += add(i, i);\n" +
      "}\n" +
      "assert.sameValue(total, 12, 'plain numeric kernel unchanged');\n" +
      "assert.sameValue(typeof add(1, 2), 'number', 'still a number carrier');\n",
    "control — a function that always returns a value keeps its f64 result",
  );

  pinSource(
    "every-path-returns-a-value-unchanged",
    "function pick(i) {\n" +
      "  if (i % 2 === 0) {\n" +
      "    return 0;\n" +
      "  }\n" +
      "  return i * 10;\n" +
      "}\n" +
      "var out = '';\n" +
      "for (var i = 0; i < 4; i++) {\n" +
      "  out += String(pick(i)) + ',';\n" +
      "}\n" +
      "assert.sameValue(out, '0,10,0,30,', 'an explicit 0 stays the number 0');\n" +
      "assert.sameValue(typeof pick(0), 'number', 'still a number carrier');\n",
    "control — an explicit `return 0;` must NOT become undefined",
  );

  describe("residuals measured on this branch (each with an owner)", () => {
    // ── Function EXPRESSIONS / arrows are registered on a different path
    // (`closures.ts` / `resolveWasmTypeForClosureReturn`), which this branch
    // deliberately does not touch. Owner: #4641 follow-on (same predicate, the
    // closure signature site).
    pinResidual(
      "mixed-return-function-expression",
      "var pick = function (i) {\n" +
        "  if (i % 2 === 0) return;\n" +
        "  return i * 10;\n" +
        "};\n" +
        "var out = '';\n" +
        "for (var i = 0; i < 2; i++) {\n" +
        "  var v = pick(i);\n" +
        "  out += (v === undefined ? 'U' : String(v)) + ',';\n" +
        "}\n" +
        "assert.sameValue(out, 'U,10,', 'function-expression mixed return');\n",
      "function expressions keep the scalar carrier (#4641 follow-on)",
    );

    // ── The LOCAL slot, which this branch deliberately does not widen.
    // `var v = pick(i)` gives `v` the checker type `number | undefined`, which
    // `resolveWasmType` still collapses to `f64` — so the widened externref
    // result is unboxed to a plain NaN on the store and the `undefined`
    // identity is gone before anything can observe it. This is the general
    // union-collapse reversal, i.e. #3580 S3/S4, whose partial landings have a
    // recorded standalone-floor breach (PR #2025, NET −1245 rows). Owner:
    // #3580. This pin is what stops a future reader from believing the return
    // fix reaches further than it does.
    pinResidual(
      "mixed-return-through-a-local-slot",
      "function pick(i) {\n" +
        "  if (i % 2 === 0) return;\n" +
        "  return i * 10;\n" +
        "}\n" +
        "var out = '';\n" +
        "for (var i = 0; i < 2; i++) {\n" +
        "  var v = pick(i);\n" +
        "  out += (v === undefined ? 'U' : String(v)) + ',';\n" +
        "}\n" +
        "assert.sameValue(out, 'U,10,', 'a number|undefined LOCAL still collapses to f64');\n",
      "`number | undefined` local collapses to f64 (#3580 S3/S4)",
    );

    // ── CONCRETE-ref carriers. A `string | undefined` return lowers to
    // `ref_null $AnyString`, and a bare `return;` pushes `ref.null` — which is
    // JS `null`, not `undefined`. MEASURED (`typeof` answers "object",
    // `String()` answers "null"); the `=== undefined` leg is already right, so
    // only the identity/stringify legs are pinned here. This is the LARGER half
    // of the real-world census (26 of 1,363 function bodies vs 2 for the scalar
    // carrier) and is held back deliberately: widening a string-returning
    // signature changes the ABI of a much hotter family. Owner: #4641 follow-on.
    pinResidual(
      "mixed-return-concrete-ref-carrier",
      "function pick(i) {\n" +
        "  if (i % 2 === 0) return;\n" +
        "  return 'x' + i;\n" +
        "}\n" +
        "var t = '';\n" +
        "for (var i = 0; i < 2; i++) {\n" +
        "  t += typeof pick(i) + '/' + String(pick(i)) + ',';\n" +
        "}\n" +
        "assert.sameValue(t, 'undefined/undefined,string/x1,', 'ref-carrier mixed return');\n",
      "`ref.null $AnyString` means null, not undefined (#4641 follow-on)",
    );

    // ── The array-ELEMENT half. A `null` in a `number[]`-lowered vec slot
    // materializes as `f64.const 0`, so `Array(undefined,1,null,3).toString()`
    // renders ",1,0,3". Needs a THIRD sNaN payload (a `null` twin of
    // UNDEF_F64_BITS / HOLE_F64_BITS) with its own `=== null` /
    // `typeof === "object"` observers. Owner: value-rep lane, sized in this
    // issue's decision matrix (ONE corpus row).
    residualRow("built-ins/Array/prototype/toString/S15.4.4.2_A1_T2.js", "null element in an f64 vec slot renders 0");

    // ── The heterogeneous-array element tag-5 lie. Nothing to do with
    // mixed-return: reading element 2 of `[0,1,2,"last"]` answers a box whose
    // `typeof` is "string" and whose ToString is "[object Object]". Owner:
    // #1888 / #2141-S4 honest-boxing flip (the flip measured −788/−794 solo, so
    // it is deliberately deferred).
    pinResidual(
      "heterogeneous-array-element-tag",
      "var arr = [0, 1, 2, 'last'];\n" +
        "var out = '';\n" +
        "for (var i = 0; i < 4; i++) {\n" +
        "  out += typeof arr[i] + ',';\n" +
        "}\n" +
        "assert.sameValue(out, 'number,number,number,string,', 'element tags');\n",
      "heterogeneous element boxes as tag-5 (#1888 / #2141-S4)",
    );
  });
});
