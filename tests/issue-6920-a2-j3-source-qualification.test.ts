// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import {
  assertPreparedIrProgram,
  assertPreparedIrProgramLinearAllocationEvidence,
} from "../src/ir/program-validation.js";
import { requirePreparedLinearMemoryInput } from "../src/ir/program/linear-allocation-facts.js";
import {
  assertPreparedIrProgramShape,
  encodePreparedIrProgram,
  decodePreparedIrProgram,
} from "../src/ir/program-codec.js";
import { planPhysicalSetup } from "../src/ir/program-physical-plan.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { IrUnsupportedError, IrInvariantError } from "../src/shared/contracts/ir-preparation-errors.js";
import { ALLOC_NAMESPACES, AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import * as encoding from "../src/ir/analysis/encoding.js";
import * as ownership from "../src/ir/analysis/ownership.js";
import * as escapeAnalysis from "../src/ir/analysis/escape.js";
import * as stack from "../src/ir/analysis/stack-alloc.js";
import * as producer from "../src/ir/analysis/linear-memory-plan.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "../src/ir/program/prepared-contracts.js";
import type { LinearPreparedAllocationFacts } from "../src/ir/analysis/linear/contracts/allocation-facts.js";
import type { IrFunction } from "../src/ir/core/nodes.js";
import { typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";

// This is the original real source, not a prepared-function or synthetic-facts fixture.
const numericSource =
  "export function sample(a: number, b: number): number { const xs: number[] = [a, b]; return xs[0] + xs[1] + xs.length; }";
const scalarSource = "export function twice(x: number): number { return x * 2; }";
type Target = "standalone" | "wasi";

function request(text = numericSource, target: Target = "standalone", capture = false) {
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  return {
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend: "linear" as const, target },
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64" as const,
    ...(capture
      ? {
          sourceMap: {
            kind: "capture-source-map" as const,
            sources: ast.sourceFiles.map((sourceFile) => ({
              sourceFile,
              projection: { originalText: sourceFile.text, analyzedText: sourceFile.text, stages: [] },
            })),
          },
        }
      : {}),
  };
}

function lower(text = numericSource, target: Target = "standalone", capture = false) {
  const input = request(text, target, capture);
  const source = prepareIrProgramSources(input);
  if (source.kind !== "prepared") throw new Error(`${source.kind}: ${source.detail}`);
  return { input, source };
}

function actual(text = numericSource, target: Target = "standalone", bothViews = false, capture = false) {
  const { input, source } = lower(text, target, capture);
  const policies = bothViews ? [input.policy, { backend: "linear" as const, target: "wasi" as const }] : [input.policy];
  const program = requireProgram(
    prepareTypedIrProgram(captureTypedIrProgramInput(source), {
      ...typedOptions,
      policy: input.policy,
      runtimePolicies: policies,
    }),
  );
  return { source, program };
}

function withoutAttachment(program: PreparedIrProgram): PreparedIrProgram {
  const { linearAllocationFacts: _facts, ...old } = program;
  return old;
}

// All mutations below are negative controls derived only after actual source preparation.
function changedFacts(program: PreparedIrProgram, facts: LinearPreparedAllocationFacts): PreparedIrProgram {
  return {
    ...program,
    allocations: facts.registry,
    linearAllocationFacts: { schema: "linear-allocation-facts-v1", facts },
  };
}

function missingEscape(program: PreparedIrProgram): PreparedIrProgram {
  const facts = program.linearAllocationFacts!.facts;
  const registry = {
    ...facts.registry,
    metadata: facts.registry.metadata.map((row) => ({
      ...row,
      entries: row.entries.filter(([key]) => key !== ALLOC_NAMESPACES.escape),
    })),
  };
  return changedFacts(program, {
    registry,
    allocations: facts.allocations.map((fact) => ({
      ...fact,
      escape: "opaque",
      evidence: { ...fact.evidence, escape: { present: false, value: undefined } },
    })),
  });
}

function undefinedEncoding(program: PreparedIrProgram): PreparedIrProgram {
  const facts = program.linearAllocationFacts!.facts;
  const registry = {
    ...facts.registry,
    metadata: facts.registry.metadata.map((row) => ({
      ...row,
      entries: [
        ...row.entries.filter(([key]) => key !== ALLOC_NAMESPACES.encoding),
        [ALLOC_NAMESPACES.encoding, undefined] as const,
      ],
    })),
  };
  return changedFacts(program, {
    registry,
    allocations: facts.allocations.map((fact) => ({
      ...fact,
      encoding: undefined,
      evidence: { ...fact.evidence, encoding: { present: true, value: undefined } },
    })),
  });
}

function uncoveredSubtraction(program: PreparedIrProgram): PreparedIrProgram {
  let edits = 0;
  const change = (functions: readonly IrFunction[]) =>
    functions.map((fn) => ({
      ...fn,
      blocks: fn.blocks.map((block) => ({
        ...block,
        instrs: block.instrs.map((instr) => {
          if (instr.kind !== "binary" || instr.op !== "f64.add") return instr;
          edits++;
          return { ...instr, op: "f64.sub" as const };
        }),
      })),
    }));
  const ir = { ...program.ir, functions: change(program.ir.functions) };
  const runtime = program.runtime.map((view) => ({
    ...view,
    prepared: { ...view.prepared, functions: change(view.prepared.functions) },
  }));
  expect(edits).toBeGreaterThan(0);
  return { ...program, ir, runtime };
}

function unsupported(callback: () => unknown): IrUnsupportedError {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(IrUnsupportedError);
    return error as IrUnsupportedError;
  }
  throw new Error("required acquisition did not refuse this negative control");
}

