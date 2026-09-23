// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// LOCAL six-trial diagnostic. Importing never installs or runs a fixture.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  sha,
  TARGET,
  HEADS,
  ORIGINALS,
  RUNTIME_PATH,
  instrumentSources,
  validateObservationArtifacts,
  verifyObservationTrace,
} from "./issue-5807-observation-trace.mjs";
import {
  SEED,
  CORPUS,
  PROVIDER_SHA,
  PROVIDER_KEY,
  assertLocalAdmission,
  treeSnapshot,
  requestPlan,
  runControlledSequence,
  traceInventory,
  selectTrialTraces,
  readControlledTraces,
} from "./issue-5807-controlled-history.mjs";
export const ARMS = Object.freeze(["original", "sham", "reset"]);
export const RECEIPT_PATH = "replay5807-intervention-admission.json";
export const MODE_ENV = "REPLAY_REGISTRY_INTERVENTION_MODE";
export const OVERLAY_PATHS = Object.freeze(["scripts/test262-worker.mjs", "src/runtime.ts"]);
export const EXPECTED_ERROR =
  "cannot marshal opaque compiled value to host BigInt64Array constructor (Testing with BigInt64Array and makeArray.)";
const SELF = fileURLToPath(import.meta.url);
const OBSERVER = fileURLToPath(new URL("./issue-5807-observation-trace.mjs", import.meta.url));
const CONTROLLED = fileURLToPath(new URL("./issue-5807-controlled-history.mjs", import.meta.url));
const INPUTS = [
  "src",
  "tests",
  "scripts",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  ".github",
];
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const git = (root, ...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trimEnd();
const inside = (root, path) => path === root || path.startsWith(root + sep);
const names = (text) => text.split("\0").filter(Boolean).sort();
const controls = () => [SELF, OBSERVER, CONTROLLED].map((path) => ({ path, sha256: sha(readFileSync(path)) }));
export function assertArm(arm) {
  assert.ok(ARMS.includes(arm), "unknown intervention arm");
}
export function assertInterventionEnvironment(arm, env) {
  assertArm(arm);
  assert.equal(env[MODE_ENV], arm, "installed arm/environment mode mismatch");
}
function once(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, "unexpected intervention anchor count");
  return source.replace(before, () => after);
}
export function interventionOverlay(arm, observed) {
  assertArm(arm);
  const result = { ...observed };
  if (arm === "original") return result;
  const runtime = "src/runtime.ts",
    worker = "scripts/test262-worker.mjs";
  // Sham/reset source is IDENTICAL; only the explicitly admitted environment
  // mode differs. Original remains exactly the published observer output.
  result[runtime] = once(
    result[runtime],
    "export function resetLinkedProjectRegistry(): void {",
    "export function __issue5807ResetDecoderRegistry(): void {\n  _crossModuleStructs.reset();\n}\n\n" +
      "export function resetLinkedProjectRegistry(): void {",
  );
  result[worker] =
    "const __5807interventionMode = process.env.REPLAY_REGISTRY_INTERVENTION_MODE;\n" +
    'if (__5807interventionMode !== "sham" && __5807interventionMode !== "reset") throw new Error("invalid registry intervention environment");\n' +
    result[worker];
  const seam = `    const __5807label = msg.__observation5807?.path;
    if (__5807label === ${JSON.stringify(TARGET)} || __5807label === ${JSON.stringify(TARGET + " [strict rerun]")}) {
      const __5807linked = (result.linkedModules ?? []).length;
      if (__5807linked !== 0 || msg.temporal === true || !originalHarness || msg.target !== "gc" || target !== undefined) {
        throw new Error("invalid decoder-only intervention target/linkage");
      }
      observation.emit("intervention-before", { arm: __5807interventionMode, linkedModules: __5807linked });
      if (__5807interventionMode === "reset") runtimeBundle.__issue5807ResetDecoderRegistry();
      observation.emit("intervention-after", { arm: __5807interventionMode, linkedModules: __5807linked });
    }
`;
  result[worker] = once(
    result[worker],
    "    const importObj = buildImports(",
    seam + "    const importObj = buildImports(",
  );
  return result;
}
export function interventionSources(head, originals, arm) {
  assertArm(arm);
  return interventionOverlay(arm, instrumentSources(head, originals));
}
function assertScope(root, modified, untracked) {
  assert.deepEqual(
    names(git(root, "diff", "--name-only", "-z", "HEAD", "--", ...INPUTS)),
    modified,
    "unexpected tracked input mutation",
  );
  assert.deepEqual(
    names(git(root, "ls-files", "--others", "--exclude-standard", "-z", "--", ...INPUTS)),
    untracked,
    "unexpected untracked input mutation",
  );
}
function prepared(root, arm) {
  assertArm(arm);
  root = realpathSync(resolve(root));
  assert.ok(root.startsWith("/private/tmp/"), "requires disposable local scratch subject");
  assert.equal(realpathSync(git(root, "rev-parse", "--show-toplevel")), root, "not exact subject repository root");
  const head = git(root, "rev-parse", "HEAD");
  assert.ok(HEADS.includes(head), "unknown historical HEAD");
  const originals = Object.fromEntries(
    Object.keys(ORIGINALS).map((path) => [
      path,
      execFileSync("git", ["show", head + ":" + path], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }),
    ]),
  );
  const observed = instrumentSources(head, originals),
    outputs = interventionOverlay(arm, observed);
  const observedFiles = Object.keys(observed)
    .sort()
    .map((path) => ({ path, preSha256: ORIGINALS[path] ?? null, postSha256: sha(observed[path]) }));
  const observerReceipt = {
    schema: "issue-5807-observation-install-v1",
    head,
    installerSha256: sha(readFileSync(OBSERVER)),
    modifiedPaths: Object.keys(ORIGINALS).sort(),
    untrackedPaths: [RUNTIME_PATH],
    files: observedFiles,
    patchSha256: sha(JSON.stringify(observedFiles)),
    traceDirectory: "replay5807-traces",
    factoryObservation: "unavailable-without-extra-compiled-reads",
    harnessAndTestCompilerInputChanged: false,
    resetAdded: false,
    comparisonOrGateChanged: false,
    precedingLinkedMeaning: "most recent linked instantiation entry, not proof that instantiation completed",
  };
  const observerReceiptBytes = JSON.stringify(observerReceipt, null, 2) + "\n";
  assert.equal(
    regular(root, "replay5807-trace-admission.json").toString("utf8"),
    observerReceiptBytes,
    "published observer receipt drift",
  );
  const files = Object.keys(outputs)
    .sort()
    .map((path) => ({ path, preSha256: ORIGINALS[path] ?? null, postSha256: sha(outputs[path]) }));
  const receipt = {
    schema: "issue-5807-registry-intervention-install-v1",
    root,
    head,
    arm,
    controls: controls(),
    observerReceiptSha256: sha(observerReceiptBytes),
    overlayPaths: arm === "original" ? [] : [...OVERLAY_PATHS],
    modifiedPaths: Object.keys(ORIGINALS).sort(),
    untrackedPaths: [RUNTIME_PATH],
    files,
    patchSha256: sha(JSON.stringify(files)),
    traceDirectory: "replay5807-traces",
    resetScope: arm === "reset" ? "decoder-registry-only-before-target-buildImports" : "none",
    mirrorResetAdded: false,
    temporalCleanupAdded: false,
    fixtureOrHarnessChanged: false,
    regressionCleared: false,
  };
  return { root, observed, outputs, receipt };
}
export function verifyRegistryIntervention(root = process.cwd()) {
  const receipt = JSON.parse(regular(realpathSync(root), RECEIPT_PATH).toString("utf8"));
  const plan = prepared(root, receipt.arm);
  validateObservationArtifacts(
    plan.receipt,
    receipt,
    Object.fromEntries(Object.keys(plan.outputs).map((path) => [path, regular(plan.root, path).toString("utf8")])),
  );
  assertScope(plan.root, plan.receipt.modifiedPaths, plan.receipt.untrackedPaths);
  return plan.receipt;
}
export function installRegistryIntervention(arm, root = process.cwd()) {
  assert.equal(process.env.REPLAY_OBSERVATION_TRACE, "1", "explicit tracing admission required");
  assertArm(arm);
  verifyObservationTrace(root); // BEFORE overlay: exact published installer admission.
  const plan = prepared(root, arm);
  assert.equal(traceInventory(root).length, 0, "subject already has observation traces");
  for (const path of [RECEIPT_PATH, ...ARMS.map((arm) => "replay5807-intervention-" + arm)]) {
    try {
      lstatSync(join(plan.root, path));
      assert.fail("refuse existing installation artifact: " + path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  save(join(plan.root, RECEIPT_PATH), { status: "INSTALL_INCOMPLETE" });
  for (const path of plan.receipt.overlayPaths) writeFileSync(join(plan.root, path), plan.outputs[path]);
  writeFileSync(join(plan.root, RECEIPT_PATH), JSON.stringify(plan.receipt, null, 2) + "\n");
  return verifyRegistryIntervention(plan.root);
}
function regular(root, path) {
  const full = join(root, path);
  assert.equal(realpathSync(full), full, `aliased source: ${path}`);
  assert.ok(lstatSync(full).isFile(), `nonregular source: ${path}`);
  return readFileSync(full);
}
function inputSnapshot(root) {
  const trace = verifyRegistryIntervention(root);
  const corpus = join(root, "test262");
  assert.equal(realpathSync(corpus), corpus, "corpus must be a disposable real directory");
  assert.equal(realpathSync(git(corpus, "rev-parse", "--show-toplevel")), corpus, "not corpus repository root");
  assert.equal(git(corpus, "rev-parse", "HEAD"), CORPUS, "corpus HEAD");
  assert.equal(git(corpus, "status", "--porcelain", "--untracked-files=all"), "", "corpus drift");
  const fixtures = [SEED, TARGET].map((path) => {
    const bytes = regular(corpus, path);
    const original = execFileSync("git", ["show", `${CORPUS}:${path}`], { cwd: corpus });
    assert.ok(bytes.equals(original), `fixture bytes drift: ${path}`);
    return { path, sha256: sha(bytes) };
  });
  const dependencies = treeSnapshot(join(root, "node_modules"));
  const req = createRequire(join(root, "package.json"));
  const loader = req.resolve("tsx/esm/api");
  for (const path of [loader, req.resolve("typescript")])
    assert.ok(inside(dependencies.root, realpathSync(path)), "dependency resolution escaped census");
  const bundles = ["scripts/compiler-bundle.mjs", "scripts/runtime-bundle.mjs"].map((path) => ({
    path,
    sha256: sha(regular(root, path)),
  }));
  const provider = treeSnapshot(join(root, ".test262-cache/temporal"));
  const wasm = provider.entries.filter((e) => e.path.endsWith(".wasm"));
  assert.equal(wasm.length, 1, "one original provider Wasm required");
  assert.equal(wasm[0].sha256, PROVIDER_SHA, "provider Wasm drift");
  assert.equal(readJSON(join(provider.root, "prewarm.json")).key, PROVIDER_KEY, "provider stamp drift");
  return {
    trace,
    corpus: { head: CORPUS, root: corpus, fixtures, harness: treeSnapshot(join(corpus, "harness")) },
    dependencies,
    loader: { path: loader, sha256: sha(readFileSync(loader)) },
    bundles,
    provider,
    configs: ["package.json", "pnpm-lock.yaml", "tsconfig.json", "vitest.config.ts"].map((path) => ({
      path,
      sha256: sha(regular(root, path)),
    })),
  };
}

export function auditRegistryInterventionTrace(
  streams,
  arm,
  results,
  { partial = false, requireExit = false, workerTerminals = [] } = {},
) {
  assertArm(arm);
  assert.ok(results.length > 0, "silent-empty results");
  assert.ok(results.length <= 4, "too many requests");
  const labels = [],
    roles = ["seed", "target"];
  let cursor = 0;
  for (const role of roles) {
    if (cursor === results.length) {
      assert.ok(partial, "missing required fixture");
      break;
    }
    const path = role === "seed" ? SEED : TARGET;
    for (const variant of ["primary", "strict"]) {
      if (cursor === results.length) {
        assert.ok(partial, "missing conditional strict variant");
        break;
      }
      const r = results[cursor++],
        label = path + (variant === "strict" ? " [strict rerun]" : "");
      assert.equal(r.role, role);
      assert.equal(r.variant, variant);
      assert.equal(r.label, label, "unexpected request label/order");
      assert.ok(r.raw && ["pass", "fail", "compile_error"].includes(r.raw.status), "invalid diagnostic status");
      assert.ok(!r.raw.recycle, "result recycle invalidates history");
      if (role === "seed") assert.equal(r.raw.status, "pass", "seed failed");
      labels.push(label);
      if (r.raw.status !== "pass") break;
    }
  }
  assert.equal(cursor, results.length, "extra results");
  assert.equal(streams.length, 2, "silent-empty/missing or extra worker trace");
  const records = [],
    boots = new Set();
  for (const s of streams) {
    assert.ok(s.length > 0, "empty trace stream");
    assert.equal(s[0].event, "observer-boot", "missing observer boot");
    assert.ok(!boots.has(s[0].boot), "duplicate boot");
    boots.add(s[0].boot);
    for (const [i, r] of s.entries()) {
      assert.equal(r.schema, "issue-5807-observation-v1");
      assert.equal(r.boot, s[0].boot);
      assert.equal(r.pid, s[0].pid);
      assert.equal(r.seq, i + 1, "trace gap");
      assert.equal(r.lost, 0, "trace loss");
      records.push(r);
    }
  }
  const births = records.filter((r) => r.event === "pool-worker"),
    ready = records.filter((r) => r.event === "worker-ready");
  assert.equal(births.length, 1, "worker replacement or extra pool");
  assert.equal(ready.length, 1, "missing/replaced worker");
  const birth = births[0],
    worker = ready[0];
  assert.equal(worker.pid, birth.data.workerPid);
  assert.equal(birth.data.initial, true, "not original worker");
  assert.ok(
    !records.some((r) => ["pool-recycle", "pool-failure", "pool-timeout"].includes(r.event)),
    "worker interruption/recycle invalidates history",
  );
  const dispatch = records.filter((r) => r.event === "dispatch"),
    starts = records.filter((r) => r.event === "request-begin"),
    ends = records.filter((r) => r.event === "request-end");
  assert.deepEqual(
    dispatch.map((r) => r.data.path),
    labels,
    "dispatch population/order mismatch (retry forbidden for valid history)",
  );
  assert.equal(starts.length, labels.length, "missing/extra request begin");
  assert.equal(ends.length, labels.length, "missing/extra request end");
  for (const [index, label] of labels.entries()) {
    const d = dispatch[index],
      start = starts[index],
      end = ends[index];
    assert.equal(d.pid, birth.pid);
    assert.equal(d.data.workerPid, worker.pid, "dispatch worker PID mismatch");
    assert.equal(d.data.generation, birth.data.generation);
    for (const r of [start, end]) {
      assert.equal(r.boot, worker.boot);
      assert.equal(r.pid, worker.pid);
      assert.deepEqual(r.request, { id: d.data.id, generation: d.data.generation, poolPid: d.pid, path: label });
    }
    assert.equal(start.data.metadataAvailable, true);
    assert.ok(end.seq > start.seq, "end precedes begin");
    if (index) assert.ok(start.seq > ends[index - 1].seq, "overlapping requests");
    assert.equal(end.data.status, results[index].raw.status, "raw/trace status mismatch");
    assert.equal(end.data.recycle, false, "trace recycle");
    const own = records.filter((r) => r.boot === worker.boot && r.request?.id === d.data.id);
    for (const event of own) {
      assert.deepEqual(event.request, start.request, "request metadata drift");
      assert.ok(start.seq <= event.seq && event.seq <= end.seq, "request event outside request");
    }
    const linked = own.filter((r) => r.event === "instantiate");
    assert.equal(linked.length, 1, "missing/extra instantiation");
    const seed = results[index].role === "seed";
    assert.equal(start.data.temporalRequested, seed);
    assert.equal(linked[0].data.linkedModules, seed ? 1 : 0, "incorrect actual linkage");
    assert.ok(linked[0].seq > start.seq && linked[0].seq < end.seq, "instantiation outside request");
    if (seed) {
      assert.ok(!own.some((r) => r.event.startsWith("intervention-")), "seed intervention forbidden");
      assert.equal(own.filter((r) => r.event === "registry-reset").length, 1, "seed natural reset floor");
      const registrations = own.filter((r) => r.event === "registry-register");
      assert.equal(registrations.length, 2, "seed registration population");
      assert.equal(new Set(registrations.map((r) => r.data.exports)).size, 2, "seed decoder identities not distinct");
      assert.ok(
        registrations.every((r) => typeof r.data.exports === "string" && r.data.exports.length > 0),
        "missing seed decoder identity",
      );
    }
    if (!seed) {
      const lastSeed = results.findLastIndex((r) => r.role === "seed");
      assert.deepEqual(start.precedingLinked, starts[lastSeed].request, "target lacks exact preceding linked seed");
      const before = own.filter((r) => r.event === "intervention-before"),
        after = own.filter((r) => r.event === "intervention-after");
      assert.equal(before.length, arm === "original" ? 0 : 1, "missing/extra intervention before");
      assert.equal(after.length, arm === "original" ? 0 : 1, "missing/extra intervention after");
      for (const event of [...before, ...after]) {
        assert.deepEqual(event.data, { arm, linkedModules: 0 }, "intervention arm/linkage mismatch");
      }
      if (arm !== "original")
        assert.ok(
          start.seq < before[0].seq && before[0].seq < after[0].seq && after[0].seq < linked[0].seq,
          "intervention ordering",
        );
      const resets = own.filter((r) => r.event === "registry-reset");
      assert.equal(resets.length, arm === "reset" ? 1 : 0, "wrong target reset count");
      if (arm === "reset")
        assert.ok(before[0].seq < resets[0].seq && resets[0].seq < after[0].seq, "reset outside intervention seam");
      const seedIds = records
        .filter(
          (r) =>
            r.boot === worker.boot && r.request?.id === starts[lastSeed].request.id && r.event === "registry-register",
        )
        .map((r) => r.data.exports);
      assert.equal(seedIds.length, 2, "missing preceding seed registrations");
      assert.equal(own.filter((r) => r.event === "registry-register").length, 0, "unexpected target registration");
      const registries = own.filter((r) => r.event === "decoder-registry");
      if (arm === "reset") {
        assert.deepEqual(
          Object.values(resets[0].data.retained),
          results[index].variant === "primary" ? seedIds : [],
          "reset did not retire exact preceding registrations",
        );
        for (const registry of registries) {
          assert.equal(registry.data.enabled, false, "target registry remains enabled after reset");
          assert.deepEqual(registry.data.retained, {}, "target registry retains entries after reset");
        }
        assert.ok(
          own.filter((r) => r.event === "decoder-selected").every((r) => r.data.selected === null),
          "target selected peer after reset",
        );
      } else {
        for (const registry of registries) {
          assert.equal(registry.data.enabled, true, "control registry not enabled");
          assert.deepEqual(
            Object.values(registry.data.retained),
            seedIds,
            "control retained registrations differ from seed",
          );
        }
        assert.ok(
          own.some((r) => r.event === "decoder-selected" && seedIds.includes(r.data.selected)),
          "control did not select retained seed decoder",
        );
      }
      for (const event of own.filter((r) =>
        ["construct-enter", "decoder-registry", "decoder-selected", "construct-mirror"].includes(r.event),
      ))
        assert.ok(event.seq > linked[0].seq && event.seq < end.seq, "constructor observation outside execution");
      assert.ok(
        own.some((r) => r.event === "construct-enter"),
        "missing target constructor observation",
      );
      assert.ok(
        own.some((r) => r.event === "decoder-registry"),
        "missing target registry observation",
      );
      assert.ok(
        own.some((r) => r.event === "decoder-selected"),
        "missing target decoder observation",
      );
      assert.ok(
        own.some((r) => r.event === "construct-mirror"),
        "missing target mirror observation",
      );
      if (end.data.status === "fail")
        assert.ok(
          own.some((r) => r.event === "construct-refusal"),
          "target failure not attributed at constructor",
        );
    }
  }
  for (const event of records.filter((r) => r.event.startsWith("intervention-") || r.event === "registry-reset")) {
    assert.ok(
      ["intervention-before", "intervention-after", "registry-reset"].includes(event.event),
      "unknown intervention event",
    );
    assert.equal(event.boot, worker.boot, "intervention/reset from wrong process");
    assert.ok(
      starts.some((s) => s.request.id === event.request?.id),
      "orphan intervention/reset",
    );
  }
  if (requireExit) {
    assert.equal(workerTerminals.length, 1, "missing/extra worker terminal");
    assert.deepEqual(
      workerTerminals[0],
      { pid: worker.pid, code: null, signal: "SIGTERM" },
      "unexpected original-shutdown worker terminal",
    );
    const controllerStream = streams.find((s) => s[0].boot === birth.boot),
      workerStream = streams.find((s) => s[0].boot === worker.boot);
    assert.notEqual(birth.boot, worker.boot, "worker/controller identity collision");
    assert.equal(controllerStream.at(-1).event, "observer-exit", "missing final controller exit tail");
    assert.equal(controllerStream.filter((r) => r.event === "observer-exit").length, 1, "duplicate controller exit");
    assert.equal(controllerStream.at(-1).data.code, 0, "nonzero controller exit");
    // The original pool terminates its worker with SIGTERM. Node does not emit
    // process 'exit' for that signal. Do not invent an observer-exit record.
    assert.equal(workerStream.at(-1).event, "request-end", "incomplete worker final request tail");
  }
  if (!partial && arm !== "reset") {
    const target = results.filter((r) => r.role === "target");
    assert.equal(target.length, 1, "control did not reproduce primary failure");
    assert.equal(target[0].raw.status, "fail", "control did not reproduce failure");
    assert.equal(target[0].raw.error, EXPECTED_ERROR, "control error differs");
  }
  return {
    status: partial ? "EXACT_COMPLETED_PREFIX" : "COMPLETE_LOCAL_INTERVENTION_DIAGNOSTIC_ONLY",
    arm,
    requests: labels.length,
    workerPid: worker.pid,
    workerBoot: worker.boot,
    generation: birth.data.generation,
    precedingLinked: starts.filter((r) => r.request.path.startsWith(TARGET)).map((r) => r.precedingLinked),
    factoryIdentity: "unavailable-without-extra-compiled-reads",
    tailLimit:
      "worker has original SIGTERM terminal, not a synthetic observer-exit; unwritten tails remain unavailable",
    regressionCleared: false,
  };
}

async function fixtureInputs(root, loader) {
  // Register the SUBJECT's pinned tsx loader, not a control-root compiler/loader.
  const { register } = await import(pathToFileURL(loader));
  register();
  const load = (path) => import(pathToFileURL(join(root, path)));
  const [
    { parseMeta, isModuleGoal },
    { assembleOriginalHarness, harnessSourceParts },
    { test262NeedsTemporalGlobal },
    { CompilerPool },
  ] = await Promise.all([
    load("tests/test262-runner.ts"),
    load("tests/test262-original-harness.ts"),
    load("scripts/test262-temporal.mjs"),
    load("scripts/compiler-pool.ts"),
  ]);
  const fixtures = {},
    receipts = {};
  for (const [role, path] of [
    ["seed", SEED],
    ["target", TARGET],
  ]) {
    const source = regular(join(root, "test262"), path).toString("utf8"),
      meta = parseMeta(source),
      assembly = assembleOriginalHarness(source, meta);
    assert.ok(!meta.negative && !assembly.async && !assembly.raw, "unexpected fixture metadata");
    assert.ok(assembly.strictRerun, "missing original strict variant");
    const category = path.split("/").slice(1, 3).join("/");
    fixtures[role] = {
      path,
      primary: assembly.primary.source,
      strict: assembly.strictRerun.source,
      options: {
        isNegative: false,
        isRuntimeNegative: false,
        expectedErrorType: undefined,
        originalHarness: true,
        asyncTest: assembly.async,
        target: "gc",
        semanticProviders: "auto",
        inferModuleStrictArguments: isModuleGoal(category, meta, source),
        temporal: test262NeedsTemporalGlobal(path, meta.features),
      },
    };
    assert.equal(fixtures[role].options.temporal, role === "seed");
    receipts[role] = {
      path,
      fixtureSha256: sha(source),
      metadata: meta,
      options: fixtures[role].options,
      primarySha256: sha(assembly.primary.source),
      strictSha256: sha(assembly.strictRerun.source),
      harnessParts: harnessSourceParts(meta, assembly.async).map((p) => ({ name: p.name, sha256: sha(p.source) })),
    };
  }
  return { fixtures, receipts, CompilerPool };
}

async function executeChild(mode, root, dir) {
  let pool,
    baseline,
    preserved = [],
    completed = null,
    coverage = null,
    stopReason = null;
  const raw = [];
  try {
    assertLocalAdmission(
      "seeded",
      { node: process.version, platform: process.platform, arch: process.arch },
      process.env,
    );
    assertInterventionEnvironment(mode, process.env);
    baseline = inputSnapshot(root);
    assert.equal(baseline.trace.arm, mode, "installed arm differs from launch");
    assert.deepEqual(baseline.trace.controls, controls(), "control code drift");
    preserved = traceInventory(root);
    assert.equal(preserved.length, 0, "fresh subject trace directory required");
    save(join(dir, "preserved-traces.json"), preserved);
    const { fixtures, receipts, CompilerPool } = await fixtureInputs(root, baseline.loader.path);
    const plan = requestPlan("seeded", fixtures);
    save(join(dir, "admission.json"), {
      schema: "issue-5807-registry-intervention-v1",
      mode,
      root,
      pid: process.pid,
      ppid: process.ppid,
      executable: { path: realpathSync(process.execPath), sha256: sha(readFileSync(process.execPath)) },
      driverSha256: sha(readFileSync(SELF)),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      inputs: baseline,
      fixtures: receipts,
      preservedTraces: preserved,
      environmentMode: process.env[MODE_ENV],
      maximumVariantCount: plan.length * 2,
      conditionalRule: "strict only after primary PASS; seed must PASS all its variants",
      localOnly: true,
    });
    pool = new CompilerPool(1, "unified");
    await pool.ready();
    completed = await runControlledSequence(
      plan,
      pool,
      (row, n) => {
        raw.push(row);
        save(join(dir, `request-${n}.json`), row);
      },
      (results) =>
        auditRegistryInterventionTrace(readControlledTraces(root, preserved), mode, results, { partial: true }),
    );
    coverage = auditRegistryInterventionTrace(readControlledTraces(root, preserved), mode, completed.results);
  } catch (error) {
    stopReason = { message: error.message, stack: error.stack };
  } finally {
    if (pool) {
      // The original shutdown removes listeners before SIGTERM. Subscribe after
      // that call, without changing its signal, retries, timeouts, or decisions.
      const processes = pool.forks.map((state) => state.proc);
      pool.shutdown();
      const terminals = await Promise.all(
        processes.map((proc) =>
          proc.exitCode !== null || proc.signalCode !== null
            ? { pid: proc.pid, code: proc.exitCode, signal: proc.signalCode }
            : new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ pid: proc.pid, code, signal }))),
        ),
      );
      save(join(dir, "worker-terminals.json"), terminals);
    }
  }
  try {
    if (baseline) assert.deepEqual(inputSnapshot(root), baseline, "post-run input/dependency/bundle/provider drift");
    save(join(dir, "pre-exit-trace-inventory.json"), selectTrialTraces(traceInventory(root), preserved));
    if (completed)
      coverage = auditRegistryInterventionTrace(readControlledTraces(root, preserved), mode, completed.results);
    const stderr = readFileSync(join(dir, "stderr.log"), "utf8");
    assert.ok(
      !/built COLD|cacheHit=false|Temporal.*(?:NOT linked|unavailable)/i.test(stderr),
      "provider cold/unavailable diagnostic",
    );
    if (completed) assert.match(stderr, /Temporal provider .*cacheHit=true/, "missing warm provider receipt");
  } catch (error) {
    stopReason ??= { message: error.message, stack: error.stack };
  }
  const result = {
    schema: "issue-5807-registry-intervention-result-v1",
    mode,
    status: stopReason ? "INVALID_OR_INCOMPLETE_INTERVENTION" : "PRE_EXIT_DIAGNOSTIC_ONLY",
    stopReason,
    observedVariantCount: raw.length,
    expectedVariantCount: completed?.expectedVariantCount ?? null,
    maximumVariantCount: 4,
    rawResults: raw,
    coverage,
    regressionCleared: false,
  };
  save(join(dir, "result.json"), result);
  process.exitCode = stopReason ? 2 : 0;
}

