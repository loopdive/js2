// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7118 — an ambient intrinsic (`TypeError`, `Object`, `String`, …) read as a
// VALUE in an IR body: a named read off the realm's global object
// (`dyn.global_object` + `dyn.member_get`). Before this every such identifier
// was `expr-ident-not-in-scope`, which kept `assert.throws(TypeError, fn)` and
// friends — the most common test262 body shape — on the legacy path.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { makeIrAmbientBindingPredicate } from "../src/ir/module-bindings.js";
import { isAmbientIntrinsicValueUse } from "../src/shared/ambient-intrinsics.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

const OPTIONS = {
  fileName: "issue-7118-intrinsics.js",
  allowJs: true,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
  scriptGoal: true,
  deferTopLevelInit: true,
  trackIrOutcomes: true,
} as const;

const TARGETS = ["standalone", undefined] as const;
const lane = (target: (typeof TARGETS)[number]): string => target ?? "gc";

async function run(target: (typeof TARGETS)[number], source: string): Promise<{ claimed: boolean; threw: boolean }> {
  const result = await compile(source, { ...OPTIONS, ...(target ? { target } : {}) });
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
  return { claimed: init?.irBodyEmitted === true, threw };
}

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
    function intrinsicUses(source: string): boolean[] {
      const fileName = "/issue-7118-predicate.js";
      const options: ts.CompilerOptions = { allowJs: true, target: ts.ScriptTarget.ES2022, noResolve: true };
      const sourceFile = ts.createSourceFile(fileName, source, options.target!, true, ts.ScriptKind.JS);
      const host = ts.createCompilerHost(options, true);
      const { fileExists, readFile, getSourceFile } = host;
      host.fileExists = (name) => name === fileName || fileExists.call(host, name);
      host.readFile = (name) => (name === fileName ? source : readFile.call(host, name));
      host.getSourceFile = (name, ...rest) =>
        name === fileName ? sourceFile : getSourceFile.call(host, name, ...rest);
      host.writeFile = () => {};
      const checker = ts.createProgram([fileName], options, host).getTypeChecker();
      const libOnly = makeIrAmbientBindingPredicate(checker, "every");
      const verdicts: boolean[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === "Error" && !ts.isFunctionDeclaration(node.parent)) {
          verdicts.push(isAmbientIntrinsicValueUse(node, libOnly));
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      return verdicts;
    }

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
