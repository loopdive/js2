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
  it("keeps declaration bindings independent from the population-wide evaluation order", () => {
    const { ast, plan } = buildPlan(`let total: number = 0; total = total + 1;`);
    const bindingId = plan.bindings[0]?.globalBindingId;
    expect(bindingId).toEqual(expect.stringContaining("ir-binding:v1:global:"));
    expect(plan.bindings).toEqual([
      expect.objectContaining({
        declarationOrdinal: 0,
        names: ["total"],
        declarationKind: "let",
        mutable: true,
        initialization: "tdz",
        globalBindingId: bindingId,
        tdzBindingId: expect.stringContaining("ir-binding:v1:global:"),
      }),
    ]);
    expect(plan.evaluations).toEqual([
      expect.objectContaining({
        kind: "variable-initializer",
        sourceOrdinal: 0,
        statementOrdinal: 0,
        bindingIds: [bindingId],
      }),
      expect.objectContaining({
        kind: "statement",
        sourceOrdinal: 1,
        statementOrdinal: 1,
        bindingIds: [],
      }),
    ]);
    expect(
      reconcileIrModuleInitPlan(plan, ast.sourceFile, {
        liveFunctionNames: [],
        staticEntries: [],
        moduleStatements: [...ast.sourceFile.statements],
      }),
    ).toMatchObject({ aligned: true, plannedEntryCount: 2, legacyEntryCount: 2 });
  });

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

    // (#5332) This rung used to pin `missing-module-init-unit` here. That gap
    // was not a capability limit of the PLAN — it was identity failing to mint
    // a module-init terminal for a source whose only top-level statement is an
    // export assignment, while this plan (correctly, matching the direct
    // front-end queue) counts one as an evaluation. #3525's census turned that
    // disagreement into a hard `terminal-join` error, so
    // `export default <anything>;` in a multi-file project stopped compiling
    // outright. Identity now owns the terminal, so the join succeeds and the
    // gap is gone. `missing-module-init-unit` stays in the plan as a
    // fail-closed guard; no ordinary source shape reaches it any more.
    const exportAssignment = buildPlan(`export default sideEffect();`).plan;
    expect(exportAssignment.evaluations.map((entry) => entry.kind)).toEqual(["export-assignment"]);
    expect(exportAssignment.executable).toBe(true);
    expect(exportAssignment.unitId).not.toBeNull();
    expect(exportAssignment.gaps).toEqual([]);

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

  // Until `8f161cbf1` (which added `src/codegen/class-expression-static-init.ts`)
  // a variable-bound class expression pushed its statics onto the MODULE-level
  // `staticInitExprs` queue, and did so twice — once under the source binding
  // and once under the synthetic identity. The legacy order for the source
  // below was therefore `[static:28:29, static:43:44, static:28:29,
  // static:43:44]` — four entries, two distinct — with the owning statement
  // missing entirely, and this test pinned that divergence as observational.
  //
  // Class-expression statics now execute as part of ClassDefinitionEvaluation
  // at the exact expression site (the expression-owned queue), so the
  // module-level ordered queue holds exactly the one statement the plan
  // predicts. Verified beyond the parity report: for a module that interleaves
  // `log` writes with a class expression whose two statics also write `log`,
  // both lanes observe `1234` and read the static values back as `5`/`6` — the
  // statics still run, at the right point in source order.
  it("aligns the class-expression static queue with the planned statement entry", () => {
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
      aligned: true,
      plannedEntryCount: 1,
      legacyEntryCount: 1,
      missingFromLegacy: [],
      extraInLegacy: [],
      reordered: [],
    });
    // The single entry is the owning statement, not a static — no
    // module-level static entry survives for a class EXPRESSION.
    expect(evidence!.parity.legacyOrder).toEqual([expect.stringMatching(/^statement:/)]);
    expect(evidence!.parity.legacyOrder).toEqual(evidence!.parity.plannedOrder);
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
  // A module-init population the IR still declines, so the direct emitter owns
  // it. The declaration is an OBJECT LITERAL, not the string const this fixture
  // used until #3523 R4-M1 — a string module binding is representable storage
  // now, so a string const stopped being an "unsupported" fixture and this
  // block silently started asserting the opposite of its own name.
  const UNSUPPORTED = `const config = { n: 1 };
export function get(): number { return config.n + 1; }
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
        expect(violated.errors.map((error) => error.message).join("\n")).toMatch(
          /exactly one startup adapter|no declaration-time startup adapter/,
        );
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

describe("#3523 exact scalar assignment stays inside the prepared module-init transaction", () => {
  const SOURCE = `let total: number = 0;
