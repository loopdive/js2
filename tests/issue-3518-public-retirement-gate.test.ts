// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  boundedProcess,
  collectPublicEntries,
  evidenceProblems,
  FIXTURES,
  inventoryFor,
  loadManifest,
  manifestProblems,
  observePublicEntry,
  oracleProblems,
  phaseProblems,
  reportProblems,
  replaySnapshot,
  type Evidence,
} from "../scripts/check-ir-retirement.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { subscribePreparedIrProgram, type PreparedIrProgramObservation } from "../src/ir/program-observation.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { replayOptions, replayProgram } from "./helpers/ir-whole-program-replay.js";

const manifest = loadManifest();
const scalar = manifest.fixtures.find((f) => f.id === "scalar")!;
const scalarEntry = manifest.entries.find((e) => e.id === "scalar/compile/gc")!;

describe("public retirement instrument, real production observations", () => {
  let positive: Evidence;
  beforeAll(() => {
    positive = observePublicEntry(scalarEntry);
  }, 60000);

  it("pins every exact file/unit/profile/API triple and executes the independent JS oracle", async () => {
    expect(manifestProblems(manifest)).toEqual([]);
    expect(manifest.entries).toHaveLength(49);
    expect(await oracleProblems(manifest)).toEqual([]);
    const changed = structuredClone(manifest);
    changed.fixtures[0]!.calls[0]!.expected++;
    expect(await oracleProblems(changed)).toContain("scalar:pinned-js-oracle");
  });

  it("executes the scalar control without calling it public migration completion", () => {
    expect(positive.success).toBe(true);
    expect(positive.runtime.map((r) => r.actual)).toEqual([17, -4]);
    expect(positive.runtime.every((r) => r.match)).toBe(true);
    expect(evidenceProblems(scalar, scalarEntry, positive)).toContain("direct-production-generator");
    expect(evidenceProblems(scalar, scalarEntry, positive)).toContain("missing-prepared-observation");
    expect(positive.audit!.legacyEntries.reduce((n, e) => n + e.count, 0)).toBeGreaterThan(0);
  });

  it("executes the namespace direct-route detector control", () => {
    const entry = manifest.entries.find((e) => e.id === "namespace/compile/gc")!;
    const row = observePublicEntry(entry);
    expect(row.success).toBe(true);
    expect(row.runtime.map((r) => r.actual)).toEqual([6, -1]);
    expect(row.audit!.legacyEntries.some((e) => e.entryPoint === "compileModuleInitBody")).toBe(true);
    expect(evidenceProblems(manifest.fixtures.find((f) => f.id === "namespace")!, entry, row)).toContain(
      "direct-dispatch-entry",
    );
  }, 60000);

  it("deleting and duplicating real terminal rows fails for the exact census defect", () => {
    const deleted = { ...positive, outcomes: positive.outcomes!.filter((o) => !o.unitId) };
    expect(evidenceProblems(scalar, scalarEntry, deleted)).toContain("terminal-bijection");
    const duplicate = { ...positive, outcomes: [...positive.outcomes!, positive.outcomes!.find((o) => o.unitId)!] };
    expect(evidenceProblems(scalar, scalarEntry, duplicate)).toContain("duplicate-terminal");
  });

  it("same-spelling source identities cannot exchange ownership", () => {
    const entry = manifest.entries.find((e) => e.id === "graph/compileMulti/gc")!;
    const fixture = manifest.fixtures.find((f) => f.id === "graph")!;
    const row = observePublicEntry(entry);
    const units = inventoryFor(fixture, entry).terminalUnits.filter((u) => u.displayName === "helper");
    expect(units).toHaveLength(2);
    expect(units[0]!.sourceId).not.toBe(units[1]!.sourceId);
    // Mutate captured outcomes, never a compiler-owned inventory or collector.
    expect(row.outcomes!.filter((o) => units.some((u) => u.id === o.unitId))).toHaveLength(2);
    const outcomes = row.outcomes!.map((o) =>
      o.unitId === units[0]!.id
        ? { ...o, sourceId: units[1]!.sourceId }
        : o.unitId === units[1]!.id
          ? { ...o, sourceId: units[0]!.sourceId }
          : o,
    );
    expect(evidenceProblems(fixture, entry, { ...row, outcomes })).toContain("terminal-bijection");
  }, 60000);

  it("counts an injected discarded direct entry, independent of final-body booleans", () => {
    const audit = positive.audit!;
    const injected = { ...audit, legacyEntries: [{ ...audit.legacyEntries[0]!, count: 3 }] };
    expect(positive.outcomes!.every((o) => !o.legacyBodyEmitted)).toBe(true);
    expect(evidenceProblems(scalar, scalarEntry, { ...positive, audit: injected })).toContain("direct-dispatch-entry");
    expect(injected.legacyEntries.reduce((n, e) => n + e.count, 0)).toBe(3);
  });

  it("rejects skipped entries, zero corpus, renamed duplicate triples and missing profiles", () => {
    expect(reportProblems(manifest, [positive])).toContain("entry-bijection");
    expect(manifestProblems({ ...manifest, entries: [], fixtures: [] })).toContain("corpus-denominator");
    const duplicate = structuredClone(manifest);
    duplicate.entries[1] = { ...duplicate.entries[0]!, id: "different-id-same-triple" };
    expect(manifestProblems(duplicate)).toContain("entry-triple-matrix");
    expect(manifestProblems({ ...manifest, profiles: manifest.profiles.slice(1) })).toContain("profile-matrix");
  });

  it("rejects source changes, an always-green result, missing runtime and publication after failure", () => {
    expect(evidenceProblems(scalar, scalarEntry, { ...positive, sourceHash: "donor" })).toContain("source-corpus-hash");
    expect(
      evidenceProblems(scalar, scalarEntry, {
        entry: scalarEntry.id,
        sourceHash: "",
        success: true,
        artifactBytes: 1,
        phases: [],
        runtime: [],
        errors: [],
      }),
    ).toEqual(
      expect.arrayContaining(["missing-terminal-observations", "missing-direct-dispatch-audit", "runtime-oracle"]),
    );
    expect(evidenceProblems(scalar, scalarEntry, { ...positive, runtime: [] })).toContain("runtime-oracle");
    expect(evidenceProblems(scalar, scalarEntry, { ...positive, success: false })).toContain(
      "publication-after-failure",
    );
  });

  it.each(["pending", "wasm-loop"])("bounds %s in a child process without hanging the suite", (mode) => {
    expect(boundedProcess([join(FIXTURES, "timeout-control.mjs"), mode], 500).problem).toBe("process-timeout");
  });

  it("fails closed on missing, malformed and nonzero process output", () => {
    expect(boundedProcess(["--eval", ""]).problem).toBe("missing-process-output");
    expect(boundedProcess(["--eval", "console.log('not JSON')"]).problem).toBe("invalid-process-output");
    expect(boundedProcess(["--eval", "process.exit(2)"]).problem).toContain("missing-process-result");
  });

  it("retains explicit failure evidence for all 49 entries and continues after timeout/malformed children", () => {
    const visited: string[] = [];
    const rows = collectPublicEntries(manifest, (entry) => {
      visited.push(entry.id);
      // Collection-only control: every entry fails; no manufactured production success.
      throw new Error(
        visited.length === 1
          ? "process-timeout"
          : visited.length === 2
            ? "malformed-entry-evidence"
            : "unavailable-control",
      );
    });
    expect(visited).toEqual(manifest.entries.map((e) => e.id));
    expect(rows).toHaveLength(49);
    expect(rows.every((r) => r.processResult === "unavailable" && r.success === null && r.artifactBytes === 0)).toBe(
      true,
    );
    expect(rows[0]!.errors[0]).toContain("process-timeout");
    expect(rows[1]!.errors[0]).toContain("malformed-entry-evidence");
    expect(rows[48]!.errors[0]).toContain("unavailable-control");
    expect(reportProblems(manifest, rows)).not.toContain("entry-bijection");
    expect(reportProblems(manifest, rows)).toContain(`${manifest.entries[0]!.id}:missing-terminal-observations`);
  });
});

