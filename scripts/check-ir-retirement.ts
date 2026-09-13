// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Public-route completion evidence. Exit 1 includes unavailable and unsupported evidence. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as api from "../src/index.js";
import { compileSourceSync } from "../src/compiler.js";
import { buildIrUnitInventory, type IrUnitInventory } from "../src/ir/identity.js";
import { nonExecutableOutcomeDefect } from "../src/ir/outcomes.js";
import { subscribePreparedIrProgram, type PreparedIrProgramObservation } from "../src/ir/program-observation.js";
import { digestEncodedPreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import type { PreparedIrProgram } from "../src/ir/program.js";
import { ts } from "../src/ts-api.js";

export const ROOT = resolve(import.meta.dirname, "..");
export const FIXTURES = join(ROOT, "tests/fixtures/ir-retirement");
export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const GATE_HASH = sha256(readFileSync(import.meta.filename));
export interface Call {
  export: string;
  args: number[] | null;
  expected: number;
}
export interface Fixture {
  id: string;
  entry: string;
  sources: { file: string; sha256: string }[];
  units: { source: string; kind: string; name: string; ordinal: number; terminal: boolean }[];
  calls: Call[];
}
export interface Entry {
  id: string;
  fixture: string;
  api: string;
  profile: string;
}
export interface Manifest {
  schema: number;
  base: string;
  spec: string;
  oracleSha256: string;
  fixtures: Fixture[];
  profiles: { id: string; options: api.CompileOptions }[];
  entries: Entry[];
}
export const loadManifest = (): Manifest => JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sorted = (rows: unknown[]): string[] => rows.map((row) => JSON.stringify(row)).sort();
const unique = (rows: string[]): boolean => new Set(rows).size === rows.length;

const PUBLIC_APIS = [
  "compile",
  "compileSourceSync",
  "compileMulti",
  "compileFiles",
  "compileProject",
  "compileToObject",
  "compileToWat",
];
const PROFILES = ["gc", "gc-fast", "standalone", "standalone-fast", "linear", "wasi"];
export function requiredTriples(): string[] {
  return [
    ...PUBLIC_APIS.flatMap((a) =>
      PROFILES.filter((p) => a !== "compileToWat" || p === "gc").map((p) => `scalar/${a}/${p}`),
    ),
    ...["namespace", "class-closure", "dynamic", "cjs", "graph", "async"].flatMap((f) =>
      ["gc", "standalone"].map((p) => `${f}/${["graph", "async"].includes(f) ? "compileMulti" : "compile"}/${p}`),
    ),
  ].sort();
}

export function inventoryFor(fixture: Fixture, entry: Entry): IrUnitInventory {
  const single = ["compile", "compileSourceSync", "compileToObject", "compileToWat"].includes(entry.api);
  const files = fixture.sources.map((source) =>
    ts.createSourceFile(
      single ? "input.ts" : join(FIXTURES, source.file),
      readFileSync(join(FIXTURES, source.file), "utf8"),
      ts.ScriptTarget.ES2022,
      true,
    ),
  );
  return buildIrUnitInventory(files, {
    entrySource: files[fixture.sources.findIndex((s) => s.file === fixture.entry)]!,
  });
}

/** Independently pinned original-input census, never inferred from candidate outcomes. */
export function manifestProblems(manifest: Manifest): string[] {
  const failures: string[] = [];
  if (manifest.schema !== 1 || manifest.fixtures.length !== 7 || manifest.entries.length !== 49)
    failures.push("corpus-denominator");
  if (!unique(manifest.entries.map((e) => e.id)) || !unique(manifest.fixtures.map((f) => f.id)))
    failures.push("duplicate-entry");
  if (!same(manifest.entries.map((e) => `${e.fixture}/${e.api}/${e.profile}`).sort(), requiredTriples()))
    failures.push("entry-triple-matrix");
  if (
    !same(manifest.profiles, [
      { id: "gc", options: { target: "gc" } },
      { id: "gc-fast", options: { target: "gc", fast: true } },
      { id: "standalone", options: { target: "standalone" } },
      { id: "standalone-fast", options: { target: "standalone", fast: true } },
      { id: "linear", options: { target: "linear" } },
      { id: "wasi", options: { target: "wasi" } },
    ])
  )
    failures.push("profile-matrix");
  if (
    !same(
      [...new Set(manifest.entries.map((e) => e.api))].sort(),
      [
        "compile",
        "compileFiles",
        "compileMulti",
        "compileProject",
        "compileSourceSync",
        "compileToObject",
        "compileToWat",
      ].sort(),
    )
  )
    failures.push("api-denominator");
  if (sha256(readFileSync(join(FIXTURES, "oracle.mjs"))) !== manifest.oracleSha256) failures.push("oracle-hash");
  const sourceFiles = [...new Set(manifest.fixtures.flatMap((f) => f.sources.map((s) => s.file)))].sort();
  if (
    !same(
      readdirSync(FIXTURES)
        .filter((f) => /\.(ts|cjs)$/.test(f))
        .sort(),
      sourceFiles,
    )
  )
    failures.push("fixture-file-bijection");
  for (const f of manifest.fixtures) {
    if (!f.sources.length || !f.units.length || !f.calls.length || !unique(f.sources.map((s) => s.file)))
      failures.push(`${f.id}:fixture-denominator`);
    for (const s of f.sources) {
      if (basename(s.file) !== s.file || sha256(readFileSync(join(FIXTURES, s.file))) !== s.sha256)
        failures.push(`${f.id}:source-hash`);
    }
    const inventory = inventoryFor(f, {
      id: "inventory",
      fixture: f.id,
      api: f.sources.length === 1 ? "compile" : "compileMulti",
      profile: "gc",
    });
    const units = inventory.allUnits.map((u) => ({
      source: f.sources.length === 1 ? f.entry : inventory.sources.find((s) => s.id === u.sourceId)!.sourceKey,
      kind: u.kind,
      name: u.displayName,
      ordinal: u.ordinal,
      terminal: u.terminal,
    }));
    if (!same(sorted(units), sorted(f.units))) failures.push(`${f.id}:pinned-unit-bijection`);
  }
  for (const e of manifest.entries)
    if (!manifest.fixtures.some((f) => f.id === e.fixture) || !manifest.profiles.some((p) => p.id === e.profile))
      failures.push(`${e.id}:entry-reference`);
  return failures;
}

export interface RuntimeRow {
  export: string;
  args: number[] | null;
  expected: number;
  actual?: unknown;
  error?: string;
  match: boolean;
}
export interface Evidence {
  processResult?: "completed" | "unavailable";
  entry: string;
  sourceHash: string;
  gateHash?: string;
  success: boolean | null;
  artifactBytes: number;
  outcomes?: api.CompileResult["irOutcomes"];
  audit?: api.CompileResult["irBodyRouteAudit"];
  phases: { phase: string; programId: string }[];
  runtime: RuntimeRow[];
  errors: string[];
  replay?: { ok: boolean; digest: string; failures: string[] };
}
export const corpusHash = (manifest: Manifest): string => sha256(JSON.stringify(manifest));
export const fixtureHash = (fixture: Fixture): string => sha256(JSON.stringify(fixture));

export function phaseProblems(phases: Evidence["phases"]): string[] {
  if (!phases.length) return ["missing-prepared-observation"];
  if (
    !same(
      phases.map((p) => p.phase),
      ["prepared", "accepted", "emission-started", "emitted"],
    )
  )
    return ["phase-order"];
  return new Set(phases.map((p) => p.programId)).size === 1 ? [] : ["foreign-program-phase"];
}

/** Validate raw observations; no summary or caller-supplied `ok` can replace receipts. */
export function evidenceProblems(fixture: Fixture, entry: Entry, evidence: Evidence): string[] {
  const failures = [...phaseProblems(evidence.phases)];
  if (evidence.entry !== entry.id || evidence.sourceHash !== fixtureHash(fixture)) failures.push("source-corpus-hash");
  const inventory = inventoryFor(fixture, entry);
  const audit = evidence.audit;
  const outcomes = evidence.outcomes;
  if (!audit) failures.push("missing-direct-dispatch-audit");
  else {
    if (audit.generator !== "generateWholeProgramModule") failures.push("direct-production-generator");
    if (audit.legacyEntries.some((e) => !Number.isSafeInteger(e.count) || e.count <= 0))
      failures.push("invalid-direct-count");
    if (audit.legacyEntries.reduce((n, e) => n + e.count, 0) > 0 || audit.unattributedLegacyEntryCount !== 0)
      failures.push("direct-dispatch-entry");
    if (!audit.structurallyComplete || audit.violations.length) failures.push("corrupt-route-audit");
    if (
      !same(
        sorted(audit.sources.map((s) => [s.id, s.sourceKey])),
        sorted(inventory.sources.map((s) => [s.id, s.sourceKey])),
      ) ||
      audit.sourceCount !== inventory.sources.length
    )
      failures.push("source-bijection");
    if (
      !same(
        sorted(audit.dispositions.map((u) => [u.unitId, u.sourceId, u.terminal, u.terminalOwnerId])),
        sorted(inventory.allUnits.map((u) => [u.id, u.sourceId, u.terminal, u.terminalOwnerId])),
      ) ||
      audit.allUnitCount !== inventory.allUnits.length
    )
      failures.push("unit-bijection");
    if (audit.terminalUnitCount !== inventory.terminalUnits.length) failures.push("terminal-denominator");
    for (const u of audit.dispositions.filter((u) => !u.terminal)) {
      if (
        !u.terminalOwnerId ||
        !inventory.terminalUnits.some((t) => t.id === u.terminalOwnerId) ||
        u.disposition !== "owned-support-ir-owner"
      )
        failures.push("support-owner");
    }
    if (
      !unique(audit.derivedUnits.map((u) => u.id)) ||
      audit.derivedUnits.some(
        (u) =>
          u.disposition !== "derived-ir-owner" ||
          !inventory.sources.some((s) => s.id === u.sourceId) ||
          !inventory.allUnits.some((p) => p.id === u.parentId) ||
          !inventory.terminalUnits.some((t) => t.id === u.terminalOwnerId),
      )
    )
      failures.push("derived-owner");
  }
  if (!outcomes) failures.push("missing-terminal-observations");
  else {
    const keyed = outcomes.filter((o) => o.unitId !== undefined);
    if (!unique(keyed.map((o) => o.unitId!))) failures.push("duplicate-terminal");
    if (
      !same(
        sorted(keyed.map((o) => [o.unitId, o.sourceId])),
        sorted(inventory.terminalUnits.map((u) => [u.id, u.sourceId])),
      )
    )
      failures.push("terminal-bijection");
    for (const o of outcomes) {
      if (o.kind === "non-executable") {
        if (nonExecutableOutcomeDefect(o)) failures.push("invalid-non-executable");
      } else if (
        o.kind !== "emitted" ||
        o.irBodyEmissions !== 1 ||
        o.directBodyEmissions !== 0 ||
        o.legacyBodyEmitted ||
        !o.irBodyEmitted
      )
        failures.push("terminal-not-owned-once");
    }
    for (const s of inventory.sources) {
      const expected = inventory.terminalUnits.some((u) => u.sourceId === s.id && u.kind === "module-init") ? 0 : 1;
      if (
        outcomes.filter((o) => o.sourceId === s.id && o.kind === "non-executable" && o.unitId === undefined).length !==
        expected
      )
        failures.push("non-executable-source-bijection");
    }
    if (
      evidence.phases.length &&
      keyed.some((o) => !("preparedProgramId" in o) || o.preparedProgramId !== evidence.phases[0]!.programId)
    )
      failures.push("terminal-program-join");
    if (outcomes.some((o) => !inventory.sources.some((s) => s.id === o.sourceId)))
      failures.push("foreign-terminal-source");
  }
  if (!evidence.success || evidence.artifactBytes <= 0) failures.push("not-published-successfully");
  if (evidence.success === false && evidence.artifactBytes > 0) failures.push("publication-after-failure");
  if (
    !same(
      evidence.runtime.map((r) => [r.export, r.args, r.expected]),
      fixture.calls.map((r) => [r.export, r.args, r.expected]),
    ) ||
    evidence.runtime.some((r) => !r.match || !Object.is(r.actual, r.expected))
  )
    failures.push("runtime-oracle");
  if (!evidence.replay?.ok || !evidence.replay.digest || evidence.replay.failures.length)
    failures.push("missing-or-failed-fresh-replay");
  if (evidence.errors.length) failures.push(...evidence.errors);
  return [...new Set(failures)];
}

async function execute(exports: Record<string, unknown>, calls: Call[]): Promise<RuntimeRow[]> {
  const rows: RuntimeRow[] = [];
  for (const call of calls) {
    try {
      const member = exports[call.export];
      const actual =
        call.args === null
          ? member instanceof WebAssembly.Global
            ? member.value
            : member
          : await (member as (...args: number[]) => unknown)(...call.args);
      const serialized =
        actual === undefined
          ? { $undefined: true }
          : typeof actual === "number" && !Number.isFinite(actual)
            ? { $number: String(actual) }
            : actual;
      rows.push({ ...call, actual: serialized, match: Object.is(actual, call.expected) });
    } catch (error) {
      rows.push({ ...call, error: String(error), match: false });
    }
  }
  return rows;
}

/** Public APIs only. The recovered observation subscription is the sole phase collector. */
async function observeEntry(manifest: Manifest, entry: Entry): Promise<Evidence> {
  const fixture = manifest.fixtures.find((f) => f.id === entry.fixture)!;
  const options = { ...manifest.profiles.find((p) => p.id === entry.profile)!.options, trackIrOutcomes: true };
  const sourceHash = fixtureHash({
    ...fixture,
    sources: fixture.sources.map((s) => ({ ...s, sha256: sha256(readFileSync(join(FIXTURES, s.file))) })),
  });
  const evidence: Evidence = {
    processResult: "completed",
    entry: entry.id,
    sourceHash,
    gateHash: GATE_HASH,
    success: false,
    artifactBytes: 0,
    phases: [],
    runtime: [],
    errors: [],
  };
  const observed: PreparedIrProgramObservation[] = [];
  const unsubscribe = subscribePreparedIrProgram((event) => observed.push(event));
  try {
    const source = readFileSync(join(FIXTURES, fixture.entry), "utf8");
    let result: api.CompileResult | undefined;
    switch (entry.api) {
      case "compile":
        result = await api.compile(source, options);
        break;
      case "compileSourceSync":
        result = compileSourceSync(source, options);
        break;
      case "compileMulti":
        result = await api.compileMulti(
          Object.fromEntries(
            fixture.sources.map((s) => [join(FIXTURES, s.file), readFileSync(join(FIXTURES, s.file), "utf8")]),
          ),
          join(FIXTURES, fixture.entry),
          options,
        );
        break;
      case "compileFiles":
        result = await api.compileFiles(join(FIXTURES, fixture.entry), options);
        break;
      case "compileProject":
        result = await api.compileProject(join(FIXTURES, fixture.entry), options);
        break;
      case "compileToWat": {
        const wat = await api.compileToWat(source);
        evidence.artifactBytes = Buffer.byteLength(wat);
        evidence.success = null;
        evidence.errors.push("dependency:wat-public-api-lacks-result-audit-and-execution-adapter");
        break;
      }
      case "compileToObject": {
        const object = api.compileToObject(source, options);
        evidence.artifactBytes = object.object.byteLength;
        evidence.success = object.success;
        evidence.errors.push(
          ...object.errors.filter((e) => e.severity === "error").map((e) => `object-error:${e.line}:${e.message}`),
        );
        evidence.errors.push("dependency:object-public-api-lacks-result-audit-and-linked-execution");
        break;
      }
      default:
        evidence.errors.push("unavailable-public-api");
    }
    if (result) {
      evidence.success = result.success;
      evidence.artifactBytes = result.binary.byteLength;
      evidence.audit = result.irBodyRouteAudit;
      evidence.outcomes = result.irOutcomes;
      evidence.errors.push(
        ...result.errors
          .filter((e) => e.severity === "error")
          .map((e) => `compile-error:${e.file ?? "unknown"}:${e.line}:${e.message}`),
      );
      if (result.success && result.binary.byteLength) {
        const imports = api.buildCompiledImports(result);
        const module = await WebAssembly.compile(Uint8Array.from(result.binary));
        const instance = await WebAssembly.instantiate(module, imports as unknown as WebAssembly.Imports);
        imports.setInstance?.(instance);
        if (result.targetProfile?.target === "standalone" || result.targetProfile?.target === "wasi") {
          const start = instance.exports._start;
          if (typeof start === "function") start();
        }
        const wrapped = api.wrapCompiledExports(result, instance);
        // Read globals from the real instance so the wrapper cannot snapshot a live binding.
        const exports = new Proxy(wrapped, {
          get: (target, name: string) =>
            instance.exports[name] instanceof WebAssembly.Global ? instance.exports[name] : target[name],
        });
        evidence.runtime = await execute(exports, fixture.calls);
      } else evidence.errors.push("dependency:public-failure-lacks-typed-prepublication-refusal-receipt");
    }
  } catch (error) {
    evidence.errors.push(
      `${evidence.success ? "runtime-harness-error" : "public-api-error"}:${error instanceof Error ? error.stack : String(error)}`,
    );
  } finally {
    unsubscribe();
  }
  evidence.phases = observed.map((e) => ({ phase: e.phase, programId: e.programId }));
  const prepared = observed.find((e) => e.phase === "prepared");
  if (prepared) {
    const runtimeTarget =
      options.target === "gc" || options.target === "linear" || options.target === undefined ? "host" : options.target;
    evidence.replay = replaySnapshot(prepared.program, fixture, runtimeTarget);
  }
  return evidence;
}

/** Dependency control may call this with A's real program; that is not public-route credit. */
export function replaySnapshot(
  program: PreparedIrProgram,
  fixture: Fixture,
  target: "host" | "standalone" | "wasi",
): NonNullable<Evidence["replay"]> {
  const scratch = mkdtempSync(join(tmpdir(), "js2-retirement-replay-"));
  try {
    for (const call of fixture.calls.filter((c) => c.args === null)) {
      const exported = program.abi.entries.find(
        (e) => e.contract.kind === "export" && e.contract.externalName === call.export,
      )?.contract;
      if (
        exported?.kind !== "export" ||
        program.abi.entries.find((e) => e.plan.id === exported.targetId)?.contract.kind !== "global"
      )
        throw new Error(`dependency:replay-global-read-requires-global-ABI:${call.export}`);
    }
    const snapshot = encodePreparedIrProgram(program);
    writeFileSync(join(scratch, "program.json"), snapshot);
    // C's compareExports explicitly reads WebAssembly.Global when args is empty.
    // Async scheduling is outside C's synchronous replay oracle contract.
    if (fixture.id === "async")
      throw new Error("dependency:C-replay-oracle-is-synchronous-no-async-scheduling-adapter");
    writeFileSync(
      join(scratch, "oracle.json"),
      JSON.stringify({
        targets: [
          { backend: "wasmgc", target },
          { backend: "linear", target },
        ],
        calls: fixture.calls.map((c) => ({ ...c, args: c.args ?? [] })),
      }),
    );
    const replay = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/ir-whole-program-replay.mjs",
        join(scratch, "program.json"),
        join(scratch, "oracle.json"),
      ],
      { cwd: ROOT, encoding: "utf8", timeout: 45000, maxBuffer: 4 * 1024 * 1024 },
    );
    const report = JSON.parse(replay.stdout);
    const expectedTargets = [`wasmgc:${target}`, `linear:${target}`].sort();
    const complete =
      same(Object.keys(report.targets).sort(), expectedTargets) &&
      expectedTargets.every((key) => {
        const r = report.targets[key];
        return (
          r.kind === "ran" &&
          r.bytes > 0 &&
          r.emittedUnits > 0 &&
          r.emittedUnits === r.projectionUnits &&
          r.rows.length === fixture.calls.length &&
          r.rows.every((row: { match: boolean }) => row.match === true)
        );
      });
    const ok =
      replay.status === 0 &&
      report.ok === true &&
      report.reencodedIdentical === true &&
      report.loadedModuleCount > 0 &&
      report.frontendModules.length === 0 &&
      report.typescriptModules.length === 0 &&
      report.digest === digestEncodedPreparedIrProgram(snapshot) &&
      complete &&
      report.failures.length === 0;
    return { ok, digest: report.digest, failures: ok ? [] : [...report.failures, "incomplete-replay-evidence"] };
  } catch (error) {
    return { ok: false, digest: "", failures: [`replay-process:${String(error)}`] };
  } finally {
    rmSync(scratch, { recursive: true });
  }
}

