// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7525 — since #7135 the IR claims `f(t: any)` on the host-free lanes, and its dynamic numeric arms run ToNumber
// where the spec takes ToNumeric: `String(-t)` on an `any` narrowed to `bigint` answered "NaN". The IR now refuses a
// dynamic numeric, additive or loose-equality operator on an operand whose static type has a BigInt member, so
// legacy (which is right) compiles the unit; the Prepared path, which has no selector, refuses it by name. The
// ToNumeric ops that let the IR claim these units are #7526.
import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { compile as compilePrepared, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";

type Target = "gc" | "standalone";

const NARROW = (body: string, result = "string"): string =>
  `function f(t: any, u: any): ${result} { if (typeof t === "bigint" && typeof u === "bigint") { ${body} } ` +
  `return "o" as any; }`;
const CATCH = (expression: string): string =>
  `function f(t: any): number { if (typeof t === "bigint") { try { return ${expression}; } catch (e) { ` +
  `return e instanceof TypeError ? 7 : 8; } } return 0; }`;

// [shape, function f, `main()`'s check — true is node's answer]
const ROWS: readonly (readonly [string, string, string])[] = [
  ["String(-t)", NARROW("return String(-t);"), 'f(5n, 2n) === "-5" && f(-7n, 2n) === "7"'],
  ["typeof -t", NARROW("return typeof -t;"), 'f(5n, 2n) === "bigint"'],
  ["+t throws", CATCH("+t"), "f(5n) === 7"],
  ["t * t", NARROW("return String(t * t);"), 'f(5n, 2n) === "25"'],
  ["t - u", NARROW("return String(t - u);"), 'f(5n, 2n) === "3"'],
  ["t / u", NARROW("return String(t / u);"), 'f(5n, 2n) === "2"'],
  ["t % u", NARROW("return String(t % u);"), 'f(5n, 2n) === "1"'],
  ["t * 2 throws", CATCH("t * 2"), "f(5n) === 7"],
  ["k++", NARROW("let k = t; k++; return String(k);"), 'f(5n, 2n) === "6"'],
  ["--k", NARROW("let k = t; --k; return String(k);"), 'f(5n, 2n) === "4"'],
  ["t + u", NARROW("return String(t + u);"), 'f(5n, 2n) === "7"'],
  ["t < u", NARROW("return String(t < u);"), 'f(5n, 6n) === "true" && f(7n, 6n) === "false"'],
  ["t == u", NARROW("return String(t == u);"), 'f(5n, 5n) === "true" && f(5n, 6n) === "false"'],
  ["t != u", NARROW("return String(t != u);"), 'f(5n, 5n) === "false"'],
  ["t == 1", NARROW("return String(t == 1);"), 'f(1n, 1n) === "true"'],
  // Already right on main, kept so a change cannot break them: strict equality stays on the IR.
  ["t === u", NARROW("return String(t === u);"), 'f(5n, 5n) === "true" && f(5n, 6n) === "false"'],
  ['t + ""', NARROW('return t + "";'), 'f(5n, 2n) === "5"'],
];

const program = (fn: string, check: string): string =>
  `${fn} export function main(): number { return ${check} ? 1 : 0; }`;

async function compileTs(source: string, target: Target): Promise<CompileResult> {
  const result = await compile(source, { fileName: "test.ts", target, trackIrOutcomes: true });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  return result;
}

async function runMain(result: CompileResult, target: Target): Promise<number> {
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : { env: built.env, string_constants: built.string_constants };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports.main as () => number)();
}

/** `f`'s IR outcome: "emitted" when the IR claimed it, else the refusal code. */
function irOutcomeOfF(result: CompileResult): string {
  const observed = (result.irOutcomes ?? []).find((candidate) => candidate.displayName === "f");
  if (observed === undefined) throw new Error("no IR outcome for f");
  return observed.kind === "emitted" ? "emitted" : ((observed as { code?: string }).code ?? observed.kind);
}

