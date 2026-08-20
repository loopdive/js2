import { describe, expect, it } from "vitest";
import { compile, compileMulti, createIncrementalCompiler } from "../src/index.js";
import { IR_COMPILE_ROUTE_MANIFEST } from "../src/ir/standalone-route-manifest.js";

const SHAPE_SOURCE = `
const top = 1;
export function main(): number {
  class C { m(): number { return 2; } }
  function nested(): number { return 3; }
  const arrow = (): number => 4;
  return new C().m() + nested() + arrow() + top;
}
`;

const DERIVED_ASYNC_SOURCE = `
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

describe("standalone physical IR cutover audit", () => {
  it("keeps the public route catalog exhaustive and target-generator specific", () => {
    expect(IR_COMPILE_ROUTE_MANIFEST).toEqual({
      compile: { graph: "single", generator: "generateModule" },
      compileSourceSync: { graph: "single", generator: "generateModule" },
      compileMulti: { graph: "multi", generator: "generateMultiModule" },
      compileFiles: { graph: "multi", generator: "generateMultiModule" },
      compileProject: { graph: "multi", generator: "generateMultiModule" },
      "incremental.compile": { graph: "single", generator: "generateModule" },
      "incremental.compileMulti": { graph: "multi", generator: "generateMultiModule" },
    });
  });

  it("is opt-in and has no effect on ordinary result shape", async () => {
    const result = await compile(`export function main(): number { return 1; }`, {
      fileName: "audit-off.ts",
      target: "standalone",
    });
    expect(result.success).toBe(true);
    expect(result.irBodyRouteAudit).toBeUndefined();
  });

  it.each(["gc", "wasi", "standalone"] as const)(
    "records exhaustive direct-body evidence without confusing the %s target",
    async (target) => {
      const result = await compile(SHAPE_SOURCE, {
        fileName: `audit-${target}.ts`,
        target,
        experimentalIR: false,
        trackIrOutcomes: true,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

      const audit = result.irBodyRouteAudit!;
      expect(audit).toBeDefined();
      expect(audit.route).toBe("compile");
      expect(audit.target).toBe(target);
      expect(audit.graph).toBe("single");
      expect(audit.generator).toBe("generateModule");
      expect(audit.sourceCount).toBe(1);
      expect(audit.classes).toHaveLength(audit.classCount);
      expect(new Set(audit.classes.map((record) => record.id)).size).toBe(audit.classCount);
      expect(audit.allUnitCount).toBe(audit.dispositions.length);
      expect(new Set(audit.dispositions.map((row) => row.unitId)).size).toBe(audit.allUnitCount);
      expect(audit.legacyEntries.length).toBeGreaterThan(0);
      expect(audit.legacyEntries.every((entry) => entry.target === target && entry.count > 0)).toBe(true);

      const entryPoints = new Set(audit.legacyEntries.map((entry) => entry.entryPoint));
      for (const required of [
        "compileDeclarations",
        "compileModuleInitBody",
        "compileFunctionBody",
        "compileClassBodies",
        "compileNestedClassDeclaration",
        "compileNestedFunctionDeclaration",
        "compileArrowAsClosure",
        "compileLiftedClosureBody",
      ] as const) {
        expect(entryPoints.has(required), `missing ${required}`).toBe(true);
      }
      expect(audit.dispositions.some((row) => row.disposition === "legacy-ast-entry")).toBe(true);
      expect(audit.structurallyComplete, audit.violations.map((violation) => violation.detail).join("\n")).toBe(true);
    },
  );

  it("distinguishes IR terminal ownership from the still-live declaration route", async () => {
    const result = await compile(`export function main(x: number): number { return x + 1; }`, {
      fileName: "audit-ir.ts",
      target: "standalone",
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(true);

    const audit = result.irBodyRouteAudit!;
    expect(audit.route).toBe("compile");
    expect(audit.dispositions).toHaveLength(1);
    expect(audit.dispositions[0]?.disposition).toBe("terminal-ir");
    expect(audit.legacyEntries.some((entry) => entry.entryPoint === "compileFunctionBody")).toBe(false);
    expect(audit.legacyEntries.some((entry) => entry.entryPoint === "compileDeclarations")).toBe(true);
  });

  it("labels the linked generator and preserves every source in the denominator", async () => {
    const result = await compileMulti(
      {
        "dep.ts": `export function dep(x: number): number { return x + 1; }`,
        "empty.ts": `export type Marker = number;`,
        "entry.ts": `import { dep } from "./dep"; export function main(): number { return dep(2); }`,
      },
      "entry.ts",
      { target: "standalone", experimentalIR: false, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const audit = result.irBodyRouteAudit!;
    expect(audit.route).toBe("compileMulti");
    expect(audit.graph).toBe("multi");
    expect(audit.generator).toBe("generateMultiModule");
    expect(audit.sourceCount).toBe(3);
    expect(audit.sources).toHaveLength(3);
    expect(audit.allUnitCount).toBe(audit.dispositions.length);
    expect(new Set(audit.sources.map((source) => source.id)).size).toBe(3);
    expect(audit.sources.some((source) => source.sourceKey.endsWith("empty.ts"))).toBe(true);
  });

  it("keeps incremental single and multi audit sessions isolated", async () => {
    const incremental = createIncrementalCompiler({
      target: "standalone",
      experimentalIR: false,
      trackIrOutcomes: true,
    });
    try {
      const first = await incremental.compile(`export function one(): number { return 1; }`, {
        fileName: "incremental-one.ts",
      });
      const second = await incremental.compile(`export function two(): number { return 2; }`, {
        fileName: "incremental-two.ts",
      });
      expect(first.irBodyRouteAudit?.route).toBe("incremental.compile");
      expect(second.irBodyRouteAudit?.route).toBe("incremental.compile");
      expect(first.irBodyRouteAudit?.legacyEntries.some((entry) => entry.bodyName === "one")).toBe(true);
      expect(first.irBodyRouteAudit?.legacyEntries.some((entry) => entry.bodyName === "two")).toBe(false);
      expect(second.irBodyRouteAudit?.legacyEntries.some((entry) => entry.bodyName === "two")).toBe(true);
      expect(second.irBodyRouteAudit?.legacyEntries.some((entry) => entry.bodyName === "one")).toBe(false);

      const linked = await incremental.compileMulti(
        {
          "dep.ts": `export function dep(): number { return 1; }`,
          "entry.ts": `import { dep } from "./dep"; export function main(): number { return dep(); }`,
        },
        "entry.ts",
      );
      expect(linked.irBodyRouteAudit?.route).toBe("incremental.compileMulti");
      expect(linked.irBodyRouteAudit?.graph).toBe("multi");
    } finally {
      incremental.dispose();
    }
  });

  it("records direct function and module-init entry before their poison guards", async () => {
    const priorFunction = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    const priorModuleInit = process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "main";
      const functionResult = await compile(`export function main(): number { return 1; }`, {
        fileName: "audit-function-poison.ts",
        target: "standalone",
        experimentalIR: false,
        trackIrOutcomes: true,
      });
      expect(functionResult.success).toBe(false);
      expect(
        functionResult.irBodyRouteAudit?.legacyEntries.some(
          (entry) => entry.entryPoint === "compileFunctionBody" && entry.bodyName === "main",
        ),
      ).toBe(true);

      Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY = "1";
      const moduleResult = await compile(`export const value = 1;`, {
        fileName: "audit-module-poison.ts",
        target: "standalone",
        experimentalIR: false,
        trackIrOutcomes: true,
      });
      expect(moduleResult.success).toBe(false);
      expect(
        moduleResult.irBodyRouteAudit?.legacyEntries.some(
          (entry) => entry.entryPoint === "compileModuleInitBody" && entry.bodyName === "__module_init",
        ),
      ).toBe(true);
    } finally {
      if (priorFunction === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = priorFunction;
      if (priorModuleInit === undefined) {
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY");
      } else {
        process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY = priorModuleInit;
      }
    }
  });

  it("attributes support to a physical legacy owner even without outcome rows", async () => {
    const result = await compile(
      `export function main(): number { const value = { method(): void {} }; value.method(); return 1; }`,
      {
        fileName: "audit-support-owner.ts",
        target: "standalone",
        experimentalIR: false,
        trackIrOutcomes: true,
      },
    );
    expect(result.success).toBe(true);
    const support = result.irBodyRouteAudit!.dispositions.filter((row) => !row.terminal);
    expect(support.length).toBeGreaterThan(0);
    expect(support.every((row) => row.disposition === "owned-support-legacy-owner")).toBe(true);
  });

  it("does not count a bodyless nested-function reservation as a body entry", async () => {
    const result = await compile(
      `export function main(): number {
        let value = 1;
        function read(): number { return value; }
        function forward(): number { return read(); }
        return forward();
      }`,
      {
        fileName: "audit-nested-reservation.ts",
        target: "standalone",
        experimentalIR: false,
        trackIrOutcomes: true,
      },
    );
    expect(result.success).toBe(true);
    const entries = result.irBodyRouteAudit!.legacyEntries.filter(
      (entry) => entry.entryPoint === "compileNestedFunctionDeclaration" && entry.bodyName === "read",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.count).toBe(1);
  });

  it("uses the exact module-init root instead of an unattributed statement frame", async () => {
    const result = await compile(`const value: any = {}; export const selected = value.field;`, {
      fileName: "audit-module-root.ts",
      target: "standalone",
      experimentalIR: false,
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(true);
    const audit = result.irBodyRouteAudit!;
    expect(audit.legacyEntries.filter((entry) => entry.entryPoint === "compileModuleInitBody")).toHaveLength(1);
    expect(audit.unattributedLegacyEntryCount).toBe(0);
    expect(audit.structurallyComplete, audit.violations.map((violation) => violation.detail).join("\n")).toBe(true);
  });

  it("does not disguise an unmatched class root as module-init evidence", async () => {
    const result = await compile(`const seed = 1; export class Box { constructor() {} method(): void {} }`, {
      fileName: "audit-class-root.ts",
      target: "standalone",
      experimentalIR: false,
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(true);
    const classEntries = result.irBodyRouteAudit!.legacyEntries.filter(
      (entry) => entry.entryPoint === "compileClassBodies",
    );
    expect(classEntries).toHaveLength(3);
    expect(classEntries.filter((entry) => entry.classId !== undefined && entry.unitId === undefined)).toHaveLength(1);
    expect(result.irBodyRouteAudit!.classes).toHaveLength(1);
    expect(classEntries[0]?.classId).toBe(result.irBodyRouteAudit!.classes[0]?.id);
    const memberEntries = classEntries.filter((entry) => entry.unitId !== undefined);
    expect(new Set(memberEntries.map((entry) => entry.unitId)).size).toBe(2);
    expect(memberEntries.every((entry) => entry.unitKind !== "module-init")).toBe(true);
    expect(result.irBodyRouteAudit!.unattributedLegacyEntryCount).toBe(0);
  });

  it("records an exact class member before its direct-body poison", async () => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
    process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Box_method";
    try {
      const result = await compile(`export class Box { method(): void {} }`, {
        fileName: "audit-class-poison.ts",
        target: "standalone",
        experimentalIR: false,
        trackIrOutcomes: true,
      });
      expect(result.success).toBe(false);
      expect(result.irBodyRouteAudit?.legacyEntries).toContainEqual(
        expect.objectContaining({
          entryPoint: "compileClassBodies",
          bodyName: "Box_method",
          unitKind: "class-instance-method",
          unitId: expect.stringContaining("class-instance-method"),
        }),
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
    }
  });

  it("includes compiler-created callable units with exact Program ABI provenance", async () => {
    const result = await compile(DERIVED_ASYNC_SOURCE, {
      fileName: "audit-derived.ts",
      target: "gc",
      trackIrOutcomes: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const audit = result.irBodyRouteAudit!;
    expect(audit.sources).toHaveLength(1);
    expect(audit.derivedUnits).toHaveLength(3);
    expect(new Set(audit.derivedUnits.map((unit) => unit.id)).size).toBe(3);
    expect(audit.derivedUnits.map((unit) => unit.role)).toEqual(["lifted-closure", "lifted-closure", "ir-async-state"]);
    expect(audit.derivedUnits.every((unit) => unit.disposition === "derived-ir-owner")).toBe(true);
    expect(audit.derivedUnits.every((unit) => unit.sourceId === audit.sources[0]!.id)).toBe(true);
    expect(audit.structurallyComplete, audit.violations.map((violation) => violation.detail).join("\n")).toBe(true);
  });

  it("marks a present but unresolved outcome as structurally incomplete", async () => {
    const previous = process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW;
    process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW = "inline";
    try {
      const result = await compile(DERIVED_ASYNC_SOURCE, {
        fileName: "audit-unresolved.ts",
        target: "gc",
        trackIrOutcomes: true,
      });
      expect(result.success).toBe(false);
      const audit = result.irBodyRouteAudit!;
      expect(audit.structurallyComplete).toBe(false);
      expect(audit.dispositions.filter((row) => row.disposition === "unresolved-terminal")).toHaveLength(2);
      expect(audit.violations.filter((violation) => violation.code === "missing-terminal-evidence")).toHaveLength(2);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_PHASE_THROW");
      else process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW = previous;
    }
  });
});
