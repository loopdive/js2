// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7352 arrays (lane S13) — arrays on the Prepared whole-program path. An array literal is an Array exotic object
// of the realm (`js.object.create-array`, then `js.object.set-index` per element); a typed element read is
// `js.object.get-index` and `.length` is the kernel's own-property arm under `js.object.get`
// (`src/runtime/wasmgc/values/array-exotic-bodies.ts`). Every program runs twice: as written (node's answer,
// returns) and with a wrong answer (throws).
//
// The A2 runtime (sparse and huge indices, a miss's prototype walk, a non-array receiver, `length` writes) is not
// reachable from source until the dynamic member chain plans it, so it is checked on the realm's own bodies,
// exported from a realm built for a constructed program (`tests/helpers/native-array-realm.ts`).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import { irIntrinsicFuncRef, irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import { irRuntimeCallableDeclaration } from "../src/ir/runtime/callable-declarations.js";
import * as linear from "../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";
import { arrayRealmModule, instantiateArrayRealm, type ArrayRealm } from "./helpers/native-array-realm.js";

const options = (): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName: "test.js",
    allowJs: true,
  }) as Test262CompileOptions;

afterEach(() => vi.restoreAllMocks());

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

/** Compile through the strict Prepared entry, run the top-level code and report whether it threw. */
async function run(source: string): Promise<"returned" | "threw"> {
  for (const spy of [
    vi.spyOn(gc, "generateModule"),
    vi.spyOn(gc, "generateMultiModule"),
    vi.spyOn(linear, "generateLinearModule"),
    vi.spyOn(linear, "generateLinearMultiModule"),
  ])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
  const result = await compile(source, options());
  expect(messages(result)).toEqual([]);
  expect(requiredPreparedEmission(result)).toBeDefined();
  try {
    const exports = instantiatePreparedArtifact(result).instance.exports;
    (exports.__module_init as (() => void) | undefined)?.();
    return "returned";
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return "threw";
  }
}

