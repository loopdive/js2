// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice O, step O3 — a member write of a dynamic value with a constant key (`MEMBER_ACCESS_ARM` in
// src/ir/program/dynamic-value-kinds.ts, `dynamicMemberWrite` in dynamic-member-access.ts): an object writes through
// the realm's OrdinarySet (`js.object.set`), `undefined` / `null` throw a TypeError, a primitive's write fails, which
// sloppy code ignores and strict code throws for. A computed key or an Object.prototype key refuses by name; (#7354
// O2b) a write that throws in a program that catches traps. Every run program runs twice: node's answer (returns) and
// a wrong one (throws).
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { buildSourceObjectSetDefinition } from "../src/runtime/wasmgc/values/source-object-bodies.js";
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

/** Each program is run as written (node's answer) and with `!==` turned into `===` (a wrong answer). */
const PROGRAMS: readonly [string, string][] = [
  [
    "the O3 proving program: a new member beside a literal's",
    "var o = { a: 1 }; o.b = 2; if (o.a + o.b !== 3) throw 1;",
  ],
  ["an own member overwritten", "var o = { a: 1 }; o.a = 2; if (o.a !== 2) throw 1;"],
  ["a member added to an empty object, then read", "var o = {}; o.k = 'x'; if (o.k + 'y' !== 'xy') throw 1;"],
  ["a write through an unannotated parameter", "function s(v){ v.k = 3; } var o = {}; s(o); if (o.k !== 3) throw 1;"],
  ["a nested object's member", "var o = { a: { b: 1 } }; o.a.b = 2; if (o.a.b !== 2) throw 1;"],
  // The written binding has no typed read plan (`prepare-ordinary-object-access.ts`), so the read sees the write.
  [
    "a function-local object's written member reads the write, not the initializer",
    "function f(){ var o = { a: 1 }; o.a = 2; return o.a; } if (f() !== 2) throw 1;",
  ],
  // A primitive's [[Set]] fails; sloppy code ignores it, and the primitive keeps no member.
  [
    "a sloppy write to a primitive is ignored",
    "function s(v){ v.k = 3; return v.k; } if (s(1) !== undefined) throw 1;",
  ],
];

describe("#7354 O3 — a member write of the dynamic value", () => {
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

  it.each([
    ["to undefined", "function s(v){ v.x = 1; } s(undefined);"],
    ["to null in strict code", '"use strict"; function s(v){ v.x = 1; } s(null);'],
    ["to a primitive in strict code", '"use strict"; function s(v){ v.k = 3; } s(1);'],
  ])(
    "throws for a write %s, as node does",
    async (_label, source) => {
      expect(() => new Function(source)()).toThrow(TypeError);
      expect(await run(source)).toBe("threw");
    },
    180_000,
  );

  it.each([
    ["a computed key", 'var o = { a: 1 }; var k = "a"; o[k] = 2;', "dyn.member_set with a computed key"],
    [
      "an Object.prototype key",
      "function s(v){ v.isPrototypeOf = 1; } s({});",
      "member write 'isPrototypeOf' needs Object.prototype's properties",
    ],
  ])("refuses %s by name", async (_label, source, reason) => {
    expect(await refusal(source)).toContain(reason);
  });

  // (#7354 O2b) These writes used to refuse by name ("… in a program that catches"). The legalization's TypeError now
  // comes from one helper (`typeError`, dynamic-realm-calls.ts): in a program that catches, the realm's TypeError is
  // not yet catchable from source code, so the program fails loudly (`js.object.uncatchable-type-error`) where node's
  // catch answers 0. That is a failure, not node's answer, and never a wrong one. A write that does not throw still
  // runs: the object write answers 1, as node does.
  it.each([
    ["a nullish write", "function f(v) { try { v.x = 1; } catch (e) { return 0; } return 1; } var r = f(null);", 0],
    [
      "a strict write to a primitive",
      '"use strict"; function f(v) { try { v.x = 1; } catch (e) { return 0; } return 1; } var r = f(1);',
      0,
    ],
  ])(
    "traps for %s in a program that catches",
    async (_label, source, answer) => {
      expect(new Function(`${source} return r;`)()).toBe(answer);
      const result = await compile(source, options());
      expect(requiredPreparedEmission(result)).toBeDefined();
      expect(() => (instantiatePreparedArtifact(result).instance.exports.__module_init as () => void)()).toThrow(
        WebAssembly.RuntimeError,
      );
    },
    180_000,
  );
});

