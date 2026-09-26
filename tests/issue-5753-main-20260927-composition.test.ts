// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { compile as candidateCompile } from "../src/index.js";

// Use the same fixture/options for the two exact parents and the merged tree.
// This mirrors issue-5753-generator-merge-preservation.test.ts.
const compilerRoot = process.env.GENERATOR_MERGE_COMPILER_ROOT;
const compile: typeof candidateCompile = compilerRoot
  ? (await import(pathToFileURL(`${compilerRoot}/src/index.ts`).href)).compile
  : candidateCompile;

// A top-level declaration is intentional: main admits host protocol delegation
// there, while nested host declarations retain the eager fallback. The array
// element type is an object, so this distinguishes host protocol from native vec.
const arraySource = `
var first = { value: 3 };
var second = { value: 4 };
var closed = 0;
var completed = 0;
function* values() {
  try {
    var completion = yield* [first, second];
    completed = completion === undefined ? 1 : -1;
  } finally {
    closed++;
  }
}
export function normal() {
  closed = 0; completed = 0;
  var it = values();
  if (closed !== 0 || completed !== 0) return -1;
  var a = it.next();
  var b = it.next();
  if (a.value !== first || b.value !== second || a.done || b.done) return -2;
  if (closed !== 0 || completed !== 0) return -3;
  var end = it.next();
  if (!end.done || end.value !== undefined || !it.next().done) return -4;
  return a.value.value * 1000 + b.value.value * 100 + closed * 10 + completed;
}
export function returned() {
  closed = 0; completed = 0;
  var it = values();
  var a = it.next();
  if (a.done || a.value !== first || closed !== 0) return -1;
  var end = it.return(second);
  if (!end.done || end.value !== second || !it.next().done) return -2;
  if (completed !== 0) return -3;
  return a.value.value * 100 + end.value.value * 10 + closed;
}
export function thrown() {
  closed = 0; completed = 0;
  var it = values();
  var a = it.next();
  if (a.done || a.value !== first || closed !== 0) return -1;
  var caught = 0;
  try { it.throw(9); }
  catch (error) { caught = error instanceof TypeError ? 1 : -1; }
  if (!it.next().done || completed !== 0) return -2;
  return a.value.value * 100 + closed * 10 + caught;
}
`;

function nativeValue(source: string, entry: string): unknown {
  return new Function(source.replace(/export function /g, "function ") + `; return ${entry}();`)();
}

it("classifies host normal-completion predicates without changing the original fixture", async () => {
  const before = "if (!end.done || end.value !== undefined || !it.next().done) return -4;";
  expect(arraySource.includes(before)).toBe(true);
  const source = arraySource.replace(
    before,
    `
    if (!end.done) return -41;
    if (end.value !== undefined) return end.value === null ? -420 : -421;
    if (!it.next().done) return -43;
  `,
  );
  expect(nativeValue(source, "normal")).toBe(3411);
  const result = await compile(source, { fileName: "composition.js", target: "gc", skipSemanticDiagnostics: true });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const imports = (result.importObject ?? {}) as WebAssembly.Imports & {
    setInstance?(instance: WebAssembly.Instance): void;
    __setInstance?(instance: WebAssembly.Instance): void;
  };
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
  imports.setInstance?.(instance);
  imports.__setInstance?.(instance);
  expect((instance.exports.normal as () => number)()).toBe(3411);
});

const arrayCases = [
  // Array exhaustion yields undefined completion, then runs finally once.
  { entry: "normal", expected: 3411 }, // 3*1000 + 4*100 + 1*10 + 1
  // ArrayIterator has no return method: propagate the supplied object unchanged.
  { entry: "returned", expected: 341 }, // 3*100 + 4*10 + 1
  // ArrayIterator has no throw method: throw TypeError, not the supplied 9.
  { entry: "thrown", expected: 311 }, // 3*100 + 1*10 + 1
] as const;

it("replaces the supplied throw payload when an array delegate lacks throw", async () => {
  const source =
    arraySource +
    `
export function classifyThrow() {
  var it = values(); it.next();
  try { it.throw(9); }
  catch (error) { return error === 9 ? 9 : error instanceof TypeError ? 1 : 2; }
  return 0;
}`;
  expect(nativeValue(source, "classifyThrow")).toBe(1);
  const result = await compile(source, {
    fileName: "composition.js",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  expect((instance.exports.classifyThrow as () => number)()).toBe(1);
});

describe.each(["gc", "standalone"] as const)("PR5753 exact-main array composition: %s", (target) => {
  it.each(arrayCases)("$entry preserves completion, identity and finally", async ({ entry, expected }) => {
    expect(nativeValue(arraySource, entry)).toBe(expected);
    const result = await compile(arraySource, {
      fileName: "composition.js",
      target,
      // Compare JavaScript semantics, including return(object) on inferred void.
      skipSemanticDiagnostics: true,
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    const importNames = WebAssembly.Module.imports(module).map((item) => item.name);
    if (target === "standalone") {
      expect(importNames).toEqual([]);
    } else {
      // Main's host protocol arm must win over the branch's broader vec arm.
      expect(importNames).toContain("__gen_yield_star_step");
      expect(importNames).not.toContain("__gen_yield_star");
    }
    const imports = (result.importObject ?? {}) as WebAssembly.Imports & {
      setInstance?(instance: WebAssembly.Instance): void;
      __setInstance?(instance: WebAssembly.Instance): void;
    };
    const instance = new WebAssembly.Instance(module, imports);
    imports.setInstance?.(instance);
    imports.__setInstance?.(instance);
    expect((instance.exports[entry] as () => number)()).toBe(expected);
  });
});

// Existing class-default-across-suspension guard from issue-3952, composed with
// the var-redeclaration OPEN-object shape from issue-6651 A3 / issue-1672.
const unsupportedMethodSource = `
var obj = {};
var obj = {
  *method({ K = class { v() { return 41; } } } = {}) {
    yield 0;
    yield new K().v() + 1;
  }
};
export function run() {
  var it = obj.method();
  it.next();
  return it.next().value;
}
`;

it("keeps the unsupported open-method class default on the legacy generator fallback", async () => {
  expect(nativeValue(unsupportedMethodSource, "run")).toBe(42);
  const result = await compile(unsupportedMethodSource, {
    fileName: "composition.js",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  const generatorImports = WebAssembly.Module.imports(module).filter((item) => item.name.startsWith("__gen_"));
  // Preservation only, NOT a standalone conformance success. The existing
  // issue-3952 guard requires a host fallback for this unsupported default.
  // A failure must be compared with both parents, never fixed by widening a gate.
  expect(generatorImports.length).toBeGreaterThan(0);
});

// Do not duplicate these exact existing controls:
// - issue-1058-generator-worklist-delegation: object vec identity/mutation,
//   return/throw, suspended cleanup, and outer IteratorClose.
// - issue-1672-async-gen-method-trampoline: async open-object extracted methods
//   return real next() results and enter the body once (both expectations: 1).
// - issue-1058-open-object-generator-method: lazy native method and receiver.
