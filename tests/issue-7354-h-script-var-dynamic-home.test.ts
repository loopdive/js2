// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice H — a dynamic home for a script `var` on the Prepared whole-program path. Every top-level script `var`
// without a proven typed home (slice V) lives in an `externref` global holding the D1 dynamic value; the module-init
// stores `undefined` into it before its first statement, so a read before the initializer observes `undefined`. A
// value read from such a home stays dynamic through what passes it on (a local, a returned value, a call, another
// var), whatever the checker infers; a typed position it would reach refuses by name.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import type { IrFunction, IrGlobalRef, IrInstr } from "../src/ir/core/nodes.js";
import { legalizeDynamicGlobals } from "../src/ir/program/dynamic-value-legalization.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  compileMulti,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";
import type { IrUnitId } from "../src/shared/contracts/ir-identity.js";

const options = (fileName = "test.js", target: "standalone" | "gc" = "standalone"): Test262CompileOptions =>
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

/**
 * Compile a script through the strict Prepared entry, run its top-level code and report whether it threw. The
 * checker's use-before-assignment warning is the only diagnostic a program here may carry: it does not stop the
 * compile, and a read before the initializer is what the dynamic home is for.
 */
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
  expect(
    messages(result).filter((message) => !/^Variable '\w+' is used before being assigned\.$/.test(message)),
  ).toEqual([]);
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

const NO_HOME = "has no exact typed storage: not-direct";
/** `x` is read by a hoisted function before its initializer runs, so it has the dynamic home. */
const HOISTED_X = "var e = f(); var x = 1; function f() { return x; } ";

