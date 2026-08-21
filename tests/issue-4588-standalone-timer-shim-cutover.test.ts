// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildImports, compile, compileMulti, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";
import {
  inspectIrCompilerTimerShimRouting,
  shouldVisitIrImportedCallBody,
} from "../src/codegen/ir-timer-shim-planning.js";
import { preparedIrBodyRouting, type IrExactBodyClaim } from "../src/codegen/ir-overlay-safety.js";
import type { IrUnitId } from "../src/ir/identity.js";
import type { IrIntegrationReport, IrIntegrationTerminalEvidence } from "../src/ir/integration.js";
import type { IrUnsupportedCode } from "../src/ir/outcomes.js";

const ASYNC_SOURCE = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
const ASYNC_TIMER_UNIT_ID =
  "ir-unit:v1:derived:ir-source%3Av1%3A0000000000000000%3Aentry%3Aasync.ts:" +
  "compiler-unit%3Atimer-shim%3Aset-timeout:0000000000000000";
const TIMER_ROLE_COMPONENT = "compiler-unit%3Atimer-shim%3Aset-timeout";

function timerOutcome(result: CompileResult, unitId = ASYNC_TIMER_UNIT_ID): IrObservedOutcome | undefined {
  return result.irOutcomes?.find((outcome) => outcome.unitId === unitId);
}

function timerLegacyEntries(result: CompileResult, unitId = ASYNC_TIMER_UNIT_ID) {
  return (
    result.irBodyRouteAudit?.legacyEntries.filter(
      (entry) =>
        entry.unitId === unitId &&
        (entry.entryPoint === "compileFunctionBody" || entry.entryPoint === "compileStatement"),
    ) ?? []
  );
}

async function compileAsync(target: "gc" | "standalone", fileName = "async.ts"): Promise<CompileResult> {
  return compile(ASYNC_SOURCE, {
    fileName,
    target,
    experimentalIR: true,
    trackIrOutcomes: true,
    optimize: false,
    emitWat: true,
  });
}

