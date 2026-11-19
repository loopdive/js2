// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slices V and G — a script `var` on the Prepared whole-program path.
//   V: the IR names the home itself (`irOwnedScriptVarHome`): a `number` or `boolean` binding whose every read
//      follows its initializer gets a typed global. Every other binding stays without a home (refused).
//   G: a top-level global that is not exported has no host contract, so it is presented with the IR's own
//      storage whatever its type; an exported non-numeric one stays refused.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { type NamedVariableDeclaration, scriptVarReadsFollowInitializer } from "../src/ir/module-binding-script-var.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  compileMulti,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";
import { ts } from "../src/ts-api.js";

const options = (fileName: string): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName,
    ...(fileName.endsWith(".js") ? { allowJs: true } : {}),
  }) as Test262CompileOptions;

function forbidDirectGenerators(): void {
  for (const spy of [
    vi.spyOn(gc, "generateModule"),
    vi.spyOn(gc, "generateMultiModule"),
    vi.spyOn(linear, "generateLinearModule"),
    vi.spyOn(linear, "generateLinearMultiModule"),
  ])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
}
afterEach(() => vi.restoreAllMocks());

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

/**
 * Compile `source` through the strict Prepared entry, instantiate it (a script's top-level code runs as the
 * module's start) and report whether the program threw.
 */
