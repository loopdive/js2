// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import * as ownership from "../src/ir/analysis/ownership.js";
import * as escapeAnalysis from "../src/ir/analysis/escape.js";
import * as encoding from "../src/ir/analysis/encoding.js";
import * as dominance from "../src/ir/analysis/dominance.js";
import * as fold from "../src/ir/passes/constant-fold.js";
import * as dead from "../src/ir/passes/dead-code.js";
import * as cfg from "../src/ir/passes/simplify-cfg.js";
import * as gvn from "../src/ir/passes/gvn.js";
import * as core from "../src/ir/passes/gvn-core.js";
import * as mono from "../src/ir/passes/monomorphize.js";
import * as inline from "../src/ir/passes/inline-small.js";
import * as tagged from "../src/ir/passes/tagged-unions.js";
import * as batch from "../src/ir/passes/batch-string-concat.js";
import * as allocations from "../src/ir/verify-alloc.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { asValueId, type IrFunction } from "../src/ir/nodes.js";
import { createDerivedIrUnitId } from "../src/shared/contracts/identity-values.js";
import {
  optimizePreparedIrProgram,
  resolveIrPreparationControlsFromEnv,
  runHygienePasses,
} from "../src/ir/program-middleend.js";
import {
  optimizePreparedIrProgramIr,
  runHygienePassesIr,
  type IrPreparationControls,
} from "../src/ir/program-middleend-ir.js";
import {
  duplicateFunction,
  evaluateNumeric,
  f64,
  identityFunction,
  producerInput,
  sourceId,
  unitId,
} from "./helpers/typed-middleend-fixtures.js";

