// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7272 — propertyHelper's isWritable, verbatim, on the IR path. Its first
// statement needs three admissions:
//   (d) `__isArray(obj)`: the stored `Array.isArray` alias lowers to the
//       object runtime's `__extern_is_array` (standalone);
//   (e) a #5092 mixed `number : string` conditional whose condition is any
//       Phase-1 condition, boxed into a fresh dynamic carrier;
//   (f) that local as a dynamic logical operand (`value || unlikelyValue`).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The refusal detail is recorded only under the shape diagnostic, which the
// selector reads at load: set it before the compiler is imported.
process.env.JS2WASM_IR_SHAPE_DIAG = "1";
const { compile } = await import("../src/index.js");
const { assembleOriginalHarness } = await import("./test262-original-harness.js");
const { originalHarnessCompileOptions, parseMeta, runTest262File } = await import("./test262-runner.js");

const PRELUDE = `var __isArray = Array.isArray;
var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
var nonIndexNumericPropertyName = Math.pow(2, 32) - 1;
function isSameValue(a, b) {
  if (a === 0 && b === 0) return 1 / a === 1 / b;
  if (a !== a && b !== b) return true;
  return a === b;
}
`;

const IS_WRITABLE = `function isWritable(obj, name, verifyProp, value) {
  var unlikelyValue = __isArray(obj) && name === "length" ?
    nonIndexNumericPropertyName :
    "unlikelyValue";
  var newValue = value || unlikelyValue;
  var hadValue = __hasOwnProperty(obj, name);
  var oldValue = obj[name];
  var writeSucceeded;

  if (arguments.length < 4 && newValue === oldValue) {
    newValue = newValue + "2";
  }

  try {
    obj[name] = newValue;
  } catch (e) {
    if (!(e instanceof TypeError)) {
      throw new Test262Error("Expected TypeError, got " + e);
    }
  }

  writeSucceeded = isSameValue(obj[verifyProp || name], newValue);

  // Revert the change only if it was successful (in other cases, reverting
  // is unnecessary and may trigger exceptions for certain property
  // configurations)
  if (writeSucceeded) {
    if (hadValue) {
      obj[name] = oldValue;
    } else {
      delete obj[name];
    }
  }

  return writeSucceeded;
}

/**
 * Verify that there is a function of specified name, length, and containing
 * descriptor associated with \`obj[name]\` and following the conventions for
 * built-in objects.
 *
 * @param {object} obj
 * @param {string|symbol} name
 * @param {string} [functionName] defaults to name for strings, \`[\${name.description}]\` for symbols
 * @param {number} functionLength
 * @param {PropertyDescriptor} [desc] defaults to data property conventions (writable, non-enumerable, configurable)
 * @param {object} [options]
 * @param {boolean} [options.label]
 * @param {typeof verifyProperty} [options.verifyProperty]
 * @param {boolean} [options.restore] revert mutations from verifying writable/configurable
 */
`;

const CHECKS = `var o = { w: 1 };
Object.defineProperty(o, "nw", { value: 2, writable: false });
var sym = Symbol("s");
o[sym] = 4;
assert.sameValue(isWritable(o, "w"), true, "w");
assert.sameValue(o.w, 1, "w restored");
assert.sameValue(isWritable(o, "nw"), false, "nw");
assert.sameValue(isWritable(o, sym), true, "sym");
assert.sameValue(isWritable([1, 2], "length"), true, "array length");
assert.sameValue(isWritable([1, 2], 0, undefined, 7), true, "index");
assert.sameValue(isWritable({ length: 1 }, "length"), true, "array-like length");
`;

const dir = mkdtempSync(join(tmpdir(), "issue-7272-"));

function fixture(name: string, body: string, flag = "noStrict"): string {
  const path = join(dir, `${name}-${flag}.js`);
  writeFileSync(path, `/*---\nflags: [${flag}]\n---*/\n${body}`);
  return path;
}

