// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4485) Builtin-surface smalls in `--target standalone`, four families:
//
//   A — `Error.prototype.toString` composition (§20.5.3.4 / ES5 §15.11.4.4):
//       an OWN `name` written on the instance, and the empty-name / empty-msg
//       arms. The own-`name` half is a WRITE bug, not a formatting one: the
//       standalone `.name` read is a hard `struct.get` of `$Error_struct`
//       field 2, and the write landed elsewhere, so `e.name = "N"; e.name`
//       answered `"Error"`.
//   B — `encodeURI` as a VALUE. Its three siblings (`decodeURI`,
//       `decodeURIComponent`, `encodeURIComponent`) were all reified; it alone
//       was missing from `STANDALONE_ES5_GLOBAL_FUNCTION_NAMES`, so the bare
//       identifier read `null` while a direct CALL worked.
//   C — Annex B `Date.prototype` (§B.2.4): `setYear` / `toGMTString` as own
//       properties, `setYear`'s ToIntegerOrInfinity window, and the §B.2.4.3
//       requirement that `toGMTString` IS `toUTCString` — one function object,
//       not two equivalent ones.
//   D — the Array surface tail (`new Array(2^32)` → a catchable RangeError
//       INSTANCE, `[object Array]`). Pinned as a REGRESSION guard: both
//       already held on this issue's base, measured, not fixed here.
//
// ## Why most pins drive `runTest262File` rather than a bare `compile()`
//
// Measured while writing this file: a `compile(source, {target:"standalone"})`
// probe and the test262 lane DISAGREE on several of these behaviours, in both
// directions. `typeof Date === "function"` is TRUE in a bare probe and FALSE on
// the test262 lane; `e.name = "N"` write-through is the reverse. The lane
// injects a harness (a tag-bearing `class Test262Error`, `deferTopLevelInit`,
// the `$262` prelude) that changes which lowering fires — the same trap
// recorded in `es5-standalone-ctor-identity.test.ts` (#4223/#4232).
//
// So the ROW pins below are the load-bearing ones: each names the exact
// test262 file whose before/after flip was measured for this issue. The few
// direct-`compile` pins that follow are kept only where they agree with the
// lane, as a cheap early signal.
//
// ## Why the row list is a SUBSET of the 18 rows that flipped
//
// A test262 row costs a full compile — 1-12 s here — and a file spending
// ~150 s inside them starved vitest's worker RPC under parallel-agent load:
// the run reported every test passing and then failed the FILE on an
// `onTaskUpdate` timeout. Measured while narrowing it: batching the rows into
// four LONG `it`s made it worse, not better, and the neighbouring
// `es5-standalone-ctor-identity.test.ts` (13 short tasks, ~43 s) is clean —
// so the trigger is the GAP between task boundaries, not the task count.
// Hence: one short `it` per row, and each family pins only the rows that
// DISCRIMINATE — the descriptor row, the arithmetic edge, the identity
// comparison, one already-passing control. The complete 18-row flip list and
// its before/after numbers live in
// `plan/issues/4485-builtin-surface-smalls.md`; the full sweep is the
// directory run, not this file.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const HARNESS = join(__dirname, "..", "test262", "harness", "assert.js");
const TEST262 = existsSync(HARNESS);

/**
 * ONE `it` per row, never a batched loop. A test262 row costs a full compile
 * (1-6 s here), and vitest's worker RPC times out `onTaskUpdate` if too long
 * passes between task boundaries under parallel-agent load: batching 13 rows
 * into 4 long `it`s made the file report every test passing and then FAIL on
 * that timeout. The neighbouring `es5-standalone-ctor-identity.test.ts` is the
 * working shape — many short tasks — so this file copies it.
 */
function pinRow(rel: string, note?: string): void {
  it(`${rel}${note ? ` — ${note}` : ""}`, { timeout: 60_000 }, async () => {
    const abs = join(__dirname, "..", "test262", "test", rel);
    const r = await runTest262File(abs, "issue-4485", 30_000, "standalone");
    expect(`${r.status}: ${r.error ?? ""}`).toBe("pass: ");
  });
}

/** The inverse, for a measured residual: the row must STILL fail. */
function pinResidualRow(rel: string, why: string): void {
  it(`still fails: ${rel} (${why})`, { timeout: 60_000 }, async () => {
    const abs = join(__dirname, "..", "test262", "test", rel);
    const r = await runTest262File(abs, "issue-4485", 30_000, "standalone");
    expect(r.status).not.toBe("pass");
  });
}

