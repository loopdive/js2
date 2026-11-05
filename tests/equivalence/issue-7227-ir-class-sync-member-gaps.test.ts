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
// Historical a15e compatibility expected TypeError for all six variants.
// The actual original43 baseline and source are retained in the Nov4 receipts.
// Current public access must preserve the actual foreign receiver like Node;
// private access still throws for a missing brand. The nominal getter route
// remains unchanged: generic source-entry binding is not an IR ownership claim.
const FOREIGN_GETTERS: Record<string, { readonly field: string; readonly body: string; readonly call: string }> = {
  "public number field, {} receiver": { field: "x = 2", body: "this.x", call: "{}" },
  "public number field, {x: 9} receiver": { field: "x = 2", body: "this.x", call: "{ x: 9 }" },
  "public string field, {} receiver": { field: 'name = "q"', body: "this.name", call: "{}" },
  "public string field, {name} receiver": { field: 'name = "q"', body: "this.name", call: '{ name: "z" }' },
  "private number field, {} receiver": { field: "#v = 2", body: "this.#v", call: "{}" },
  "private string field, {x: 9} receiver": { field: '#s = "q"', body: "this.#s", call: "{ x: 9 }" },
};

describe("#7227 extracted getters preserve public receivers and private brands", () => {
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
        const reference = evaluateAsJs(source);
        expect(exports.test!()).toBe(reference.test!());
        expect(route(result, "P_get_v"), "nominal P_get_v ownership stays unchanged").toBe("unsupported");
      }, 120_000);
    }
  }
});

