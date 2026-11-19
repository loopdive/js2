// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice O, step O2b — OrdinaryToPrimitive of an ordinary object, decided at run time
// (src/ir/program/ordinary-to-primitive.ts). No admitted kind is callable, so the answer for every hint is
// "[object Object]" when the object has no `toString` up to the realm's Object.prototype, and a TypeError when it
// holds one. ToNumber of that string is NaN, and `+` concatenates it. A program that names `Symbol` refuses by name.
// The synthesized TypeError aborts uncatchably in a program that catches. Every answer program runs twice: node's
// answer (returns) and a wrong one (throws).
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
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

/** How the strict Prepared program ends: it returns, throws a Wasm exception, or traps. */
async function run(source: string): Promise<"returned" | "threw" | "trapped"> {
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
    if (error instanceof WebAssembly.RuntimeError) return "trapped";
    expect((error as object).constructor.name).toBe("Exception");
    return "threw";
  }
}

/** `@A` is node's answer in the right program and the other one in the wrong program. */
const PROGRAMS: readonly { name: string; source: string; answers: [string, string] }[] = [
  {
    // `typeof Object` made this program unplain under the old static rule, so it refused.
    name: "ToString, `+` and ToNumber of a plain object in a program that names 'Object'",
    source:
      "function f(a) { return 1 / a; } var o = { a: 1 }; var t = typeof Object;" +
      " if ('' + o !== @A) throw 1; if (o + '!' !== @A + '!') throw 2; if ((+o === +o) !== false) throw 3;" +
      " if ((f(o) === f(o)) !== false) throw 4;",
    answers: ["'[object Object]'", "'[object]'"],
  },
  {
    // assert.js: `message += ' '` on a parameter whose admitted kinds include the object kind.
    name: "`+=` on a string-valued dynamic value in a program that builds objects",
    source:
      "function f(message) { if (message === undefined) { message = ''; } else { message += ' '; } return message; }" +
      " var o = { a: 1 }; if (f('x') !== @A) throw 1;",
    answers: ["'x '", "'x'"],
  },
  {
    // A `valueOf` that is not callable is skipped; the realm Object.prototype's `toString` answers.
    name: "a non-callable own `valueOf`",
    source: "var o = { valueOf: 1 }; if ('' + o !== @A) throw 1;",
    answers: ["'[object Object]'", "'1'"],
  },
];

describe("#7354 O2b — OrdinaryToPrimitive of an ordinary object", () => {
  for (const { name, source, answers } of PROGRAMS) {
    it(
      name,
      async () => {
        const [right, wrong] = answers.map((answer) => source.replaceAll("@A", answer));
        expect(() => new Function(right!)()).not.toThrow();
        expect(() => new Function(wrong!)()).toThrow();
        expect(await run(right!)).toBe("returned");
        expect(await run(wrong!)).toBe("threw");
      },
      180_000,
    );
  }

  // An own `toString` that is not callable is skipped, the realm Object.prototype's `valueOf` answers the object
  // itself, and no method is left: node throws a TypeError, and so does the program.
  it.each([
    ["ToString of `{ toString: undefined }`", "var o = { toString: undefined }; var s = '' + o;"],
    ["ToNumber of `{ toString: 1 }`", "var o = { toString: 1 }; var n = +o;"],
  ])(
    "throws a TypeError for %s, as node does",
    async (_label, source) => {
      expect(() => new Function(source)()).toThrow(TypeError);
      expect(await run(source)).toBe("threw");
    },
    180_000,
  );

  // Node's catch reads the TypeError and answers 1. Here the TypeError is the realm's, which no carrier kind holds,
  // so a catch must not read it: the program traps instead (`js.object.uncatchable-type-error`). That is a failure, not
  // node's answer, and never a wrong one.
  it("traps instead of throwing the TypeError in a program that catches", async () => {
    const source = "var o = { toString: undefined }; var r = 0; try { var s = '' + o; } catch (e) { r = 1; }";
    expect(new Function(`${source} return r;`)()).toBe(1);
    expect(await run(source)).toBe("trapped");
  }, 180_000);

  it("refuses by name in a program that names 'Symbol'", async () => {
    const result = await compile("var o = { a: 1 }; var s = typeof Symbol; var t = '' + o;", options());
    expect(result.success).toBe(false);
    expect(messages(result).join("\n")).toContain("ToPrimitive of an object in a program that names 'Symbol'");
  });
});
