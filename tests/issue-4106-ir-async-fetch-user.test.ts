// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** #4106 — first genuinely-suspending source function prepared and emitted through IR. */
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { ASYNC_HOST_ADAPTERS } from "../src/ir/async-runtime-providers.js";
import { isSingleAwaitReturnAsyncCandidate } from "../src/ir/async-prepare.js";
import { ts } from "../src/ts-api.js";

const EXACT_SOURCE = `
  function delay(ms: number, value: number): Promise<number> {
    return new Promise<number>((resolve) => {
      setTimeout(() => resolve(value), ms);
    });
  }

  export async function fetchUser(id: number): Promise<number> {
    const value = await delay(0, id * 10);
    return value;
  }
`;

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
}

function parseFunction(body: string): ts.FunctionDeclaration {
  const source = ts.createSourceFile("issue-4106-candidate.ts", body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find(ts.isFunctionDeclaration);
  if (!declaration) throw new Error("missing function declaration fixture");
  return declaration;
}

function extractFunctionBody(wat: string, name: string): string | null {
  const marker = `(func $${name}`;
  const start = wat.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  for (let index = start; index < wat.length; index++) {
    if (wat[index] === "(") depth++;
    else if (wat[index] === ")" && --depth === 0) return wat.slice(start, index + 1);
  }
  return null;
}

function functionImportIndex(binary: Uint8Array, module: string, name: string): number | undefined {
  let functionIndex = 0;
  for (const imported of WebAssembly.Module.imports(new WebAssembly.Module(binary))) {
    if (imported.kind !== "function") continue;
    if (imported.module === module && imported.name === name) return functionIndex;
    functionIndex++;
  }
  return undefined;
}

async function settled<T>(value: T | Promise<T>, ms = 4000): Promise<T> {
  return Promise.race([
    Promise.resolve(value),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("async result never settled")), ms)),
  ]);
}