function locatedPhysical(program: PreparedIrProgram, view = program.runtime[0]!) {
  return planPhysicalSetup(program, replayOptions("linear", view.target as Target), view);
}

function expectLocatedUnsupported(program: PreparedIrProgram, view = program.runtime[0]!) {
  const refusal = unsupported(() => assertPreparedIrProgramLinearAllocationEvidence(program, view));
  const result = locatedPhysical(program, view);
  expect(result.kind).toBe("unsupported");
  if (result.kind !== "unsupported") throw new Error("physical acquisition did not refuse");
  const cause = refusal.cause as { unitId: unknown; location: unknown; sourceFile: unknown };
  expect(result.code).toBe(refusal.code);
  expect(result.stage).toBe(refusal.stage);
  expect(result.detail).toBe(refusal.message);
  expect(result.unitId).toBe(cause.unitId);
  expect(result.location).toEqual(cause.location);
  expect(result.sourceFile).toBe(cause.sourceFile);
  return result;
}

function observers() {
  const e = vi.spyOn(encoding, "analyzeEncoding"),
    o = vi.spyOn(ownership, "analyzeOwnership"),
    x = vi.spyOn(escapeAnalysis, "analyzeEscape"),
    s = vi.spyOn(stack, "findStackAllocCandidates"),
    fresh = vi.spyOn(AllocSiteRegistry.prototype, "fresh"),
    snapshot = vi.spyOn(AllocSiteRegistry.prototype, "snapshot"),
    facts = vi.spyOn(producer, "prepareLinearAllocationFacts");
  const all = {
    encoding: e,
    ownership: o,
    escape: x,
    stack: s,
    registryFresh: fresh,
    registrySnapshot: snapshot,
    factsProducer: facts,
  };
  return {
    all,
    counts: () => Object.fromEntries(Object.entries(all).map(([key, spy]) => [key, spy.mock.calls.length])),
    reset: () => {
      for (const spy of Object.values(all)) spy.mockClear();
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("A2 real source under current J3 allocation evidence", () => {
  it.each(["standalone", "wasi"] as const)(
    "prepares original numeric source with complete final facts under %s",
    (target) => {
      const { source, program } = actual(numericSource, target);
      expect(source.ir.functions.map((fn) => fn.name)).toEqual(["sample"]);
      expect(program.inventory.terminalUnits).toHaveLength(1);
      const attachment = program.linearAllocationFacts!;
      expect(attachment.schema).toBe("linear-allocation-facts-v1");
      expect(attachment.facts.allocations).toHaveLength(1);
      expect(attachment.facts.registry).toBe(program.allocations);
      expect(attachment.facts.allocations[0]!.site.kind).toBe("array");
      expect(attachment.facts.allocations[0]!.evidence.ownership.present).toBe(true);
      expect(attachment.facts.allocations[0]!.evidence.escape.present).toBe(true);
      assertPreparedIrProgram(program);
      const semantic = assertPreparedIrProgramLinearAllocationEvidence(program)!;
      expect(semantic.module).toBe(program.ir);
      expect(semantic.facts).toBe(attachment.facts);
      const checked = requirePreparedLinearMemoryInput(program, program.runtime[0]!);
      expect(checked.facts).toBe(attachment.facts);
      expect(checked.module.declaredSignatures).toBe(program.ir.declaredSignatures);
      expect(checked.module.declaredGlobals).toBe(program.ir.declaredGlobals);
      expect(checked.module.functions).toHaveLength(program.runtime[0]!.prepared.functions.length);
      for (const [index, fn] of checked.module.functions.entries())
        expect(fn).toBe(program.runtime[0]!.prepared.functions[index]);
      for (const key of Object.keys(program.ir).filter((key) => key !== "functions")) {
        expect(Object.hasOwn(checked.module, key)).toBe(true);
        expect(Reflect.get(checked.module, key)).toBe(Reflect.get(program.ir, key));
      }
      const bytes = encodePreparedIrProgram(program),
        replay = decodePreparedIrProgram(bytes);
      expect(replay.linearAllocationFacts).toEqual(attachment);
      expect(encodePreparedIrProgram(replay)).toBe(bytes);
      expect(requirePreparedLinearMemoryInput(replay, replay.runtime[0]!).facts).toBe(
        replay.linearAllocationFacts!.facts,
      );
      const resource = locatedPhysical(program);
      expect(resource.kind).toBe("unsupported");
      if (resource.kind !== "unsupported") throw new Error("B allocation resources unexpectedly available");
      expect(resource.detail).toContain("linear memory plan");
      expect(resource.unitId).toBe(program.inventory.terminalUnits[0]!.id);
    },
  );

  it("retains both genuine native runtime views with one final producer answer", () => {
    const observations = observers();
    const { program } = actual(numericSource, "standalone", true);
    expect(observations.all.factsProducer).toHaveBeenCalledTimes(1);
    expect(program.runtime.map((view) => view.target)).toEqual(["standalone", "wasi"]);
    for (const view of program.runtime) {
      const checked = requirePreparedLinearMemoryInput(program, view);
      expect(checked.facts).toBe(program.linearAllocationFacts!.facts);
      expect(checked.module.functions[0]).toBe(view.prepared.functions[0]);
    }
  });

  it.each(["standalone", "wasi"] as const)(
    "retains genuine scalar routes with and without attachment under %s",
    (target) => {
      const { program } = actual(scalarSource, target);
      expect(program.allocations.size).toBe(0);
      expect(program.linearAllocationFacts!.facts.allocations).toHaveLength(0);
      const old = withoutAttachment(program);
      assertPreparedIrProgram(old);
      expect(assertPreparedIrProgramLinearAllocationEvidence(old, old.runtime[0]!)).toBeUndefined();
      expect(decodePreparedIrProgram(encodePreparedIrProgram(old)).linearAllocationFacts).toBeUndefined();
      expect(locatedPhysical(old).kind).toBe("planned");
      expect(locatedPhysical(program).kind).toBe("planned");
    },
  );

  it("preserves actual raw UTF16 source-catalog code units without illegal numeric encoding", () => {
    const text = numericSource + " // \ud800x\udc00";
    const { program } = actual(text, "standalone", false, true);
    const replay = decodePreparedIrProgram(encodePreparedIrProgram(program));
    expect(replay.sourceMap!.sources[0]!.projection.originalText).toBe(text);
    expect(requirePreparedLinearMemoryInput(replay, replay.runtime[0]!).facts).toBe(
      replay.linearAllocationFacts!.facts,
    );
  });

  it("rejects producer-preserved present-undefined numeric encoding at final semantic preparation", () => {
    const { input, source } = lower(numericSource + " // \ud800x\udc00", "standalone", true);
    const site = source.allocations.liveSites()[0]!;
    source.allocations.annotate(site.id, ALLOC_NAMESPACES.encoding, undefined);
    expect(() =>
      prepareTypedIrProgram(captureTypedIrProgramInput(source), {
        ...typedOptions,
        policy: input.policy,
        runtimePolicies: [input.policy],
      }),
    ).toThrow(PreparedIrProgramInvariantError);
  });

  it("rejects an internally joined present-undefined encoding through full semantic and codec entries", () => {
    const bad = undefinedEncoding(actual().program);
    expect(() => assertPreparedIrProgramShape(bad)).not.toThrow();
    expect(() => assertPreparedIrProgram(bad)).toThrow(PreparedIrProgramInvariantError);
    expect(() => assertPreparedIrProgramLinearAllocationEvidence(bad, bad.runtime[0]!)).toThrow(
      PreparedIrProgramInvariantError,
    );
    expect(() => encodePreparedIrProgram(bad)).toThrow(PreparedIrProgramInvariantError);
  });

  it.each(["unknown-schema", "extra-field", "missing-facts"] as const)(
    "checks %s at semantic entries rather than granting shape authority",
    (kind) => {
      const program = actual().program;
      const attachment =
        kind === "unknown-schema"
          ? { ...program.linearAllocationFacts!, schema: "linear-allocation-facts-v2" }
          : kind === "extra-field"
            ? { ...program.linearAllocationFacts!, forged: true }
            : { ...program.linearAllocationFacts!, facts: undefined };
      const bad = { ...program, linearAllocationFacts: attachment } as PreparedIrProgram;
      // Shape enforces the published attachment discriminator; passing shape alone grants no semantic or layout authority.
      if (kind === "unknown-schema")
        expect(() => assertPreparedIrProgramShape(bad)).toThrow(PreparedIrProgramInvariantError);
      expect(() => assertPreparedIrProgram(bad)).toThrow(PreparedIrProgramInvariantError);
      expect(() => assertPreparedIrProgramLinearAllocationEvidence(bad, bad.runtime[0]!)).toThrow(
        PreparedIrProgramInvariantError,
      );
      expect(() => encodePreparedIrProgram(bad)).toThrow(PreparedIrProgramInvariantError);
    },
  );

  it.each(["registry", "population"] as const)(
    "rejects a real-program %s contradiction at complete semantic entry",
    (kind) => {
      const program = actual().program,
        view = program.runtime[0]!;
      const bad =
        kind === "registry"
          ? { ...program, allocations: { size: 0, entries: [], metadata: [] } }
          : { ...program, runtime: [{ ...view, prepared: { ...view.prepared, functions: [] } }] };
      if (kind === "registry") {
        const message = 'instr "vec.new_fixed" references unknown AllocSiteId 0 (dangling)';
        for (const action of [
          () => assertPreparedIrProgram(bad),
          () => assertPreparedIrProgramLinearAllocationEvidence(bad, bad.runtime[0]!),
          () => encodePreparedIrProgram(bad),
          () => locatedPhysical(bad),
        ]) {
          let thrown: unknown;
          try {
            action();
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(IrInvariantError);
          const failure = thrown as IrInvariantError;
          expect(failure.kind).toBe("invariant");
          expect(failure.code).toBe("allocation-provenance-failure");
          expect(failure.stage).toBe("verify");
          expect(failure.name).toBe("IrInvariantError");
          expect(failure.message).toBe(`IR alloc-provenance check failed (#1586):\n  - [sample] ${message}`);
          expect(failure.cause).toEqual([{ func: "sample", message }]);
        }
      } else {
        expect(() => assertPreparedIrProgram(bad)).toThrow(PreparedIrProgramInvariantError);
        expect(() => assertPreparedIrProgramLinearAllocationEvidence(bad, bad.runtime[0]!)).toThrow(
          PreparedIrProgramInvariantError,
        );
        expect(() => encodePreparedIrProgram(bad)).toThrow(PreparedIrProgramInvariantError);
      }
    },
  );

  it.each(["allocation", "semantic", "projection", "abi"] as const)(
    "screens a joined %s accessor before direct physical reads",
    (field) => {
      const healthy = actual().program;
      expect(locatedPhysical(healthy).kind).toBe("unsupported");
      const getter = vi.fn();
      let bad: PreparedIrProgram;
      if (field === "allocation") {
        bad = { ...healthy };
        Object.defineProperty(bad, "allocations", { enumerable: true, get: getter });
      } else if (field === "semantic") {
        bad = { ...healthy };
        Object.defineProperty(bad, "ir", { enumerable: true, get: getter });
      } else if (field === "abi") {
        bad = { ...healthy };
        Object.defineProperty(bad, "abi", { enumerable: true, get: getter });
      } else {
        const view = { ...healthy.runtime[0]! };
        Object.defineProperty(view, "prepared", { enumerable: true, get: getter });
        bad = { ...healthy, runtime: [view] };
      }
      expect(() => planPhysicalSetup(bad, replayOptions("linear", "standalone"), bad.runtime[0]!)).toThrow(
        PreparedIrProgramInvariantError,
      );
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it("retains located typed refusal for an allocating old program without attachment", () => {
    const old = withoutAttachment(actual().program);
    const result = expectLocatedUnsupported(old);
    expect(result.detail).toContain("no final linear-allocation-facts-v1 attachment");
  });

  it("refuses incomplete namespaces with the same canonical location and typed classification", () => {
    const bad = missingEscape(actual().program);
    const result = expectLocatedUnsupported(bad);
    expect(result.detail).toContain("both ownership and escape");
  });

  it("retains well-formed uncovered arithmetic as a located capability refusal", () => {
    const bad = uncoveredSubtraction(actual().program);
    const result = expectLocatedUnsupported(bad);
    expect(result.detail).toContain("finite semantic profile");
  });

  it("keeps canonical ABI contradiction ahead of missing allocating evidence", () => {
    const old = withoutAttachment(actual().program);
    const bad = { ...old, abi: { ...old.abi, entries: [...old.abi.entries, old.abi.entries[0]!] } };
    expect(() => locatedPhysical(bad)).toThrow(PreparedIrProgramInvariantError);
  });

  it.each(["copied-view", "other-program"] as const)(
    "requires actual selected projection membership for %s",
    (kind) => {
      const program = actual().program;
      const view: PreparedIrProgramRuntimeProjection =
        kind === "copied-view" ? { ...program.runtime[0]! } : actual().program.runtime[0]!;
      expect(() => requirePreparedLinearMemoryInput(program, view)).toThrow(PreparedIrProgramInvariantError);
      expect(() => planPhysicalSetup(program, replayOptions("linear", "standalone"), view)).toThrow(
        PreparedIrProgramInvariantError,
      );
    },
  );

  it("proves reachable producer observers before separate covered consumer intervals", () => {
    const obs = observers();
    const { program } = actual();
    const positive = obs.counts();
    for (const key of ["encoding", "ownership", "escape", "stack", "registryFresh", "registrySnapshot"])
      expect(positive[key], `positive producer ${key} observer was not attached`).toBeGreaterThan(0);
    expect(positive.factsProducer).toBe(1);
    const bytes = encodePreparedIrProgram(program);
    const scalar = actual(scalarSource).program;
    obs.reset();
    assertPreparedIrProgram(withoutAttachment(scalar));
    const positiveLegacy = obs.counts();
    expect(positiveLegacy.encoding).toBeGreaterThan(0);
    expect(positiveLegacy.registrySnapshot).toBeGreaterThan(0);
    console.info("J212 positive genuine legacy before covered intervals", positiveLegacy);
    const boundaries: [string, () => unknown][] = [
      ["generic", () => assertPreparedIrProgram(program)],
      ["required", () => assertPreparedIrProgramLinearAllocationEvidence(program, program.runtime[0]!)],
      ["strict", () => requirePreparedLinearMemoryInput(program, program.runtime[0]!)],
      ["encode", () => encodePreparedIrProgram(program)],
      ["decode-replay", () => decodePreparedIrProgram(bytes)],
      ["physical", () => locatedPhysical(program)],
    ];
    for (const [name, callback] of boundaries) {
      obs.reset();
      callback();
      const measured = obs.counts();
      console.info("J212 actual covered consumer interval", name, measured);
      for (const [key, count] of Object.entries(measured)) expect(count, `${name}:${key}`).toBe(0);
    }
    // Counts are actual mock-call observations on the real bindings, never substituted implementations.
    console.info("J212 positive producer", positive);
  });

  it("observes genuine legacy and unknown-scalar fallback work rather than crediting zero", () => {
    const obs = observers();
    const { program } = actual(scalarSource);
    expect(obs.all.encoding.mock.calls.length).toBeGreaterThan(0);
    expect(obs.all.stack.mock.calls.length).toBeGreaterThan(0);
    const old = withoutAttachment(program);
    obs.reset();
    assertPreparedIrProgram(old);
    const legacy = obs.counts();
    expect(legacy.encoding).toBeGreaterThan(0);
    expect(legacy.registrySnapshot).toBeGreaterThan(0);
    obs.reset();
    assertPreparedIrProgram(program); // Actual f64.mul source is outside the finite add/compare profile.
    const unknown = obs.counts();
    expect(unknown.encoding).toBeGreaterThan(0);
    expect(unknown.registrySnapshot).toBeGreaterThan(0);
    expect(assertPreparedIrProgramLinearAllocationEvidence(program, program.runtime[0]!)).toBeUndefined();
    console.info("J212 genuine legacy", legacy, "generic unknown scalar", unknown);
  });

  it.each([false, true])("refuses actual host policy before source inventory (empty=%s)", (empty) => {
    const input = request();
    const host = {
      ...input,
      policy: { backend: "linear" as const, target: "host" as const },
      ...(empty ? { sourceFiles: [] } : {}),
    };
    expect(() => prepareIrProgramSources(host)).toThrow(IrUnsupportedError);
    expect(() => prepareWholeIrProgram(host)).toThrow(IrUnsupportedError);
  });

  it("refuses typed host policy before owned source work", () => {
    const { source } = lower();
    const host = { backend: "linear" as const, target: "host" as const };
    expect(() =>
      prepareTypedIrProgram(captureTypedIrProgramInput(source), {
        ...typedOptions,
        policy: host,
        runtimePolicies: [host],
      }),
    ).toThrow(IrUnsupportedError);
  });

  it("selects the frontend vector option by own DATA without invoking a getter", () => {
    const input = request();
    const getter = vi.fn(() => "native-f64");
    Object.defineProperty(input, "linearVectorProjection", { enumerable: true, get: getter });
    expect(() => prepareIrProgramSources(input)).toThrow(PreparedIrProgramInvariantError);
    expect(getter).not.toHaveBeenCalled();
  });
});