async function compileAndInstantiate(source: string) {
  const result = await compile(source, { fileName: "issue-4588-node-timeout.ts" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const imports = buildImports(result.imports);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return { instance };
}

async function compileWithTimerCutover(source: string, fileName: string, enabled: boolean): Promise<CompileResult> {
  const previous = process.env.JS2WASM_PREPARED_TIMER_SHIM_CUTOVER;
  try {
    if (enabled) Reflect.deleteProperty(process.env, "JS2WASM_PREPARED_TIMER_SHIM_CUTOVER");
    else process.env.JS2WASM_PREPARED_TIMER_SHIM_CUTOVER = "0";
    return await compile(source, {
      fileName,
      target: "standalone",
      experimentalIR: true,
      trackIrOutcomes: true,
      optimize: false,
      emitWat: true,
    });
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_PREPARED_TIMER_SHIM_CUTOVER");
    else process.env.JS2WASM_PREPARED_TIMER_SHIM_CUTOVER = previous;
  }
}

function exactTimerOutcomes(result: CompileResult): readonly IrObservedOutcome[] {
  return (result.irOutcomes ?? []).filter((outcome) => outcome.unitId?.includes(TIMER_ROLE_COMPONENT));
}

function expectLegacyOrSafeReject(result: CompileResult): void {
  const outcomes = exactTimerOutcomes(result);
  if (!result.success) {
    expect(result.errors.length).toBeGreaterThan(0);
    expect(outcomes.every((outcome) => !outcome.irBodyEmitted)).toBe(true);
    return;
  }
  expect(outcomes.length).toBeGreaterThan(0);
  expect(outcomes.every((outcome) => outcome.kind === "unsupported")).toBe(true);
  expect(outcomes.every((outcome) => outcome.legacyBodyEmitted && !outcome.irBodyEmitted)).toBe(true);
  for (const outcome of outcomes) {
    expect(result.irBodyRouteAudit?.dispositions.find((row) => row.unitId === outcome.unitId)?.disposition).toBe(
      "legacy-ast-entry",
    );
    expect(timerLegacyEntries(result, outcome.unitId)).not.toHaveLength(0);
  }
}

describe("#4588 exact compiler timer-shim physical-route cutover", () => {
  it("defers only exact Unsupported free-function owners for post-direct retry", () => {
    const freeUnitId = "ir-unit:v1:test:free" as IrUnitId;
    const classUnitId = "ir-unit:v1:test:class" as IrUnitId;
    const connectedUnitId = "ir-unit:v1:test:timer-connected" as IrUnitId;
    const unsupported = (
      unitId: IrUnitId,
      legacyName: string,
      code: IrUnsupportedCode = "late-preparation-unsupported",
    ): Extract<IrIntegrationTerminalEvidence, { kind: "failed" }> => ({
      kind: "failed",
      unitId,
      legacyName,
      error: {
        func: legacyName,
        message: `${legacyName} is not ready for prepared lowering`,
        kind: "build",
        outcome: {
          kind: "unsupported",
          code,
          stage: "resolve",
          detail: `${legacyName} is not ready for prepared lowering`,
        },
      },
    });
    const terminalEvidence = [
      unsupported(freeUnitId, "free"),
      unsupported(classUnitId, "Class_method"),
      unsupported(connectedUnitId, "connected", "timer-component-not-isolated"),
    ];
    const report: IrIntegrationReport = {
      compiled: [],
      errors: terminalEvidence.map((evidence) => evidence.error),
      terminalEvidence,
    };
    const claims = new Map<IrUnitId, IrExactBodyClaim>([
      [freeUnitId, { unitId: freeUnitId, legacyName: "free" }],
      [classUnitId, { unitId: classUnitId, legacyName: "Class_method" }],
      [connectedUnitId, { unitId: connectedUnitId, legacyName: "connected" }],
    ]);

    const routing = preparedIrBodyRouting(report, claims, {
      deferUnsupportedUnitIds: new Set([freeUnitId, connectedUnitId]),
    });

    expect([...routing.deferredUnitIds]).toEqual([freeUnitId]);
    expect(routing.deferredUnitIds.has(classUnitId)).toBe(false);
    expect(routing.deferredUnitIds.has(connectedUnitId)).toBe(false);
    expect(routing.irOwnedUnitIds).toEqual(new Set());
    expect(routing.preparedUnitIds).toEqual(new Set());
  });

  it("does not walk an ordinary selected body for the timer resolver alone", () => {
    expect(shouldVisitIrImportedCallBody(false, false)).toBe(false);
    expect(shouldVisitIrImportedCallBody(true, false)).toBe(true);
    expect(shouldVisitIrImportedCallBody(true, true)).toBe(false);
  });

  it("keeps accessor population on its established route without an exact timer owner", () => {
    const routing = inspectIrCompilerTimerShimRouting({
      importedCalls: new Map(),
      identityPlan: { safeFunctionUnitIds: new Set() },
      functionClaimsByUnitId: new Map(),
      hostVoidCallbacks: { size: 1 },
      hostDateImportsByOwnerUnitId: { size: 0 },
      promiseDelays: { constructions: { size: 0 } },
    } as unknown as Parameters<typeof inspectIrCompilerTimerShimRouting>[0]);
    expect(routing.ownerUnitIds.size).toBe(0);
    expect(routing.owners(undefined, new Set(["ordinary"]), new Set(["accessor"]))).toBeUndefined();
  });

  it("turns the pinned Async shim into the exact self-owned terminal and bypasses both AST entries", async () => {
    const previous = process.env.JS2WASM_PREPARED_TIMER_SHIM_CUTOVER;
    try {
      Reflect.deleteProperty(process.env, "JS2WASM_PREPARED_TIMER_SHIM_CUTOVER");
      const candidate = await compileAsync("standalone");
      expect(candidate.success, candidate.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(candidate.irBodyRouteAudit).toMatchObject({
        sourceCount: 1,
        allUnitCount: 8,
        terminalUnitCount: 6,
        ownedSupportUnitCount: 2,
        unownedSupportUnitCount: 0,
        structurallyComplete: true,
      });
      expect(timerOutcome(candidate)).toMatchObject({
        unitId: ASYNC_TIMER_UNIT_ID,
        unitKind: "function",
        displayName: "setTimeout",
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      expect(candidate.irBodyRouteAudit?.dispositions.find((row) => row.unitId === ASYNC_TIMER_UNIT_ID)).toEqual({
        sourceId: "ir-source:v1:0000000000000000:entry:async.ts",
        unitId: ASYNC_TIMER_UNIT_ID,
        unitKind: "synthetic-support",
        terminal: true,
        terminalOwnerId: ASYNC_TIMER_UNIT_ID,
        disposition: "terminal-ir",
      });
      expect(timerLegacyEntries(candidate)).toEqual([]);

      process.env.JS2WASM_PREPARED_TIMER_SHIM_CUTOVER = "0";
      const directControl = await compileAsync("standalone");
      expect(directControl.success, directControl.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(
        timerLegacyEntries(directControl)
          .map((entry) => entry.entryPoint)
          .sort(),
      ).toEqual(["compileFunctionBody", "compileStatement"]);
      expect(
        directControl.irBodyRouteAudit?.dispositions.find((row) => row.unitId === ASYNC_TIMER_UNIT_ID),
      ).toMatchObject({
        terminal: true,
        terminalOwnerId: ASYNC_TIMER_UNIT_ID,
        disposition: "legacy-ast-entry",
      });
      expect(candidate.wat).toBe(directControl.wat);
      expect(Buffer.compare(candidate.binary, directControl.binary)).toBe(0);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_PREPARED_TIMER_SHIM_CUTOVER");
      else process.env.JS2WASM_PREPARED_TIMER_SHIM_CUTOVER = previous;
    }
  });

  it("keeps the target-neutral timer identity IR-owned in host and standalone lanes", async () => {
    const [host, standalone] = await Promise.all([compileAsync("gc"), compileAsync("standalone")]);
    for (const result of [host, standalone]) {
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(timerOutcome(result)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      expect(result.irBodyRouteAudit?.dispositions.find((row) => row.unitId === ASYNC_TIMER_UNIT_ID)).toMatchObject({
        terminal: true,
        terminalOwnerId: ASYNC_TIMER_UNIT_ID,
        disposition: "terminal-ir",
      });
      expect(timerLegacyEntries(result)).toEqual([]);
    }
    expect(timerOutcome(host)?.unitId).toBe(ASYNC_TIMER_UNIT_ID);
    expect(timerOutcome(standalone)?.unitId).toBe(ASYNC_TIMER_UNIT_ID);
  });

  it.each([
    ["direct pair", "0", "0"],
    ["SMI plus direct pair", "0", "1"],
    ["fused helper", "1", "0"],
    ["SMI plus fused helper", "1", "1"],
  ] as const)(
    "seals the exact %s ToNumber providers without changing the direct artifact",
    async (_label, fused, smi) => {
      const previousFused = process.env.JS2WASM_FUSED_TONUMBER;
      const previousSmi = process.env.JS2WASM_SMI_FASTPATH;
      const previousCutover = process.env.JS2WASM_PREPARED_TIMER_SHIM_CUTOVER;
      try {
        process.env.JS2WASM_FUSED_TONUMBER = fused;
        process.env.JS2WASM_SMI_FASTPATH = smi;
        Reflect.deleteProperty(process.env, "JS2WASM_PREPARED_TIMER_SHIM_CUTOVER");
        const candidate = await compileAsync("standalone");
        process.env.JS2WASM_PREPARED_TIMER_SHIM_CUTOVER = "0";
        const directControl = await compileAsync("standalone");
        expect(candidate.success, candidate.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(directControl.success, directControl.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(timerOutcome(candidate)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
        });
        expect(timerLegacyEntries(candidate)).toEqual([]);
        expect(candidate.wat).toBe(directControl.wat);
        expect(Buffer.compare(candidate.binary, directControl.binary)).toBe(0);
      } finally {
        if (previousFused === undefined) Reflect.deleteProperty(process.env, "JS2WASM_FUSED_TONUMBER");
        else process.env.JS2WASM_FUSED_TONUMBER = previousFused;
        if (previousSmi === undefined) Reflect.deleteProperty(process.env, "JS2WASM_SMI_FASTPATH");
        else process.env.JS2WASM_SMI_FASTPATH = previousSmi;
        if (previousCutover === undefined) Reflect.deleteProperty(process.env, "JS2WASM_PREPARED_TIMER_SHIM_CUTOVER");
        else process.env.JS2WASM_PREPARED_TIMER_SHIM_CUTOVER = previousCutover;
      }
    },
  );

  it("keeps the corpus full-path source key on the same physical prepared route", async () => {
    const result = await compileAsync("standalone", "website/playground/examples/js/async.ts");
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(timerOutcome(result)).toMatchObject({
      unitId: ASYNC_TIMER_UNIT_ID,
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(timerLegacyEntries(result)).toEqual([]);
  });

  it("fails a timer-connected final-IR component closed instead of splitting its seal", async () => {
    const previous = process.env.JS2WASM_TEST_INJECT_IR_TIMER_SHIM_UNIT_EDGE;
    try {
      process.env.JS2WASM_TEST_INJECT_IR_TIMER_SHIM_UNIT_EDGE = "1";
      const result = await compileAsync("standalone");
      expectLegacyOrSafeReject(result);
      const nonTimer = (result.irOutcomes ?? []).filter((outcome) => outcome.unitId !== ASYNC_TIMER_UNIT_ID);
      expect(timerOutcome(result)).toMatchObject({ kind: "unsupported", code: "timer-component-not-isolated" });
      expect(
        nonTimer.some(
          (outcome) =>
            outcome.kind === "unsupported" &&
            outcome.code === "timer-component-not-isolated" &&
            outcome.legacyBodyEmitted,
        ),
      ).toBe(true);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_TIMER_SHIM_UNIT_EDGE");
      else process.env.JS2WASM_TEST_INJECT_IR_TIMER_SHIM_UNIT_EDGE = previous;
    }
  });

  it.each(["seal", "lower"] as const)(
    "isolates an injected timer-scoped late-%s failure from every non-timer patch",
    async (stage) => {
      const previous = process.env.JS2WASM_TEST_INJECT_IR_PREPARED_TIMER_SHIM_FAILURE;
      try {
        process.env.JS2WASM_TEST_INJECT_IR_PREPARED_TIMER_SHIM_FAILURE = stage;
        const result = await compileAsync("standalone");
        expectLegacyOrSafeReject(result);
        const nonTimer = (result.irOutcomes ?? []).filter((outcome) => outcome.unitId !== ASYNC_TIMER_UNIT_ID);
        expect(nonTimer).toHaveLength(5);
        expect(
          nonTimer.every(
            (outcome) => outcome.kind === "emitted" && outcome.irBodyEmitted && !outcome.legacyBodyEmitted,
          ),
        ).toBe(true);
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_PREPARED_TIMER_SHIM_FAILURE");
        } else {
          process.env.JS2WASM_TEST_INJECT_IR_PREPARED_TIMER_SHIM_FAILURE = previous;
        }
      }
    },
  );

  it("preserves artifact and numeric timer-handle runtime behavior against the direct control", async () => {
    const source = `
      function tick(): void {}
      export function schedule(ms: number): number { return setTimeout(tick, ms); }
    `;
    const candidate = await compileWithTimerCutover(source, "issue-4588-runtime.ts", true);
    const directControl = await compileWithTimerCutover(source, "issue-4588-runtime.ts", false);
    for (const result of [candidate, directControl]) {
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    }
    expect(candidate.wat).toBe(directControl.wat);
    expect(Buffer.compare(candidate.binary, directControl.binary)).toBe(0);

    const run = async (result: CompileResult) => {
      const scheduledDelays: number[] = [];
      const provider = ((callback: () => void, delay?: number) => {
        void callback;
        scheduledDelays.push(Number(delay ?? 0));
        return 73 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;
      const imports = buildCompiledImports(result, { setTimeout: provider });
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setExports?.(instance.exports as unknown as Record<string, Function>);
      imports.setInstance?.(instance);
      const exports = instance.exports as unknown as Record<string, Function>;
      const returned = (exports.schedule as (ms: number) => number)(5);
      expect(scheduledDelays).toEqual([5]);
      return returned;
    };

    await expect(run(candidate)).resolves.toBe(73);
    await expect(run(directControl)).resolves.toBe(73);
  });

  it("coerces a Node Timeout object through the wrapper's full ToNumber path", async () => {
    const source = `
      function tick(): void {}
      export function schedule(ms: number): number { return setTimeout(tick, ms); }
    `;
    const { instance } = await compileAndInstantiate(source);
    const handle = (instance.exports.schedule as (ms: number) => number)(60_000);
    try {
      expect(typeof handle).toBe("number");
      expect(Number.isFinite(handle)).toBe(true);
      expect(handle).toBeGreaterThan(0);
    } finally {
      clearTimeout(handle);
    }
  });

  it.each([
    [
      "nested local shadow",
      `export function main(): number {
         function setTimeout(callback: () => void, ms: number): number { callback(); return ms; }
         return setTimeout(() => {}, 1);
       }`,
    ],
    [
      "first-class escape",
      `const escaped = setTimeout;
       export function main(): number { escaped(() => {}, 1); return setTimeout(() => {}, 2); }`,
    ],
    [
      "multiple source users",
      `export function first(): number { return setTimeout(() => {}, 1); }
       export function second(): number { return setTimeout(() => {}, 2); }`,
    ],
  ] as const)("leaves an injected shim with %s on legacy or rejects safely", async (label, source) => {
    const result = await compileWithTimerCutover(source, `issue-4588-${label.replaceAll(" ", "-")}.ts`, true);
    expectLegacyOrSafeReject(result);
  });

  it.each([
    [
      "ordinary user declaration",
      `function setTimeout(callback: () => void, ms: number): number { callback(); return ms + 41; }
       export function main(): number { return setTimeout(() => {}, 1); }`,
    ],
    [
      "injected-looking near miss",
      `// #1501 timer host-import shim (auto-injected)
       declare function __timer_set_timeout(cb: any, ms: any): any;
       function setTimeout(cb: () => void, ms: number): number { return __timer_set_timeout(cb, ms); }
       export function main(): number { return setTimeout(() => {}, 1); }`,
    ],
  ] as const)("never gives an %s compiler provenance", async (label, source) => {
    const result = await compileWithTimerCutover(source, `issue-4588-${label.replaceAll(" ", "-")}.ts`, true);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(exactTimerOutcomes(result)).toEqual([]);
    expect(
      result.irBodyRouteAudit?.dispositions.some(
        (row) => row.unitKind === "synthetic-support" && row.unitId.includes(TIMER_ROLE_COMPONENT),
      ),
    ).toBe(false);
  });

  it("does not synthesize or claim same-name timer shims in a multi-source graph", async () => {
    const result = await compileMulti(
      {
        "dep.ts": `export function dep(): number { return setTimeout(() => {}, 1); }`,
        "entry.ts": `import { dep } from "./dep";
          export function main(): number { setTimeout(() => {}, 2); return dep(); }`,
      },
      "entry.ts",
      {
        target: "standalone",
        experimentalIR: true,
        trackIrOutcomes: true,
        optimize: false,
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(exactTimerOutcomes(result)).toEqual([]);
    for (const name of ["dep", "main"]) {
      const outcome = result.irOutcomes?.find((candidate) => candidate.displayName === name);
      expect(outcome).toMatchObject({
        kind: "unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(result.irBodyRouteAudit?.dispositions.find((row) => row.unitId === outcome?.unitId)?.disposition).toBe(
        "legacy-ast-entry",
      );
    }
  });
});
