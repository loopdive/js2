// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 follow-up to slice H — a `var x;` without initializer is hoisted: its `undefined` is the value at function
// (or script) entry, and the declaration itself is no write. In a loop the declaration runs again after `x` was
// assigned and must keep that value; the Prepared path used to store `undefined` at the statement on every iteration.
import { describe, expect, it } from "vitest";
import { compile as compileOrdinary } from "../src/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { assembleHarnessBody, moduleInit } from "./helpers/harness-module-init.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

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

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

/** Compile through the strict Prepared entry, run the top-level code and report whether it threw. */
async function run(source: string, fileName = "test.js"): Promise<"returned" | "threw"> {
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

async function refusal(source: string) {
  const result = await compile(source, options("test.js"));
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

/** `f(v, w)` stores `v` into `x` in the first iteration and reads it into `r` (initially `w`) in a later one. */
const LOOPS: readonly (readonly [string, string])[] = [
  ["a for body", "for (var i = 0; i < 2; i = i + 1) { var x; if (i === 0) x = v; else r = x; }"],
  ["a while body", "var i = 0; while (i < 2) { var x; if (i === 0) x = v; else r = x; i = i + 1; }"],
  ["a do body", "var i = 0; do { var x; if (i === 0) x = v; else r = x; i = i + 1; } while (i < 2);"],
  [
    "a nested loop",
    "for (var i = 0; i < 2; i = i + 1) { for (var j = 0; j < 2; j = j + 1) { var x; if (i === 0 && j === 0) x = v; else r = x; } }",
  ],
  [
    "a switch in a loop",
    "for (var i = 0; i < 2; i = i + 1) { switch (i) { case 0: var x; x = v; break; default: r = x; } }",
  ],
  [
    "a try in a loop",
    "for (var i = 0; i < 2; i = i + 1) { try { var x; if (i === 0) x = v; else r = x; } finally {} }",
  ],
  [
    "a try/catch in a loop",
    "for (var i = 0; i < 2; i = i + 1) { try { var x; if (i === 0) x = v; else r = x; } catch (e) {} }",
  ],
  [
    "a loop left by a labelled continue",
    "outer: for (var i = 0; i < 2; i = i + 1) { for (var j = 0; j < 2; j = j + 1) { var x; if (i === 0) { x = v; continue outer; } r = x; } }",
  ],
  [
    "a labelled block in a loop",
    "for (var i = 0; i < 2; i = i + 1) { blk: { var x; if (i === 0) { x = v; break blk; } r = x; } }",
  ],
];

describe("#7354 H follow-up — a hoisted `var` declaration without initializer", () => {
  // Each program runs twice: as written (returns) and with a wrong answer (throws), so a pass cannot come from a
  // check that never ran. Every answer is node's.
  it.each(LOOPS)("keeps the value across iterations in %s", async (_, loop) => {
    const program = (expected: string) =>
      `function f(v, w) { var r = w; ${loop} return r; } if (f(5, 0) !== ${expected}) throw 1;`;
    expect(await run(program("5"))).toBe("returned");
    expect(await run(program("0"))).toBe("threw");
  });

  it.each([
    [
      "the reviewer's repro (a dynamic read multiplied)",
      "function f(v){ var r = 0; for (var i = 0; i < 2; i = i + 1) { var x; if (i === 0) x = v; else r = x * 1; } return r; }",
      "f(5) !== 5",
      "f(5) !== 6",
    ],
    [
      "a typed first store",
      "function f(v, w){ var r = w; for (var i = 0; i < 2; i = i + 1) { var x; if (i === 0) x = 5; else r = x; } return r; }",
      "f(0, 0) !== 5",
      "f(0, 0) !== undefined",
    ],
    [
      "a boolean first store",
      "function f(v, w){ var r = w; for (var i = 0; i < 2; i = i + 1) { var x; if (i === 0) x = true; else r = x; } return r; }",
      "f(0, 0) !== true",
      "f(0, 0) !== undefined",
    ],
    [
      "a read in the first iteration (undefined until the first store)",
      "function f(v, w){ var r = w; for (var i = 0; i < 1; i = i + 1) { var x; r = x; x = v; } return r; }",
      "f(1, 0) !== undefined",
      "f(1, 0) !== 1",
    ],
    [
      "a loop after an early return (the entry block is closed before the declaration)",
      "function f(v, w){ if (v === 0) return 1; var r = w; for (var i = 0; i < 2; i = i + 1) { var x; if (i === 0) x = v; else r = x; } return r; } " +
        "function g(v, w){ if (v === 0) return 1; var r = w; for (var i = 0; i < 1; i = i + 1) { var x; r = x; x = v; } return r; }",
      "f(5, 0) !== 5 || f(0, 0) !== 1 || g(5, 0) !== undefined",
      "g(5, 0) !== 0",
    ],
    [
      "a script loop",
      "var r; for (var i = 0; i < 2; i = i + 1) { var g; if (i === 0) g = 5; else r = g; } function f() { return r; }",
      "f() !== 5",
      "f() !== undefined",
    ],
    // (#7365) The nested script `var` is the global the function reads.
    [
      "a script loop var read by a function",
      "var r; function h(){ return g; } for (var i = 0; i < 2; i = i + 1) { var g; if (i === 0) g = 5; else r = h(); }",
      "r !== 5",
      "r !== undefined",
    ],
    [
      "a script while loop",
      "var r; var i = 0; while (i < 2) { var g; if (i === 0) g = true; else r = g; i = i + 1; } function f() { return r; }",
      "f() !== true",
      "f() !== undefined",
    ],
  ])("keeps the value across iterations with %s", async (_, program, holds, fails) => {
    expect(await run(`${program} if (${holds}) throw 1;`)).toBe("returned");
    expect(await run(`${program} if (${fails}) throw 1;`)).toBe("threw");
  });

  it("keeps the value in TypeScript", async () => {
    const program = (expected: string) =>
      "function f(v: any, w: any) { var r: any = w; for (let i = 0; i < 2; i = i + 1) { var x; if (i === 0) x = v; else r = x; } return r; } " +
      `if (f(5, 0) !== ${expected}) throw 1;`;
    expect(await run(program("5"), "test.ts")).toBe("returned");
    expect(await run(program("0"), "test.ts")).toBe("threw");
  });

  // What the Prepared path does not model refuses by name: no binding is hoisted to the function scope yet, and a
  // repeated declaration has no single storage.
  it.each([
    [
      "read after the loop that declares it",
      "function f(v){ for (var j = 0; j < 1; j = j + 1) { var x; x = v; } return x; } f(1);",
      'identifier "x" is not in scope in f',
    ],
    [
      "read in a loop before its declaration",
      "function f(v, w){ var r = w; for (var i = 0; i < 2; i = i + 1) { if (i === 1) r = x; var x; x = v; } return r; } f(5, 0);",
      'identifier "x" is not in scope in f',
    ],
    [
      "declared again after an assignment",
      "function f(v){ var x = v; var x; return x; } f(1);",
      "redeclaration of 'x' in f",
    ],
    // Review round 1: a repeat in another block opened a second slot starting at `undefined` (a wrong answer on
    // main too). Every repeat of a `var` name in its function refuses; none may bind a second local.
    ...(
      [
        ["in a block, then at function level", "if (v === 5) { var x; x = v; } var x; return x * 1;"],
        [
          "in two loops",
          "for (var i = 0; i < 1; i++) { var x; x = v; } for (var j = 0; j < 1; j++) { var x; return x * 1; }",
        ],
        ["in a loop, then after it", "for (var i = 0; i < 1; i++) { var x; x = v; } var x; return x * 1;"],
        [
          "in both arms of an if in a loop",
          "for (var i = 0; i < 2; i++) { if (i === 0) { var x; x = v; } else { var x; return x * 1; } }",
        ],
        ["in try, catch and finally", "try { var x; x = v; } catch (e) { var x; } finally { var x; } return x * 1;"],
        ["with an initializer in a block", "var x = 1; { var x = 2; } return x;"],
        ["after a parameter of the same name", "var v; return v * 1;"],
        [
          "as a for-head variable of two loops",
          "var r = 0; for (var i = 0; i < 2; i++) r = r + i; for (var i = 0; i < 3; i++) r = r + i; return r;",
        ],
      ] as const
    ).map(
      ([shape, body]) =>
        [`repeated ${shape}`, `function f(v){ ${body} } f(5);`, /redeclaration of '[xvi]' in f/] as const,
    ),
    // (#7365) A nested and a repeated script `var` are one global: `tests/issue-7365-nested-script-var.test.ts`
    // runs the two script programs this list refused.
    [
      "read by a closure",
      "function f(v, w){ var r = w; var k = function(){ return x; }; for (var i = 0; i < 2; i = i + 1) { var x; if (i === 0) x = v; else r = k(); } return r; } f(5, 0);",
      "closure must have a return type annotation (f)",
    ],
  ])("refuses a var %s by name", async (_, program, message) => {
    expect(await refusal(program)).toMatch(message);
  });

  // Review round 2. Only a `var` repeat refuses: sibling `let` bindings are separate bindings by definition.
  it("keeps two sibling-block `let` bindings of one name", async () => {
    const program = (expected: string) =>
      "function f(v: number) { let r = 0; for (let i = 0; i < 1; i++) { let x = v; r = r + x; } " +
      `for (let j = 0; j < 1; j++) { let x = v * 2; r = r + x; } return r; } if (f(5) !== ${expected}) throw 1;`;
    expect(await run(program("15"), "test.ts")).toBe("returned");
    expect(await run(program("10"), "test.ts")).toBe("threw");
  });

  // Review round 2. A repeated script `var` with a module home is one global (`isRedeclaredModuleVar`), not a
  // second local: the ordinary pipeline claims and runs it, so the repeat check must leave it alone.
  it("leaves a repeated script var with a module home to its one global (ordinary pipeline)", async () => {
    const source = assembleHarnessBody(
      "var s = 0;\nfor (var i = 0; i < 2; i++) { s += i; }\nfor (var i = 5; i < 7; i++) { s += i; }\n" +
        "assert.sameValue(s, 12);\nassert.sameValue(i, 7);",
    );
    const result = await compileOrdinary(source, {
      fileName: "test.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
      target: "standalone",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(moduleInit(result)?.irBodyEmitted).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports.__module_init as () => void)();
  });
});
