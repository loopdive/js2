// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7233 — two class-member gaps left after #7227:
//
//   - static private FIELDS: `this.#x` / `C.#x` inside one of `C`'s own static
//     methods now reads and writes the legacy `__static_C___priv_x` module
//     global from the IR body (`staticPrivateFieldOwner`,
//     `resolveIrClassStaticFieldStorage`). Number, string and untyped fields;
//     compound assignment, a field whose initialiser reads `this`, and a
//     dynamic value written through a dynamic parameter stay on legacy;
//   - shape-less JS classes: one unprojectable instance method (async,
//     default / destructured parameter) no longer drops the whole class in
//     `buildIrClassShapes` for a `.js` source; the method keeps its legacy
//     body. TS sources keep the all-or-nothing rule.
//
// Each case asserts the IR route (`trackIrOutcomes`) and the result on
// standalone, WASI and the default gc target — against the JS evaluation of
// the same source, or against the pinned legacy value where legacy already
// diverges from the spec (base and head agree there).
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
  { name: "gc (default)", options: {} },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

async function compileAndRun(source: string, options: CompileOptions, fileName = "issue-7233.js") {
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
  /** Legacy diverges from the spec here; the value base and head both give. */
  readonly legacyValue?: number;
  /** Exports whose raw value (a string) is compared on the gc lane only. */
  readonly gcRawExports?: readonly string[];
}

const CASES: Record<string, Case> = {
  "number static private field: reads, writes, + and comparisons": {
    source: `
class C {
  static #n = 5;
  static getN() { return this.#n; }
  static bump() { C.#n = this.#n + 2; return C.#n; }
  static big() { return this.#n > 6 ? this.#n : 0; }
}
export function test() { const a = C.getN(); const b = C.bump(); return a * 100 + b * 10 + C.big(); }`,
    irUnits: ["C_getN", "C_bump", "C_big"],
  },
  "string static private field": {
    source: `
class S {
  static #s = "ab";
  static read() { return S.#s; }
  static put() { this.#s = "zz"; return 1; }
}
export function test() { const a = S.read(); S.put(); return (a === "ab" ? 10 : 0) + (S.read() === "zz" ? 1 : 0); }
export function raw() { return S.read(); }`,
    irUnits: ["S_read", "S_put"],
    gcRawExports: ["raw"],
  },
  "a subclass receiver reads the one global (no brand check, as legacy)": {
    source: `
class C { static #n = 5; static getN() { return this.#n; } }
class D extends C {}
export function test() { const f = C.getN; try { return D.getN(); } catch (e) { return -1; } }`,
    irUnits: ["C_getN"],
    legacyValue: 5,
  },
  "a foreign receiver via .call({}) reads the one global (no brand check, as legacy)": {
    source: `
class C { static #n = 5; static getN() { return this.#n; } }
class D extends C {}
export function test() { const f = C.getN; try { return C.getN.call({}); } catch (e) { return -1; } }`,
    irUnits: ["C_getN"],
    legacyValue: 5,
  },
  "a foreign receiver via Reflect.apply reads the one global (no brand check, as legacy)": {
    source: `
class C { static #n = 5; static getN() { return this.#n; } }
class D extends C {}
export function test() { const f = C.getN; try { return Reflect.apply(C.getN, {}, []); } catch (e) { return -1; } }`,
    irUnits: ["C_getN"],
    legacyValue: 5,
  },
  "a detached call reads the one global (no brand check, as legacy)": {
    source: `
class C { static #n = 5; static getN() { return this.#n; } }
class D extends C {}
export function test() { const f = C.getN; try { return f(); } catch (e) { return -1; } }`,
    irUnits: ["C_getN"],
    legacyValue: 5,
  },
  "an exception thrown after an IR static field read is caught by the caller": {
    source: `
class C { static #n = 5; static getN() { return this.#n; } }
function check(v) { if (v > 3) throw new RangeError("big"); return v; }
export function test() { try { return check(C.getN()); } catch (e) { return e instanceof RangeError ? -1 : -2; } }`,
    irUnits: ["C_getN"],
  },
  "a dynamic parameter written to an untyped static private field stays legacy": {
    source: `
class C {
  static #xVal;
  static #x(value) { this.#xVal = value; return this.#xVal; }
  static x() { return this.#x(42); }
}
export function test() { return C.x(); }`,
    irUnits: [],
    legacyUnits: ["C___priv_x", "C_x"],
  },
  "compound assignment and a this-reading initialiser stay legacy": {
    source: `
class C {
  static #n = 1;
  static #t = this.name.length;
  static inc() { this.#n += 1; return 2; }
  static t() { return this.#t; }
}
export function test() { return C.inc() * 10 + C.t(); }`,
    irUnits: [],
    legacyUnits: ["C_inc", "C_t"],
  },
  "JS class with async, generator and default-param methods projects its plain members": {
    source: `
class E {
  *g() { yield 1; }
  dd(x = 3) { return x; }
  async am() { return 1; }
  m() { return 9; }
}
export function test() { const e = new E(); return e.m() * 10 + e.dd() + [...e.g()].length * 100; }`,
    irUnits: ["E_m"],
    legacyUnits: ["E_dd", "E_am", "E_g"],
  },
  "skipped methods stay reachable through overrides, super and method-as-value": {
    source: `
class A {
  constructor() { this.k = 1; }
  d({ a }) { return a + this.k; }
  plain() { return 5; }
  callsD() { return this.d({ a: 2 }); }
}
class B extends A {
  d({ a }) { return a * 10; }
  plain() { return super.plain() + 1; }
  viaSuperD() { return super.d({ a: 4 }); }
}
export function test() {
  const a = new A();
  const b = new B();
  const f = a.d;
  return a.plain() + b.plain() * 10 + a.callsD() * 100 + b.callsD() * 1000 + b.viaSuperD() * 100000 + f.call(b, { a: 1 }) * 1000000 + (A.prototype.hasOwnProperty("d") ? 10000000 : 0);
}`,
    irUnits: [],
    legacyUnits: ["A_d", "B_d"],
  },
};

