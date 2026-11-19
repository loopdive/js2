// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice Fb — a call through a dynamic value on the Prepared whole-program path. On the native standalone lane
// every operand is the externref carrier and the call is one `js.closure.call:N`, whose native dispatcher reaches any
// source closure of the program (each has the all-dynamic signature of slice Fa) and throws the TypeError for a value
// that is not callable.
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

afterEach(() => vi.restoreAllMocks());

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);
/**
 * The script's own `var print` collides with lib.dom's `declare function print` (#7287): the checker reports the
 * duplicate and types the calls by the lib declaration. Those diagnostics do not stop the compile.
 */
const LIB_PRINT =
  /^(Duplicate identifier 'print'\.|Expected 0 arguments, but got 1\.|This comparison appears to be unintentional because the types 'void' and 'number' have no overlap\.)$/;

/** A closure pulls in the native realm, whose emission takes tens of seconds on a loaded box. */
const SLOW = 240_000;

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
  expect(messages(result).filter((message) => !LIB_PRINT.test(message))).toEqual([]);
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

function node(source: string): "returned" | "threw" {
  try {
    new Function(source)();
    return "returned";
  } catch {
    return "threw";
  }
}

async function refusal(source: string, target: "standalone" | "gc" = "standalone") {
  const result = await compile(source, options(target));
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

describe("#7354 Fb — calls through a dynamic value", () => {
  // Each program runs twice: with node's answer (returns) and with a wrong one (throws). Node agrees with the first.
  it.each([
    [
      "through an untyped parameter",
      "function t(fn) { return fn(2); }",
      "t(function (x) { return x * 2; }) !== 4",
      "t(function (x) { return x * 2; }) !== 5",
    ],
    [
      "with a missing and an extra argument",
      "function a(fn) { return fn(); } function b(fn) { return fn(1, 2); } var id = function (x) { return x; };",
      "a(id) !== undefined || b(id) !== 1",
      "b(id) !== 2",
    ],
    [
      "through a script var from another function, and after a second store",
      "var f = function (a) { return a; }; function h() { return f(1); } var one = h(); f = function (a) { return 2; };",
      "one !== 1 || h() !== 2",
      "h() !== 1",
    ],
    [
      "of a callback that calls its own argument",
      "function t(fn, g) { return fn(g); }",
      "t(function (h) { return h(4); }, function (y) { return y; }) !== 4",
      "t(function (h) { return h(4); }, function (y) { return y; }) !== 5",
    ],
    [
      "on a value that is not callable: a catchable TypeError",
      "function t(fn) { try { fn(2); } catch (e) { return 7; } return 1; } var g = function () {};",
      "t(3) !== 7 || t(undefined) !== 7 || t(g) !== 1",
      "t(g) !== 7",
    ],
    [
      "with effects in argument order, each call once",
      "var k = 0; function t(fn) { fn(); fn(); return k; }",
      "t(function () { k = k + 1; }) !== 2",
      "t(function () { k = k + 1; }) !== 4",
    ],
  ])(
    "calls a function value %s",
    async (_, program, holds, fails) => {
      const right = `${program} if (${holds}) throw 1;`;
      expect(node(right)).toBe("returned");
      expect(await run(right)).toBe("returned");
      expect(await run(`${program} if (${fails}) throw 1;`)).toBe("threw");
    },
    SLOW,
  );

  // What Fb leaves to its neighbours, pinned by name.
  it.each([
    // Without any source closure the program has no dispatcher to reach.
    [
      "a call in a program with no function value",
      "function t(fn) { try { fn(2); } catch (e) { return 7; } return 1; } t(3);",
      "intrinsic callable js.closure.call:1 needs runtime function materialization",
    ],
    [
      "a spread call",
      "function t(fn) { return fn(...[1]); } t(function (x) { return x; });",
      "optional/spread dynamic value call is unsupported",
    ],
    // Function objects (slice C).
    // (#7354 C) `new` on a value is `js.function.construct:N` now: tests/issue-7354-c-function-objects.test.ts.
    [
      "a method call on a value",
      "function t(o) { return o.m(1); } t(1);",
      "dynamic operation __ir_dyn_method_call_1 has no Prepared intrinsic",
    ],
    [
      "`fn.call`",
      "function t(fn) { return fn.call(null, 1); } t(function (x) { return x; });",
      "dynamic method .call/2 has no brand-dispatch wrapper",
    ],
  ])("refuses %s by name", async (_, program, message) => {
    expect(await refusal(program)).toContain(message);
  });
});
