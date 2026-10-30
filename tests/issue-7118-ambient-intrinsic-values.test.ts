// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7118 — an ambient intrinsic (`TypeError`, `Object`, `String`, …) read as a
// VALUE in an IR body: a named read off the realm's global object
// (`dyn.global_object` + `dyn.member_get`). Before this every such identifier
// was `expr-ident-not-in-scope`, which kept `assert.throws(TypeError, fn)` and
// friends — the most common test262 body shape — on the legacy path.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { intrinsicUseVerdicts, lane, runModuleInit, TARGETS, type Target } from "./helpers/ambient-intrinsic-probe.js";

const run = (target: Target, source: string) => runModuleInit(target, source, { fileName: "issue-7118-intrinsics.js" });

// Every name on the allowlist that claims (a bare `Function` value pulls the
// runtime-eval provider and stays legacy).
const CLAIMING_NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
];

// Each source throws unless the intrinsic read answers exactly as node does.
// Value uses only: `typeof`, identity, an alias or parameter that is itself
// only compared, a conditional branch, an argument to a member callee.
const CLAIMING: Record<string, string> = {
  sameIdentity: `if (TypeError !== TypeError) { throw "#5"; } if (TypeError === RangeError) { throw "#6"; }`,
  aliasTypeof: `var x = TypeError; if (typeof x !== "function") { throw "#20"; }`,
  aliasIdentity: `var x = TypeError; if (x !== TypeError) { throw "#21"; }`,
  parameterTypeof: `function f(c) { return typeof c; } if (f(TypeError) !== "function") { throw "#22"; }`,
  conditionalBranch: `var x = true ? TypeError : RangeError; if (x !== TypeError) { throw "#23"; }`,
  ...Object.fromEntries(
    CLAIMING_NAMES.map((name) => [`identity:${name}`, `var x = ${name}; if (x !== ${name}) { throw "#${name}"; }`]),
  ),
};

// (#7123) A member read off an intrinsic stays on the legacy path: through the
// IR's dynamic read these answered differently from legacy and node (legacy
// seeds no runtime companion for syntactic `<Builtin>.prototype.<m>`). The
// refusal follows the value through aliases (local, re-alias, conditional
// branch): a member read off the alias goes through the same chain.
const MEMBER_READS: Record<string, string> = {
  protoMethod: `if (typeof Error.prototype.toString !== "function") { throw "#7"; }`,
  protoConstructor: `if (TypeError.prototype.constructor !== TypeError) { throw "#8"; }`,
  inheritedCall: `if (typeof TypeError.call !== "function") { throw "#9"; }`,
  functionProto: `if (typeof Function.prototype !== "function") { throw "#10"; }`,
  // `.name` is a member read too, so it stays legacy with the rest (#7123).
  nameRead: `if (TypeError.name !== "TypeError") { throw "#3"; } if (Error.name !== "Error") { throw "#4"; }`,
  aliasProtoConstructor: `var C = TypeError; if (C.prototype.constructor !== C) { throw "#11"; }`,
  aliasInheritedCall: `var C = TypeError; if (typeof C.call !== "function") { throw "#12"; }`,
  aliasHasOwnProperty: `var C = Object; if (typeof C.hasOwnProperty !== "function") { throw "#13"; }`,
  aliasProtoPush: `var A = Array; if (typeof A.prototype.push !== "function") { throw "#14"; }`,
  reAlias: `var x = TypeError; var y = x; if (typeof y.call !== "function") { throw "#15"; }`,
  conditionalReceiver: `if ((true ? TypeError : RangeError).prototype.constructor !== TypeError) { throw "#16"; }`,
};

