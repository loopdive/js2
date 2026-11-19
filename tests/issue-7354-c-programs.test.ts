// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice C — the proving programs of steps C1 to C4 (function objects on the Prepared path), end to end through
// the strict Prepared entry. Each program is checked with node's answer (returns) and a wrong one (throws). A program
// the entry does not compile yet carries its first refusal verbatim; the step that wires it deletes the pin.
import { readFileSync } from "node:fs";
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

/** A function value pulls in the native realm, whose emission takes about 20 s per program. */
const SLOW = 120_000;

const STA = readFileSync(new URL("../test262/harness/sta.js", import.meta.url), "utf-8");

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

/** Compile a script through the strict Prepared entry; no direct generator may run. */
async function strict(source: string) {
  for (const spy of [
    vi.spyOn(gc, "generateModule"),
    vi.spyOn(gc, "generateMultiModule"),
    vi.spyOn(linear, "generateLinearModule"),
    vi.spyOn(linear, "generateLinearMultiModule"),
  ])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
  return compile(source, options());
}

async function run(source: string): Promise<"returned" | "threw"> {
  const result = await strict(source);
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

interface Program {
  readonly right: string;
  readonly wrong: string;
}

/** Node returns on `right` and throws on `wrong`; the Prepared entry agrees, or refuses `right` with `pinnedRefusal`. */
async function expectRunsOrRefuses(program: Program, pinnedRefusal: string | undefined) {
  expect(node(program.right)).toBe("returned");
  expect(node(program.wrong)).toBe("threw");
  if (pinnedRefusal !== undefined) {
    const result = await strict(program.right);
    expect(result.success).toBe(false);
    expect(messages(result)[0]).toBe(pinnedRefusal);
    return;
  }
  expect(await run(program.right)).toBe("returned");
  expect(await run(program.wrong)).toBe("threw");
}

type Case = readonly [name: string, right: string, wrong: string, pinnedRefusal: string | undefined];

const check = async (_: string, right: string, wrong: string, pinnedRefusal: string | undefined) =>
  expectRunsOrRefuses({ right, wrong }, pinnedRefusal);

describe("#7354 C1 — `new F()`, `this`, `.constructor`, `instanceof`", () => {
  it.each<Case>([
    [
      "`this.a = a` under `new`",
      "function F(a){ this.a = a; } var o = new F(1); if (o.a !== 1) throw 1;",
      "function F(a){ this.a = a; } var o = new F(1); if (o.a !== 2) throw 1;",
      "ir/from-ast: property assignment on dynamic is not in slice 4 (F)",
    ],
    [
      "`o.constructor === F`",
      "function F(){} var o = new F(); if (o.constructor !== F) throw 1;",
      "function F(){} var o = new F(); if (o.constructor === F) throw 1;",
      'ir/from-ast: unknown class "F" in <module-init>',
    ],
    [
      "`o instanceof F`",
      "function F(){} var o = new F(); if (!(o instanceof F)) throw 1;",
      "function F(){} var o = new F(); if (o instanceof F) throw 1;",
      'ir/from-ast: unknown class "F" in <module-init>',
    ],
    [
      "an object result replacing the new object",
      "function F(){ return { b: 2 }; } if (new F().b !== 2) throw 1;",
      "function F(){ return { b: 2 }; } if (new F().b !== 3) throw 1;",
      // The checker's diagnostic comes first; the IR's own refusal is `unknown class "F" in <module-init>`.
      "Only a void function can be called with the 'new' keyword.",
    ],
    [
      "sta.js: `new Test262Error(m).message`",
      `${STA}\nvar e = new Test262Error("m"); if (e.message !== "m") throw 1;`,
      `${STA}\nvar e = new Test262Error("m"); if (e.message !== "n") throw 1;`,
      'ir/from-ast: instanceof RHS class "Test262Error" has no projected shape (Test262Error)',
    ],
    [
      "sta.js: `Test262Error.prototype.toString`",
      `${STA}\nvar e = new Test262Error("m"); if (e.toString() !== "Test262Error: m") throw 1;`,
      `${STA}\nvar e = new Test262Error("m"); if (e.toString() !== "Test262Error: n") throw 1;`,
      'ir/from-ast: instanceof RHS class "Test262Error" has no projected shape (Test262Error)',
    ],
  ])("%s", check, SLOW);
});

describe("#7354 C2 — own properties of a function object", () => {
  it.each<Case>([
    [
      "a method stored on a function and called through it",
      "function assert(){} assert.x = function(){ return 1; }; if (assert.x() !== 1) throw 1;",
      "function assert(){} assert.x = function(){ return 1; }; if (assert.x() !== 2) throw 1;",
      'ir/from-ast: identifier "assert" is not in scope in <module-init>',
    ],
    [
      "a data property written and read",
      "function f(){} f.p = 2; if (f.p !== 2) throw 1;",
      "function f(){} f.p = 2; if (f.p !== 3) throw 1;",
      'ir/from-ast: identifier "f" is not in scope in <module-init>',
    ],
    [
      "a property of the function read inside its own body",
      "function assert(v){ return assert._t(v); } assert._t = function(v){ return v + 1; }; if (assert(1) !== 2) throw 1;",
      "function assert(v){ return assert._t(v); } assert._t = function(v){ return v + 1; }; if (assert(1) !== 3) throw 1;",
      'ir/from-ast: identifier "assert" is not in scope in assert',
    ],
    [
      "a read before the first assignment",
      "function f(){} if (f.p !== undefined) throw 1; f.p = 1;",
      "function f(){} if (f.p === undefined) throw 1; f.p = 1;",
      // The checker's TS2565 comes first; like the ordinary compiler, the entry tolerates it, and the IR's own refusal
      // is `identifier "f" is not in scope in <module-init>`.
      "Property 'p' is used before being assigned.",
    ],
  ])("%s", check, SLOW);
});

describe("#7354 C3 — a method on `F.prototype`", () => {
  it.each<Case>([
    [
      "assigned before the hoisted declaration, called on `new F(2)`",
      "F.prototype.m = function(){ return this.a; }; function F(a){ this.a = a; } if (new F(2).m() !== 2) throw 1;",
      "F.prototype.m = function(){ return this.a; }; function F(a){ this.a = a; } if (new F(2).m() !== 3) throw 1;",
      "ir/from-ast: property assignment on dynamic is not in slice 4 (F)",
    ],
  ])("%s", check, SLOW);
});

describe("#7354 C4 — `length` and `name` of a function", () => {
  it.each<Case>([
    [
      "`F.length`",
      "function F(a, b){} if (F.length !== 2) throw 1;",
      "function F(a, b){} if (F.length !== 3) throw 1;",
      'ir/from-ast: identifier "F" is not in scope in <module-init>',
    ],
    [
      "`F.name`",
      'function F(a, b){} if (F.name !== "F") throw 1;',
      'function F(a, b){} if (F.name !== "G") throw 1;',
      'ir/from-ast: identifier "F" is not in scope in <module-init>',
    ],
  ])("%s", check, SLOW);
});
