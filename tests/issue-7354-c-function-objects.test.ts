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

  it("binds a body's own `this` at entry, so the next gap is the receiver read itself", async () => {
    const result = messages(await strict('"use strict"; function f() { return this; } f();'));
    expect(result.join("\n")).not.toContain("'this' reference outside an instance method body");
    expect(result).toContain("dynamic operation dyn.current_this has no Prepared intrinsic");
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
