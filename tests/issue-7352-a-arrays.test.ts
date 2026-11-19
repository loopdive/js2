// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7352 arrays (lane S13) — arrays on the Prepared whole-program path. An array literal is an Array exotic object
// of the realm (`js.object.create-array`, then `js.object.set-index` per element); a typed element read is
// `js.object.get-index` and `.length` is the kernel's own-property arm under `js.object.get`
// (`src/runtime/wasmgc/values/array-exotic-bodies.ts`). Every program runs twice: as written (node's answer,
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
    name: "the A1 proving program: a function-local literal, an index read and .length",
    body: "function f(){ var a = [1, 2, 3]; return a[1] + a.length; }",
    answers: ["5", "6"],
  },
  {
    name: "every index of the literal reads its own element",
    body: "function f(){ var a = [1, 2, 3]; return a[0] * 100 + a[2] * 10 + a[1]; }",
    answers: ["132", "123"],
  },
  {
    name: "an empty literal has length 0 (no vec element type to infer)",
    body: "function f(){ var a = []; return a.length; }",
    answers: ["0", "1"],
  },
  {
    name: "string and nested-array elements are stored, and the length counts them",
    body: 'function f(){ var a = ["x", [1, 2], "y"]; return a.length; }',
    answers: ["3", "2"],
  },
];

describe("#7352 arrays — array literals are Array exotic objects of the realm", () => {
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

  // Each refusal names the slice that removes it (the plan in the #7352 issue file).
  it("refuses what the later slices build, by name", async () => {
    // A2: a script var's literal into the dynamic home.
    expect(await refusal("var a = [1, 2]; if (a[0] !== 1) throw 1;")).toContain(
      "proven dynamic binding 'a' initializer has no supported carrier",
    );
    // A2: an array reaching a dynamic slot (here P's unannotated result).
    expect(await refusal("function f(){ var a = [1, 2]; return a; } f();")).toContain(
      "concrete return needs a dynamic box in f",
    );
    // A2: an element write.
    expect(await refusal("function f(){ var a = [1, 2]; a[0] = 3; return a[0]; } f();")).toContain(
      "element store on externref not in IR scope",
    );
    // A2: a read outside the literal (the prototype walk of a miss).
    expect(await refusal("function f(){ var a = [1, 2]; return a[5]; } f();")).toContain(
      "element access on externref with index",
    );
    // A2: a hole makes the binding's reads unplanned, so `.length` meets the untyped member read.
    expect(await refusal("function f(){ var a = [1, , 3]; return a.length; } f();")).toContain(
      "box of a non-primitive value has no Prepared intrinsic",
    );
    // Spread needs the iteration protocol.
    expect(await refusal("function f(b){ var a = [1, ...b]; return 0; } f([]);")).toContain(
      "array literal spread needs the iteration protocol",
    );
  }, 120_000);
});