// The kernel's lookup answers (status, entry): 0 absent, 1 found, 2 a miss at the realm's Object.prototype, 3 not an
// object. The adapter defines a writable data property's or a missing one's value on the receiver (CreateDataProperty,
// mask 191) and answers true; a found accessor or read-only property, and status 3, trap.
describe("#7354 O3 — the js.object.set adapter over the kernel's lookup", () => {
  const ext = { kind: "externref" } as const;
  const i32 = { kind: "i32" } as const;
  function adapter(answer: (object: unknown, key: unknown) => readonly [number, number]) {
    const defined: unknown[][] = [];
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const entry = tx.reserveType("entry", {
      kind: "struct",
      name: "entry",
      fields: [
        { name: "key", type: ext, mutable: false },
        { name: "value", type: ext, mutable: true },
        { name: "flags", type: i32, mutable: true },
      ],
    });
    const probe = tx.reserveFunctionImport("kernel:probe", "kernel", "probe", {
      params: [ext, ext],
      results: [i32, i32],
    });
    const define = tx.reserveFunctionImport("descriptors:define", "kernel", "define", {
      params: [ext, ext, ext, { kind: "f64" }],
      results: [],
    });
    const entryRef = { kind: "ref_null", typeIdx: entry.typeIndex } as const;
    const lookup = tx.reserveFunction("kernel:lookup", "lookup", { params: [ext, ext], results: [i32, entryRef] });
    const fn = tx.reserveFunction("adapter:set", "set", { params: [ext, ext, ext, ext], results: [i32] });
    tx.freezeReservations();
    // (status, flags) from the probe; an entry carries the flags only for status 1.
    tx.fillFunction(lookup, {
      locals: [
        { name: "status", type: i32 },
        { name: "flags", type: i32 },
      ],
      body: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: probe.handle },
        { op: "local.set", index: 3 },
        { op: "local.tee", index: 2 },
        { op: "local.get", index: 2 },
        { op: "i32.const", value: 1 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: entryRef },
          then: [
            { op: "ref.null.extern" },
            { op: "ref.null.extern" },
            { op: "local.get", index: 3 },
            { op: "struct.new", typeIdx: entry.typeIndex },
          ],
          else: [{ op: "ref.null", typeIdx: entry.typeIndex }],
        },
      ],
    });
    tx.fillFunction(
      fn,
      buildSourceObjectSetDefinition({
        entryTypeIdx: entry.typeIndex,
        lookup: lookup.handle,
        defineData: define.handle,
      }),
    );
    tx.defineExport("export:set", "set", fn);
    tx.seal();
    const wasm = new WebAssembly.Module(emitBinary(module) as BufferSource);
    const set = new WebAssembly.Instance(wasm, {
      kernel: { probe: answer, define: (...args: unknown[]) => void defined.push(args) },
    }).exports.set as (...args: unknown[]) => unknown;
    return { set, defined };
  }
  const object = {},
    key = {},
    value = {},
    receiver = {};

  it.each([
    ["absent (status 0)", 0, 0],
    ["a miss at Object.prototype (status 2)", 2, 0],
    ["a writable data property (status 1)", 1, 1 | 2 | 4],
  ])("defines the value on the receiver for %s and answers true", (_label, status, flags) => {
    const seen: unknown[][] = [];
    const { set, defined } = adapter((...args) => {
      seen.push(args);
      return [status, flags];
    });
    expect(set(object, key, value, receiver)).toBe(1);
    expect(seen.map((args) => args.map((operand, i) => operand === [object, key][i]))).toEqual([[true, true]]);
    expect(defined).toHaveLength(1);
    expect(defined[0]!.map((operand, i) => operand === [receiver, key, value][i] || operand)).toEqual([
      true,
      true,
      true,
      191,
    ]);
  });

  it.each([
    ["a read-only data property", 1, 2 | 4],
    ["an accessor", 1, 8 | 1],
    ["a non-object (status 3)", 3, 0],
    ["an unknown status", 0x7fffffff, 0],
  ])("traps on %s", (_label, status, flags) => {
    const { set, defined } = adapter(() => [status, flags]);
    expect(() => set(object, key, value, receiver)).toThrow(WebAssembly.RuntimeError);
    expect(defined).toHaveLength(0);
  });
});
