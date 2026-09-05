// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4515 — standalone `in` membership over the Object/fnctor prototype chain.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface StandaloneOutcome {
  result: number;
  imports: string[];
}

async function runStandalone(sourceBody: string): Promise<StandaloneOutcome> {
  const compiled = await compile(`${sourceBody}\nexport function test(): number { return result as number; }\n`, {
    allowJs: true,
    fileName: "issue-4515-in-prototype-chain.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
    inferModuleStrictArguments: false,
  });
  expect(compiled.success, compiled.errors.map((error) => error.message).join("; ")).toBe(true);
  const imports = (compiled.imports ?? []).map((entry: unknown) =>
    typeof entry === "string" ? entry : `${(entry as { module: string }).module}::${(entry as { name: string }).name}`,
  );
  const { instance } = await WebAssembly.instantiate(compiled.binary, {});
  (instance.exports as Record<string, unknown> & { __module_init?: () => void }).__module_init?.();
  return {
    result: (instance.exports as Record<string, () => number>).test(),
    imports,
  };
}

describe("#4515 — standalone `in` prototype-chain fixes", () => {
  it("sees Object.prototype.valueOf on an ordinary open object", async () => {
    const outcome = await runStandalone(`var result = 0;\nvar object = {};\nresult = "valueOf" in object ? 1 : 0;`);
    expect(outcome.result).toBe(1);
    expect(outcome.imports).toEqual([]);
  });

  it("does not invent Object.prototype on Object.create(null)", async () => {
    const outcome = await runStandalone(
      `var result = 0;\nvar object = Object.create(null);\nresult = "valueOf" in object ? 1 : 0;`,
    );
    expect(outcome.result).toBe(0);
    expect(outcome.imports).toEqual([]);
  });

  it("walks a user fnctor's per-constructor prototype object", async () => {
    const outcome = await runStandalone(
      `var result = 0;\n` +
        `var proto = { phylum: "avis" };\n` +
        `function Robin() { this.name = "robin"; }\n` +
        `Robin.prototype = proto;\n` +
        `var robin = new Robin();\n` +
        `result = (("phylum" in robin) ? 10 : 0) + (robin.hasOwnProperty("phylum") ? 1 : 0);`,
    );
    expect(outcome.result).toBe(10);
    expect(outcome.imports).toEqual([]);
  });

  it("preserves an object-valued constructor alias in evaluation order", async () => {
    const outcome = await runStandalone(
      `var result = 0;\nvar NUMBER = 0;\nresult = (NUMBER = Number, "MAX_VALUE") in NUMBER ? 1 : 0;`,
    );
    expect(outcome.result).toBe(1);
    expect(outcome.imports).toEqual([]);
  });
});
