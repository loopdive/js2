// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 Perf2 — the Prepared path's currentness checks re-derived the whole program at every string emit. Each check
// that is a pure function of input that can no longer change now runs once per input (checkUnlessSettled,
// PreparedIrSettledChecks and settledAtIssue in src/ir/program/settled-verdict.ts; the allocation registry restore
// of src/ir/program/prepared-allocations.ts), and a body's emits share one layout audit. These tests try to pass a
// mutated input through every one of those paths: each must be refused, never a stale pass.
import { describe, expect, it } from "vitest";
import {
  checkUnlessSettled,
  PreparedIrSettledChecks,
  settledAtIssue,
  type PreparedIrSettlement,
} from "../src/ir/program/settled-verdict.js";
import {
  assertNativeStringOutputRequirementsCurrent,
  deriveNativeStringOutputRequirements,
} from "../src/ir/program/native-string-output-requirements.js";
import {
  assertNativeObjectAccessRequirementsCurrent,
  deriveNativeObjectAccessRequirements,
} from "../src/ir/program/native-object-access-requirements.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { freezePreparedIrRuntimeValue } from "../src/ir/program/data.js";
import { preparedAllocationSites } from "../src/ir/program/prepared-allocations.js";
import { asAllocSiteId } from "../src/ir/core/nodes.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";

const policy = {
  target: "standalone",
  backend: "wasmgc",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
  numberBoundary: { box: "unsupported", unbox: "native" },
} as const;

function programOf(source: string) {
  const prepared = prepareIrProgramSources({
    ...sourceInput({ "./entry.ts": source }),
    policy,
    nativeStringValueProjection: "standalone-native",
  });
  if (prepared.kind !== "prepared") throw new Error(prepared.detail);
  return requireProgram(
    prepareTypedIrProgram(captureTypedIrProgramInput(prepared), { ...typedOptions, policy, runtimePolicies: [policy] }),
  );
}
const concatProgram = () => programOf(`export function run(a: string): string { return a + "x"; }`);

describe("#7354 Perf2 — checkUnlessSettled", () => {
  const counting = () => {
    let runs = 0;
    return { check: () => void runs++, runs: () => runs };
  };

  it("re-checks input that can still change at every use", () => {
    const holder: PreparedIrSettlement = { settled: undefined };
    const input = { value: 1 };
    const c = counting();
    for (let i = 0; i < 3; i++) checkUnlessSettled(holder, input, c.check);
    expect(c.runs()).toBe(3);
  });

  it("checks frozen data once, and again after a shared prototype changes", () => {
    const holder: PreparedIrSettlement = { settled: undefined };
    const input = Object.freeze({ rows: Object.freeze([Object.freeze({ value: 1 })]) });
    const c = counting();
    checkUnlessSettled(holder, input, c.check);
    checkUnlessSettled(holder, input, c.check);
    expect(c.runs()).toBe(1);
    const prototype = Object.prototype as { perf2Probe?: unknown };
    prototype.perf2Probe = 1;
    try {
      checkUnlessSettled(holder, input, c.check);
      expect(c.runs()).toBe(2);
    } finally {
      Reflect.deleteProperty(prototype, "perf2Probe");
    }
    checkUnlessSettled(holder, input, c.check);
    expect(c.runs()).toBe(3);
  });

  it("decides immutability before the check: input frozen by the check is not settled by that run", () => {
    const holder: PreparedIrSettlement = { settled: undefined };
    const input = { value: 1 };
    const c = counting();
    checkUnlessSettled(holder, input, () => {
      c.check();
      Object.freeze(input);
    });
    checkUnlessSettled(holder, input, c.check);
    expect(c.runs()).toBe(2);
  });

  it("does not settle a check whose verdict threw", () => {
    const holder: PreparedIrSettlement = { settled: undefined };
    const input = Object.freeze({ value: 1 });
    expect(() =>
      checkUnlessSettled(holder, input, () => {
        throw new Error("refused");
      }),
    ).toThrow(/refused/);
    const c = counting();
    checkUnlessSettled(holder, input, c.check);
    expect(c.runs()).toBe(1);
  });

  it("keeps one verdict per input object, and none for a mutable copy", () => {
    const checks = new PreparedIrSettledChecks<object>();
    const a = Object.freeze({ value: 1 });
    const b = Object.freeze({ value: 1 });
    const c = counting();
    checks.check(a, c.check);
    checks.check(a, c.check);
    checks.check(b, c.check);
    checks.check({ ...a }, c.check);
    expect(c.runs()).toBe(3);
  });

  it("settles at issue only input that can no longer change", () => {
    expect(settledAtIssue(Object.freeze({ value: 1 })).settled).toBeDefined();
    expect(settledAtIssue({ value: 1 }).settled).toBeUndefined();
    expect(settledAtIssue(Object.freeze({ nested: { value: 1 } })).settled).toBeUndefined();
  });
});

