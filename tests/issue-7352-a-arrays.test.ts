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
//
// A2's dynamic value: an array is the carrier's object kind; a number key reads and writes it through the index
// contracts and `length` writes through `js.object.set-length` (`src/ir/program/dynamic-member-*.ts`).
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
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { forEachInstrDeep, type IrFunction, type IrInstr } from "../src/ir/core/nodes.js";
import {
  DynamicValueGap,
  legalizeDynamicValues,
  type LegalizationProgram,
} from "../src/ir/program/dynamic-value-legalization.js";
import { JS_TAG_IDS } from "../src/ir/runtime/js-tag-domain.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { irModuleGlobalBindingId, irSourceGlobalRef } from "../src/ir/abi-bindings.js";
import { scriptVarGlobalKinds } from "../src/ir/script-var-kinds.js";
import type { IrSourceId } from "../src/shared/contracts/ir-identity.js";
import { ts } from "../src/ts-api.js";

const GLOBAL = irModuleGlobalBindingId("source:test" as IrSourceId, 0);

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
    // A2: an Array through P's dynamic parameter, which may hold a string, whose index needs its wrapper (slice B).
    expect(await refusal("function f(x) { return x[1] + x.length; } if (f([1, 2, 3]) !== 5) throw 1;")).toContain(
      "member read '1' of a string needs its wrapper prototype",
    );
    // A constant number key that is no array index needs ToString of a number, which the realm cannot reach.
    expect(await refusal("var a = [1, 2]; var x = a[1.5];")).toContain(
      "dyn.member_get with the number key 1.5 (it needs ToString of a number)",
    );
    expect(await refusal("var a = [1, 2]; a[-1] = 0;")).toContain(
      "dyn.member_set with the number key -1 (it needs ToString of a number)",
    );
    // An Array's ToPrimitive is `join` (Array.prototype methods, A3).
    expect(await refusal('var o = {}; var a = [1]; if ("" + o !== "x") throw 1;')).toContain(
      "ToPrimitive of an object (array ToPrimitive needs Array.prototype.join)",
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

// A2: a member write of the dynamic value (`MEMBER_WRITE_ARM`), through P's dynamic parameter, which may hold any kind.
// A2: a script var whose every write is a literal holds `undefined` or an object (`src/ir/script-var-kinds.ts`), so
// its member chain has no primitive arm. Each program runs as written (node's answer) and with a wrong answer.
describe("#7352 A2 — a script var holding an Array", () => {
  it.each([
    ["an index read", "var a = [1, 2]; if (a[0] !== 1) throw 1;", "a[0] !== 2"],
    [
      "an element write with growth and a hole",
      "var a = [1, 2]; a[5] = 1; if (a.length !== 6 || a[3] !== undefined || a[5] !== 1) throw 1;",
      "a.length !== 7",
    ],
    [
      "a length write that shrinks",
      "var a = [1, 2, 3]; a.length = 1; if (a.length !== 1 || a[1] !== undefined) throw 1;",
      "a.length !== 3",
    ],
  ])(
    "%s",
    async (_label, source, wrongCheck) => {
      const wrong = source.replace(/if \(.*\) throw 1;$/, `if (${wrongCheck}) throw 1;`);
      expect(() => new Function(source)()).not.toThrow();
      expect(() => new Function(wrong)()).toThrow();
      expect(await run(source)).toBe("returned");
      expect(await run(wrong)).toBe("threw");
    },
    180_000,
  );

  it("throws ArraySetLength's RangeError for a length that is no u32, as node does", async () => {
    const source = "var a = [1, 2, 3]; a.length = -1;";
    expect(() => new Function(source)()).toThrow(RangeError);
    expect(await run(source)).toBe("threw");
  }, 120_000);

  it("refuses by name what it cannot answer", async () => {
    // The realm throws the RangeError under its own exception tag, which a source catch does not handle yet.
    expect(await refusal("var a = [1, 2, 3]; try { a.length = -1; } catch {}")).toContain(
      "member write 'length' (ArraySetLength's RangeError) in a program that catches",
    );
    // A write of another kind (here a closure's) keeps every kind, and the string arm refuses.
    expect(await refusal("var a = [1, 2]; function f(v) { a = v; } f(1); var x = a[0];")).toContain(
      "member read '0' of a string needs its wrapper prototype",
    );
    // A write through the global object takes the binding's home away before any kind is asked.
    expect(await refusal("var a = [1, 2]; function id(x) { return x; } this.a = id(1); var x = a[0];")).toContain(
      "module binding a has no exact typed storage: not-direct",
    );
  }, 120_000);

  // Escapes the frontend refuses or the Prepared path cannot compile yet (`eval` throws an invariant on the base):
  // the screen itself drops the fact.
  const kinds = (source: string) => {
    const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
    const [statement] = ast.sourceFiles.flatMap((file) => file.statements).filter(ts.isVariableStatement);
    const declaration = statement!.declarationList.declarations[0]!;
    const binding = { type: { kind: "dynamic" }, globalRef: irSourceGlobalRef(GLOBAL, "a") } as const;
    return scriptVarGlobalKinds(ast.checker, new Map([[declaration, { binding }]])).get(GLOBAL);
  };
  it.each([
    ["a direct eval", 'var a = [1]; eval("a = 1");'],
    ["an indirect eval", 'var a = [1]; (0, eval)("a = 1");'],
    ["Function", 'var a = [1]; Function("a = 1")();'],
    ["with", "var a = [1]; with ({}) {}"],
    ["delete", "var a = [1]; delete a;"],
    ["the global object escaping through this", "var a = [1]; var g = this;"],
    ["the global object escaping through globalThis", "var a = [1]; var g = globalThis;"],
    ["a closure's write", "var a = [1]; function f(v) { a = v; }"],
    ["a member write by the binding's name", "var a = [1]; var o = {}; o.a = 1;"],
    ["a non-literal initializer", "function g() { return [1]; } var a = g();"],
  ])("keeps every kind with %s", (_label, source) => {
    expect(kinds(source)).toBeUndefined();
  });
  it("holds undefined and objects when every write is an object or array literal", () => {
    expect(kinds("var a = [1]; a[0] = 2;")).toEqual(["undefined", "object"]);
    expect(kinds("var a = { p: 1 };")).toEqual(["undefined", "object"]);
  });
});

describe("#7352 A2 — a member write of the dynamic value", () => {
  it("a primitive's [[Set]] fails: nothing in sloppy code", async () => {
    const source = "function w(o) { o.q = 2; return o; } if (w(1) !== 1) throw 1;";
    expect(() => new Function(source)()).not.toThrow();
    expect(await run(source)).toBe("returned");
    expect(await run(source.replace("!==", "==="))).toBe("threw");
  }, 120_000);

  it.each([
    ["a primitive's failed [[Set]] in strict code", '"use strict"; function w(o) { o.q = 2; } w(1);'],
    ["a write to undefined", "function w(o) { o[0] = 2; } w(undefined);"],
  ])(
    "throws a TypeError for %s, as node does",
    async (_label, source) => {
      expect(() => new Function(source)()).toThrow(TypeError);
      expect(await run(source)).toBe("threw");
    },
    120_000,
  );
});

// A2: the number-key and `length` arms of the dynamic value's member chain, on a receiver whose kind its box proves
// (an Array from `js.object.create-array`).
describe("#7352 A2 — the dynamic member chain's Array arms (legalization)", () => {
  const F64 = { kind: "val", val: { kind: "f64" } } as const;
  const DYN = { kind: "dynamic" } as const;
  const ARRAYS: LegalizationProgram = {
    objects: { present: true, arrays: true, unplain: undefined },
    catches: false,
    handlesExceptions: false,
    globalKinds: new Map(),
  };
  const box = (result: number, value: number, tag: number): IrInstr =>
    ({ kind: "box", value, toType: { ...DYN, tag }, result, resultType: { ...DYN, tag } }) as unknown as IrInstr;
  /** The boxed number `value` into `result + 1`. */
  const number = (result: number, value: number): IrInstr[] => [
    { kind: "const", value: { kind: "f64", value }, result, resultType: F64 } as unknown as IrInstr,
    box(result + 1, result, JS_TAG_IDS.NumberF64),
  ];
  /** The boxed string `text` into v4. */
  const named = (text: string): IrInstr[] => [
    { kind: "string.const", value: text, result: 3, resultType: { kind: "string" } } as unknown as IrInstr,
    box(4, 3, JS_TAG_IDS.String),
  ];
  /** v2 is a boxed Array, `operands` write the key (v4) and value (v6), then `op`: the legalized contract calls. */
  const calls = (operands: IrInstr[], op: IrInstr, program = ARRAYS): string[] => {
    const instrs: IrInstr[] = [
      { kind: "const", value: { kind: "f64", value: 2 }, result: 0, resultType: F64 },
      { kind: "call", target: irIntrinsicFuncRef("js.object.create-array"), args: [0], result: 1, resultType: REF },
      box(2, 1, JS_TAG_IDS.Object),
      ...operands,
      op,
    ] as IrInstr[];
    const fn = {
      unitId: "ir-unit:test",
      name: "f",
      params: [],
      resultTypes: [],
      blocks: [{ id: 0, blockArgs: [], blockArgTypes: [], instrs, terminator: { kind: "return", values: [] } }],
      exported: false,
      valueCount: 8,
    } as unknown as IrFunction;
    const found: string[] = [];
    for (const root of legalizeDynamicValues(fn, new AllocSiteRegistry(), program).blocks[0]!.instrs)
      forEachInstrDeep(root, (instr) => {
        if (instr.kind === "call" && instr.target.binding.kind === "intrinsic")
          found.push(`${instr.target.binding.symbol}(${instr.args.join(",")})`);
      });
    return found;
  };
  const read = { kind: "dyn.member_get", recv: 2, key: 4, result: 7, resultType: DYN } as unknown as IrInstr;
  const write = { kind: "dyn.member_set", recv: 2, key: 4, value: 6, result: null, resultType: null } as IrInstr;
  const refusalOf = (legalize: () => unknown): string => {
    try {
      legalize();
    } catch (error) {
      expect(error).toBeInstanceOf(DynamicValueGap);
      return (error as Error).message;
    }
    throw new Error("legalization accepted the program");
  };

  it("reads a number key through the index-keyed [[Get]]", () => {
    expect(calls(number(3, 1), read)).toEqual(["js.object.create-array(0)", "js.object.get-index(2,3,2)"]);
  });

  it("writes a number key through the index-keyed [[Set]], and `length` through ArraySetLength", () => {
    expect(calls([...number(3, 5), ...number(5, 9)], write)).toEqual([
      "js.object.create-array(0)",
      "js.object.set-index(2,3,6)",
    ]);
    expect(calls([...named("length"), ...number(5, 1)], write)[1]).toMatch(/^js\.object\.set-length\(2,\d+\)$/);
  });

  it.each([1.5, -1, 2 ** 32 - 1, NaN])("refuses the constant non-index number key %s by name", (key) => {
    expect(refusalOf(() => calls(number(3, key), read))).toContain(
      `dyn.member_get with the number key ${key} (it needs ToString of a number)`,
    );
    expect(refusalOf(() => calls([...number(3, key), ...number(5, 0)], write))).toContain(
      `dyn.member_set with the number key ${key} (it needs ToString of a number)`,
    );
  });

  it("refuses OrdinarySet, and a `length` write in a program that catches, by name", () => {
    expect(refusalOf(() => calls([...named("p"), ...number(5, 1)], write))).toContain(
      "member write 'p' needs OrdinarySet",
    );
    // Without Arrays every object is ordinary: an index write is OrdinarySet too.
    const plain = { ...ARRAYS, objects: { ...ARRAYS.objects, arrays: false } };
    expect(refusalOf(() => calls([...number(3, 0), ...number(5, 1)], write, plain))).toContain(
      "member write '0' needs OrdinarySet",
    );
    expect(
      refusalOf(() => calls([...named("length"), ...number(5, 1)], write, { ...ARRAYS, handlesExceptions: true })),
    ).toContain("member write 'length' (ArraySetLength's RangeError) in a program that catches");
  });
});