describe("#7118 — ambient intrinsics as IR values", () => {
  for (const [name, source] of Object.entries(CLAIMING)) {
    it(`node agrees: ${name}`, () => {
      expect(() => new Function(source)()).not.toThrow();
    });
    for (const target of TARGETS) {
      it(`${name} claims <module-init> and runs (${lane(target)})`, async () => {
        expect(await run(target, source)).toEqual({ claimed: true, threw: false });
      });
    }
  }

  for (const [name, source] of Object.entries(MEMBER_READS)) {
    it(`node agrees: ${name}`, () => {
      expect(() => new Function(source)()).not.toThrow();
    });
    for (const target of TARGETS) {
      it(`${name} stays legacy and answers as node does (${lane(target)})`, async () => {
        expect(await run(target, source)).toEqual({ claimed: false, threw: false });
      });
    }
  }

  // (#7127) Once the module's brand companion is seeded (here by an
  // `Object.getPrototypeOf` call in a legacy function), a
  // `<Receiver>.prototype.<method>` value read is exact through the IR and claims.
  const SEEDED = "function seed(o) { return Object.getPrototypeOf(o); }\n";
  const SEEDED_READS: Record<string, string> = {
    errorToString: `if (typeof Error.prototype.toString !== "function") { throw "#11"; }`,
    inheritedIdentity: `if (Array.prototype.hasOwnProperty !== Object.prototype.hasOwnProperty) { throw "#12"; }`,
    ownIdentity: `if (Array.prototype.toString === Object.prototype.toString) { throw "#13"; }`,
    functionCall: `if (typeof Function.prototype.call !== "function") { throw "#14"; }`,
    absentMember: `if (Number.prototype.push !== undefined) { throw "#15"; }`,
  };
  for (const [name, body] of Object.entries(SEEDED_READS)) {
    const source = SEEDED + body;
    it(`node agrees: seeded ${name}`, () => {
      expect(() => new Function(source)()).not.toThrow();
    });
    for (const target of TARGETS) {
      it(`seeded ${name} claims <module-init> and runs (${lane(target)})`, async () => {
        expect(await run(target, source)).toEqual({ claimed: true, threw: false });
      });
    }
  }
  // …while the shapes legacy or the IR still answer wrongly stay refused, as do
  // reads through an alias.
  const SEEDED_REFUSED: Record<string, string> = {
    protoConstructor: `if (TypeError.prototype.constructor !== TypeError) { throw "#16"; }`,
    inheritedCall: `if (typeof TypeError.call !== "function") { throw "#17"; }`,
    functionProto: `if (typeof Function.prototype !== "function") { throw "#18"; }`,
    dataMember: `if (Error.prototype.message !== "") { throw "#19"; }`,
    nativeError: `if (typeof RangeError.prototype.toString !== "function") { throw "#20"; }`,
    viaAlias: `var E = Error; if (typeof E.prototype.toString !== "function") { throw "#21"; }`,
  };
  for (const [name, body] of Object.entries(SEEDED_REFUSED)) {
    for (const target of TARGETS) {
      it(`seeded ${name} stays legacy and answers as node does (${lane(target)})`, async () => {
        expect(await run(target, SEEDED + body)).toEqual({ claimed: false, threw: false });
      });
    }
  }

  // An intrinsic handed to a same-file function whose parameter is a member
  // receiver stays legacy too (legacy answers this one wrong as well — a
  // pre-existing bug — but the IR must not own it).
  for (const target of TARGETS) {
    it(`a parameter that is a member receiver keeps the unit legacy (${lane(target)})`, async () => {
      const source = `function f(c) { return c.prototype.constructor === c; } if (!f(RangeError)) { throw "#17"; }`;
      expect((await run(target, source)).claimed).toBe(false);
    });
  }

  for (const target of TARGETS) {
    it(`a failing intrinsic check still throws from the IR body (${lane(target)})`, async () => {
      expect(await run(target, `if (typeof Object !== "object") { throw "#neg"; }`)).toEqual({
        claimed: true,
        threw: true,
      });
    });
  }

  it("leaves a user declaration with an intrinsic's name to its own binding", async () => {
    // A module-level `function Error(a, b)` is NOT the realm's `Error`
    // (builtin Error.length is 1). `var c = Error` is a VALUE use, so the
    // lib-only rule — not the member-read one — is what keeps it off this arm.
    const source = `function Error(a, b) { return a; }\nexport function probe() { var c = Error; return c.length; }`;
    for (const target of TARGETS) {
      const result = await compile(source, {
        fileName: "issue-7118-shadow.ts",
        skipSemanticDiagnostics: true,
        trackIrOutcomes: true,
        ...(target ? { target } : {}),
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
      (instance.exports.__module_init as (() => void) | undefined)?.();
      expect((instance.exports.probe as () => number)()).toBe(2);
      const probe = (result.irOutcomes ?? []).find((o) => o.displayName === "probe");
      expect(probe?.irBodyEmitted).toBe(false);
    }
  });

  // The admission predicate itself, against a real checker with the lib loaded.
  describe("isAmbientIntrinsicValueUse", () => {
    const intrinsicUses = (source: string): boolean[] => intrinsicUseVerdicts(source, "Error");

    it("admits a lib-only value use", () => {
      expect(intrinsicUses(`var c = Error; if (typeof c !== "function") { throw 1; }`)).toEqual([true]);
    });
    it("refuses the same use when a script declaration merges with the lib one", () => {
      expect(
        intrinsicUses(`function Error(a, b) { return a; } var c = Error; if (typeof c !== "function") { throw 1; }`),
      ).toEqual([false]);
    });
    it("refuses a member read, directly and through an alias", () => {
      expect(intrinsicUses(`var n = Error.name;`)).toEqual([false]);
      expect(intrinsicUses(`var c = Error; var n = c.name;`)).toEqual([false]);
    });
  });
});
