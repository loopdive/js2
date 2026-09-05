// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2175 D5 — distinguish the implicit Object.prototype terminal from an
// explicitly null [[Prototype]] during standalone OrdinaryToPrimitive.
import { describe, expect, it } from "vitest";
import { type CompileResult, compile } from "../src/index.js";

async function compileStandalone(source: string): Promise<CompileResult> {
  const result = await compile(source, {
    target: "standalone",
    skipSemanticDiagnostics: true,
    emitWat: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(WebAssembly.validate(result.binary), "invalid wasm").toBe(true);
  return result;
}

async function runStandalone(source: string): Promise<number> {
  const result = await compileStandalone(source);
  const wasmModule = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(wasmModule)).toEqual([]);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as { test(): number }).test();
}

function watFunctionStart(wat: string, name: string): number {
  const headers = [...wat.matchAll(/^[ \t]*\(func \$([^\s(]+)/gm)].map((match) => ({
    name: match[1]!,
    index: match.index!,
  }));
  const names = headers.map((header) => header.name);
  expect(new Set(names).size, "WAT function names must be unique before body attribution").toBe(names.length);
  const matches = headers.filter((header) => header.name === name);
  expect(matches, `unique WAT function $${name}`).toHaveLength(1);
  return matches[0]!.index;
}

function extractWatFunctionBody(wat: string, name: string): string {
  const start = watFunctionStart(wat, name);
  let depth = 0;
  for (let index = start; index < wat.length; index++) {
    if (wat[index] === "(") depth++;
    else if (wat[index] === ")" && --depth === 0) return wat.slice(start, index + 1);
  }
  throw new Error(`unterminated WAT function $${name}`);
}

function watCallTargets(wat: string, body: string): string[] {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  if (new Set(names).size !== names.length) throw new Error("WAT callable names are not unique");
  return [...body.matchAll(/\b(?:return_)?call (\d+)/g)].map((match) => {
    const target = names[Number(match[1])];
    if (!target) throw new Error(`WAT call ${match[1]} has no exact callable target`);
    return target;
  });
}

describe("#2175 D5 null-prototype OrdinaryToPrimitive", () => {
  it("keeps the implicit Object.prototype toString fallback for ordinary open objects", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const ordinary: any = {};
        return String(ordinary) === "[object Object]" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("keeps fixed Object.prototype names on an unarmed ordinary child", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const terminal: any = {};
        const child: any = Object.create(terminal);
        if (!("toString" in child) || !("valueOf" in child)) return 0;
        return String(child) === "[object Object]" ? 1 : 2;
      }`),
    ).toBe(1);
  });

  it("throws TypeError instead of inventing Object.prototype for Object.create(null)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const nullProto: any = Object.create(null);
        try {
          String(nullProto);
          return 0;
        } catch (error) {
          return error instanceof TypeError ? 1 : 2;
        }
      }`),
    ).toBe(1);
  });

  it("emits ToPropertyKey in the exact Test262-shaped top-level and function class bodies", async () => {
    const result = await compileStandalone(`
      var declarationKey: any = Object.create(null);
      class DeclarationProbe { get [declarationKey](): number { return 1; } }

      export function declarationProbe(): number {
        var key: any = Object.create(null);
        class FunctionDeclarationProbe { get [key](): number { return 1; } }
        return 0;
      }
      export function expressionProbe(): number {
        var key: any = Object.create(null);
        0, class { static get [key](): number { return 1; } };
        return 0;
      }
    `);
    for (const [name, expectedCalls] of [
      ["__module_init", 1],
      ["declarationProbe", 1],
      ["expressionProbe", 1],
    ] as const) {
      const body = extractWatFunctionBody(result.wat, name);
      expect(
        watCallTargets(result.wat, body).filter((target) => target === "__to_property_key"),
        `$${name} must own exactly ${expectedCalls} ToPropertyKey call(s) for its computed accessor name(s)`,
      ).toHaveLength(expectedCalls);
    }
  });

  it("applies ToPropertyKey to a null-prototype computed instance accessor name", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const key: any = Object.create(null);
        try {
          class C { get [key](): number { return 1; } }
          return 0;
        } catch (error) {
          return error instanceof TypeError ? 1 : 2;
        }
      }`),
    ).toBe(1);
  });

  it("applies ToPropertyKey to a null-prototype computed static accessor name", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const key: any = Object.create(null);
        try {
          0, class { static get [key](): number { return 1; } };
          return 0;
        } catch (error) {
          return error instanceof TypeError ? 1 : 3;
        }
      }`),
    ).toBe(1);
  });

  it("propagates an inherited Symbol.toPrimitive getter from a computed instance accessor name", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const proto: any = {};
        const abrupt: any = {};
        let getterCalls = 0;
        let fallbackCalls = 0;
        Object.defineProperty(proto, Symbol.toPrimitive, {
          get: function (): any {
            getterCalls++;
            throw abrupt;
          },
        });
        proto.toString = function (): string {
          fallbackCalls++;
          return "fallback";
        };
        const key: any = Object.create(proto);
        try {
          class C { get [key](): number { return 1; } }
          return 0;
        } catch (error: any) {
          return error === abrupt && getterCalls === 1 && fallbackCalls === 0 ? 1 : 2;
        }
      }`),
    ).toBe(1);
  });

  it("propagates an inherited Symbol.toPrimitive getter from a computed static accessor name", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const proto: any = {};
        const abrupt: any = {};
        let getterCalls = 0;
        let fallbackCalls = 0;
        Object.defineProperty(proto, Symbol.toPrimitive, {
          get: function (): any {
            getterCalls++;
            throw abrupt;
          },
        });
        proto.toString = function (): string {
          fallbackCalls++;
          return "fallback";
        };
        const key: any = Object.create(proto);
        try {
          0, class { static get [key](): number { return 1; } };
          return 0;
        } catch (error: any) {
          return error === abrupt && getterCalls === 1 && fallbackCalls === 0 ? 1 : 3;
        }
      }`),
    ).toBe(1);
  });

  it("observes an explicit null terminal through a child created from it", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const terminal: any = Object.create(null);
        const child: any = Object.create(terminal);
        try {
          String(child);
          return 0;
        } catch (error) {
          return error instanceof TypeError ? 1 : 2;
        }
      }`),
    ).toBe(1);
  });

  it("keeps an unarmed null-terminal child false while preserving a real inherited hit", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const terminal: any = Object.create(null);
        const child: any = Object.create(terminal);
        if ("toString" in child || "valueOf" in child) return 0;
        try {
          String(child);
          return 2;
        } catch (error) {
          if (!(error instanceof TypeError)) return 3;
        }
        terminal.toString = function (): string { return "inherited-real-hit"; };
        if (!("toString" in child)) return 4;
        return String(child) === "inherited-real-hit" ? 1 : 5;
      }`),
    ).toBe(1);
  });

  it("observes a null terminal installed below an existing child", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const child: any = {};
        const terminal: any = Object.create(null);
        Object.setPrototypeOf(child, terminal);
        try {
          String(child);
          return 0;
        } catch (error) {
          return error instanceof TypeError ? 1 : 2;
        }
      }`),
    ).toBe(1);
  });

  it("re-reads a mutated ancestor terminal instead of propagating a child bit", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const parent: any = {};
        const child: any = Object.create(parent);
        Object.setPrototypeOf(parent, null);
        try {
          String(child);
          return 0;
        } catch (error) {
          return error instanceof TypeError ? 1 : 2;
        }
      }`),
    ).toBe(1);
  });

  it("records the same-encoded-null transition and clears it for a non-null proto", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const value: any = {};
        Object.setPrototypeOf(value, null);
        try {
          String(value);
          return 0;
        } catch (error) {
          if (!(error instanceof TypeError)) return 2;
        }
        Object.setPrototypeOf(value, {});
        return String(value) === "[object Object]" ? 1 : 3;
      }`),
    ).toBe(1);
  });

  it("clears a marked null terminal for an accepted non-null new C() proto that cannot cast to $Object", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const value: any = Object.create(null);
        class C {}
        const failedObjectCast: any = new C();
        try {
          String(value);
          return 0;
        } catch (error) {
          if (!(error instanceof TypeError)) return 2;
        }
        if (Object.setPrototypeOf(value, failedObjectCast) !== value) return 3;
        try {
          return String(value) === "[object Object]" ? 1 : 4;
        } catch (error) {
          return error instanceof TypeError ? 5 : 6;
        }
      }`),
    ).toBe(1);
  });

  it("keeps a marked null terminal after a non-extensible new C() proto refusal", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const value: any = Object.create(null);
        class C {}
        const failedObjectCast: any = new C();
        Object.preventExtensions(value);
        try {
          Object.setPrototypeOf(value, failedObjectCast);
          return 0;
        } catch (error) {
          if (!(error instanceof TypeError)) return 2;
        }
        try {
          String(value);
          return 3;
        } catch (error) {
          return error instanceof TypeError ? 1 : 4;
        }
      }`),
    ).toBe(1);
  });

  it("keeps own callable toString and valueOf overrides on a null-prototype object", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const stringOverride: any = Object.create(null);
        stringOverride.toString = function (): string { return "override"; };
        const numberOverride: any = Object.create(null);
        numberOverride.valueOf = function (): number { return 37; };
        return String(stringOverride) === "override" && +numberOverride === 37 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("keeps an inherited explicit toString override before the terminal miss", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const terminal: any = Object.create(null);
        terminal.toString = function (): string { return "inherited-override"; };
        const child: any = Object.create(terminal);
        return String(child) === "inherited-override" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("does not leak proto-indexed Object.prototype toString or valueOf into a null terminal", async () => {
    expect(
      await runStandalone(`export function test(): number {
        (Object.prototype as any).toString = function (): string { return "proto-index-toString"; };
        (Object.prototype as any).valueOf = function (): number { return 41; };

        const ordinary: any = {};
        if (String(ordinary) !== "proto-index-toString") return 0;
        if (+ordinary !== 41) return 2;
        if (!("toString" in ordinary) || !("valueOf" in ordinary)) return 3;

        const terminal: any = Object.create(null);
        const child: any = Object.create(terminal);
        if ("toString" in terminal || "valueOf" in terminal) return 4;
        try {
          const directString = String(terminal);
          return directString === "proto-index-toString" ? 5 : 6;
        } catch (error) {
          if (!(error instanceof TypeError)) return 7;
        }
        try {
          const directNumber = +terminal;
          return directNumber === 41 ? 8 : 9;
        } catch (error) {
          if (!(error instanceof TypeError)) return 10;
        }
        if ("toString" in child || "valueOf" in child) return 11;
        try {
          const childString = String(child);
          return childString === "proto-index-toString" ? 12 : 13;
        } catch (error) {
          if (!(error instanceof TypeError)) return 14;
        }
        try {
          const childNumber = +child;
          return childNumber === 41 ? 15 : 16;
        } catch (error) {
          return error instanceof TypeError ? 1 : 17;
        }
      }`),
    ).toBe(1);
  });

  it("re-reads a proto-index-armed ancestor after it is relinked to null", async () => {
    expect(
      await runStandalone(`export function test(): number {
        (Object.prototype as any).toString = function (): string { return "ancestor-proto-index"; };
        (Object.prototype as any).valueOf = function (): number { return 59; };

        const terminal: any = {};
        const child: any = Object.create(terminal);
        if (String(child) !== "ancestor-proto-index") return 0;
        if (+child !== 59) return 2;
        if (!("toString" in child) || !("valueOf" in child)) return 3;

        Object.setPrototypeOf(terminal, null);
        if ("toString" in child || "valueOf" in child) return 4;
        try {
          String(child);
          return 5;
        } catch (error) {
          if (!(error instanceof TypeError)) return 6;
        }
        try {
          +child;
          return 7;
        } catch (error) {
          return error instanceof TypeError ? 1 : 8;
        }
      }`),
    ).toBe(1);
  });

  it("does not leak proto-index companions through an activated fnctor after its terminal is relinked", async () => {
    expect(
      await runStandalone(`function Fnctor() { this.own = 1; }
        Fnctor.prototype = {};
        export function test(): number {
          const instance: any = new Fnctor();
          (Object.prototype as any).toString = function (): string { return "fnctor-proto-index"; };
          (Object.prototype as any).valueOf = function (): number { return 89; };

          if (!("toString" in instance) || !("valueOf" in instance)) return 0;
          if (String(instance) !== "fnctor-proto-index") return 2;
          if (+instance !== 89) return 3;

          const terminal: any = (Fnctor as any).prototype;
          Object.setPrototypeOf(terminal, null);
          if ("toString" in instance || "valueOf" in instance) return 4;
          if (String(instance) === "fnctor-proto-index") return 5;
          return +instance === 89 ? 6 : 1;
        }`),
    ).toBe(1);
  });

  it("classifies an activated fnctor terminal without an Object.prototype companion", async () => {
    expect(
      await runStandalone(`function Fnctor() { this.own = 1; }
        Fnctor.prototype = {};
        export function test(): number {
          const instance: any = new Fnctor();
          if (!("toString" in instance) || !("valueOf" in instance)) return 0;

          const terminal: any = (Fnctor as any).prototype;
          Object.setPrototypeOf(terminal, null);
          return "toString" in instance || "valueOf" in instance ? 2 : 1;
        }`),
    ).toBe(1);
  });

  it("preserves fixed-name Proxy forwarding and invokes a present has trap exactly once", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const target: any = {};
        const forwarded: any = new Proxy(target, {});
        let calls = 0;
        let matchedTargetAndKey = false;
        const trapped: any = new Proxy(target, {
          has: function (actualTarget: any, actualKey: any): boolean {
            calls++;
            matchedTargetAndKey = actualTarget === target && actualKey === "toString";
            return false;
          },
        });
        const forwardedResult = "toString" in forwarded;
        const trappedResult = "toString" in trapped;
        return forwardedResult && !trappedResult && calls === 1 && matchedTargetAndKey ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("propagates a throwing fixed-name Proxy has trap unchanged without a terminal fallback", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const abrupt: any = {};
        let outerCalls = 0;
        let fallbackHasCalls = 0;
        const nullTerminal: any = Object.create(null);
        const fallbackTarget: any = new Proxy(nullTerminal, {
          has: function (): boolean {
            fallbackHasCalls++;
            return false;
          },
        });
        const trapped: any = new Proxy(fallbackTarget, {
          has: function (): boolean {
            outerCalls++;
            throw abrupt;
          },
        });
        try {
          const result = "toString" in trapped;
          return result ? 3 : 4;
        } catch (error: any) {
          return error === abrupt && outerCalls === 1 && fallbackHasCalls === 0 ? 1 : 2;
        }
      }`),
    ).toBe(1);
  });

  it("keeps a non-null proto input that cannot cast to $Object on the ordinary terminal", async () => {
    expect(
      await runStandalone(`export function test(): number {
        class C {}
        const nonObjectRuntimeProto: any = new C();
        const value: any = Object.create(nonObjectRuntimeProto);
        return String(value) === "[object Object]" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("uses exact string and number hint order after object-valued method results", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let stringOrder = 0;
        const stringHint: any = Object.create(null);
        stringHint.toString = function (): any {
          stringOrder = stringOrder * 10 + 1;
          return {};
        };
        stringHint.valueOf = function (): string {
          stringOrder = stringOrder * 10 + 2;
          return "string-result";
        };

        let numberOrder = 0;
        const numberHint: any = Object.create(null);
        numberHint.valueOf = function (): any {
          numberOrder = numberOrder * 10 + 1;
          return {};
        };
        numberHint.toString = function (): string {
          numberOrder = numberOrder * 10 + 2;
          return "23";
        };

        return String(stringHint) === "string-result" &&
            +numberHint === 23 &&
            stringOrder === 12 &&
            numberOrder === 12
          ? 1
          : 0;
      }`),
    ).toBe(1);
  });

  it("does not treat a present non-callable toString as the absent fallback", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const value: any = Object.create(null);
        value.toString = 1;
        try {
          String(value);
          return 0;
        } catch (error) {
          return error instanceof TypeError ? 1 : 2;
        }
      }`),
    ).toBe(1);
  });

  it("propagates an abrupt own toString accessor completion unchanged", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const value: any = Object.create(null);
        Object.defineProperty(value, "toString", {
          get: function (): any { throw "toprimitive-accessor-abrupt"; },
        });
        try {
          String(value);
          return 0;
        } catch (error: any) {
          return error === "toprimitive-accessor-abrupt" ? 1 : 2;
        }
      }`),
    ).toBe(1);
  });

  it("does not record an explicit-null terminal after a non-extensible refusal", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const value: any = {};
        Object.preventExtensions(value);
        try {
          Object.setPrototypeOf(value, null);
          return 0;
        } catch (error) {
          if (!(error instanceof TypeError)) return 2;
        }
        return String(value) === "[object Object]" ? 1 : 3;
      }`),
    ).toBe(1);
  });

  it("keeps the marked null terminal's OrdinaryToPrimitive behavior after a cycle refusal", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const terminal: any = Object.create(null);
        const child: any = Object.create(terminal);
        try {
          Object.setPrototypeOf(terminal, child);
          return 0;
        } catch (error) {
          if (!(error instanceof TypeError)) return 2;
        }
        try {
          String(child);
          return 3;
        } catch (error) {
          return error instanceof TypeError ? 1 : 4;
        }
      }`),
    ).toBe(1);
  });

  it("does not fold a fixed Object.prototype name after a cycle refusal", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const terminal: any = Object.create(null);
        const child: any = Object.create(terminal);
        try {
          Object.setPrototypeOf(terminal, child);
          return 0;
        } catch (error) {
          if (!(error instanceof TypeError)) return 2;
        }
        return "toString" in child || "valueOf" in child ? 3 : 1;
      }`),
    ).toBe(1);
  });
});
