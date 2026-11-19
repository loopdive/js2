// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice O, step O2 — an ordinary object is a kind of the Prepared dynamic value. A literal stored into a
// dynamic home (a script `var`) or thrown and caught is the object kind: `typeof` answers "object", strict equality
// is identity, ToBoolean is true and, while the program's objects are plain (`src/ir/source-plain-objects.ts`),
// OrdinaryToPrimitive answers "[object Object]" (ToNumber NaN). A program whose objects are not plain refuses that
// conversion by name. Every program runs twice: node's answer (returns) and a wrong one (throws).
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { programObjects } from "../src/ir/source-plain-objects.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

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

/** `check` is the program's test of `value`; node's answer passes it, `wrong` must not. */
const PROGRAMS: readonly {
  name: string;
  setup: string;
  check: (answer: string) => string;
  answers: [string, string];
}[] = [
  {
    name: "typeof of an object in a script var",
    setup: "var o = { a: 1 };",
    check: (answer) => `if (typeof o !== ${answer}) throw 1;`,
    answers: ['"object"', '"number"'],
  },
  {
    name: "strict equality is identity",
    setup: "var o = {}; var p = o; var q = {};",
    check: (answer) => `if ((o === p) !== ${answer.split(",")[0]} || (o === q) !== ${answer.split(",")[1]}) throw 1;`,
    answers: ["true,false", "true,true"],
  },
  {
    name: "ToBoolean of an object",
    setup: "var o = {};",
    check: (answer) => `if (!o !== ${answer}) throw 1;`,
    answers: ["false", "true"],
  },
  {
    name: "an object is not null",
    setup: "var o = {};",
    check: (answer) => `if ((o === null) !== ${answer}) throw 1;`,
    answers: ["false", "true"],
  },
  {
    name: "ToString of a plain object through `+`",
    setup: "var o = { a: 1 };",
    check: (answer) => `if ("" + o !== ${answer}) throw 1;`,
    answers: ['"[object Object]"', '"[object]"'],
  },
  {
    name: "an object on the left of `+` with a string",
    setup: "var o = {};",
    check: (answer) => `if (o + "!" !== ${answer}) throw 1;`,
    answers: ['"[object Object]!"', '"!"'],
  },
  {
    name: "ToNumber of a plain object is NaN",
    setup: "var o = {}; var n = +o;",
    check: (answer) => `if ((n === n) !== ${answer}) throw 1;`,
    answers: ["false", "true"],
  },
  {
    name: "an object thrown from a callee and caught",
    setup: 'function f() { throw { a: 1 }; } var t; try { f(); } catch (e) { t = typeof e + ("" + e); }',
    check: (answer) => `if (t !== ${answer}) throw 1;`,
    answers: ['"object[object Object]"', '"object"'],
  },
];

describe("#7354 O2 — an ordinary object is a kind of the dynamic value", () => {
  for (const { name, setup, check, answers } of PROGRAMS) {
    it(
      name,
      async () => {
        const [right, wrong] = answers;
        expect(() => new Function(`${setup} ${check(right)}`)()).not.toThrow();
        expect(() => new Function(`${setup} ${check(wrong)}`)()).toThrow();
        expect(await run(`${setup} ${check(right)}`)).toBe("returned");
        expect(await run(`${setup} ${check(wrong)}`)).toBe("threw");
      },
      180_000,
    );
  }

  // The reasons a program reaches today; the others stop earlier (methods and function values need slice Fa, member
  // writes O3) and are pinned on the predicate itself below.
  it.each([
    [
      "a literal `toString`",
      'var o = { toString: 1 }; if ("" + o !== "x") throw 1;',
      "an object literal defines 'toString'",
    ],
    ["a literal `valueOf`", "var o = { valueOf: 1 }; if (+o !== 1) throw 1;", "an object literal defines 'valueOf'"],
    [
      "a prototype global",
      'var o = {}; var s = typeof Object; if ("" + o !== s) throw 1;',
      "the program names 'Object'",
    ],
  ])("refuses ToPrimitive of an object with %s", async (_label, source, reason) => {
    expect(await refusal(source)).toContain(`ToPrimitive of an object (${reason})`);
  });
});

describe("#7354 O2 — whether a program's objects are plain", () => {
  const objects = (source: string) => {
    const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
    return programObjects(ast.checker, ast.sourceFiles);
  };

  it("answers no objects, and plain objects", () => {
    expect(objects("export const n = 1;")).toEqual({ present: false, unplain: undefined });
    expect(objects("export const o = { a: 1, b: 'x' }; export const v = o.a;")).toEqual({
      present: true,
      unplain: undefined,
    });
  });

  it.each([
    ["a method", "export const o = { f() { return 1; } };", "an object literal defines a method, accessor or spread"],
    [
      "an accessor",
      "export const o = { get f() { return 1; } };",
      "an object literal defines a method, accessor or spread",
    ],
    ["a spread", "const p = {}; export const o = { ...p };", "an object literal defines a method, accessor or spread"],
    ["a computed key", "const k = 'a'; export const o = { [k]: 1 };", "an object literal has a computed key"],
    ["a literal toString", "export const o = { toString: 1 };", "an object literal defines 'toString'"],
    ["a literal valueOf", "export const o = { valueOf: 1 };", "an object literal defines 'valueOf'"],
    ["a literal __proto__", "export const o = { __proto__: null };", "an object literal defines '__proto__'"],
    ["a function value", "export const o = { f: function () {} };", "an object property holds a function"],
    ["an arrow value", "export const o = { f: () => 1 };", "an object property holds a function"],
    ["a toString write", "export const o: any = {}; o.toString = 1;", "a member write defines 'toString'"],
    ["a valueOf element write", "export const o: any = {}; o['valueOf'] = 1;", "a member write defines 'valueOf'"],
    ["a computed write", "export const o: any = {}; const k = 'a'; o[k] = 1;", "a member write has a computed key"],
    ["a function write", "export const o: any = {}; o.f = function () {};", "a member write stores a function"],
    ["a prototype read", "function F() {} export const p = F.prototype;", "the program reads 'prototype'"],
    ["a __proto__ read", "export const o: any = {}; export const p = o.__proto__;", "the program reads '__proto__'"],
    ["the Object global", "export const t = typeof Object;", "the program names 'Object'"],
    ["the String global", "export const s = String(1);", "the program names 'String'"],
    ["globalThis", "export const g = globalThis;", "the program names 'globalThis'"],
    // (#7352 arrays) An array is the object kind; its ToPrimitive is `join`, not "[object Object]".
    ["an array literal", "export const a = [1];", "array ToPrimitive needs Array.prototype.join"],
  ])("is not plain with %s", (_label, source, reason) => {
    expect(objects(source).unplain).toBe(reason);
  });

  it("does not take a member or key name for a global", () => {
    expect(objects("export const o = { Object: 1, String: 2 }; export const v = o.Object;").unplain).toBeUndefined();
  });
});
