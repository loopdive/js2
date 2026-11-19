// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 — one exception tag. The native realm's builtin-object kernel throws its errors under the program's own
// `__exn` tag, the one source `throw` and `catch` use, so a source `catch` catches a realm TypeError. A catch that
// only binds or rethrows the caught value is admitted; one that reads it still refuses by name, because no carrier
// kind holds an error yet (pinned in issue-7354-o4-member-read.test.ts). Every program runs twice: node's answer
// (returns) and a wrong one (throws).
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const options = (emitWat = false): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat,
    fileName: "test.js",
    allowJs: true,
  }) as Test262CompileOptions;

afterEach(() => vi.restoreAllMocks());

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

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
  expect(result.success).toBe(true);
  expect(requiredPreparedEmission(result)).toBeDefined();
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
    return "returned";
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return "threw";
  }
}

/** Each program is run as written (node's answer) and with `!==` turned into `===` (a wrong answer). */
const PROGRAMS: readonly [string, string][] = [
  [
    "a caught TypeError of a nullish member read",
    "var o; var t = 0; try { o.x; } catch (e) { t = 1; } if (t !== 1) throw 1;",
  ],
  [
    "a TypeError caught in the function that reads the member",
    "function f(v) { try { return v.x; } catch (e) { return 2; } } if (f(null) !== 2) throw 1;",
  ],
  [
    "a rethrown TypeError caught by the outer catch",
    "var o = null; var t = 0; try { try { o.x; } catch (e) { throw e; } } catch (e) { t = 1; } if (t !== 1) throw 1;",
  ],
];

describe("#7354 — the realm and the source throw under one exception tag", () => {
  for (const [name, source] of PROGRAMS) {
    it(
      name,
      async () => {
        const wrong = source.replace("!==", "===");
        expect(() => new Function(source)()).not.toThrow();
        expect(() => new Function(wrong)()).toThrow();
        expect(await run(source)).toBe("returned");
        expect(await run(wrong)).toBe("threw");
      },
      180_000,
    );
  }

  it("lets a rethrown TypeError escape the program, as node does", async () => {
    const source = "var o; try { o.x; } catch (e) { throw e; }";
    expect(() => new Function(source)()).toThrow(TypeError);
    expect(await run(source)).toBe("threw");
  }, 180_000);

  it("gives a realm program one tag, `__exn`, and throws every error under it", async () => {
    const result = await compile("var o = { a: 1 }; if (o.a !== 1) throw 1;", options(true));
    expect(messages(result)).toEqual([]);
    const wat = result.wat ?? "";
    expect(wat.match(/\(tag [^\n]*/g)).toEqual(["(tag $__exn (type 0))"]);
    expect(new Set(wat.match(/\bthrow \S+/g))).toEqual(new Set(["throw 0"]));
  }, 180_000);
});