// Full source bodies and real JS values: these are not ABI-shape mirrors.
const GENERIC_GETTER_CASES: Record<string, { source: string; fileName?: string; irUnits?: readonly string[] }> = {
  "foreign addition preserves string concatenation and once-only Get and valueOf": {
    source: `
let gets = 0;
let conversions = 0;
class P { x = 2; get value() { return this.x + 1; } }
export function test() {
  const g = Object.getOwnPropertyDescriptor(P.prototype, "value").get;
  const value = {valueOf() { conversions++; return "z"; }};
  const receiver = {get x() { gets++; return value; }};
  return g.call({x: 9}) === 10 && g.call({x: "a"}) === "a1" &&
    g.call(receiver) === "z1" && gets === 1 && conversions === 1 ? 1 : 0;
}`,
  },
  "ordinary named, arrow, parameter and alias calls retain call/apply behavior": {
    source: `
const token = {value: 10};
function ordinary(a, b) { return (this === token ? 10 : 0) + arguments.length + a + b; }
function invoke(fn) { return fn.call(token, 3, 4) + fn.apply(token, [3, 4]); }
function mapped(fn) { return [7].map(fn, token)[0]; }
function makeArrow() { return (a, b) => this.value + a + b; }
export function test() {
  const literal = function(a, b) { return this.value + arguments.length + a + b; };
  const alias = literal;
  let mutable = alias;
  const arrow = makeArrow.call(token);
  return ordinary.call(token, 3, 4) === 19 && ordinary.apply(token, [3, 4]) === 19 &&
    invoke(ordinary) === 38 && mapped(ordinary) === 20 && literal.call(token, 3, 4) === 19 &&
    alias.apply(token, [3, 4]) === 19 && mutable.call(token, 3, 4) === 19 &&
    arrow.call({value: 100}, 3, 4) === 17 && arrow.apply({value: 100}, [3, 4]) === 17 ? 1 : 0;
}`,
  },
  "source arguments and raw receivers survive free, call, apply, bind and HOF invocation": {
    source: `
const token = {};
let callbackArray;
class P {
  get value() {
    let mask = this === undefined ? 1 : this === token ? 2 : 0;
    if (arguments.length === 2 && arguments[0] === 7 && arguments[1] === 8) mask += 4;
    if (arguments.length === 3 && arguments[0] === 7 && arguments[1] === 0 && arguments[2] === callbackArray) mask += 8;
    return mask;
  }
}
export function test() {
  const actual = Object.getOwnPropertyDescriptor(P.prototype, "value").get;
  if (typeof actual !== "function") throw new Error("class descriptor must contain its getter");
  /** @type {(...args: any[]) => any} */
  const g = actual;
  const free = g(7, 8);
  const called = g.call(token, 7, 8);
  const applied = g.apply(token, [7, 8]);
  const bound = g.bind(token, 7)(8);
  callbackArray = [7];
  const mapped = callbackArray.map(g, token)[0];
  return typeof g === "function" && g.name === "get value" && g.length === 0 &&
    free === 5 && called === 6 && applied === 6 && bound === 6 && mapped === 10 ? 1 : 0;
}`,
  },
  "strict receiver identity retains null, undefined, primitives and object identity": {
    source: `
class P { get value() { return this; } }
export function test() {
  const g = Object.getOwnPropertyDescriptor(P.prototype, "value").get;
  const token = {};
  return (g.call(null) === null ? 1 : 0) + (g.call(undefined) === undefined ? 2 : 0) +
    (g.call(7) === 7 ? 4 : 0) + (g.call("s") === "s" ? 8 : 0) +
    (g.call(true) === true ? 16 : 0) + (g.call(token) === token ? 32 : 0) +
    (g() === undefined ? 64 : 0);
}`,
  },
  "duplicate own getter keeps the final declaration and its generic source owner": {
    source: `
class P {
  x = 1;
  get value() { return this.x + 100; }
  get ["value"]() { return this.x; }
}
export function test() {
  const g = Object.getOwnPropertyDescriptor(P.prototype, "value").get;
  const token = {};
  return g.call({x: token}) === token && new P().value === 1 ? 1 : 0;
}`,
  },
  "inherited getter keeps its declaring source body with the actual foreign receiver": {
    source: `
class Base { x = 4; get value() { return this.x; } }
class Child extends Base {}
export function test() {
  const parent = Object.getPrototypeOf(Child.prototype);
  const g = Object.getOwnPropertyDescriptor(parent, "value").get;
  const token = {};
  return g.call({x: token}) === token && g.call(new Child()) === 4 &&
    !Object.hasOwn(Child.prototype, "value") ? 1 : 0;
}`,
  },
  "numeric public read preserves undefined, foreign number and object identity": {
    source: `
class P { x = 2; get value() { return this.x; } }
export function test() {
  const g = Object.getOwnPropertyDescriptor(P.prototype, "value").get;
  const token = {};
  return (g.call({}) === undefined ? 1 : 0) + (g.call({x: 9}) === 9 ? 2 : 0) + (g.call({x: token}) === token ? 4 : 0);
}`,
  },
  "string public read preserves undefined, foreign string and object identity": {
    source: `
class P { name = "q"; get value() { return this.name; } }
export function test() {
  const g = Object.getOwnPropertyDescriptor(P.prototype, "value").get;
  const token = {};
  return (g.call({}) === undefined ? 1 : 0) + (g.call({name: "z"}) === "z" ? 2 : 0) + (g.call({name: token}) === token ? 4 : 0);
}`,
  },
  "receiver and result aliases retain dynamic values": {
    source: `
class P { x = 2; get value() { const self = this; const value = self.x; return value; } }
export function test() {
  const g = Object.getOwnPropertyDescriptor(P.prototype, "value").get;
  const token = {};
  return (g.call({}) === undefined ? 1 : 0) + (g.call({x: 9}) === 9 ? 2 : 0) + (g.call({x: token}) === token ? 4 : 0);
}`,
  },
  "public method call uses the foreign method and its actual receiver": {
    source: `
class P { read() { return 0; } get value() { return this.read(); } }
export function test() {
  const g = Object.getOwnPropertyDescriptor(P.prototype, "value").get;
  const token = {};
  const receiver = { value: token, read() { return this.value; } };
  return g.call(receiver) === token ? 1 : 0;
}`,
  },
  "aliased public method call uses the foreign method and receiver": {
    source: `
class P { read() { return 0; } get value() { const self = this; return self.read(); } }
export function test() {
  const g = Object.getOwnPropertyDescriptor(P.prototype, "value").get;
  const token = {};
  const receiver = { value: token, read() { return this.value; } };
  return g.call(receiver) === token ? 1 : 0;
}`,
  },
  "computed method Get precedes arguments and keeps once-only effects": {
    source: `
let trace = 0;
function key() { trace = trace * 10 + 1; return "read"; }
function argument() { trace = trace * 10 + 2; return 3; }
class P { read(v) { return 0; } get value() { return this[key()](argument()); } }
export function test() {
  const g = Object.getOwnPropertyDescriptor(P.prototype, "value").get;
  const token = {};
  const receiver = { value: token, get read() { trace = trace * 10 + 3; return function(v) { trace = trace * 10 + 4; return v === 3 && this.value === token ? token : null; }; } };
  const value = g.call(receiver);
  return value === token && trace === 1324 ? 1 : 0;
}`,
  },
  "inherited public property is read and the accessor runs once": {
    source: `
let hits = 0;
class P { x = 2; get value() { hits++; return this.x; } }
export function test() {
  const g = Object.getOwnPropertyDescriptor(P.prototype, "value").get;
  const receiver = Object.create({x: 7});
  const value = g.call(receiver);
  return value === 7 && hits === 1 ? 1 : 0;
}`,
  },
  "abrupt foreign property getter keeps the thrown object identity": {
    source: `
const token = {};
class P { x = 2; get value() { return this.x; } }
export function test() {
  const g = Object.getOwnPropertyDescriptor(P.prototype, "value").get;
  const receiver = { get x() { throw token; } };
  try { g.call(receiver); return 0; } catch (error) { return error === token ? 1 : 0; }
}`,
  },
  "strict getter rejects actual null and undefined receivers": {
    source: `
class P { x = 2; get value() { return this.x; } }
export function test() {
  const g = Object.getOwnPropertyDescriptor(P.prototype, "value").get;
  let mask = 0;
  try { g.call(null); } catch (error) { if (error instanceof TypeError) mask += 1; }
  try { g.call(undefined); } catch (error) { if (error instanceof TypeError) mask += 2; }
  return mask;
}`,
  },
  "private lexical brand rejects a foreign receiver and accepts the real instance": {
    source: `
class P { #x = 3; get value() { return this.#x; } }
export function test() {
  const g = Object.getOwnPropertyDescriptor(P.prototype, "value").get;
  let mask = g.call(new P()) === 3 ? 1 : 0;
  try { g.call({}); } catch (error) { if (error instanceof TypeError) mask += 2; }
  return mask;
}`,
  },
  "receiver-insensitive JS getter retains its nominal IR entry": {
    source: `
class P {
  /** @type {number} */
  x = 1;
  /** @returns {number} */
  get value() { return 7; }
}
export function test() { const g = Object.getOwnPropertyDescriptor(P.prototype, "value").get; return g.call({}) + new P().value; }`,
    irUnits: ["P_get_value"],
  },
  "receiver-insensitive annotated getter retains its nominal IR entry": {
    source: `
class P { x: number = 1; get value(): number { return 7; } }
export function test(): number { const g = Object.getOwnPropertyDescriptor(P.prototype, "value")!.get!; return g.call({}) + new P().value; }`,
    fileName: "issue-7227.ts",
    irUnits: ["P_get_value"],
  },
};

