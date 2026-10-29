// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7189 — a static method read off an ambient namespace intrinsic as a plain
// VALUE (`var __isArray = Array.isArray`, the propertyHelper.js prelude) is a
// realm read in an IR body: `dyn.member_get` off the #7118 intrinsic value.
// Calls (`Object.getPrototypeOf(x)`) and every other member read stay on the
// legacy path.

import { describe, expect, it } from "vitest";

import { intrinsicUseVerdicts, lane, runModuleInit, TARGETS, type Target } from "./helpers/ambient-intrinsic-probe.js";

const run = (target: Target, source: string, experimentalIR = true) =>
  runModuleInit(target, source, { fileName: "issue-7189-namespace-members.js", experimentalIR });

const STATIC_METHODS: Record<string, Record<string, number>> = {
  Array: { isArray: 1, from: 1, of: 0 },
  Object: {
    defineProperty: 3,
    defineProperties: 2,
    getOwnPropertyDescriptor: 2,
    getOwnPropertyNames: 1,
    getPrototypeOf: 1,
    setPrototypeOf: 2,
    keys: 1,
    values: 1,
    entries: 1,
    assign: 2,
    is: 2,
    hasOwn: 2,
    isExtensible: 1,
    preventExtensions: 1,
    seal: 1,
    isSealed: 1,
    freeze: 1,
    isFrozen: 1,
  },
};

// Each source throws unless the value answers exactly as node does: typeof,
// `name`, `length`, and identity across two reads and against a sibling.
const CLAIMING: Record<string, string> = Object.fromEntries(
  Object.entries(STATIC_METHODS).flatMap(([ns, methods]) =>
    Object.entries(methods).map(([method, length]) => [
      `${ns}.${method}`,
      `var f = ${ns}.${method}; var g = ${ns}.${method};
       if (typeof f !== "function") { throw "#typeof"; }
       if (f.name !== "${method}") { throw "#name"; }
       if (f.length !== ${length}) { throw "#length"; }
       if (f !== g) { throw "#identity"; }
       if (f === ${ns === "Array" ? "Object.keys" : "Array.isArray"}) { throw "#sibling"; }`,
    ]),
  ),
);
// The propertyHelper.js prelude's static half. `__getOwnPropertyDescriptor` and
// `__getOwnPropertyNames` are left out: either global name alone
// (`var __getOwnPropertyNames = 1`) already fails the module-init build on
// main — it collides with the runtime helper of the same name (recorded in the
// #7189 issue, not fixed here).
CLAIMING.propertyHelperPrelude = `var __isArray = Array.isArray;
var __defineProperty = Object.defineProperty;
if (typeof __isArray !== "function" || __defineProperty.length !== 3) { throw "#prelude"; }`;

// Refused shapes: a call (legacy's type-directed static arm; the dynamic route
// answers `Object.getPrototypeOf(1)` wrongly), a further read, an unmeasured
// or absent member, a write, and a static read through an alias.
const REFUSED: Record<string, string> = {
  primitiveCall: `if (Object.getPrototypeOf(1) !== Number.prototype) { throw "#1"; }`,
  stringCall: `if (Object.getPrototypeOf("a") !== String.prototype) { throw "#2"; }`,
  nullProtoCall: `var o = Object.create(null); if (Object.getPrototypeOf(o) !== null) { throw "#3"; }`,
  functionCall: `if (Object.getPrototypeOf(function () {}) !== Function.prototype) { throw "#4"; }`,
  isArrayCall: `if (Array.isArray(1) !== false) { throw "#5"; }`,
  furtherRead: `if (Object.keys.length !== 1) { throw "#6"; }`,
  absentMember: `if (typeof Object.nope !== "undefined") { throw "#7"; }`,
  unmeasured: `if (typeof Object.groupBy !== "function") { throw "#8"; }`,
  legacyWrongLength: `var f = Object.create; if (typeof f !== "function") { throw "#11"; }`,
  write: `var saved = Object.keys; Object.keys = saved; if (Object.keys !== saved) { throw "#9"; }`,
  viaAlias: `var O = Object; if (typeof O.keys !== "function") { throw "#10"; }`,
};

describe("#7189 — static method values off ambient namespace intrinsics", () => {
  for (const [name, source] of Object.entries(CLAIMING)) {
    it(`node agrees: ${name}`, () => {
      expect(() => new Function(source)()).not.toThrow();
    });
    // gc is the native-first lane, projected as standalone (#7118 claims there too).
    for (const target of TARGETS) {
      it(`${name} claims <module-init> with no errors and runs (${lane(target)})`, async () => {
        expect(await run(target, source)).toEqual({ claimed: true, threw: false });
      });
      it(`${name} answers as legacy (${lane(target)}, IR off)`, async () => {
        expect(await run(target, source, false)).toEqual({ claimed: false, threw: false });
      });
    }
  }

  for (const [name, source] of Object.entries(REFUSED)) {
    it(`node agrees: ${name}`, () => {
      expect(() => new Function(source)()).not.toThrow();
    });
    for (const target of TARGETS) {
      it(`${name} stays legacy and answers as node does (${lane(target)})`, async () => {
        expect(await run(target, source)).toEqual({ claimed: false, threw: false });
      });
    }
  }

  // The predicate itself: only the plain value read of a listed static method
  // admits; a call, a further read and every write form — destructuring and a
  // for-of head included — refuse.
  describe("isAmbientIntrinsicValueUse on static-method reads", () => {
    it("admits a listed static method read as a plain value", () => {
      expect(intrinsicUseVerdicts(`var f = Array.isArray; var g = (Array).from;`, "Array")).toEqual([true, true]);
    });
    it.each([
      ["a call", `Array.isArray(1);`],
      ["a further read", `var n = Array.isArray.length;`],
      ["an unlisted member", `var f = Array.fromAsync;`],
      ["an assignment target", `Array.isArray = null;`],
      ["an array destructuring target", `[Array.isArray] = [1];`],
      ["an object destructuring target", `({ a: Array.of } = { a: 1 });`],
      ["a for-of head", `for (Array.from of []) {}`],
      ["a delete operand", `delete Array.isArray;`],
      ["a numeric unary operand", `var n = -Array.isArray;`],
    ])("refuses %s", (_label, source) => {
      expect(intrinsicUseVerdicts(source, "Array")).toEqual([false]);
    });
  });

  // A failing check still throws from the IR body.
  it("a failing static-value check throws from the IR body (standalone)", async () => {
    expect(await run("standalone", `var f = Array.isArray; if (f.name !== "from") { throw "#neg"; }`)).toEqual({
      claimed: true,
      threw: true,
    });
  });
});
