// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7283 — five admissions from propertyHelper's verifyProperty chain, each
// in a function of its own:
//   (g) a statement-position member call on a stable function object
//       (`assert.sameValue(x, undefined, msg)`): its dynamic result is dropped;
//   (h) a certified boolean alias call as a dynamic argument
//       (`assert(__hasOwnProperty(o, k), msg)`), boxed like a comparison;
//   (i) the same call as a condition (`if (__hasOwnProperty(o, k))`);
//   (j) a local call's boolean result as a strict-equality operand
//       (`d !== isTrue(d)`);
//   (1) the stored `Object.getOwnPropertyNames` alias, a dynamic array value
//       read by `names.length` / `names[i]` in a counted loop.
// Base keeps all five legacy; head claims them and answers the same.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { originalHarnessCompileOptions, parseMeta, runTest262File } from "./test262-runner.js";

const BODY = `var __getOwnPropertyNames = Object.getOwnPropertyNames;
var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
function isTrue(x) { return x === true; }
function stmtAssert(x) { assert.sameValue(x, undefined, "x is undefined"); return 1; }
function boolArg(o, k) { assert(__hasOwnProperty(o, k), "own " + String(k)); return 1; }
function boolCond(o, k) { if (__hasOwnProperty(o, k)) { return 1; } return 0; }
function boolEq(d) { if (d !== isTrue(d)) { return 1; } return 0; }
function countKeys(o) {
  var names = __getOwnPropertyNames(o);
  var c = 0;
  for (var i = 0; i < names.length; i++) {
    if (names[i] === "a" || names[i] === "b") { c++; }
  }
  return c + names.length * 10;
}
var sym = Symbol("s");
assert.sameValue(stmtAssert(undefined), 1);
assert.throws(Test262Error, function () { stmtAssert(null); });
assert.sameValue(boolArg({ a: 1 }, "a"), 1);
assert.throws(Test262Error, function () { boolArg({}, sym); });
assert.sameValue(boolCond({ a: 1 }, "a"), 1);
assert.sameValue(boolCond(Object.create({ a: 1 }), "a"), 0);
assert.sameValue(boolCond([1], 0), 1);
assert.sameValue(boolEq(true), 0);
assert.sameValue(boolEq(false), 0);
assert.sameValue(boolEq(1), 1);
assert.sameValue(countKeys({ a: 1, b: 2, c: 3 }), 32);
assert.sameValue(countKeys([7, 8]), 30);
assert.sameValue(countKeys("ab"), 30);
var o = {}; o[sym] = 1; Object.defineProperty(o, "h", { value: 1, enumerable: false });
assert.sameValue(countKeys(o), 10);
`;

const UNITS = ["stmtAssert", "boolArg", "boolCond", "boolEq", "countKeys"];

const dir = mkdtempSync(join(tmpdir(), "issue-7283-"));

function fixture(flag: string, body = BODY, name = flag): string {
  const path = join(dir, `${name}.js`);
  writeFileSync(path, `/*---\nflags: [${flag}]\n---*/\n${body}`);
  return path;
}

async function emittedUnits(path: string): Promise<string[]> {
  const source = readFileSync(path, "utf8");
  const meta = parseMeta(source);
  const variant = assembleOriginalHarness(source, meta).primary;
  const result = await compile(variant.source, {
    ...originalHarnessCompileOptions(meta, "standalone"),
    fileName: path,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return (result.irOutcomes ?? [])
    .filter((outcome) => outcome.irBodyEmitted && UNITS.includes(outcome.displayName))
    .map((outcome) => outcome.displayName)
    .sort();
}

describe("#7283 verifyProperty chain admissions", () => {
  for (const flag of ["noStrict", "onlyStrict"]) {
    it(`claims every admission and passes (${flag})`, async () => {
      const path = fixture(flag);
      expect(await emittedUnits(path)).toEqual([...UNITS].sort());
      for (const lane of ["standalone", undefined] as const) {
        expect(await runTest262File(path, "issue-7283", undefined, lane)).toMatchObject({ status: "pass" });
      }
    });
  }

  // A parameter of the alias's name anywhere in the file withdraws the
  // alias, so a shadowing callee is called as itself.
  it("calls a shadowing parameter, not the alias", async () => {
    const body = `var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
function shadowedCond(o, k, __hasOwnProperty) {
  if (__hasOwnProperty(o, k)) { return 1; }
  return 0;
}
assert.sameValue(shadowedCond({}, "a", function () { return "yes"; }), 1);
`;
    const path = fixture("noStrict", body, "shadowed");
    expect(await runTest262File(path, "issue-7283", undefined, "standalone")).toMatchObject({ status: "pass" });
  });

  // A reassigned function has no stable direct-call target, so its callers
  // refuse at selection instead of being claimed and then refused by from-ast.
  it("refuses a call to a reassigned local function at selection", async () => {
    const body = `function isTrue(x) { return x === true; }
function viaEquality(d) { if (d !== isTrue(d)) { return 1; } return 0; }
function viaAssignment(d) { var w; w = isTrue(d); return w; }
function plain() { return isTrue(true) ? 1 : 0; }
viaEquality(1); viaAssignment(1); plain();
isTrue = function () { return "s"; };
`;
    const path = fixture("noStrict", body, "reassigned-callee");
    const source = readFileSync(path, "utf8");
    const meta = parseMeta(source);
    const result = await compile(assembleOriginalHarness(source, meta).primary.source, {
      ...originalHarnessCompileOptions(meta, "standalone"),
      fileName: path,
      trackIrOutcomes: true,
    });
    for (const unit of ["viaEquality", "viaAssignment", "plain"]) {
      const outcome = (result.irOutcomes ?? []).find((o) => o.displayName === unit);
      expect(outcome).toMatchObject({ irBodyEmitted: false, stage: "select" });
    }
  });
});