describe("#7354 H — the dynamic home of a script var", () => {
  // Each program carries node's answer and runs twice: as written (returns) and with a wrong answer (throws), so a
  // pass cannot come from a check that never ran.
  it.each(
    [
      ["assigned after a bare declaration", "var x; x = 1;", "x !== 1", "x !== 2"],
      [
        "read as undefined before its first store, then a boolean",
        "var x; if (x !== undefined) throw 9; x = true;",
        "x !== true",
        "x !== false",
      ],
      ["read before its declaration statement", "if (y !== undefined) throw 9; var y = 5;", "y !== 5", "y !== 6"],
      [
        "read by a hoisted function called before and after the initializer",
        "var r1 = f(); var z = 3; var r2 = f(); function f() { return z; }",
        "r1 !== undefined || r2 !== 3",
        "r1 !== 3",
      ],
      [
        "read through another hoisted function before the initializer",
        "function g() { return f(); } function f() { return x; } var r = g(); var x = 1;",
        "r !== undefined || g() !== 1",
        "r !== 1",
      ],
      [
        "holding a number, a boolean and undefined in turn",
        "var x; x = 1; var a = x === 1; x = true; var b = x === true; x = undefined; var c = x === undefined;",
        "!a || !b || !c",
        "a",
      ],
      ["written in a function and read at top level", "var x; function w() { x = 2; } w();", "x !== 2", "x !== 3"],
      [
        "written at top level and read in a function",
        "var x; function r() { return x; } x = true;",
        "r() !== true",
        "r() !== false",
      ],
      [
        "beside a typed home it is copied from",
        "var a = 1; var b; b = a; b = undefined;",
        "a !== 1 || b !== undefined",
        "b !== 1",
      ],
      ["initialized from a var of its own statement", "var x = 1, y = x;", "y !== 1", "y !== 2"],
      [
        "stored into another var from a call result",
        "var b = f(); var a = 1; function f() { return a; } a = b;",
        "a !== undefined || b !== undefined",
        "a !== 1",
      ],
      [
        "copied into a local and returned",
        "var e = f(); var x = 1; function f() { return x; } function k() { var t = x; return t; }",
        "k() !== 1",
        "k() !== 2",
      ],
      // A nested `var` is a module-init local, not a global: it gets no home at all.
      ["declared in a for head (a module-init local)", "for (var i = 0; i < 2; i++) {}", "i !== 2", "i !== 3"],
      // A typed home needs every stored value typed: each of these stores may be the dynamic value.
      ["stored from an untyped parameter", "var y = 1; function s(v) { y = v; } s(2);", "y !== 2", "y !== 1"],
      ["stored from a conditional of dynamic reads", "%svar y = 1; y = e === undefined ? x : x;", "y !== 1", "y !== 2"],
      ["stored from a comma expression", "%svar y = 1; y = (f(), x);", "y !== 1", "y !== 2"],
      ["stored from an assignment", "%svar w; var y = 1; y = (w = x);", "y !== 1 || w !== 1", "w !== 2"],
      ["initialized under a JSDoc number type", "%s/** @type {number} */ var y = x;", "y !== 1", "y !== 2"],
      // `x` and `y` store each other before `x` stores the dynamic `z`: the cycle must not leave `y` typed.
      [
        "in a cycle of stores with a dynamic one",
        "var e = g(); var z = 1; function g() { return z; } var x = 1; var y = 1; x = y; y = x; x = z;",
        "y !== 1 || x !== 1",
        "y !== 2",
      ],
    ].map(([name, program, holds, fails]) => [name, program.replace("%s", HOISTED_X), holds, fails]),
  )("runs a script var %s", async (_, program, holds, fails) => {
    expect(await run(`${program} if (${holds}) throw 1;`)).toBe("returned");
    expect(await run(`${program} if (${fails}) throw 1;`)).toBe("threw");
  });

  it.each([
    // The startup plan gives every declarator its own binding id: a second declaration has no single global.
    ["declared twice", "var x = 1; var x = 2;", NO_HOME],
    // Each script's module-init stores `undefined` into its own globals; a script that runs first would read null.
    ["declared in one of two scripts", ["var u; u = 1;", "var v; v = 2;"], NO_HOME],
    ["on the gc target (no dynamic carrier)", "var x; x = 1;", NO_HOME],
    // The value of a dynamic home flowing into a typed position.
    [
      "stored into a typed local",
      "var e = f(); var x = 1; function f() { return x; } function k() { var t = 0; t = x; return t; } k();",
      'assignment to "t" (f64) got dynamic',
    ],
    [
      "passed to Math.abs",
      "var e = f(); var x = 1; function f() { return x; } function k() { return Math.abs(x); } k();",
      "Math.abs arg must be f64, got dynamic",
    ],
    [
      "returned from an annotated number result (TypeScript)",
      "function f(): number { return x; } f(); var x: number = 1;",
      "a dynamic value flows into number without a conversion (ReturnStatement)",
    ],
    [
      "passed to an annotated number parameter (TypeScript)",
      "var e = f(); var x = 1; function f() { return x; } function h(n: number) { return n; } h(x);",
      "a dynamic value flows into number without a conversion (CallExpression)",
    ],
    // An operation on the dynamic value the legalization has no intrinsic for (slices Str and T).
    ["added to", `${HOISTED_X}var y = 1; y = x + 1;`, "dynamic operation __ir_dyn_add has no Prepared intrinsic"],
    [
      "tested for truth",
      `${HOISTED_X}var y = 1; y = x || 0;`,
      "dynamic operation dyn.truthy has no Prepared intrinsic",
    ],
    // A JS property declaration on the binding is no second declaration: the store, not the home, refuses.
    [
      "given a property by Object.defineProperty (slice O)",
      'var obj = {}; Object.defineProperty(obj, "foo", { value: 1 });',
      "proven dynamic binding 'obj' initializer has no supported carrier",
    ],
    // A value kind the carrier cannot hold yet is refused at its store, by the slice that owns it.
    [
      "holding an object literal (slice O)",
      "var o = { a: 1 };",
      "proven dynamic binding 'o' initializer has no supported carrier",
    ],
    ["holding an array literal", "var arr = [1];", "resolver cannot register vec for array literal"],
    [
      "holding a string (slice Str)",
      'var s = "x";',
      "dynamic operation box of a non-primitive value has no Prepared intrinsic",
    ],
    [
      "holding a function expression (slice Fa)",
      "var f = function () {};",
      "module-level closure binding 'f' not in module-init Slice 2 scope",
    ],
    ["holding a built-in member (slice B)", "var g = Math.max;", 'identifier "Math" is not in scope'],
    [
      "holding a function declaration (slice Fa)",
      "function id(v) { return v; } var g = id;",
      'identifier "id" is not in scope',
    ],
    // An exported var is a host boundary (slice G), not a script var.
    ["exported", "export var x; x = 1;", "top-level global storage needs a numeric source classification"],
  ] as const)("refuses a script var %s", async (name, program, message) => {
    if (typeof program !== "string") {
      const [a, b] = program;
      const result = await compileMulti({ "a.js": a, "test.js": b }, "test.js", options());
      expect(result.success).toBe(false);
      expect(messages(result).join("\n")).toContain(message);
      return;
    }
    const fileName = name.includes("TypeScript") ? "entry.ts" : "test.js";
    expect(await refusal(program, fileName, name.includes("gc target") ? "gc" : "standalone")).toContain(message);
  });

  // An ES module's `var` is not a script var: the resolver types its global, so a function returning it keeps the
  // checker's result (a dynamic one could not flow into `main`'s annotated number).
  it("keeps an ES module var read by a hoisted function typed", async () => {
    const result = await compile(
      "export function main(): number { return f(); }\nfunction f() { return x; }\nvar x = 1;\n",
      options("entry.ts"),
    );
    expect(messages(result)).toEqual([]);
    const exports = instantiatePreparedArtifact(result).instance.exports;
    (exports.__module_init as (() => void) | undefined)?.();
    expect((exports.main as () => number)()).toBe(1);
  });

  // A repeated var with the brief's `var b = a` is not a JavaScript-level refusal: the checker types `b` as number
  // and reports the later `undefined` store, which the strict entry refuses as a front-end error.
  it("refuses the front-end type error of an undefined store into a number-typed var", async () => {
    expect(await refusal("var a = 1; var b = a; b = undefined;")).toContain(
      "Type 'undefined' is not assignable to type 'number'.",
    );
  });
});

