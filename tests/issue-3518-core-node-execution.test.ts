// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CORE_NODE_EXECUTION_PROGRAMS,
  CORE_NODE_EXECUTION_TARGETS,
  coreNodeExecutionLoaderOverrides,
  coreNodeExecutionRuntimeIdentity,
  validateBreakpointInstallations,
  validateBoundFunctionReceipt,
  validateCoreNodeExecution,
  validatePausedObservation,
} from "../scripts/lib/core-node-execution-witness.mjs";

const root = resolve(import.meta.dirname, "..");
const helper = pathToFileURL(resolve(root, "scripts/lib/core-node-execution-witness.mjs")).href;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const loaderOverrides = {
  ESBUILD_BINARY_PATH: null,
  TSX_TSCONFIG_PATH: resolve(root, "tsconfig.json"),
  TSX_DISABLE_CACHE: "1",
};
const limits = {
  cutAssessed: false,
  cutWitnessCount: null,
  cutStatus: "unknown",
  closureCertified: false,
  retirementCertified: false,
};

// These are deliberately small, known fixture callers, NOT compiler witnesses.
// Keep publicEntry a real declared function so its actual paused range, rather
// than its name, authenticates the calibration stack.
const fixtureSource = `class Counter {
  constructor() { this.value = 0; }
  fresh() { return ++this.value; }
  get count() { return this.value; }
  unused() { return -7; }
  get unusedValue() { return -8; }
}
const shadowFresh = function fresh() { return 999; };
function publicEntry(mode, instance) {
  if (mode === "evaluate") return Counter;
  if (mode === "construct") return new Counter();
  if (mode === "method") return instance.fresh();
  if (mode === "getter") return instance.count;
  if (mode === "shadow") return shadowFresh();
  if (mode === "twice") { instance.fresh(); return instance.fresh(); }
  if (mode === "all") { const value = new Counter(); value.fresh(); return value.count; }
  throw new Error("unexpected fixture mode");
}
export { Counter, publicEntry, shadowFresh };
`;
const implicitFixtureSource = fixtureSource.replace("constructor() { this.value = 0; }", "value = 0;");

type Calibration = {
  schema: string;
  compilerWitness: boolean;
  errors: string[];
  bindings: any[];
  publicRoot: any;
  observations: any[];
  targets: { id: string; status: string; exactCallCount: null }[];
};
let evidence: Record<string, Calibration>;
let setupFailures: Record<string, string>;
let runtimeIdentity: any;

