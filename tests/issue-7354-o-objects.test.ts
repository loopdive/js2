// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice O — objects on the Prepared whole-program path. An object literal is an ordinary object of the realm
// (`js.object.create-default` on the realm's Object.prototype, one `js.object.define-data` per member) and a typed
// member read is `js.object.get`; each contract binds the realm function that serves it
// (`src/backend/wasmgc/resources/native-source-objects.ts`). Every program runs twice: as written (node's answer,
// returns) and with a wrong answer (throws).
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

/** Compile through the strict Prepared entry, run the top-level code and report whether it threw. */
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

async function refusal(source: string): Promise<string> {
  const result = await compile(source, options());
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

/** `check(answer)` is the program's own test of its result; node's answer is the first of `answers`. */
const PROGRAMS: readonly { name: string; body: string; answers: readonly [string, string] }[] = [
  {
    name: "the O1 proving program: a function-local var literal and a read",
    body: "function f(){ var o = { a: 1 }; return o.a; }",
    answers: ["1", "2"],
  },
  {
    name: "several members, read in source order and out of it",
    body: "function f(){ const o = { a: 1, b: 2, c: 4 }; return o.c * 100 + o.a * 10 + o.b; }",
    answers: ["412", "421"],
  },
  {
    name: "a shorthand member and a member computed from a local",
    body: "function f(){ var n = 3; var o = { n, b: n * 2 }; return o.b - o.n; }",
    answers: ["3", "6"],
  },
  {
    name: "a member named like an Object.prototype method reads the own member",
    body: "function f(){ var o = { valueOf: 5 }; return o.valueOf; }",
    answers: ["5", "0"],
  },
];

describe("#7354 O — object literals are ordinary objects of the realm", () => {
  for (const { name, body, answers } of PROGRAMS) {
    it(
      name,
      async () => {
        const [right, wrong] = answers;
        expect(new Function(`${body} return f();`)()).toBe(Number(right));
        expect(await run(`${body} if (f() !== ${right}) throw 1;`)).toBe("returned");
        expect(await run(`${body} if (f() !== ${wrong}) throw 1;`)).toBe("threw");
      },
      120_000,
    );
  }

  // Each refusal names the step that removes it (the slice plan in the #7354 issue file).
  it("refuses what the later steps build, by name", async () => {
    // O2: a script var's literal into the dynamic home.
    expect(await refusal("var o = { a: 1 }; if (o.a !== 1) throw 1;")).toContain(
      "proven dynamic binding 'o' initializer has no supported carrier",
    );
    // O2: an object reaching a dynamic slot (here P's unannotated result).
    expect(await refusal("function f(){ var o = { a: 1 }; return o; } f();")).toContain(
      "concrete return needs a dynamic box in f",
    );
    // O3: a member write.
    expect(await refusal("function f(){ var o = { a: 1 }; o.a = 2; return o.a; } f();")).toContain(
      "property assignment on externref is not in slice 4",
    );
    // A Boolean member read needs a Boolean unbox, which this presentation's policy does not offer.
    expect(await refusal("function f(){ const o = { b: true }; return o.b ? 1 : 0; } f();")).toContain(
      "semantic intrinsic js.boolean.unbox is unavailable",
    );
  }, 120_000);
});
