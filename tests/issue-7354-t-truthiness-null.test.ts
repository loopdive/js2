// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice T — ToBoolean and `null` on the Prepared dynamic value. ToBoolean is the intrinsic
// `js.value.to_boolean`, whose native function is the ordinary pipeline's `__is_truthy` body (one shared
// builder). `null` is the carrier's null reference, as on the ordinary standalone pipeline, so it stays apart
// from the `undefined` singleton under strict equality and the `undefined` probe; `=== null` is `ref.is_null`.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { legalizeDynamicValues } from "../src/ir/program/dynamic-value-legalization.js";
import type { IrFunction, IrInstr } from "../src/ir/core/nodes.js";
import { JS_TAG_IDS } from "../src/ir/runtime/js-tag-domain.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const options = (target: "standalone" | "gc" = "standalone", fileName = "test.js"): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target,
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName,
    allowJs: true,
  }) as Test262CompileOptions;

afterEach(() => vi.restoreAllMocks());

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

/** A compile never yields to the event loop: a turn first lets the worker answer vitest's RPC between compiles. */
async function compileYielding(
  source: string,
  compileOptions: Test262CompileOptions,
  unlowerableBodies?: "abort" | "refuse",
) {
  await new Promise((resolve) => setImmediate(resolve));
  return compile(source, compileOptions, undefined, unlowerableBodies);
}

