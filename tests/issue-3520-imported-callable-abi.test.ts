// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { canonicalProgramAbiCallableTypeContract } from "../src/codegen/program-abi-signatures.js";
import { compile } from "../src/index.js";
import { irCallableBindingKey, irImportFuncRef } from "../src/ir/callable-bindings.js";
import type { Import } from "../src/ir/types.js";
import { buildImports } from "../src/runtime.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const SOURCE = `
  export function main(value: number): number {
    console.log(value);
    return value + 1;
  }
`;

function withPlannedImportResolverProbe<T>(run: () => T): T {
  const key = "JS2WASM_TEST_INJECT_IR_RESOLVER_FAILURE";
  const previous = process.env[key];
  process.env[key] = "planned-import";
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

function functionImportAt(imports: readonly Import[], functionIndex: number): Import | undefined {
  let current = 0;
  for (const imported of imports) {
    if (imported.desc.kind !== "func") continue;
    if (current++ === functionIndex) return imported;
  }
  return undefined;
}

async function runMain(value: number): Promise<{ readonly value: number; readonly logged: readonly number[] }> {
  const compiled = await compile(SOURCE, {
    experimentalIR: true,
    fileName: "imported-callable-abi.ts",
  });
  expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
  const logged: number[] = [];
  const imports = buildImports(
    compiled.imports,
    {
      console: {
        log: (loggedValue: number) => logged.push(loggedValue),
      },
    },
    compiled.stringPool,
  );
  const { instance } = await WebAssembly.instantiate(compiled.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return {
    value: Number((instance.exports.main as (input: number) => number)(value)),
    logged,
  };
}

describe("#3520 production imported-callable Program ABI planning", () => {
  it("resolves a relabelled import structurally and publishes its exact post-DCE import slot", async () => {
    const ast = analyzeSource(SOURCE, "imported-callable-abi.ts");
    const result = withPlannedImportResolverProbe(() =>
      generateModule(ast, {
        experimentalIR: true,
        trackIrOutcomes: true,
      }),
    );

    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.irCompiledFuncs).toContain("main");
    expect(result.irPostClaimErrors).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const ref = irImportFuncRef("env", "console_log_number", "__untrusted_import_label");
    const structuralReferenceKey = irCallableBindingKey(ref.binding);
    const entries = result
      .programAbi!.abi.entries()
      .filter((entry) => entry.structuralReferenceKey === structuralReferenceKey);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry).toMatchObject({
      displayName: "console_log_number",
      structuralReferenceKey,
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "import",
      },
    });
    if (entry.intent.kind !== "callable") {
      throw new Error("missing exact imported-callable ABI entry");
    }

    const finalIndex = result.programAbi!.abi.resolveFinalIndex(entry.id);
    expect(finalIndex).toEqual(expect.objectContaining({ space: "function" }));
    if (!finalIndex || finalIndex.space !== "function") {
      throw new Error("missing final imported-callable slot");
    }
    const imported = functionImportAt(result.module.imports, finalIndex.index);
    expect(imported).toMatchObject({
      module: "env",
      name: "console_log_number",
      desc: { kind: "func" },
    });
    if (!imported || imported.desc.kind !== "func") {
      throw new Error("missing exact final function import object");
    }
    const signature = result.module.types[imported.desc.typeIdx];
    expect(signature).toEqual(expect.objectContaining({ kind: "func" }));
    if (!signature || signature.kind !== "func") {
      throw new Error("missing final imported-callable signature");
    }
    expect(canonicalProgramAbiCallableTypeContract(signature)).toEqual(entry.intent.signature);

    expect(await runMain(41)).toEqual({ value: 42, logged: [41] });
  });
});