async function runStandalone(body: string): Promise<number> {
  const result = await compile(`export function test(): number { ${body} }`, {
    allowJs: true,
    fileName: "issue-4485.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe.skipIf(!TEST262)("#4485 A — Error.prototype.toString composition (rows that flipped)", () => {
  // All four set an OWN `name` on the instance and then assert on toString().
  // Base 7/17 → 11/17 over `built-ins/Error/prototype/toString`.
  // Cheapest row FIRST in each family — the first compile in a family pays the
  // helper-emission warmup (measured 8-11 s vs 3-4 s for its siblings), and a
  // single task over ~10 s is what trips the worker-RPC timeout described above.
  //
  // `Error.prototype.toString = Object.prototype.toString`. This row was
  // PASSING and the first cut of the write arm BROKE it: the field table was a
  // plain object literal, so `TABLE["toString"]` found
  // `Object.prototype.toString` instead of `undefined`, the decline never
  // fired, and the arm emitted a struct.set with a FUNCTION as the field
  // index. It is pinned precisely because it is the row a careless rewrite of
  // the arm loses.
  pinRow("built-ins/Error/prototype/S15.11.4_A2.js", "toString stays REPLACEABLE");
  pinRow("built-ins/Error/prototype/toString/15.11.4.4-8-2.js", "name '', no msg → '' (step 7)");
  pinRow("built-ins/Error/prototype/toString/15.11.4.4-10-1.js", "own name + msg → 'N: m'");
});

describe.skipIf(!TEST262)("#4485 B — encodeURI as a first-class value (rows that flipped)", () => {
  pinRow("built-ins/encodeURI/S15.1.3.3_A5.2.js", "encodeURI.hasOwnProperty('length')");
  pinRow("built-ins/encodeURI/prop-desc.js", "the global own-property descriptor");
  // `encodeURI` shares `__uri_encode` with `encodeURIComponent` and the mask
  // table is now picked by helper FAMILY. A name-based pick would look
  // `encodeURI` up in the DECODE table; this sibling row is what catches it.
  pinRow("built-ins/encodeURIComponent/prop-desc.js", "sibling undisturbed");
});

describe.skipIf(!TEST262)("#4485 C — Annex B Date.prototype surface (rows that flipped)", () => {
  // Base 14/24 → 23/24 over `annexB/built-ins/Date`.
  pinRow("annexB/built-ins/Date/prototype/toGMTString/value.js", "toGMTString IS toUTCString");
  pinRow("annexB/built-ins/Date/prototype/setYear/year-number-relative.js", "the truncated 0..99 window");
  pinRow("annexB/built-ins/Date/prototype/setYear/B.2.5.js", "setYear is an own property");
  // `getYear` is the already-passing control for this family. It is NOT pinned
  // here — `tests/issue-2671-getyear.test.ts` already owns it, and its row was
  // the single slowest task in this file (11 s), which is exactly the shape
  // that trips the worker-RPC timeout.
});

describe("#4485 C — setYear arithmetic (direct probe; agrees with the lane)", () => {
  it("truncates the year BEFORE the 0..99 window test (§B.2.4.2 step 5)", async () => {
    // -0.9999999 truncates to -0, which IS in [0, 99], so the answer is 1900.
    // Testing the raw double put it in the else arm and produced year 0.
    expect(await runStandalone(`var d = new Date(1970, 0); d.setYear(-0.9999999); return d.getFullYear();`)).toBe(1900);
  });

  it("maps 50.999999 / 99 into the 1900s and leaves 100 / 2000 absolute", async () => {
    expect(await runStandalone(`var d = new Date(1970, 0); d.setYear(50.999999); return d.getFullYear();`)).toBe(1950);
    expect(await runStandalone(`var d = new Date(1970, 0); d.setYear(99); return d.getFullYear();`)).toBe(1999);
    expect(await runStandalone(`var d = new Date(1970, 0); d.setYear(100); return d.getFullYear();`)).toBe(100);
    expect(await runStandalone(`var d = new Date(1970, 0); d.setYear(2000); return d.getFullYear();`)).toBe(2000);
  });

  it("getYear stays getFullYear - 1900", async () => {
    expect(await runStandalone(`var d = new Date(1970, 0); return d.getYear();`)).toBe(70);
  });
});

describe("#4485 D — Array surface tail (regression guard, already held on base)", () => {
  it("new Array(2^32) throws a catchable RangeError INSTANCE", async () => {
    expect(
      await runStandalone(
        `try { var a = new Array(4294967296); return 0; } catch (e) { return (e instanceof RangeError) ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("new Array(-1) throws a catchable RangeError INSTANCE", async () => {
    expect(
      await runStandalone(
        `try { var a = new Array(-1); return 0; } catch (e) { return (e instanceof RangeError) ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("Object.prototype.toString.call([]) is '[object Array]'", async () => {
    expect(await runStandalone(`return Object.prototype.toString.call([]) === "[object Array]" ? 1 : 0;`)).toBe(1);
  });
});

describe.skipIf(!TEST262)("#4485 — measured residuals (owners recorded in the issue file)", () => {
  // Each was MEASURED as still failing after this issue's change, on the same
  // lane as every row above — asserted on the LANE, not with an `it.fails`
  // around a bare `compile()` probe, which would be asserting a DIFFERENT
  // harness's answer and is how a residual gets mis-recorded as fixed.
  // Retire an entry when its row starts passing; the pin fails loudly then.
  pinResidualRow(
    "annexB/built-ins/Date/prototype/setYear/year-to-number-err.js",
    "ToNumber(Symbol) throws nowhere in standalone — a value-representation gap, not Annex B",
  );
  pinResidualRow(
    "built-ins/Error/prototype/toString/undefined-props.js",
    "§20.5.3.4 on an ARBITRARY receiver needs a real property Get; the native helper reads $Error_struct fields only",
  );
  pinResidualRow(
    "built-ins/Date/prop-desc.js",
    "bare builtin CONSTRUCTOR globals still read null — the #4442 carrier generalisation family B did not reach",
  );
});
