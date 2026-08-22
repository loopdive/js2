// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource, type TypedAST } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { compile, type CompileResult } from "../src/index.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import type { IrObservedOutcome } from "../src/ir/outcomes.js";
import {
  buildIrModuleInitPlan,
  IrModuleInitPlanInvariantError,
  reconcileIrModuleInitPlan,
  verifyIrModuleInitPlan,
  type IrModuleInitPlan,
  type IrModuleInitTarget,
} from "../src/ir/module-init-plan.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// Register the statement/expression delegates used by generateModule.
import "../src/codegen/expressions.js";

function buildPlan(
  source: string,
  target: IrModuleInitTarget = "host",
  deferTopLevelInit = false,
): { readonly ast: TypedAST; readonly plan: IrModuleInitPlan } {
  const ast = analyzeSource(source, "module-init-plan.ts");
  const identityContext = buildIrPlanningIdentityContext(
    buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker }),
  );
  return {
    ast,
    plan: buildIrModuleInitPlan({
      sourceFile: ast.sourceFile,
      checker: ast.checker,
      identityContext,
      target,
      deferTopLevelInit,
    }),
  };
}

describe("#3523 source-ordered module-init planning", () => {
  it("builds exact binding, live-seed, export, static, and invocation intents", () => {
    const { plan } = buildPlan(
      `
        export let value: number = 1;
        function live(): number { return 1; }
        live = function replacement(): number { return 2; };
        value += live();
        class Box {
          static first: number = value++;
          static { value += 10; }
        }
        value += 100;
        export { value as alias };
      `,
      "host",
      true,
    );

    expect(plan.unitId).not.toBeNull();
    expect(plan.executable).toBe(true);
    expect(plan.invocation).toEqual({ target: "host", kind: "deferred-export", exactlyOnce: true });
    expect(plan.bindings).toEqual([
      expect.objectContaining({
        names: ["value"],
        declarationKind: "let",
        mutable: true,
        initialization: "tdz",
        globalBindingId: expect.stringContaining("ir-binding:v1:global:"),
        tdzBindingId: expect.stringContaining("ir-binding:v1:global:"),
      }),
    ]);
    expect(plan.liveSeeds).toEqual([
      expect.objectContaining({
        name: "live",
        callableBindingId: expect.stringContaining("ir-binding:v1:callable:"),
        liveGlobalBindingId: expect.stringContaining("ir-binding:v1:global:"),
      }),
    ]);
    expect(plan.evaluations.map((entry) => entry.kind)).toEqual([
      "variable-initializer",
      "statement",
      "statement",
      "class-static-field",
      "class-static-block",
      "statement",
    ]);
    expect(plan.evaluations.map((entry) => entry.sourceOrdinal)).toEqual([0, 1, 2, 3, 4, 5]);
    const valueExport = plan.exports.find((entry) => entry.externalName === "value");
    const aliasExport = plan.exports.find((entry) => entry.externalName === "alias");
    expect(valueExport?.targetBindingId).toBe(plan.bindings[0]!.globalBindingId);
    expect(aliasExport?.targetBindingId).toBe(valueExport?.targetBindingId);
    expect(plan.gaps).toEqual([]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.evaluations)).toBe(true);
  });

  it("makes empty modules explicit and derives each startup adapter before emission", () => {
    const empty = buildPlan(`export function read(): number { return 1; }`).plan;
    expect(empty).toMatchObject({ executable: false, unitId: null, invocation: { kind: "none" } });

    expect(buildPlan(`let x: number = 1;`, "host").plan.invocation.kind).toBe("wasm-start");
    expect(buildPlan(`let x: number = 1;`, "standalone", true).plan.invocation.kind).toBe("deferred-export");
    expect(buildPlan(`let x: number = 1;`, "wasi", true).plan.invocation.kind).toBe("wasi-start-export");
  });

  it("records capability gaps instead of dropping unmatched top-level semantics", () => {
    const destructuring = buildPlan(`let [first, second] = [1, 2];`).plan;
    expect(destructuring.gaps).toEqual([
      expect.objectContaining({ code: "destructuring-binding-abi", detail: expect.stringContaining("first, second") }),
    ]);
    expect(destructuring.evaluations).toHaveLength(1);

    const exportAssignment = buildPlan(`export default sideEffect();`).plan;
    expect(exportAssignment.evaluations.map((entry) => entry.kind)).toEqual(["export-assignment"]);
    expect(exportAssignment.gaps).toEqual([expect.objectContaining({ code: "missing-module-init-unit" })]);

    const forwardExport = buildPlan(`export { later }; function later(): number { return 1; }`).plan;
    expect(forwardExport.exports).toEqual([
      expect.objectContaining({
        externalName: "later",
        localName: "later",
        targetBindingId: expect.stringContaining("ir-binding:v1:callable:"),
      }),
    ]);
    expect(forwardExport.gaps).toEqual([]);
  });

  it("fails closed when a plan loses canonical order", () => {
    const { ast, plan } = buildPlan(`let x: number = 1; x += 2;`);
    const invalid = {
      ...plan,
      evaluations: [plan.evaluations[0]!, { ...plan.evaluations[1]!, sourceOrdinal: 0 }],
    } as IrModuleInitPlan;
    expect(() => verifyIrModuleInitPlan(invalid, ast.sourceFile)).toThrowError(
      expect.objectContaining<IrModuleInitPlanInvariantError>({ code: "non-canonical-order" }),
    );
  });
});

