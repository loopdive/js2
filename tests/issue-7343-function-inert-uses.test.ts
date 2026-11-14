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
import { compile } from "../src/index.js";
import { createTypeOracle } from "../src/checker/oracle-backend.js";
import { buildIrRuntimeEvalBoundaryPlan } from "../src/ir/runtime-eval-boundary-plan.js";
import { ts } from "../src/ts-api.js";

/** A dead binding that only a dynamic-code position keeps alive (the test262 `$262.evalScript` shape). */
const SHIM = "var deadShim = function (s) { return eval(s); };\n";

const INERT: Record<string, string> = {
  "instanceof right operand": "var o = {}; var r = o instanceof Function;",
  "typeof operand": "var r = typeof Function;",
  "Object.isSealed": "var r = Object.isSealed(Function);",
  "Object.isFrozen": "var r = Object.isFrozen(Function);",
  "Object.isExtensible": "var r = Object.isExtensible(Function.prototype);",
  "Object.getPrototypeOf of Function.prototype": "var r = Object.getPrototypeOf(Function.prototype);",
  // The descriptor pairs that hold neither `%Function%` nor `%Function.prototype%` (function-mention.ts).
  'descriptor of Function "length"': 'var d = Object.getOwnPropertyDescriptor(Function, "length");',
  'descriptor of Function "name"': 'var d = Object.getOwnPropertyDescriptor(Function, "name");',
  "descriptor of a key Function does not own": 'var d = Object.getOwnPropertyDescriptor(Function, "zz");',
  'descriptor of Function.prototype "call"': 'var d = Object.getOwnPropertyDescriptor(Function.prototype, "call");',
  'descriptor of Function.prototype "apply"': 'var d = Object.getOwnPropertyDescriptor(Function.prototype, "apply");',
  'descriptor of Function.prototype "bind"': 'var d = Object.getOwnPropertyDescriptor(Function.prototype, "bind");',
  'descriptor of Function.prototype "toString"':
    'var d = Object.getOwnPropertyDescriptor(Function.prototype, "toString");',
  'descriptor of Function.prototype "length"': 'var d = Object.getOwnPropertyDescriptor(Function.prototype, "length");',
  "Object.defineProperty statement on Function.prototype":
    'Object.defineProperty(Function.prototype, "prop", { value: 1, configurable: true });',
  "Object.defineProperty statement on Function":
    'Object.defineProperty(Function, "prop", { value: 1, configurable: true });',
  "prototype method chain": "var call = Function.prototype.call;",
  "delete of a Function.prototype member": "delete Function.prototype.xq;",
};

/** Acceptance criterion 3: each stays a dynamic-code site. */
const SITES: Record<string, string> = {
  "Function.call": 'var f = Function.call(this, "return 1;");',
  "Function.apply": 'var f = Function.apply(this, ["return 1;"]);',
  "Function.prototype.constructor": "var C = Function.prototype.constructor;",
  "stored value": "var F = Function;",
  // An equality compares identities: only the provider-linked module keeps ONE `%Function%` (#4442).
  "strict equality operand": "var f = function () {}; var r = f.constructor === Function;",
  "loose inequality operand": "var f = function () {}; var r = Function != f;",
  "shadowed Object": "var Object = { isSealed: function (x) { return x; } }; var r = Object.isSealed(Function);",
  "shadowed Function": "var r = Object.isSealed(Function); function Function() {}",
  "Object.getPrototypeOf of Function": "var r = Object.getPrototypeOf(Function);",
  // Review B1 (PR #7231): a descriptor whose value is `%Function.prototype%` reaches `%Function%`.
  'descriptor of Function "prototype", value\'s constructor called':
    'var P = Object.getOwnPropertyDescriptor(Function, "prototype").value; var f = P.constructor("return 7;");',
  'descriptor of Function "prototype", constructor read':
    'var d = Object.getOwnPropertyDescriptor(Function, "prototype"); var g = d.value.constructor;',
  'descriptor of Function.prototype "constructor"':
    'var d = Object.getOwnPropertyDescriptor(Function.prototype, "constructor");',
  "Object.defineProperty as a value": 'var r = Object.defineProperty(Function.prototype, "prop", { value: 1 });',
  "computed key": 'var k = "call"; var d = Object.getOwnPropertyDescriptor(Function.prototype, k);',
  // Review S2: the bare `Function.prototype` value is a site for both readers now.
  "bare Function.prototype value": "var P = Function.prototype;",
  // Review S1: a written `Object` or static may hand `%Function%` to the program's own code.
  "Object reassigned": "Object = { isSealed: function (F) { return F; } }; var r = Object.isSealed(Function);",
  "static assigned": "Object.isSealed = function (F) { return F; }; var r = Object.isSealed(Function);",
  "static assigned through globalThis":
    "globalThis.Object.isSealed = function (F) { return F; }; var r = Object.isSealed(Function);",
  "getOwnPropertyDescriptor assigned":
    'Object.getOwnPropertyDescriptor = function (F) { return { value: F }; }; var d = Object.getOwnPropertyDescriptor(Function, "length");',
  "static assigned through an alias":
    'var O = Object; O["isFrozen"] = function (F) { return F; }; var r = Object.isFrozen(Function);',
  "static defined":
    'Object.defineProperty(Object, "isSealed", { value: function (F) { return F; } }); var r = Object.isSealed(Function);',
  "with statement": "with ({}) { var r = Object.isSealed(Function); }",
};

