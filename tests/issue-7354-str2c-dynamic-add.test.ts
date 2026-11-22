// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice Str2-c step 2 — dynamic `+` and `+=` on the Prepared path. The legalization expands the front end's
// `__ir_dyn_add` (`addition` in `src/ir/program/dynamic-value-legalization.ts`): a string on either side
// concatenates the ToStrings, otherwise the ToNumbers are summed; operands of a known kind take only their arms.
// Every program is checked against node twice: the right answer returns, a wrong one throws.
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const options = (target: "standalone" | "gc" = "standalone"): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target,
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName: "test.js",
    allowJs: true,
  }) as Test262CompileOptions;

// A compile runs synchronously for seconds; yielding a macrotask between tests lets the worker answer vitest's RPC.
afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});
const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

async function run(source: string): Promise<"returned" | "threw"> {
  for (const spy of [vi.spyOn(gc, "generateModule"), vi.spyOn(linear, "generateLinearModule")])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
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
async function expectLikeNode(program: (right: boolean) => string) {
  expect(node(program(true))).toBe("returned");
  expect(await run(program(true))).toBe("returned");
  expect(node(program(false))).toBe("threw");
  expect(await run(program(false))).toBe("threw");
}

const VALUES = [
  "1",
  "0",
  "-0",
  "0 / 0",
  "1 / 0",
  "-1 / 0",
  "1.5",
  "true",
  "false",
  "undefined",
  "null",
  '""',
  '"a"',
  '"1"',
  '" 12 "',
];
const value = (text: string): unknown => new Function(`return ${text};`)();
/** A check that `r` is exactly `expected` (kind, value, the sign of zero, NaN). */
function exact(r: string, expected: unknown): string {
  if (typeof expected === "string") return `(typeof ${r} === "string" && ${r} === ${JSON.stringify(expected)})`;
  const n = expected as number;
  if (Number.isNaN(n)) return `(typeof ${r} === "number" && ${r} !== ${r})`;
  if (n === 0) return `(typeof ${r} === "number" && ${r} === 0 && 1 / ${r} ${Object.is(n, -0) ? "<" : ">"} 0)`;
  return `(typeof ${r} === "number" && ${r} === ${Object.is(n, Infinity) ? "1 / 0" : Object.is(n, -Infinity) ? "-1 / 0" : String(n)})`;
}
/** The wrong expectation: another string, or the number as a string. */
const wrongOf = (expected: unknown): unknown => (typeof expected === "string" ? `${expected}?` : String(expected));
const PAIRS = VALUES.flatMap((a) => VALUES.map((b) => [a, b] as const));
const chunks = <T>(rows: readonly T[], size: number) =>
  Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, i * size + size));

// A Prepared compile costs seconds, so the sweep checks every pair once against node (the right answers return) and
// proves the check itself with one wrong answer per position (it throws).
async function expectRight(program: string) {
  expect(node(program)).toBe("returned");
  expect(await run(program)).toBe("returned");
}
const sum = (a: string, b: string) => (value(a) as number) + (value(b) as number);
const checks = (rows: readonly (readonly [string, string])[], site: (a: string, b: string) => string) =>
  rows.map(([a, b], i) => `${site(a, b)}if (!${exact("r", sum(a, b))}) throw ${i};`);
const POSITIONS: readonly [string, string, (a: string, b: string) => string, number][] = [
  ["returned from a function", "function f(a, b) { return a + b; }\nvar r;", (a, b) => `r = f(${a}, ${b}); `, 1],
  // A site per pair: top level over dynamic globals, every 13th pair (`id` keeps the checker from narrowing the globals).
  [
    "at top level",
    "function id(v) { return v; }\nvar g; var h; var r;",
    (a, b) => `g = id(${a}); h = id(${b}); r = g + h; `,
    13,
  ],
];