describe("#3523 direct-queue parity inventory", () => {
  it("aligns for an ordered statement-only module", () => {
    const { ast, plan } = buildPlan(`let x: number = 1; x += 2;`);
    const report = reconcileIrModuleInitPlan(plan, ast.sourceFile, {
      liveFunctionNames: [],
      staticEntries: [],
      moduleStatements: [...ast.sourceFile.statements],
    });
    expect(report).toMatchObject({
      aligned: true,
      plannedEntryCount: 2,
      legacyEntryCount: 2,
      missingFromLegacy: [],
      extraInLegacy: [],
      reordered: [],
    });
  });

  it("reports repeated legacy queue identities as extra work instead of failing compilation", () => {
    const { ast, plan } = buildPlan(`let x: number = 1;`);
    const statement = ast.sourceFile.statements[0]!;
    const report = reconcileIrModuleInitPlan(plan, ast.sourceFile, {
      liveFunctionNames: [],
      staticEntries: [],
      moduleStatements: [statement, statement],
    });
    expect(report).toMatchObject({
      aligned: false,
      plannedEntryCount: 1,
      legacyEntryCount: 2,
      missingFromLegacy: [],
      extraInLegacy: [report.plannedOrder[0]],
      reordered: [],
    });
  });

  it("keeps duplicated class-expression static queues observational", () => {
    const ast = analyzeSource(
      `var C = class { static #a = 1; static #b = 2; m() { return 42; } };`,
      "module-init-class-expression-duplicate.js",
    );
    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    });
    const evidence = generated.moduleInitPlanning;
    expect(evidence).toBeDefined();
    expect(evidence!.parity).toMatchObject({
      aligned: false,
      plannedEntryCount: 1,
      legacyEntryCount: 4,
      missingFromLegacy: [expect.stringMatching(/^statement:/)],
      reordered: [],
    });
    expect(evidence!.parity.extraInLegacy).toHaveLength(4);
    expect(new Set(evidence!.parity.extraInLegacy).size).toBe(2);
  });

  it("detects the legacy all-statics-before-statements reordering in production", () => {
    const ast = analyzeSource(
      `
        let value: number = 1;
        class Box {
          static first: number = value++;
          static { value += 10; }
        }
        value += 100;
      `,
      "module-init-production-plan.ts",
    );
    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    });
    const evidence = generated.moduleInitPlanning;
    expect(evidence).toBeDefined();
    expect(evidence!.plan).toMatchObject({
      executable: true,
      invocation: { target: "host", kind: "deferred-export", exactlyOnce: true },
    });
    expect(evidence!.parity.missingFromLegacy).toEqual([]);
    expect(evidence!.parity.extraInLegacy).toEqual([]);
    expect(evidence!.parity.aligned).toBe(false);
    expect(evidence!.parity.reordered.length).toBeGreaterThan(0);
    expect(evidence!.parity.plannedOrder[0]).toMatch(/^statement:/);
    expect(evidence!.parity.legacyOrder[0]).toMatch(/^static:/);
  });
});

/**
 * (#3523 R4 — Commit 3, first slice) The Prepared module initializer must be
 * reached by the ONE startup adapter its plan names, and must never also
 * compile a direct body.
 *
 * Before this slice the prepared exact-lexical owner accepted the host lane
 * only under `wasm-start`. Under `deferTopLevelInit` the identical source fell
 * back to the overlay model: the direct body was compiled TWICE (pass 1 +
 * pass 2) and then patched, so the terminal recorded `legacyBodyEmitted: true`
 * AND `irBodyEmitted: true` — never the `direct=0, IR=1` the acceptance
 * criteria require. The standalone lane already admitted `deferred-export`,
 * so the export-alias and TDZ machinery exercised below is shared, not new.
 *
 * Every assertion is paired with a control that must behave differently: a
 * green numeric initializer proves nothing on its own.
 */
