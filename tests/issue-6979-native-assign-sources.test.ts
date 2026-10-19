// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { WASI } from "node:wasi";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

const source = `
  const assign = Object.assign;
  function copy(target: any, input: any): any { return assign(target, input); }

  export function closed(n: number): number {
    const token = { input: n };
    const input = { value: n, token: token };
    const target: any = {};
    const result = copy(target, input);
    return result === target && result.value === n && result.token === token ? 42 : -1;
  }

  export function overwrite(n: number): number {
    const target: any = { value: n - 1 };
    copy(target, null);
    const result = copy(target, { value: n });
    copy(target, undefined);
    copy(target, { other: n + 1 });
    return result === target && target.value === n && target.other === n + 1 ? 42 : -1;
  }

  export function proxy(n: number): number {
    let events = "";
    const input = new Proxy({ value: n }, {
      ownKeys(t) { events += "K"; return ["value"]; },
      getOwnPropertyDescriptor(t, key) { events += "D"; return { enumerable: true, configurable: true }; },
      get(t, key) { events += "G"; return n; }
    });
    const target: any = {};
    const result = copy(target, input);
    return result === target && result.value === n && events === "KDG" ? 42 : -1;
  }

  export function skipped(n: number): number {
    let gets = 0;
    let descriptors = 0;
    const input = new Proxy({}, {
      ownKeys(t) { return ["hidden", "gone", "value"]; },
      getOwnPropertyDescriptor(t, key) {
        descriptors++;
        if (key === "gone") return undefined;
        return { enumerable: key === "value", configurable: true };
      },
      get(t, key) { gets++; return n; }
    });
    const target: any = {};
    copy(target, input);
    return target.value === n && !Object.hasOwn(target, "hidden") &&
      !Object.hasOwn(target, "gone") && descriptors === 3 && gets === 1 ? 42 : -1;
  }

  export function symbols(n: number): number {
    const key = Symbol("source");
    let gets = 0;
    const input = new Proxy({}, {
      ownKeys(t) { return ["value", key]; },
      getOwnPropertyDescriptor(t, k) { return { enumerable: true, configurable: true }; },
      get(t, k) { gets++; return k === key ? n + 1 : n; }
    });
    const target: any = {};
    copy(target, input);
    return target.value === n && target[key] === n + 1 &&
      Object.getOwnPropertySymbols(target)[0] === key && gets === 2 ? 42 : -1;
  }

  export function abrupt(n: number): number {
    const token = { input: n };
    let gets = 0;
    const input = new Proxy({}, {
      ownKeys(t) { return ["first", "second"]; },
      getOwnPropertyDescriptor(t, key) { return { enumerable: true, configurable: true }; },
      get(t, key) { gets++; if (key === "second") throw token; return n; }
    });
    const target: any = {};
    try { copy(target, input); } catch (error) {
      return error === token && target.first === n && !Object.hasOwn(target, "second") && gets === 2 ? 42 : -1;
    }
    return -2;
  }

  export function ownKeysThrow(n: number): number {
    const token = { input: n };
    let descriptors = 0;
    const input = new Proxy({}, {
      ownKeys(t) { throw token; },
      getOwnPropertyDescriptor(t, key) { descriptors++; return undefined; }
    });
    try { copy({}, input); } catch (error) { return error === token && descriptors === 0 ? 42 : -1; }
    return -2;
  }

  export function revoked(n: number): number {
    const pair = Proxy.revocable({ value: n }, {});
    pair.revoke();
    try { copy({}, pair.proxy); } catch (error) { return error instanceof TypeError ? 42 : -1; }
    return -2;
  }

  export function empty(n: number): number {
    const target: any = { value: n };
    const input = new Proxy({}, { ownKeys(t) { return []; } });
    return copy(target, input) === target && target.value === n ? 42 : -1;
  }

  function encode(value: any): string { return JSON.stringify(value); }
  export function jsonClosed(n: number): number {
    const input = { value: n };
    return encode(input) === '{"value":' + n + '}' ? 42 : -1;
  }

  function define(target: any, props: any): any { return Object.defineProperties(target, props); }
  export function descriptors(n: number): number {
    const props = { value: { value: n, enumerable: true, writable: true, configurable: true } };
    const target: any = {};
    return define(target, props) === target && target.value === n ? 42 : -1;
  }
`;

for (const target of ["standalone", "wasi", "gc"] as const) {
  describe(`#6979 shared native Object.assign source semantics — ${target}`, () => {
    let functions: Record<string, (n: number) => number>;
    beforeAll(async () => {
      const result = await compile(source, {
        target,
        skipSemanticDiagnostics: true,
        deferTopLevelInit: true,
      });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      const module = new WebAssembly.Module(result.binary);
      if (target === "gc") {
        const imports = buildCompiledImports(result);
        const instance = await WebAssembly.instantiate(module, imports);
        imports.setInstance?.(instance);
        functions = wrapCompiledExports(result, instance) as typeof functions;
      } else {
        const imports = WebAssembly.Module.imports(module);
        expect(imports.every((row) => row.module === "wasi_snapshot_preview1")).toBe(true);
        if (target === "standalone") expect(imports).toEqual([]);
        const wasi = target === "wasi" ? new WASI({ version: "preview1", returnOnExit: true }) : undefined;
        const instance = await WebAssembly.instantiate(module, wasi?.getImportObject() ?? {});
        functions = instance.exports as typeof functions;
      }
      functions.__module_init?.(0);
    });
    for (const name of [
      "closed",
      "overwrite",
      "proxy",
      "skipped",
      "symbols",
      "abrupt",
      "ownKeysThrow",
      "revoked",
      "empty",
      "jsonClosed",
      "descriptors",
    ]) {
      it(`${name}: retains live input values, source effects and target identity`, () => {
        expect(functions[name]!(7)).toBe(42);
        expect(functions[name]!(13)).toBe(42);
      });
    }
  });
}
