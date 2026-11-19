// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice O, step O4 — a member read of a dynamic value with a constant key (`MEMBER_ACCESS_ARM` in
// src/ir/program/dynamic-value-kinds.ts): `undefined` / `null` throw a TypeError, an object reads through the realm's
// [[Get]], a primitive reads `undefined` for a key no built-in prototype holds. A key a built-in prototype holds, a
// computed key, a program whose prototypes code can reach, or a nullish read in a program that catches refuses by
// name. Every program runs twice: node's answer (returns) and a wrong one (throws).
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

/** Each program is run as written (node's answer) and with `!==` turned into `===` (a wrong answer). */
const PROGRAMS: readonly [string, string][] = [
  ["an own member of a script var's object", "var o = { a: 1 }; if (o.a !== 1) throw 1;"],
  ["a missing member reads undefined", "var o = { a: 1 }; if (o.b !== undefined) throw 1;"],
  ["a nested object's member", "var o = { a: { b: 2 } }; if (o.a.b !== 2) throw 1;"],
  ["a Boolean member", "var o = { a: true }; if (o.a !== true) throw 1;"],
  ["a string member in a concatenation", 'var o = { s: "x" }; if (o.s + "y" !== "xy") throw 1;'],
  ["typeof of a member", 'var o = { a: 1 }; if (typeof o.a !== "number") throw 1;'],
  ["a member read through an unannotated parameter", "function g(v) { return v.a; } if (g({ a: 3 }) !== 3) throw 1;"],
  ["a primitive's absent member", 'function g(v) { return v.q; } if (g("a") !== undefined) throw 1;'],
  ["a number's absent member", "function g(v) { return v.q; } if (g(1) !== undefined) throw 1;"],
];

describe("#7354 O4 — a member read of the dynamic value", () => {
  for (const [name, source] of PROGRAMS) {
    it(
      name,
      async () => {
        const wrong = source.replace("!==", "===");
        expect(() => new Function(source)()).not.toThrow();
        expect(() => new Function(wrong)()).toThrow();
        expect(await run(source)).toBe("returned");
        expect(await run(wrong)).toBe("threw");
      },
      180_000,
    );
  }

  it.each([
    ["undefined", "var o; var x = o.x;"],
    ["null", "var o = null; var x = o.x;"],
  ])(
    "throws reading a member of %s, as node does",
    async (_label, source) => {
      expect(() => new Function(source)()).toThrow(TypeError);
      const result = await compile(source, options());
      expect(requiredPreparedEmission(result)).toBeDefined();
      expect(() => (instantiatePreparedArtifact(result).instance.exports.__module_init as () => void)()).toThrow();
    },
    180_000,
  );

  it.each([
    [
      "a string's length",
      'var s = "a"; var n = s.length;',
      "member read 'length' of a string needs its wrapper prototype",
    ],
    ["an Object.prototype method", "var o = { a: 1 }; var t = o.toString;", "member read 'toString'"],
    ["a computed key", 'var o = { a: 1 }; var k = "a"; var v = o[k];', "dyn.member_get with a computed key"],
    [
      "a nullish read in a program that catches",
      "function f(v) { try { return v.x; } catch (e) { return 0; } } f(null);",
      "member read 'x' of a possibly nullish value in a program that catches",
    ],
    [
      "a program that names a prototype global",
      "var o = { a: 1 }; var t = typeof Object; if (o.a !== 1) throw 1;",
      "member read 'a' (the program names 'Object')",
    ],
  ])("refuses %s by name", async (_label, source, reason) => {
    expect(await refusal(source)).toContain(reason);
  });
});
