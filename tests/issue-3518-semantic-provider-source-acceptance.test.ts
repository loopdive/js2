// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  ARM_PATHS,
  CANONICAL_ROOTS,
  SCHEMA,
  fixtureMatrix,
  evidenceValue,
  sha256,
  compareArms,
  validateArm,
  childEnvironment,
  produceAdmission,
  postPassSatisfied,
  resolveRecorderDirectory,
} from "./helpers/semantic-provider-source-receipts.mjs";
import {
  allowedCanonicalPath,
  requireNonemptyAdmission,
  validateAdmissionInventory,
  validateGuardProbe,
} from "./helpers/semantic-provider-source-free.mjs";

const root = resolve(import.meta.dirname, "..");
const matrix = fixtureMatrix(root);

type Fixture = {
  id: string;
  files: Record<string, string>;
  native?: boolean;
  calls: { name: string; args: number[]; expected: number; tolerance?: number }[];
};
function calibrationNative(binary: string) {
  return Array.from({ length: 2 }, () =>
    ["suspension", "non-i31", "undefined"].map((action) => {
      const count = action === "undefined" ? 10 : 1;
      return {
        action,
        ...(action === "non-i31"
          ? {
              observerExportPresent: false,
              autoFireReverseAt: 1,
              timerFiringsAtWrapperReturn: 1,
            }
          : { before: 0, after: 1 }),
        value: action === "undefined" ? { $undefined: true } : action === "non-i31" ? 3_000_000_000 : 70,
        events: [
          ...Array.from({ length: count }, (_, i) => ["start", i, 10]),
          ...(action === "undefined" ? [0, 1, 2, 3, 4, 9, 8, 7, 6, 5] : Array.from({ length: count }, (_, i) => i)).map(
            (i) => ["fire", i],
          ),
        ],
        instantiatedBinary: binary,
      };
    }),
  );
}
function calibrationPublic(fixture: Fixture) {
  const binary = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 1, 0]).toString("base64");
  return {
    assessed: Object.keys(fixture.files).length === 1,
    kind: "executed",
    result: {
      success: true,
      irOutcomes: ["fetchUser", "fetchAllSequential", "fetchAllParallel", "main"].map((displayName) => ({
        unitKind: "function",
        displayName,
        kind: "emitted",
        irBodyEmitted: true,
        legacyBodyEmitted: false,
      })),
    },
    binary,
    instantiatedBinary: binary,
    wat: "(module) ;; report calibration only",
    imports: fixture.native ? [{ module: "env", name: "__timer_set_timeout" }] : [],
    exports: [{ name: "calibration", kind: "function" }],
    values: (fixture.native
      ? calibrationNative(binary)
      : fixture.calls.map((call) => ({ call, values: [call.expected, call.expected] }))) as unknown[],
  };
}

// Serialized attachment reports only; these are never supplied to a compiler.
function calibrationPostPass() {
  const owner = "calibration-transformed-owner";
  return {
    assessed: true,
    satisfied: true,
    observations: [
      {
        owner,
        kind: "authenticated",
        changed: true,
        before: { unitId: owner, asyncPlan: { ownerUnitId: owner } },
        after: { unitId: owner, asyncPlan: { ownerUnitId: owner } },
        beforePlan: {
          ownerUnitId: owner,
          states: [{ body: ["old"] }, { body: [] }],
          runtimeIntents: ["calibration-feature"],
        },
        afterPlan: {
          ownerUnitId: owner,
          states: [{ body: ["changed"] }, { body: [] }],
          runtimeIntents: ["calibration-feature"],
        },
        runtimeSemanticPlans: [
          {
            owner,
            plan: {
              ownerUnitId: owner,
              states: [{ body: ["changed"] }, { body: [] }],
              runtimeIntents: ["calibration-feature"],
            },
          },
        ],
        joins: [
          { owner, plan: true, manifest: true, statesFrozen: true, stateCount: 2, instructionCount: 1, providers: [0] },
        ],
        manifest: { providers: [{ id: "calibration-provider", feature: "calibration-feature" }] },
        runtime: {
          functions: [
            { unitId: owner, asyncPlan: { ownerUnitId: owner }, asyncRuntime: { kind: "standalone-native-wasmgc" } },
          ],
        },
      },
    ],
  };
}

