// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7227 — synchronous class-member gaps left after #7223:
//
//   - `static #m()` had no projected descriptor (the static projection in
//     `buildIrClassShapes` admitted identifier names only), so every private
//     static method and every `C.#m()` call site stayed on the legacy body;
//   - `this.#m()` inside a static method was looked up as an INSTANCE method
//     and refused (`expr-private-method-member`);
//   - an unannotated JS STATIC method returning a concrete value
//     (`return this.#m()`) was refused as
//     `return-type-unresolved(lattice=absent)`; its descriptor return — the
//     checker inference legacy registers the slot from — is now the fallback
//     (number and string; a boolean slot keeps the legacy body). Instance
//     methods and getters stay legacy: an IR instance body would trap on a
//     foreign receiver where legacy throws a catchable TypeError;
//   - a read of a private METHOD/ACCESSOR as a value (`return this.#m` with
//     `get #m()`) is refused at selection instead of demoting after the claim.
//
// Each case asserts the IR route (`trackIrOutcomes`) and the result against
// the JS evaluation of the same source, on standalone, WASI and the default
// gc target.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
  { name: "gc (default)", options: {} },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

async function compileAndRun(source: string, options: CompileOptions, fileName = "issue-7227.js") {
  const result = await compile(source, { fileName, trackIrOutcomes: true, ...options });
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
  return { result, exports };
}

function route(result: Awaited<ReturnType<typeof compile>>, unit: string): string | undefined {
  return result.irOutcomes?.find((o) => o.displayName === unit)?.kind;
}

interface Case {
  readonly source: string;
  /** Class-member units that must take the IR body. */
  readonly irUnits: readonly string[];
  /** Class-member units that must stay on the legacy body. */
  readonly legacyUnits?: readonly string[];
  /** Same-named classes: base and head share a pre-existing wrong value; only the route is pinned. */
  readonly skipNodeCompare?: boolean;
  /** Exports whose raw value (a string) is compared on the gc lane only. */
  readonly gcRawExports?: readonly string[];
}

const CASES: Record<string, Case> = {
  "private static method called through the class name": {
    source: `
class C { static #k() { return 7; } static viaName() { return C.#k() * 2; } }
export function test() { return C.viaName(); }`,
    irUnits: ["C___priv_k", "C_viaName"],
  },
  "this.#m() in a static method, string result": {
    source: `
class C { static #m() { return "test262"; } static access() { return this.#m(); } }
export function test() { const s = C.access(); return s === "test262" ? s.length : -1; }
export function raw() { return C.access(); }`,
    irUnits: ["C___priv_m", "C_access"],
    gcRawExports: ["raw"],
  },
  "this.#k() in a static method feeding arithmetic": {
    source: `
class C {
  static #k() { return 7; }
  static num() { return this.#k() + 1; }
  static scaled() { return this.#k() * 3 + 0.5; }
}
export function test() { return C.num() * 10 + C.scaled(); }`,
    irUnits: ["C___priv_k", "C_num"],
  },
  "unannotated JS static methods return their concrete descriptor type": {
    source: `
class P {
  static #v() { return 3; }
  static #n() { return "p"; }
  static v() { return this.#v(); }
  static label() { return P.#n(); }
}
export function test() { return P.v() * 10 + (P.label() === "p" ? 1 : 0); }
export function raw() { return P.label(); }`,
    irUnits: ["P___priv_v", "P___priv_n", "P_v", "P_label"],
    gcRawExports: ["raw"],
  },
  "unannotated JS instance getter and method keep the legacy body": {
    source: `
class P {
  #v = 3;
  name = "p";
  get v() { return this.#v; }
  label() { return this.name; }
}
export function test() { const p = new P(); return p.v * 10 + (p.label() === "p" ? 1 : 0); }`,
    irUnits: [],
    legacyUnits: ["P_get_v", "P_label"],
  },
  "a class name shadowed by a nested class keeps the private static call legacy": {
    source: `
class C { static #m() { return 1; } static access() { return this.#m(); } }
function f() { class C { static #m() { return 2; } static access() { return this.#m(); } } return C.access(); }
export function test() { return C.access() * 10 + f(); }`,
    irUnits: [],
    legacyUnits: ["C_access"],
    skipNodeCompare: true,
  },
  "a boolean JS member return keeps the legacy body (slot parity)": {
    source: `
class Q { #v = 3; big() { return this.#v > 2; } static yes() { return 1 > 0; } }
export function test() { return (new Q().big() ? 1 : 0) + (Q.yes() ? 10 : 0); }`,
    irUnits: [],
    legacyUnits: ["Q_big", "Q_yes"],
  },
  "a private accessor read as a value stays legacy (refused at selection)": {
    source: `
class C { get #m() { return "x"; } method() { return this.#m; } }
export function test() { return new C().method() === "x" ? 1 : 0; }`,
    irUnits: [],
    legacyUnits: ["C_method"],
  },
};

