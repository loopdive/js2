// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5190 — host RegExp match results must retain their native result fields.
// #5204's inherited-array carrier inference accidentally lowered the
// TypeScript `RegExpExecArray`/`RegExpMatchArray` declarations to compiler
// vectors in the JS-host lane. That preserved indexed captures but discarded
// the native `.index` and `.input` properties.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Lane = "host" | "standalone";

const SOURCE = `
  export function test(): number {
    const exec = /e{1}/.exec(void 0);
    const match = "aabaac".match(/b+/);
    return exec !== null && exec.index === 3 && exec.input === "undefined" &&
      match !== null && match.index === 2 && match.input === "aabaac" ? 1 : 0;
  }
`;

async function run(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-5190-regexp-exec-result.ts",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), `${lane} module failed validation`).toBe(true);

  if (lane === "standalone") {
    expect(result.imports.filter((entry) => entry.module === "env")).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports as { test: () => number }).test();
  }

  const importObject = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  (importObject as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

describe("#5190 — host RegExp exec/match result fields", () => {
  for (const lane of ["host", "standalone"] as const) {
    it(`${lane}: preserves index and input on exec and match results`, async () => {
      await expect(run(SOURCE, lane)).resolves.toBe(1);
    });
  }
});
