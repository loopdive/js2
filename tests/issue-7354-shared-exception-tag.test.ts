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
import { yieldToRpc } from "./helpers/prepared-node-agreement.js";

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

/** The number of entries in the module's tag section (id 13), from the binary. */
function tagCount(bytes: Uint8Array): number {
  const leb = (at: number): [number, number] => {
    let value = 0;
    let shift = 0;
    let next = at;
    for (;;) {
      const byte = bytes[next++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) return [value, next];
    }
  };
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at]!;
    const [size, body] = leb(at + 1);
    if (id === 13) return leb(body)[0];
    at = body + size;
  }
  return 0;
}

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
  await yieldToRpc();
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

  // The realm's TypeError, thrown in one unit, is caught in another; and the module declares exactly one tag (its tag
  // section, read off the binary, holds one entry).
  it("gives a realm program one tag, and a realm error thrown in one unit is caught in another", async () => {
    const source =
      "function f(v) { return v.a; } function g() { try { f(null); return 1; } catch (e) { return 2; } }" +
      " var o = { a: 1 }; if (g() !== 2 || o.a !== 1) throw 1;";
    expect(() => new Function(source)()).not.toThrow();
    expect(await run(source)).toBe("returned");
    expect(await run(source.replace("g() !== 2", "g() === 2"))).toBe("threw");
    const result = await compile(source, options());
    expect(tagCount(result.binary!)).toBe(1);
  }, 180_000);
});