describe("#7354 Perf2 — output requirements", () => {
  it("refuses options changed after issue when they were not frozen", () => {
    const program = concatProgram();
    const demands = collectNativeStringValueDemands(program, program.runtime[0]!);
    const options = { emptyIdentity: true };
    const requirements = deriveNativeStringOutputRequirements(demands, options);
    if ("kind" in requirements) throw new Error(requirements.detail);
    assertNativeStringOutputRequirementsCurrent(requirements);
    assertNativeStringOutputRequirementsCurrent(requirements);
    options.emptyIdentity = false;
    expect(() => assertNativeStringOutputRequirementsCurrent(requirements)).toThrow(/stale output selections/);
  });

  it("refuses a copied requirements record after the issued one settled", () => {
    const program = concatProgram();
    const demands = collectNativeStringValueDemands(program, program.runtime[0]!);
    const requirements = deriveNativeStringOutputRequirements(demands, Object.freeze({ emptyIdentity: true }));
    if ("kind" in requirements) throw new Error(requirements.detail);
    assertNativeStringOutputRequirementsCurrent(requirements);
    expect(() => assertNativeStringOutputRequirementsCurrent({ ...requirements, binaryConcat: false })).toThrow(
      /unissued/,
    );
  });

  it("authenticates the census of each demands object, not of an equal fresh one", () => {
    const program = concatProgram();
    const first = collectNativeStringValueDemands(program, program.runtime[0]!);
    const options = Object.freeze({ emptyIdentity: true });
    expect("demands" in deriveNativeStringOutputRequirements(first, options)).toBe(true);
    const forged = { ...first, occurrences: [...first.occurrences].reverse() };
    expect(() => deriveNativeStringOutputRequirements(forged as typeof first, options)).toThrow(/census/);
  });
});

describe("#7354 Perf2 — object-access requirements settled at issue", () => {
  it("still refuses a copied pack after the issued one passed", () => {
    const program = concatProgram();
    const pack = deriveNativeObjectAccessRequirements(program, program.runtime[0]!);
    assertNativeObjectAccessRequirementsCurrent(pack);
    expect(() => assertNativeObjectAccessRequirementsCurrent({ ...pack })).toThrow(/unissued/);
  });
});

describe("#7354 Perf2 — allocation registry restored once per immutable snapshot", () => {
  function snapshotOf() {
    const registry = new AllocSiteRegistry();
    const id = registry.fresh("string", { kind: "string" } as never);
    return { id, snapshot: registry.snapshot() };
  }

  it("restores a frozen snapshot once and a mutable one at every use", () => {
    const frozen = snapshotOf();
    freezePreparedIrRuntimeValue(frozen.snapshot);
    expect(preparedAllocationSites(frozen.snapshot)).toBe(preparedAllocationSites(frozen.snapshot));
    const mutable = snapshotOf();
    expect(preparedAllocationSites(mutable.snapshot)).not.toBe(preparedAllocationSites(mutable.snapshot));
  });

  it("refuses a mutable snapshot changed after a successful restore", () => {
    const { id, snapshot } = snapshotOf();
    expect(preparedAllocationSites(snapshot).resolve(id)?.kind).toBe("string");
    (snapshot as { size: number }).size = 7;
    expect(() => preparedAllocationSites(snapshot)).toThrow(/invalid allocation snapshot/);
    expect(asAllocSiteId(0)).toBe(id);
  });
});