export function auditRegistryIntervention(root = process.cwd()) {
  const install = verifyRegistryIntervention(root),
    dir = join(root, "replay5807-intervention-" + install.arm);
  const terminal = readJSON(join(dir, "terminal.json")),
    result = readJSON(join(dir, "result.json"));
  assert.equal(terminal.code, 0, "diagnostic child failed");
  assert.equal(terminal.signal, null, "diagnostic child signalled");
  assert.equal(result.stopReason, null, "incomplete trial");
  assert.equal(result.mode, install.arm, "result arm drift");
  const preserved = readJSON(join(dir, "preserved-traces.json"));
  assert.equal(preserved.length, 0, "unexpected preserved traces in fresh trial");
  const admission = readJSON(join(dir, "admission.json"));
  assert.equal(admission.pid, terminal.pid, "controller terminal PID mismatch");
  assert.equal(admission.environmentMode, install.arm, "recorded environment mismatch");
  assert.deepEqual(inputSnapshot(root), admission.inputs, "final input/dependency/bundle/provider drift");
  const coverage = auditRegistryInterventionTrace(
    readControlledTraces(root, preserved),
    install.arm,
    result.rawResults,
    { requireExit: true, workerTerminals: readJSON(join(dir, "worker-terminals.json")) },
  );
  assert.equal(result.observedVariantCount, coverage.requests, "result count mismatch");
  assert.equal(result.expectedVariantCount, coverage.requests, "expected count mismatch");
  assert.equal(result.maximumVariantCount, 4, "maximum count drift");
  for (const [i, row] of result.rawResults.entries())
    assert.deepEqual(readJSON(join(dir, `request-${i + 1}.json`)), row, "raw receipt mismatch");
  return {
    coverage,
    finalTraceInventory: selectTrialTraces(traceInventory(root), preserved),
    regressionCleared: false,
  };
}
export async function main(argv = process.argv.slice(2)) {
  const root = realpathSync(process.cwd()),
    command = argv[0];
  if (command === "install") {
    assert.equal(argv.length, 2, "usage: install original|sham|reset");
    return installRegistryIntervention(argv[1], root);
  }
  assert.equal(argv.length, command === "run" || command === "--internal-child" ? 2 : 1, "unexpected CLI arguments");
  if (command === "verify") return verifyRegistryIntervention(root);
  if (command === "audit") return auditRegistryIntervention(root);
  assert.ok(command === "run" || command === "--internal-child", "unknown command");
  assertLocalAdmission(
    "seeded",
    { node: process.version, platform: process.platform, arch: process.arch },
    process.env,
  );
  assert.equal(process.execArgv.length, 0, "invoke plain pinned node");
  const receipt = verifyRegistryIntervention(root),
    mode = receipt.arm,
    dir = join(root, "replay5807-intervention-" + mode);
  assertInterventionEnvironment(mode, process.env);
  if (command === "--internal-child") {
    assert.equal(argv[1], mode, "internal arm mismatch");
    const launch = readJSON(join(dir, "launch.json"));
    assert.equal(launch.parentPid, process.ppid);
    assert.equal(launch.mode, mode);
    assert.deepEqual(launch.controls, controls(), "launch code drift");
    return executeChild(mode, root, dir);
  }
  assert.equal(argv[1], "--execute", "explicit --execute required");
  mkdirSync(dir, { mode: 0o700 });
  save(join(dir, "launch.json"), {
    parentPid: process.pid,
    mode,
    root,
    controls: controls(),
    node: process.version,
    argv: process.argv,
  });
  const out = openSync(join(dir, "stdout.log"), "wx"),
    err = openSync(join(dir, "stderr.log"), "wx");
  let terminal;
  try {
    const child = spawn(process.execPath, [SELF, "--internal-child", mode], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", out, err],
    });
    terminal = await new Promise((resolve) => {
      child.once("error", (error) =>
        resolve({ code: null, signal: null, error: error.message, pid: child.pid ?? null }),
      );
      child.once("exit", (code, signal) => resolve({ code, signal, pid: child.pid ?? null }));
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  save(join(dir, "terminal.json"), { ...terminal, parentPid: process.pid, mode });
  let audited = null,
    stopReason = null;
  try {
    audited = auditRegistryIntervention(root);
  } catch (error) {
    stopReason = error.message;
  }
  // This outer controller never imports a subject compiler/runtime; child and
  // worker have exited before ANY final hashes are captured.
  const files = readdirSync(dir)
    .sort()
    .map((path) => ({ path, sha256: sha(regular(dir, path)) }));
  const final = {
    schema: "issue-5807-registry-intervention-final-v1",
    mode,
    terminal,
    status: stopReason ? "INVALID_OR_INCOMPLETE_INTERVENTION" : "COMPLETE_LOCAL_DIAGNOSTIC_ONLY",
    stopReason,
    audited,
    files,
    regressionCleared: false,
  };
  save(join(dir, "final.json"), final);
  process.exitCode = stopReason ? 2 : 0;
  return { artifactDirectory: dir, ...final };
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) console.log(JSON.stringify(await main(), null, 2));
