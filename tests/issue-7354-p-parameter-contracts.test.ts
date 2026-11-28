// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice P — sound contracts for untyped parameters on the Prepared standalone path. A parameter without a
// TypeScript annotation is the dynamic value (call-site propagation saw no top-level caller, no call with missing
// arguments and no call through a value, so it was never a contract), and an unannotated result is dynamic where
// the checker cannot vouch for it: `any`, or a body that can run off its end after a value. A JSDoc tag is no
// contract either way (#7354 W2): a converted value returns as typed, an unconverted one as the dynamic value.
import { afterEach, describe, expect, it, vi } from "vitest";
import { programDynamicContracts } from "../src/ir/source-dynamic-contracts.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { ts } from "../src/ts-api.js";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  compileMulti,
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

afterEach(() => vi.restoreAllMocks());

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

/** Compile a script through the strict Prepared entry, run its top-level code and report whether it threw. */
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

/**
 * The name the path refuses `source` by. (#7354 U) Compiled without abort bodies: under them a refusal inside a
 * function becomes that function's abort body, and these cases are about the name of the refusal.
 */
async function refusal(source: string, target: "standalone" | "gc" = "standalone"): Promise<string> {
  const result = await compile(source, options(target), undefined, "refuse");
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

const ID = "function id(v) { return v; }\n";

describe("#7354 P — an untyped parameter is the dynamic value", () => {
  // Each program carries node's answers and runs twice: as written (returns) and with one answer replaced by a
  // wrong one (throws), so a pass cannot come from a check that never ran.
  it.each([
    [
      "the #7354 repro: h is called with a boolean through g and with numbers from top-level code",
      "function h(v) { return v === 0; }\nfunction g(b) { return h(b); }\n" +
        "if (g(true) !== false) throw 1;\nif (h(0.5) !== false) throw 2;\nif (h(0) !== true) throw 3;",
      ["h(0) !== true", "h(0) !== false"],
    ],
    [
      "id with a number, a boolean and undefined, from top-level code and from a function",
      `${ID}function k() { if (id(true) !== true) throw 4; if (id(undefined) !== undefined) throw 5; ` +
        "if (id(2) !== 2) throw 6; }\n" +
        "if (id(1) !== 1) throw 1;\nif (id(false) !== false) throw 2;\nif (id(undefined) !== undefined) throw 3;\nk();",
      ["id(2) !== 2", "id(2) !== 3"],
    ],
    [
      "a parameter only ever passed numbers (dynamic; `*` converts it back)",
      "function sq(n) { return n * n; }\nfunction k() { return sq(3); }\nif (sq(4) + k() !== 25) throw 1;",
      ["!== 25", "!== 24"],
    ],
    [
      "recursion",
      "function f(n) { if (n === 0) return 0; return f(n - 1); }\nif (f(3) !== 0) throw 1;",
      ["f(3) !== 0", "f(3) !== 3"],
    ],
    [
      "a parameter reassigned to another type inside the body",
      "function f(v) { v = true; return v; }\nif (f(1) !== true) throw 1;",
      ["!== true", "!== 1"],
    ],
    ["a missing argument is undefined", `${ID}if (id() !== undefined) throw 1;`, ["!== undefined", "=== undefined"]],
    [
      "a body that runs off its end after returning a value returns undefined there",
      "function f(v) { if (v === 1) return 2; }\nif (f(1) !== 2) throw 1;\nif (f(3) !== undefined) throw 2;",
      ["f(3) !== undefined", "f(3) === undefined"],
    ],
    [
      "a local copied from a parameter",
      "function f(v) { var x = v; return x; }\nif (f(1) !== 1) throw 1;",
      ["!== 1", "!== 2"],
    ],
    [
      "a JSDoc `@returns {void}` on a body that returns no value (no result to contract)",
      "/** @returns {void} */\nfunction check(v) { if (v !== 1) throw 1; }\ncheck(1);",
      ["check(1);", "check(2);"],
    ],
    [
      "a JSDoc `@returns {number}` over a value the body converts",
      "/** @returns {number} */\nfunction f(n) { return n * 1; }\nif (f(true) !== 1) throw 1;",
      ["f(true) !== 1", "f(true) !== 2"],
    ],
    [
      "a JSDoc `@returns {boolean}` over a comparison",
      "/** @returns {boolean} */\nfunction f(n) { return n === 1; }\nif (f(1) !== true) throw 1;",
      ["f(1) !== true", "f(1) !== false"],
    ],
    [
      // The tag follows a statement on its line, so the checker does not attach it: f's result is the `any` of
      // id's, dynamic by the checker-`any` arm, and returns node's `true`.
      "a JSDoc `@returns {number}` the checker does not attach, over an untyped value",
      "function id(v){return v} /** @returns {number} */ function f(n){return id(n)} if (f(true) !== true) throw 1;",
      ["f(true) !== true", "f(true) !== false"],
    ],
    [
      // (#7354 F1b, F2) A declaration read as a value is its home's function value; the call is the dispatcher's.
      "a call through a value",
      `${ID}var g = id;\nif (g(1) !== 1) throw 1;`,
      ["g(1) !== 1", "g(1) !== 2"],
    ],
    [
      // (#7354 W2) A JSDoc tag is a comment: the parameter stays the dynamic value it is called with.
      "a JSDoc-typed parameter called with a wrong type at top level",
      `/** @param {number} n */\nfunction f(n) { return n; }\n${ID}if (String(f(id(true))) !== "true") throw 1;`,
      ['!== "true"', '!== "1"'],
    ],
    [
      // (#7354 W2) …and the result returns the dynamic value its body returns.
      "a JSDoc `@returns {number}` over an unconverted untyped value",
      '/** @returns {number} */\nfunction f(n) { return n; }\nif (String(f(true)) !== "true") throw 1;',
      ['!== "true"', '!== "1"'],
    ],
    [
      "the isNegativeZero helper of harness/assert.js",
      "function isNegativeZero(value) { return value === 0 && 1 / value === -Infinity; }\n" +
        "if (!isNegativeZero(-0)) throw 1;\nif (isNegativeZero(0)) throw 2;\nif (isNegativeZero(true)) throw 3;",
      ["if (isNegativeZero(0))", "if (!isNegativeZero(0))"],
    ],
  ])("runs %s", async (_name, source, [right, wrong]) => {
    expect(source).toContain(right);
    expect(await run(source)).toBe("returned");
    expect(await run(source.replace(right, wrong))).toBe("threw");
  });

  it.each([
    // (#7354 T) ToBoolean of the dynamic parameter (the repro's original `v ? 1 : 2`) is expressed now
    // (tests/issue-7354-t-truthiness-null.test.ts).
    [
      "`arguments`",
      "function f(v) { return arguments.length; }\nif (f(1) !== 1) throw 1;",
      "intrinsic callable js.closure.arguments-length needs runtime function materialization",
    ],
    // (#7354 L0b) An extra argument is expressed now (tests/issue-7354-l0b-statements.test.ts).
  ])("refuses %s", async (_name, source, message) => {
    expect(await refusal(source)).toContain(message);
  });

  // The native lane is for functions no host calls (`dynamicLane`): an `export` modifier leaves it, and a function
  // exported by name keeps the native contract, which the export join refuses.
  it.each([
    [
      "a function exported by name",
      "function f(x) { return x; }\nexport { f };",
      "source unit, export ABI and actual function-space export must join exactly",
    ],
    [
      "a function exported under another name",
      "function f(x) { return x; }\nexport { f as g };",
      "source unit, export ABI and actual function-space export must join exactly",
    ],
    [
      "an exported default function",
      "export default function f(x) { return x; }",
      "complete synchronous numeric or Boolean function declarations are required",
    ],
  ])("refuses %s with an untyped parameter", async (_name, source, message) => {
    expect(await refusal(source)).toContain(message);
  });

  it("keeps the gc target without a dynamic carrier: an untyped parameter used only from top level has no contract", async () => {
    expect(await refusal(`${ID}if (id(1) !== 1) throw 1;`, "gc")).toContain("unresolved parameter contract");
  });

  // The contract reads no call site, so a caller in another source cannot unsettle it; today a cross-source call
  // to such a function is refused before it would matter (a script has no AST-site plan for it, and an exported
  // function with an untyped parameter has no host contract).
  it.each([
    [
      "a call from another script",
      {
        "./a.js": "function h(v) { return v === 0; }\nif (h(0.5) !== false) throw 1;",
        "./b.js": "if (h(true) !== false) throw 2;",
      },
      'direct call to "h" has no exact AST-site plan',
    ],
    [
      "a call from another module",
      {
        "./a.js": "export function h(v) { return v === 0; }\nexport var x = h(0.5) ? 1 : 0;",
        "./b.js": 'import { h } from "./a.js";\nexport var y = h(true) ? 1 : 0;',
      },
      "complete synchronous numeric or Boolean function declarations are required",
    ],
  ])("refuses %s", async (_name, files, message) => {
    const result = await compileMulti(files, "./b.js", options());
    expect(result.success).toBe(false);
    expect(messages(result).join("\n")).toContain(message);
  });
});

/** The two contracts on their own, over a TypeScript source the checker sees, for lanes no program reaches whole. */
describe("#7354 P — the parameter and result contracts", () => {
  function declarationOf(source: string): { checker: ts.TypeChecker; file: ts.SourceFile; f: ts.FunctionDeclaration } {
    const fileName = "/probe.ts";
    const host = ts.createCompilerHost({ noLib: true });
    const read = host.getSourceFile;
    host.getSourceFile = (file, ...rest) =>
      file === fileName ? ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2020, true) : read(file, ...rest);
    const program = ts.createProgram([fileName], { noLib: true }, host);
    const file = program.getSourceFile(fileName)!;
    return { checker: program.getTypeChecker(), file, f: file.statements.find(ts.isFunctionDeclaration)! };
  }
  const STANDALONE = { backend: "wasmgc", target: "standalone" } as const;

  // A host async frame keeps its own contracts: an untyped parameter there is no dynamic value.
  it("gives an untyped parameter of a host async function no dynamic contract", () => {
    const { checker, file, f } = declarationOf("async function f(n) { return 1; }");
    const host = programDynamicContracts(
      { checker, policy: { backend: "wasmgc", target: "host" } },
      [file],
      new AllocSiteRegistry(),
    );
    expect(host.parameter(f, f.parameters[0]!)).toBeUndefined();
    const sync = declarationOf("function f(n) { return 1; }");
    const native = programDynamicContracts(
      { checker: sync.checker, policy: STANDALONE },
      [sync.file],
      new AllocSiteRegistry(),
    );
    expect(native.parameter(sync.f, sync.f.parameters[0]!)).toEqual({ kind: "dynamic" });
  });

  it("keeps an annotated non-any result whose body runs off its end: the annotation is the contract", () => {
    const { checker, file, f } = declarationOf("function f(v: any): number | undefined { if (v === 1) return 2; }");
    expect(
      programDynamicContracts({ checker, policy: STANDALONE }, [file], new AllocSiteRegistry()).result(f),
    ).toBeUndefined();
    const bare = declarationOf("function f(v: any) { if (v === 1) return 2; }");
    expect(
      programDynamicContracts(
        { checker: bare.checker, policy: STANDALONE },
        [bare.file],
        new AllocSiteRegistry(),
      ).result(bare.f),
    ).toEqual({
      kind: "dynamic",
    });
  });
});