total = total + 1;
export function read(): number { return total; }
`;

  // (#3523 R4 gap 2b) The scalar-statement operator family the prepared
  // transaction owns. Every row's expected value is one only the ASSIGNMENT
  // can produce — initializer-only execution returns the declared value — so a
  // silently dropped statement fails on the number, not merely on an outcome
  // row. The last two rows are the sub-B cases: a declaration AFTER an
  // assignment, which the retired `sawAssignment` rule refused for order alone.
  const ADMITTED_SHAPES = [
    { name: "postfix increment", body: `let n: number = 0;\nn++;`, read: `n`, expected: 1 },
    { name: "prefix increment", body: `let n: number = 0;\n++n;`, read: `n`, expected: 1 },
    { name: "postfix decrement", body: `let n: number = 5;\nn--;`, read: `n`, expected: 4 },
    { name: "prefix decrement", body: `let n: number = 5;\n--n;`, read: `n`, expected: 4 },
    { name: "plus-equals", body: `let n: number = 0;\nn += 2;`, read: `n`, expected: 2 },
    { name: "minus-equals", body: `let n: number = 5;\nn -= 2;`, read: `n`, expected: 3 },
    { name: "times-equals", body: `let n: number = 5;\nn *= 3;`, read: `n`, expected: 15 },
    { name: "divide-equals", body: `let n: number = 8;\nn /= 2;`, read: `n`, expected: 4 },
    { name: "binary minus", body: `let n: number = 5;\nn = n - 2;`, read: `n`, expected: 3 },
    { name: "binary times", body: `let n: number = 5;\nn = n * 3;`, read: `n`, expected: 15 },
    { name: "binary divide", body: `let n: number = 8;\nn = n / 2;`, read: `n`, expected: 4 },
    { name: "plain numeric literal", body: `let n: number = 0;\nn = 7;`, read: `n`, expected: 7 },
    { name: "sequential compounds", body: `let n: number = 5;\nn -= 2;\nn *= 3;`, read: `n`, expected: 9 },
    { name: "sequential binaries", body: `let n: number = 5;\nn = n - 2;\nn = n * 3;`, read: `n`, expected: 9 },
    {
      name: "declaration after assignment",
      body: `let total: number = 0;\ntotal = total + 1;\nlet later: number = 2;`,
      read: `total * 10 + later`,
      expected: 12,
    },
    {
      name: "interleaved declarations and updates",
      body: `let n: number = 0;\nn++;\nlet k: number = 4;\nk--;`,
      read: `n * 10 + k`,
      expected: 13,
    },
  ] as const;

  function admittedSource(shape: (typeof ADMITTED_SHAPES)[number]): string {
    return `${shape.body}\nexport function read(): number { return ${shape.read}; }\n`;
  }
  const lanes = [
    { name: "host-start", target: "gc" as const, deferTopLevelInit: false },
    { name: "host-deferred", target: "gc" as const, deferTopLevelInit: true },
    { name: "standalone-start", target: "standalone" as const, deferTopLevelInit: false },
    { name: "standalone-deferred", target: "standalone" as const, deferTopLevelInit: true },
    // (#3523 R4 gap 3) WASI is the fifth admitted lane. Its startup adapter is
    // neither the `start` section nor a `__module_init` export: it is the one
    // `_start` export, and the body carries the `__init_done` idempotence guard
    // planted at preparation. `deferTopLevelInit` is not a WASI axis —
    // `exportModuleInit` is `deferTopLevelInit && !wasi` — so one row covers it.
    { name: "wasi-start-export", target: "wasi" as const, deferTopLevelInit: false },
  ];

  function compileLane(
    source: string,
    lane: (typeof lanes)[number],
    skipSemanticDiagnostics = false,
    optimize: false | undefined = undefined,
  ): Promise<CompileResult> {
    return compile(source, {
      fileName: `issue-3523-scalar-${lane.name}.ts`,
      target: lane.target,
      deferTopLevelInit: lane.deferTopLevelInit,
      experimentalIR: true,
      trackFallbacks: true,
      trackIrOutcomes: true,
      emitWat: false,
      ...(skipSemanticDiagnostics ? { skipSemanticDiagnostics: true } : {}),
      ...(optimize === false ? { optimize: false } : {}),
    });
  }

  function scalarModuleInitOutcome(result: CompileResult): IrObservedOutcome {
    const rows = (result.irOutcomes ?? []).filter((outcome) => outcome.unitKind === "module-init");
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function instantiateLane(
    result: CompileResult,
    lane: (typeof lanes)[number],
  ): Promise<Record<string, unknown>> {
    if (lane.target === "standalone" || lane.target === "wasi") {
      const { instance } = await WebAssembly.instantiate(result.binary, {});
      return instance.exports as Record<string, unknown>;
    }
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setInstance?.(instance);
    return instance.exports as Record<string, unknown>;
  }

  async function directPoisonEvidence(source: string, target: "gc" | "wasi" = "gc"): Promise<string> {
    try {
      const result = await compile(source, {
        fileName: `issue-3523-scalar-control-${target}.ts`,
        target,
        experimentalIR: true,
        trackFallbacks: true,
        trackIrOutcomes: true,
        emitWat: false,
        skipSemanticDiagnostics: true,
      });
      expect(result.success).toBe(false);
      return result.errors.map((error) => error.message).join("\n");
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it("routes every host/standalone/WASI adapter through one genuine IR component", async () => {
    for (const lane of lanes) {
      const result = await compileLane(SOURCE, lane);
      expect(result.success, `${lane.name}: ${result.errors.map((error) => error.message).join("\n")}`).toBe(true);
      expect(scalarModuleInitOutcome(result)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      expect(new Set(result.irCompiledFuncs ?? [])).toContain("<module-init>");
      expect((result.irPostClaimErrors ?? []).filter((error) => error.func === "<module-init>")).toEqual([]);

      const exports = await instantiateLane(result, lane);
      const read = exports.read as () => number;
      if (lane.deferTopLevelInit) {
        expect(typeof exports.__module_init).toBe("function");
        expect(read).toThrow();
        (exports.__module_init as () => void)();
      } else {
        expect(exports.__module_init).toBeUndefined();
      }
      // The value, not merely an outcome row, proves that the later statement
      // was lowered. Initializer-only execution would return zero.
      expect(read()).toBe(1);
      expect(read()).toBe(1);
    }
  });

  it("is structural rather than allowlisted to one name, literal, or assignment count", async () => {
    const variants = [
      {
        name: "renamed binding and different literal",
        source: `let score = 10; score = score + 7; export function read(): number { return score; }`,
        expected: 17,
      },
      {
        name: "two independently assigned declarations",
        source: `let left = 1; let right = 2; left = left + 3; right = right + 4;
