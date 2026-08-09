// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2856 Capability C — declaration-identity module bindings shared by the
// selector and AST→IR builder. Positive cases assert genuine IR ownership;
// negatives prove unsupported writes reject before claim rather than demoting.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

const JS_STRING = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  fromCharCode: (c: number) => String.fromCharCode(c),
  cast: (s: unknown) => String(s),
  test: (v: unknown) => (typeof v === "string" ? 1 : 0),
};

async function compileAndInstantiate(source: string): Promise<{
  result: Awaited<ReturnType<typeof compile>>;
  exports: Record<string, (...args: number[]) => number>;
}> {
  const result = await compile(source, { experimentalIR: true, trackFallbacks: true });
  expect(result.success, result.errors[0]?.message).toBe(true);
  expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
  const built = buildImports(result.imports, ENV_STUB, result.stringPool);
  const imports: WebAssembly.Imports = { env: built.env, string_constants: built.string_constants };
  imports["wasm:js-string"] = JS_STRING as unknown as WebAssembly.ModuleImports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  built.setExports?.(instance.exports as Record<string, Function>);
  return {
    result,
    exports: instance.exports as unknown as Record<string, (...args: number[]) => number>,
  };
}

describe("#2856 Capability C — shared module-global storage", () => {
  it("shares one slot from an IR writer to a legacy reader", async () => {
    const { result, exports } = await compileAndInstantiate(`
      let shared: number = 1;
      export function writer(v: number): number {
        shared = v;
        return shared;
      }
      export function reader(): number {
        legacy: { return shared; }
        return -1;
      }
    `);

    expect(result.irCompiledFuncs ?? []).toContain("writer");
    expect(result.irCompiledFuncs ?? []).not.toContain("reader");
    expect(exports.writer!(42)).toBe(42);
    expect(exports.reader!()).toBe(42);
  });

  it("shares one slot from a legacy writer to an IR reader", async () => {
    const { result, exports } = await compileAndInstantiate(`
      let shared: number = 1;
      export function writer(v: number): number {
        legacy: { shared = v; }
        return shared;
      }
      export function reader(): number { return shared; }
    `);

    expect(result.irCompiledFuncs ?? []).not.toContain("writer");
    expect(result.irCompiledFuncs ?? []).toContain("reader");
    expect(exports.writer!(73)).toBe(73);
    expect(exports.reader!()).toBe(73);
  });

  it("preserves boolean i32 module storage", async () => {
    const bool = await compileAndInstantiate(`
      let ready: boolean = false;
      export function mark(): boolean { ready = true; return ready; }
    `);
    expect(bool.result.irCompiledFuncs ?? []).toContain("mark");
    expect(bool.exports.mark!()).toBe(1);
  });

  it("admits boolean module consumers while pre-claim rejecting numeric truthiness and aliases", async () => {
    const { result, exports } = await compileAndInstantiate(`
      let count: number = 2;
      let ready: boolean = true;
      export function numNot(): boolean { return !count; }
      export function numIf(): number { if (count) return 1; return 0; }
      export function numAnd(): number { return count && 4; }
      export function numOr(): number { return count || 4; }
      export function numAlias(): number { const value = count; return value + 1; }
      export function boolAlias(): boolean { const value = ready; return !value; }
      export function numAdd(): number { return count + 4; }
      export function numBitwise(): number { return count | 4; }
      export function numCompare(): boolean { return count > 1; }
      export function numAddCondition(): number { if (count + 1) return 1; return 0; }
      export function numBitCondition(): number { if (count | 0) return 1; return 0; }
      export function mixedConditional(): void { void (true ? count : ready); }
      export function mixedParamConditional(value: boolean): void { void (true ? count : value); }
      export function mixedArray(value: boolean): void { void [count, value]; }
      export function boolNot(): boolean { return !ready; }
      export function boolIf(): number { if (ready) return 1; return 0; }
      export function boolAnd(): boolean { return ready && false; }
      export function boolOr(): boolean { return ready || false; }
    `);

    expect(result.irCompiledFuncs ?? []).not.toContain("numNot");
    expect(result.irCompiledFuncs ?? []).not.toContain("numIf");
    expect(result.irCompiledFuncs ?? []).not.toContain("numAnd");
    expect(result.irCompiledFuncs ?? []).not.toContain("numOr");
    expect(result.irCompiledFuncs ?? []).toContain("numAlias");
    expect(result.irCompiledFuncs ?? []).toContain("boolAlias");
    expect(result.irCompiledFuncs ?? []).toContain("numAdd");
    expect(result.irCompiledFuncs ?? []).toContain("numBitwise");
    expect(result.irCompiledFuncs ?? []).toContain("numCompare");
    expect(result.irCompiledFuncs ?? []).not.toContain("numAddCondition");
    expect(result.irCompiledFuncs ?? []).not.toContain("numBitCondition");
    expect(result.irCompiledFuncs ?? []).not.toContain("mixedConditional");
    expect(result.irCompiledFuncs ?? []).not.toContain("mixedParamConditional");
    expect(result.irCompiledFuncs ?? []).not.toContain("mixedArray");
    expect(result.irCompiledFuncs ?? []).toContain("boolNot");
    expect(result.irCompiledFuncs ?? []).toContain("boolIf");
    expect(result.irCompiledFuncs ?? []).toContain("boolAnd");
    expect(result.irCompiledFuncs ?? []).toContain("boolOr");
    expect(exports.numAdd!()).toBe(6);
    expect(exports.numBitwise!()).toBe(6);
    expect(exports.numCompare!()).toBe(1);
    expect(exports.numAlias!()).toBe(3);
    expect(exports.boolAlias!()).toBe(0);
    expect(exports.boolNot!()).toBe(0);
    expect(exports.boolIf!()).toBe(1);
    expect(exports.boolAnd!()).toBe(0);
    expect(exports.boolOr!()).toBe(1);
  });

  it("rejects mixed scalar representations and numeric nullish use before claim", async () => {
    const result = await compile(
      `
        let count: number = 2;
        let ready: boolean = true;
        export function boolLtNumber(): boolean { return ready < 1; }
        export function boolEqNumber(): boolean { return ready === 1; }
        export function boolSubNumber(): number { return ready - 1; }
        export function numberEqBool(): boolean { return count === true; }
        export function numericNullish(): number { return count ?? 3; }
      `,
      { experimentalIR: true, trackFallbacks: true, skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(result.irCompiledFuncs ?? []).not.toContain("boolLtNumber");
    expect(result.irCompiledFuncs ?? []).not.toContain("boolEqNumber");
    expect(result.irCompiledFuncs ?? []).not.toContain("boolSubNumber");
    expect(result.irCompiledFuncs ?? []).not.toContain("numberEqBool");
    expect(result.irCompiledFuncs ?? []).not.toContain("numericNullish");
  });

  it("keeps ambient module lexicals out of IR storage while retaining their identity", async () => {
    const result = await compile(
      `
        declare let ambientValue: number;
        export function readAmbient(): number { return ambientValue; }
      `,
      { experimentalIR: true, trackFallbacks: true, skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(result.irCompiledFuncs ?? []).not.toContain("readAmbient");
  });

  it("uses checker identity when a for-init name leaked into selector scope", async () => {
    const { result, exports } = await compileAndInstantiate(`
      let i: number = 40;
      export function writeAfterLoop(): number {
        let sum: number = 0;
        for (let i = 0; i < 2; i++) { sum = sum + i; }
        i = i + sum;
        return i;
      }
      export function readGlobal(): number {
        legacy: { return i; }
        return -1;
      }
    `);

    expect(result.irCompiledFuncs ?? []).toContain("writeAfterLoop");
    expect(result.irCompiledFuncs ?? []).not.toContain("readGlobal");
    expect(exports.writeAfterLoop!()).toBe(41);
    expect(exports.readGlobal!()).toBe(41);
  });

  it("claims nullable extern module init and strict null checks", async () => {
    const result = await compile(
      `
        let node: HTMLElement | null = null;
        export function attach(): boolean {
          if (node === null) node = document.createElement("div");
          return node !== null;
        }
      `,
      { fileName: "issue-2856-module-extern.ts", experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irCompiledFuncs ?? []).toContain("<module-init>");
    expect(result.irCompiledFuncs ?? []).toContain("attach");
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("keeps direct extern initialization and simple extern writes claimable", async () => {
    const result = await compile(
      `
        let node: HTMLElement | null = document.body;
export function replace(): boolean {
  node = document.createElement("div");
  node = null;
  return node === null;
}
      `,
      { fileName: "issue-2856-module-extern-simple.ts", experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irCompiledFuncs ?? []).toContain("<module-init>");
    expect(result.irCompiledFuncs ?? []).toContain("replace");
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  for (const [label, expression] of [
    ["conditional", "true ? document.body : null"],
    ["nullish", "document.body ?? null"],
    ["logical-or", "document.body || null"],
    ["logical-and", "document.body && null"],
    ["array-element", "[document.body][0]"],
    ["nullable-array-element", "[document.body, null][0]"],
    ["nested-logical", "({ value: document.body || document.body }).value"],
    ["nested-conditional", "({ value: true ? document.body : document.body }).value"],
  ] as const) {
    it(`rejects extern ${label} flow in module init and writes before claim`, async () => {
      const result = await compile(
        `
          let initialized: HTMLElement | null = ${expression};
          let written: HTMLElement | null = null;
          export function write(): void { written = ${expression}; }
        `,
        {
          fileName: `issue-2856-module-extern-${label}.ts`,
          experimentalIR: true,
          trackFallbacks: true,
          skipSemanticDiagnostics: true,
        },
      );

      expect(result.success, result.errors[0]?.message).toBe(true);
      expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");
      expect(result.irCompiledFuncs ?? []).not.toContain("write");
      expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    });
  }

  it("rejects GC object producers for structurally compatible extern storage", async () => {
    for (const source of [
      `
        declare class Box { x: number; }
        let box: Box = { x: 1 };
        export function reset(): void { box = { x: 2 }; }
      `,
      `
        declare class Box { x: number; }
        class LocalBox { x: number = 1; }
        let box: Box = new LocalBox();
        export function reset(): void { box = new LocalBox(); }
      `,
    ]) {
      const result = await compile(source, {
        experimentalIR: true,
        trackFallbacks: true,
      });

      expect(result.success, result.errors[0]?.message).toBe(true);
      expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");
      expect(result.irCompiledFuncs ?? []).not.toContain("reset");
      expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    }
  });

  it("rejects GC values at module-rooted extern member boundaries before claim", async () => {
    const result = await compile(
      `
        declare class Child { value: object; }
        declare class Host {
          value: object;
          flag: any;
          nullable: number | null;
          take(value: object): void;
          takeArray(value: number[]): void;
          takeAny(value: any): void;
          takeNullable(value: number | null): void;
          child(): Child;
        }
        let host: Host | null = null;
        export function callObject(): void { if (host !== null) host.take({ x: 1 }); }
        export function callArray(): void { if (host !== null) host.takeArray([1, 2]); }
        export function callBoolean(): void { if (host !== null) host.takeAny(true); }
        export function callNull(): void { if (host !== null) host.takeNullable(null); }
        export function writeObject(): void { if (host !== null) host.value = { x: 1 }; }
        export function writeBoolean(): void { if (host !== null) host.flag = true; }
        export function writeNull(): void { if (host !== null) host.nullable = null; }
        export function writeNested(): void { if (host !== null) host.child().value = { x: 1 }; }
      `,
      { experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    for (const name of [
      "callObject",
      "callArray",
      "callBoolean",
      "callNull",
      "writeObject",
      "writeBoolean",
      "writeNull",
      "writeNested",
    ]) {
      expect(result.irCompiledFuncs ?? []).not.toContain(name);
    }
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
  });

  it("does not treat source declarations named like extern constructors as builtins", async () => {
    for (const source of [
      `
        class CustomMap { size: number = 7; }
        const Map = CustomMap;
        export function read(): number { return new Map().size; }
      `,
      `
        class Map { size: number = 7; }
        export function read(): number { return new Map().size; }
      `,
    ]) {
      const { result, exports } = await compileAndInstantiate(source);
      expect(result.irCompiledFuncs ?? []).not.toContain("read");
      expect(exports.read!()).toBe(7);
    }
  });

  it("keeps exact extern brands claimable at direct and spread call boundaries", async () => {
    const result = await compile(
      `
        const element: HTMLElement = document.body;
        export function acceptElement(value: HTMLElement): void { void value; }
        export function exactBrand(): void { acceptElement(element); }
        export function exactSpreadBrand(): void { acceptElement(...[element]); }
      `,
      { fileName: "issue-2856-module-extern-call-brand.ts", experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irCompiledFuncs ?? []).toContain("exactBrand");
    expect(result.irCompiledFuncs ?? []).toContain("exactSpreadBrand");
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("rejects covariant extern brands at direct and spread call boundaries", async () => {
    const result = await compile(
      `
        const element: HTMLElement = document.body;
        class Sink { take(value: Node): void { void value; } }
        export function acceptNode(value: Node): void { void value; }
        export function covariantBrand(): void { acceptNode(element); }
        export function covariantSpreadBrand(): void { acceptNode(...[element]); }
        export function covariantMethod(sink: Sink): void { sink.take(element); }
      `,
      { fileName: "issue-2856-module-extern-call-covariance.ts", experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("covariantBrand");
    expect(result.irCompiledFuncs ?? []).not.toContain("covariantSpreadBrand");
    expect(result.irCompiledFuncs ?? []).not.toContain("covariantMethod");
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
  });

  it("rejects unsupported nullable-extern truthiness and loose null checks before claim", async () => {
    const result = await compile(
      `
        let node: HTMLElement | null = null;
        let other: HTMLElement | null = null;
        export function direct(): boolean {
          if (node) return true;
          return false;
        }
        export function negated(): boolean { return !node; }
        export function anded(): boolean { return node && true; }
        export function ored(): boolean { return node || false; }
        export function loose(): boolean { return node == null; }
        export function looseAlias(): boolean { const x = (node); return x == null; }
        export function ifAlias(): boolean { const x = node; if (x) return true; return false; }
        export function notAlias(): boolean { const x = node; return !x; }
        export function andAlias(): boolean { const x = node; return x && true; }
        export function conditionalAlias(): boolean {
          const x = true ? node : node;
          return x == null;
        }
        export function conditionalCondition(): boolean {
          if (true ? node : node) return true;
          return false;
        }
        export function nullishAlias(): boolean {
          const x = node ?? node;
          return x == null;
        }
        export function nullishCondition(): boolean {
          if (node ?? node) return true;
          return false;
        }
        export function moduleEquality(): boolean { return node === other; }
        export function selfInequality(): boolean { return node !== node; }
        export function looseEquality(): boolean { return node == other; }
        export function hostEquality(): boolean { return node === document.body; }
        export function additive(): string { return "x" + node; }
        export function typeOfNode(): string { return typeof node; }
        export function elementRead(): string { return node["id"]; }
        export function optionalRead(): boolean { return node?.id === "x"; }
        export function optionalMethod(): void { node?.focus(); }
        export function optionalCall(): void { node.focus?.(); }
        export function templateNode(): string { return \`node=\${node}\`; }
        export function computedChain(): boolean {
          return node.ownerDocument["body"] === null;
        }
        export function destructureNode(): number { const { id } = node; return 1; }
        export function arrayContainsNode(): number { const values = [node]; return values.length; }
        export function objectContainsNode(): number { const value = { node }; return 1; }
        export function methodCondition(): boolean {
          if (node === null) return false;
          if (node.cloneNode()) return true;
          return false;
        }
        export function methodAliasCondition(): boolean {
          if (node === null) return false;
          const copy = node.cloneNode();
          if (copy) return true;
          return false;
        }
        export function booleanMethodCondition(): boolean {
          if (node === null) return false;
          if (node.matches("div")) return true;
          return false;
        }
        export function strict(): boolean { return node === null; }
        export function strictUndefined(): boolean { return node !== undefined; }
        export function directProperty(): string { return node.id; }
        export function voidNode(): void { void node; }
      `,
      {
        fileName: "issue-2856-module-extern-conditions.ts",
        experimentalIR: true,
        trackFallbacks: true,
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(result.irCompiledFuncs ?? []).not.toContain("direct");
    expect(result.irCompiledFuncs ?? []).not.toContain("negated");
    expect(result.irCompiledFuncs ?? []).not.toContain("anded");
    expect(result.irCompiledFuncs ?? []).not.toContain("ored");
    expect(result.irCompiledFuncs ?? []).not.toContain("loose");
    expect(result.irCompiledFuncs ?? []).not.toContain("looseAlias");
    expect(result.irCompiledFuncs ?? []).not.toContain("ifAlias");
    expect(result.irCompiledFuncs ?? []).not.toContain("notAlias");
    expect(result.irCompiledFuncs ?? []).not.toContain("andAlias");
    expect(result.irCompiledFuncs ?? []).not.toContain("conditionalAlias");
    expect(result.irCompiledFuncs ?? []).not.toContain("conditionalCondition");
    expect(result.irCompiledFuncs ?? []).not.toContain("nullishAlias");
    expect(result.irCompiledFuncs ?? []).not.toContain("nullishCondition");
    expect(result.irCompiledFuncs ?? []).not.toContain("moduleEquality");
    expect(result.irCompiledFuncs ?? []).not.toContain("selfInequality");
    expect(result.irCompiledFuncs ?? []).not.toContain("looseEquality");
    expect(result.irCompiledFuncs ?? []).not.toContain("hostEquality");
    expect(result.irCompiledFuncs ?? []).not.toContain("additive");
    expect(result.irCompiledFuncs ?? []).not.toContain("typeOfNode");
    expect(result.irCompiledFuncs ?? []).not.toContain("elementRead");
    expect(result.irCompiledFuncs ?? []).not.toContain("optionalRead");
    expect(result.irCompiledFuncs ?? []).not.toContain("optionalMethod");
    expect(result.irCompiledFuncs ?? []).not.toContain("optionalCall");
    expect(result.irCompiledFuncs ?? []).not.toContain("templateNode");
    expect(result.irCompiledFuncs ?? []).not.toContain("computedChain");
    expect(result.irCompiledFuncs ?? []).not.toContain("destructureNode");
    expect(result.irCompiledFuncs ?? []).not.toContain("arrayContainsNode");
    expect(result.irCompiledFuncs ?? []).not.toContain("objectContainsNode");
    expect(result.irCompiledFuncs ?? []).not.toContain("methodCondition");
    expect(result.irCompiledFuncs ?? []).not.toContain("methodAliasCondition");
    expect(result.irCompiledFuncs ?? []).not.toContain("booleanMethodCondition");
    expect(result.irCompiledFuncs ?? []).toContain("strict");
    expect(result.irCompiledFuncs ?? []).toContain("strictUndefined");
    expect(result.irCompiledFuncs ?? []).not.toContain("directProperty");
    expect(result.irCompiledFuncs ?? []).toContain("voidNode");
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("preserves a TDZ trap for an IR read before module initialization", async () => {
    const result = await compile(
      `
        export function readBeforeInit(): number { return value; }
        const observed: number = readBeforeInit();
        let value: number = 1;
        export function readObserved(): number { return observed; }
      `,
      {
        fileName: "issue-2856-module-tdz.ts",
        experimentalIR: true,
        trackFallbacks: true,
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(result.irCompiledFuncs ?? []).toContain("<module-init>");
    expect(result.irCompiledFuncs ?? []).toContain("readBeforeInit");
    const built = buildImports(result.imports, ENV_STUB, result.stringPool);
    const imports: WebAssembly.Imports = { env: built.env, string_constants: built.string_constants };
    imports["wasm:js-string"] = JS_STRING as unknown as WebAssembly.ModuleImports;
    await expect(WebAssembly.instantiate(result.binary, imports)).rejects.toThrow();
  });

  it("accepts only string-producing scalar module consumers", async () => {
    const result = await compile(
      [
        "let count: number = 3;",
        "let ready: boolean = true;",
        "export function numberString(): string { return count.toString(); }",
        "export function numberTemplate(): string { return `${count.toString()}`; }",
        "export function throwString(): void { throw count.toString(); }",
        "export function boolString(): string { return ready.toString(); }",
        "export function boolValue(): boolean { return ready.valueOf(); }",
        "export function numberValue(): number { return count.valueOf(); }",
        "export function numberFixed(): string { return count.toFixed(); }",
        "export function numberExponential(): string { return count.toExponential(); }",
        "export function numberRadix(): string { return count.toString(16); }",
        "export function numberTemplateBad(): string { return `${count}`; }",
        "export function boolTemplateBad(): string { return `${ready}`; }",
        "export function derivedTemplateBad(): string { return `${count + 1}`; }",
        "export function throwNumber(): void { throw count; }",
        "export function throwBoolean(): void { throw ready; }",
        "export function throwDerived(): void { throw count + 1; }",
      ].join("\n"),
      { experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irCompiledFuncs ?? []).toContain("numberString");
    expect(result.irCompiledFuncs ?? []).toContain("numberTemplate");
    expect(result.irCompiledFuncs ?? []).toContain("throwString");
    for (const name of [
      "boolString",
      "boolValue",
      "numberValue",
      "numberFixed",
      "numberExponential",
      "numberRadix",
      "numberTemplateBad",
      "boolTemplateBad",
      "derivedTemplateBad",
      "throwNumber",
      "throwBoolean",
      "throwDerived",
    ]) {
      expect(result.irCompiledFuncs ?? []).not.toContain(name);
    }
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  for (const [label, options] of [
    ["native strings", { nativeStrings: true }],
    ["standalone", { target: "standalone" }],
    ["wasi", { target: "wasi" }],
    ["strict no-host", { strictNoHostImports: true }],
  ] as const) {
    it(`keeps module-number toString on legacy with ${label}`, async () => {
      const result = await compile(
        `let count: number = 3; export function stringify(): string { return count.toString(); }`,
        { ...options, experimentalIR: true, trackFallbacks: true },
      );

      expect(result.success, result.errors[0]?.message).toBe(true);
      expect(result.irCompiledFuncs ?? []).not.toContain("stringify");
      expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    });
  }

  it("keeps scalar module values out of destructuring aliases", async () => {
    const { result, exports } = await compileAndInstantiate(`
      let count: number = 2;
      let ready: boolean = true;
      export function destructureNumber(): number { const [value] = [count]; return value + 1; }
      export function destructureBoolean(): boolean { const [value] = [ready]; return !value; }
      export function directNumberIndex(): number { return [count, 3][0]; }
      export function directBooleanIndex(): boolean { return [ready, true][0]; }
    `);

    expect(result.irCompiledFuncs ?? []).not.toContain("destructureNumber");
    expect(result.irCompiledFuncs ?? []).not.toContain("destructureBoolean");
    expect(result.irCompiledFuncs ?? []).toContain("directNumberIndex");
    expect(result.irCompiledFuncs ?? []).toContain("directBooleanIndex");
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(exports.directNumberIndex!()).toBe(2);
    expect(exports.directBooleanIndex!()).toBe(1);
  });

  it("proves call-result truthiness before consuming a module argument", async () => {
    const result = await compile(
      `
        let count: number = 2;
        export function identity(value: number): number { return value; }
        export function positive(value: number): boolean { return value > 0; }
        export function numericCallIf(): number { if (identity(count)) return 1; return 0; }
        export function numericCallNot(): boolean { return !identity(count); }
        export function numericCallLogical(): number { return identity(count) || 1; }
        export function mathCallIf(): number { if (Math.abs(count)) return 1; return 0; }
        export function booleanCallIf(): number { if (positive(count)) return 1; return 0; }
      `,
      { experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    for (const name of ["numericCallIf", "numericCallNot", "numericCallLogical", "mathCallIf"]) {
      expect(result.irCompiledFuncs ?? []).not.toContain(name);
    }
    expect(result.irCompiledFuncs ?? []).toContain("booleanCallIf");
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("rejects provenance-losing scalar aliases before claim", async () => {
    const result = await compile(
      `
        let count: number = 2;
        let ready: boolean = true;
        export function identity(value: number): number { return value; }
        export function arithmeticAlias(): number { const value = count + 1; if (value) return 1; return 0; }
        export function callAlias(): number { const value = identity(count); if (value) return 1; return 0; }
        export function arrayAlias(): number { const values = [count]; const value = values[0]; return !value ? 1 : 0; }
        export function objectAlias(): void { const holder = { value: ready }; throw holder.value; }
        export function aliasToString(): string { const value = count; return value.toString(); }
        export function aliasTemplate(): string { const value = count; return \`\${value}\`; }
        export function aliasNumberValue(): number { const value = count; return value.valueOf(); }
        export function aliasBooleanValue(): boolean { const value = ready; return value.valueOf(); }
        export function aliasThrow(): void { const value = count; throw value; }
        export function directNumber(): number { return count + 1; }
        export function directBoolean(): boolean { return !ready; }
      `,
      { experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    for (const name of [
      "arithmeticAlias",
      "callAlias",
      "arrayAlias",
      "objectAlias",
      "aliasTemplate",
      "aliasNumberValue",
      "aliasBooleanValue",
      "aliasThrow",
    ]) {
      expect(result.irCompiledFuncs ?? []).not.toContain(name);
    }
    expect(result.irCompiledFuncs ?? []).toContain("aliasToString");
    expect(result.irCompiledFuncs ?? []).toContain("directNumber");
    expect(result.irCompiledFuncs ?? []).toContain("directBoolean");
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
  });

  it("keeps catch bindings from inheriting tracked module-alias families", async () => {
    const result = await compile(
      `
        let ready: boolean = true;
        const cache = new Map<number, number>();
        export function scalarShadow(): number {
          const value = ready;
          let result: number = 0;
          try { throw "x"; } catch (value) { if (value) { result = 1; } }
          return result;
        }
        export function mapShadow(key: number): number {
          const hit = cache.get(key);
          let result: number = 0;
          try { throw "x"; } catch (hit) { if (hit) { result = 1; } }
          return result;
        }
      `,
      { experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("scalarShadow");
    expect(result.irCompiledFuncs ?? []).not.toContain("mapShadow");
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
  });

  it("keeps module bindings named like builtins on the declaration-identity path", async () => {
    const result = await compile(
      `
        let Math: number = 3;
        let console: number = 4;
        export function mathString(): string { return Math.toString(); }
        export function consoleString(): string { return console.toString(); }
      `,
      { experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irCompiledFuncs ?? []).toContain("mathString");
    expect(result.irCompiledFuncs ?? []).toContain("consoleString");
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("does not treat a module binding named undefined as the sentinel", async () => {
    const result = await compile(
      `
        let undefined: number = 1;
        let value: number = 1;
        export function equal(): boolean { return value === undefined; }
      `,
      { experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("equal");
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
  });
});

describe("#2856 Capability C — storage representation matrix", () => {
  it("rejects unsupported module Map iteration consumers before claim", async () => {
    const result = await compile(
      `
        const cache = new Map<number, number>();
        export function keysBad(): void { cache.keys(); }
        export function iterateBad(): void {
          for (const entry of cache) {}
          return;
        }
        export function nullishGetBad(key: number): number { return cache.get(key) ?? 0; }
        export function wrappedKeysBad(): void { (true ? cache : cache).keys(); }
        export function wrappedNullishKeysBad(): void { (cache ?? cache).keys(); }
        export function wrappedHasBad(key: number): boolean { return (true ? cache : cache).has(key); }
        export function wrappedDeleteBad(key: number): boolean { return (cache ?? cache).delete(key); }
        export function wrappedGetBad(key: number): number {
          const hit = (true ? cache : cache).get(key);
          return hit === undefined ? 0 : hit;
        }
        export function wrappedSetBad(key: number, value: number): void {
          (true ? cache : cache).set(key, value);
        }
        export function aliasTruthinessBad(key: number): number {
          const hit = cache.get(key);
          if (hit) return hit;
          return 0;
        }
        export function aliasLogicalBad(key: number): number {
          const hit = cache.get(key);
          return hit || 0;
        }
        export function aliasLooseNullBad(key: number): boolean {
          const hit = cache.get(key);
          return hit == null;
        }
        export function aliasEqualityBad(key: number): boolean {
          const left = cache.get(key);
          const right = cache.get(key);
          return left === right;
        }
        export function aliasPrefixBad(key: number): number {
          const hit = cache.get(key);
          if (hit === undefined) return 0;
          return +hit;
        }
        export function aliasCallBad(key: number): number {
          const hit = cache.get(key);
          if (hit === undefined) return 0;
          return take(hit);
        }
        export function aliasTemplateBad(key: number): string {
          const hit = cache.get(key);
          return \`value=\${hit}\`;
        }
        export function strictNullOk(key: number): boolean {
          const hit = cache.get(key);
          return hit === null;
        }
        export function take(value: number): number { return value; }
        export function getOk(key: number): number {
          const hit = cache.get(key);
          if (hit !== undefined) return hit;
          return -1;
        }
        export function setOk(key: number, value: number): void { cache.set(key, value); }
      `,
      { experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(result.irCompiledFuncs ?? []).not.toContain("keysBad");
    expect(result.irCompiledFuncs ?? []).not.toContain("iterateBad");
    expect(result.irCompiledFuncs ?? []).not.toContain("nullishGetBad");
    expect(result.irCompiledFuncs ?? []).not.toContain("wrappedKeysBad");
    expect(result.irCompiledFuncs ?? []).not.toContain("wrappedNullishKeysBad");
    expect(result.irCompiledFuncs ?? []).not.toContain("wrappedHasBad");
    expect(result.irCompiledFuncs ?? []).not.toContain("wrappedDeleteBad");
    expect(result.irCompiledFuncs ?? []).not.toContain("wrappedGetBad");
    expect(result.irCompiledFuncs ?? []).not.toContain("wrappedSetBad");
    expect(result.irCompiledFuncs ?? []).not.toContain("aliasTruthinessBad");
    expect(result.irCompiledFuncs ?? []).not.toContain("aliasLogicalBad");
    expect(result.irCompiledFuncs ?? []).not.toContain("aliasLooseNullBad");
    expect(result.irCompiledFuncs ?? []).not.toContain("aliasEqualityBad");
    expect(result.irCompiledFuncs ?? []).not.toContain("aliasPrefixBad");
    expect(result.irCompiledFuncs ?? []).not.toContain("aliasCallBad");
    expect(result.irCompiledFuncs ?? []).not.toContain("aliasTemplateBad");
    expect(result.irCompiledFuncs ?? []).toContain("strictNullOk");
    expect(result.irCompiledFuncs ?? []).toContain("getOk");
    expect(result.irCompiledFuncs ?? []).toContain("setOk");
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("keeps ordinary number module storage on legacy under fast mode", async () => {
    const result = await compile(
      `
        let shared: number = 1;
        export function write(v: number): number { shared = v; return shared; }
        export function read(): number { return shared; }
        export function leakedRead(): number {
          for (let shared = 0; shared < 1; shared++) {}
          return shared;
        }
        export function leakedWrite(): void {
          for (let shared = 0; shared < 1; shared++) {}
          shared = 2;
        }
      `,
      { fast: true, experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");
    expect(result.irCompiledFuncs ?? []).not.toContain("write");
    expect(result.irCompiledFuncs ?? []).not.toContain("read");
    expect(result.irCompiledFuncs ?? []).not.toContain("leakedRead");
    expect(result.irCompiledFuncs ?? []).not.toContain("leakedWrite");
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("keeps builtin Map module storage on legacy with native strings", async () => {
    const result = await compile(
      `
        const cache = new Map<number, number>();
        export function put(key: number, value: number): void { cache.set(key, value); }
      `,
      { nativeStrings: true, experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");
    expect(result.irCompiledFuncs ?? []).not.toContain("put");
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  for (const [label, options] of [
    ["native strings", { nativeStrings: true }],
    ["fast mode", { fast: true }],
  ] as const) {
    it(`keeps host-extern module storage on legacy with ${label}`, async () => {
      const result = await compile(
        `
          let node: HTMLElement | null = null;
          const values = new Set<number>();
          const pattern = new RegExp("x");
          export function mutateDom(): void { node.setAttribute("x", "y"); }
          export function setIsNull(): boolean { return values === null; }
          export function regexpIsNull(): boolean { return pattern === null; }
        `,
        {
          ...options,
          experimentalIR: true,
          trackFallbacks: true,
          skipSemanticDiagnostics: true,
        },
      );

      expect(result.success, result.errors[0]?.message).toBe(true);
      expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
      expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");
      expect(result.irCompiledFuncs ?? []).not.toContain("mutateDom");
      expect(result.irCompiledFuncs ?? []).not.toContain("setIsNull");
      expect(result.irCompiledFuncs ?? []).not.toContain("regexpIsNull");
    });
  }

  for (const target of ["standalone", "wasi"] as const) {
    it(`shares f64 module storage on the ${target} target`, async () => {
      const result = await compile(
        `
          let shared: number = 1;
          export function write(v: number): number { shared = v; return shared; }
        `,
        { target, experimentalIR: true, trackFallbacks: true },
      );

      expect(result.success, result.errors[0]?.message).toBe(true);
      expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
      expect(result.irCompiledFuncs ?? []).toContain("<module-init>");
      expect(result.irCompiledFuncs ?? []).toContain("write");
      expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
    });
  }

  it("does not mistake a user-defined Map class for the host builtin", async () => {
    const result = await compile(
      `
        class Map {
          get(value: number): number { return value; }
        }
        const cache = new Map();
        export function read(value: number): number { return cache.get(value); }
      `,
      { experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");
    expect(result.irCompiledFuncs ?? []).not.toContain("read");
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("rejects top-level destructuring before claiming module init", async () => {
    for (const source of [
      `const { body } = document; export function read(): void { void body; }`,
      `const [first] = [1]; export function read(): number { return first; }`,
    ]) {
      const result = await compile(source, {
        experimentalIR: true,
        trackFallbacks: true,
      });

      expect(result.success, result.errors[0]?.message).toBe(true);
      expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");
      expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    }
  });

  it("rejects representation-unsafe assignment in a module-init loop update", async () => {
    const result = await compile(
      `
        let node: HTMLElement | null = null;
        for (let index: number = 0; index < 1; node = true ? document.body : null) { index++; }
        export function read(): boolean { return node === null; }
      `,
      { experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
  });
});

describe("#2856 Capability C — unsupported writes reject before claim", () => {
  const cases = [
    `const locked: number = 1; export function bad(): number { locked = 2; return locked; }`,
    `let counter: number = 1; export function bad(): number { counter++; return counter; }`,
    `let counter: number = 1; export function bad(): number { counter += 2; return counter; }`,
  ];

  for (const [index, source] of cases.entries()) {
    it(`keeps unsupported module write ${index + 1} on legacy`, async () => {
      const result = await compile(source, {
        experimentalIR: true,
        trackFallbacks: true,
        skipSemanticDiagnostics: true,
      });
      expect(result.success, result.errors[0]?.message).toBe(true);
      expect(result.irCompiledFuncs ?? []).not.toContain("bad");
      expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    });
  }

  it("rejects scalar write expressions whose operands cannot lower to the target representation", async () => {
    const result = await compile(
      `
        let ready: boolean = false;
        let value: number = 0;
        export function badNot(n: number): void { ready = !n; }
        export function badDoubleNot(n: number): void { ready = !!n; }
        export function badNumberValue(n: number): void { value = n.valueOf(); }
        export function badBooleanValue(v: boolean): void { ready = v.valueOf(); }
        export function badFixedLength(n: number): void { value = n.toFixed(1).length; }
        export function badExponentialLength(n: number): void { value = n.toExponential(1).length; }
        export function badFixedBoolean(n: number): void { ready = n.toFixed(1).length > 0; }
        export function badNumericOr(n: number): void { value = n || 1; }
        export function badNumericNullish(n: number): void { value = n ?? 1; }
        export function badNumericConditional(n: number): void { value = n ? 1 : 2; }
        export function numberAdd(n: number): void { value = n + 1; }
        export function numberStringLength(n: number): void { value = n.toString().length; }
        export function booleanCompare(n: number): void { ready = n > 0; }
        export function booleanAnd(v: boolean): void { ready = v && true; }
        export function booleanConditional(v: boolean): void { ready = v ? true : false; }
      `,
      { experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    for (const name of [
      "badNot",
      "badDoubleNot",
      "badNumberValue",
      "badBooleanValue",
      "badFixedLength",
      "badExponentialLength",
      "badFixedBoolean",
      "badNumericOr",
      "badNumericNullish",
      "badNumericConditional",
    ]) {
      expect(result.irCompiledFuncs ?? []).not.toContain(name);
    }
    for (const name of ["numberAdd", "numberStringLength", "booleanCompare", "booleanAnd", "booleanConditional"]) {
      expect(result.irCompiledFuncs ?? []).toContain(name);
    }
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
  });
});

describe("#2856 calendar residual prework", () => {
  it("stringifies an exact numeric call result that retains module provenance", async () => {
    const { result, exports } = await compileAndInstantiate(`
      let base: number = 100;
      function price(delta: number): number { return base + delta; }
      export function digits(delta: number): number { return price(delta).toString().length; }
    `);

    expect(result.irCompiledFuncs ?? []).toContain("price");
    expect(result.irCompiledFuncs ?? []).toContain("digits");
    expect(exports.digits!(23)).toBe(3);
    expect(exports.digits!(-95)).toBe(1);
  });

  it("keeps toString arguments outside the exact scalar formatter claim", async () => {
    const result = await compile(
      `
        let base: number = 15;
        function numberValue(delta: number): number { return delta; }
        export function radix(): string { return numberValue(base).toString(16); }
      `,
      { experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    for (const name of ["radix"]) {
      expect(result.irCompiledFuncs ?? []).not.toContain(name);
    }
  });

  it("lowers a converging top-level if/else before trailing statements", async () => {
    const { result, exports } = await compileAndInstantiate(`
      export function choose(value: number): number {
        let selected: number = 0;
        if (value > 0) {
          selected = 1;
        } else if (value < 0) {
          selected = 2;
        } else {
          selected = 3;
        }
        return selected + 10;
      }
    `);

    expect(result.irCompiledFuncs ?? []).toContain("choose");
    expect(exports.choose!(4)).toBe(11);
    expect(exports.choose!(-4)).toBe(12);
    expect(exports.choose!(0)).toBe(13);
  });

  it("does not route a terminating non-tail if/else through if.stmt", async () => {
    const result = await compile(
      `
        export function early(value: number): number {
          if (value > 0) return 1;
          else value = value + 1;
          return value;
        }
      `,
      { experimentalIR: true, trackFallbacks: true },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("early");
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
  });

  it("assigns an extern module slot from an exact same-file factory", async () => {
    const result = await compile(
      `
        let node: HTMLElement | null = null;
        function makeNode(): HTMLElement {
          const created = document.body;
          created.textContent = "made";
          return created;
        }
        export function install(): boolean {
          node = makeNode();
          return node !== null;
        }
      `,
      {
        fileName: "issue-2856-calendar-factory.ts",
        experimentalIR: true,
        trackFallbacks: true,
      },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    expect(result.irCompiledFuncs ?? []).toContain("makeNode");
    expect(result.irCompiledFuncs ?? []).toContain("install");
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();

    const document = { body: { kind: "body", textContent: "" } };
    const built = buildImports(result.imports, { ...ENV_STUB, document }, result.stringPool);
    const imports: WebAssembly.Imports = { env: built.env, string_constants: built.string_constants };
    imports["wasm:js-string"] = JS_STRING as unknown as WebAssembly.ModuleImports;
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    built.setExports?.(instance.exports as Record<string, Function>);
    expect((instance.exports.install as () => number)()).toBe(1);
    expect(document.body.textContent).toBe("made");
  });

  it("rejects unproven same-file factory returns before claiming the writer", async () => {
    const result = await compile(
      `
        let node: HTMLElement | null = null;
        function asserted(): HTMLElement { return 1 as unknown as HTMLElement; }
        function mutable(): HTMLElement { let value = document.body; return value; }
        function branching(flag: boolean): HTMLElement {
          if (flag) return document.body;
          return document.documentElement;
        }
        function forwarded(value: HTMLElement): HTMLElement { return value; }
        function aliasedForward(value: HTMLElement): HTMLElement {
          const result = value;
          return result;
        }
        function destructuredWrite(): HTMLElement {
          const result = document.body;
          [result] = [1 as unknown as HTMLElement];
          return result;
        }
        function nullable(): HTMLElement | null { return document.body; }
        export function writeAsserted(): void { node = asserted(); }
        export function writeMutable(): void { node = mutable(); }
        export function writeBranching(): void { node = branching(true); }
        export function writeForwarded(): void { node = forwarded(document.body); }
        export function writeAliasedForward(): void { node = aliasedForward(document.body); }
        export function writeDestructured(): void { node = destructuredWrite(); }
        export function writeNullable(): void { node = nullable(); }
      `,
      {
        fileName: "issue-2856-calendar-factory-negatives.ts",
        experimentalIR: true,
        trackFallbacks: true,
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    for (const name of [
      "writeAsserted",
      "writeMutable",
      "writeBranching",
      "writeForwarded",
      "writeAliasedForward",
      "writeDestructured",
      "writeNullable",
    ]) {
      expect(result.irCompiledFuncs ?? []).not.toContain(name);
    }
  });
});