describe("#7233 static private fields and shape-less JS classes reach the IR", () => {
  for (const [label, { source, irUnits, legacyUnits = [], gcRawExports = [], legacyValue }] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${label} — ${lane.name}`, async () => {
        const reference = evaluateAsJs(source);
        const { result, exports } = await compileAndRun(source, lane.options);
        const value = exports.test!();
        expect(value).toBe(legacyValue ?? reference.test!());
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

// Review of #7059: a `string` static private field whose global can still be
// null when read (no initialiser, `!`, or read by an earlier static
// initialiser) must keep the legacy body: the IR's `string` is non-null and
// trapped on `+`, `===` and truthiness. Values are base's, on every lane.
const NULLABLE_STRING_FIELDS: Record<
  string,
  { readonly source: string; readonly unit: string; readonly value: number }
> = {
  "uninitialised, === undefined": {
    source: `class C { static #s: string; static g(): number { return this.#s === undefined ? 1 : 2; } }
export function test(): number { return C.g(); }`,
    unit: "C_g",
    value: 1,
  },
  "read by an earlier static initialiser": {
    source: `class C { static a: number = C.peek(); static #s: string = "x"; static peek(): number { return this.#s === undefined ? 1 : 2; } }
export function test(): number { return C.a * 10 + C.peek(); }`,
    unit: "C_peek",
    value: 12,
  },
  "uninitialised, concatenation": {
    source: `function h(s: string): number { let r = 0; for (let i = 0; i < s.length; i++) r = (r * 31 + s.charCodeAt(i)) | 0; return r; }
class C { static #s: string; static g(): string { return "a" + this.#s; } }
export function test(): number { return h(C.g()); }`,
    unit: "C_g",
    value: 1374895631,
  },
  "uninitialised, truthiness then write": {
    source: `class C { static #s: string; static g(): number { return this.#s ? 1 : 2; } static w(): number { this.#s = "k"; return this.#s ? 3 : 4; } }
export function test(): number { return C.g() * 10 + C.w(); }`,
    unit: "C_g",
    value: 23,
  },
  "definite-assignment `!`, === undefined": {
    source: `class C { static #s!: string; static g(): number { return this.#s === undefined ? 1 : 2; } }
export function test(): number { return C.g(); }`,
    unit: "C_g",
    value: 1,
  },
  'uninitialised, === ""': {
    source: `class C { static #s: string; static g(): number { return this.#s === "" ? 1 : 2; } }
export function test(): number { return C.g(); }`,
    unit: "C_g",
    value: 2,
  },
};

describe("#7233 a string static private field that can be read null stays legacy", () => {
  for (const [label, { source, unit, value }] of Object.entries(NULLABLE_STRING_FIELDS)) {
    for (const lane of LANES) {
      it(`${label} — ${lane.name}`, async () => {
        const { result, exports } = await compileAndRun(source, lane.options, "issue-7233.ts");
        expect(exports.test!()).toBe(value);
        expect(route(result, unit), `${unit} stays on the legacy body`).toBe("unsupported");
      }, 120_000);
    }
  }
});

// The best-effort projection is JS-only: a TS class with one unprojectable
// method keeps no shape at all, which keeps the typed corpus byte-identical.
describe("#7233 TS sources keep the all-or-nothing class projection", () => {
  it("a TS class with a default-param method keeps every member legacy", async () => {
    const source = `
class E { dd(x: number = 3): number { return x; } m(): number { return 9; } }
export function test(): number { const e = new E(); return e.m() * 10 + e.dd(); }`;
    const { result, exports } = await compileAndRun(source, { target: "standalone" }, "issue-7233.ts");
    expect(exports.test!()).toBe(93);
    expect(route(result, "E_m")).toBe("unsupported");
  }, 120_000);
});

// #4016: the constructor value shares a physical carrier with instances, but
// its live name/descriptor must remain separate from an instance field name.
it("constructor name and descriptor remain distinct from an instance name field — wasi", async () => {
  const source =
    'class C {name=7; static n(){return this.name.length;}} function inspect(ctor,instance){const d=Object.getOwnPropertyDescriptor(ctor,"name"); return ctor.name==="C" && d && d.value==="C" && d.writable===false && d.enumerable===false && d.configurable===true && instance.name===7 ? 1:0;} export function test(){return C.n()===1 ? inspect(C,new C()):0;}';
  const reference = evaluateAsJs(source);
  expect(reference.test!(), "genuine Node oracle").toBe(1);
  const { exports } = await compileAndRun(source, { target: "wasi" });
  expect(exports.test!()).toBe(reference.test!());
}, 120_000);