beforeAll(() => {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const scratch = mkdtempSync(join(root, ".tmp/core-node-execution-calibration-"));
  const fixture = join(scratch, "fixture.mjs");
  const output = join(scratch, "evidence.json");
  const coverageDirectory = join(scratch, "source-content");
  mkdirSync(coverageDirectory);
  runtimeIdentity = coreNodeExecutionRuntimeIdentity({
    root,
    launch: {
      execArgv: ["--import", "tsx"],
      argv: ["scripts/audit-core-node-execution.mjs"],
      nodeOptions: "--max-old-space-size=2048",
      coverageDirectory,
      loaderOverrides,
    },
  });
  writeFileSync(fixture, fixtureSource);
  const child = `
    import { writeFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    import inspector from "node:inspector";
    import { calibrateBoundFunctionExecution } from ${JSON.stringify(helper)};
    const root = ${JSON.stringify(root)};
    const fixture = ${JSON.stringify(fixture)};
    const sourcePath = ${JSON.stringify(relative(root, fixture))};
    const module = await import(pathToFileURL(fixture).href);
    const instance = new module.Counter(); // Outside every instrumented window.
    function options(mod = module, path = sourcePath) {
      const target = (id, member, fn, memberKind = "method") => ({
        id, name: "Counter", member, memberKind, fn, sourcePath: path,
      });
      return { root, targets: [
        target("construct", "constructor", mod.Counter),
        target("fresh", "fresh", mod.Counter.prototype.fresh),
        target("count", "count", Object.getOwnPropertyDescriptor(mod.Counter.prototype, "count").get, "getter"),
        target("unused", "unused", mod.Counter.prototype.unused),
        target("unusedValue", "unusedValue", Object.getOwnPropertyDescriptor(mod.Counter.prototype, "unusedValue").get, "getter"),
      ], publicRoot: { id: "fixture.public", name: "publicEntry", fn: mod.publicEntry, sourcePath: path } };
    }
    const evidence = {}, failures = {};
    for (const mode of ["evaluate", "construct", "method", "getter", "shadow", "twice", "all"]) {
      evidence[mode] = await calibrateBoundFunctionExecution({ ...options(), invoke: () => module.publicEntry(mode, instance) });
    }
    const implicitPath = fixture.replace("fixture.mjs", "implicit.mjs");
    writeFileSync(implicitPath, ${JSON.stringify(implicitFixtureSource)});
    const implicit = await import(pathToFileURL(implicitPath).href);
    const implicitInstance = new implicit.Counter(); // Before binding any breakpoints.
    for (const mode of ["evaluate", "construct", "method", "getter"]) {
      evidence["implicit-" + mode] = await calibrateBoundFunctionExecution({
        ...options(implicit, sourcePath.replace("fixture.mjs", "implicit.mjs")),
        invoke: () => implicit.publicEntry(mode, implicitInstance),
      });
    }
    evidence.inactive = await calibrateBoundFunctionExecution({
      ...options(), beforeWindow: () => instance.fresh(), invoke: () => module.publicEntry("evaluate", instance),
    });
    evidence.noPublicRoot = await calibrateBoundFunctionExecution({ ...options(), invoke: () => instance.fresh() });
    // Fixture-only transport fault: resume the real VM exactly once, then
    // deliver a delayed callback error. Nothing is patched in production.
    const originalPost = inspector.Session.prototype.post;
    let resumeCalls = 0;
    inspector.Session.prototype.post = function(method, params, callback) {
      if (method !== "Debugger.resume") return originalPost.call(this, method, params, callback);
      resumeCalls++;
      return originalPost.call(this, method, params, (error, result) => setTimeout(() => callback(error ?? new Error("delayed resume calibration failure"), result), 25));
    };
    try {
      evidence.delayedResume = await calibrateBoundFunctionExecution({ ...options(), invoke: () => module.publicEntry("construct") });
      evidence.delayedResume.resumeCalls = resumeCalls;
    } finally { inspector.Session.prototype.post = originalPost; }
    for (const mode of ["missing", "duplicate", "duplicateId", "missingDeclaration", "wrongBinding"]) {
      const request = options();
      if (mode === "missing") request.targets[1].fn = undefined;
      if (mode === "duplicate") request.targets[1].fn = request.targets[0].fn;
      if (mode === "duplicateId") request.targets[1].id = request.targets[0].id;
      if (mode === "missingDeclaration") request.targets[1].name = "Absent";
      if (mode === "wrongBinding") request.targets[1].fn = module.shadowFresh;
      try { evidence[mode] = await calibrateBoundFunctionExecution({ ...request, invoke: () => module.publicEntry("all", instance) }); }
      catch (error) { failures[mode] = error.message; }
    }
    const duplicatePath = fixture.replace("fixture.mjs", "duplicate.mjs");
    writeFileSync(duplicatePath, ${JSON.stringify(fixtureSource)});
    const duplicate = await import(pathToFileURL(duplicatePath).href);
    await import(pathToFileURL(duplicatePath).href + "?duplicate-instance");
    evidence.duplicateSource = await calibrateBoundFunctionExecution({
      ...options(duplicate, sourcePath.replace("fixture.mjs", "duplicate.mjs")), invoke: () => duplicate.publicEntry("construct"),
    });
    const changedPath = fixture.replace("fixture.mjs", "changed.mjs");
    writeFileSync(changedPath, ${JSON.stringify(fixtureSource)});
    const changed = await import(pathToFileURL(changedPath).href);
    evidence.changedSource = await calibrateBoundFunctionExecution({
      ...options(changed, sourcePath.replace("fixture.mjs", "changed.mjs")),
      invoke: () => { const result = changed.publicEntry("construct"); writeFileSync(changedPath, ${JSON.stringify(fixtureSource + "\n// changed after load\n")}); return result; },
    });
    writeFileSync(${JSON.stringify(output)}, JSON.stringify({ evidence, failures }));
  `;
  const childEnv = {
    ...process.env,
    NODE_OPTIONS: "--max-old-space-size=2048",
    NODE_V8_COVERAGE: coverageDirectory,
    TSX_TSCONFIG_PATH: loaderOverrides.TSX_TSCONFIG_PATH,
    TSX_DISABLE_CACHE: loaderOverrides.TSX_DISABLE_CACHE,
  };
  Reflect.deleteProperty(childEnv, "ESBUILD_BINARY_PATH");
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child], {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  ({ evidence, failures: setupFailures } = JSON.parse(readFileSync(output, "utf8")));
}, 60_000);