/**
 * The known limit of the store arms (#7343 review round 2, PR #7231): a store into `Function.prototype.<k>` and a
 * discarded `Object.defineProperty` statement are inert, as on main, so they can place `%Function%` under another key
 * with no site, and a later inert read hands it out. Harmless ONLY while a function value's inherited `.constructor`
 * cannot evaluate source (`FN_CONSTRUCTOR_EVALUATES` below). Follow-up: #7343 "Follow-ups" (receiver-aware written-key
 * sets in `src/shared/intrinsic-prototype-writes.ts`).
 */
const INERT_TODAY_KNOWN_LIMIT: Record<string, string> = {
  "store of a function's constructor": "Function.prototype.xq = (function () {}).constructor;",
  "define of a function's constructor":
    'Object.defineProperty(Function.prototype, "yq", { value: (function () {}).constructor });',
  "store, then a descriptor read of the stored key":
    'Function.prototype.xq = (function () {}).constructor; var d = Object.getOwnPropertyDescriptor(Function.prototype, "xq");',
};

/**
 * The known limit of the `Object` write screen (`objectStaticIsPristine`), the #3776 boundary the object statics
 * share: a write under a COMPUTED name is not seen, so the static still counts as the realm's. A literal-named write
 * through an alias is seen.
 */
const OBJECT_WRITE_SCREEN: Record<string, { readonly body: string; readonly inert: boolean }> = {
  "computed-name write (not seen: #3776 boundary)": {
    body: 'Object["is" + "Sealed"] = function (F) { return F; }; var r = Object.isSealed(Function);',
    inert: true,
  },
  "alias write under a literal name (seen)": {
    body: "var O = Object; O.isSealed = function (F) { return F; }; var r = Object.isSealed(Function);",
    inert: false,
  },
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

  for (const [name, body] of Object.entries(INERT_TODAY_KNOWN_LIMIT)) {
    it(`inert today, known limit: ${name}`, () => {
      expect(keepsShim(body)).toBe(false);
      expect(boundarySite(body)).toBe(false);
    });
  }

  for (const [name, { body, inert }] of Object.entries(OBJECT_WRITE_SCREEN)) {
    it(`Object write screen: ${name}`, () => {
      expect(keepsShim(body)).toBe(!inert);
      expect(boundarySite(body)).toBe(!inert);
    });
  }
});

/**
 * The dependency the known limit rests on. A function value's inherited `.constructor` is `%Function%` in the
 * language, but this compiler cannot evaluate source through it: the call throws, and no `js2wasm:runtime-eval`
 * import is linked. IF THIS ROW EVER STARTS ANSWERING 1 (the source ran), stores into `Function` /
 * `Function.prototype` must become sites (#7343, "Follow-ups"), or `INERT_TODAY_KNOWN_LIMIT` hands out `%Function%`.
 */
describe("#7343 — FN_CONSTRUCTOR_EVALUATES: a function's inherited constructor cannot evaluate source today", () => {
  const source = `var r = 0;
try { var v = (function () {}).constructor("return 7;")(); r = v === 7 ? 1 : 2; } catch (e) { r = 3; }
export function probe() { return r; }`;
  for (const target of ["standalone", undefined] as const) {
    it(`${target ?? "default"} target: the call throws (3), with no runtime-eval import`, async () => {
      const result = await compile(source, {
        fileName: "probe.js",
        allowJs: true,
        skipSemanticDiagnostics: true,
        ...(target ? { target } : {}),
      });
      expect(result.success).toBe(true);
      const modules = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((entry) => entry.module);
      expect(modules).not.toContain("js2wasm:runtime-eval");
      const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
      (instance.exports.__module_init as (() => void) | undefined)?.();
      expect((instance.exports.probe as () => number)()).toBe(3);
    }, 60_000);
  }
});
