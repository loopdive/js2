// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4200) Standalone `<Builtin>.prototype.constructor` — the own `constructor`
 * data property of a builtin prototype, on BOTH the value-read arm and the
 * gOPD descriptor-synthesis arm.
 *
 * Every `expect(...).toBe(13)` / `toBe(1)` case below is RED on the unpatched
 * base (the descriptor is `undefined` / the read is `undefined`). The
 * cross-check and decline cases are green on BOTH — they are what proves the
 * identity is a genuine `ref.eq` on distinct singletons rather than a
 * `null === null` tautology, and that the arm declines rather than inventing a
 * carrier for builtins that have none.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `body` as a standalone module and run its exported `f()`. */
async function runStandalone(body: string): Promise<number> {
  const result = await compile(`export function f(): number {\n${body}\n}`, { target: "standalone" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors.map((e) => e.message).join(" | ")}`);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { f: () => number }).f();
}

/**
 * Encode `gOPD(<C>.prototype, "constructor")` as one integer so the assertion
 * never depends on string concatenation — concatenating a descriptor field
 * traps on standalone and would mask the real answer.
 *   -1 = no descriptor; else bit0 writable, bit1 enumerable, bit2 configurable,
 *   bit3 `desc.value === <C>.prototype.constructor`.
 */
const descriptorProbe = (ctor: string): string => `
  var d: any = Object.getOwnPropertyDescriptor(${ctor}.prototype, "constructor");
  if (d === undefined) return -1;
  var n: number = 0;
  if (d.writable === true) n = n + 1;
  if (d.enumerable === true) n = n + 2;
  if (d.configurable === true) n = n + 4;
  var direct: any = ${ctor}.prototype.constructor;
  if (d.value === direct) n = n + 8;
  return n;`;

/** §6.1.7.3 `{writable:true, enumerable:false, configurable:true}` + value identity. */
const SPEC_CONSTRUCTOR_DESCRIPTOR = 13;

// The builtins that carry an identity-stable constructor object standalone:
// the #2907 namespace carriers plus the #3006 ctor-identity singletons.
const CARRIER_BUILTINS = [
  "Object",
  "Array",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "RegExp",
] as const;

describe("#4200 standalone <Builtin>.prototype.constructor", () => {
  describe("gOPD synthesis returns the spec data descriptor", () => {
    for (const ctor of CARRIER_BUILTINS) {
      it(`gOPD(${ctor}.prototype, "constructor") is {w:true,e:false,c:true} with the right value`, async () => {
        expect(await runStandalone(descriptorProbe(ctor))).toBe(SPEC_CONSTRUCTOR_DESCRIPTOR);
      });
    }
  });

  describe("the value read resolves to the bare-identifier singleton", () => {
    for (const ctor of CARRIER_BUILTINS) {
      it(`${ctor}.prototype.constructor === ${ctor}`, async () => {
        expect(
          await runStandalone(`
  var read: any = ${ctor}.prototype.constructor;
  var bare: any = ${ctor};
  return read === bare ? 1 : 0;`),
        ).toBe(1);
      });
    }
  });

  describe("the identity is genuine, not a null-equals-null tautology", () => {
    it("Error.prototype.constructor !== TypeError (distinct singletons)", async () => {
      expect(
        await runStandalone(`
  var a: any = Error.prototype.constructor;
  var b: any = TypeError;
  return a === b ? 1 : 0;`),
      ).toBe(0);
    });

    it("Object.prototype.constructor !== Array (distinct singletons)", async () => {
      expect(
        await runStandalone(`
  var a: any = Object.prototype.constructor;
  var b: any = Array;
  return a === b ? 1 : 0;`),
      ).toBe(0);
    });

    it("the constructor is not enumerable, so it stays out of Object.keys", async () => {
      expect(
        await runStandalone(`
  var d: any = Object.getOwnPropertyDescriptor(Error.prototype, "constructor");
  return d.enumerable === false ? 1 : 0;`),
      ).toBe(1);
    });
  });

  describe("scope guards — shapes that must keep declining", () => {
    // No identity-stable carrier exists for these, and minting one would change
    // what the BARE identifier reads. They keep today's `undefined`.
    for (const ctor of ["Date", "String", "Number", "Boolean", "Function"]) {
      it(`gOPD(${ctor}.prototype, "constructor") still declines (no carrier)`, async () => {
        expect(await runStandalone(descriptorProbe(ctor))).toBe(-1);
      });
    }

    it("a user binding that shadows the builtin keeps its own constructor", async () => {
      expect(
        await runStandalone(`
  var Error: any = { prototype: { constructor: 42 } };
  return Error.prototype.constructor === 42 ? 1 : 0;`),
      ).toBe(1);
    });
  });

  describe("preconditions — green on BOTH base and branch", () => {
    // An INSTANCE read already resolved to the ctor singleton before this
    // change. It is the control that makes this a builtin-PROTOTYPE member
    // gap rather than a missing-carrier bug: a fixture built only on the
    // instance form would have passed on unpatched main and proved nothing.
    it("new Error().constructor === Error (already worked)", async () => {
      expect(
        await runStandalone(`
  var e: any = new Error();
  var bare: any = Error;
  return e.constructor === bare ? 1 : 0;`),
      ).toBe(1);
    });

    // A member that IS in the brand's method CSV keeps its existing
    // descriptor — this arm must not disturb the #2885 Site-2 synthesis.
    it("gOPD(Array.prototype, 'indexOf') keeps its method descriptor", async () => {
      expect(
        await runStandalone(`
  var d: any = Object.getOwnPropertyDescriptor(Array.prototype, "indexOf");
  if (d === undefined) return -1;
  var n: number = 0;
  if (d.writable === true) n = n + 1;
  if (d.enumerable === true) n = n + 2;
  if (d.configurable === true) n = n + 4;
  if (d.value !== undefined) n = n + 8;
  return n;`),
      ).toBe(SPEC_CONSTRUCTOR_DESCRIPTOR);
    });
  });
});