describe("#7354 Str2-c — dynamic + over the carrier's cross product, like node", () => {
  describe.each(POSITIONS)("%s", (_label, declarations, site, stride) => {
    const pairs = PAIRS.filter((_, i) => i % stride === 0);
    it.each(chunks(pairs, 45).map((rows, index) => [index, rows] as const))(
      "pairs chunk %i",
      async (_i, rows) => {
        await expectRight([declarations, ...checks(rows, site)].join("\n"));
      },
      150_000,
    );
    it.each([
      ["a number", "1", "2", 3, 4],
      ["a string", '"a"', "null", "anull", "a null"],
    ])("throws on a wrong answer (%s)", async (_k, a, b, right, wrong) => {
      await expectLikeNode((ok) =>
        [declarations, `${site(a, b)}if (!${exact("r", ok ? right : wrong)}) throw 1;`].join("\n"),
      );
    });
  });

  // Every third pair, in one program (a compile costs about 0.6 s per site).
  const CONDITION_PAIRS = PAIRS.filter((_, i) => i % 3 === 0);
  it("answers pairs as a condition (ToBoolean of the sum)", async () => {
    await expectLikeNode((right) =>
      [
        "function f(a, b) { if (a + b) return 1; return 0; }",
        ...CONDITION_PAIRS.map(([a, b], i) => {
          const truthy = Boolean(sum(a, b));
          return `if (f(${a}, ${b}) !== ${(!right && i === CONDITION_PAIRS.length - 1 ? !truthy : truthy) ? 1 : 0}) throw ${i};`;
        }),
      ].join("\n"),
    );
  }, 200_000);
});

describe("#7354 Str2-c — dynamic + with operands of a known kind", () => {
  it.each([
    [
      "typed number + dynamic",
      "function f(v) { var n = 2 * 1; return n + v; }",
      ["1", '"a"', "true", "null", "undefined"],
    ],
    [
      "dynamic + typed number",
      "function f(v) { var n = 2 * 1; return v + n; }",
      ["1", '"a"', "true", "null", "undefined"],
    ],
    ["typed string + dynamic", 'function f(v) { var s = "x"; return s + v; }', ["1", '"a"', "true", "null", "-0"]],
    [
      "dynamic + typed string",
      'function f(v) { var s = "x"; return v + s; }',
      ["1", '"a"', "false", "undefined", "0 / 0"],
    ],
    [
      "literal + dynamic + literal",
      "function f(v) { return '\"' + v + '\"'; }",
      ["1.5", '"a"', "true", "null", "1e21"],
    ],
    [
      "typed boolean + dynamic",
      "function f(v) { var b = 1 < 2; return b + v; }",
      ["1", '"a"', "true", "null", "undefined"],
    ],
  ])("answers %s", async (_label, declaration, values) => {
    const f = new Function(`${declaration}; return f;`)() as (v: unknown) => unknown;
    await expectLikeNode((right) =>
      [
        declaration,
        ...values.map((v, i) => {
          const expected = f(value(v));
          return `if (!${exact(`f(${v})`, !right && i === values.length - 1 ? wrongOf(expected) : expected)}) throw ${i};`;
        }),
      ].join("\n"),
    );
  });

  // A chain's first `+` of two non-strings is a number, not a known string, to the next `+` of the chain.
  it("answers chains whose first pair is numeric", async () => {
    const declarations = "function f(a, b, c) { return a + b + c; }\nfunction g(a, b, c, d) { return a + b + c + d; }";
    const fns = new Function(`${declarations}; return [f, g];`)() as ((...v: unknown[]) => unknown)[];
    const rows: readonly (readonly ["f" | "g", readonly string[]])[] = [
      ["f", ["1", "2", '"x"']],
      ["f", ["true", "1", "null"]],
      ["f", ["1", "2", "3"]],
      ["f", ['"a"', "1", "2"]],
      ["f", ["undefined", "1", '"z"']],
      ["g", ["1", "2", "3", '"s"']],
    ];
    await expectLikeNode((right) =>
      [
        declarations,
        ...rows.map(([name, args], i) => {
          const expected = fns[name === "f" ? 0 : 1]!(...args.map(value));
          const call = `${name}(${args.join(", ")})`;
          return `if (!${exact(call, !right && i === rows.length - 1 ? wrongOf(expected) : expected)}) throw ${i};`;
        }),
      ].join("\n"),
    );
  }, 120_000);

  it("keeps typed + typed as before (no dynamic expansion)", async () => {
    await expectLikeNode((ok) => `var a = 1; var b = 2;\nif (a + b !== ${ok ? 3 : 4}) throw 1;`);
  });
});

