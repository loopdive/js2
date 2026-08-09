// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { buildImports, wrapExports } from "../src/runtime.js";

const EMPTY_MODULE = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);

function emptyInstance(): WebAssembly.Instance {
  return new WebAssembly.Instance(new WebAssembly.Module(EMPTY_MODULE));
}

describe("#3520 branded instance wiring", () => {
  it("accepts only a genuine instance internal slot", () => {
    const imports = buildImports([]);
    const instance = emptyInstance();
    const proxy = new Proxy(instance, {});
    const inherited = Object.create(WebAssembly.Instance.prototype);

    expect(() => imports.setInstance?.(instance)).not.toThrow();
    expect(() => imports.setInstance?.(proxy)).toThrow("setInstance: expected a genuine WebAssembly.Instance");
    expect(() => imports.setInstance?.(inherited)).toThrow("setInstance: expected a genuine WebAssembly.Instance");
  });

  it("does not let Function.prototype.call poisoning bypass the instance brand", () => {
    const imports = buildImports([]);
    const instance = emptyInstance();
    const inherited = Object.create(WebAssembly.Instance.prototype);
    const originalCall = Function.prototype.call;
    let thrown: unknown;
    try {
      Function.prototype.call = function poisonedCall(): WebAssembly.Exports {
        return instance.exports;
      };
      imports.setInstance?.(inherited);
    } catch (error) {
      thrown = error;
    } finally {
      Function.prototype.call = originalCall;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toBe("setInstance: expected a genuine WebAssembly.Instance");
  });

  it("does not consult mutable call/apply intrinsics while wiring exports", () => {
    const imports = buildImports([]);
    const instance = emptyInstance();
    const inherited = Object.create(WebAssembly.Instance.prototype);
    const originalCall = Function.prototype.call;
    const originalReflectApply = Reflect.apply;
    let callPoisonError: unknown;
    let applyPoisonError: unknown;

    try {
      Function.prototype.call = function poisonedCall(): never {
        throw new Error("live Function.prototype.call consulted");
      };
      imports.setExports?.(instance.exports as Record<string, Function>);
    } catch (error) {
      callPoisonError = error;
    } finally {
      Function.prototype.call = originalCall;
    }

    try {
      Reflect.apply = function poisonedReflectApply(): never {
        throw new Error("live Reflect.apply consulted");
      };
      imports.setInstance?.(inherited);
    } catch (error) {
      applyPoisonError = error;
    } finally {
      Reflect.apply = originalReflectApply;
    }

    expect(callPoisonError).toBeUndefined();
    expect(applyPoisonError).toBeInstanceOf(TypeError);
    expect((applyPoisonError as Error).message).toBe("setInstance: expected a genuine WebAssembly.Instance");
  });

  it("retains raw setExports and accepts an instance in wrapExports", () => {
    const imports = buildImports([]);
    const instance = emptyInstance();
    expect(() => imports.setExports?.(instance.exports as Record<string, Function>)).not.toThrow();
    expect(Object.keys(wrapExports(instance))).toEqual(Object.keys(wrapExports(instance.exports)));
  });
});