describe("#7227 generic getter receiver and result fidelity", () => {
  for (const [label, { source, fileName, irUnits = [] }] of Object.entries(GENERIC_GETTER_CASES)) {
    for (const lane of LANES) {
      it(`${label} — ${lane.name}`, async () => {
        const reference = evaluateAsJs(source);
        const { result, exports } = await compileAndRun(source, lane.options, fileName);
        expect(exports.test!()).toBe(reference.test!());
        for (const unit of irUnits)
          expect(
            route(result, unit),
            `${unit} keeps its actual nominal IR body: ${JSON.stringify(result.irOutcomes?.find((outcome) => outcome.displayName === unit))}`,
          ).toBe("emitted");
      }, 120_000);
    }
  }
});

it("nominal IR getter plus generic source body stays visible to direct-body poison", async () => {
  const source = `
class P {
  /** @type {number} */
  x = 7;
  /** @returns {number} */
  get value() { return this.x; }
}
export function test() {
  const g = Object.getOwnPropertyDescriptor(P.prototype, "value").get;
  return g.call({x: 9}) + new P().value;
}`;
  const { result, exports } = await compileAndRun(source, { target: "standalone" });
  expect(exports.test!()).toBe(evaluateAsJs(source).test!());
  const nominal = result.irOutcomes?.find((outcome) => outcome.displayName === "P_get_value");
  expect(nominal, `actual nominal getter outcome: ${JSON.stringify(nominal)}`).toMatchObject({
    kind: "emitted",
    irBodyEmitted: true,
  });
  const genericRows = result.irBodyRouteAudit?.legacyEntries.filter(
    (entry) => entry.entryPoint === "compileClassBodies" && entry.bodyName === "__class_getter_receiver_P_get_value",
  );
  expect(genericRows).toHaveLength(1);
  const derived = result.irBodyRouteAudit?.derivedUnits.find((unit) => unit.role === "class-getter-generic");
  expect(derived).toMatchObject({ parentId: nominal!.unitId, disposition: "derived-legacy-owner" });
  expect(genericRows![0]).toMatchObject({
    count: 1,
    unitId: derived!.id,
    derivedParentUnitId: nominal!.unitId,
    terminalOwnerId: nominal!.unitId,
  });
  const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
  try {
    process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "P_get_value";
    const poisoned = await compile(source, { target: "standalone", fileName: "issue-7227.js", trackIrOutcomes: true });
    expect(poisoned.success).toBe(false);
    expect(poisoned.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct class-body poison: P_get_value",
    );
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
    else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
  }
}, 120_000);
