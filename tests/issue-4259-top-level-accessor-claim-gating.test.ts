// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildIrUnitInventory, type IrTerminalUnitRecord, type IrUnitId } from "../src/ir/identity.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone"] as const;

function accessorUnits(source: string, fileName: string): readonly IrTerminalUnitRecord[] {
  const ast = analyzeSource(source, fileName);
  return buildIrUnitInventory([ast.sourceFile], {
    entrySource: ast.sourceFile,
    checker: ast.checker,
  }).terminalUnits.filter(
    (unit) =>
      unit.observedKind === "class-member" &&
      (unit.kind === "class-instance-getter" || unit.kind === "class-instance-setter"),
  );
}

function outcomeFor(result: CompileResult, unitId: IrUnitId): IrObservedOutcome {
  const outcomes = (result.irOutcomes ?? []).filter((outcome) => outcome.unitId === unitId);
  expect(outcomes, `outcome count for ${unitId}`).toHaveLength(1);
  return outcomes[0]!;
}

async function run(result: CompileResult): Promise<number> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  exports.__module_init?.();
  return exports.run!();
}

const PARTIALLY_CLAIMABLE_SOURCE = `
  var sink;
  class C {
    get x() { return 1; }
    set x(v) { sink = v; }
  }
  C.prototype["x"] = 2;
  export function run() { return sink === 2 ? 1 : 0; }
`;

const PREPARATION_WITHDRAWAL_SOURCE = `
  var sink;
  class C {
    get x() { return "get"; }
    set x(v) { sink = v; }
  }
  C.prototype["x"] = "set";
  export function run() { return sink === "set" ? 1 : 0; }
`;

describe("#4259 top-level accessor claim gating", () => {
  it.each(TARGETS)("keeps a partially claimable class atomically on the direct path in %s", async (target) => {
    const fileName = `issue-4259-top-level-claim-gating-${target}.ts`;
    const units = accessorUnits(PARTIALLY_CLAIMABLE_SOURCE, fileName);
    expect(units).toHaveLength(2);

    const result = await compile(PARTIALLY_CLAIMABLE_SOURCE, {
      fileName,
      experimentalIR: true,
      trackIrOutcomes: true,
      target,
      deferTopLevelInit: true,
      hostBridge: "always",
      skipSemanticDiagnostics: true,
      emitWat: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    for (const unit of units) {
      expect(outcomeFor(result, unit.id)).toMatchObject({
        kind: "unsupported",
        code: "class-member-unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(outcomeFor(result, unit.id)).not.toHaveProperty("preparedComponentId");
    }
    expect(result.wat).toMatch(/\(func \$C_set_x \(param \(ref null \d+\) f64\)/);
    expect(await run(result)).toBe(1);
  });

  it.each(TARGETS)("preserves the exact selected ABI when final preparation withdraws in %s", async (target) => {
    const fileName = `issue-4259-top-level-preparation-withdrawal-${target}.ts`;
    const units = accessorUnits(PREPARATION_WITHDRAWAL_SOURCE, fileName);
    expect(units).toHaveLength(2);

    const previous = process.env.JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE;
    let result: CompileResult;
    try {
      process.env.JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE = "1";
      result = await compile(PREPARATION_WITHDRAWAL_SOURCE, {
        fileName,
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
        deferTopLevelInit: true,
        hostBridge: "always",
        skipSemanticDiagnostics: true,
      });
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE");
      else process.env.JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE = previous;
    }

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    for (const unit of units) {
      expect(outcomeFor(result, unit.id)).toMatchObject({
        kind: "unsupported",
        code: "late-preparation-unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(outcomeFor(result, unit.id)).not.toHaveProperty("preparedComponentId");
    }
    expect(await run(result)).toBe(1);
  });
});