describe("#3523 planned invocation policy owns prepared startup wiring", () => {
  const ADMITTED = `const memo = new Map<number, number>();
export function put(k: number, v: number): void { memo.set(k, v); }
export function size(): number { return memo.size; }
`;
  const ADMITTED_TDZ = `export function early(): number { return v; }
let v = 7;
export function late(): number { return v; }
`;
  // Rejected by the exact-lexical selector (string binding), so it stays on the
  // typed Unsupported route in every mode — the control for each claim below.
  const UNSUPPORTED = `const greeting = "hi";
export function get(): string { return greeting + "!"; }
`;

  function moduleInitOutcome(result: CompileResult): IrObservedOutcome {
    const rows = (result.irOutcomes ?? []).filter((outcome) => outcome.unitKind === "module-init");
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  function compileHost(source: string, deferTopLevelInit: boolean): Promise<CompileResult> {
    return compile(source, {
      fileName: "module-init-invocation.ts",
      trackIrOutcomes: true,
      ...(deferTopLevelInit ? { deferTopLevelInit: true } : {}),
    });
  }

  async function instantiate(result: CompileResult): Promise<Record<string, unknown>> {
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setInstance?.(instance);
    return instance.exports as Record<string, unknown>;
  }

  it("emits the deferred host initializer once through IR and never through the direct body", async () => {
    const deferred = moduleInitOutcome(await compileHost(ADMITTED, true));
    expect(deferred.kind).toBe("emitted");
    expect(deferred.legacyBodyEmitted).toBe(false);
    expect(deferred.irBodyEmitted).toBe(true);

    // The ordinary wasm-start lane already had this property; both host
    // startup modes must now agree, or the "matrix" claim is vacuous.
    const started = moduleInitOutcome(await compileHost(ADMITTED, false));
    expect(started.legacyBodyEmitted).toBe(false);
    expect(started.irBodyEmitted).toBe(true);

    // Control: a source the selector rejects still records the typed
    // Unsupported terminal and still emits the direct body, in BOTH modes.
    for (const deferTopLevelInit of [false, true]) {
      const control = moduleInitOutcome(await compileHost(UNSUPPORTED, deferTopLevelInit));
      expect(control.kind).toBe("unsupported");
      expect(control.legacyBodyEmitted).toBe(true);
      expect(control.irBodyEmitted).toBe(false);
    }
  });

  it("compiles no direct module-init body for a prepared deferred module (poison seam)", async () => {
    // `compileModuleInitBody` throws when this seam is armed, so a successful
    // compile is positive proof that the direct emitter never ran — the
    // `direct=0` half of `direct=0, IR=1`.
    const poison = "JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY";
    const previous = process.env[poison];
    process.env[poison] = "1";
    try {
      for (const deferTopLevelInit of [false, true]) {
        const prepared = await compileHost(ADMITTED, deferTopLevelInit);
        expect(prepared.success).toBe(true);

        // Control: the poison must actually be reachable. An Unsupported
        // module still routes through the direct emitter and therefore fails.
        const control = await compileHost(UNSUPPORTED, deferTopLevelInit);
        expect(control.success).toBe(false);
      }
    } finally {
      if (previous === undefined) delete process.env[poison];
      else process.env[poison] = previous;
    }
  });

  it("runs the deferred initializer only when the host calls it, and the start-section one at instantiation", async () => {
    // The two adapters are distinguished by OBSERVABLE timing, not by reading
    // the binary: under `wasm-start` the bindings are live immediately after
    // instantiation; under `deferred-export` they are still in TDZ until the
    // host calls the exported initializer.
    const deferred = await compileHost(ADMITTED_TDZ, true);
    expect(deferred.success).toBe(true);
    const deferredExports = await instantiate(deferred);
    expect(typeof deferredExports.__module_init).toBe("function");
    // TDZ is retained on the deferred lane: only wasm-start may elide it.
    expect(() => (deferredExports.late as () => number)()).toThrow();
    (deferredExports.__module_init as () => void)();
    expect((deferredExports.late as () => number)()).toBe(7);
    expect((deferredExports.early as () => number)()).toBe(7);

    const started = await compileHost(ADMITTED_TDZ, false);
    expect(started.success).toBe(true);
    const startedExports = await instantiate(started);
    // The start section already ran it, so there is no export to call and the
    // binding is live — the exact opposite of the deferred lane above.
    expect(startedExports.__module_init).toBeUndefined();
    expect((startedExports.late as () => number)()).toBe(7);
  });

  it("fails closed when a prepared module would be reached by both startup adapters", async () => {
    // Without this seam the invariant is untestable and therefore vacuous:
    // the two adapters are mutually exclusive by construction, so only an
    // injected double-wire proves the reconciliation actually runs.
    const seam = "JS2WASM_TEST_MODULE_INIT_DOUBLE_ADAPTER";
    const previous = process.env[seam];
    process.env[seam] = "1";
    try {
      for (const deferTopLevelInit of [false, true]) {
        const violated = await compileHost(ADMITTED, deferTopLevelInit);
        // Fatal, not a demotion: no direct replacement body is emitted and no
        // publishable artifact survives the reconciliation failure.
        expect(violated.success).toBe(false);
        expect(violated.errors.map((error) => error.message).join("\n")).toMatch(/exactly one startup adapter/);
        expect(violated.binary.length).toBe(0);
      }
      // Control: the seam only arms the Prepared route. An Unsupported module
      // keeps its established direct wiring and still compiles.
      const control = await compileHost(UNSUPPORTED, true);
      expect(control.success).toBe(true);
    } finally {
      if (previous === undefined) delete process.env[seam];
      else process.env[seam] = previous;
    }
  });
});