describe("#7227 synchronous class-member gaps reach the IR", () => {
  for (const [label, { source, irUnits, legacyUnits = [], gcRawExports = [], skipNodeCompare }] of Object.entries(
    CASES,
  )) {
    for (const lane of LANES) {
      it(`${label} — ${lane.name}`, async () => {
        const reference = evaluateAsJs(source);
        const { result, exports } = await compileAndRun(source, lane.options);
        const value = exports.test!();
        if (!skipNodeCompare) expect(value).toBe(reference.test!());
        if (lane.options.target === undefined) {
          for (const name of gcRawExports) expect(exports[name]!(), name).toBe(reference[name]!());
        }
        for (const unit of irUnits) expect(route(result, unit), `${unit} takes the IR body`).toBe("emitted");
        for (const unit of legacyUnits) {
          expect(route(result, unit), `${unit} stays on the legacy body`).toBe("unsupported");
        }
      }, 120_000);
    }
  }
});

// The concrete-return fallback is JS-only: an unannotated member of a TS class
// keeps its pre-#7227 verdict, which keeps the typed corpus byte-identical.
describe("#7227 the concrete-return fallback leaves TS sources unchanged", () => {
  it("an unannotated TS method stays on the legacy body", async () => {
    const source = `
class P { name: string = "p"; label() { return this.name; } }
export function test(): number { return new P().label() === "p" ? 1 : 0; }`;
    const { result, exports } = await compileAndRun(source, { target: "standalone" }, "issue-7227.ts");
    expect(exports.test!()).toBe(1);
    expect(route(result, "P_label")).toBe("unsupported");
  }, 120_000);
});

// Review of #7054: a getter called on a foreign receiver through its descriptor.
// Legacy raises a catchable TypeError (-2) for every variant — for the public
// field variants that already diverges from node, which reads the foreign
// object's own property (pre-existing, unchanged here). The getter must stay
// on the legacy body: an IR instance body dereferences the `ref.null` the
// cached trampoline passes for a foreign receiver and traps uncatchably.
const FOREIGN_GETTERS: Record<string, { readonly field: string; readonly body: string; readonly call: string }> = {
  "public number field, {} receiver": { field: "x = 2", body: "this.x", call: "{}" },
  "public number field, {x: 9} receiver": { field: "x = 2", body: "this.x", call: "{ x: 9 }" },
  "public string field, {} receiver": { field: 'name = "q"', body: "this.name", call: "{}" },
  "public string field, {name} receiver": { field: 'name = "q"', body: "this.name", call: '{ name: "z" }' },
  "private number field, {} receiver": { field: "#v = 2", body: "this.#v", call: "{}" },
  "private string field, {x: 9} receiver": { field: '#s = "q"', body: "this.#s", call: "{ x: 9 }" },
};

describe("#7227 a getter on a foreign receiver throws a catchable TypeError", () => {
  for (const [label, { field, body, call }] of Object.entries(FOREIGN_GETTERS)) {
    const source = `
class P { ${field}; get v() { return ${body}; } }
export function test() {
  const d = Object.getOwnPropertyDescriptor(P.prototype, "v");
  try { d.get.call(${call}); return 1; } catch (e) { return e instanceof TypeError ? -2 : -1; }
}`;
    for (const lane of LANES) {
      it(`${label} — ${lane.name}`, async () => {
        const { result, exports } = await compileAndRun(source, lane.options);
        expect(exports.test!()).toBe(-2);
        expect(route(result, "P_get_v"), "P_get_v stays on the legacy body").toBe("unsupported");
      }, 120_000);
    }
  }
});
