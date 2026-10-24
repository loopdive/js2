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

const OPTIONS = {
  fileName: "issue-7118-intrinsics.js",
  allowJs: true,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
  scriptGoal: true,
  deferTopLevelInit: true,
  trackIrOutcomes: true,
} as const;

async function run(target: "standalone" | undefined, source: string): Promise<{ claimed: boolean }> {
  const result = await compile(source, { ...OPTIONS, ...(target ? { target } : {}) });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  const init = (result.irOutcomes ?? []).find((o) => o.displayName === "<module-init>");
  return { claimed: init?.irBodyEmitted === true };
}

// Each source throws unless the intrinsic read answers exactly as node does.
const CASES: Record<string, string> = {
  typeofCtor: `if (typeof Object !== "function") { throw "#1"; } if (typeof RangeError !== "function") { throw "#2"; }`,
  sameIdentity: `if (TypeError !== TypeError) { throw "#5"; } if (TypeError === RangeError) { throw "#6"; }`,
};

describe("#7118 — ambient intrinsics as IR values", () => {
  for (const [name, source] of Object.entries(CASES)) {
    it(`node agrees: ${name}`, () => {
      expect(() => new Function(source)()).not.toThrow();
    });
    for (const target of ["standalone", undefined] as const) {
      it(`${name} claims <module-init> and runs (${target ?? "gc"})`, async () => {
        const { claimed } = await run(target, source);
        expect(claimed).toBe(true);
      });
    }
  }

  // (#7123) A member read off an intrinsic stays on the legacy path: through
  // the IR's dynamic read these answered differently from legacy and node
  // (legacy seeds no runtime companion for syntactic `<Builtin>.prototype.<m>`).
  const MEMBER_READS: Record<string, string> = {
    protoMethod: `if (typeof Error.prototype.toString !== "function") { throw "#7"; }`,
    protoConstructor: `if (TypeError.prototype.constructor !== TypeError) { throw "#8"; }`,
    inheritedCall: `if (typeof TypeError.call !== "function") { throw "#9"; }`,
    functionProto: `if (typeof Function.prototype !== "function") { throw "#10"; }`,
    nameRead: `if (TypeError.name !== "TypeError") { throw "#3"; } if (Error.name !== "Error") { throw "#4"; }`,
  };
  for (const [name, source] of Object.entries(MEMBER_READS)) {
    it(`node agrees: ${name}`, () => {
      expect(() => new Function(source)()).not.toThrow();
    });
    for (const target of ["standalone", undefined] as const) {
      it(`${name} stays legacy and answers as node does (${target ?? "gc"})`, async () => {
        const { claimed } = await run(target, source);
        expect(claimed).toBe(false);
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
    for (const target of ["standalone", undefined] as const) {
      it(`seeded ${name} claims <module-init> and runs (${target ?? "gc"})`, async () => {
        const { claimed } = await run(target, source);
        expect(claimed).toBe(true);
      });
    }
  }
  // …while the shapes legacy or the IR still answer wrongly stay refused.
  const SEEDED_REFUSED: Record<string, string> = {
    protoConstructor: `if (TypeError.prototype.constructor !== TypeError) { throw "#16"; }`,
    inheritedCall: `if (typeof TypeError.call !== "function") { throw "#17"; }`,
    functionProto: `if (typeof Function.prototype !== "function") { throw "#18"; }`,
    dataMember: `if (Error.prototype.message !== "") { throw "#19"; }`,
  };
  for (const [name, body] of Object.entries(SEEDED_REFUSED)) {
    for (const target of ["standalone", undefined] as const) {
      it(`seeded ${name} stays legacy and answers as node does (${target ?? "gc"})`, async () => {
        const { claimed } = await run(target, SEEDED + body);
        expect(claimed).toBe(false);
      });
    }
  }

  for (const target of ["standalone", undefined] as const) {
    it(`a failing intrinsic check still throws from the IR body (${target ?? "gc"})`, async () => {
      await expect(run(target, `if (typeof Object !== "object") { throw "#neg"; }`)).rejects.toThrow();
    });
  }

  it("leaves a user declaration with an intrinsic's name to its own binding", async () => {
    // A module-level `function Error(a, b)` is NOT the realm's `Error`
    // (builtin Error.length is 1); the lib-only check keeps it off this arm.
    const source = `function Error(a, b) { return a; }\nexport function probe() { return Error.length; }`;
    for (const target of ["standalone", undefined] as const) {
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
    }
  });
});
