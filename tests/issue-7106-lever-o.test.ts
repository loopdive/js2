// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 lever O — the six ES5 integrity statics fold where their answer is
// fixed at compile time: a test of a pristine intrinsic or of a primitive is a
// constant, a mutator of a primitive literal is that literal. Each body runs
// behind the original harness on both lanes and in node, so every claimed row
// is checked against the JS answer; the refused rows stay legacy and run.

import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { compileHarnessOn, runHarnessOn } from "./helpers/harness-module-init.js";
import { lane, TARGETS } from "./helpers/ambient-intrinsic-probe.js";

/** Run `body` in a fresh node realm against a two-method `assert`, so an expectation the test states is JS's own answer. */
function runInNode(body: string): void {
  const assert = Object.assign(
    (condition: unknown) => {
      if (condition !== true) throw new Error("assert failed");
    },
    {
      sameValue(actual: unknown, expected: unknown) {
        if (!Object.is(actual, expected)) throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
      },
    },
  );
  runInNewContext(body, { assert });
}

const CLAIMED: Record<string, string> = {
  // A pristine ES5 intrinsic: extensible, neither sealed nor frozen.
  sealedIntrinsic:
    "assert.sameValue(Object.isSealed(Array), false);\nvar b = Object.isSealed(SyntaxError);\nassert.sameValue(b, false);",
  sealedPrototype: "assert.sameValue(Object.isSealed(Error.prototype), false);",
  extensibleIntrinsic:
    "var e = Object.isExtensible(Math);\nassert.sameValue(e, true);\nassert.sameValue(Object.isExtensible(JSON), true);",
  extensiblePrototype: "assert.sameValue(Object.isExtensible(String.prototype), true);",
  frozenIntrinsic: "assert.sameValue(Object.isFrozen(Number), false);",
  // A primitive (§20.1.2.12–14): frozen and sealed, not extensible.
  frozenPrimitives:
    'assert.sameValue(Object.isFrozen(0), true);\nassert.sameValue(Object.isFrozen("abc"), true);\nassert.sameValue(Object.isFrozen(null), true);\nassert.sameValue(Object.isFrozen(undefined), true);',
  sealedPrimitives:
    "assert.sameValue(Object.isSealed(true), true);\nvar s = Object.isSealed(undefined);\nassert.sameValue(s, true);",
  extensiblePrimitives:
    "assert.sameValue(Object.isExtensible(1.5), false);\nassert.sameValue(Object.isExtensible(null), false);\nvar x = Object.isExtensible('');\nassert.sameValue(x, false);",
  // A mutator of a primitive literal returns it.
  freezePrimitive: 'assert.sameValue(Object.freeze("abc"), "abc");\nassert.sameValue(Object.freeze(false), false);',
  sealPrimitive: "assert.sameValue(Object.seal(1.5), 1.5);",
  preventExtensionsPrimitive: "Object.preventExtensions(0);\nassert.sameValue(Object.preventExtensions(true), true);",
  // A mutator of a primitive does not unsettle the intrinsic fold's realm.
  literalMutatorBesideTest: "assert.sameValue(Object.freeze(7), 7);\nassert.sameValue(Object.isFrozen(7), true);",
};

// Refused at selection; legacy runs them.
const REFUSED: Record<string, string> = {
  // A mutator named anywhere: no intrinsic is known pristine.
  mutatedIntrinsic: "Object.preventExtensions(Boolean);\nassert.sameValue(Object.isExtensible(Boolean), false);",
  // A mutator's nullish operand has no IR value without its consumer's hint.
  nullishMutator: "assert.sameValue(Object.freeze(null), null);\nassert.sameValue(Object.seal(undefined), undefined);",
  // An object that is no intrinsic keeps legacy's runtime arm.
  dynamicOperand: "assert.sameValue(Object.isSealed(this), false);",
  // A source that assigns the static (here never run) may replace the builtin.
  reassignedStatic: "if (false) Object.isSealed = null;\nassert.sameValue(Object.isSealed(Array), false);",
  // Out of scope for this lever: #7294's gOPD, and the statics with no fixed answer.
  getOwnPropertyDescriptor:
    "var d = Object.getOwnPropertyDescriptor(Math, 'PI');\nassert.sameValue(d.writable, false);",
  keys: "assert.sameValue(Object.keys('ab').length, 2);",
  getPrototypeOf: "assert.sameValue(Object.getPrototypeOf(RangeError), Error);",
};

describe("#7106 lever O: ES5 integrity statics with a fixed answer", () => {
  for (const [name, body] of Object.entries({ ...CLAIMED, ...REFUSED })) {
    it(`node agrees with the stated answers: ${name}`, () => {
      runInNode(body);
    });
  }
  for (const target of TARGETS) {
    describe(lane(target), () => {
      for (const [name, body] of Object.entries(CLAIMED)) {
        it(`claims and runs: ${name}`, async () => {
          expect(await runHarnessOn(target, body)).toBe(true);
        });
      }
      it("claims and runs: a function unit", async () => {
        const body = "function f() { return Object.isSealed(Error); }\nassert.sameValue(f(), false);";
        runInNode(body);
        expect(await runHarnessOn(target, body, undefined, ["f"])).toBe(true);
      });
      it("keeps a shadowed `undefined` on legacy's runtime arm", async () => {
        const body = "function f(undefined) { return Object.isFrozen(undefined); }\nassert.sameValue(f(5), true);";
        runInNode(body);
        const result = await compileHarnessOn(target, body);
        expect(result.irOutcomes?.find((unit) => unit.displayName === "f")?.irBodyEmitted).not.toBe(true);
        await runHarnessOn(target, body);
      });
      for (const [name, body] of Object.entries(REFUSED)) {
        it(`stays legacy and runs: ${name}`, async () => {
          expect(await runHarnessOn(target, body)).toBe(false);
        });
      }
    });
  }
});
