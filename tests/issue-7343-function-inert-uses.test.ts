// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7343) A `Function` value in an inert position is not dynamic code. Both
// places that ask "can this mention run code" read ONE predicate
// (`src/shared/function-mention.ts`): dead-binding elision, where a site keeps
// an unused `eval` shim alive, and the runtime-eval boundary plan, where a site
// is an `intrinsic-value` site that links the runtime-eval provider.
import { describe, expect, it } from "vitest";
import { elideDeadTopLevelBindings } from "../src/deadcode-elide.js";
import { analyzeSource } from "../src/checker/index.js";
import { createTypeOracle } from "../src/checker/oracle-backend.js";
import { buildIrRuntimeEvalBoundaryPlan } from "../src/ir/runtime-eval-boundary-plan.js";
import { ts } from "../src/ts-api.js";

/** A dead binding that only a dynamic-code position keeps alive (the test262 `$262.evalScript` shape). */
const SHIM = "var deadShim = function (s) { return eval(s); };\n";

const INERT: Record<string, string> = {
  "instanceof right operand": "var o = {}; var r = o instanceof Function;",
  "strict equality operand": "var f = function () {}; var r = f === Function;",
  "loose inequality operand": "var f = function () {}; var r = Function != f;",
  "typeof operand": "var r = typeof Function;",
  "Object.isSealed": "var r = Object.isSealed(Function);",
  "Object.isFrozen": "var r = Object.isFrozen(Function);",
  "Object.isExtensible": "var r = Object.isExtensible(Function.prototype);",
  "Object.getPrototypeOf of Function.prototype": "var r = Object.getPrototypeOf(Function.prototype);",
  "Object.getOwnPropertyDescriptor, literal key": 'var d = Object.getOwnPropertyDescriptor(Function, "prototype");',
  "Object.getOwnPropertyDescriptor of Function.prototype":
    'var d = Object.getOwnPropertyDescriptor(Function.prototype, "call");',
  "Object.defineProperty statement":
    'Object.defineProperty(Function.prototype, "prop", { value: 1, configurable: true });',
  "prototype method chain": "var call = Function.prototype.call;",
};

/** Acceptance criterion 3: each stays a dynamic-code site. */
const SITES: Record<string, string> = {
  "Function.call": 'var f = Function.call(this, "return 1;");',
  "Function.apply": 'var f = Function.apply(this, ["return 1;"]);',
  "Function.prototype.constructor": "var C = Function.prototype.constructor;",
  "stored value": "var F = Function;",
  "shadowed Object": "var Object = { isSealed: function (x) { return x; } }; var r = Object.isSealed(Function);",
  "shadowed Function": "var r = Object.isSealed(Function); function Function() {}",
  "Object.getPrototypeOf of Function": "var r = Object.getPrototypeOf(Function);",
};

/**
 * Each keeps the elision pre-pass's site; the boundary plan excuses a bare `Function.prototype` value
 * before and after this issue (`isBareFunctionPrototypeValue`: its `.constructor` is served by the
 * self-contained `%Function%` arm), so there it is not an `intrinsic-value` site on main either.
 */
const PROTOTYPE_VALUE_SITES: Record<string, string> = {
  'descriptor of "constructor"': 'var d = Object.getOwnPropertyDescriptor(Function.prototype, "constructor");',
  "Object.defineProperty as a value": 'var r = Object.defineProperty(Function.prototype, "prop", { value: 1 });',
  "computed key": 'var k = "call"; var d = Object.getOwnPropertyDescriptor(Function.prototype, k);',
};

/** Whether the elision pre-pass keeps the dead shim, i.e. it saw a dynamic-code position. */
function keepsShim(body: string): boolean {
  return !elideDeadTopLevelBindings(SHIM + body, ts.ScriptKind.JS).elided.includes("deadShim");
}

/** Whether the runtime-eval boundary plan records an `intrinsic-value` site for `Function`. */
function boundarySite(body: string): boolean {
  const { sourceFile, checker } = analyzeSource(body, "issue-7343.js", {
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  return buildIrRuntimeEvalBoundaryPlan([sourceFile], createTypeOracle(checker)).sites.some(
    (site) => site.kind === "intrinsic-value" && site.intrinsicName === "Function",
  );
}

describe("#7343 — a Function value in an inert position is not dynamic code", () => {
  for (const [name, body] of Object.entries(INERT)) {
    it(`inert: ${name}`, () => {
      expect(keepsShim(body)).toBe(false);
      expect(boundarySite(body)).toBe(false);
    });
  }

  for (const [name, body] of Object.entries(SITES)) {
    it(`stays a site: ${name}`, () => {
      expect(keepsShim(body)).toBe(true);
      expect(boundarySite(body)).toBe(true);
    });
  }

  for (const [name, body] of Object.entries(PROTOTYPE_VALUE_SITES)) {
    it(`stays an elision site: ${name}`, () => {
      expect(keepsShim(body)).toBe(true);
      expect(boundarySite(body)).toBe(false);
    });
  }
});
