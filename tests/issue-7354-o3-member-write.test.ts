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
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";
import { runPrepared, yieldToRpc } from "./helpers/prepared-node-agreement.js";

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
    // (#7354 F1, D4) Object.prototype's other keys are writable data properties: a write creates an own property.
  ])("refuses %s by name", async (_label, source, reason) => {
    expect(await refusal(source)).toContain(reason);
  });

  // (#7354 M2) In a program that reads a caught value the error kind is admitted. The realm's error has no property
  // storage, so (#7354 C2, C2-D1) a write whose receiver is that error ends at the run-time abort, and the write's other
  // kinds answer: these refused at compile time before C2.
  it.each([
    ["a nullish write", "function f(v) { try { v.x = 1; } catch (e) { return e.name; } return 1; } var r = f(null);"],
    [
      "a strict write to a primitive",
      '"use strict"; function f(v) { try { v.x = 1; } catch (e) { return e.name; } return 1; } var r = f(1);',
    ],
  ])(
    "throws the TypeError for %s in a program that reads a caught value",
    async (_label, source) => {
      const asserting = (name: string) => `${source} if (r !== "${name}") throw 1;`;
      expect(() => new Function(asserting("TypeError"))()).not.toThrow();
      expect(await runPrepared(asserting("TypeError"))).toBe("returned");
      expect(await runPrepared(asserting("RangeError"))).toBe("threw");
    },
    180_000,
  );
});

// (#7354 F1b) The adapter's unit harness (kernel answers forged per call) is gone: what OrdinarySet answers for an own,
// an inherited and an absent property, and for a read-only one, is proven by source programs
// (tests/issue-7354-f1b-function-objects.test.ts, the member writes above); its traps are reachable from none.
