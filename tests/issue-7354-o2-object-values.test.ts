// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice O, step O2 — an ordinary object is a kind of the Prepared dynamic value. A literal stored into a
// dynamic home (a script `var`) or thrown and caught is the object kind: `typeof` answers "object", strict equality
// is identity, ToBoolean is true and OrdinaryToPrimitive of an object without its own `toString` answers
// "[object Object]" (ToNumber NaN). (#7354 O2b) That conversion is decided at run time now, not by the static
// plainness rule: tests/issue-7354-o2b-to-primitive.test.ts pins it. Every program runs twice: node's answer
// (returns) and a wrong one (throws).
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { programObjects } from "../src/ir/source-plain-objects.js";
import { pristineBuiltinGlobal } from "../src/ir/builtin-global-binding.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";
import { yieldToRpc } from "./helpers/prepared-node-agreement.js";

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
  await yieldToRpc();
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
    setup: "function f() { throw { a: 1 }; } var t; try { f(); } catch (e) { t = typeof e; }",
    check: (answer) => `if (t !== ${answer}) throw 1;`,
    answers: ['"object"', '"number"'],
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

  // (#7354 M2) ToString of a caught object in a program that reads a caught value: its OrdinaryToPrimitive may raise
  // a TypeError, which is a value now (the error kind); here the object has no `toString`, so node's answer.
  it("converts a caught object to a string in a program that reads a caught value", async () => {
    const source =
      'function f() { throw { a: 1 }; } var t; try { f(); } catch (e) { t = "" + e; } if (t !== @A) throw 1;';
    expect(await run(source.replace("@A", '"[object Object]"'))).toBe("returned");
    expect(await run(source.replace("@A", '"object"'))).toBe("threw");
  }, 180_000);

  // (#7354 O2b) The table "refuses ToPrimitive of an object with …" is gone: a literal `toString` or `valueOf` and a
  // prototype global no longer refuse. OrdinaryToPrimitive reads the object at run time, so the static plainness
  // rule has nothing left to decide for it (tests/issue-7354-o2b-to-primitive.test.ts pins each of those programs).
});

describe("#7354 O2 — what a program's source allows its objects", () => {
  const objects = (source: string) => {
    const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
    return programObjects(ast.sourceFiles, false, pristineBuiltinGlobal(ast.checker, ast.sourceFiles));
  };

  it("answers no objects, and objects", () => {
    expect(objects("export const n = 1;")).toEqual({
      present: false,
      functions: false,
      namesSymbol: false,
      realmFamilies: new Set(),
    });
    expect(objects("export const o = { a: 1, toString: 1 }; export const v = o.a;")).toEqual({
      present: true,
      functions: false,
      namesSymbol: false,
      realmFamilies: new Set(),
    });
  });

  // (#7354 G1) An Error constructor makes objects; naming one (not as a member) admits the object kind. (#7350 B3a) The
  // answer is the set of realm constructor families the program names.
  it("answers whether the program names an Error constructor", () => {
    const families = (source: string) => [...objects(source).realmFamilies];
    expect(objects("export const e = new TypeError('m');")).toMatchObject({ present: true });
    expect(families("export const e = new TypeError('m');")).toEqual(["error"]);
    expect(families("export const o = { TypeError: 1 }; export const v = o.TypeError;")).toEqual([]);
    // A binding or a label spelled like one is not the global.
    expect(families("function f(RangeError: unknown) { return RangeError; } export const v = f(1);")).toEqual([]);
    expect(families("TypeError: for (;;) { break TypeError; }")).toEqual([]);
    // (#7350 B3a) A wrapper constructor is a function value and makes no object; a constant folded off it is no read.
    expect(objects("export const s = String;")).toMatchObject({ present: false });
    expect(families("export const s = String;")).toEqual(["wrapper"]);
    expect(families("export const n = Number.MAX_VALUE;")).toEqual([]);
  });

  // (#7354 F1) A function expression is the one producer of a function value the source shows here.
  it("answers whether the program creates function values", () => {
    expect(objects("export const f = function () {};").functions).toBe(true);
    expect(objects("export function f() {} export const v = f();").functions).toBe(false);
  });

  // (#7354 M1, C1) The program-wide plainness answer (`unplain`) is gone: no Prepared program can obtain a built-in
  // prototype as a value (tests/issue-7354-m-prototype-premise.test.ts).
  it("answers whether the program names Symbol, the way to @@toPrimitive", () => {
    expect(objects("export const s = typeof Symbol;").namesSymbol).toBe(true);
    expect(objects("export const o = { Symbol: 1 }; export const v = o.Symbol;").namesSymbol).toBe(false);
  });
});
