// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7368 — `Object.defineProperty` / `defineProperties` / `getOwnPropertyDescriptor` on the Prepared whole-program
// path. The `Object` statics table (`ir/object-statics.ts`) is the one admission; a Prepared plan lowers through the
// one emitter (`emitObjectStaticCall`) onto the realm's `js.object.*` contracts, whose defines are the descriptor
// pack's ValidateAndApplyPropertyDescriptor. Each runnable program runs with node's answer (returns) and with a wrong
// one (throws); a program that needs a later slice is pinned to its named refusal.
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

function forbidDirectGenerators(): void {
  for (const spy of [vi.spyOn(gc, "generateModule"), vi.spyOn(linear, "generateLinearModule")])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
}

/** Compile a script through the strict Prepared entry, run its top-level code and report whether it threw. */
async function run(source: string): Promise<"returned" | "threw"> {
  forbidDirectGenerators();
  const result = await compile(source, options());
  expect(messages(result)).toEqual([]);
  expect(requiredPreparedEmission(result)).toBeDefined();
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
    return "returned";
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return "threw";
  }
}

function node(source: string): "returned" | "threw" {
  try {
    new Function(source)();
    return "returned";
  } catch {
    return "threw";
  }
}

/** The program with node's answer returns and with a wrong one throws, on node and on the Prepared path. */
async function twice(program: (answer: string) => string, right: string, wrong: string): Promise<void> {
  expect(node(program(right))).toBe("returned");
  expect(await run(program(right))).toBe("returned");
  expect(node(program(wrong))).toBe("threw");
  expect(await run(program(wrong))).toBe("threw");
}

/** The Prepared path refuses `source` by name, with `code` and a message holding `detail`. */
async function refuses(source: string, code: string, detail: string): Promise<void> {
  forbidDirectGenerators();
  const result = await compile(source, options());
  expect(result.success).toBe(false);
  expect(result.errors.map((error) => [(error as { code?: string }).code, error.message])).toContainEqual([
    code,
    expect.stringContaining(detail),
  ]);
}

const SLOW = 120_000;
/** (#7354 O4) A member read in a program that names `Object`, whose statics could install a property elsewhere. */
const memberRead = (key: string) => `member read '${key}' (the program names 'Object') has no Prepared intrinsic`;

describe("#7368 — Object statics on the Prepared path", () => {
  it(
    "defines a data property on a fresh object",
    async () => {
      await twice(
        (answer) =>
          `var o = Object.defineProperty({}, "x", { value: 1, writable: false });\n` +
          `if (Object.getOwnPropertyDescriptor(o, "x") ${answer} undefined) throw 1;`,
        "===",
        "!==",
      );
    },
    SLOW,
  );

  it(
    "defines each entry of a descriptor map",
    async () => {
      await twice(
        (answer) =>
          `var o = Object.defineProperties({}, { a: { value: 1 }, b: { value: 2, enumerable: true } });\n` +
          `if (Object.getOwnPropertyDescriptor(o, "a") === undefined) throw 1;\n` +
          `if (Object.getOwnPropertyDescriptor(o, "b") === undefined) throw 2;\n` +
          `if (Object.getOwnPropertyDescriptor(o, ${answer}) !== undefined) throw 3;`,
        '"c"',
        '"b"',
      );
    },
    SLOW,
  );

  it(
    "answers FromPropertyDescriptor as an object, and undefined for a primitive's absent property",
    async () => {
      await twice(
        (answer) =>
          `var d = Object.getOwnPropertyDescriptor(Object.defineProperty({}, "x", { enumerable: true }), "x");\n` +
          `if (typeof d !== ${answer}) throw 1;\n` +
          `if (Object.getOwnPropertyDescriptor(5, "x") !== undefined) throw 2;`,
        '"object"',
        '"undefined"',
      );
    },
    SLOW,
  );

  it(
    "throws ToObject's TypeError for a nullish receiver",
    async () => {
      for (const receiver of ["null", "undefined"]) {
        const source = `var d = Object.getOwnPropertyDescriptor(${receiver}, "x");`;
        expect(node(source)).toBe("threw");
        expect(await run(source)).toBe("threw");
      }
    },
    SLOW,
  );

  it(
    "defines on a binding, behind §20.1.2.4's Object test",
    async () => {
      await twice(
        (answer) =>
          `var o = {};\nObject.defineProperty(o, "x", { value: 1, writable: false });\n` +
          `if (!o.hasOwnProperty(${answer})) throw 1;`,
        '"x"',
        '"y"',
      );
      const primitive = 'var n = 5; Object.defineProperty(n, "x", { value: 1 });';
      expect(node(primitive)).toBe("threw");
      expect(await run(primitive)).toBe("threw");
    },
    SLOW,
  );

  // The census shape (Object/defineProperty 15.2.3.6-2-*, defineProperties 15.2.3.7-*): a script var's dynamic home
  // passed as the target, then tested through its own properties.
  it(
    "defines each entry of a map on a binding, and a numeric key as its ToString",
    async () => {
      await twice(
        (answer) =>
          `var obj = {};\nObject.defineProperties(obj, { a: { value: 1 }, b: { get: undefined } });\n` +
          `Object.defineProperty(obj, 100000000000000000000, {});\n` +
          `if (!obj.hasOwnProperty("a") || !obj.hasOwnProperty("b")) throw 1;\n` +
          `if (!obj.hasOwnProperty(${answer})) throw 2;`,
        '"100000000000000000000"',
        '"1e+20"',
      );
    },
    SLOW,
  );

  it(
    "rejects a non-configurable redefinition with the descriptor pack's TypeError",
    async () => {
      await twice(
        (answer) => `var o = Object.defineProperty({}, "x", { value: 1 });\nObject.defineProperty(o, "x", ${answer});`,
        "{ value: 1 }",
        "{ value: 2 }",
      );
    },
    SLOW,
  );
});