export function reportProblems(manifest: Manifest, rows: Evidence[]): string[] {
  const failures = manifestProblems(manifest);
  if (!same(rows.map((r) => r.entry).sort(), manifest.entries.map((e) => e.id).sort()))
    failures.push("entry-bijection");
  if (rows.some((r) => r.gateHash !== GATE_HASH)) failures.push("gate-process-provenance");
  for (const e of manifest.entries) {
    const row = rows.find((r) => r.entry === e.id);
    if (row)
      failures.push(
        ...evidenceProblems(manifest.fixtures.find((f) => f.id === e.fixture)!, e, row).map((p) => `${e.id}:${p}`),
      );
  }
  return failures;
}

/** A real OS process bounds compilation AND runtime (including synchronous Wasm loops). */
export function boundedProcess(args: string[], timeout = 55000): { output?: unknown; problem?: string } {
  const child = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (child.error && "code" in child.error && child.error.code === "ETIMEDOUT") return { problem: "process-timeout" };
  if (child.status !== 0 || child.error) return { problem: `missing-process-result:${child.error ?? child.stderr}` };
  if (!child.stdout.trim()) return { problem: "missing-process-output" };
  try {
    return { output: JSON.parse(child.stdout) };
  } catch {
    return { problem: "invalid-process-output" };
  }
}
export function observePublicEntry(entry: Entry, timeout = 55000): Evidence {
  const result = boundedProcess(["--import", "tsx", import.meta.filename, "--entry", entry.id], timeout);
  if (result.problem) throw new Error(`${entry.id}:${result.problem}`);
  const row = result.output as Evidence | undefined;
  if (
    !row ||
    row.entry !== entry.id ||
    row.processResult !== "completed" ||
    ![true, false, null].includes(row.success) ||
    !Number.isSafeInteger(row.artifactBytes) ||
    row.artifactBytes < 0 ||
    typeof row.sourceHash !== "string" ||
    !Array.isArray(row.phases) ||
    !Array.isArray(row.runtime) ||
    !Array.isArray(row.errors)
  )
    throw new Error(`${entry.id}:malformed-entry-evidence`);
  // Malformed nested audit/outcome structures are unavailable evidence, never a crash that truncates the corpus.
  const fixture = loadManifest().fixtures.find((f) => f.id === entry.fixture)!;
  try {
    evidenceProblems(fixture, entry, row);
  } catch {
    throw new Error(`${entry.id}:malformed-entry-evidence`);
  }
  return row;
}

