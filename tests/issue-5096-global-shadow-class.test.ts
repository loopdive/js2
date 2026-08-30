// #5096 — a user class whose NAME matches an ambient global must be the thing
// `new X()` constructs.
//
// Three independent claim points all matched the SPELLING and never asked which
// binding the name resolves to (§9.1: any lexical/var binding in scope shadows
// the global):
//
//   1. `TsCheckerOracle.factOfType` classified any type whose symbol is named
//      `Map`/`Date`/… as `{kind:"builtin"}` BEFORE testing for construct
//      signatures. `isFreshlyConstructedNonCallable` reads a `builtin` fact as
//      "no [[Construct]]", so `new Map()` compiled to a hard
//      `TypeError: Map is not a constructor` — the filed symptom.
//   2. `tryCompileBuiltinGlobalNew`'s arms (`Number`/`String`/`Boolean`,
//      `Object`, `Proxy`, `Function`, `Date`, `AggregateError`,
//      `SuppressedError`, the TypedArrays) claimed by `expr.expression.text`.
//   3. `resolveWasmType` mapped a type by its symbol name to the builtin Wasm
//      REPRESENTATION, so a user `class Date` instance got `ref $__Date` (one
//      i64) and the ctor's real struct nulled on the way in.
//
// The regression direction matters as much as the fix: with no shadow in scope
// every builtin lowering must be untouched, so each case here has an
// unshadowed twin.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string, opts: Record<string, unknown> = {}): Promise<any> {
  const result: any = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, ...opts } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

/** A shadowing class whose constructor marks the instance with `arg + 1000`. */
function shadowModule(name: string): string {
  return `class ${name} { v: number; constructor(a: number) { this.v = a + 1000; } m(): number { return this.v + 1; } }
export function test(): number { const o = new ${name}(5); return o.v; }`;
}

// Every ambient-global spelling any of the three claim points recognised.
const SHADOWED_NAMES = [
  // the four the issue proved
  "ArrayBuffer",
  "DataView",
  "Map",
  "SharedArrayBuffer",
  // the rest of the same cohort, found while sizing the claim points
  "Array",
  "AggregateError",
  "Boolean",
  "Date",
  "Error",
  "Float64Array",
  "Function",
  "Int8Array",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "RegExp",
  "Set",
  "String",
  "SuppressedError",
  "Symbol",
  "Uint8Array",
  "WeakMap",
  "WeakSet",
];

describe("#5096 — a user class shadowing an ambient global is constructable", () => {
  for (const name of SHADOWED_NAMES) {
    it(`class ${name} { … } — new ${name}(5) builds the USER instance`, async () => {
      const exports = await run(shadowModule(name));
      expect(exports.test()).toBe(1005);
    });
  }

  it("a name that shadows nothing is unaffected (control)", async () => {
    const exports = await run(shadowModule("NotAGlobalAtAll"));
    expect(exports.test()).toBe(1005);
  });

  it("the shadow works inside a FUNCTION BODY, not just at module scope", async () => {
    const exports = await run(`export function test(): number {
      class ArrayBuffer { v: number; constructor(a: number) { this.v = a + 1000; } }
      return new ArrayBuffer(5).v;
    }`);
    expect(exports.test()).toBe(1005);
  });

  it("instanceof against the shadowing class is the USER class", async () => {
    const exports = await run(`class Map { v: number; constructor() { this.v = 7; } }
export function test(): number { const m = new Map(); return (m instanceof Map) ? 1 : 0; }`);
    expect(exports.test()).toBe(1);
  });

  it("methods on the shadowing class are callable", async () => {
    const exports = await run(shadowModule("DataView").replace("return o.v;", "return o.m();"));
    expect(exports.test()).toBe(1006);
  });

  it("a shadow declared AFTER the use site still binds the USER class", async () => {
    // §14.7 makes a `class` binding lexical, so V8 answers this exact program
    // with `ReferenceError: Cannot access 'Map' before initialization`
    // (measured on node 22, `.tmp/tdz-node.mjs`) — emphatically NOT the
    // intrinsic. js2wasm does not model class TDZ (a separate, general gap:
    // it hoists the binding as initialised), so it constructs the user class.
    // Asserted here because the half that this issue owns — "the intrinsic
    // must not win the name" — is what the value proves.
    const exports = await run(`export function test(): number { const o = new Map(5); return o.v; }
class Map { v: number; constructor(a: number) { this.v = a + 1000; } }`);
    expect(exports.test()).toBe(1005);
  });

  it("the AMBIENT global is untouched when nothing shadows it", async () => {
    const exports = await run(`export function test(): number {
      const m = new Map();
      m.set(1, 2);
      const b = new ArrayBuffer(8);
      const d = new DataView(b);
      const ta = new Uint8Array(4);
      const n: any = new Number(3);
      return (m.get(1) as number) + b.byteLength + d.byteLength + ta.length + (n.valueOf() as number);
    }`);
    // 2 + 8 + 8 + 4 + 3
    expect(exports.test()).toBe(25);
  });

  it("Test262Error keeps its dedicated lowering despite being user-declared", async () => {
    // The harness DECLARES Test262Error in the module under compilation, so the
    // shadow guard must exempt it or the #2902 host-free interception (~2,779
    // wrapped tests) would decline. Both spellings must still construct and
    // carry `.message`.
    const exports = await run(`class Test262Error extends Error { constructor(m: string) { super(m); } }
export function test(): string { return new Test262Error("boom").message; }`);
    expect(exports.test()).toBe("boom");
  });
});
