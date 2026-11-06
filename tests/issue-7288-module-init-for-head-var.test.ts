// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7288 — a script's top-level `for (var i = …; …; …)` head is a module
// binding: legacy hoists it into the same `__mod_<name>` slot as a top-level
// `var` statement, and the IR now lowers it there instead of refusing the
// `<module-init>` unit (`for-init-var-kind`). A top-level `for (var k in o)`
// head is refused up front (`forin-head-module-var`) instead of being claimed
// and then withdrawn by from-ast.
//
// Each case asserts the verdict on standalone, WASI and the default gc target
// against the sloppy JS evaluation of the same source, and the route of the
// named units.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
  { name: "gc (default)", options: {} },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

async function compileAndRun(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7288.js", trackIrOutcomes: true, ...options });
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
  /** The lanes on which `<module-init>` takes the IR body; on the others it keeps legacy's. */
  readonly irOn: readonly string[];
}

const ALL = ["standalone", "wasi", "gc (default)"];

// A string throw keeps the checks themselves on the IR path.
const CASES: Record<string, Case> = {
  "the counter survives the loop": {
    source: `var n = 0;
for (var i = 0; i < 3; i++) { n = n + i; }
if (n !== 3 || i !== 3) throw "for";`,
    irOn: ALL,
  },
  "read before the loop is undefined (hoisted)": {
    source: `if (typeof i !== "undefined") throw "pre";
for (var i = 0; i < 3; i++) {}
if (i !== 3) throw "post";`,
    irOn: ALL,
  },
  "a redeclared head shares one slot": {
    source: `var n = 0;
for (var i = 0; i < 2; i++) { n++; }
for (var i = 5; i < 7; i++) { n++; }
if (n !== 4 || i !== 7) throw "redecl";`,
    irOn: ALL,
  },
  "a labelled loop with continue": {
    source: `var n = 0;
outer: for (var i = 0; i < 3; i++) { if (i === 1) continue outer; n++; }
if (n !== 2 || i !== 3) throw "label";`,
    irOn: ALL,
  },
  "several declarators": {
    source: `for (var i = 0, j = 10; i < 3; i++, j--) {}
if (i !== 3 || j !== 7) throw "multi";`,
    irOn: ALL,
  },
  "break leaves the counter": {
    source: `for (var i = 0; i < 3; i++) { if (i === 1) break; }
if (i !== 1) throw "break";`,
    irOn: ALL,
  },
  "typeof after the loop": {
    source: `for (var x = 0.5; x < 2; x = x * 2) {}
if (typeof x !== "number" || x !== 2) throw "typeof";`,
    irOn: ALL,
  },
  // Shapes that keep legacy (refused up front, never claimed and withdrawn).
  "a for-in head": {
    source: `var seen = false;
for (var k in { a: 1 }) { seen = true; }
if (!seen) throw "forin";`,
    irOn: [],
  },
  "a head without an initializer": {
    source: `var n = 0;
for (var i; n < 2; n++) {}
if (i !== undefined) throw "noinit";`,
    irOn: [],
  },
  "a head that redeclares a top-level var statement": {
    source: `var i = 10;
for (var i = 0; i < 2; i++) {}
if (i !== 2) throw "stmt+head";`,
    irOn: [],
  },
  "a function reads the counter after the loop": {
    source: `function f() { return i; }
for (var i = 0; i < 3; i++) {}
if (f() !== 3) throw "fn";`,
    irOn: [],
  },
};

describe("#7288 top-level for-head var in module-init", () => {
  for (const [label, testCase] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${label} (${lane.name})`, async () => {
        const { result, value } = await compileAndRun(testCase.source, lane.options);
        expect(value).toBe(scriptVerdict(testCase.source));
        expect(route(result, "<module-init>")).toBe(testCase.irOn.includes(lane.name));
      });
    }
  }
});
