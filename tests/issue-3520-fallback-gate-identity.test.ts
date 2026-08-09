// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { planIrFallbackGateEntry, reconcileFallbackGateFallbacks } from "../scripts/check-ir-fallbacks.js";
import { ts } from "../src/ts-api.js";

const FILES = new Map([
  [
    "/repo/entry.ts",
    `
      import { same as fromA } from "./a";
      import { same as fromB } from "./b";
      export function callA(value: number): number { return fromA(value); }
      export function callB(value: number): number { return fromB(value); }
    `,
  ],
  ["/repo/a.ts", `export function same(value: number): number { return value + 1; }`],
  ["/repo/b.ts", `export function same(value: number): number { return value + 2; }`],
]);

function graph(sourceOrder: readonly string[]) {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    noLib: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => FILES.has(fileName),
    readFile: (fileName) => FILES.get(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const text = FILES.get(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram([...FILES.keys()], options, host);
  const byName = new Map([...FILES.keys()].map((fileName) => [fileName, program.getSourceFile(fileName)!] as const));
  return {
    checker: program.getTypeChecker(),
    entryFile: byName.get("/repo/entry.ts")!,
    sourceFiles: sourceOrder.map((fileName) => byName.get(fileName)!),
  };
}

function snapshot(sourceOrder: readonly string[]) {
  const selection = planIrFallbackGateEntry(graph(sourceOrder));
  expect(selection).toBeDefined();
  return {
    funcs: [...selection!.funcs].sort(),
    fallbacks: (selection!.fallbacks ?? [])
      .map(({ name, reason }) => ({ name, reason }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

describe("#3520 fallback telemetry planning identity", () => {
  it("never last-wins across same-labeled imported targets", () => {
    const forward = snapshot(["/repo/entry.ts", "/repo/a.ts", "/repo/b.ts"]);
    const reversed = snapshot(["/repo/b.ts", "/repo/a.ts", "/repo/entry.ts"]);

    expect(reversed).toEqual(forward);
    expect(forward.funcs).toEqual([]);
    expect(forward.fallbacks).toEqual([
      { name: "callA", reason: "external-call" },
      { name: "callB", reason: "external-call" },
    ]);
  });

  it("retires a preliminary fallback only for the matching source-qualified production owner", () => {
    const fallback = { name: "main", reason: "async-function" } as const;
    const emitted = {
      key: "entry::main",
      file: "/repo/entry.ts",
      unitKind: "function",
      displayName: "main",
      ordinal: 0,
      line: 1,
      column: 1,
      backend: "wasmgc",
      target: "gc",
      kind: "emitted",
      stage: "patch",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    } as const;
    expect(reconcileFallbackGateFallbacks([fallback], [emitted], "/repo/entry.ts")).toEqual({
      remaining: [],
      retired: [fallback],
    });
    expect(
      reconcileFallbackGateFallbacks([fallback], [{ ...emitted, file: "/repo/dep.ts" }], "/repo/entry.ts"),
    ).toEqual({
      remaining: [fallback],
      retired: [],
    });
  });
});