const disabled: IrPreparationControls = Object.freeze({
  gvnMode: "off",
  ownership: false,
  escape: false,
  verifyIntermediateAllocations: false,
  verifyDominanceNaive: false,
});
const envNames = [
  "JS2WASM_IR_GVN",
  "JS2WASM_IR_OWNERSHIP",
  "JS2WASM_IR_ESCAPE",
  "IR_VERIFY_ALLOC",
  "JS2WASM_IR_VERIFY_DOMINANCE_NAIVE",
];
function ambient(value: string) {
  for (const name of envNames) vi.stubEnv(name, value);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("resolved middle-end controls and historical compatibility", () => {
  it.each([undefined, "", "0", "off", "false", "TRUE", "1", "true", "poison"])(
    "resolves exactly the historical five switches for %s",
    (value) => {
      for (const name of envNames) vi.stubEnv(name, value);
      const controls = resolveIrPreparationControlsFromEnv();
      const bool = value === "1" || value === "true";
      expect(controls).toEqual({
        gvnMode: value === "poison" ? "poison" : bool ? "on" : "off",
        ownership: bool,
        escape: bool,
        verifyIntermediateAllocations: bool,
        verifyDominanceNaive: value === "1",
      });
      expect(Object.isFrozen(controls)).toBe(true);
      expect(Reflect.ownKeys(controls)).toHaveLength(5);
    },
  );

  it.each(["off", "1", "true", "poison"])(
    "historical hygiene still calls gvnFromEnv and agrees with resolved mode %s",
    (mode) => {
      vi.stubEnv("JS2WASM_IR_GVN", mode);
      const legacy = vi.spyOn(gvn, "gvnFromEnv");
      const fn = duplicateFunction();
      const before = structuredClone(fn);
      const historical = runHygienePasses(fn);
      expect(legacy).toHaveBeenCalled();
      const calls = legacy.mock.calls.length;
      const resolved = runHygienePassesIr(
        fn,
        undefined,
        resolveIrPreparationControlsFromEnv().gvnMode,
        core.createGvnCounters(),
      );
      expect(resolved).toEqual(historical);
      expect(evaluateNumeric(resolved)).toBe(mode === "poison" ? 424247 : 10);
      expect(legacy).toHaveBeenCalledTimes(calls);
      expect(fn).toEqual(before);
    },
  );

  it.each([false, true])(
    "preserves fold/GVN/dead/CFG order and identity termination (force ten rounds=%s)",
    (changing) => {
      const events: string[] = [];
      vi.spyOn(fold, "constantFold").mockImplementation((fn) => {
        events.push("fold");
        return changing ? { ...fn } : fn;
      });
      vi.spyOn(core, "gvnCore").mockImplementation((fn) => {
        events.push("gvn");
        return fn;
      });
      vi.spyOn(dead, "deadCode").mockImplementation((fn) => {
        events.push("dead");
        return fn;
      });
      vi.spyOn(cfg, "simplifyCFG").mockImplementation((fn) => {
        events.push("cfg");
        return fn;
      });
      const fn = identityFunction();
      const result = runHygienePassesIr(fn, undefined, "on", core.createGvnCounters());
      expect(events).toEqual(Array.from({ length: changing ? 10 : 1 }, () => ["fold", "gvn", "dead", "cfg"]).flat());
      expect(result === fn).toBe(!changing);
    },
  );

  it.each(["off", "on", "poison"] as const)(
    "uses explicit %s under contradictory ambient mode with nonempty real IR",
    (mode) => {
      ambient(mode === "off" ? "1" : "off");
      const input = producerInput([duplicateFunction()]);
      const counters = core.createGvnCounters();
      const legacy = vi.spyOn(gvn, "gvnFromEnv");
      const naive = vi.spyOn(dominance, "crossCheckDominance");
      const result = optimizePreparedIrProgramIr(
        input,
        new AllocSiteRegistry(),
        { ...disabled, gvnMode: mode },
        counters,
      );
      expect(result.ir.functions).toHaveLength(1);
      expect(evaluateNumeric(result.ir.functions[0]!)).toBe(mode === "poison" ? 424247 : 10);
      expect(counters).toEqual({
        functions: mode === "off" ? 0 : 4,
        merged: mode === "on" ? 1 : 0,
        poisoned: mode === "poison" ? 1 : 0,
      });
      expect(legacy).not.toHaveBeenCalled();
      expect(naive).not.toHaveBeenCalled();
      expect(result.derivedUnits).toEqual([]);
    },
  );

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("honors ownership=%s escape=%s independently of ambient settings", (wantOwnership, wantEscape) => {
    ambient(wantOwnership || wantEscape ? "off" : "true");
    const own = vi.spyOn(ownership, "analyzeOwnership");
    const esc = vi.spyOn(escapeAnalysis, "analyzeEscape");
    const enc = vi.spyOn(encoding, "analyzeEncoding");
    const fn = identityFunction();
    const result = optimizePreparedIrProgramIr(
      producerInput([fn]),
      new AllocSiteRegistry(),
      { ...disabled, ownership: wantOwnership, escape: wantEscape },
      core.createGvnCounters(),
    );
    expect(result.ir.functions).toEqual([fn]);
    expect(result.ir.functions[0]).toBe(fn);
    expect(own).toHaveBeenCalledTimes(wantOwnership || wantEscape ? 1 : 0);
    expect(esc).toHaveBeenCalledTimes(wantEscape ? 1 : 0);
    expect(enc).toHaveBeenCalledTimes(2);
    if (wantEscape) expect(esc.mock.calls[0]![2]).toBe(own.mock.results[0]!.value);
  });

  it.each([false, true])("passes explicit naive=%s to all three intermediate verifications", (enabled) => {
    ambient(enabled ? "off" : "1");
    const naive = vi.spyOn(dominance, "crossCheckDominance");
    optimizePreparedIrProgramIr(
      producerInput(),
      new AllocSiteRegistry(),
      { ...disabled, verifyDominanceNaive: enabled },
      core.createGvnCounters(),
    );
    expect(naive).toHaveBeenCalledTimes(enabled ? 3 : 0);
  });

  it.each([
    [false, "1", 0],
    [true, "off", 1],
    [undefined, "1", 1],
    [undefined, "true", 0],
  ] as const)("fourth verifier option %s with env %s makes %s naive calls", (explicit, env, calls) => {
    vi.stubEnv("JS2WASM_IR_VERIFY_DOMINANCE_NAIVE", env);
    const naive = vi.spyOn(dominance, "crossCheckDominance");
    expect(
      verifyIrFunction(
        identityFunction(),
        undefined,
        undefined,
        explicit === undefined ? undefined : { verifyDominanceNaive: explicit },
      ),
    ).toEqual([]);
    expect(naive).toHaveBeenCalledTimes(calls);
  });

  it.each([false, true])(
    "performs intermediate allocation checks iff explicit %s, with a real missing allocation control",
    (enabled) => {
      ambient(enabled ? "off" : "1");
      const fn: IrFunction = {
        ...identityFunction(),
        params: [],
        resultTypes: [{ kind: "string" }],
        blocks: [
          {
            ...identityFunction().blocks[0]!,
            instrs: [{ kind: "string.const", value: "nonempty", result: asValueId(0), resultType: { kind: "string" } }],
          },
        ],
      };
      const registry = new AllocSiteRegistry();
      expect(verifyIrFunction(fn, undefined, undefined, { verifyDominanceNaive: false })).toEqual([]);
      expect(allocations.verifyAllocProvenance(fn, registry)).toHaveLength(1);
      const check = vi.spyOn(allocations, "assertFinalAllocProvenance");
      const run = () =>
        optimizePreparedIrProgramIr(
          producerInput([fn]),
          registry,
          { ...disabled, verifyIntermediateAllocations: enabled },
          core.createGvnCounters(),
        );
      if (enabled) {
        expect(run).toThrow(/missing an AllocSiteId/);
        expect(check).toHaveBeenCalledTimes(1);
      } else {
        expect(run().ir.functions).toHaveLength(1);
        expect(check).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves module pass order and uses the same counter for the additional batching hygiene", () => {
    ambient("off");
    const events: string[] = [];
    const implementations = {
      inline: inline.inlineSmall,
      mono: mono.monomorphize,
      tagged: tagged.runTaggedUnions,
      batch: batch.batchStringConcat,
      gvn: core.gvnCore,
    };
    vi.spyOn(inline, "inlineSmall").mockImplementation((...args) => {
      events.push("inline");
      return implementations.inline(...args);
    });
    vi.spyOn(mono, "monomorphize").mockImplementation((...args) => {
      events.push("mono");
      return implementations.mono(...args);
    });
    vi.spyOn(tagged, "runTaggedUnions").mockImplementation((...args) => {
      events.push("tagged");
      return implementations.tagged(...args);
    });
    vi.spyOn(batch, "batchStringConcat").mockImplementation((...args) => {
      events.push("batch");
      return implementations.batch(...args);
    });
    const counter = core.createGvnCounters();
    vi.spyOn(core, "gvnCore").mockImplementation((...args) => {
      events.push("gvn");
      expect(args[2]).toBe(counter);
      return implementations.gvn(...args);
    });
    const input = producerInput();
    const result = optimizePreparedIrProgramIr(
      { ...input, policy: { ...input.policy, stringConcatMany: { batch: "native" } } },
      new AllocSiteRegistry(),
      { ...disabled, gvnMode: "on" },
      counter,
    );
    expect(events).toEqual(["gvn", "inline", "gvn", "mono", "tagged", "gvn", "batch", "gvn"]);
    expect(counter).toEqual({ functions: 4, merged: 0, poisoned: 0 });
    expect(result.ir.functions[0]).toBe(input.ir.functions[0]);
  });

  it("historical optimizer records once in finally and does not mask a post-merge sentinel", () => {
    ambient("1");
    const sentinel = Object.freeze({ phase: "after-hygiene" });
    const record = vi.spyOn(gvn, "recordLegacyGvnCountersOnce");
    vi.spyOn(inline, "inlineSmall").mockImplementation(() => {
      throw sentinel;
    });
    const run = () => optimizePreparedIrProgram(producerInput([duplicateFunction()]), new AllocSiteRegistry());
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toEqual({ functions: 2, merged: 1, poisoned: 0 });
    try {
      run();
    } catch {
      /* The same sentinel escapes the second independent transaction. */
    }
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1]![0]).not.toBe(record.mock.calls[0]![0]);
  });

  // Deliberate producer-output controls: natural clone discovery is separately
  // covered by issue-3520-monomorphize-identity.test.ts, not asserted by this seam.
  it.each(["valid", "contradictory", "missing-owner"])(
    "preserves derived insertion order and exact owners: %s",
    (scenario) => {
      const input = producerInput([identityFunction(0), identityFunction(1)]);
      vi.spyOn(mono, "monomorphize").mockImplementation((module) => {
        const parents = [...module.functions].reverse();
        const records = parents.map((parent, ordinal) => {
          const provenance = {
            parentId: scenario === "missing-owner" ? unitId(99) : parent.unitId,
            role: "monomorphization-clone" as const,
            ordinal,
          };
          return { ...provenance, id: createDerivedIrUnitId(provenance) };
        });
        return {
          module: {
            ...module,
            functions: [
              ...module.functions,
              ...records.map((record, index) => ({
                ...parents[index]!,
                unitId: record.id,
                name: `clone${index}`,
                exported: false,
              })),
            ],
          },
          cloneSignatures: new Map(
            records.map((record, index) => [record.id, { name: `clone${index}`, params: [f64], returnType: f64 }]),
          ),
          cloneOrigins: new Map(
            records.map((record) => [record.id, scenario === "contradictory" ? unitId(99) : record.parentId]),
          ),
          cloneUnitProvenance: new Map(records.map((record) => [record.id, record])),
        };
      });
      const run = () => optimizePreparedIrProgramIr(input, new AllocSiteRegistry(), disabled, core.createGvnCounters());
      if (scenario !== "valid") {
        expect(run).toThrow(scenario === "contradictory" ? /contradictory provenance/ : /no original owner/);
        return;
      }
      const result = run();
      expect(result.ir.functions).toHaveLength(4);
      expect(
        result.derivedUnits.map((record) => [record.parentId, record.terminalOwnerId, record.sourceId, record.ordinal]),
      ).toEqual([
        [unitId(1), unitId(1), sourceId, 0],
        [unitId(0), unitId(0), sourceId, 1],
      ]);
      expect(result.ir.functions.slice(2).map((fn) => fn.unitId)).toEqual(
        result.derivedUnits.map((record) => record.id),
      );
    },
  );

  it("retains all four real historical integration calls", () => {
    const source = readFileSync(new URL("../src/ir/integration.ts", import.meta.url), "utf8");
    expect(source.match(/\brunHygienePasses\(/g)).toHaveLength(4);
    expect(source).toContain('from "./program-middleend.js"');
  });
});
