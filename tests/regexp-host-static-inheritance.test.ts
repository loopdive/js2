// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Host class objects use a WasmGC carrier rather than a native JavaScript
// constructor. Static misses must still delegate to a host builtin parent with
// the child class as the receiver (Annex B RegExp accessors intentionally
// reject that receiver).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, markCoherentBuiltinRealm } from "../src/runtime.js";
import { createTestSandbox } from "./test262-runner.js";

const SOURCE = `
  class MyRegExp extends RegExp {}
  class Plain {}

  export function test(): number {
    let thrown = 0;
    for (let i = 1; i <= 9; i++) {
      try {
        MyRegExp["$" + i];
      } catch (error) {
        if (error instanceof TypeError) thrown++;
      }
    }
    return thrown;
  }

  export function controls(): number {
    let directThrows = 0;
    try {
      RegExp["$1"];
    } catch {
      directThrows++;
    }
    return directThrows * 10 + (typeof Plain["$1"] === "undefined" ? 1 : 0);
  }
`;

describe("host class static inheritance", () => {
  it("delegates RegExp legacy static reads with the subclass receiver", async () => {
    const result = await compile(SOURCE, {
      fileName: "regexp-host-static-inheritance.ts",
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const importObject = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, importObject);
    (importObject as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect((instance.exports as { test: () => number }).test()).toBe(9);
    expect((instance.exports as { controls: () => number }).controls()).toBe(1);
  });

  it("keeps host RegExp match metadata on the native result array", async () => {
    const result = await compile(
      `
        let setterCalls = 0;
        Object.defineProperty(Array.prototype, "indices", {
          set() { setterCalls++; }
        });
        let match = /a/d.exec("a");
        export function test(): number {
          let descriptor = Object.getOwnPropertyDescriptor(match, "indices");
          if (setterCalls !== 0) return 1;
          if (!Object.prototype.hasOwnProperty.call(match, "indices")) return 2;
          if (descriptor === undefined || descriptor.enumerable !== true) return 3;
          if (descriptor.configurable !== true || descriptor.writable !== true) return 4;
          return 5;
        }
      `,
      {
        fileName: "regexp-host-match-properties.ts",
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const sandbox = createTestSandbox();
    markCoherentBuiltinRealm(sandbox);
    const imports = buildImports(result.imports, undefined, result.stringPool, {
      globalSandbox: sandbox,
    });
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    expect((instance.exports as { test: () => number }).test()).toBe(5);
    expect(Object.getOwnPropertyDescriptor(Array.prototype, "indices")).toBeUndefined();
  });

  it("reads a mutable heritage binding at class evaluation time", async () => {
    const result = await compile(
      `
        let LetParent = class extends RegExp {};
        LetParent = Object;
        class LetChild extends LetParent {}
        var VarParent = class extends RegExp {};
        VarParent = Object;
        class VarChild extends VarParent {}

        export function test(): number {
          let passed = 0;
          try { LetChild.input; passed++; } catch {}
          try { VarChild.input; passed++; } catch {}
          return passed;
        }
      `,
      { fileName: "regexp-host-mutable-heritage.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const importObject = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, importObject);
    (importObject as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    expect((instance.exports as { test: () => number }).test()).toBe(2);
  });

  it("captures top-level mutable and const-snapshot heritage parents in source order", async () => {
    const result = await compile(
      `
        let P = RegExp;
        class BeforeWrite extends P {}
        P = Object;
        class AfterWrite extends P {}

        let Mutable = RegExp;
        const Stable = Mutable;
        Mutable = Object;
        class StableSnapshot extends Stable {}

        export function test(): number {
          let thrown = 0;
          try { BeforeWrite.input; } catch { thrown++; }
          try { AfterWrite.input; } catch {}
          try { StableSnapshot.input; } catch { thrown++; }
          return thrown;
        }
      `,
      { fileName: "regexp-host-top-level-mutable-heritage.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const importObject = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, importObject);
    (importObject as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    expect((instance.exports as { test: () => number }).test()).toBe(2);
  });

  it("does not freeze heritage aliases whose initializers occur later", async () => {
    const lateConst = await compile(
      `
        let P = RegExp;
        class LateConstChild extends Stable {}
        const Stable = P;
        class LateLetChild extends Later {}
        let Later = P;

        export function test(): number { return 0; }
      `,
      { fileName: "regexp-host-late-const-heritage.ts", deferTopLevelInit: true, skipSemanticDiagnostics: true },
    );
    expect(lateConst.success, lateConst.errors.map((error) => error.message).join("\n")).toBe(true);
    const lateConstImports = lateConst.importObject ?? {};
    const { instance: lateConstInstance } = await WebAssembly.instantiate(lateConst.binary, lateConstImports);
    lateConstImports.__setInstance?.(lateConstInstance);
    expect(() => (lateConstInstance.exports as { __module_init?: () => void }).__module_init?.()).toThrow(
      ReferenceError,
    );

    const futureVar = await compile(
      `
        class FutureVarChild extends FutureParent {}
        var FutureParent = RegExp;

        export function test(): number {
          try { FutureVarChild.input; return 0; } catch { return 1; }
        }
      `,
      { fileName: "regexp-host-future-var-heritage.ts", deferTopLevelInit: true, skipSemanticDiagnostics: true },
    );
    expect(futureVar.success, futureVar.errors.map((error) => error.message).join("\n")).toBe(true);
    const futureVarImports = futureVar.importObject ?? {};
    const { instance: futureVarInstance } = await WebAssembly.instantiate(futureVar.binary, futureVarImports);
    futureVarImports.__setInstance?.(futureVarInstance);
    expect(() => (futureVarInstance.exports as { __module_init?: () => void }).__module_init?.()).not.toThrow();
    expect((futureVarInstance.exports as { test: () => number }).test()).toBe(0);

    const futureClass = await compile(
      `
        const FutureClassAlias = FutureClassBase;
        class FutureClassBase extends RegExp {}
        class FutureClassChild extends FutureClassAlias {}

        export function test(): number {
          try { FutureClassChild.input; return 0; } catch { return 1; }
        }
      `,
      { fileName: "regexp-host-future-class-heritage.ts", deferTopLevelInit: true, skipSemanticDiagnostics: true },
    );
    expect(futureClass.success, futureClass.errors.map((error) => error.message).join("\n")).toBe(true);
    const futureClassImports = futureClass.importObject ?? {};
    const { instance: futureClassInstance } = await WebAssembly.instantiate(futureClass.binary, futureClassImports);
    futureClassImports.__setInstance?.(futureClassInstance);
    expect(() => (futureClassInstance.exports as { __module_init?: () => void }).__module_init?.()).not.toThrow();
    expect((futureClassInstance.exports as { test: () => number }).test()).toBe(0);
  });
});