/** Compile a script through the strict Prepared entry, run its top-level code and report whether it threw. */
async function run(source: string, fileName?: string): Promise<"returned" | "threw"> {
  for (const spy of [vi.spyOn(gc, "generateModule"), vi.spyOn(linear, "generateLinearModule")])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
  const result = await compileYielding(source, options("standalone", fileName));
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

/**
 * The name the path refuses `source` by. (#7354 U) Compiled without abort bodies: under them a refusal inside a
 * function becomes that function's abort body, and these cases are about the name of the refusal.
 */
async function refusal(source: string, target: "standalone" | "gc" = "standalone", fileName?: string) {
  const result = await compileYielding(source, options(target, fileName), "refuse");
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

/** node's verdict on the same script: the reference every answer is checked against. */
function node(source: string): "returned" | "threw" {
  try {
    new Function(source)();
    return "returned";
  } catch {
    return "threw";
  }
}

const VALUES = ["1.5", "0", "-0", "0 / 0", "1", "1 / 0", "true", "false", "undefined", "null"] as const;
const value = (text: string): unknown => new Function(`return ${text};`)();

describe("#7354 T — ToBoolean and null on the Prepared dynamic value", () => {
  // Each program runs twice: with node's answer (returns) and with a wrong one (throws), so a pass cannot come
  // from a check that never ran.
  it.each([
    ["`!v`", "function f(v) { return !v; }\nif (f(0) !== @R || f(1) !== @W) throw 1;", "true", "false"],
    ["`&&` yields an operand", "function a(x, y) { return x && y; }\nif (a(1, true) !== @R) throw 1;", "true", "1"],
    ["`||` yields an operand", "function o(x, y) { return x || y; }\nif (o(0, 5) !== @R) throw 1;", "5", "true"],
    [
      "`||` over undefined",
      "function o(x, y) { return x || y; }\nif (o(undefined, undefined) !== @R) throw 1;",
      "undefined",
      "null",
    ],
    [
      "`=== null`",
      "function n(v) { return v === null; }\nif (n(null) !== @R || n(undefined) !== @W) throw 1;",
      "true",
      "false",
    ],
    [
      "`!== null`",
      "function n(v) { return v !== null; }\nif (n(0) !== @R || n(null) !== @W) throw 1;",
      "true",
      "false",
    ],
    [
      "`null` through a dynamic value",
      "function id(v) { return v; }\nif ((id(null) === null) !== @R) throw 1;",
      "true",
      "false",
    ],
    [
      "`null !== undefined`",
      "function id(v) { return v; }\nif ((id(null) !== id(undefined)) !== @R) throw 1;",
      "true",
      "false",
    ],
    ["ToNumber(null) is 0", "function id(v) { return v; }\nif (id(null) * 1 !== @R) throw 1;", "0", "1"],
    [
      "a loop condition",
      "function w(v) { var i = 0; while (v) { i++; v = 0; } return i; }\nif (w(1.5) !== @R) throw 1;",
      "1",
      "0",
    ],
    ["a conditional", "function c(v) { return v ? 1 : 2; }\nif (c(null) !== @R) throw 1;", "2", "1"],
  ])("answers %s like JavaScript", async (_label, template, right, wrong) => {
    // `@W` is the other polarity of `@R` where a program checks two answers.
    const program = (r: string, w: string) => template.replaceAll("@R", r).replaceAll("@W", w);
    expect(node(program(right, wrong))).toBe("returned");
    expect(await run(program(right, wrong))).toBe("returned");
    expect(node(program(wrong, right))).toBe("threw");
    expect(await run(program(wrong, right))).toBe("threw");
  });

  it.each(VALUES)("branches on %s like JavaScript", async (text) => {
    const answer = value(text) ? 1 : 2;
    const program = (expected: number) =>
      `function t(v) { if (v) return 1; return 2; }\nif (t(${text}) !== ${expected}) throw 1;`;
    expect(await run(program(answer))).toBe("returned");
    expect(await run(program(3 - answer))).toBe("threw");
  });

  // (#7354 L0a) Loose equality of two dynamic values is lowered now (tests/issue-7354-l0a-loose-equality.test.ts).
  // (#7354 L0b) So is `== null` (tests/issue-7354-l0b-expressions.test.ts).
  it.each([
    // The other from-ast paths the externref-carrier flag switches on; each still refuses before it matters.
    [
      "a dynamic for-in head",
      "function f(v) { var r = 0; for (var k in v) { r++; } return r; }\nf(null);",
      "dynamic for-in runtime is unavailable in f",
    ],
    // (#7354 F1b) A function-object property write is lowered now (tests/issue-7354-f1b-function-object-writes.test.ts).
    [
      "a primitive wrapper's ToPrimitive",
      "function h(v) { return new Number(1) == v; }\nh(1);",
      // (#7350 B3a) `Number` is the realm's value; its wrapper object waits for B3bc.
      "new Number (a wrapper object; #7350 B3bc)",
    ],
    [
      "the parseInt externref boundary",
      "function stringToNumber(v) { return parseInt(v); }\nstringToNumber(5);",
      'direct call to "parseInt" has no exact AST-site plan in stringToNumber',
    ],
  ])("refuses %s by name", async (_label, source, expected) => {
    expect(await refusal(source)).toContain(expected);
  });

  it("keeps `null` and ToBoolean of the dynamic value off the gc target", async () => {
    expect(await refusal("function t(v) { return v ? 1 : 2; }\nif (t(null) !== 2) throw 1;", "gc")).toContain(
      "function t has an unresolved parameter contract",
    );
  });

  // The catch binding is the dynamic value now (the carrier is the exception payload), so an assertion to a
  // typed position is a flow without a conversion, like an `any` one.
  it("refuses a caught value asserted into a typed result by name", async () => {
    const source = "export function f(x: number): number { try { throw x * 2; } catch (e) { return e as number; } }";
    expect(await refusal(source, "standalone", "entry.ts")).toContain(
      "a dynamic value flows into number without a conversion (ReturnStatement)",
    );
  });
});

// Review round 2 (delta after the port onto H): with ToBoolean bound, `bool && dyn` in a value position yielded the
// Boolean truth of the right operand instead of the operand. Every program runs twice: node's answer (returns) and a
// wrong one (throws).
describe("#7354 T review round 2 — `&&` / `||` with a typed left and a dynamic right operand", () => {
  it.each([
    [
      "`bool && dyn` returned",
      "function f(b, c) { return (b > 1) && c; }",
      "f(5, 7) !== 7 || f(0, 7) !== false",
      "f(5, 7) !== true",
    ],
    [
      "`bool || dyn` returned",
      "function f(b, c) { return (b > 1) || c; }",
      "f(0, 7) !== 7 || f(5, 7) !== true",
      "f(0, 7) !== true",
    ],
    ["`!a || c`", "function f(a, c) { return !a || c; }", "f(1, 7) !== 7 || f(0, 7) !== true", "f(1, 7) !== true"],
    ["`!(a && b) || c`", "function f(a, b, c) { return !(a && b) || c; }", "f(1, 1, 0) !== 0", "f(1, 1, 0) !== true"],
    [
      "a nested right operand",
      "function f(b, c, d) { return (b > 1) && (c || d); }",
      "f(5, 0, 9) !== 9",
      "f(5, 0, 9) !== true",
    ],
    [
      "assigned to a dynamic var",
      "function f(b, c) { var r = c; r = (b > 1) && c; return r; }",
      "f(5, 7) !== 7 || f(0, 7) !== false",
      "f(5, 7) !== true",
    ],
    [
      "passed as an argument",
      "function id(x) { return x; } function f(b, c) { return id((b > 1) || c); }",
      "f(0, 7) !== 7",
      "f(0, 7) !== true",
    ],
    [
      "in a condition",
      "function f(b, c) { if ((b > 1) && c) return 1; return 2; }",
      "f(5, 7) !== 1 || f(5, 0) !== 2",
      "f(5, 0) !== 1",
    ],
    // The right operand runs exactly when JavaScript runs it: `t(c, 1)` throws.
    [
      "skipping the right operand",
      "function t(x, k) { if (k === 1) throw 5; return x; } function f(b, c) { return (b > 1) && t(c, 1); }",
      "f(0, 7) !== false",
      "f(5, 7) !== 7",
    ],
  ])("yields the operand: %s", async (_, program, holds, fails) => {
    expect(await run(`${program}\nif (${holds}) throw 1;`)).toBe("returned");
    expect(await run(`${program}\nif (${fails}) throw 1;`)).toBe("threw");
  });

  it("yields the operand in TypeScript (`n > 1 && c`, `n > 1 || c`)", async () => {
    const program =
      "function f(n: number, c: any) { return n > 1 && c; } function g(n: number, c: any) { return n > 1 || c; }";
    expect(await run(`${program}\nif (f(5, 7) !== 7 || g(0, 7) !== 7) throw 1;`, "entry.ts")).toBe("returned");
    expect(await run(`${program}\nif (f(5, 7) !== true) throw 1;`, "entry.ts")).toBe("threw");
  });

  // A sweep of the cross product, every value pair in one program, checked against node. (A program per call pair
  // compiles slowly: the full sweep over every value, -0 and typed numbers included, is in the result record.)
  const LEFT = {
    bool: ["(a > 0)", ["0", "1"]],
    dyn: ["b", ["0", "NaN", "1", "false", "undefined", "null"]],
  } as const;
  const RIGHT = { bool: ["(c > 0)", ["0", "1"]], dyn: ["d", LEFT.dyn[1]] } as const;
  const POSITIONS = {
    returned: (e: string) => `return ${e};`,
    chained: (e: string) => `return ${e} || e;`,
    condition: (e: string) => `if (${e}) return 1; return 2;`,
  };
  it.each(
    (["bool", "dyn"] as const).flatMap((l) =>
      (["bool", "dyn"] as const).flatMap((r) =>
        ["&&", "||"].flatMap((op) => Object.keys(POSITIONS).map((pos) => [l, op, r, pos] as const)),
      ),
    ),
  )("sweeps %s %s %s %s against node", async (l, op, r, pos) => {
    const [leftExpr, leftValues] = LEFT[l];
    const [rightExpr, rightValues] = RIGHT[r];
    const body = POSITIONS[pos as keyof typeof POSITIONS](`${leftExpr} ${op} ${rightExpr}`);
    const fn = `function nan(x) { return x !== x; } function f(a, b, c, d, e) { ${body} }`;
    const calls = leftValues.flatMap((lv) =>
      rightValues.map(
        (rv) => `f(${l === "dyn" ? `0, ${lv}` : `${lv}, 0`}, ${r === "dyn" ? `0, ${rv}` : `${rv}, 0`}, 7)`,
      ),
    );
    const answers = new Function(`${fn} return [${calls.join(", ")}];`)() as unknown[];
    const literal = (v: unknown) => (v === undefined ? "undefined" : JSON.stringify(v));
    const checks = calls.map((call, i) =>
      Number.isNaN(answers[i])
        ? `if (!nan(${call})) throw ${i + 1};`
        : `if (${call} !== ${literal(answers[i])}) throw ${i + 1};`,
    );
    expect(node(`${fn}\n${checks.join("\n")}`)).toBe("returned");
    expect(await run(`${fn}\n${checks.join("\n")}`)).toBe("returned");
  });

  it.each([
    [
      "flowing into a typed local",
      "function f(b, c) { var r = 0; r = (b > 1) && c; return r; }\nf(5, 7);",
      'assignment to "r" (f64) got dynamic',
    ],
    [
      "with a typed number left operand",
      "function f(n: number, c: any) { return n && c; }\nf(5, 7);",
      "operator '&&' requires bool operands",
    ],
    // Should-fix (1): an unannotated result with no Prepared contract names its type, not a later void call.
    [
      "returning `n as unknown`",
      "function f(n: number) { return n as unknown; }\nf(1);",
      "function f returns unknown, which has no Prepared result contract",
    ],
    [
      "returning `n as unknown as object`",
      "function f(n: number) { return n as unknown as object; }\nf(1);",
      "function f returns object, which has no Prepared result contract",
    ],
  ])("refuses an operand value %s by name", async (_, program, message) => {
    expect(await refusal(program, "standalone", "entry.ts")).toContain(message);
  });
});

// Review round 3: a `&&` / `||` whose value is unused dropped its right operand (pre-existing on H for typed code,
// root fix #7359). Every right operand here runs or is skipped exactly as in JavaScript; a counter program runs
// twice, node's count (returns) and a wrong one (throws). The full cross product (432 programs) is in the record.
describe("#7354 T review round 3 — an unused `&&` / `||` keeps its right operand", () => {
  const HEAD =
    "var n = 0; function inc(v){ n = n * 1 + 1; return v; } function boom(v){ if (v) throw 9; return v; } " +
    "function id(v){ return v; } ";
  const POSITIONS = {
    statement: (e: string) => `function f(a, b){ ${e}; return n; } var r = f(@A, 1);`,
    "an unread local": (e: string) => `function f(a, b){ var u = ${e}; return n; } var r = f(@A, 1);`,
    "the top level": (e: string) => `var a = id(@A); var b = id(1); ${e}; var r = n;`,
    "a loop": (e: string) =>
      `function f(a, b){ for (var i = 0; i < 2; i = i + 1) { ${e}; } return n; } var r = f(@A, 1);`,
  };
  const cases = ["&&", "||"].flatMap((op) =>
    ["(a > 0)", "a"].flatMap((left) =>
      ["inc(b)", "(inc(b) > 0)"].flatMap((right) =>
        Object.keys(POSITIONS).map((position) => [op, left, right, position] as const),
      ),
    ),
  );

  it.each(cases)("`%s` with left %s and right %s in %s", async (op, left, right, position) => {
    const at = POSITIONS[position as keyof typeof POSITIONS];
    // `a` is 1 for `&&` and 0 for `||`: the right operand runs (node counts how often).
    const counter = HEAD + at(`${left} ${op} ${right}`).replace("@A", op === "&&" ? "1" : "0");
    const count = new Function(`${counter} return n;`)() as number;
    expect(count).toBeGreaterThan(0);
    expect(await run(`${counter} if (r !== ${count}) throw 1;`)).toBe("returned");
    expect(await run(`${counter} if (r !== ${count + 1}) throw 1;`)).toBe("threw");
    const throwing = HEAD + at(`${left} ${op} ${right.replace("inc", "boom")}`);
    expect(await run(throwing.replace("@A", op === "&&" ? "1" : "0"))).toBe("threw");
    expect(await run(throwing.replace("@A", op === "&&" ? "0" : "1"))).toBe("returned");
  });

  it.each(["&&", "||"])("refuses a typed number left operand of an unused `%s` by name", async (op) => {
    expect(await refusal(`${HEAD}function f(a, b){ (a * 1) ${op} inc(b); return n; } f(1, 1);`)).toContain(
      `operator '${op}' requires bool operands in f`,
    );
  });
});

// The merge with slice Str: a native string reaches the carrier, so ToBoolean takes the string arm (empty is falsy).
describe("#7354 T after Str — ToBoolean of a carried string", () => {
  it.each([
    ["a conditional", 'function f(v) { return v ? 1 : 2; }\nif (f("") !== @R || f("a") !== @W) throw 1;', "2", "1"],
    ["an if", 'function f(v) { if (v) return 1; return 2; }\nif (f("") !== @R || f("a") !== @W) throw 1;', "2", "1"],
    ["`||` yields an operand", 'function o(x, y) { return x || y; }\nif (o("", 5) !== @R) throw 1;', "5", '""'],
    ["`!v`", 'function f(v) { return !v; }\nif (f("") !== @R || f("a") !== @W) throw 1;', "true", "false"],
  ])("answers %s like JavaScript", async (_label, template, right, wrong) => {
    const program = (r: string, w: string) => template.replaceAll("@R", r).replaceAll("@W", w);
    expect(node(program(right, wrong))).toBe("returned");
    expect(await run(program(right, wrong))).toBe("returned");
    expect(node(program(wrong, right))).toBe("threw");
    expect(await run(program(wrong, right))).toBe("threw");
  });
});

describe("#7354 T — the legalization arms", () => {
  const dynamic = { kind: "dynamic" } as const;
  const externref = { kind: "val", val: { kind: "externref" } } as const;
  const i32 = { kind: "val", val: { kind: "i32" } } as const;
  const one = (instr: object, params: readonly object[] = [dynamic]) =>
    legalizeDynamicValues({
      unitId: "ir-unit:test",
      name: "f",
      params: params.map((type, index) => ({ value: index, type, name: `p${index}` })),
      resultTypes: [i32],
      blocks: [
        {
          id: 0,
          blockArgs: [],
          blockArgTypes: [],
          instrs: [instr as IrInstr],
          terminator: { kind: "return", values: [1] },
        },
      ],
      exported: false,
      valueCount: 2,
    } as unknown as IrFunction).blocks[0]!.instrs[0];

  it("lowers ToBoolean to its intrinsic", () => {
    expect(one({ kind: "dyn.truthy", value: 0, result: 1, resultType: i32 })).toMatchObject({
      kind: "intrinsic",
      id: "js.value.to_boolean",
      args: [0],
    });
  });

  it("lowers the null tag test to the carrier's null check", () => {
    expect(one({ kind: "tag.test", value: 0, tagId: JS_TAG_IDS.Null, result: 1, resultType: i32 })).toEqual({
      kind: "unary",
      op: "ref.is_null",
      rand: 0,
      result: 1,
      resultType: i32,
    });
  });

  it("boxes null as the carrier's null reference", () => {
    const box = {
      kind: "box",
      value: 0,
      toType: { kind: "dynamic", tag: JS_TAG_IDS.Null },
      result: 1,
      resultType: dynamic,
    };
    expect(one(box, [externref])).toEqual({
      kind: "const",
      value: { kind: "null", ty: externref },
      result: 1,
      resultType: externref,
    });
  });
});
