// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { beforeAll, describe, expect, it } from "vitest";
import {
  executeIndirectEval,
  installRuntimeDynamicImportHook,
  type RuntimeDynamicImportMetadata,
} from "../../src/interp/index.js";
import { loadAcorn, parse } from "./harness.js";

beforeAll(async () => {
  await loadAcorn();
});

const parser = (source: string, options: object): unknown => parse(source, options);

describe("runtime-eval dynamic import", () => {
  it("executes the exact async-arrow import shape through its realm loader", async () => {
    const globalObject = Object.create(globalThis);
    const calls: Array<{ specifier: string; metadata: RuntimeDynamicImportMetadata }> = [];
    const namespace = Object.freeze({ answer: 42 });
    installRuntimeDynamicImportHook(globalObject, (specifier, metadata) => {
      calls.push({ specifier, metadata });
      return namespace;
    });

    const result = executeIndirectEval(parser, "(async()=>await import('./b.js'))()", globalObject, "file:///app/a.js");

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(namespace);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.specifier).toBe("./b.js");
    expect(calls[0]!.metadata).toEqual({
      referrer: "file:///app/a.js",
      line: 1,
      column: 16,
      options: undefined,
    });
  });

  it("evaluates each request once and invokes the hook again on repeated calls", async () => {
    const globalObject = Object.create(globalThis);
    let specifierReads = 0;
    let loaderCalls = 0;
    globalObject.nextSpecifier = () => {
      specifierReads += 1;
      return "./b.js";
    };
    installRuntimeDynamicImportHook(globalObject, (specifier) => {
      loaderCalls += 1;
      return { specifier, loaderCalls };
    });

    const source = "(async()=>await import(nextSpecifier()))()";
    const first = executeIndirectEval(parser, source, globalObject, "file:///app/a.js");
    const second = executeIndirectEval(parser, source, globalObject, "file:///app/a.js");

    await expect(first).resolves.toEqual({ specifier: "./b.js", loaderCalls: 1 });
    await expect(second).resolves.toEqual({ specifier: "./b.js", loaderCalls: 2 });
    expect(specifierReads).toBe(2);
    expect(loaderCalls).toBe(2);
  });

  it("forwards the evaluated import-options object as loader metadata", async () => {
    const globalObject = Object.create(globalThis);
    let seen: RuntimeDynamicImportMetadata | undefined;
    installRuntimeDynamicImportHook(globalObject, (_specifier, metadata) => {
      seen = metadata;
      return {};
    });

    const result = executeIndirectEval(
      parser,
      "import('./data.json', { with: { type: 'json' } })",
      globalObject,
      "file:///app/a.js",
    );
    await result;

    expect(seen?.options).toEqual({ with: { type: "json" } });
  });

  it("turns specifier coercion and synchronous loader failures into rejections", async () => {
    const coercionGlobal = Object.create(globalThis);
    let coercionCalls = 0;
    coercionGlobal.request = {
      toString() {
        coercionCalls += 1;
        throw new RangeError("coercion failed");
      },
    };
    installRuntimeDynamicImportHook(coercionGlobal, () => {
      throw new Error("loader must not run");
    });

    let coercionResult: Promise<unknown> | undefined;
    expect(() => {
      coercionResult = executeIndirectEval(parser, "import(request)", coercionGlobal) as Promise<unknown>;
    }).not.toThrow();
    await expect(coercionResult).rejects.toThrow("coercion failed");
    expect(coercionCalls).toBe(1);

    const loaderGlobal = Object.create(globalThis);
    installRuntimeDynamicImportHook(loaderGlobal, () => {
      throw new URIError("loader failed");
    });
    let loaderResult: Promise<unknown> | undefined;
    expect(() => {
      loaderResult = executeIndirectEval(parser, "import('./b.js')", loaderGlobal) as Promise<unknown>;
    }).not.toThrow();
    await expect(loaderResult).rejects.toThrow("loader failed");

    const symbolGlobal = Object.create(globalThis);
    symbolGlobal.request = Symbol("module");
    installRuntimeDynamicImportHook(symbolGlobal, () => ({}));
    const symbolResult = executeIndirectEval(parser, "import(request)", symbolGlobal) as Promise<unknown>;
    await expect(symbolResult).rejects.toThrow(TypeError);
  });

  it("keeps an abrupt request expression synchronous", () => {
    const globalObject = Object.create(globalThis);
    globalObject.fail = () => {
      throw new SyntaxError("request expression failed");
    };
    installRuntimeDynamicImportHook(globalObject, () => ({}));

    expect(() => executeIndirectEval(parser, "import(fail())", globalObject)).toThrow("request expression failed");
  });
});