function observed(mode: string) {
  expect(evidence[mode].errors).toEqual([]);
  return evidence[mode].observations.map((row) => row.target);
}

describe("canonical child loader environment", () => {
  it("records exactly three supported overrides, distinguishing absent from empty", () => {
    expect(coreNodeExecutionLoaderOverrides({})).toEqual({
      ESBUILD_BINARY_PATH: null,
      TSX_TSCONFIG_PATH: null,
      TSX_DISABLE_CACHE: null,
    });
    expect(
      coreNodeExecutionLoaderOverrides({
        TSX_TSCONFIG_PATH: loaderOverrides.TSX_TSCONFIG_PATH,
        TSX_DISABLE_CACHE: "1",
        ESBK: "not-supported-by-installed-loader",
      }),
    ).toEqual(loaderOverrides);
    expect(coreNodeExecutionLoaderOverrides({ ESBUILD_BINARY_PATH: "" }).ESBUILD_BINARY_PATH).toBe("");
    expect(runtimeIdentity.launch.loaderOverrides).toEqual(loaderOverrides);
  });

  it.each([
    ["ESBUILD_BINARY_PATH", "/tmp/alternate-esbuild"],
    ["ESBUILD_BINARY_PATH", ""],
    ["TSX_TSCONFIG_PATH", null],
    ["TSX_TSCONFIG_PATH", "tsconfig.json"],
    ["TSX_TSCONFIG_PATH", "/tmp/alternate-tsconfig.json"],
    ["TSX_DISABLE_CACHE", null],
    ["TSX_DISABLE_CACHE", "0"],
  ])("records and rejects actual %s=%s before importing the production compiler", (key, value) => {
    const env = {
      ...process.env,
      NODE_OPTIONS: "--max-old-space-size=2048",
      TSX_TSCONFIG_PATH: loaderOverrides.TSX_TSCONFIG_PATH,
      TSX_DISABLE_CACHE: loaderOverrides.TSX_DISABLE_CACHE,
    };
    Reflect.deleteProperty(env, "ESBUILD_BINARY_PATH");
    if (value === null) Reflect.deleteProperty(env, key!);
    else Reflect.set(env, key!, value);
    // Do not start tsx with an untrusted binary override. This fixture invokes
    // the production launch guard directly, without loading any TS compiler.
    const child = `
      import { runCoreNodeExecution } from ${JSON.stringify(helper)};
      const report = await runCoreNodeExecution({ root: ${JSON.stringify(root)} });
      console.log(JSON.stringify(report));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
      cwd: root,
      env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.programs).toEqual([]);
    expect(report.errors.join(" ")).toContain(key);
    expect(report.provenance.runtime.launch.loaderOverrides).toEqual({ ...loaderOverrides, [key!]: value });
  });

  it("rejects missing/extra fields and noncanonical independent planned overrides", () => {
    for (const overrides of [
      undefined,
      { ...loaderOverrides, ESBK: "unsupported" },
      { ...loaderOverrides, ESBUILD_BINARY_PATH: undefined },
      { ...loaderOverrides, ESBUILD_BINARY_PATH: "/tmp/alternate-esbuild" },
      { ...loaderOverrides, TSX_TSCONFIG_PATH: "/tmp/alternate-tsconfig.json" },
      { ...loaderOverrides, TSX_DISABLE_CACHE: "0" },
    ]) {
      const launch = { ...runtimeIdentity.launch, loaderOverrides: overrides };
      expect(() => coreNodeExecutionRuntimeIdentity({ root, launch })).toThrow(
        /loader override|ESBUILD_BINARY_PATH|TSX_TSCONFIG_PATH|TSX_DISABLE_CACHE/,
      );
      // Even matching caller/report claims cannot bless a noncanonical launch.
      const runtime = { ...runtimeIdentity, launch };
      const report = {
        schema: "execution-witness-v1",
        ...limits,
        denominator: 12,
        targets: CORE_NODE_EXECUTION_TARGETS,
        provenance: { root, runtime },
      };
      const result = validateCoreNodeExecution(report, {
        expectedRoot: root,
        expectedSourceTreeSha256: sha(fixtureSource),
        expectedRuntimeIdentity: runtime,
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toMatch(
        /loader override|ESBUILD_BINARY_PATH|TSX_TSCONFIG_PATH|TSX_DISABLE_CACHE/,
      );
    }
  });
});

describe("fixed full execution witness contract", () => {
  it("requires all nine free functions and three distinct allocator bindings", () => {
    expect(CORE_NODE_EXECUTION_TARGETS).toEqual([
      "asValueId",
      "asLabelId",
      "asAllocSiteId",
      "asBlockId",
      "forEachNestedBuffer",
      "forEachInstrDeep",
      "mapNestedBuffers",
      "directUses",
      "collectUses",
      "IrValueIdAllocator.constructor",
      "IrValueIdAllocator.fresh",
      "IrValueIdAllocator.count",
    ]);
    expect(new Set(CORE_NODE_EXECUTION_TARGETS).size).toBe(12);
    expect(CORE_NODE_EXECUTION_PROGRAMS.map((row) => row.name)).toEqual([
      "scalar",
      "vector",
      "record",
      "class",
      "closure",
      "loop",
    ]);
    expect(CORE_NODE_EXECUTION_PROGRAMS.map((row) => row.expected)).toEqual([85, 42, 42, 42, 42, 18]);
  });

  it.each([0, 9, 11, 13])("rejects a changed denominator of %i", (denominator) => {
    const result = validateCoreNodeExecution({
      schema: "execution-witness-v1",
      ...limits,
      denominator,
      targets: CORE_NODE_EXECUTION_TARGETS,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/12-target denominator/);
  });

  it.each(
    Object.entries({
      cutAssessed: true,
      cutWitnessCount: 12,
      cutStatus: "passed",
      closureCertified: true,
      retirementCertified: true,
    }),
  )("cannot promote %s, even in a purported full report", (key, value) => {
    const result = validateCoreNodeExecution({
      schema: "execution-witness-v1",
      ...limits,
      [key]: value,
      denominator: 12,
      targets: CORE_NODE_EXECUTION_TARGETS,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject(limits);
    expect(result.errors.join(" ")).toContain(`cannot promote ${key}`);
  });

  it("rejects empty full coverage and calibration rebranding", () => {
    expect(
      validateCoreNodeExecution({
        schema: "execution-witness-v1",
        ...limits,
        denominator: 12,
        targets: CORE_NODE_EXECUTION_TARGETS,
      }).ok,
    ).toBe(false);
    expect(validateCoreNodeExecution(evidence.all).ok).toBe(false);
    expect(
      validateCoreNodeExecution({
        ...evidence.all,
        schema: "execution-witness-v1",
        denominator: 12,
        targets: CORE_NODE_EXECUTION_TARGETS,
        fullWitnessCount: 12,
      }).ok,
    ).toBe(false);
  });
});

describe("actual function-object breakpoint calibration (not compiler evidence)", () => {
  it("evaluating a class is zero observations; constructing it witnesses only the constructor", () => {
    expect(observed("evaluate")).toEqual([]);
    expect(observed("construct")).toEqual(["construct"]);
  });

  it("a method is not a constructor; getter use is its own observation", () => {
    expect(observed("method")).toEqual(["fresh"]);
    expect(observed("getter")).toEqual(["count"]);
    expect(observed("all")).toEqual(["construct", "fresh", "count"]);
  });

  it.each([
    { mode: "evaluate", expected: [] },
    { mode: "construct", expected: ["construct"] },
    { mode: "method", expected: ["fresh"] },
    { mode: "getter", expected: ["count"] },
  ])("implicit constructor with instance field: $mode witnesses only its actual target", ({ mode, expected }) => {
    expect(implicitFixtureSource).not.toContain("constructor()");
    expect(implicitFixtureSource).toContain("value = 0;");
    const calibration = evidence[`implicit-${mode}`];
    expect(observed(`implicit-${mode}`)).toEqual(expected);
    expect(validateBreakpointInstallations(calibration)).toBe(true);
    for (const binding of calibration.bindings) {
      expect(validateBoundFunctionReceipt(binding, sha(implicitFixtureSource))).toBe(true);
    }
    for (const target of calibration.targets) {
      expect(target).toEqual({
        id: target.id,
        status: expected.includes(target.id) ? "observed-first-hit" : "not-observed",
        exactCallCount: null,
      });
    }
  });

  it("never turns unused method/getter absence into zero-inferred coverage", () => {
    expect(observed("all")).not.toContain("unused");
    expect(observed("all")).not.toContain("unusedValue");
    for (const id of ["unused", "unusedValue"]) {
      expect(evidence.all.targets.find((row) => row.id === id)).toEqual({
        id,
        status: "not-observed",
        exactCallCount: null,
      });
    }
  });

  it("does not activate an actual method for a same-name shadow function", () => {
    expect(observed("shadow")).toEqual([]);
  });

  it("removes a breakpoint after its first hit, never claiming an exact count", () => {
    expect(observed("twice")).toEqual(["fresh"]);
    expect(evidence.twice.observations[0]).toMatchObject({ firstHit: true, exactCallCount: null });
  });

  it("rejects calls outside the active window and without the actual public root", () => {
    expect(evidence.inactive.errors.join(" ")).toMatch(/inactive compile window/);
    expect(evidence.noPublicRoot.errors.join(" ")).toMatch(/actual public-root frame/);
  });

  it("awaits a delayed resume callback failure without resuming twice", () => {
    expect(evidence.delayedResume.errors).toEqual(["delayed resume calibration failure"]);
    expect(evidence.delayedResume).toMatchObject({ resumeCalls: 1 });
  });

  it.each([
    ["missing", /missing target/],
    ["duplicate", /duplicate bound function/],
    ["duplicateId", /duplicate target ids/],
  ])("rejects %s target setup", (mode, message) => {
    expect(setupFailures[mode as string]).toMatch(message as RegExp);
  });

  it("rejects missing declarations, same-file foreign bindings, and duplicate/query modules", () => {
    expect(evidence.missingDeclaration.errors.join(" ")).toMatch(/missing\/duplicate class declaration/);
    expect(evidence.wrongBinding.errors.join(" ")).toMatch(/not the named canonical declaration/);
    expect(evidence.duplicateSource.errors.join(" ")).toMatch(/duplicate loaded source instance/);
  });

  it("rejects source changes while the window is open", () => {
    expect(evidence.changedSource.errors.join(" ")).toMatch(/source changed during window/);
  });

  it("records concrete source, generated location, object identity and public stack receipts", () => {
    expect(observed("all")).toHaveLength(3);
    expect(evidence.all).toMatchObject({ schema: "execution-calibration-v1", compilerWitness: false, ...limits });
    for (const binding of evidence.all.bindings) {
      expect(binding.sourceSha256).toBe(sha(fixtureSource));
      expect(binding.objectId).toBeTruthy();
      expect(validateBoundFunctionReceipt(binding, sha(fixtureSource))).toBe(true);
    }
    for (const observation of evidence.all.observations) {
      const binding = evidence.all.bindings.find((row) => row.id === observation.target);
      expect(validatePausedObservation(observation, binding, evidence.all.publicRoot)).toBe(true);
    }
    expect(validateBreakpointInstallations(evidence.all)).toBe(true);
  });
});

describe("serialized receipt tampering controls", () => {
  const binding = () => structuredClone(evidence.all.bindings.find((row) => row.id === "fresh"));

  it("rejects stale and missing independently supplied source hashes", () => {
    expect(() => validateBoundFunctionReceipt(binding(), "0".repeat(64))).toThrow(/source receipt/);
    expect(() => validateBoundFunctionReceipt(binding(), undefined)).toThrow(/source receipt/);
    const stale = binding();
    stale.scriptSha256 = "0".repeat(64);
    expect(() => validateBoundFunctionReceipt(stale, sha(fixtureSource))).toThrow(/generated-script/);
  });

  it("requires independently supplied source, root, launch, runtime and implementation expectations", () => {
    const report = {
      schema: "execution-witness-v1",
      ...limits,
      denominator: 12,
      targets: CORE_NODE_EXECUTION_TARGETS,
      provenance: { root, runtime: runtimeIdentity },
    };
    const expected = {
      expectedRoot: root,
      expectedSourceTreeSha256: sha(fixtureSource),
      expectedRuntimeIdentity: runtimeIdentity,
    };
    // Positive identity control reaches the next (intentionally absent) gate.
    expect(validateCoreNodeExecution(report, expected).errors.join(" ")).toMatch(/canonical\/facade identity/);
    for (const key of Object.keys(expected)) {
      expect(validateCoreNodeExecution(report, { ...expected, [key]: undefined }).errors.join(" ")).toMatch(
        /independent/,
      );
    }
    for (const key of [
      "node",
      "versions",
      "executable",
      "loader",
      "parser",
      "implementation",
      "configuration",
      "launch",
    ]) {
      const stale = structuredClone(report);
      delete stale.provenance.runtime[key];
      expect(validateCoreNodeExecution(stale, expected).errors.join(" ")).toMatch(
        /runtime\/launch\/implementation identity/,
      );
    }
    const stale = structuredClone(report);
    stale.provenance.runtime.loader.tsx.sha256 = "0".repeat(64);
    expect(validateCoreNodeExecution(stale, expected).ok).toBe(false);
    const changedLaunch = structuredClone(report);
    changedLaunch.provenance.runtime.launch.coverageDirectory += "-foreign";
    expect(validateCoreNodeExecution(changedLaunch, expected).ok).toBe(false);
  });

  it("requires each acknowledged installation and exact actual hitBreakpoints attribution", () => {
    const missing = structuredClone(evidence.all);
    expect(Reflect.deleteProperty(missing, "installations")).toBe(true);
    expect(Object.hasOwn(missing, "installations")).toBe(false);
    expect(() => validateBreakpointInstallations(missing)).toThrow(/acknowledgements/);
    const duplicate: any = structuredClone(evidence.all);
    duplicate.installations[1] = duplicate.installations[0];
    expect(() => validateBreakpointInstallations(duplicate)).toThrow(/foreign\/duplicate/);
    const actual = evidence.all.observations.find((row) => row.target === "fresh");
    for (const hitBreakpoints of [[], ["foreign"], [actual.breakpointId, actual.breakpointId]]) {
      expect(() =>
        validatePausedObservation({ ...actual, hitBreakpoints }, binding(), evidence.all.publicRoot),
      ).toThrow(/breakpoint attribution/);
    }
  });

  it("rejects absent function text and duplicated exact generated text", () => {
    const absent = binding();
    absent.functionSource = "function absent() {}";
    absent.functionSha256 = sha(absent.functionSource);
    expect(() => validateBoundFunctionReceipt(absent, sha(fixtureSource))).toThrow(/missing\/duplicated/);
    const duplicate = binding();
    duplicate.scriptSource += duplicate.functionSource;
    duplicate.scriptSha256 = sha(duplicate.scriptSource);
    // Give this malformed generated script an independently pinned source hash
    // too, so the positive hash controls do not hide the duplicate-range check.
    duplicate.mapping = {
      kind: "inline-source-map",
      sources: duplicate.mapping.sources,
      sourceSha256: sha(fixtureSource),
    };
    const map = JSON.stringify({
      version: 3,
      sources: duplicate.mapping.sources,
      sourcesContent: [fixtureSource],
      names: [],
      mappings: "",
    });
    duplicate.mapping.url = "data:application/json;base64," + Buffer.from(map).toString("base64");
    duplicate.mapping.sha256 = sha(map);
    expect(() => validateBoundFunctionReceipt(duplicate, sha(fixtureSource))).toThrow(/missing\/duplicated/);
  });

  it("rejects missing/foreign source origins, declaration receipts and target ranges", () => {
    const foreign = binding();
    foreign.mapping.sources = [];
    expect(() => validateBoundFunctionReceipt(foreign, sha(fixtureSource))).toThrow(/source origin/);
    const declaration = binding();
    declaration.sourceDeclaration.sha256 = "0".repeat(64);
    expect(() => validateBoundFunctionReceipt(declaration, sha(fixtureSource))).toThrow(/source declaration/);
    const moved = binding();
    moved.location.columnNumber = 0;
    moved.location.lineNumber = 0;
    expect(() => validateBoundFunctionReceipt(moved, sha(fixtureSource))).toThrow(/outside its generated range/);
  });

  it("a matching frame name cannot replace target or public function identity", () => {
    const actual = evidence.all.observations.find((row) => row.target === "fresh");
    const renamed = structuredClone(actual);
    renamed.frames[0].functionName = "deliberately irrelevant label";
    expect(validatePausedObservation(renamed, binding(), evidence.all.publicRoot)).toBe(true);
    const foreign = structuredClone(actual);
    foreign.frames[0].functionLocation.columnNumber += 1;
    expect(() => validatePausedObservation(foreign, binding(), evidence.all.publicRoot)).toThrow(/target frame/);
    const noRoot = structuredClone(actual);
    noRoot.frames = noRoot.frames.slice(0, 1);
    expect(() => validatePausedObservation(noRoot, binding(), evidence.all.publicRoot)).toThrow(/public-root frame/);
    const inactive = structuredClone(actual);
    inactive.active = false;
    expect(() => validatePausedObservation(inactive, binding(), evidence.all.publicRoot)).toThrow(/inactive/);
  });
});
