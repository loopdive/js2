// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7189 — a static method read off an ambient namespace intrinsic as a plain
// VALUE (`var __isArray = Array.isArray`, the propertyHelper.js prelude) is a
// realm read in an IR body: `dyn.member_get` off the #7118 intrinsic value.
// Calls (`Object.getPrototypeOf(x)`) and every other member read stay on the
// legacy path.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const OPTIONS = {
  fileName: "issue-7189-namespace-members.js",
  allowJs: true,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
  scriptGoal: true,
  deferTopLevelInit: true,
  trackIrOutcomes: true,
} as const;

const TARGETS = ["standalone", undefined] as const;
const lane = (target: (typeof TARGETS)[number]): string => target ?? "gc";

interface Run {
  readonly claimed: boolean;
  readonly threw: boolean;
  readonly errors: number;
}

async function run(target: (typeof TARGETS)[number], source: string, experimentalIR = true): Promise<Run> {
  const result = await compile(source, { ...OPTIONS, experimentalIR, ...(target ? { target } : {}) });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  let threw = false;
  try {
    (instance.exports.__module_init as (() => void) | undefined)?.();
  } catch {
    threw = true;
  }
  const init = (result.irOutcomes ?? []).find((o) => o.displayName === "<module-init>");
  return { claimed: init?.irBodyEmitted === true, threw, errors: result.errors.length };
}

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
    it(`${name} claims <module-init> with no errors and runs (standalone)`, async () => {
      expect(await run("standalone", source)).toEqual({ claimed: true, threw: false, errors: 0 });
    });
    it(`${name} answers as legacy (standalone, IR off)`, async () => {
      expect(await run("standalone", source, false)).toEqual({ claimed: false, threw: false, errors: 0 });
    });
    it(`${name} answers as node (gc)`, async () => {
      expect((await run(undefined, source)).threw).toBe(false);
    });
  }

  for (const [name, source] of Object.entries(REFUSED)) {
    it(`node agrees: ${name}`, () => {
      expect(() => new Function(source)()).not.toThrow();
    });
    for (const target of TARGETS) {
      it(`${name} stays legacy and answers as node does (${lane(target)})`, async () => {
        expect(await run(target, source)).toEqual({ claimed: false, threw: false, errors: 0 });
      });
    }
  }

  // A failing check still throws from the IR body.
  it("a failing static-value check throws from the IR body (standalone)", async () => {
    expect(await run("standalone", `var f = Array.isArray; if (f.name !== "from") { throw "#neg"; }`)).toEqual({
      claimed: true,
      threw: true,
      errors: 0,
    });
  });
});