/** Every requested entry retains a row even when its process never reports. */
export function collectPublicEntries(
  manifest: Manifest,
  run: (entry: Entry) => Evidence = observePublicEntry,
): Evidence[] {
  return manifest.entries.map((entry) => {
    try {
      return run(entry);
    } catch (error) {
      return {
        processResult: "unavailable",
        entry: entry.id,
        gateHash: GATE_HASH,
        sourceHash: fixtureHash(manifest.fixtures.find((f) => f.id === entry.fixture)!),
        success: null,
        artifactBytes: 0,
        phases: [],
        runtime: [],
        errors: [String(error)],
      };
    }
  });
}

export async function oracleProblems(manifest: Manifest): Promise<string[]> {
  const module = await import(pathToFileURL(join(FIXTURES, "oracle.mjs")).href);
  const failures: string[] = [];
  for (const fixture of manifest.fixtures)
    if ((await execute(module.oracle(fixture.id), fixture.calls)).some((r) => !r.match))
      failures.push(`${fixture.id}:pinned-js-oracle`);
  return failures;
}

async function main(): Promise<void> {
  const manifest = loadManifest();
  if (process.argv.includes("--entry")) {
    const entry = manifest.entries.find((e) => e.id === process.argv[process.argv.indexOf("--entry") + 1]);
    if (!entry) throw new Error("unknown entry");
    console.log(JSON.stringify(await observeEntry(manifest, entry)));
    return;
  }
  const failures = manifestProblems(manifest);
  failures.push(...(await oracleProblems(manifest)));
  const rows = collectPublicEntries(manifest);
  failures.push(...reportProblems(manifest, rows));
  console.log(
    JSON.stringify(
      {
        status: failures.length ? "incomplete" : "validated",
        base: manifest.base,
        spec: manifest.spec,
        head: spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim(),
        gateHash: GATE_HASH,
        corpusHash: corpusHash(manifest),
        expectedEntries: manifest.entries.length,
        accountedEntries: rows.length,
        observedEntries: rows.filter((row) => row.processResult === "completed").length,
        failures,
        rows: rows.map((row) => {
          const entry = manifest.entries.find((e) => e.id === row.entry)!;
          const fixture = manifest.fixtures.find((f) => f.id === entry.fixture)!;
          const expected = inventoryFor(fixture, entry);
          return {
            ...row,
            expectedSources: expected.sources,
            expectedUnits: expected.allUnits,
            expectedRuntimeCalls: fixture.calls.length,
            problems: evidenceProblems(fixture, entry, row),
          };
        }),
      },
      null,
      2,
    ),
  );
  process.exitCode = failures.length ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
