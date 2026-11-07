// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7265 — the move-only scan admits two shapes from propertyHelper's
// isWritable: a local call's boolean result assigned to a dynamic `var`
// (`writeSucceeded = isSameValue(...)`, boxed onto the carrier like a
// comparison) and a dynamic element read with a computed dynamic key
// (`obj[verifyProp || name]`). The fixture is isWritable with #7250 step 1
// (the module-alias locals) replaced by plain locals, run through the test262
// runner in sloppy and strict mode and compiled the same way to read the IR
// outcomes.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { originalHarnessCompileOptions, parseMeta, runTest262File } from "./test262-runner.js";

// (#7120 review) Annotated and inferred Boolean-returning callees assigned into
// a dynamic local: the annotated return keeps its Boolean brand
// (`resolvePositionType`), so each carrier is IR-emitted and holds a real JS
// Boolean. Each export returns 10 for `typeof v === "boolean"` plus 1 for true,
// 2 for false.
const BOOL_CALLS = `function annT(): boolean { return true; }
function annF(): boolean { return false; }
function infT() { return 1 === 1; }
function infF() { return 1 === 2; }
function viaAnnT(seed: any): any { var r; r = annT(); return r; }
function viaAnnF(seed: any): any { var r; r = annF(); return r; }
function viaInfT(seed: any): any { var r; r = infT(); return r; }
function viaInfF(seed: any): any { var r; r = infF(); return r; }
export function annotatedTrue(): number { var v = viaAnnT(undefined); return (typeof v === "boolean" ? 10 : 0) + (v === true ? 1 : v === false ? 2 : 3); }
export function annotatedFalse(): number { var v = viaAnnF(undefined); return (typeof v === "boolean" ? 10 : 0) + (v === true ? 1 : v === false ? 2 : 3); }
export function inferredTrue(): number { var v = viaInfT(undefined); return (typeof v === "boolean" ? 10 : 0) + (v === true ? 1 : v === false ? 2 : 3); }
export function inferredFalse(): number { var v = viaInfF(undefined); return (typeof v === "boolean" ? 10 : 0) + (v === true ? 1 : v === false ? 2 : 3); }
`;

const BODY = `function isSameValue(a, b) { if (a === 0 && b === 0) return 1 / a === 1 / b; if (a !== a && b !== b) return true; return a === b; }
function isWritable(obj, name, verifyProp, value) {
  var unlikelyValue = "unlikelyValue";
  var newValue = value || unlikelyValue;
  var oldValue = obj[name];
  var writeSucceeded;
  if (arguments.length < 4 && newValue === oldValue) {
    newValue = newValue + "2";
  }
  try {
    obj[name] = newValue;
  } catch (e) {
    if (!(e instanceof TypeError)) {
      throw e;
    }
  }
  writeSucceeded = isSameValue(obj[verifyProp || name], newValue);
  if (writeSucceeded) {
    obj[name] = oldValue;
  }
  return writeSucceeded;
}
var o = { w: 1 };
Object.defineProperty(o, "nw", { value: 2, writable: false });
Object.defineProperty(o, "acc", { get: function () { return 3; }, set: function (v) {} });
var sym = Symbol("s");
o[sym] = 4;
assert.sameValue(isWritable(o, "w"), true, "w");
assert.sameValue(o.w, 1, "w restored");
assert.sameValue(isWritable(o, "nw"), false, "nw");
assert.sameValue(isWritable(o, "acc"), false, "acc");
assert.sameValue(isWritable(o, sym), true, "sym");
assert.sameValue(isWritable(o, "w", undefined, 9), true, "w with value");
assert.sameValue(isWritable([1, 2], "length", undefined, 5), true, "array length");
assert.sameValue(isWritable(Object.freeze({ f: 1 }), "f"), false, "frozen");
`;

const dir = mkdtempSync(join(tmpdir(), "issue-7265-"));

function fixture(flag: string): string {
  const path = join(dir, `${flag}.js`);
  writeFileSync(path, `/*---\nflags: [${flag}]\n---*/\n${BODY}`);
  return path;
}

async function irOutcomes(path: string) {
  const source = readFileSync(path, "utf8");
  const meta = parseMeta(source);
  const variant = assembleOriginalHarness(source, meta).primary;
  const result = await compile(variant.source, {
    ...originalHarnessCompileOptions(meta, "standalone"),
    fileName: path,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result.irOutcomes ?? [];
}

describe("#7265 boolean call result into a dynamic var, dynamic computed key", () => {
  // Strict function code keeps #7260's store on legacy (#7270), so the strict
  // fixture stays legacy and still passes.
  for (const [flag, claimed] of [
    ["noStrict", true],
    ["onlyStrict", false],
  ] as const) {
    it(`${claimed ? "IR-emits" : "keeps legacy"} isWritable and passes the ${flag} fixture`, async () => {
      const path = fixture(flag);
      const outcome = (await irOutcomes(path)).find((o) => o.displayName === "isWritable");
      expect(outcome?.irBodyEmitted).toBe(claimed);
      expect(await runTest262File(path, "issue-7265", undefined, "standalone")).toMatchObject({ status: "pass" });
    });
  }

  for (const target of ["standalone", "gc"] as const) {
    it(`boxes annotated and inferred Boolean call results as JS Booleans on ${target}`, async () => {
      const result = await compile(BOOL_CALLS, { fileName: "issue-7265-bool.ts", target, trackIrOutcomes: true });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      for (const name of ["viaAnnT", "viaAnnF", "viaInfT", "viaInfF"]) {
        expect(result.irOutcomes?.find((o) => o.displayName === name)?.irBodyEmitted, name).toBe(true);
      }
      const imports = target === "gc" ? buildImports(result.imports ?? [], undefined, result.stringPool ?? []) : {};
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      const exports = instance.exports as Record<string, () => number>;
      (instance.exports.__module_init as (() => void) | undefined)?.();
      expect(exports.annotatedTrue!()).toBe(11);
      expect(exports.annotatedFalse!()).toBe(12);
      expect(exports.inferredTrue!()).toBe(11);
      expect(exports.inferredFalse!()).toBe(12);
    });
  }
});
