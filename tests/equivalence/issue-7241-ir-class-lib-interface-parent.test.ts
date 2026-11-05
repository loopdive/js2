// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7241 — two class-shape gaps:
//
//   - `class X extends Iterator`: the lib declares `Iterator` as an interface
//     only, so the heritage has no value binding and the direct backend lays
//     `X` out as an ordinary root struct. `buildIrClassShapes` now projects it
//     as a flat shape and the selector admits its own `super`-free methods.
//     The constructor and `get next` accessors stay legacy.
//   - array-returning members of the injected `Intl.ListFormat` polyfill
//     (`formatToParts`, `static supportedLocalesOf`): an `any[]` result now
//     projects to legacy's exact `$__vec_externref` slot, so the members get a
//     descriptor. Their bodies still stop at the selector's own return
//     resolution (`return-type-not-resolvable`), like `format` beside them.
//
// Each case asserts the route (`trackIrOutcomes`) and the result on
// standalone, WASI and the default gc target. A top-level `extends Iterator`
// class whose module init stays legacy throws there on standalone and gc on
// base already; those lanes pin that legacy outcome rather than the JS value.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
  { name: "gc (default)", options: {} },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

async function compileFor(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7241.js", trackIrOutcomes: true, ...options });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  return result;
}

async function run(result: Awaited<ReturnType<typeof compile>>, options: CompileOptions): Promise<unknown> {
  const instance =
    options.target === "standalone"
      ? (await WebAssembly.instantiate(result.binary, {})).instance
      : options.target === "wasi"
        ? (await WebAssembly.instantiate(result.binary, { wasi_snapshot_preview1: wasiStub })).instance
        : await instantiateWithRuntime(result);
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return exports.test!();
}

function outcome(result: Awaited<ReturnType<typeof compile>>, unit: string) {
  return result.irOutcomes?.find((o) => o.displayName === unit);
}

interface Case {
  readonly source: string;
  readonly irUnits: readonly string[];
  readonly legacyUnits: readonly string[];
  /** Lanes whose module init throws on base too (top-level `extends Iterator`). */
  readonly throwsOn?: readonly string[];
}

const ITERATOR_LEGACY_THROW = ["standalone", "gc (default)"];

const ITERATOR_CASES: Record<string, Case> = {
  "own methods take the IR; the explicit constructor stays legacy": {
    source: `
class C extends Iterator {
  constructor() { super(); this.i = 0; }
  m() { return 2; }
  w(d) { this.i = this.i + d; }
  next() { this.i++; return { value: this.i, done: this.i > 3 }; }
}
export function test() { const c = new C(); c.w(4); return c.m() * 100 + c.i; }`,
    irUnits: ["C_m"],
    // A dynamic parameter used in arithmetic: the move-only scan's refusal.
    legacyUnits: ["C_new", "C_w"],
    throwsOn: ITERATOR_LEGACY_THROW,
  },
  "a method used as a value and through .call": {
    source: `
class C extends Iterator {
  constructor() { super(); this.k = 5; }
  val() { return 7; }
  next() { return { value: this.k, done: true }; }
}
export function test() { const c = new C(); const f = c.val; return f() + C.prototype.val.call(c) * 10; }`,
    irUnits: ["C_val"],
    legacyUnits: ["C_new"],
    throwsOn: ITERATOR_LEGACY_THROW,
  },
  "a static method; a throwing method": {
    source: `
class C extends Iterator {
  static k() { return 4; }
  t() { throw new RangeError("r"); }
}
export function test() { return C.k(); }`,
    irUnits: ["C_k"],
    // `throw new RangeError(...)`: the selector refuses it (error-constructor-unsupported).
    legacyUnits: ["C_t"],
    throwsOn: ITERATOR_LEGACY_THROW,
  },
  "a get next accessor stays legacy": {
    source: `
let n = 0;
class C extends Iterator {
  get next() { n++; return function () { return { value: 1, done: true }; }; }
  m() { return 3; }
}
export function test() { const c = new C(); return c.m() + n; }`,
    irUnits: ["C_m"],
    legacyUnits: ["C_get_next"],
    // Module init takes the IR here and does not throw on any lane.
  },
  "a super-referencing method of a subclass of the subclass stays legacy": {
    source: `
class A extends Iterator { m() { return 2; } }
class B extends A { m() { return super.m() * 10; } }
export function test() { return new B().m() + new A().m(); }`,
    irUnits: [],
    legacyUnits: ["B_m"],
    throwsOn: ITERATOR_LEGACY_THROW,
  },
};

describe("#7241 classes extending a lib interface get a flat shape", () => {
  for (const [label, { source, irUnits, legacyUnits, throwsOn = [] }] of Object.entries(ITERATOR_CASES)) {
    for (const lane of LANES) {
      it(`${label} — ${lane.name}`, async () => {
        const result = await compileFor(source, lane.options);
        for (const unit of irUnits) expect(outcome(result, unit)?.kind, `${unit} takes the IR body`).toBe("emitted");
        for (const unit of legacyUnits) {
          expect(outcome(result, unit)?.kind, `${unit} stays on the legacy body`).toBe("unsupported");
        }
        if (throwsOn.includes(lane.name)) {
          await expect(run(result, lane.options)).rejects.toBeDefined();
        } else {
          expect(await run(result, lane.options)).toBe(evaluateAsJs(source).test!());
        }
      }, 120_000);
    }
  }
});

const LIST_FORMAT_SOURCE = `
function h(s) { let r = 0; for (let i = 0; i < s.length; i++) r = (r * 31 + s.charCodeAt(i)) | 0; return r; }
export function test() {
  const lf = new Intl.ListFormat("en", { type: "disjunction" });
  const parts = lf.formatToParts(["x", "y", "z"]);
  const supported = Intl.ListFormat.supportedLocalesOf(["en-US"]);
  return parts.length * 1000 + h(parts[1].value + parts.map((p) => p.type).join("")) % 1000 +
    supported.length * 100000 + (Array.isArray(supported) ? 1000000 : 0) + h(JSON.stringify(parts)) % 7;
}`;

describe("#7241 array-returning ListFormat polyfill members get a descriptor", () => {
  for (const lane of LANES) {
    it(`formatToParts / supportedLocalesOf — ${lane.name}`, async () => {
      const result = await compileFor(LIST_FORMAT_SOURCE, lane.options);
      for (const unit of ["__js2wasm_Intl_ListFormat_formatToParts", "__js2wasm_Intl_ListFormat_supportedLocalesOf"]) {
        const o = outcome(result, unit);
        expect(o?.kind, unit).toBe("unsupported");
        // The descriptor exists; the body stops at the selector's return
        // resolution, as the sibling `format` does.
        expect(o?.code, unit).toBe("return-type-not-resolvable");
      }
      expect(outcome(result, "__js2wasm_Intl_ListFormat_new")?.kind).toBe("unsupported");
      // WASI's `supportedLocalesOf` already diverges from node on base (1005942).
      const expected = lane.options.target === "wasi" ? 1005942 : evaluateAsJs(LIST_FORMAT_SOURCE).test!();
      expect(await run(result, lane.options)).toBe(expected);
    }, 120_000);
  }
});
