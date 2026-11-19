// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice C — function objects on the Prepared path: `this`, `new F()`, `instanceof`, properties of a
// function. A function value is the source closure struct; `this` is the receiver the dispatcher installs.
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

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

/** Compile a script through the strict Prepared entry; no direct generator may run. */
async function strict(source: string) {
  for (const spy of [vi.spyOn(gc, "generateModule"), vi.spyOn(linear, "generateLinearModule")])
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

describe("#7354 C — `this` on the Prepared path", () => {
  it("binds `this` only in a body that reads it", async () => {
    // A body without `this` gets no receiver read at entry, which would refuse (below).
    expect(await run("function f(a) { return a; } if (f(1) !== 1) throw 1;")).toBe("returned");
  });

  // `this` is `js.function.this`, the receiver a closure dispatcher installs; a direct call installs none.
  it("refuses a direct call of a function that reads its `this`", async () => {
    const result = messages(await strict('var g = function () {}; function f() { "use strict"; return this; } f();'));
    expect(result.join("\n")).not.toContain("'this' reference outside an instance method body");
    expect(result).toContain("a direct call of f installs no receiver for its 'this'");
  }, 60_000);

  it("refuses `this` in a program without a closure invocation", async () => {
    expect(messages(await strict('"use strict"; function f() { return this; }')).join("\n")).toContain(
      "js.function.this needs a closure invocation, and the program has none",
    );
  });
});

/** Node returns on `right` and throws on `wrong`, and so does the Prepared entry. */
async function expectAgrees(right: string, wrong: string) {
  for (const [source, answer] of [
    [right, "returned"],
    [wrong, "threw"],
  ] as const) {
    let node: string;
    try {
      new Function(source)();
      node = "returned";
    } catch {
      node = "threw";
    }
    expect(node).toBe(answer);
    expect(await run(source)).toBe(answer);
  }
}

describe("#7354 C — `new` and `instanceof` on a function value", () => {
  // Each program pulls in the native realm (~20 s per compile).
  const SLOW = 120_000;
  it.each([
    [
      "`new F()` of a script var, then `o instanceof F`",
      "var F = function () {}; var o = new F(); if (!(o instanceof F)) throw 1;",
      "var F = function () {}; var o = new F(); if (o instanceof F) throw 1;",
    ],
    [
      "`instanceof` of another function",
      "var F = function () {}; var G = function () {}; if (new F() instanceof G) throw 1;",
      "var F = function () {}; var G = function () {}; if (!(new F() instanceof G)) throw 1;",
    ],
    [
      "`new` with arguments",
      "var F = function (a, b) {}; if (!(new F(1, 2) instanceof F)) throw 1;",
      "var F = function (a, b) {}; if (new F(1, 2) instanceof F) throw 1;",
    ],
    [
      "`new` of a parameter",
      "function t(fn) { return new fn(); } if (t(function () {}) === undefined) throw 1;",
      "function t(fn) { return new fn(); } if (t(function () {}) !== undefined) throw 1;",
    ],
    [
      "a member read of a function value (its bag)",
      "function t(fn) { return fn.x; } if (t(function () {}) !== undefined) throw 1;",
      "function t(fn) { return fn.x; } if (t(function () {}) === undefined) throw 1;",
    ],
    [
      "a thrown function value",
      "var f = function () {}; try { throw f; } catch (e) { if (e !== f) throw 1; }",
      "var f = function () {}; try { throw f; } catch (e) { if (e === f) throw 1; }",
    ],
  ])("%s", async (_, right, wrong) => expectAgrees(right, wrong), SLOW);

  it.each([
    [
      "a function's own `length`: the receiver may be a string, whose `length` the realm lacks",
      "var f = function (a, b) {}; if (f.length !== 2) throw 1;",
      "dynamic operation member read 'length' of a string needs its wrapper prototype has no Prepared intrinsic",
    ],
    [
      "`o.constructor`: a key Object.prototype holds",
      "var F = function () {}; var o = new F(); if (o.constructor !== F) throw 1;",
      "dynamic operation member read 'constructor' of a string needs its wrapper prototype has no Prepared intrinsic",
    ],
    [
      "a key Function.prototype holds",
      "function t(fn) { return fn.call; } t(function () {});",
      "dynamic operation member read 'call' needs Function.prototype's properties has no Prepared intrinsic",
    ],
    [
      "`typeof` of a function value (its kind test is #7354 Fa × Ty's `js.value.is_function`)",
      'var f = function () {}; if (typeof f !== "function") throw 1;',
      "dynamic operation kind test of a function value has no Prepared intrinsic",
    ],
  ])("refuses %s by name", async (_, program, message) => {
    expect(messages(await strict(program))).toContain(message);
  });
});

describe("#7354 C — the function kind of the dynamic value", () => {
  it("answers `typeof` of a function value as the chain's last kind", async () => {
    const program = (answer: string) => `var f = function () {}; var t = typeof f; if (t !== "${answer}") throw 1;`;
    expect(await run(program("function"))).toBe("returned");
    expect(await run(program("object"))).toBe("threw");
  }, 120_000); // two programs that pull in the native realm (~20 s each to compile)

  it("keeps a program without function values off the function kind", async () => {
    expect(await run('function g(v) { return "" + v; } if (g(1) !== "1") throw 1;')).toBe("returned");
    expect(await run('function g(v) { return typeof v === "function"; } if (g(1)) throw 1;')).toBe("returned");
  });
});

describe("#7354 C — objects and function values in one program", () => {
  // The object kind's test is the complement of the other kinds, and the function kind has none yet; a value that may
  // be either is ToPrimitive'd through Get and Call, which are not built.
  it.each([
    [
      "`+` on a value that may be an object or a function",
      'var o = { a: 1 }; var f = function () {}; var s = "" + o;',
      "+ on a function value",
    ],
    [
      "the object kind's test",
      'var o = { a: 1 }; var f = function () {}; var b = typeof o === "object";',
      "kind test of a function value",
    ],
  ])("refuses %s by name", async (_, program, message) => {
    expect(messages(await strict(program))).toContain(`dynamic operation ${message} has no Prepared intrinsic`);
  });
});
