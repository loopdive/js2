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
      trackIrOutcomes: true,
    });
    expectSuccess(result);

    expect(result.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["fetchUser", "fetchUser__ir_async_state_0"]));
    const outcome = (result.irOutcomes ?? []).find((candidate) => candidate.displayName === "fetchUser");
    expect(outcome).toMatchObject({ kind: "emitted", legacyBodyEmitted: true, irBodyEmitted: true });

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
});