// These synthetic REPORTS calibrate the comparator, not compiler IR or replay.
// Their all-refused outcome may prove equality only, never acceptance.
function calibration() {
  const fixtures = matrix.filter((row: { mode: string }) => row.mode === "off");
  const arm = (name: "baseline" | "candidate") => {
    const selectedRoot = `/calibration/${name}`;
    const snapshot = {
      root: selectedRoot,
      head: "calibration-only",
      diff: "",
      census: [["only.ts", "calibration"]],
      sha256: "calibration",
    };
    const runtime = { calibration: "not a measured compiler runtime" };
    const implementation = [{ path: "calibration", sha256: "calibration" }];
    const launch = { execArgv: ["--import", "tsx"], env: {} };
    const expected = { arm: name, mode: "off", snapshot, runtime, implementation, launch, fixtures };
    const report = {
      schema: SCHEMA,
      provenance: {
        arm: name,
        mode: "off",
        before: snapshot,
        after: snapshot,
        runtime,
        implementation,
        launch,
        fixtureSha256: sha256(JSON.stringify(fixtures)),
        urls: Object.fromEntries(
          Object.entries(ARM_PATHS[name]).map(([key, path]) => [key, pathToFileURL(join(selectedRoot, path)).href]),
        ),
      },
      rows: fixtures.map((fixture: Fixture) => ({
        id: fixture.id,
        fixture,
        preparation: {
          phase: "backend-acceptance",
          kind: "refused",
          refusal: {
            kind: "unsupported",
            code: "body-shape-rejected",
            stage: "build",
            unitId: "source-owned",
            sourceFile: "entry.ts",
            location: { sourceId: "entry", line: 1, column: 1 },
            detail: "calibration refusal",
          },
        },
        public: calibrationPublic(fixture),
        postPass: {
          ...calibrationPostPass(),
          assessed: false,
          satisfied: false,
          observations: [] as ReturnType<typeof calibrationPostPass>["observations"],
        },
      })),
      admissions: [],
    };
    const terminal = {
      root: selectedRoot,
      arm: name,
      mode: "off",
      code: 0,
      signal: null,
      error: null,
      reportSha256: sha256(JSON.stringify(report)),
    };
    return { report, expected, terminal };
  };
  return { baseline: arm("baseline"), candidate: arm("candidate") };
}
function compare(pair: ReturnType<typeof calibration>) {
  return compareArms(
    pair.baseline.report,
    pair.candidate.report,
    pair.baseline.expected,
    pair.candidate.expected,
    pair.baseline.terminal,
    pair.candidate.terminal,
  );
}
function rebind(pair: ReturnType<typeof calibration>) {
  pair.candidate.terminal.reportSha256 = sha256(JSON.stringify(pair.candidate.report));
}