async function run(source: string, fileName = "test.js"): Promise<"returned" | "threw"> {
  forbidDirectGenerators();
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

async function refusal(source: string, fileName = "test.js"): Promise<string> {
  const result = await compile(source, options(fileName));
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

const NO_HOME = "has no exact typed storage: not-direct";

describe("#7354 V — the IR's own typed home for a script var", () => {
  // Each program is run twice: once with the value JS computes (returns), once with a wrong one (throws), so
  // a pass cannot come from a check that never ran.
  it.each([
    ["update at top level", "var x = 1; x = x + 1;", "x !== 2", "x !== 3"],
    [
      "read and written from a function and from top-level code",
      "var n = 1; function bump() { n = n + 1; return n; } bump(); n = n * 10;",
      "bump() !== 21 || n !== 21",
      "n !== 21",
    ],
    [
      "read by a function declared above it and called after it",
      "function read() { return x; } var x = 4;",
      "read() !== 4",
      "read() !== 0",
    ],
    ["a boolean", "var b = true; b = !b;", "b", "!b"],
    [
      "written by a function before its declaration runs",
      "function w() { y = 5; } var y = 1; w();",
      "y !== 5",
      "y !== 1",
    ],
  ])("presents and runs a script var %s", async (_, program, holds, fails) => {
    expect(await run(`${program} if (${holds}) throw 1;`)).toBe("returned");
    expect(await run(`${program} if (${fails}) throw 1;`)).toBe("threw");
  });

  // (#7354 H) A script var V cannot prove (a read before the initializer, no initializer, a string) now gets the
  // dynamic home: `tests/issue-7354-h-script-var-dynamic-home.test.ts` runs those programs. (#7365 1b) A repeated
  // `var` is one binding: `tests/issue-7365-nested-script-var.test.ts` runs it.

  it("refuses a var of a non-writable global, whose write never lands", async () => {
    expect(await refusal("var Infinity = 1; if (Infinity === 1) throw 1;")).toContain(
      "module binding Infinity has no exact typed storage",
    );
  });

  it("presents a script var whose name a lib declaration also declares", async () => {
    expect(await run("var length = 1; length = length + 1; if (length !== 2) throw 1;")).toBe("returned");
  });

  // Every script of a program shares one global scope, and the reads proof walks one file: a script that runs
  // first may read the binding before its initializer, so a typed home needs its file to be the only source.
  // Each pair compiled before that rule, and ran with `r` reading 0 where JavaScript reads 1 or throws.
  it.each([
    ["a hoisted function", "function f() { return x; } var r = -1; try { r = f(); } catch (e) {}"],
    ["top-level code", "var r = -1; try { r = x; } catch (e) {}"],
    ["a call without a guard", "function f() { return x; } var r = f();"],
  ])("refuses a script var another script reads first through %s", async (_, first) => {
    for (const ext of [".js", ".ts"]) {
      const result = await compileMulti(
        { [`a${ext}`]: first, [`test${ext}`]: "var x = 1; if (r === 0) throw 1;" },
        `test${ext}`,
        options(`test${ext}`),
      );
      expect(result.success).toBe(false);
      expect(messages(result).join("\n")).toContain(NO_HOME);
    }
  });

  // (#7354 H) An annotated binding keeps its annotation's home or none: the dynamic home is for unannotated ones.
  it("refuses a read of the hoisted binding in a TypeScript script", async () => {
    expect(await refusal("function f(): number { return x; } f(); var x: number = 1;", "entry.ts")).toContain(NO_HOME);
  });
});

describe("#7354 G — a non-exported global is the IR's own storage", () => {
  const CAPTURE = "top-level global storage needs a numeric source classification";
  const EXPORT_JOIN = "primitive source binding, global ABI slot and physical export must join exactly";

  it("presents an internal boolean global behind a numeric export", async () => {
    forbidDirectGenerators();
    const result = await compile(
      "let b = true;\nexport function f(): number { b = !b; return b ? 1 : 0; }\n",
      options("entry.ts"),
    );
    expect(messages(result)).toEqual([]);
    const f = instantiatePreparedArtifact(result).instance.exports.f as () => number;
    expect([f(), f(), f()]).toEqual([0, 1, 0]);
  });

  it("refuses an exported boolean global at capture", async () => {
    expect(await refusal("export var b = true;", "entry.ts")).toContain(CAPTURE);
  });

  it.each(["let b = true; export { b };", "let b = true; export { b as alias };"])(
    "refuses an export of an internal global at the export join: %s",
    async (program) => {
      expect(await refusal(program, "entry.ts")).toContain(EXPORT_JOIN);
    },
  );

  it("keeps the numeric global export", async () => {
    forbidDirectGenerators();
    const result = await compile("export var x = 1;\nx = x + 1;\n", options("entry.ts"));
    expect(messages(result)).toEqual([]);
    const exports = instantiatePreparedArtifact(result).instance.exports;
    (exports.__module_init as (() => void) | undefined)?.();
    expect((exports.x as WebAssembly.Global).value).toBe(2);
  });
});

/** The reads proof on its own, over a JS script the checker sees, for the routes the Prepared path cannot lower. */
describe("#7354 V — scriptVarReadsFollowInitializer", () => {
  function follows(source: string, name = "x"): boolean {
    const fileName = "/probe.js";
    const host = ts.createCompilerHost({ allowJs: true, noLib: true });
    const read = host.getSourceFile;
    host.getSourceFile = (file, ...rest) =>
      file === fileName ? ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2020, true) : read(file, ...rest);
    const program = ts.createProgram([fileName], { allowJs: true, noLib: true }, host);
    const sourceFile = program.getSourceFile(fileName)!;
    let declaration: ts.VariableDeclaration | undefined;
    const find = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) declaration ??= node;
      ts.forEachChild(node, find);
    };
    find(sourceFile);
    return scriptVarReadsFollowInitializer(program.getTypeChecker(), declaration as NamedVariableDeclaration);
  }

  it.each([
    ["module-init reads after it", "var x = 1; x + 1;"],
    ["a plain write before it", "x = 2; var x = 1; x;"],
    ["a function expression created after it", "var x = 1; var g = function () { return x; };"],
    ["a class created after it", "var x = 1; class C { m() { return x; } }"],
    ["a function declaration only named after it", "function f() { return x; } var x = 1; f();"],
    ["a same-named parameter of a function called before it", "function g(x) { return x; } g(1); var x = 1;"],
    ["a with statement after it", "var x = 1; with ({}) { x; }"],
    [
      "a function expression calling a hoisted function, created after it",
      "var x = 1; var g = function () { f(); }; function f() { return x; }",
    ],
    [
      "a nested function declaration whose name a hoisted function shares",
      "function g() {} g(); var x = 1; var h = function () { function g() { return x; } return g; };",
    ],
  ])("proves %s", (_, source) => {
    expect(follows(source)).toBe(true);
  });

  it.each([
    ["a module-init read before it", "x; var x = 1;"],
    ["a compound write before it", "x += 1; var x = 1;"],
    ["a read in its own statement", "var x = 1, y = x;"],
    ["no initializer", "var x; x = 1; x;"],
    ["a nested declaration", "{ var x = 1; } x;"],
    ["a function expression created before it", "var g = function () { return x; }; var x = 1;"],
    ["a class created before it", "class C { m() { return x; } } var x = 1;"],
    ["a call before it", "function f() { return x; } f(); var x = 1;"],
    ["the name spelled as a member before it", "function f() { return x; } var o = {}; o.f; var x = 1;"],
    ["the name spelled as a string before it", 'function f() { return x; } "f"; var x = 1;'],
    ["a caller that is itself hoisted", "function g() { f(); } function f() { return x; } var x = 1;"],
    ["a hoisted caller declared after it", "function f() { return x; } g(); var x = 1; function g() { f(); }"],
    ["an escaping global object", "function f() { return x; } var o = this; var x = 1;"],
    ["dynamic code anywhere", 'var x = 1; eval("x");'],
    ["a shorthand property before it", "var o = { x }; var x = 1;"],
    // Inside `with` the checker resolves no symbol for `x`; an unresolved name may be the binding.
    ["a with statement before it", "var o = {}; with (o) { x; } var x = 1;"],
    [
      "a closure a hoisted function returns, called before it",
      "var r = f()(); var x = 1; function f() { return function () { return x; }; }",
    ],
    ["a labelled hoisted function called before it", "var r = f(); var x = 1; l: function f() { return x; }"],
    [
      "an anonymous default export (an importer in a cycle runs it first)",
      "export default function () { return x; } var x = 1;",
    ],
  ])("refuses %s", (_, source) => {
    expect(follows(source)).toBe(false);
  });
});
