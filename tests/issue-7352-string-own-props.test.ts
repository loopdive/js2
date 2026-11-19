// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7352 / #7354 — a member read of the dynamic value answers a string's OWN properties (§10.4.3, `MEMBER_READ_ARM`'s
// `string-own` in src/ir/program/dynamic-value-kinds.ts): `length` is the native string length, a number key or a
// constant index key is `js.value.char_at` (a one-code-unit string below the length, else `undefined`,
// `buildStringCodeUnitReadDefinition` in src/runtime/wasmgc/values/string-exotic-bodies.ts). Every other key a
// String.prototype would answer refuses by name until String.prototype exists. Every program runs twice through the
// strict Prepared entry, standalone: as written (node's answer, returns) and with a wrong answer (throws).
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

const COMPARE_ARRAY =
  "function compareArray(a, b) { if (a.length !== b.length) throw 1; " +
  "for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) throw 1; }";

/** `[name, source, [right, wrong]]`: the wrong run replaces `right` by `wrong`. */
const PROGRAMS: readonly (readonly [string, string, readonly [string, string]])[] = [
  ["a string's length", 'function f(x) { return x.length; } if (f("abc") !== 3) throw 1;', ["!== 3", "!== 4"]],
  [
    "a string's code unit, and undefined past its end",
    'function f(x) { return x[1]; } function g(x) { return x[3]; } if (f("abc") !== "b" || g("abc") !== undefined) throw 1;',
    ['!== "b"', '!== "c"'],
  ],
  [
    "an index and the length in one `+` (A2 program 4 on a string)",
    'function f(x) { return x[1] + x.length; } if (f("abc") !== "b3") throw 1;',
    ['"b3"', '"b4"'],
  ],
  [
    "run-time number keys: a loop index past the end and a non-integer",
    "function g(s) { var n = 0; for (var i = 0; i < 5; i++) if (s[i] === undefined) n++; return n; }\n" +
      "function h(s) { var k = 0.5; return s[k + 1]; }\n" +
      'if (g("abc") !== 2 || h("abc") !== undefined) throw 1;',
    ['g("abc") !== 2', 'g("abc") !== 3'],
  ],
  [
    "constant string keys: a canonical index, and a non-canonical one that names nothing",
    'function f(x) { return x["2"] + x["01"]; } if (f("abc") !== "cundefined") throw 1;',
    ['"cundefined"', '"bundefined"'],
  ],
  ["the stand-in compareArray over strings", `${COMPARE_ARRAY} compareArray("ab", "ab");`, ['"ab");', '"ac");']],
  [
    "compareArray's reads over arrays, without the loop",
    "function g(a, b) { if (a.length !== b.length || a[0] !== b[0] || a[1] !== b[1]) throw 1; } g([1, 2], [1, 2]);",
    ["[1, 2]);", "[1, 3]);"],
  ],
];

describe("#7352 a string's own properties on a dynamic receiver", () => {
  it.each(PROGRAMS)(
    "%s",
    async (_name, source, [right, wrong]) => {
      expect(source).toContain(right);
      const mistaken = source.replace(right, wrong);
      expect(() => new Function(source)()).not.toThrow();
      expect(() => new Function(mistaken)()).toThrow();
      expect(await run(source)).toBe("returned");
      expect(await run(mistaken)).toBe("threw");
    },
    180_000,
  );

  it.each([
    [
      "a String.prototype method call",
      'function f(x) { return x.charAt(0); } f("a");',
      "dynamic operation __ir_dyn_method_call_1 has no Prepared intrinsic",
    ],
    [
      "a String.prototype member read",
      'function f(x) { return x.indexOf; } f("a");',
      "member read 'indexOf' of a string needs its wrapper prototype",
    ],
    // The `i < a.length` of the loop takes ToNumber of a value an Array's [[Get]] answered, which may be an Array.
    [
      "compareArray over arrays, whose `<` needs an Array's ToPrimitive (A3)",
      `${COMPARE_ARRAY} compareArray([1, 2], [1, 2]);`,
      "ToPrimitive of an object (array ToPrimitive needs Array.prototype.join)",
    ],
  ])("refuses %s by name", async (_label, source, reason) => {
    expect(await refusal(source)).toContain(reason);
  });
});