describe("#4106 IR single-await async producer", () => {
  it("recognizes only the exact two-statement source shape", () => {
    expect(
      isSingleAwaitReturnAsyncCandidate(
        parseFunction(`async function fetchUser(id: number): Promise<number> {
          const value = await delay(0, id * 10);
          return value;
        }`),
      ),
    ).toBe(true);

    for (const source of [
      `async function fetchUser(id: number): Promise<number> {
        const value = await delay(0, id * 10);
        const adjusted = value + 0;
        return adjusted;
      }`,
      `async function fetchUser(id: number): Promise<number> {
        const value = await delay(0, id * 10);
        return value + 0;
      }`,
      `function fetchUser(id: number): Promise<number> {
        const value = await delay(0, id * 10);
        return value;
      }`,
    ]) {
      expect(isSingleAwaitReturnAsyncCandidate(parseFunction(source))).toBe(false);
    }
  });

  it("IR-emits the exact host function and resolves its numeric fulfillment", async () => {
    const result = await compile(EXACT_SOURCE, {
      fileName: "issue-4106-ir-async-fetch-user.ts",
      target: "gc",
      emitWat: true,
      trackIrOutcomes: true,
    });
    expectSuccess(result);

    expect(result.irFirstSkipped ?? []).toContain("fetchUser");
    expect(result.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["fetchUser", "fetchUser__ir_async_state_0"]));
    const outcome = (result.irOutcomes ?? []).find((candidate) => candidate.displayName === "fetchUser");
    expect(outcome).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });

    const resumeBody = extractFunctionBody(result.wat, "__async_resume_ffetchUser");
    expect(resumeBody, "missing fetchUser resume body").not.toBeNull();
    for (const importedName of ["__box_number", "__unbox_number"]) {
      const importIndex = functionImportIndex(result.binary, "env", importedName);
      expect(importIndex, `missing positive-control env.${importedName} import`).toBeDefined();
      expect(resumeBody).not.toMatch(new RegExp(`\\bcall\\s+${importIndex}\\b`));
    }

    const adapterNames = new Set(ASYNC_HOST_ADAPTERS.map((adapter) => adapter.field));
    const actualAdapters = WebAssembly.Module.imports(new WebAssembly.Module(result.binary))
      .filter((entry) => entry.module === "env" && entry.kind === "function" && adapterNames.has(entry.name))
      .map((entry) => entry.name)
      .sort();
    expect(actualAdapters).toEqual(ASYNC_HOST_ADAPTERS.map((adapter) => adapter.field).sort());

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const fetchUser = instance.exports.fetchUser as (id: number) => Promise<number>;
    await expect(settled(fetchUser(7))).resolves.toBe(70);
  });

  it("keeps direct-only async activation behavior when the IR overlay is disabled", async () => {
    const result = await compile(EXACT_SOURCE, {
      fileName: "issue-4107-direct-only-control.ts",
      target: "gc",
      experimentalIR: false,
    });
    expectSuccess(result);
    expect(result.irFirstSkipped).toBeUndefined();

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const fetchUser = instance.exports.fetchUser as (id: number) => Promise<number>;
    await expect(settled(fetchUser(7))).resolves.toBe(70);
  });

  it("leaves a non-identity post-await tail on the direct route", async () => {
    const result = await compile(
      EXACT_SOURCE.replace(
        "return value;",
        `const adjusted = value + 0;
        return adjusted;`,
      ),
      {
        fileName: "issue-4106-near-miss.ts",
        target: "gc",
        trackIrOutcomes: true,
      },
    );
    expectSuccess(result);

    expect(result.irCompiledFuncs ?? []).not.toContain("fetchUser");
    expect((result.irOutcomes ?? []).find((candidate) => candidate.displayName === "fetchUser")).toMatchObject({
      kind: "unsupported",
      stage: "select",
      code: "async-function",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  });

  it("keeps an await of a non-prepared async callee on the direct route", async () => {
    const result = await compile(
      `async function getValue(): Promise<number> {
        return 100;
      }

      export async function test(): Promise<number> {
        const value = await getValue();
        return value;
      }`,
      {
        fileName: "issue-4107-non-prepared-async-callee.ts",
        target: "gc",
        trackIrOutcomes: true,
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irFirstSkipped ?? []).not.toContain("test");
    expect((result.irOutcomes ?? []).find((candidate) => candidate.displayName === "test")).toMatchObject({
      legacyBodyEmitted: true,
    });

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    await expect(settled((instance.exports.test as () => Promise<number>)())).resolves.toBe(100);
  });

  it("keeps host-free and non-numeric ABI owners off the prepared skip route", async () => {
    const hostFree = await compile(EXACT_SOURCE, {
      fileName: "issue-4107-host-free.ts",
      target: "standalone",
      trackIrOutcomes: true,
    });
    expectSuccess(hostFree);
    expect(hostFree.irFirstSkipped ?? []).not.toContain("fetchUser");
    expect((hostFree.irOutcomes ?? []).find((candidate) => candidate.displayName === "fetchUser")).toMatchObject({
      legacyBodyEmitted: true,
    });

    const abiMismatch = await compile(
      `export async function fetchFlag(id: number): Promise<boolean> {
        const value = await Promise.resolve(id > 0);
        return value;
      }`,
      {
        fileName: "issue-4107-abi-mismatch.ts",
        target: "gc",
        trackIrOutcomes: true,
      },
    );
    expect(abiMismatch.success, abiMismatch.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(abiMismatch.binary)).toBe(true);
    // The final async fixed point rejects this ABI before the IR owner is
    // claimed, so it stays on the direct route without a post-claim failure.
    expect(abiMismatch.irPostClaimErrors ?? []).toEqual([]);
    expect(abiMismatch.irFirstSkipped ?? []).not.toContain("fetchFlag");
    expect((abiMismatch.irOutcomes ?? []).find((candidate) => candidate.displayName === "fetchFlag")).toMatchObject({
      legacyBodyEmitted: true,
    });

    const imports = buildImports(abiMismatch.imports, undefined, abiMismatch.stringPool);
    const { instance } = await WebAssembly.instantiate(abiMismatch.binary, imports as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    await expect(settled((instance.exports.fetchFlag as (id: number) => Promise<boolean>)(1))).resolves.toBe(true);
  });

  it("fails terminally without retrying a skipped owner after preparation starts", async () => {
    const previous = process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW;
    process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW = "inline";
    try {
      const result = await compile(EXACT_SOURCE, {
        fileName: "issue-4107-preparation-failure.ts",
        target: "gc",
        trackIrOutcomes: true,
      });
      expect(result.success).toBe(false);
      expect(result.irFirstSkipped ?? []).toContain("fetchUser");
      expect((result.irOutcomes ?? []).find((candidate) => candidate.displayName === "fetchUser")).toMatchObject({
        kind: "invariant",
        legacyBodyEmitted: false,
        irBodyEmitted: false,
      });
    } finally {
      if (previous === undefined) process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW = undefined;
      else process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW = previous;
    }
  });
});
