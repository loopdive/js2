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
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { buildSourceObjectGetDefinition } from "../src/runtime/wasmgc/values/source-object-bodies.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";
import { yieldToRpc } from "./helpers/prepared-node-agreement.js";

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
  await yieldToRpc();
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

/**
 * The name the path refuses `source` by. (#7354 U) Compiled without abort bodies: under them a refusal inside a
 * function becomes that function's abort body, and these cases are about the name of the refusal.
 */
async function refusal(source: string): Promise<string> {
  const result = await compile(source, options(), undefined, "refuse");
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
    // The resolver and the lowering ask one key fold (`shared/property-key-fold.ts`).
    name: "a literal computed key is the member's static name",
    body: "function f(){ var o = { ['a']: 3 }; return o.a; }",
    answers: ["3", "4"],
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

  // A program without a catch binding reads no thrown payload, so an object may be thrown: uncaught, it escapes start.
  it("an uncaught thrown object escapes start", async () => {
    const program = (thrown: boolean) =>
      `function f(){ if (${thrown ? "2 > 1" : "1 > 2"}) throw { a: 1 }; return 1; } f();`;
    expect(await run(program(false))).toBe("returned");
    expect(await run(program(true))).toBe("threw");
  }, 120_000);

  // Each refusal names the step that removes it (the slice plan in the #7354 issue file).
  it("refuses what the later steps build, by name", async () => {
    // O4 reads a script var's object (tests/issue-7354-o4-member-read.test.ts).
    // O2: an object reaching a dynamic slot (here P's unannotated result).
    expect(await refusal("function f(){ var o = { a: 1 }; return o; } f();")).toContain(
      "concrete return needs a dynamic box in f",
    );
    // O3 writes members, a function-local object's too (tests/issue-7354-o3-member-write.test.ts).
    // O4: a member read with no typed plan (here of a key the literal lacks) is a dynamic member read; (#7354 M1) it
    // is legalized without a dynamic contract too and runs (tests/issue-7354-m-member-access.test.ts).
    // A Boolean member read needs a Boolean unbox, which this presentation's policy does not offer.
    expect(await refusal("function f(){ const o = { b: true }; return o.b ? 1 : 0; } f();")).toContain(
      "semantic intrinsic js.boolean.unbox is unavailable",
    );
  }, 120_000);
});

// The kernel's [[Get]] answers (status, value): 0 absent (value `undefined`), 1 found, 2 a miss at the realm's
// Object.prototype (value `undefined`; (#7354 O4) its keys refuse at every call site), 3 not an object. The adapter
// returns the value of the first three and traps on 3 and on any status outside the four.
describe("#7354 O — the js.object.get adapter over the kernel's [[Get]]", () => {
  const ext = { kind: "externref" } as const;
  function adapter(answer: (target: unknown, key: unknown, receiver: unknown) => readonly [number, unknown]) {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const get = tx.reserveFunctionImport("kernel:get", "kernel", "get", {
      params: [ext, ext, ext],
      results: [{ kind: "i32" }, ext],
    });
    const fn = tx.reserveFunction("adapter:get", "get", { params: [ext, ext, ext], results: [ext] });
    tx.freezeReservations();
    tx.fillFunction(fn, buildSourceObjectGetDefinition({ get: get.handle }));
    tx.defineExport("export:get", "get", fn);
    tx.seal();
    const wasm = new WebAssembly.Module(emitBinary(module) as BufferSource);
    return new WebAssembly.Instance(wasm, { kernel: { get: answer } }).exports.get as (...args: unknown[]) => unknown;
  }
  const target = {},
    key = {},
    receiver = {},
    value = {};

  it.each([0, 1, 2])("returns the value of an answer (status %i), forwarding all three operands", (status) => {
    const seen: unknown[][] = [];
    const get = adapter((...args) => {
      seen.push(args);
      return [status, value];
    });
    expect(get(target, key, receiver)).toBe(value);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.map((operand, i) => operand === [target, key, receiver][i])).toEqual([true, true, true]);
  });

  it.each([3, 0x7fffffff, -1])("traps on a non-object or unknown answer (status %i)", (status) => {
    const get = adapter(() => [status, value]);
    expect(() => get(target, key, receiver)).toThrow(WebAssembly.RuntimeError);
  });
});