describe("source/provider receipt instrument (not acceptance by equal refusal)", () => {
  it("pins 30 rows: GVN off/on and both orders for alias, var startup, and lexical TDZ", () => {
    expect(matrix).toHaveLength(30);
    expect(new Set(matrix.map((row: { id: string }) => row.id)).size).toBe(30);
    for (const mode of ["off", "on"]) {
      const rows = matrix.filter((row: { mode: string }) => row.mode === mode);
      expect(rows).toHaveLength(15);
      for (const prefix of ["alias", "startup", "tdz"]) {
        expect(
          rows
            .filter((row: { id: string }) => row.id.startsWith(prefix))
            .map((row: { reverse: boolean }) => row.reverse),
        ).toEqual([false, true]);
      }
    }
    for (const row of matrix)
      expect(Object.values(row.files).every((source) => typeof source === "string" && source.length > 0)).toBe(true);
  });
  it("retains actual native family, boolean refusal and provider-only trig obligations", () => {
    const native = matrix.find((row: { id: string }) => row.id === "native-async:gvn-off")!;
    expect(native.files["./entry.ts"]).toContain("new Promise<number>");
    expect(native.files["./entry.ts"]).toContain("export async function fetchUser");
    expect(native.files["./entry.ts"]).toContain("export async function main(): Promise<void>");
    expect(matrix.find((row: { id: string }) => row.id === "math-trig:gvn-off")!.requiredFeatures).toEqual([
      "math.sin",
      "math.reduce-trig",
    ]);
    expect(
      matrix.find((row: { id: string }) => row.id === "boolean-standalone-refusal:gvn-off")!.policy.booleanBoundary,
    ).toEqual({ box: "unsupported" });
  });
  it("calibrates equal nonempty refusal receipts without accepting them", () => {
    const result = compare(calibration());
    expect(result.pairs).toBe(15);
    expect(result.preservationOK).toBe(true);
    expect(result.acceptanceOK).toBe(false);
    expect(result.pending).toHaveLength(15);
  });
  it("retains undefined, non-finite numbers, -0, owners, locations, causes and sharing", () => {
    const shared = { absent: undefined };
    const value = evidenceValue({
      shared,
      again: shared,
      values: [undefined, NaN, -0, Infinity, 3n],
      failure: new Error("sentinel", { cause: { owner: "real-owner", location: { line: 3 } } }),
    });
    expect(value.again).toHaveProperty("$ref");
    expect(value.values).toEqual([
      { $undefined: true },
      { $number: "NaN" },
      { $number: "-0" },
      { $number: "Infinity" },
      { $bigint: "3" },
    ]);
    expect(value.failure.cause).toEqual({ owner: "real-owner", location: { line: 3 } });
    expect(value.failure.stack).toContain("sentinel");
  });
  it("does not invoke accessor diagnostics or silently erase callable evidence", () => {
    let gets = 0;
    expect(() =>
      evidenceValue({
        get detail() {
          gets++;
          return "hidden";
        },
      }),
    ).toThrow(/accessor/);
    expect(gets).toBe(0);
    expect(() => evidenceValue({ callback() {} })).toThrow(/function/);
  });
  it("retains the complete native lazy Error stack and cause without replacing the stack", () => {
    const cause = new TypeError("native-cause");
    const failure = new Error("native-stack-sentinel", { cause });
    const before = Object.getOwnPropertyDescriptor(failure, "stack")!;
    const receipt = evidenceValue(failure);
    expect(receipt.name).toBe("Error");
    expect(receipt.message).toBe("native-stack-sentinel");
    expect(receipt.stack).toBe(failure.stack);
    expect(receipt.stack).toContain("native-stack-sentinel");
    expect(receipt.stack).toContain("issue-3518-semantic-provider-source-acceptance.test.ts");
    expect(receipt.cause.name).toBe("TypeError");
    expect(receipt.cause.message).toBe("native-cause");
    expect(receipt.cause.stack).toBe(cause.stack);
    const after = Object.getOwnPropertyDescriptor(failure, "stack")!;
    if (before.get) expect(after.get).toBe(before.get);
  });
  it.each(["stack", "cause", "detail", "name", "message", "inherited-name", "inherited-message"])(
    "rejects custom Error %s accessors without invoking them",
    (key) => {
      let gets = 0;
      const failure = new Error("custom-accessor-control");
      const inherited = key.startsWith("inherited-");
      const field = inherited ? key.slice("inherited-".length) : key;
      if (inherited) Reflect.deleteProperty(failure, field);
      const owner = inherited ? Object.create(Error.prototype) : failure;
      Object.defineProperty(owner, field, {
        configurable: true,
        get() {
          gets++;
          return "must-not-run";
        },
      });
      if (inherited) Object.setPrototypeOf(failure, owner);
      // Avoid toThrow's own stack formatting of the rejected input.
      let caught: unknown;
      try {
        evidenceValue(failure);
      } catch (error) {
        caught = error;
      }
      expect(gets).toBe(0);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("accessor");
    },
  );
  it("does not authenticate an ordinary object's copied native stack accessor", () => {
    let gets = 0;
    const descriptor = Object.getOwnPropertyDescriptor(new Error(), "stack")!;
    const counterfeit = Object.create(Error.prototype);
    Object.defineProperty(
      counterfeit,
      "stack",
      descriptor.get
        ? descriptor
        : {
            get() {
              gets++;
              return "counterfeit";
            },
          },
    );
    expect(() => evidenceValue(counterfeit)).toThrow(/accessor/);
    expect(gets).toBe(0);
  });
  it.each([
    "missing-row",
    "duplicate-row",
    "root",
    "arm",
    "mode",
    "census",
    "loader",
    "config",
    "implementation",
    "launch",
    "url",
    "fixture",
  ])("rejects %s provenance/denominator countermodel", (change) => {
    const pair = calibration();
    const report = structuredClone(pair.candidate.report);
    // Deliberately operate on serialized data, with a freshly bound terminal:
    // rejection must come from independent expectations, not a stale hash alone.
    if (change === "missing-row") report.rows.pop();
    if (change === "duplicate-row") report.rows[1] = report.rows[0]!;
    if (change === "root") report.provenance.before.root = pair.baseline.expected.snapshot.root;
    if (change === "arm") report.provenance.arm = "baseline";
    if (change === "mode") report.provenance.mode = "on";
    if (change === "census") report.provenance.before.sha256 = "stale";
    if (change === "loader" || change === "config") report.provenance.runtime.calibration = change;
    if (change === "implementation") report.provenance.implementation[0]!.sha256 = "stale";
    if (change === "launch") report.provenance.launch.execArgv.push("--require", "foreign.cjs");
    if (change === "url") report.provenance.urls.bootstrap = "file:///foreign/src/index.ts";
    if (change === "fixture") report.provenance.fixtureSha256 = "stale";
    const terminal = { ...pair.candidate.terminal, reportSha256: sha256(JSON.stringify(report)) };
    expect(() => validateArm(report, pair.candidate.expected, terminal)).toThrow();
  });
  it.each(["missing", "nonzero", "signal", "error", "stale-hash"])("rejects %s terminal receipt", (change) => {
    const { candidate } = calibration();
    const terminal = {
      ...candidate.terminal,
      code: change === "nonzero" ? 1 : 0,
      signal: change === "signal" ? "SIGTERM" : null,
      error: change === "error" ? { message: "spawn failure" } : null,
      reportSha256: change === "stale-hash" ? "stale" : candidate.terminal.reportSha256,
    };
    expect(() =>
      validateArm(candidate.report, candidate.expected, change === "missing" ? undefined : terminal),
    ).toThrow();
  });
  it("rejects baseline-as-candidate rather than discovering a fallback module", () => {
    const pair = calibration();
    expect(() =>
      compareArms(
        pair.baseline.report,
        pair.baseline.report,
        pair.baseline.expected,
        pair.baseline.expected,
        pair.baseline.terminal,
        pair.baseline.terminal,
      ),
    ).toThrow();
    expect(ARM_PATHS.candidate.attachment).toBe("src/ir/runtime/async-attachment.ts");
    expect(ARM_PATHS.baseline.attachment).toBe("src/ir/async-plan.ts");
  });
  it.each(["byte", "value", "owner", "location", "valid-outcome", "checkout-stack"])(
    "retains raw %s inequality and refuses acceptance",
    (change) => {
      const pair = calibration();
      const row = pair.candidate.report.rows[0]!;
      if (change === "byte") {
        row.public.binary = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 2, 1, 120]).toString("base64");
        row.public.instantiatedBinary = row.public.binary;
      }
      if (change === "value")
        row.public.values = row.fixture.calls.map((call, index) => ({
          call,
          // A different finite result still inside the existing trig tolerance
          // is valid in isolation, but must not disappear from raw comparison.
          values: [call.expected + (index === 0 ? call.tolerance! / 2 : 0), call.expected],
        }));
      if (change === "owner") row.preparation.refusal.unitId = "foreign-owner";
      if (change === "location") row.preparation.refusal.location.line = 2;
      if (change === "valid-outcome") row.preparation.refusal.detail = "a different valid refusal";
      if (change === "checkout-stack") row.preparation.refusal.detail = "Error\n at /candidate/src/ir/owner.ts:1";
      rebind(pair);
      const result = compare(pair);
      expect(result.preservationOK).toBe(false);
      expect(result.acceptanceOK).toBe(false);
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0].candidate).toEqual(row);
    },
  );
  it.each([
    "binary-mismatch",
    "missing-instantiated",
    "empty-values",
    "wrong-value",
    "missing-action",
    "duplicate-action",
    "native-binary",
    "native-value",
    "missing-events",
    "missing-native-owner",
  ])("rejects identical %s public corruption on both arms", (change) => {
    const pair = calibration();
    for (const arm of [pair.baseline, pair.candidate]) {
      const native = [
        "missing-action",
        "duplicate-action",
        "native-binary",
        "native-value",
        "missing-events",
        "missing-native-owner",
      ].includes(change);
      const row = native ? arm.report.rows.find((row) => row.fixture.native)! : arm.report.rows[0]!;
      const receipt = row.public;
      if (change === "binary-mismatch")
        receipt.binary = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 2, 1, 120]).toString("base64");
      if (change === "missing-instantiated") Reflect.deleteProperty(receipt, "instantiatedBinary");
      if (change === "empty-values") receipt.values = [];
      if (change === "wrong-value") receipt.values = row.fixture.calls.map((call) => ({ call, values: [99, 99] }));
      if (native) {
        const runs = calibrationNative(receipt.binary);
        if (change === "missing-action") runs[0]!.pop();
        if (change === "duplicate-action") runs[0]![1] = structuredClone(runs[0]![0]!);
        if (change === "native-binary") runs[0]![0]!.instantiatedBinary = "foreign";
        if (change === "native-value") runs[0]![1]!.value = 70;
        if (change === "missing-events") runs[0]![0]!.events = [];
        if (change === "missing-native-owner") receipt.result.irOutcomes.pop();
        receipt.values = runs;
      }
      arm.terminal.reportSha256 = sha256(JSON.stringify(arm.report));
      expect(() => validateArm(arm.report, arm.expected, arm.terminal)).toThrow();
    }
    expect(() => compare(pair)).toThrow();
  });
  it("requires a changed owner with real joins, not a changed flag alone", () => {
    const pair = calibration();
    for (const arm of [pair.baseline, pair.candidate]) {
      arm.report.rows.find((row) => row.id.startsWith("native-async-post-pass"))!.postPass = calibrationPostPass();
      arm.terminal.reportSha256 = sha256(JSON.stringify(arm.report));
      expect(validateArm(arm.report, arm.expected, arm.terminal)).toBe(true);
    }
    expect(compare(pair).acceptanceOK).toBe(false); // Prepared refusals still cannot be promoted.
    const receipt = calibrationPostPass();
    expect(postPassSatisfied(receipt)).toBe(true);
    receipt.observations[0]!.afterPlan.states = structuredClone(receipt.observations[0]!.beforePlan.states);
    receipt.observations[0]!.runtimeSemanticPlans[0]!.plan = structuredClone(receipt.observations[0]!.afterPlan);
    receipt.observations[0]!.changed = false;
    expect(postPassSatisfied(receipt)).toBe(false);
  });
  it.each([
    "removed-owner",
    "removed-runtime-owner",
    "foreign-owner",
    "empty-joins",
    "false-plan",
    "false-manifest",
    "false-frozen",
    "empty-body",
    "negative-index",
    "foreign-index",
    "duplicate-index",
    "false-changed",
    "false-satisfied",
    "same-owner-stale-plan",
  ])("rejects identical %s post-pass claims on both arms", (change) => {
    const pair = calibration();
    for (const arm of [pair.baseline, pair.candidate]) {
      const row = arm.report.rows.find((row) => row.id.startsWith("native-async-post-pass"))!;
      row.postPass = calibrationPostPass();
      const observation = row.postPass.observations[0]!;
      const joined = observation.joins[0]!;
      if (change === "removed-owner") Reflect.deleteProperty(observation, "owner");
      if (change === "removed-runtime-owner") observation.runtime.functions = [];
      if (change === "foreign-owner") joined.owner = "unrelated-owner";
      if (change === "empty-joins") observation.joins = [];
      if (change === "false-plan") joined.plan = false;
      if (change === "false-manifest") joined.manifest = false;
      if (change === "false-frozen") joined.statesFrozen = false;
      if (change === "empty-body") joined.instructionCount = 0;
      if (change === "negative-index") joined.providers = [-1];
      if (change === "foreign-index") joined.providers = [1];
      if (change === "duplicate-index") joined.providers = [0, 0];
      if (change === "false-changed") observation.changed = false;
      if (change === "false-satisfied") row.postPass.satisfied = false;
      if (change === "same-owner-stale-plan")
        observation.runtimeSemanticPlans[0]!.plan = structuredClone(observation.beforePlan);
      arm.terminal.reportSha256 = sha256(JSON.stringify(arm.report));
      expect(() => validateArm(arm.report, arm.expected, arm.terminal)).toThrow();
    }
    expect(() => compare(pair)).toThrow();
  });
  it.each(["valid", "wrong-value", "substituted-call", "one-execution", "binary-mismatch", "empty-binary"])(
    "validates %s prepared executions independently, even when both replays and arms agree",
    (change) => {
      const pair = calibration();
      for (const arm of [pair.baseline, pair.candidate]) {
        const row = arm.report.rows[0]!;
        const emission = {
          kind: "executed",
          artifact: { binary: row.public.binary },
          instantiatedBinary: row.public.binary,
          values: row.fixture.calls.map((call) => ({
            call: structuredClone(call),
            values: [call.expected, call.expected],
          })),
        };
        if (change === "wrong-value") emission.values[0]!.values = [99, 99];
        if (change === "substituted-call") emission.values[0]!.call.name = "not-the-fixture-call";
        if (change === "one-execution") emission.values[0]!.values.pop();
        if (change === "binary-mismatch") emission.instantiatedBinary = "foreign";
        if (change === "empty-binary") emission.artifact.binary = emission.instantiatedBinary = "";
        // Calibration REPORT only; no fake prepared carrier reaches the compiler.
        Object.assign(row.preparation, {
          kind: "prepared",
          canonical: "{}",
          runtime: [{ calibration: true }],
          features: [],
          original: structuredClone(emission),
          replayed: structuredClone(emission),
          replayEqual: true,
        });
        arm.terminal.reportSha256 = sha256(JSON.stringify(arm.report));
        if (change === "valid") expect(validateArm(arm.report, arm.expected, arm.terminal)).toBe(true);
        else expect(() => validateArm(arm.report, arm.expected, arm.terminal)).toThrow();
      }
      if (change === "valid") expect(compare(pair).acceptanceOK).toBe(false);
      else expect(() => compare(pair)).toThrow();
    },
  );
  it("pins child-only five-control and loader configuration without modifying ambient settings", () => {
    const before = { ...process.env };
    const env = childEnvironment(root, "on");
    expect(env.JS2WASM_IR_GVN).toBe("1");
    expect(env.TSX_TSCONFIG_PATH).toBe(join(root, "tsconfig.json"));
    expect(env.TSX_DISABLE_CACHE).toBe("1");
    expect(env).not.toHaveProperty("ESBUILD_BINARY_PATH");
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=2048");
    expect(process.env).toEqual(before);
  });
  it("binds relative report directories before a compiler child changes cwd, excluding baseline writes", () => {
    const baseline = "/calibration/read-only-baseline";
    expect(resolveRecorderDirectory(".tmp/pair-control", baseline)).toBe(resolve(".tmp/pair-control"));
    expect(() => resolveRecorderDirectory(baseline, baseline)).toThrow(/baseline/);
    expect(() => resolveRecorderDirectory(join(baseline, ".tmp/forbidden"), baseline)).toThrow(/baseline/);
  });
  it("rejects the old pending non-i31 recipe even when both arms report it identically", () => {
    const pair = calibration();
    for (const arm of [pair.baseline, pair.candidate]) {
      const row = arm.report.rows.find((row) => row.fixture.native)!;
      const runs = calibrationNative(row.public.binary);
      for (const run of runs) Object.assign(run[1]!, { before: 0, after: 1, timerFiringsAtWrapperReturn: 0 });
      row.public.values = runs;
      arm.terminal.reportSha256 = sha256(JSON.stringify(arm.report));
      expect(() => validateArm(arm.report, arm.expected, arm.terminal)).toThrow();
    }
    expect(() => compare(pair)).toThrow();
  });
  it.each(["fulfilled", "rejected", "unsettled"])(
    "records %s promises explicitly in an isolated child without ambient timer polling",
    async (mode) => {
      const helper = pathToFileURL(join(root, "tests/helpers/semantic-provider-source-receipts.mjs")).href;
      const script = `
        import { awaitRecorderPromise, evidenceValue } from ${JSON.stringify(helper)};
        const mode = ${JSON.stringify(mode)};
        const before = process.listenerCount("beforeExit");
        const events = [], rows = [];
        const sentinel = new Error("explicit-rejection");
        const promise = mode === "fulfilled" ? Promise.resolve(42) : mode === "rejected" ? Promise.reject(sentinel) : new Promise(() => {});
        let sameRejection = false;
        try {
          const value = await awaitRecorderPromise(promise, { fixtureId: "instrument-only", phase: mode }, event => events.push(event));
          rows.push({ id: "instrument-only", kind: "fulfilled", value });
        } catch (error) {
          sameRejection = error === sentinel;
          rows.push({ id: "instrument-only", kind: "failed", error: evidenceValue(error) });
        }
        console.log(JSON.stringify({ rows, events, sameRejection, before, after: process.listenerCount("beforeExit") }));
        process.exitCode = rows[0].kind === "fulfilled" ? 0 : 1;
      `;
      const terminal = await new Promise<{
        code: number | null;
        signal: string | null;
        error: unknown;
        stdout: string;
        stderr: string;
      }>((done) => {
        const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
          cwd: root,
          env: childEnvironment(root, "off"),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "",
          error: unknown = null;
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", (value) => {
          error = evidenceValue(value);
        });
        child.on("close", (code, signal) => done({ code, signal, error, stdout, stderr }));
      });
      expect(terminal.error).toBeNull();
      expect(terminal.signal).toBeNull();
      expect(terminal.code, terminal.stderr).toBe(mode === "fulfilled" ? 0 : 1);
      expect(terminal.stderr).toBe("");
      const report = JSON.parse(terminal.stdout);
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0].id).toBe("instrument-only");
      expect(report.after).toBe(report.before);
      expect(report.events.map((event: { kind: string }) => event.kind)).toEqual([
        "await-start",
        mode === "fulfilled" ? "await-completed" : "await-failed",
      ]);
      if (mode === "fulfilled") expect(report.rows[0].value).toBe(42);
      if (mode === "rejected") expect(report.sameRejection).toBe(true);
      if (mode === "unsettled") {
        expect(report.rows[0].error.code).toBe("ERR_RECORDER_UNSETTLED_AWAIT");
        expect(report.rows[0].error.context).toEqual({ fixtureId: "instrument-only", phase: "unsettled" });
      }
    },
  );
});