async function outcomeOf(path: string, unit: string) {
  const source = readFileSync(path, "utf8");
  const meta = parseMeta(source);
  const variant = assembleOriginalHarness(source, meta).primary;
  const result = await compile(variant.source, {
    ...originalHarnessCompileOptions(meta, "standalone"),
    fileName: path,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return (result.irOutcomes ?? []).find((outcome) => outcome.displayName === unit);
}

describe("#7272 isWritable's first statement on the IR path", () => {
  for (const flag of ["noStrict", "onlyStrict"]) {
    it(`IR-emits propertyHelper's isWritable and passes (${flag})`, async () => {
      const path = fixture("is-writable", PRELUDE + IS_WRITABLE + CHECKS, flag);
      expect(await outcomeOf(path, "isWritable")).toMatchObject({ kind: "emitted", irBodyEmitted: true });
      expect(await runTest262File(path, "issue-7272", undefined, "standalone")).toMatchObject({ status: "pass" });
    });
  }

  it("boxes a mixed conditional over a comparison of dynamic operands and reads it as a logical operand", async () => {
    const body = `function pick(flag, value) {
  var fallback = flag === 1 || flag === "one" ? 1.5 : "fallback";
  return value || fallback;
}
assert.sameValue(pick(1, 0), 1.5, "number arm");
assert.sameValue(pick("", undefined), "fallback", "string arm");
assert.sameValue(pick(null, "v"), "v", "left operand");
assert.sameValue(pick("one", ""), 1.5, "second comparison");
`;
    const path = fixture("mixed-carrier", body);
    expect(await outcomeOf(path, "pick")).toMatchObject({ kind: "emitted", irBodyEmitted: true });
    expect(await runTest262File(path, "issue-7272", undefined, "standalone")).toMatchObject({ status: "pass" });
  });

  it("answers __isArray like Array.isArray for arrays, array-likes and primitives", async () => {
    const body = `var __isArray = Array.isArray;
function isArr(x) {
  var r = __isArray(x);
  return r;
}
assert.sameValue(isArr([]), true, "array");
assert.sameValue(isArr({ length: 0 }), false, "array-like");
assert.sameValue(isArr("s"), false, "string");
assert.sameValue(isArr(undefined), false, "undefined");
assert.sameValue(isArr(new Proxy([], {})), true, "proxy of array");
`;
    const path = fixture("is-array", body);
    expect(await outcomeOf(path, "isArr")).toMatchObject({ kind: "emitted", irBodyEmitted: true });
    expect(await runTest262File(path, "issue-7272", undefined, "standalone")).toMatchObject({ status: "pass" });
  });

  const uncertified: ReadonlyArray<readonly [string, string]> = [
    ["reassigned", "var __isArray = Array.isArray;\n__isArray = function () { return true; };\n"],
    ["shadowed namespace", "var __isArray = Array.isArray;\nfunction Array() {}\n"],
    ["member-rewritten", 'Array.isArray = function () { return "yes"; };\nvar __isArray = Array.isArray;\n'],
    ["redefined", 'var __isArray = Array.isArray;\nObject.defineProperty(Array, "isArray", { value: 0 });\n'],
  ];
  // A condition the claim cannot prove boolean keeps the conditional off the
  // mixed route, so the function compiles (legacy) instead of failing after
  // the claim.
  it("leaves a mixed conditional over an unproven condition to legacy", async () => {
    const body = `function f(v) { var fb = [] ? 1.5 : "a"; return fb; }
assert.sameValue(f(0), 1.5);
`;
    const path = fixture("unproven-condition", body);
    expect((await outcomeOf(path, "f"))?.irBodyEmitted).toBe(false);
    expect(await runTest262File(path, "issue-7272", undefined, "standalone")).toMatchObject({ status: "pass" });
  });

  for (const [name, prelude] of uncertified) {
    it(`does not certify a ${name} __isArray`, async () => {
      const body = prelude + "function isArr(x) { var r = __isArray(x); return r; }\nisArr([]);\n";
      const outcome = await outcomeOf(fixture(name.replace(" ", "-"), body), "isArr");
      expect(outcome?.irBodyEmitted).toBe(false);
    });
  }
});