// The realm's own-property bodies serve no String receiver (its exotic object owns `length` and its indices); the
// legalization answers a key a String never owns and refuses the others, so no String reaches the bodies' trap.
describe("#7368 — an own-property lookup whose receiver may be a String", () => {
  it(
    "answers the String's absent property for a key no String owns",
    async () => {
      await twice(
        (answer) =>
          `var s = "abc";\nif (s.hasOwnProperty("x") !== ${answer}) throw 1;\n` +
          `if (s.propertyIsEnumerable("x") !== ${answer}) throw 2;\n` +
          `if ((Object.getOwnPropertyDescriptor(s, "x") !== undefined) !== ${answer}) throw 3;`,
        "false",
        "true",
      );
    },
    SLOW,
  );

  it(
    "keeps the realm's answer for an object held where a String could be",
    async () => {
      await twice(
        (answer) =>
          `var o = {};\nObject.defineProperty(o, "x", { value: 1, enumerable: true });\n` +
          `if (!o.hasOwnProperty(${answer}) || !o.propertyIsEnumerable(${answer})) throw 1;\n` +
          `if (Object.getOwnPropertyDescriptor(o, ${answer}) === undefined) throw 2;`,
        '"x"',
        '"y"',
      );
    },
    SLOW,
  );

  const STRING_OWN = "on a possible string, whose exotic own properties no body serves";
  it.each([
    ["length", 'var s = "abc"; if (!s.hasOwnProperty("length")) throw 1;', "js.object.has-own of 'length'"],
    [
      "an index",
      'var s = "abc"; if (!s.propertyIsEnumerable("0")) throw 1;',
      "js.object.property-is-enumerable of '0'",
    ],
    [
      "a computed key",
      'var s = "abc"; var k = "le" + "ngth"; if (Object.getOwnPropertyDescriptor(s, k) === undefined) throw 1;',
      "js.object.get-own-property of 'a computed key'",
    ],
  ])("refuses %s, which a String may own", async (_, source, lookup) => {
    expect(node(source)).toBe("returned");
    await refuses(source, "type-resolution-unsupported", `${lookup} ${STRING_OWN}`);
  });
});

describe("#7368 — named refusals on the Prepared path", () => {
  it("reading the defined property needs #7354 O4's member read in a program that names Object", async () => {
    const source = 'var o = {}; Object.defineProperty(o, "x", { value: 1, writable: false }); if (o.x !== 1) throw 1;';
    expect(node(source)).toBe("returned");
    await refuses(source, "type-resolution-unsupported", memberRead("x"));
  });

  it("reading a descriptor's field likewise", async () => {
    const source =
      'var o = Object.defineProperty({}, "x", { value: 1 });\n' +
      'if (Object.getOwnPropertyDescriptor(o, "x").writable !== false) throw 1;';
    expect(node(source)).toBe("returned");
    await refuses(source, "type-resolution-unsupported", memberRead("writable"));
  });

  it("a define that may reject, in a program that catches: no carrier kind holds the TypeError", async () => {
    const source =
      'var o = Object.defineProperty({}, "x", { value: 1 });\n' +
      'try { Object.defineProperty(o, "x", { value: 2 }); throw 1; } catch (e) { if (e === 1) throw 2; }';
    expect(node(source)).toBe("returned");
    await refuses(source, "type-resolution-unsupported", "may reject with a TypeError, in a program that catches");
  });

  // An Array is no object kind on this branch (lane S13's array carriers): its literal refuses before the define.
  it("a define on an array binding", async () => {
    const source =
      'var arr = []; Object.defineProperty(arr, "0", { value: 1 }); if (!arr.hasOwnProperty("0")) throw 1;';
    expect(node(source)).toBe("returned");
    await refuses(source, "body-shape-rejected", "empty array 'arr' escapes before its element type is closed");
  });

  it("Object.getOwnPropertyNames needs an array result", async () => {
    await refuses(
      "var o = {}; Object.getOwnPropertyNames(o);",
      "call-resolution-unsupported",
      "__getOwnPropertyNames: its answer is an array",
    );
  });

  it("a descriptor that is not an inline literal", async () => {
    await refuses(
      'var desc = { value: 1 }; var o = Object.defineProperty({}, "x", desc);',
      "call-resolution-unsupported",
      "Object.defineProperty is not an admitted Object static: descriptor",
    );
  });
});
