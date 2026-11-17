// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice Str — strings on the Prepared standalone path. The presentation selects the native string
// policies (constants, equality, length, concatenation), the string value plan joins equality (the lazy
// `__str_equals` resource) and length (the carrier's length field), and R's census authenticates the string
// providers against the native setup. Every accepted program runs twice: as written (node's answers return) and with
// one answer replaced by a wrong one (it throws), so a pass cannot come from a check that never ran.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const options = (fileName: string, target: "standalone" | "gc" = "standalone"): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target,
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName,
    ...(fileName.endsWith(".js") ? { allowJs: true } : {}),
  }) as Test262CompileOptions;

afterEach(() => vi.restoreAllMocks());

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

/** Compile through the strict Prepared entry, run its top-level code and report whether it threw. */
async function run(source: string, fileName = "test.js"): Promise<"returned" | "threw"> {
  for (const spy of [
    vi.spyOn(gc, "generateModule"),
    vi.spyOn(gc, "generateMultiModule"),
    vi.spyOn(linear, "generateLinearModule"),
    vi.spyOn(linear, "generateLinearMultiModule"),
  ])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
  const result = await compile(source, options(fileName));
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

async function refusal(source: string, fileName = "test.js", target: "standalone" | "gc" = "standalone") {
  const result = await compile(source, options(fileName, target));
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

/** Each program carries node's answers; `[right, wrong]` is the one answer the second run replaces. */
const accepted = (cases: readonly (readonly [string, string, readonly [string, string]])[]) =>
  it.each(cases)("%s", async (_, source, [right, wrong]) => {
    expect(source).toContain(right);
    expect(await run(source)).toBe("returned");
    expect(await run(source.replace(right, wrong))).toBe("threw");
  });

describe("#7354 Str 1 — typed strings through the presentation", () => {
  accepted([
    [
      "a typed string local: constant, !==, .length",
      'function f() { var s = "ab"; if (s !== "ab" || s.length !== 2) throw 1; }\nf();',
      ["s.length !== 2", "s.length !== 3"],
    ],
    [
      "concatenation of typed strings, a non-ASCII literal, equality and length of the result",
      'function h() { var s = "p" + "\\u00ab"; var t = s + "q"; return t + "r"; }\n' +
        'if (h() !== "p\\u00abqr" || h().length !== 4) throw 2;',
      ["h().length !== 4", "h().length !== 5"],
    ],
    [
      "throw of a string, caught; a string returned out of a try and out of its catch",
      'function g(n) { try { if (n === 1) throw "x"; return "a"; } catch (e) { return "c"; } }\n' +
        'if (g(0) !== "a" || g(1) !== "c") throw 1;',
      ['g(1) !== "c"', 'g(1) !== "a"'],
    ],
  ]);

  it("concatenates, compares and measures typed string parameters (TypeScript)", async () => {
    const source =
      "function cat(a: string, b: string): string { return a + b; }\n" +
      "function eq(a: string, b: string): boolean { return a === b; }\n" +
      "export function main(): number {\n" +
      "  const s = cat('a', 'bc');\n" +
      "  return (s.length === 3 ? 1 : 0) + (eq(s, 'abc') ? 2 : 0) + (eq(s, 'abd') ? 4 : 0) + (eq(cat('', ''), '') ? 8 : 0);\n" +
      "}\n";
    const result = await compile(source, options("entry.ts"));
    expect(messages(result)).toEqual([]);
    expect((instantiatePreparedArtifact(result).instance.exports.main as () => number)()).toBe(11);
  });

  it("an uncaught thrown string escapes as an exception", async () => {
    expect(await run('function f() { throw "x"; }\nf();')).toBe("threw");
  });

  it.each([
    [
      "a reassigned typed string local (from-ast has no string slot on this path)",
      'function h() { var s = "p"; s = s + "q"; return s; }\nh();',
      "mutable binding 's' (string) has no slot representation",
    ],
    [
      "a script-level string var (no string global home)",
      'var s = "ab";\nif (s !== "ab") throw 1;',
      "module binding s has no exact typed storage",
    ],
  ])("refuses %s", async (_, source, detail) => {
    expect(await refusal(source)).toContain(detail);
  });

  it("refuses the relational compare of typed strings (no join)", async () => {
    const source =
      "function lt(a: string, b: string): boolean { return a < b; }\n" +
      "export function main(): number { return lt('a', 'b') ? 1 : 0; }\n";
    expect(await refusal(source, "entry.ts")).toContain("js.string.compare is unavailable");
  });

  it("refuses a typed string program on the gc target (no string policy there)", async () => {
    expect(await refusal('function f() { var s = "ab"; return s.length; }\nf();', "test.js", "gc")).toContain(
      "string-const policy storage=unsupported",
    );
  });
});
