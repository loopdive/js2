// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7519 — a Script whose top-level class or binding pattern binds `undefined`, `NaN` or `Infinity` throws a
// SyntaxError at GlobalDeclarationInstantiation. The ordinary pipeline threw only for a plain `let`/`const`
// identifier; it now asks the shared predicate, which also skips ambient (`declare`) declarations.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Whether `__module_init` throws, on the standalone or the default target; a module without one has nothing to run. */
async function initThrows(source: string, fileName: string, target: "standalone" | undefined): Promise<boolean> {
  const result = await compile(source, {
    allowJs: true,
    fileName,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, target ? {} : result.importObject!);
  const init = instance.exports.__module_init as (() => void) | undefined;
  if (!init) return false;
  try {
    init();
    return false;
  } catch {
    return true;
  }
}

const expectInit = async (source: string, throws: boolean, fileName = "test.js") => {
  for (const target of ["standalone", undefined] as const)
    expect(await initThrows(source, fileName, target), `${target ?? "default"}: ${source}`).toBe(throws);
};

describe("#7519 — ordinary pipeline throws for every restricted global lexical", () => {
  it.each([
    ["class NaN {}"],
    ["class undefined {}"],
    ["let { a: NaN } = { a: 1 };"],
    ["let [Infinity] = [1];"],
    ["const { Infinity } = { Infinity: 1 };"],
    ["let NaN = 1;"],
  ])("throws at instantiation: %s", async (source) => {
    await expectInit(source, true);
  });

  it.each([["var NaN;"], ["{ let NaN = 1; }"], ["let x = 1;"], ["class C {}"]])(
    "does not throw: %s",
    async (source) => {
      await expectInit(source, false);
    },
  );

  it.each([["declare let NaN: number;"], ["declare class NaN {}"], ["declare const undefined: any;"]])(
    "an ambient declaration binds nothing: %s",
    async (source) => {
      await expectInit(source, false, "test.ts");
    },
  );
});
