// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7280 S1 — a script's top-level `var obj = {}` whose `__mod_` slot is the
// dynamic carrier no longer refuses `<module-init>` as `objectlit-empty`. The
// literal lowers to legacy's open `$Object` (`__new_plain_object`, the #7128
// open-carrier object) boxed onto the carrier, and every use reads it through
// the ordinary dynamic arms. Standalone only: the lane that supplies legacy's
// open-object classification (`isOpenObjectBinding`); WASI and gc keep legacy.
//
// Each case asserts the verdict on all three lanes against the sloppy JS
// evaluation, that no unit is claimed and then withdrawn, and the route of
// `<module-init>`.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
  { name: "gc (default)", options: {} },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

async function compileAndRun(source: string, options: CompileOptions, fileName: string) {
  const result = await compile(source, { fileName, trackIrOutcomes: true, ...options });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  // A script's body runs at instantiation (the start function); its verdict is what it throws.
  try {
    const instance =
      options.target === "standalone"
        ? (await WebAssembly.instantiate(result.binary, {})).instance
        : options.target === "wasi"
          ? (await WebAssembly.instantiate(result.binary, { wasi_snapshot_preview1: wasiStub })).instance
          : await instantiateWithRuntime(result);
    const exports = instance.exports as Record<string, () => unknown>;
    (exports.__module_init ?? exports._start)?.();
    return { result, value: "completed" };
  } catch {
    return { result, value: "threw" };
  }
}

function scriptVerdict(source: string): string {
  try {
    new Function(source)();
    return "completed";
  } catch {
    return "threw";
  }
}

function route(result: Awaited<ReturnType<typeof compile>>, unit: string): boolean | undefined {
  return result.irOutcomes?.find((o) => o.displayName === unit)?.irBodyEmitted;
}

interface Case {
  readonly source: string;
  /** The lanes whose `<module-init>` takes the IR body. */
  readonly irOn: readonly string[];
  /** Lanes whose legacy route itself answers differently from JS: compared with the IR-off compile. */
  readonly againstLegacyOn?: readonly string[];
}

// A string throw keeps the checks themselves on the IR path.
const CASES: Record<string, Case> = {
  "an escaped-name write, then an element read": {
    source: `var obj = {};
obj.def\\u0061ult = 42;
if (obj["default"] !== 42) throw "x";`,
    irOn: ["standalone"],
  },
  "element writes, named reads and an absent key": {
    source: `var obj = {};
obj["a"] = 1;
obj["b"] = "s";
if (obj.a !== 1 || obj.b !== "s") throw "x";
if (typeof obj.c !== "undefined") throw "c";`,
    irOn: ["standalone"],
  },
  "typeof the carrier": {
    source: `var obj = {};
if (typeof obj !== "object") throw "typeof";`,
    irOn: ["standalone"],
  },
  "an inherited method read through the carrier": {
    source: `var obj = {};
if (obj.toString === undefined) throw "proto";`,
    irOn: ["standalone"],
    // WASI's legacy member read misses the inherited method (identical without this change).
    againstLegacyOn: ["wasi"],
  },
  "two literals are two objects": {
    source: `var a = {}, b = {};
if (a === b) throw "id";
a["p"] = 1;
if (b.p !== undefined) throw "shared";`,
    irOn: ["standalone"],
  },
  "strict script code": {
    source: `"use strict";
var obj = {};
obj["x"] = 1;
if (obj.x !== 1) throw "x";`,
    irOn: ["standalone"],
  },
  "passed to a function that reads it": {
    source: `var obj = {};
function f(o) { return o.k; }
obj["k"] = 3;
if (f(obj) !== 3) throw "f";`,
    irOn: ["standalone"],
  },
  "an `in` with an Object.prototype key keeps the unit on legacy": {
    source: `var obj = {};
if (!("toString" in obj)) throw "in";`,
    irOn: [],
  },
  "a for-in over the carrier keeps the unit on legacy": {
    source: `var obj = {};
obj["a"] = 1;
var keys = "";
for (var k in obj) keys += k;
if (keys !== "a") throw keys;`,
    irOn: [],
  },
  "a delete keeps the unit on legacy": {
    source: `var obj = {};
obj["a"] = 2;
if (delete obj["a"] !== true) throw "del";
if (obj.a !== undefined) throw "gone";`,
    irOn: [],
  },
  "an Object.defineProperty target keeps its legacy storage (S3)": {
    source: `var obj = {};
Object.defineProperty(obj, "length", { value: 3 });
if (obj.length !== 3) throw "len";`,
    irOn: [],
  },
};

describe("#7280 S1 top-level `var obj = {}` on the dynamic carrier", () => {
  for (const [label, testCase] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${label} (${lane.name})`, async () => {
        const { result, value } = await compileAndRun(testCase.source, lane.options, "issue-7280.js");
        expect(result.irPostClaimErrors ?? []).toEqual([]);
        const expected = testCase.againstLegacyOn?.includes(lane.name)
          ? (await compileAndRun(testCase.source, { ...lane.options, experimentalIR: false }, "issue-7280.js")).value
          : scriptVerdict(testCase.source);
        expect(value).toBe(expected);
        expect(route(result, "<module-init>")).toBe(testCase.irOn.includes(lane.name));
      });
    }
  }
});