function prepare(source: string, both = true) {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  return prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend: "wasmgc", target: "host" },
    runtimePolicies: both
      ? [
          { backend: "wasmgc", target: "host" },
          { backend: "linear", target: "host" },
        ]
      : [{ backend: "wasmgc", target: "host" }],
    deferTopLevelInit: false,
  });
}

describe("recovered A/C dependency controls — never public-route credit", () => {
  it("runs unchanged C fresh-process replay on both backends, including a real global read", () => {
    const result = prepare(
      "export let value: number = 4; export function calculate(x: number): number { return x * 3 + 2; }",
    );
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(result.detail);
    const fixture = { ...scalar, calls: [{ export: "value", args: null, expected: 4 }, ...scalar.calls] };
    expect(replaySnapshot(result.program, fixture, "host")).toMatchObject({ ok: true, failures: [] });
    // The same snapshot lacks these projections. Never silently substitute host replay.
    expect(replaySnapshot(result.program, fixture, "standalone").ok).toBe(false);
  }, 60000);
  it("captures real prepare/accept/emit ordering and rejects reordered phases", async () => {
    const events: PreparedIrProgramObservation[] = [];
    const unsubscribe = subscribePreparedIrProgram((e) => events.push(e));
    try {
      const prepared = prepare(readFileSync(join(FIXTURES, "scalar.ts"), "utf8"));
      expect(prepared.kind).toBe("prepared");
      if (prepared.kind !== "prepared") throw new Error(prepared.detail);
      const run = await replayProgram(prepared.program, replayOptions("wasmgc"));
      expect(run.kind).toBe("ran");
      expect(phaseProblems(events)).toEqual([]);
      expect(phaseProblems([events[1]!, events[0]!, ...events.slice(2)])).toContain("phase-order");
      expect(phaseProblems(events.slice(1))).toContain("phase-order");
      if (run.kind !== "ran") throw new Error(run.failure.detail);
      expect((run.run.exports.calculate as (n: number) => number)(5)).toBe(17);
      const linear = await replayProgram(
        decodePreparedIrProgram(encodePreparedIrProgram(prepared.program)),
        replayOptions("linear"),
      );
      expect(linear.kind).toBe("ran");
      if (linear.kind !== "ran") throw new Error(linear.failure.detail);
      expect((linear.run.exports.calculate as (n: number) => number)(-2)).toBe(-4);
    } finally {
      unsubscribe();
    }
  });

  it("keeps typed async refusal before acceptance/emission with its original denominator", () => {
    const events: PreparedIrProgramObservation[] = [];
    const unsubscribe = subscribePreparedIrProgram((e) => events.push(e));
    try {
      const result = prepare(
        "export async function run(x: number): Promise<number> { const y = await (x + 1); return await (y + 2); }",
        false,
      );
      expect(result.kind).toBe("prepared");
      if (result.kind !== "prepared") throw new Error(result.detail);
      const count = result.program.inventory.terminalUnits.length;
      expect(count).toBe(1);
      const refused = acceptPreparedIrProgram(result.program, replayOptions("wasmgc"));
      expect(refused.kind).toBe("unsupported");
      if (refused.kind !== "unsupported") throw new Error("expected located async capability refusal");
      expect(refused.sourceFile).toBe("entry.ts");
      expect(refused.unitId).toBe(result.program.inventory.terminalUnits[0]!.id);
      expect(refused.detail).toMatch(/async|physical/);
      expect(events.map((e) => e.phase)).toEqual(["prepared"]);
      expect(result.program.inventory.terminalUnits).toHaveLength(count);
    } finally {
      unsubscribe();
    }
  });

  it("real codec rejects removing a runtime provider and replaying a donor projection", () => {
    const source = prepare("export async function run(x: number): Promise<number> { return await (x + 1); }", false);
    const donor = prepare("export function calculate(x: number): number { return x + 91; }");
    expect(source.kind).toBe("prepared");
    expect(donor.kind).toBe("prepared");
    if (source.kind !== "prepared" || donor.kind !== "prepared") throw new Error("dependency preparation failed");
    const removed = JSON.parse(encodePreparedIrProgram(source.program));
    const providers = removed.program.runtime[0].prepared.manifest.providers;
    expect(providers.length).toBeGreaterThan(0);
    providers.pop();
    const sortJson = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(sortJson).join(",")}]`;
      if (value && typeof value === "object")
        return `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${sortJson((value as Record<string, unknown>)[k])}`)
          .join(",")}}`;
      return JSON.stringify(value);
    };
    expect(() => decodePreparedIrProgram(sortJson(removed))).toThrow(/provider|runtime|projection|manifest/);
    const replaced = JSON.parse(encodePreparedIrProgram(source.program));
    replaced.program.runtime = JSON.parse(encodePreparedIrProgram(donor.program)).program.runtime;
    expect(() => decodePreparedIrProgram(sortJson(replaced))).toThrow(/runtime|projection|unit|function|body/);
  });
});