describe("#7354 Str2-c — dynamic + statements, order, loops and +=", () => {
  it.each([
    [
      "evaluates left before right, once each",
      "var n = 0; function f(a, b) { return (n = n * 10 + 1, a) + (n = n * 10 + 2, b); } function cat(a, b) { return a + b; }",
      'cat(f(1, "x"), f(null, 2))',
      '"1x2"',
      '"1x2 "',
      "n === 1212",
    ],
    [
      "the assert.js message shape (non-ASCII literal)",
      'function m(actual, expected) { return "Expected SameValue(«" + actual + "», «" + expected + "») to be true"; }',
      'm(1, "1")',
      '"Expected SameValue(«1», «1») to be true"',
      '"Expected SameValue(«1», «\\"1\\"») to be true"',
      "true",
    ],
    [
      "formatIdentityFreeValue's string arm",
      "function q(value) { return '\"' + value + '\"'; }",
      'q("ab") + q(-0)',
      '"\\"ab\\"\\"0\\""',
      '"\\"ab\\"\\"-0\\""',
      "true",
    ],
    ["String(value) + n", 'function b(value) { return String(value) + "n"; }', "b(12)", '"12n"', '"12"', "true"],
    [
      "+= number then string on a dynamic var",
      "function f(a, b) { var s = a; s += 1; s += b; s += 2; return s; }",
      'f(1, "x")',
      '"2x2"',
      '"2x2 "',
      "true",
    ],
    [
      "+= across loop iterations, kind changing",
      'function cat(a, b) { return a + b; } function f(v) { var s = v; for (var i = 0; i < 4; i++) { s += i === 2 ? "|" : i; } return s; }',
      "cat(f(1), f(null))",
      '"2|31|3"',
      '"2|31|4"',
      "true",
    ],
    [
      "nested loops and sibling blocks",
      "function cat(a, b) { return a + b; } function f(v) { var t = v; for (var i = 0; i < 2; i++) { for (var j = 0; j < 2; j++) { if (j) { t = t + j; } else { t = j + t; } } } return t; }",
      'cat(cat(f(1), "/"), f("s"))',
      '"3/00s11"',
      '"3/00s12"',
      "true",
    ],
    [
      "inside switch and try/catch/finally",
      'function cat(a, b) { return a + b; } function id(v) { return v; } function f(v) { var t = id(""); switch (typeof v) { case "number": t = v + 1; break; default: t = v + "!"; } try { t = t + v; throw t; } catch (e) { t = e + "c"; } finally { t = t + "f"; } return t; }',
      'cat(f(1), f("a"))',
      '"3cfa!acf"',
      '"3cfa!ac"',
      "true",
    ],
  ])(
    "%s",
    async (_label, declarations, expression, right, wrong, after) => {
      await expectLikeNode(
        (ok) => `${declarations}\nif (${expression} !== ${ok ? right : wrong} || !(${after})) throw 1;`,
      );
    },
    120_000,
  );

  // The addition's value unused: its operands still run, a throwing operand still throws.
  it.each([
    ["an expression statement", "a + g(b);"],
    ["an unread local", "var t = a + g(b);"],
    ["a += on an unread local", "var t = a; t += g(b);"],
  ])("evaluates the operands of %s", async (_label, statement) => {
    await expectLikeNode(
      (right) =>
        `function g(v) { if (v === 1) throw 7; return v; }\nfunction t(a, b) { ${statement} return 1; }\n` +
        `var r = 0;\ntry { t("x", 1); } catch (e) { r = 1; }\nif (r !== ${right ? 1 : 0}) throw 1;`,
    );
  });
});

// (#7354 W) A script var's dynamic home read from a function is a dynamic `+` operand too (one binding predicate).
it("adds a dynamic global and a literal, written from a function, as node does", async () => {
  const source = 'var g; function w() { g = g + "x"; }\nw(); w();\n';
  expect(await run(`${source}if (g !== "undefinedxx") throw 1;`)).toBe("returned");
  expect(await run(`${source}if (g !== "undefinedx") throw 1;`)).toBe("threw");
});

describe("#7354 Str2-c — what dynamic + still refuses by name", () => {
  // The front end makes a `+` dynamic only over operands it knows are dynamic values (parameters, dynamic vars);
  // the result of a call to an untyped function is not one of them yet.
  it.each([["the results of untyped calls", "function f(v) { return v; }\nvar s = f(1) + f(2);"]])(
    "refuses %s",
    async (_label, source) => {
      // (#7354 U) Without abort bodies: under them the refusal in `w` would be w's abort body.
      const result = await compile(source, options(), undefined, "refuse");
      expect(result.success).toBe(false);
      expect(messages(result).join("\n")).toContain("not provably both-number or string-concatenable");
    },
  );
});