export function read(): number { return left * 10 + right; }`,
        expected: 46,
      },
      {
        name: "unrelated const before the assigned let",
        source: `const offset = 4; let total = 1; total = total + 2;
export function read(): number { return offset * 10 + total; }`,
        expected: 43,
      },
      {
        name: "multiple sequential assignments",
        source: `let value = 0; value = value + 2; value = value + 3;
export function read(): number { return value; }`,
        expected: 5,
      },
      // (#3523 R4 gap 2b) Source order is proven per entry, so a declaration
      // may follow an assignment. The retired `sawAssignment` rule refused
      // this for ordering alone even though the plan zips bindings by
      // `declarationOrdinal` and evaluations by population ordinal.
      {
        name: "declaration after an assignment",
        source: `let total = 0; total = total + 1; let later = 2;
export function read(): number { return total * 10 + later; }`,
        expected: 12,
      },
      {
        name: "declarations interleaved with updates",
        source: `let first = 0; first++; let second = 4; second--;
export function read(): number { return first * 10 + second; }`,
        expected: 13,
      },
    ] as const;
    for (const variant of variants) {
      const result = await compileLane(variant.source, lanes[2]!);
      expect(result.success, variant.name).toBe(true);
      expect(scalarModuleInitOutcome(result)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      const exports = await instantiateLane(result, lanes[2]!);
      expect((exports.read as () => number)(), variant.name).toBe(variant.expected);
    }
  });

  // (#3523 R4 gap 2b) The operator family is the slice's whole behavior claim:
  // each shape must be prepared-owned on every lane AND produce a value only
  // the assignment can produce. The deferred lanes additionally prove the
  // statement runs at `__module_init`, not at instantiation.
  it("owns the whole scalar-statement operator family on every lane", async () => {
    for (const shape of ADMITTED_SHAPES) {
      const source = admittedSource(shape);
      for (const lane of lanes) {
        const label = `${shape.name} / ${lane.name}`;
        const result = await compileLane(source, lane);
        expect(result.success, `${label}: ${result.errors.map((error) => error.message).join("\n")}`).toBe(true);
        expect(scalarModuleInitOutcome(result), label).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
        expect(new Set(result.irCompiledFuncs ?? []), label).toContain("<module-init>");

        const exports = await instantiateLane(result, lane);
        const read = exports.read as () => number;
        if (lane.deferTopLevelInit) {
          expect(typeof exports.__module_init, label).toBe("function");
          expect(read, label).toThrow();
          (exports.__module_init as () => void)();
        } else {
          expect(exports.__module_init, label).toBeUndefined();
        }
        expect(read(), label).toBe(shape.expected);
        expect(read(), label).toBe(shape.expected);
      }
    }
    // 16 shapes x 5 lanes of real compiles; the default 35s budget is for
    // single-compile tests.
  }, 300000);

  it("keeps the exact standalone candidate prepared without Binaryen optimization", async () => {
    const lane = lanes[2]!;
    const result = await compileLane(SOURCE, lane, false, false);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(scalarModuleInitOutcome(result)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    const exports = await instantiateLane(result, lane);
    expect((exports.read as () => number)()).toBe(1);
  });

  it("never reaches the direct emitter in any admitted lane", async () => {
    const poison = "JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY";
    const previous = process.env[poison];
    process.env[poison] = "1";
    try {
      // (#3523 R4 gap 2b) Every shape of the admitted operator family, not
      // only the landed `total = total + 1`. A shape that still compiled a
      // direct body would trip the poison and fail its compile.
      for (const source of [SOURCE, ...ADMITTED_SHAPES.map(admittedSource)]) {
        for (const lane of lanes) {
          const result = await compileLane(source, lane);
          expect(result.success, `${lane.name}: ${result.errors.map((error) => error.message).join("\n")}`).toBe(true);
          expect(scalarModuleInitOutcome(result)).toMatchObject({
            kind: "emitted",
            legacyBodyEmitted: false,
            irBodyEmitted: true,
          });
        }
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, poison);
      else process.env[poison] = previous;
    }
    // 17 sources x 5 lanes of real compiles under the poison seam.
  }, 300000);

  it("fails closed for every near-miss grammar and binding-identity mutation", async () => {
    const controls = [
      ["const target", `const total: number = 0; total = total + 1;`],
      // (#3523 R4 gap 2b) `total += 1`, `total++`, `total = total - 1` and
      // `let total = 0; total = total + 1; let later = 2` used to sit here.
      // They are now ADMITTED; their green-under-poison proof lives in "never
      // reaches the direct emitter in any admitted lane". What replaces them
      // are the boundaries of the widened grammar — the operators the two
      // allowlists deliberately omit, the fixed operand order, the
      // non-numeric storage kind, and statement-subtree admission.
      ["exponent compound", `let total: number = 2; total **= 2;`],
      ["remainder compound", `let total: number = 7; total %= 3;`],
      ["bitwise-or compound", `let total: number = 0; total |= 1;`],
      ["shift compound", `let total: number = 1; total <<= 1;`],
      ["literal-first operand order", `let total: number = 0; total = 1 + total;`],
      ["boolean-branded increment", `let flag = true; flag++;`],
      ["statement-subtree body", `let total: number = 0; for (let i = 0; i < 3; i++) { total = total + i; }`],
      ["parenthesized RHS", `let total: number = 0; total = (total + 1);`],
      ["nonnumeric literal", `let total: number = 0; total = total + "1";`],
      ["forward target", `total = total + 1; let total: number = 0;`],
      ["unknown target", `missing = missing + 1;`],
      ["missing initializer", `let total: number; total = total + 1;`],
      ["different binding RHS", `let total: number = 0; let other: number = 0; total = other + 1;`],
      ["property LHS", `const box = { value: 0 }; box.value = box.value + 1;`],
      [
        "local call RHS",
        `function bump(value: number): number { return value + 1; } let total = 0; total = bump(total);`,
      ],
      ["var declaration", `var total: number = 0; total = total + 1;`],
      ["destructuring", `let [total] = [0]; total = total + 1;`],
      ["multiple declarations", `let total: number = 0, other: number = 1; total = total + 1;`],
    ] as const;
    const poison = "JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY";
    const previous = process.env[poison];
    process.env[poison] = "1";
    try {
      for (const [name, source] of controls) {
        expect(await directPoisonEvidence(source), name).toContain("injected direct module-init body poison");
      }
      // (#3523 R4 gap 3) WASI used to sit here as a near-miss control: the
      // selector refused it, so the admitted grammar still reached the direct
      // emitter and tripped the poison. It is now an ADMITTED lane, and its
      // green-under-poison proof lives in "never reaches the direct emitter in
      // any admitted lane" above. The near-miss GRAMMAR controls still run on
      // the gc lane, so this test keeps every assertion it was written for.
      // (#3523 R4 gap 2b) `total += 1` was the WASI row here; it is now
      // admitted, so the WASI near-miss carries a grammar the widened
      // predicate still refuses.
      expect(
        await directPoisonEvidence(`let total: number = 2; total **= 2;`, "wasi"),
        "WASI exponent compound",
      ).toContain("injected direct module-init body poison");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, poison);
      else process.env[poison] = previous;
    }
  });

  it("fails fatally if the prepared statement component is wired to two startup adapters", async () => {
    const seam = "JS2WASM_TEST_MODULE_INIT_DOUBLE_ADAPTER";
    const previous = process.env[seam];
    process.env[seam] = "1";
    try {
      for (const lane of lanes) {
        const violated = await compileLane(SOURCE, lane);
        expect(violated.success, lane.name).toBe(false);
        expect(violated.errors.map((error) => error.message).join("\n")).toMatch(
          /exactly one startup adapter|no declaration-time startup adapter/,
        );
        expect(violated.binary.length).toBe(0);
      }
      // (#3523 R4 gap 2b) The control has to be a shape that STAYS overlay,
      // or it proves nothing about the seam. `total += 1` was admitted by this
      // slice; a `for` body is statement-subtree admission — a later slice —
      // and is measured overlay on every lane.
      const control = await compileLane(`let total = 0; for (let i = 0; i < 3; i++) { total = total + i; }`, lanes[1]!);
      expect(control.success).toBe(true);
      expect(scalarModuleInitOutcome(control).legacyBodyEmitted).toBe(true);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, seam);
      else process.env[seam] = previous;
    }
  });
});
