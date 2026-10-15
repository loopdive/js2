// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// L is independently testable as an analysis patch. The three retained runtime
// witnesses require J's conditional join as well; their correct expectations
// intentionally remain 1 on pristine B, where the producer is still defective.
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { TsCheckerOracle } from "../src/checker/oracle.js";
import { UsageInference } from "../src/checker/usage-inference.js";
import {
  analyzeNumericPropertyNames,
  applyNumericPropertyAnalysis,
  refineNumericLocalsWithCallReturns,
  type NumericPropertyAnalysisHost,
  type NumericPropertyAnalysisTarget,
} from "../src/codegen/numeric-property-analysis.js";
import { compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";

function proofFor(source: string, hostOverride?: NumericPropertyAnalysisHost) {
  const { sourceFile, checker } = analyzeSource(source, "issue-6878-local-proof.ts");
  const oracle = new TsCheckerOracle(checker);
  const host = hostOverride ?? { oracle };
  const verdicts = analyzeNumericPropertyNames(host, [sourceFile]);
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const declaration = (name: string, occurrence = 0): ts.VariableDeclaration => {
    const result = declarations.filter((node) => ts.isIdentifier(node.name) && node.name.text === name)[occurrence];
    if (!result) throw new Error(`missing declaration ${name}[${occurrence}]`);
    return result;
  };
  return {
    sourceFile,
    checker,
    host,
    oracle,
    verdicts,
    declaration,
    numeric: (name: string, occurrence = 0) => verdicts.isNumericLocal(declaration(name, occurrence).name, name),
  };
}

describe("#6878 local Number proof — independently of conditional code generation", () => {
  it.each([
    "x ? 37 : false",
    "x ? true : 0",
    "x ? NaN : false",
    "x ? true : -0",
    "x && 37",
    "37 || false",
    "true ?? 0",
    "(x ? false : 37) as number",
    "(x ? 0 : true)!",
    "(0, false)",
    "!x",
    "x === 0",
    "delete object.flag",
    "x ? 37 : undefined",
    "x ? null : 37",
  ])("declines the possibly non-Number definition %s", (expression) => {
    const proof = proofFor(`function f(x: any, object: any) { const value: any = ${expression}; return value; }`);
    expect(proof.numeric("value")).toBe(false);
  });

  it.each(["const", "let", "var"])("declines a mixed %s and its alias", (kind) => {
    const proof = proofFor(
      `function f(x: number) { ${kind} value: unknown = x ? false : 37; const alias = value; return alias; }`,
    );
    expect(proof.numeric("value")).toBe(false);
    expect(proof.numeric("alias")).toBe(false);
  });

  it("withdraws a numeric initializer when a later definition can be Boolean", () => {
    const proof = proofFor(`function f(x: number) { let value: any = 37; value = x ? true : 0; return value; }`);
    expect(proof.numeric("value")).toBe(false);
  });

  it("keeps exact lexical slots separate", () => {
    const proof = proofFor(`
      function numeric() { const value: any = 37; return value; }
      function mixed(x: number) { const value: any = x ? false : 37; return value; }
    `);
    expect(proof.numeric("value", 0)).toBe(true);
    expect(proof.numeric("value", 1)).toBe(false);
    expect(proof.declaration("value", 0)).not.toBe(proof.declaration("value", 1));
  });

  it("rejects a pure Boolean call without needing a conditional producer", () => {
    const proof = proofFor(
      `function predicate(): any { return false; } function f() { const value: any = predicate(); return value; }`,
    );
    expect(proof.verdicts.numericFunctions).toContain("predicate");
    expect(proof.numeric("value")).toBe(false);
  });

  it("closes explicitly-any return bodies and keeps the broad function publication", () => {
    const proof = proofFor(`
      function mixed(x: number): any { return x ? true : -0; }
      function allNumbers(x: number): any { return x ? 37 : -0; }
      function forward(): any { return mixed(0); }
      function f() { const bad: any = forward(); const good: any = allNumbers(0); return good; }
    `);
    expect(proof.numeric("bad")).toBe(false);
    expect(proof.numeric("good")).toBe(true);
    expect(proof.verdicts.numericFunctions).toContain("mixed");
    expect(proof.verdicts.numericFunctions).toContain("allNumbers");
  });

  it("resolves a shadowed callee to its own declaration", () => {
    const proof = proofFor(`
      function choose(): any { return 37; }
      function f() { function choose(): any { return false; } const bad: any = choose(); return bad; }
      function g() { const good: any = choose(); return good; }
    `);
    expect(proof.numeric("bad")).toBe(false);
    expect(proof.numeric("good")).toBe(true);
  });

  it.each([
    "function helper(x: number): any { if (x) return 37; }",
    "function helper(x: number): any { if (x) return; return 37; }",
    "function helper(x: number): any { return helper(x); }",
    "function helper(x: number): any { return other(x); } function other(x: number): any { return helper(x); }",
    "declare function helper(x: number): number;",
    "import { helper } from './unknown.js';",
    "function original(x: number): any { return 37; } const helper = original;",
    "let helper = (x: number): any => 37; helper = (x: number): any => false;",
    "function helper(x: number): any { return 37; } helper = (x: number): any => false;",
    "function helper(x: number): any { return 37; } function helper(x: number): any { return false; }",
    "async function helper(x: number): Promise<number> { return 37; }",
    "function* helper(x: number): any { return 37; }",
  ])("fails closed over incomplete, cyclic or unresolved callable %s", (helper) => {
    const proof = proofFor(`${helper} function f() { const value: any = helper(0); return value; }`);
    expect(proof.numeric("value")).toBe(false);
  });

  it("does not borrow a same-name function when declaration resolution is absent", () => {
    const proof = proofFor(
      `function helper(): any { return 37; } function f() { const value: any = helper(); return value; }`,
      { oracle: { typeFactOf: () => ({ kind: "unknown" }) } },
    );
    expect(proof.numeric("value")).toBe(false);
  });

  it.each(["Number", "parseInt", "parseFloat"])("does not treat a shadowed %s as a conversion", (name) => {
    const source = `function ${name}(): any { return false; } function f() { const value: any = ${name}(); return value; }`;
    expect(proofFor(source).numeric("value")).toBe(false);
    expect(proofFor(source, { oracle: { typeFactOf: () => ({ kind: "unknown" }) } }).numeric("value")).toBe(false);
  });

  it("does not borrow an intrinsic string/method contract from shadowed namespaces", () => {
    expect(
      proofFor(`
      function String(): any { return { charCodeAt() { return false; } }; }
      function f() { const value: any = String().charCodeAt(0); return value; }
    `).numeric("value"),
    ).toBe(false);
    expect(
      proofFor(`
      const Math = { max(): any { return false; } };
      function f() { const value: any = Math.max(); return value; }
    `).numeric("value"),
    ).toBe(false);
  });

  it.each([
    ["math-overwrite", "Math.max = () => false;", "Math.max()"],
    ["math-new-member", "Math.someNewMethod = () => false;", "Math.someNewMethod()"],
    ["math-static-key", "Math['max'] = () => false;", "Math.max()"],
    ["math-unknown-key", "declare const key: string; Math[key] = () => false;", "Math.max()"],
    ["math-delete", "delete Math.max;", "Math.max()"],
    ["math-alias", "const alias = Math; alias.max = () => false;", "Math.max()"],
    ["math-reflection", "Object.defineProperty(Math, 'max', { value: () => false });", "Math.max()"],
    ["math-global-property", "globalThis.Math.max = () => false;", "Math.max()"],
    ["math-global-static-key", "globalThis['Math'].max = () => false;", "Math.max()"],
    ["math-global-key-update", "globalThis['Math']['max'] = () => false;", "Math.max()"],
    ["math-global-unknown-key", "declare const key: string; globalThis[key].max = () => false;", "Math.max()"],
    ["math-global-alias", "const root = globalThis; root.Math.max = () => false;", "Math.max()"],
    ["math-non-callable-member", "", "Math.PI()"],
    ["math-unresolved-member", "", "Math.someNewMethod()"],
    ["math-class-shadow", "class Math { static max(): any { return false; } }", "Math.max()"],
    ["date-overwrite", "Date.now = () => false;", "Date.now()"],
    ["date-static-key", "Date['now'] = () => false;", "Date.now()"],
    ["date-unknown-key", "declare const key: string; Date[key] = () => false;", "Date.now()"],
    ["date-delete", "delete Date.now;", "Date.now()"],
    ["date-alias", "const alias = Date; alias.now = () => false;", "Date.now()"],
    ["date-global-property", "globalThis.Date.now = () => false;", "Date.now()"],
    ["date-global-static-key", "globalThis['Date'].now = () => false;", "Date.now()"],
    ["date-global-unknown-key", "declare const key: string; globalThis[key].now = () => false;", "Date.now()"],
    ["date-class-shadow", "class Date { static now(): any { return false; } }", "Date.now()"],
    ["number-global-static-key", "globalThis['Number'] = () => false;", "Number(0)"],
    [
      "string-global-static-key",
      "globalThis['String'] = () => ({ charCodeAt: () => false });",
      "String().charCodeAt(0)",
    ],
  ])("[intrinsic-%s] declines unstable or unresolved intrinsic members", (_id, setup, expression) => {
    const proof = proofFor(`${setup} function f() { const value: any = ${expression}; return value; }`);
    expect(proof.numeric("value")).toBe(false);
  });

  it("[intrinsic-positive] retains unmodified Number-returning Math and Date members", () => {
    const proof = proofFor(`
      function f() { const maximum: any = Math.max(1, 37); const now: any = Date.now(); return maximum + now; }
    `);
    expect(proof.numeric("maximum")).toBe(true);
    expect(proof.numeric("now")).toBe(true);
  });

  it("[intrinsic-member-specific] does not withdraw an untouched peer method", () => {
    const proof = proofFor(`
      Math.max = () => false;
      function f() { const value: any = Math.min(1, 37); return value; }
    `);
    expect(proof.numeric("value")).toBe(true);
  });

  it("requires complete incoming Number evidence for returned parameters", () => {
    const source = (extra: string) => `
      function helper(input: any): any { return input; }
      ${extra}
      function f() { const value: any = helper(37); return value; }
    `;
    expect(proofFor(source("")).numeric("value")).toBe(true);
    expect(proofFor(source("helper(false);")).numeric("value")).toBe(false);
    expect(proofFor(source("helper();")).numeric("value")).toBe(false);
    expect(proofFor(source("declare const unknown: any; helper(unknown);")).numeric("value")).toBe(false);
    expect(proofFor(source("const escaped = helper;")).numeric("value")).toBe(false);
    expect(proofFor(source("export { helper };")).numeric("value")).toBe(false);
  });

  it("grounds an accumulator but rejects ungrounded self and mutual cycles", () => {
    const proof = proofFor(`
      function f() {
        let sum: any = 0; sum = sum + 37; sum -= 1; ++sum;
        var self: any = self + 1;
        var left: any = right; var right: any = left;
        return sum;
      }
    `);
    expect(proof.numeric("sum")).toBe(true);
    for (const name of ["self", "left", "right"]) expect(proof.numeric(name)).toBe(false);
  });

  it.each(["-value", "~value", "value - 1n", "value * 1n", "value << 1n", "++value"])(
    "does not conflate ToNumeric with ToNumber in %s",
    (expression) => {
      const proof = proofFor(`function f() { let value: any = 1n; const result: any = ${expression}; return result; }`);
      expect(proof.numeric("value")).toBe(false);
      expect(proof.numeric("result")).toBe(false);
    },
  );

  it("retains explicit Number conversions, numeric branches, native facts and string methods", () => {
    const proof = proofFor(`
      type i32 = number;
      function f(x: any, native: { count: i32; flag: boolean }) {
        const converted: any = +(x ? false : 37);
        const explicit: any = Number(x);
        const numeric: any = x ? 37 : -0;
        const alias: any = numeric;
        const code: any = "ABC".charCodeAt(0);
        const index: any = "ABC".indexOf("B");
        const length: any = "ABC".length;
        const scalar: any = native.count;
        const boolean: any = native.flag;
        const absent: any = "ABC".codePointAt(99);
        return alias;
      }
    `);
    for (const name of ["converted", "explicit", "numeric", "alias", "code", "index", "length", "scalar"]) {
      expect(proof.numeric(name), name).toBe(true);
    }
    expect(proof.numeric("boolean")).toBe(false);
    expect(proof.numeric("absent")).toBe(false);
  });

  it("does not promote field-name votes or open/getter/Boolean reads into new Number proof", () => {
    const source = `
      function Box() { this.count = 37; this.label = "ok"; }
      function f(object: any) {
        const value: any = object.count;
        const methodValue: any = object.label.charCodeAt(0);
        return value;
      }
    `;
    const proof = proofFor(source);
    expect(proof.verdicts.numeric).toContain("count");
    expect(proof.verdicts.string).toContain("label");
    expect(proof.numeric("value")).toBe(false);
    expect(proof.numeric("methodValue")).toBe(false);
    const open = analyzeNumericPropertyNames({ ...proof.host, openWorldPropertyReads: true }, [proof.sourceFile]);
    expect(open.numeric).toEqual(proof.verdicts.numeric);
    expect(open.string).toEqual(proof.verdicts.string);
    // Root matched pristine B with both host options: publication already
    // differs here because open-world property returns do not prove numeric.
    expect(proof.verdicts.numericFunctions).toEqual(new Set(["f"]));
    expect(open.numericFunctions).toEqual(new Set());
    expect(open.isNumericLocal(proof.declaration("value").name, "value")).toBe(false);
    expect(
      proofFor(`const object = { get flag() { return false; } }; const value: any = object.flag;`).numeric("value"),
    ).toBe(false);
  });

  it("does not cache a call rejection across later grounded-slot iterations", () => {
    const proof = proofFor(`
      function f() { const result: any = helper(); const seed: any = 37; function helper(): any { return seed; } return result; }
    `);
    expect(proof.numeric("seed")).toBe(true);
    expect(proof.numeric("result")).toBe(true);
  });

  it("exhausts long call closures conservatively", () => {
    const helpers = Array.from(
      { length: 55 },
      (_, index) => `function h${index}(): any { return ${index === 54 ? "37" : `h${index + 1}()`}; }`,
    ).join("\n");
    expect(proofFor(`${helpers} const value: any = h0();`).numeric("value")).toBe(false);
  });

  it.each([
    "function f() { const value: any = 37; const read = () => value; return read(); }",
    "function f(x: number) { if (x) return value; var value: any = 37; return value; }",
  ])("[%#] keeps capture/read-before-declaration eligibility independent of Number proof", (source) => {
    const proof = proofFor(source);
    expect(proof.numeric("value")).toBe(true);
    const usageInference = new UsageInference(proof.checker);
    usageInference.setNumericLocalOracle(proof.verdicts.isNumericLocal);
    expect(usageInference.scalarForDecl(proof.declaration("value"))).toBeUndefined();
  });

  it("refreshes declaration caches on local-oracle refinement without republishing fields", () => {
    const proof = proofFor(`
      const object = { helper(): any { return "s"; } };
      function helper(): any { return 37; }
      function f() { const value: any = helper(); return value; }
    `);
    const usageInference = new UsageInference(proof.checker);
    const target: NumericPropertyAnalysisTarget = {
      numericPropertyNames: new Set(),
      stringPropertyNames: new Set(),
      numericFunctionNames: new Set(),
      usageInference,
    };
    applyNumericPropertyAnalysis(target, proof.host, [proof.sourceFile]);
    const fields = target.numericPropertyNames;
    const functions = target.numericFunctionNames;
    expect(usageInference.scalarForDecl(proof.declaration("value"))).toBeUndefined();
    // The name-keyed broad set had to withdraw helper because of object.helper.
    // Independent, stratified call evidence restores broad admission; the local
    // proof still inspects the exact visible declaration's complete return body.
    expect(refineNumericLocalsWithCallReturns(target, proof.host, [proof.sourceFile], () => true)).toBe(true);
    expect(usageInference.scalarForDecl(proof.declaration("value"))).toBe("number");
    expect(target.numericPropertyNames).toBe(fields);
    expect(target.numericFunctionNames).toBe(functions);
    usageInference.setNumericLocalOracle(() => false);
    expect(usageInference.scalarForDecl(proof.declaration("value"))).toBeUndefined();
  });
});

describe("#6878 P private String.prototype stability — analysis only", () => {
  it.each([
    ["char-code-overwrite", "String.prototype.charCodeAt = () => false;", "'ABC'.charCodeAt(0)"],
    ["index-overwrite", "String.prototype.indexOf = () => false;", "'ABC'.indexOf('B')"],
    ["member-delete", "delete String.prototype.charCodeAt;", "'ABC'.charCodeAt(0)"],
    ["static-prototype-key", "String['prototype'].charCodeAt = () => false;", "'ABC'.charCodeAt(0)"],
    ["static-member-key", "String.prototype['charCodeAt'] = () => false;", "'ABC'.charCodeAt(0)"],
    ["member-update", "String.prototype.charCodeAt++;", "'ABC'.charCodeAt(0)"],
    ["member-compound", "String.prototype.charCodeAt += 1;", "'ABC'.charCodeAt(0)"],
    ["destructuring-write", "[String.prototype.charCodeAt] = [() => false];", "'ABC'.charCodeAt(0)"],
    ["unknown-member-key", "declare const key: string; String.prototype[key] = () => false;", "'ABC'.charCodeAt(0)"],
    [
      "unknown-prototype-key",
      "declare const key: string; String[key].charCodeAt = () => false;",
      "'ABC'.charCodeAt(0)",
    ],
    [
      "prototype-alias",
      "const prototype = String.prototype; prototype.charCodeAt = () => false;",
      "'ABC'.charCodeAt(0)",
    ],
    [
      "constructor-alias",
      "const Constructor = String; Constructor.prototype.charCodeAt = () => false;",
      "'ABC'.charCodeAt(0)",
    ],
    [
      "object-reflection",
      "Object.defineProperty(String.prototype, 'charCodeAt', { value: () => false });",
      "'ABC'.charCodeAt(0)",
    ],
    [
      "reflect-reflection",
      "Reflect.defineProperty(String.prototype, 'charCodeAt', { value: () => false });",
      "'ABC'.charCodeAt(0)",
    ],
    ["object-assign", "Object.assign(String.prototype, { charCodeAt: () => false });", "'ABC'.charCodeAt(0)"],
    ["prototype-replacement", "String.prototype = { charCodeAt: () => false };", "'ABC'.charCodeAt(0)"],
    ["prototype-delete", "delete String.prototype;", "'ABC'.charCodeAt(0)"],
    ["global-property", "globalThis.String.prototype.charCodeAt = () => false;", "'ABC'.charCodeAt(0)"],
    ["global-static-key", "globalThis['String']['prototype']['charCodeAt'] = () => false;", "'ABC'.charCodeAt(0)"],
    [
      "global-unknown-key",
      "declare const key: string; globalThis[key].prototype.charCodeAt = () => false;",
      "'ABC'.charCodeAt(0)",
    ],
    ["global-alias", "const root = globalThis; root.String.prototype.charCodeAt = () => false;", "'ABC'.charCodeAt(0)"],
    ["slice-chain", "String.prototype.slice = () => ({ charCodeAt: () => false });", "'ABC'.slice(0).charCodeAt(0)"],
    [
      "concat-chain",
      "String.prototype.concat = () => ({ charCodeAt: () => false });",
      "'ABC'.concat('D').charCodeAt(0)",
    ],
    [
      "prototype-query",
      "const prototype = Object.getPrototypeOf('ABC'); prototype.charCodeAt = () => false;",
      "'ABC'.charCodeAt(0)",
    ],
    [
      "reflect-prototype-query",
      "const prototype = Reflect.getPrototypeOf(Object('ABC')); prototype.charCodeAt = () => false;",
      "'ABC'.charCodeAt(0)",
    ],
    ["legacy-prototype", "'ABC'.__proto__.charCodeAt = () => false;", "'ABC'.charCodeAt(0)"],
    ["primitive-constructor", "'ABC'.constructor.prototype.charCodeAt = () => false;", "'ABC'.charCodeAt(0)"],
    [
      "reflection-alias",
      "const reflection = Object; reflection.getPrototypeOf('ABC').charCodeAt = () => false;",
      "'ABC'.charCodeAt(0)",
    ],
    [
      "reflection-unknown-key",
      "declare const key: string; Object[key]('ABC').charCodeAt = () => false;",
      "'ABC'.charCodeAt(0)",
    ],
    [
      "prototype-alias-forwarding",
      "let alias: any; const other = String.prototype; alias = other; other.charCodeAt = () => false;",
      "'ABC'.charCodeAt(0)",
    ],
    ["constructor-reassignment", "String = () => ({ charCodeAt: () => false });", "String().charCodeAt(0)"],
  ])("[P-%s] declines an unstable string method domain", (_id, setup, expression) => {
    const proof = proofFor(`${setup} function f() { const value: any = ${expression}; return value; }`);
    expect(proof.numeric("value")).toBe(false);
  });

  it("[P-positive] retains untouched literal, String, Number, Math and Date contracts", () => {
    const proof = proofFor(`
      function typed(input: string): any { return input.charCodeAt(0); }
      function f() {
        const text = String(37);
        const code: any = 'ABC'.charCodeAt(0);
        const index: any = text.indexOf('7');
        const chain: any = 'ABC'.slice(0).concat('D').charCodeAt(0);
        const converted: any = Number(text);
        const explicit: any = +text;
        const maximum: any = Math.max(1, 37);
        const now: any = Date.now();
        const typedValue: any = typed('ABC');
        return code;
      }
    `);
    for (const name of ["code", "index", "chain", "converted", "explicit", "maximum", "now", "typedValue"]) {
      expect(proof.numeric(name), name).toBe(true);
    }
  });

  it("[P-peer] withdraws a changed member without withdrawing its untouched peer or conversion", () => {
    const proof = proofFor(`
      String.prototype.charCodeAt = () => false;
      function f() {
        const text = String(37);
        const changed: any = text.charCodeAt(0);
        const peer: any = text.indexOf('7');
        const converted: any = Number(text);
        return peer;
      }
    `);
    expect(proof.numeric("changed")).toBe(false);
    expect(proof.numeric("peer")).toBe(true);
    expect(proof.numeric("converted")).toBe(true);
  });

  it("[P-chain-peer] withdraws the changed string producer, not an independent literal method", () => {
    const proof = proofFor(`
      String.prototype.slice = () => ({ charCodeAt: () => false });
      function f() {
        const changed: any = 'ABC'.slice(0).charCodeAt(0);
        const peer: any = 'ABC'.charCodeAt(0);
        return peer;
      }
    `);
    expect(proof.numeric("changed")).toBe(false);
    expect(proof.numeric("peer")).toBe(true);
  });

  it("[P-wildcard-conversion] keeps explicit conversions while unknown prototype writes withdraw methods", () => {
    const proof = proofFor(`
      declare const key: string;
      String.prototype[key] = () => false;
      function f() {
        const text = String(37);
        const changed: any = text.charCodeAt(0);
        const converted: any = Number(text);
        const explicit: any = +text;
        return converted;
      }
    `);
    expect(proof.numeric("changed")).toBe(false);
    expect(proof.numeric("converted")).toBe(true);
    expect(proof.numeric("explicit")).toBe(true);
  });

  it.each(["unknown", "number"])(
    "[P-absent-%s] proves a closed literal without member declaration resolution",
    (kind) => {
      const proof = proofFor(`function f() { const value: any = 'ABC'.charCodeAt(0); return value; }`, {
        oracle: { typeFactOf: () => ({ kind }) },
      });
      expect(proof.numeric("value")).toBe(true);
    },
  );

  it("[P-cycle] declines cyclic primitive-string aliases without caching a provisional proof", () => {
    const proof = proofFor(`
      function f() { var left: string = right; var right: string = left;
        const value: any = left.charCodeAt(0); return value; }
    `);
    expect(proof.numeric("value")).toBe(false);
  });

  it("[P-unresolved-member] proves the actual closed all-string incoming domain without a member declaration", () => {
    const proof = proofFor(`
      function f(input: any) { const value: any = input.charCodeAt(0); return value; }
      f('ABC');
    `);
    expect(proof.numeric("value")).toBe(true);
  });

  it("[P-publication] keeps broad field, string and function publication while withdrawing the local", () => {
    const proof = proofFor(`
      String.prototype.charCodeAt = () => false;
      function Box() { this.count = 37; this.label = 'ok'; }
      function f() { const value: any = 'ABC'.charCodeAt(0); return value; }
    `);
    expect(proof.verdicts.numeric).toContain("count");
    expect(proof.verdicts.string).toContain("label");
    expect(proof.verdicts.numericFunctions).toContain("f");
    expect(proof.numeric("value")).toBe(false);
  });
});

describe("#6878 P2 primitive String and closed effects — analysis only", () => {
  it.each([
    ["legacy-getter", "String.prototype.__defineGetter__('charCodeAt', () => () => false);"],
    ["legacy-setter", "String.prototype.__defineSetter__('charCodeAt', () => {});"],
    ["unknown-prototype-call", "String.prototype.installMethod();"],
    ["binding-constructor", "const { constructor: C } = 'ABC'; C.prototype.charCodeAt = () => false;"],
    ["binding-dunder", "const { __proto__: p } = 'ABC'; p.charCodeAt = () => false;"],
    ["binding-default", "const { constructor: C = String } = 'ABC'; C.prototype.charCodeAt = () => false;"],
    [
      "binding-computed",
      "declare const key: string; const { [key]: C } = 'ABC'; C.prototype.charCodeAt = () => false;",
    ],
    ["binding-nested", "const { constructor: { prototype: p } } = 'ABC'; p.charCodeAt = () => false;"],
    ["binding-rest", "const { length, ...rest } = 'ABC'; rest.constructor.prototype.charCodeAt = () => false;"],
    ["binding-array", "const [C] = ['ABC'.constructor]; C.prototype.charCodeAt = () => false;"],
    ["assignment-constructor", "let C: any; ({ constructor: C } = 'ABC'); C.prototype.charCodeAt = () => false;"],
    ["assignment-rest", "let rest: any; ({ ...rest } = 'ABC'); rest.constructor.prototype.charCodeAt = () => false;"],
    [
      "assignment-computed",
      "let C: any; declare const key: string; ({ [key]: C } = 'ABC'); C.prototype.charCodeAt = () => false;",
    ],
    ["computed-handle", "declare const key: string; const C = 'ABC'[key]; C.prototype.charCodeAt = () => false;"],
    ["direct-eval", "eval('String.prototype.charCodeAt = () => false');"],
    ["indirect-eval", "(0, eval)('String.prototype.charCodeAt = () => false');"],
    ["function-code", "Function('String.prototype.charCodeAt = () => false')();"],
    ["opaque-constructor", "new UnknownConstructor();"],
    ["imported-effect", "import { mutate } from './unknown.js'; mutate();"],
    ["import-equals-effect", "import mutate = require('./unknown.js'); mutate();"],
    ["ambient-effect", "declare function mutate(): void; mutate();"],
    ["ambient-accessor-read", "declare const opaque: any; Boolean(opaque);"],
    ["unresolved-global-read", "opaque;"],
    ["callable-alias", "declare function mutate(): void; const alias = mutate; alias();"],
    ["opaque-callback", "function run(callback: any) { callback(); } run(() => {});"],
    [
      "getter-effect",
      "declare function mutate(): void; const object = { get value() { mutate(); return 0; } }; object.value;",
    ],
    ["number-coercion", "declare function mutate(): void; Number({ valueOf() { mutate(); return 0; } });"],
    ["string-coercion", "declare function mutate(): void; String({ toString() { mutate(); return 'ABC'; } });"],
    ["index-coercion", "declare function mutate(): void; 'ABC'.charCodeAt({ valueOf() { mutate(); return 0; } });"],
    ["length-coercion", "declare function mutate(): void; String({ toString() { mutate(); return 'ABC'; } }).length;"],
    ["closed-opaque-callee", "declare function mutate(): void; function run() { mutate(); } run();"],
    ["cyclic-effect-closure", "function run(): any { return run(); } run();"],
    ["default-parameter-effect", "function run(input = eval('String.prototype.charCodeAt = () => false')) {} run();"],
    ["exported-opaque-callee", "declare function mutate(): void; export function run() { mutate(); }"],
    ["iterator-effect", "declare const iterable: any; for (const item of iterable) {}"],
    ["proxy-enumeration", "declare const object: any; for (const key in object) {}"],
    ["spread-effect", "declare const object: any; const copy = { ...object };"],
    ["tagged-effect", "declare function tag(text: any): any; tag\`opaque\`;"],
  ])("[P2-effect-%s] declines incomplete prototype provenance or source effects", (_id, setup) => {
    const proof = proofFor(`${setup} function f() { const value: any = 'ABC'.charCodeAt(0); return value; }`);
    expect(proof.numeric("value")).toBe(false);
  });

  it.each([
    ["exported", "export function f(input: any) { const value: any = input.charCodeAt(0); return value; } f('ABC');"],
    [
      "open-export",
      "function f(input: any) { const value: any = input.charCodeAt(0); return value; } export { f }; f('ABC');",
    ],
    [
      "alias-escape",
      "function f(input: any) { const value: any = input.charCodeAt(0); return value; } const alias = f; alias('ABC');",
    ],
    [
      "unknown-second-caller",
      "declare const unknown: any; function f(input: any) { const value: any = input.charCodeAt(0); return value; } f('ABC'); f(unknown);",
    ],
    [
      "missing-argument",
      "function f(input: any) { const value: any = input.charCodeAt(0); return value; } f('ABC'); f();",
    ],
    [
      "cyclic-forwarding",
      "function f(input: any) { const value: any = input.charCodeAt(0); return value; } function other(): any { return other(); } f(other());",
    ],
    [
      "reassigned-input",
      "function f(input: any) { input = { charCodeAt() { return false; } }; const value: any = input.charCodeAt(0); return value; } f('ABC');",
    ],
    [
      "object-method",
      "function f(input: any) { const value: any = input.charCodeAt(0); return value; } f({ charCodeAt(): any { return false; } });",
    ],
    ["boxed-string", "function f() { const value: any = new String('ABC').charCodeAt(0); return value; } f();"],
  ])("[P2-ingress-%s] requires every actual closed incoming value to be primitive String", (_id, source) => {
    expect(proofFor(source).numeric("value")).toBe(false);
  });

  it.each([
    ["search", "'x'.search({ [Symbol.search]() { return false; } })"],
    ["replace", "'x'.replace({ [Symbol.replace]() { return { charCodeAt() { return false; } }; } }, '').charCodeAt(0)"],
    [
      "replace-all",
      "'x'.replaceAll({ [Symbol.replace]() { return { charCodeAt() { return false; } }; } }, '').charCodeAt(0)",
    ],
    ["code-point-undefined", "'x'.codePointAt(99)"],
  ])("[P2-protocol-%s] does not grant a private Number contract to arbitrary or absent results", (_id, expression) => {
    expect(proofFor(`function f() { const value: any = ${expression}; return value; }`).numeric("value")).toBe(false);
  });

  it("[P2-scan] proves the natural closed all-string scan and isAscii effect closure", () => {
    const proof = proofFor(`
      function isAscii(c) { return c >= 0 && c <= 127; }
      function scan(input) { var c = input.charCodeAt(0); return isAscii(c); }
      export function main() { return scan('A'); }
    `);
    expect(proof.numeric("c")).toBe(true);
  });

  it("[P2-classify] proves the natural closed all-string switch effect closure", () => {
    const proof = proofFor(`
      function classify(input) {
        var ch = input.charCodeAt(0);
        switch (ch) { case 10: return 1; case 32: return 2; case 65: return 3; default: return 4; }
      }
      export function main() { return classify('A'); }
    `);
    expect(proof.numeric("ch")).toBe(true);
  });

  it("[P2-partial-member] retains resolved actual String ingress when only member resolution is absent", () => {
    const proof = proofFor(`
      function f(input: any) { const value: any = input.charCodeAt(0); return value; } f('ABC');
    `);
    const verdicts = analyzeNumericPropertyNames(
      {
        oracle: {
          typeFactOf: (node) => proof.oracle.typeFactOf(node),
          valueDeclarationOf: (node) =>
            ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
              ? undefined
              : proof.oracle.valueDeclarationOf(node),
        },
      },
      [proof.sourceFile],
    );
    expect(verdicts.isNumericLocal(proof.declaration("value").name, "value")).toBe(true);
  });

  it.each([
    ["incoming-binding", "function f(input: any) { const value: any = input.charCodeAt(0); return value; } f('ABC');"],
    [
      "helper-binding",
      "function helper(): any { return 'ABC'; } function f() { const value: any = helper().charCodeAt(0); return value; } f();",
    ],
    ["conversion-binding", "function f() { const value: any = String(37).charCodeAt(0); return value; }"],
    [
      "object-number-oracle",
      "function f(input: any) { const value: any = input.charCodeAt(0); return value; } f({ charCodeAt() { return false; } });",
    ],
  ])("[P2-missing-%s] does not substitute a number vote for required binding resolution", (_id, source) => {
    expect(proofFor(source, { oracle: { typeFactOf: () => ({ kind: "number" }) } }).numeric("value")).toBe(false);
  });

  it("[P2-closed-effects] follows exact source helpers and inert primitive coercions", () => {
    const proof = proofFor(`
      function inert(value: any) { return Number(value); }
      inert(37);
      function f(input: any) {
        const value: any = input.slice(0).concat('D').charCodeAt(0);
        const peer: any = input.indexOf('B');
        return value + peer;
      }
      export function main() { return f(String(37)); }
    `);
    expect(proof.numeric("value")).toBe(true);
    expect(proof.numeric("peer")).toBe(true);
  });
});

async function nativeTest(source: string) {
  const result = await compile(source, {
    fileName: "issue-6878-conditional-return-boolean.ts",
    target: "standalone",
    allowJs: false,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    deferTopLevelInit: true,
    emitWat: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary!);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports.test as (x: number) => number;
}

describe("#6878 native local identity", () => {
  it("retains pure Boolean-call identity independently of J", async () => {
    const test = await nativeTest(`
      function predicate(): any { return false; }
      export function test(x: number): number {
        const value: any = predicate();
        if (value !== false) return 101;
        if (typeof value !== "boolean") return 102;
        if ("" + value !== "false") return 103;
        switch (value) { case false: return 1; default: return 104; }
      }
    `);
    expect(test(0)).toBe(1);
    expect(test(1)).toBe(1);
  });

  it("preserves numeric controls and explicit coercion side effects", async () => {
    const test = await nativeTest(`
      let calls = 0;
      function allNumbers(x: number): any { return x ? 37 : -0; }
      export function test(x: number): number {
        const numeric: any = allNumbers(x);
        if (typeof numeric !== "number") return 111;
        if (x && numeric !== 37) return 112;
        if (!x && 1 / numeric !== -Infinity) return 113;
        let sum: any = 0; sum += "A".charCodeAt(0); sum -= 1; ++sum;
        if (sum !== 65) return 114;
        calls = 0;
        const object = { valueOf(): number { calls++; return 37; } };
        const converted: any = +object;
        if (converted !== 37) return 115;
        if (calls !== 1) return 116;
        return 1;
      }
    `);
    expect(test(0)).toBe(1);
    expect(test(1)).toBe(1);
  });

  it("[J prerequisite] separates lazy selection and identity observers", async () => {
    const test = await nativeTest(`
      let conditions = 0;
      let arms = 0;
      function condition(x: number): number { conditions++; return x; }
      function selected(): boolean { arms++; return false; }
      function forbidden(): number { throw new Error("unselected arm ran"); }
      function identity(value: any): any { return value; }
      export function test(x: number): number {
        conditions = 0; arms = 0;
        const value: any = condition(x) ? selected() : 37;
        if (conditions !== 1) return 121;
        if (arms !== x) return 122;
        const expected: any = x ? false : 37;
        if (value !== expected) return 123;
        if (typeof value !== (x ? "boolean" : "number")) return 124;
        if (identity(value) !== expected) return 125;
        if ("" + value !== (x ? "false" : "37")) return 126;
        const guarded: any = condition(1) ? false : forbidden();
        if (guarded !== false) return 127;
        if (conditions !== 2) return 128;
        return 1;
      }
    `);
    expect(test(0)).toBe(1);
    expect(test(1)).toBe(1);
  });

  it.each([
    [
      "direct arguments versus any locals",
      `
function valueResult(value: any, expected: any, category: string): boolean {
  return value === expected && typeof value === category;
}


export function test(x: number): number {
  const a: any = x ? 37 : false;
  const b: any = x ? true : 0;
  if (x) {
    if (!valueResult(x ? 0 : false, 0, "number")) return 31;
    if (!valueResult(x ? true : 1, true, "boolean")) return 32;
    if (!valueResult(a, 37, "number")) return 33;
    if (!valueResult(b, true, "boolean")) return 34;
  } else {
    if (!valueResult(x ? 0 : false, false, "boolean")) return 35;
    if (!valueResult(x ? true : 1, 1, "number")) return 36;
    if (!valueResult(a, false, "boolean")) return 37;
    if (!valueResult(b, 0, "number")) return 38;
  }
  return 1;
}
`,
    ],
    [
      "boxed call returns, NaN and negative zero",
      `
function valueResult(value: any, expected: any, category: string): boolean {
  return value === expected && typeof value === category;
}


function nanBoolean(x: number): any { return x ? NaN : false; }
function booleanMinusZero(x: number): any { return x ? true : -0; }
export function test(x: number): number {
  const a: any = nanBoolean(x);
  const b: any = booleanMinusZero(x);
  if (x) {
    if (typeof a !== "number" || a === a) return 81;
    if (!valueResult(b, true, "boolean")) return 82;
  } else {
    if (!valueResult(a, false, "boolean")) return 83;
    if (typeof b !== "number" || 1 / b !== -Infinity) return 84;
  }
  return 1;
}
`,
    ],
    [
      "condition and selected arm run once",
      `
function valueResult(value: any, expected: any, category: string): boolean {
  return value === expected && typeof value === category;
}


let trace = 0;
function condition(x: number): number { trace = trace * 10 + 1; return x; }
function numberArm(): number { trace = trace * 10 + 2; return 37; }
function booleanArm(): boolean { trace = trace * 10 + 3; return false; }
export function test(x: number): number {
  trace = 0;
  const a: any = condition(x) ? numberArm() : booleanArm();
  if (x) {
    if (trace !== 12 || !valueResult(a, 37, "number")) return 91;
  } else if (trace !== 13 || !valueResult(a, false, "boolean")) return 92;
  trace = 0;
  const b: any = condition(x) ? booleanArm() : numberArm();
  if (x) {
    if (trace !== 13 || !valueResult(b, false, "boolean")) return 93;
  } else if (trace !== 12 || !valueResult(b, 37, "number")) return 94;
  return 1;
}
`,
    ],
  ])("[J prerequisite] retained witness: %s", async (_name, source) => {
    const test = await nativeTest(source);
    expect(test(0)).toBe(1);
    expect(test(1)).toBe(1);
  });
});