describe.each(["gc", "standalone"] as const)("#7525 — numeric operators on a narrowed BigInt (%s)", (target) => {
  it.each(ROWS)("%s answers like node", async (_, fn, check) => {
    expect(await runMain(await compileTs(program(fn, check), target), target)).toBe(1);
  });

  it("the IR keeps claiming a narrowed number operand", async () => {
    const source = program(
      'function f(t: any): string { if (typeof t === "number") return String(-t * 2); return "o"; }',
      'f(3) === "-6"',
    );
    const result = await compileTs(source, target);
    expect(await runMain(result, target)).toBe(1);
    expect(irOutcomeOfF(result)).toBe("emitted");
  });
});

describe("#7525 — the host-free IR refuses a BigInt operand of a dynamic numeric operator", () => {
  it("leaves `-t` on an `any` narrowed to bigint to legacy", async () => {
    const result = await compileTs(program(NARROW("return String(-t);"), 'f(5n, 2n) === "-5"'), "standalone");
    expect(irOutcomeOfF(result)).toBe("operand-coercion-unsupported");
  });

  // `bigint | number` has a BigInt member, so the IR refuses it; legacy's answer is still wrong on both lanes (#7526),
  // so this pins the refusal only, not node's value.
  it("leaves `-t` on an `any` narrowed to `bigint | number` to legacy", async () => {
    const fn =
      'function f(t: any): string { if (typeof t === "bigint" || typeof t === "number") return String(-t); return "o"; }';
    const result = await compileTs(program(fn, 'f(3) === "-3"'), "standalone");
    expect(irOutcomeOfF(result)).toBe("operand-coercion-unsupported");
  });

  // Strict equality and ToBoolean are exact on the carrier, so the IR keeps claiming them.
  it.each([
    ["t === u", NARROW("return String(t === u);"), 'f(5n, 5n) === "true"'],
    ["!t", NARROW("return String(!t);"), 'f(0n, 2n) === "true" && f(5n, 2n) === "false"'],
  ])("keeps %s on a narrowed BigInt on the IR", async (_, fn, check) => {
    const result = await compileTs(program(fn, check), "standalone");
    expect(await runMain(result, "standalone")).toBe(1);
    expect(irOutcomeOfF(result)).toBe("emitted");
  });
});

describe("#7525 — the Prepared path refuses the same operators by name", () => {
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

  it.each([
    ["unary -", 'function f(t) { if (typeof t === "bigint") return typeof -t; return "o"; }'],
    [
      "binary *",
      'function f(t, u) { if (typeof t === "bigint" && typeof u === "bigint") return typeof (t * u); return "o"; }',
    ],
    ["++", 'function f(t) { if (typeof t === "bigint") { t++; return typeof t; } return "o"; }'],
    ...["*=", "+=", "-=", "<<="].map(
      (op) =>
        [
          `${op}`,
          `function f(t, u) { if (typeof t === "bigint" && typeof u === "bigint") { t ${op} u; return typeof t; } return "o"; }`,
        ] as const,
    ),
    [
      "*= on a narrowed copy",
      'function f(t, u) { if (typeof t === "bigint" && typeof u === "bigint") { var k = t; k *= u; return typeof k; } return "o"; }',
    ],
    [
      "*= into a dynamic member",
      'function f(o, u) { if (typeof u === "bigint") { o.x *= u; return typeof o.x; } return "o"; }',
    ],
  ])("%s on a narrowed BigInt", async (_, source) => {
    const result = await compilePrepared(source, options(), undefined, "refuse");
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => [error.code, error.message])).toEqual([
      ["operand-coercion-unsupported", expect.stringContaining("dynamic numeric operator on a BigInt operand")],
    ]);
  });

  it.each([
    ["unary -", 'function f(t) { if (typeof t === "number") return typeof -t; return "o"; }'],
    [
      "*=",
      'function f(t, u) { if (typeof t === "number" && typeof u === "number") { t *= u; return typeof t; } return "o"; }',
    ],
  ])("still compiles %s on a narrowed number", async (_, source) => {
    const result = await compilePrepared(source, options(), undefined, "refuse");
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });
});
