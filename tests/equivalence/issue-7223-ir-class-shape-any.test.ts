// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7223 — `buildIrClassShapes` projected every class-member position through
// `tsTypeToClassPositionIr`, which returned `null` for `any`. Untyped JS
// classes (all of test262) therefore lost their whole class shape (one `any`
// instance-method position dropped the class) or the member's descriptor
// (static methods / accessors), and every member stayed on the legacy body.
// `any`/`unknown` positions now project as the IR `dynamic` value — the same
// carrier legacy `resolveWasmType` gives them — and the selector takes the
// descriptor's dynamic positions as its ABI evidence.
//
// Each case asserts the IR route (`trackIrOutcomes`) and the result against
// the JS evaluation of the same source.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
  { name: "gc (default)", options: {} },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

async function compileAndRun(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7223.js", trackIrOutcomes: true, ...options });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const instance =
    options.target === "standalone"
      ? (await WebAssembly.instantiate(result.binary, {})).instance
      : options.target === "wasi"
        ? (await WebAssembly.instantiate(result.binary, { wasi_snapshot_preview1: wasiStub })).instance
        : await instantiateWithRuntime(result);
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return { result, value: exports.test!() };
}

interface Case {
  readonly source: string;
  /** Class-member units that must take the IR body. */
  readonly irUnits: readonly string[];
}

const CASES: Record<string, Case> = {
  "instance method with an untyped parameter and return": {
    source: `
class C { m(x) { return x; } }
export function test() { return new C().m(7); }`,
    irUnits: ["C_m"],
  },
  "static method with untyped parameters": {
    source: `
class C { static pick(x, y) { return y; } }
export function test() { return C.pick(1, 4); }`,
    irUnits: ["C_pick"],
  },
  "private instance method beside a public one": {
    source: `
class C { #p(x) { return x; } m(x) { return x; } }
export function test() { return new C().m(5); }`,
    irUnits: ["C___priv_p", "C_m"],
  },
  "setter with an untyped parameter": {
    source: `
class C { set g(v) { } }
export function test() { const c = new C(); c.g = 1; return 3; }`,
    irUnits: ["C_set_g"],
  },
  "untyped field no longer drops the class shape": {
    source: `
class C { f; m(x) { return x; } }
export function test() { const c = new C(); c.f = 2; return c.m(1) + c.f; }`,
    irUnits: ["C_m"],
  },
  "subclass with untyped methods and constructors": {
    source: `
class A { constructor() {} id(x) { return x; } }
class B extends A { constructor() { super(); } pick(x, y) { return y; } }
export function test() { const b = new B(); return b.id(3) + b.pick(1, 4); }`,
    irUnits: ["A_new", "A_id", "B_new", "B_pick"],
  },
};

describe("#7223 untyped class members project as dynamic and reach the IR", () => {
  for (const [label, { source, irUnits }] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${label} — ${lane.name}`, async () => {
        const expected = evaluateAsJs(source).test!();
        const { result, value } = await compileAndRun(source, lane.options);
        expect(value).toBe(expected);
        for (const unit of irUnits) {
          expect(
            result.irOutcomes?.find((o) => o.displayName === unit),
            `${unit} takes the IR body`,
          ).toMatchObject({ kind: "emitted" });
        }
      }, 120_000);
    }
  }
});