describe("new canonical-owner admission is distinct from full preparation closure", () => {
  it.each([
    "valid",
    "sentinel-only",
    "stripped-query",
    "allowed-query",
    "missing-terminal",
    "signalled",
    "foreign-guard",
  ])("requires exact guard rejection rather than exit 1: %s", (change) => {
    const probe = "src/ir/core/intrinsics.ts?duplicate=1";
    const url = pathToFileURL(join(root, "src/ir/core/intrinsics.ts")).href + "?duplicate=1";
    const guardSha256 = "a".repeat(64);
    // Instrument calibration only, never a compiler closure receipt.
    const report = {
      root,
      ok: false,
      guardSha256,
      probe: {
        url,
        mode: "plain-node",
        guardSha256,
        terminal: {
          code: 1,
          signal: null as string | null,
          error: null,
          stdout: "",
          stderr: `Error: forbidden canonical load: ${url}\n`,
          guardSha256,
        },
      },
      loads: [{ url, path: "src/ir/core/intrinsics.ts", phase: "requested", allowed: false }],
    };
    if (change === "sentinel-only") {
      report.loads = [];
      report.probe.terminal.stderr = "Error: forbidden import probe unexpectedly loaded\n";
    }
    if (change === "stripped-query") report.loads[0]!.url = url.split("?")[0]!;
    if (change === "allowed-query") report.loads[0]!.allowed = true;
    if (change === "missing-terminal") Reflect.deleteProperty(report.probe, "terminal");
    if (change === "signalled") report.probe.terminal.signal = "SIGTERM";
    if (change === "foreign-guard") report.probe.terminal.guardSha256 = "b".repeat(64);
    if (change === "valid") expect(validateGuardProbe(report, { root, probe })).toBe(true);
    else expect(() => validateGuardProbe(report, { root, probe })).toThrow();
  });
  it("fixes all twelve mandatory roots and rejects mixed/query/foreign roots", () => {
    expect(CANONICAL_ROOTS).toHaveLength(12);
    expect(new Set(CANONICAL_ROOTS).size).toBe(12);
    for (const path of CANONICAL_ROOTS) expect(allowedCanonicalPath(path)).toBe(true);
    for (const path of [
      "src/ir/async-plan.ts",
      "src/ir/program-prepare-ir.ts",
      "src/checker/index.ts",
      "src/codegen/index.ts",
      "src/ir/core/intrinsics.ts?foreign=1",
      "../foreign/src/ir/core/nodes.ts",
    ])
      expect(allowedCanonicalPath(path)).toBe(false);
  });
  it.each([
    {},
    { kind: "refused" },
    { kind: "produced", source: "", sourceSha256: "stale", wire: "", wireSha256: "stale" },
  ])("requires independent producer provenance even for admission payload %#", (payload) => {
    expect(() => requireNonemptyAdmission(payload)).toThrow();
  });
  it("produces a real source plan and admits nonempty canonical owners in fresh children", async () => {
    mkdirSync(join(root, ".tmp"), { recursive: true });
    const directory = mkdtempSync(join(root, ".tmp/semantic-provider-admission-"));
    let captured: unknown;
    let captures = 0;
    const payload = await produceAdmission({
      root,
      arm: "candidate",
      captureReceipt(receipt: unknown) {
        captures++;
        captured = structuredClone(receipt);
      },
    });
    const input = join(directory, "source-payload.json");
    writeFileSync(input, JSON.stringify(payload, null, 2));
    // Located source refusals are retained above; this positive control must fail,
    // never skip or switch to synthetic IR when the producer cannot supply it.
    expect(payload.kind, JSON.stringify(payload)).toBe("produced");
    expect(captures).toBe(1);
    const producer = join(directory, "producer.json");
    const producerSha256 = sha256(JSON.stringify(captured));
    writeFileSync(producer, JSON.stringify(captured, null, 2));
    const expected = { root, producerReceipt: captured, producerSha256 };
    expect(() => requireNonemptyAdmission(payload, expected)).not.toThrow();
    for (const invalid of [{}, { kind: "refused" }, { ...payload, source: "", sourceSha256: "stale" }])
      expect(() => requireNonemptyAdmission(invalid, expected)).toThrow();
    expect(() => requireNonemptyAdmission(payload, { ...expected, producerSha256: "stale" })).toThrow();
    expect(() =>
      requireNonemptyAdmission(payload, {
        ...expected,
        producerReceipt: Object.assign({}, captured, { source: "unrelated" }),
      }),
    ).toThrow();
    // Countermodels mutate only transport/evidence; the independent producer
    // receipt remains unchanged. No fabricated IR is submitted to a compiler.
    const foreignSource = structuredClone(payload);
    foreignSource.source = "export function unrelated(): number { return 7; }";
    foreignSource.sourceSha256 = sha256(foreignSource.source);
    expect(() => requireNonemptyAdmission(foreignSource, expected)).toThrow();
    expect(() => requireNonemptyAdmission({ ...payload, inventory: {} }, expected)).toThrow();
    expect(() => requireNonemptyAdmission(payload, { ...expected, root: "/foreign-root" })).toThrow();
    const transport = await import(pathToFileURL(join(root, "tests/helpers/typed-program-transport.mjs")).href);
    const decoded = transport.decodeTypedPacket(payload.wire);
    expect(validateAdmissionInventory(decoded, captured)).toBe(true);
    for (const key of ["terminalUnits", "allUnits"]) {
      const missingOwner = {
        ...decoded,
        inventory: {
          ...decoded.inventory,
          [key]: decoded.inventory[key].filter((unit: { id: string }) => unit.id !== payload.owner),
        },
      };
      expect(() => validateAdmissionInventory(missingOwner, captured)).toThrow();
      const duplicateOwner = {
        ...decoded,
        inventory: {
          ...decoded.inventory,
          [key]: [
            ...decoded.inventory[key],
            decoded.inventory[key].find((unit: { id: string }) => unit.id === payload.owner),
          ],
        },
      };
      expect(() => validateAdmissionInventory(duplicateOwner, captured)).toThrow();
    }
    const foreignOwner = { ...decoded, fn: { ...decoded.fn, unitId: "foreign-owner" } };
    expect(() => validateAdmissionInventory(foreignOwner, captured)).toThrow();
    for (const [ordinal, probe] of [
      null,
      "src/ir/async-plan.ts",
      "src/ir/async-plan.ts?probe=1",
      "src/ir/async-plan.ts#probe",
      "src/ir/program-prepare-ir.ts",
      "src/ir/core/intrinsics.ts?duplicate=1",
    ].entries()) {
      const output = join(directory, `${ordinal}.json`),
        census = join(directory, `${ordinal}.jsonl`);
      const args = [
        "--import",
        "tsx",
        join(root, "tests/helpers/semantic-provider-source-free.mjs"),
        root,
        input,
        producer,
        producerSha256,
        output,
        census,
        ...(probe === null ? [] : [probe]),
      ];
      const terminal = await new Promise<{
        code: number | null;
        signal: string | null;
        error: unknown;
        stderr: string;
      }>((done) => {
        const child = spawn(process.execPath, args, {
          cwd: root,
          env: childEnvironment(root, "off"),
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "",
          error: unknown = null;
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", (value) => {
          error = evidenceValue(value);
        });
        child.on("close", (code, signal) => done({ code, signal, error, stderr }));
      });
      writeFileSync(join(directory, `${ordinal}.terminal.json`), JSON.stringify(terminal, null, 2));
      expect(terminal.error).toBeNull();
      expect(terminal.signal).toBeNull();
      expect(terminal.code, terminal.stderr).toBe(probe === null ? 0 : 1);
      const report = JSON.parse(readFileSync(output, "utf8"));
      expect(report.ok).toBe(probe === null);
      if (probe === null) {
        expect(report.population.roots).toBe(12);
        expect(report.population.states).toBeGreaterThan(1);
        expect(report.population.instructions).toBeGreaterThan(0);
        expect(report.population.capabilities).toBeGreaterThan(0);
        expect(report.population.definitions).toBeGreaterThan(0);
        expect(report.joins.sealedIdentity).toBe(true);
        expect(report.loads.every((entry: { allowed: boolean }) => entry.allowed)).toBe(true);
      } else {
        expect(report.probe.rejected).toBe(true);
        expect(validateGuardProbe(report, { root, probe })).toBe(true);
        const path = probe.split(/[?#]/)[0]!;
        const rejectedUrl = pathToFileURL(join(root, path)).href + probe.slice(path.length);
        expect(report.loads).toHaveLength(1);
        expect(report.loads[0]).toMatchObject({ url: rejectedUrl, path, allowed: false, phase: "requested" });
        if (/[?#]/.test(probe)) {
          expect(report.probe.mode).toBe("plain-node");
          expect(report.probe.terminal.code).toBe(1);
          expect(report.probe.terminal.stderr).toContain(`Error: forbidden canonical load: ${rejectedUrl}\n`);
        } else expect(report.error.message).toBe(`forbidden canonical load: ${rejectedUrl}`);
      }
      expect(report.closureCertified).toBe(false);
      expect(report.retirementCertified).toBe(false);
    }
  }, 180_000);
});
