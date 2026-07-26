// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeMultiSource } from "../src/checker/index.js";
import { generateMultiModule } from "../src/codegen/index.js";
import { canonicalProgramAbiCallableTypeContract } from "../src/codegen/program-abi-signatures.js";
import { irSupportFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";

// Register the codegen expression/statement delegates used by generateMultiModule.
import "../src/codegen/expressions.js";

const HOF_SOURCE = `
  export function apply(fn: () => number): number { return fn() + 1; }
  export function identical(a: () => number, b: () => number): number {
    try { return a === b ? 1 : 0; } catch (_) { return 0; }
  }
`;

function generateEntry(entrySource: string) {
  const ast = analyzeMultiSource(
    {
      "hof.ts": HOF_SOURCE,
      "entry.ts": entrySource,
    },
    "entry.ts",
  );
  const inventory = buildIrUnitInventory(ast.sourceFiles, {
    entrySource: ast.entryFile,
    checker: ast.checker,
  });
  const target = inventory.allUnits.find(
    (unit) => unit.kind === "top-level-function" && unit.displayName === "fortyOne",
  );
  if (!target) throw new Error("missing exact fortyOne source unit");
  const supportRef = irSupportFuncRef(target.id, "function-value-trampoline", "__fn_tramp_fortyOne_cached");
  const result = generateMultiModule(ast, {
    experimentalIR: true,
    trackIrOutcomes: true,
  });
  return { result, supportRef, targetUnitId: target.id };
}

function withPlannedSupportResolverProbe<T>(run: () => T): T {
  const key = "JS2WASM_TEST_INJECT_IR_RESOLVER_FAILURE";
  const previous = process.env[key];
  process.env[key] = "planned-support";
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

describe("#3520 production support-callable Program ABI planning", () => {
  it("resolves a misleading support label and publishes the exact post-DCE trampoline signature", () => {
    const { result, supportRef, targetUnitId } = withPlannedSupportResolverProbe(() =>
      generateEntry(`
        import { apply, identical } from "./hof.ts";
        function fortyOne(): number { return 41; }
        export function main(): number {
          return apply(fortyOne) + identical(fortyOne, fortyOne);
        }
      `),
    );

    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.irCompiledFuncs).toContain("main");
    expect(result.irPostClaimErrors).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const publication = result.programAbi!;
    const entry = publication.abi.entries().find((candidate) => candidate.id === supportRef.binding.bindingId);
    expect(entry).toMatchObject({
      id: supportRef.binding.bindingId,
      displayName: supportRef.name,
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "support",
        unitId: targetUnitId,
      },
    });
    if (!entry || entry.intent.kind !== "callable") {
      throw new Error("missing function-value trampoline ABI entry");
    }

    const finalIndex = publication.abi.resolveFinalIndex(entry.id);
    expect(finalIndex).toEqual(expect.objectContaining({ space: "function" }));
    if (!finalIndex || finalIndex.space !== "function") {
      throw new Error("missing final function-value trampoline slot");
    }
    const importCount = result.module.imports.filter((candidate) => candidate.desc.kind === "func").length;
    const trampoline = result.module.functions[finalIndex.index - importCount];
    expect(trampoline?.name).toBe(supportRef.name);
    const signature = trampoline ? result.module.types[trampoline.typeIdx] : undefined;
    expect(signature).toEqual(expect.objectContaining({ kind: "func" }));
    if (!signature || signature.kind !== "func") {
      throw new Error("missing final function-value trampoline signature");
    }
    expect(signature.params.some((param) => param.kind === "ref" || param.kind === "ref_null")).toBe(true);
    expect(canonicalProgramAbiCallableTypeContract(signature)).toEqual(entry.intent.signature);
  });

  it("publishes no support callable when a source-name collision demotes the owner", () => {
    const { result, supportRef } = generateEntry(`
      import { apply } from "./hof.ts";
      function fortyOne(): number { return 41; }
      function __fn_tramp_fortyOne_cached(): number { return -1; }
      export function main(): number { return apply(fortyOne); }
    `);

    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.irCompiledFuncs ?? []).not.toContain("main");
    expect(result.irPostClaimErrors).toEqual([]);
    expect(result.programAbi).toBeDefined();
    expect(
      result
        .programAbi!.abi.entries()
        .filter(
          (entry) =>
            entry.id === supportRef.binding.bindingId ||
            (entry.intent.kind === "callable" &&
              entry.intent.origin === "support" &&
              entry.displayName === supportRef.name),
        ),
    ).toEqual([]);
  });
});