async function refusal(source: string): Promise<string> {
  const result = await compile(source, options());
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

/** `check(answer)` is the program's own test of its result; node's answer is the first of `answers`. */
const PROGRAMS: readonly { name: string; body: string; answers: readonly [string, string] }[] = [
  {
    name: "the A1 proving program: a function-local literal, an index read and .length",
    body: "function f(){ var a = [1, 2, 3]; return a[1] + a.length; }",
    answers: ["5", "6"],
  },
  {
    name: "every index of the literal reads its own element",
    body: "function f(){ var a = [1, 2, 3]; return a[0] * 100 + a[2] * 10 + a[1]; }",
    answers: ["132", "123"],
  },
  {
    name: "an empty literal has length 0 (no vec element type to infer)",
    body: "function f(){ var a = []; return a.length; }",
    answers: ["0", "1"],
  },
  {
    name: "string and nested-array elements are stored, and the length counts them",
    body: 'function f(){ var a = ["x", [1, 2], "y"]; return a.length; }',
    answers: ["3", "2"],
  },
];

const REF = { kind: "val", val: { kind: "externref" } };
const INDEX = { kind: "val", val: { kind: "f64" } };
const CONTRACTS = [
  ["js.object.create-array", [INDEX], [REF]],
  ["js.object.get-index", [REF, INDEX, REF], [REF]],
  ["js.object.set-index", [REF, INDEX, REF], []],
  ["js.object.set-length", [REF, INDEX], []],
] as const;

describe("#7352 arrays — the index contracts of the ordinary-object family", () => {
  it.each(CONTRACTS)("%s has its declared shape and only its exact intrinsic binding", (name, params, results) => {
    const declared = irRuntimeCallableDeclaration(irIntrinsicFuncRef(name));
    expect(declared).toMatchObject({ feature: name, params, results });
    expect(Object.isFrozen(declared)).toBe(true);
    expect(irRuntimeCallableDeclaration(irRuntimeFuncRef(name))).toBeUndefined();
    expect(irRuntimeCallableDeclaration(irIntrinsicFuncRef(name + ".foreign", name))).toBeUndefined();
  });
});

describe("#7352 arrays — array literals are Array exotic objects of the realm", () => {
  for (const { name, body, answers } of PROGRAMS) {
    it(
      name,
      async () => {
        const [right, wrong] = answers;
        expect(new Function(`${body} return f();`)()).toBe(Number(right));
        expect(await run(`${body} if (f() !== ${right}) throw 1;`)).toBe("returned");
        expect(await run(`${body} if (f() !== ${wrong}) throw 1;`)).toBe("threw");
      },
      120_000,
    );
  }

  // Each refusal names the slice that removes it (the plan in the #7352 issue file).
  it("refuses what the later slices build, by name", async () => {
    // A2: a script var's literal into the dynamic home.
    expect(await refusal("var a = [1, 2]; if (a[0] !== 1) throw 1;")).toContain(
      "proven dynamic binding 'a' initializer has no supported carrier",
    );
    // A2: an array reaching a dynamic slot (here P's unannotated result).
    expect(await refusal("function f(){ var a = [1, 2]; return a; } f();")).toContain(
      "concrete return needs a dynamic box in f",
    );
    // A2: an element write.
    expect(await refusal("function f(){ var a = [1, 2]; a[0] = 3; return a[0]; } f();")).toContain(
      "element store on externref not in IR scope",
    );
    // A2: a read outside the literal (the prototype walk of a miss).
    expect(await refusal("function f(){ var a = [1, 2]; return a[5]; } f();")).toContain(
      "element access on externref with index",
    );
    // A2: a hole makes the binding's reads unplanned, so `.length` meets the untyped member read.
    expect(await refusal("function f(){ var a = [1, , 3]; return a.length; } f();")).toContain(
      "box of a non-primitive value has no Prepared intrinsic",
    );
    // Spread needs the iteration protocol.
    expect(await refusal("function f(b){ var a = [1, ...b]; return 0; } f([]);")).toContain(
      "array literal spread needs the iteration protocol",
    );
  }, 120_000);
});

/** A complete data descriptor word: value, writable, enumerable and configurable, all present and true. */
const DATA = 191;
const TRAP = WebAssembly.RuntimeError;

describe("#7352 arrays — the Array exotic object's runtime (the realm's bodies, exported)", () => {
  let module: WebAssembly.Module;
  let r: ArrayRealm;
  beforeAll(() => {
    module = arrayRealmModule();
  }, 120_000);
  const fresh = () => (r = instantiateArrayRealm(module));
  const read = (array: unknown, index: number) => r.getIndex(array, index, array);
  const write = (array: unknown, index: number, value: number) => r.setIndex(array, index, r.boxNumber(value));
  const number = (array: unknown, index: number) => r.unboxNumber(read(array, index));

  it("a dense write grows the vector, fills a gap with holes, and length follows", () => {
    fresh();
    const a = r.create(2);
    expect([r.length(a), r.denseLength(a)]).toEqual([2, 0]);
    write(a, 0, 10);
    write(a, 1, 11);
    write(a, 5, 15);
    expect([r.length(a), r.denseLength(a)]).toEqual([6, 6]);
    expect([number(a, 0), number(a, 1), number(a, 5)]).toEqual([10, 11, 15]);
    expect(read(a, 3)).toBe(r.undefinedValue());
  });

  it("an index past the density bound, or past 2^31 - 2, is a keyed property and never allocates", () => {
    fresh();
    const dense = r.create(0);
    write(dense, 1023, 1);
    expect([r.length(dense), r.denseLength(dense)]).toEqual([1024, 1024]);
    const sparse = r.create(0);
    write(sparse, 1024, 2);
    write(sparse, 2 ** 32 - 2, 3);
    write(sparse, 0, 4);
    expect([r.length(sparse), r.denseLength(sparse)]).toEqual([2 ** 32 - 1, 1]);
    expect([number(sparse, 1024), number(sparse, 2 ** 32 - 2), number(sparse, 0)]).toEqual([2, 3, 4]);
    expect(read(sparse, 1025)).toBe(r.undefinedValue());
  });

  it("a number key is classified by arrayIndexOf alone: 1.0 and -0 are indices, others trap by name", () => {
    fresh();
    const a = r.create(0);
    write(a, 0, 7);
    write(a, 1, 8);
    expect([number(a, -0), number(a, 1.0)]).toEqual([7, 8]);
    // A non-index number key needs ToString(number), which the realm cannot reach yet (array-index-bodies.ts).
    for (const key of [1.5, -1, 2 ** 32 - 1, NaN]) {
      expect(() => read(a, key)).toThrow(TRAP);
      expect(() => write(a, key, 0)).toThrow(TRAP);
    }
  });

  it("a miss walks %Array.prototype% then Object.prototype, and an own element shadows both", () => {
    fresh();
    const a = r.create(0);
    r.defineData(r.arrayPrototype(), r.indexKey(7), r.boxNumber(70), DATA);
    r.defineData(r.objectPrototype(), r.indexKey(8), r.boxNumber(80), DATA);
    expect([number(a, 7), number(a, 8)]).toEqual([70, 80]);
    write(a, 7, 1);
    write(a, 5000, 2);
    r.defineData(r.arrayPrototype(), r.indexKey(5000), r.boxNumber(3), DATA);
    expect([number(a, 7), number(a, 5000)]).toEqual([1, 2]);
    expect(read(a, 9)).toBe(r.undefinedValue());
  });

  it("an ordinary receiver: get-index is the string-keyed [[Get]], set-index traps by name", () => {
    fresh();
    const o = r.objectPrototype();
    r.defineData(o, r.indexKey(3), r.boxNumber(30), DATA);
    expect(r.unboxNumber(r.getIndex(o, 3, o))).toBe(30);
    expect(r.getIndex(o, 4, o)).toBe(r.undefinedValue());
    // [[Set]] on an ordinary object is `js.object.set`, which does not exist yet (array-index-bodies.ts).
    expect(() => r.setIndex(o, 3, r.boxNumber(0))).toThrow(TRAP);
  });

  it("ArraySetLength: growing sets length, shrinking cuts the vector", () => {
    fresh();
    const a = r.create(0);
    for (const index of [0, 1, 2, 3]) write(a, index, index + 10);
    r.setLength(a, 10);
    expect([r.length(a), r.denseLength(a)]).toEqual([10, 4]);
    r.setLength(a, 2);
    expect([r.length(a), r.denseLength(a)]).toEqual([2, 2]);
    expect([number(a, 1), read(a, 2)]).toEqual([11, r.undefinedValue()]);
    write(a, 3, 5);
    expect([r.length(a), number(a, 3), read(a, 2)]).toEqual([4, 5, r.undefinedValue()]);
    r.setLength(a, 2 ** 32 - 1);
    expect(r.length(a)).toBe(2 ** 32 - 1);
  });

  it("ArraySetLength: a length that is no u32 throws a catchable RangeError and changes nothing", () => {
    fresh();
    const a = r.create(3);
    for (const length of [1.5, -1, 2 ** 32, NaN, Infinity]) {
      let thrown: unknown;
      try {
        r.setLength(a, length);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WebAssembly.Exception);
      const exception = thrown as WebAssembly.Exception;
      expect(exception.is(r.exception)).toBe(true);
      expect(r.errorTag(exception.getArg(r.exception, 0))).toBe(-12);
      expect(r.length(a)).toBe(3);
    }
    r.setLength(a, -0);
    expect(r.length(a)).toBe(0);
  });

  it("ArraySetLength: shrinking past an index the map holds aborts by name, never leaving a wrong length", () => {
    fresh();
    const a = r.create(0);
    write(a, 5000, 1);
    r.setLength(a, 5001);
    expect(r.length(a)).toBe(5001);
    // Deleting map-held indices is a later slice (array-length-bodies.ts).
    expect(() => r.setLength(a, 5000)).toThrow(TRAP);
    expect(number(a, 5000)).toBe(1);
  });
});