describe("#7354 H — legalizeDynamicGlobals", () => {
  const unit = (name: string) => `unit:${name}` as IrUnitId;
  const ref = (name: string) => ({ name }) as unknown as IrGlobalRef;
  const fn = (name: string, instrs: readonly IrInstr[]): IrFunction =>
    ({
      unitId: unit(name),
      name,
      params: [],
      resultTypes: [],
      blocks: [{ id: 0, blockArgs: [], blockArgTypes: [], instrs, terminator: { kind: "return", values: [] } }],
      exported: false,
      valueCount: 3,
    }) as unknown as IrFunction;
  const global = (name: string, type: object, owner: string) => ({
    binding: { globalRef: ref(name), type: type as never },
    identity: { storageOwnerUnitId: unit(owner) },
  });
  const f64 = { kind: "val", val: { kind: "f64" } };
  const marker = { kind: "const", value: { kind: "f64", value: 1 }, result: 0, resultType: f64 } as unknown as IrInstr;

  it("returns the program unchanged without a dynamic global", () => {
    const functions = [fn("init", [marker])];
    const globals = [global("n", f64, "init")];
    const out = legalizeDynamicGlobals(functions, globals);
    expect(out.functions).toBe(functions);
    expect(out.globals).toBe(globals);
  });

  it("stores undefined into each dynamic global first, in its owner only, and types it as the carrier", () => {
    const init = fn("init", [marker]);
    const other = fn("other", [marker]);
    const globals = [
      global("a", { kind: "dynamic" }, "init"),
      global("n", f64, "init"),
      global("b", { kind: "dynamic" }, "init"),
    ];
    const out = legalizeDynamicGlobals([init, other], globals);
    expect(out.functions[1]).toBe(other);
    const instrs = out.functions[0]!.blocks[0]!.instrs;
    expect(instrs.map((instr) => instr.kind)).toEqual(["intrinsic", "global.set", "global.set", "const"]);
    expect(instrs[0]).toMatchObject({ id: "js.value.undefined", args: [], result: 3 });
    expect(instrs.slice(1, 3)).toMatchObject([
      { target: { name: "a" }, value: 3 },
      { target: { name: "b" }, value: 3 },
    ]);
    expect(out.functions[0]!.valueCount).toBe(4);
    expect(out.globals.map((row) => row.binding.type)).toEqual([
      { kind: "val", val: { kind: "externref" } },
      f64,
      { kind: "val", val: { kind: "externref" } },
    ]);
  });
});
