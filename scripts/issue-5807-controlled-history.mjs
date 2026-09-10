// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// LOCAL diagnostic only. Importing this file never executes a historical fixture.
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
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha, TARGET, verifyObservationTrace } from "./issue-5807-observation-trace.mjs";

export const SEED = "test/built-ins/Temporal/Duration/from/argument-string-invalid.js";
export const CORPUS = "b363f29d3c43c626dc852744ad64a0b48a003693";
export const PROVIDER_SHA = "1e277d9b4bc3e634f5838bdeff0f8088f56dba8c7e8a394ee38c2c63286df18b";
export const PROVIDER_KEY = "372a41be9bdeb22ade63a811b4b26afce75694ee0d9b7cf928c24ddad739020b";
const SELF = fileURLToPath(import.meta.url);
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const git = (root, ...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trimEnd();
const inside = (root, path) => path === root || path.startsWith(root + sep);

export function assertLocalAdmission(mode, runtime, env) {
  assert.ok(["alone", "seeded"].includes(mode), "mode must be alone|seeded");
  assert.deepEqual(
    runtime,
    { node: "v25.9.0", platform: "darwin", arch: "arm64" },
    "requires explicit local Node25.9 macOS arm64",
  );
  for (const [key, value] of Object.entries({
    REPLAY_OBSERVATION_TRACE: "1",
    COMPILER_POOL_SIZE: "1",
    TEST262_WORKER_MAX_OLD_SPACE_SIZE: "1024",
    TEST262_ORACLE_MODE: "honest",
    TEST262_SEMANTIC_PROVIDERS: "auto",
    TEST262_REALM_CANARY: "recycle",
    TEST262_TARGET: "gc",
    TEST262_TZ: "UTC",
    JS2WASM_TEMPORAL_CACHE: ".test262-cache/temporal",
  }))
    assert.equal(env[key], value, key);
  for (const key of [
    "JS2WASM_IR_FIRST",
    "JS2WASM_FNCTOR_LAYOUT_EMIT",
    "JS2WASM_EVAL_ENGINE",
    "TEST262_FULL_RUNTIME_EVAL",
    "TEST262_PATH_FILTER",
    "TEST262_IT_TIMEOUT_MS",
    "NODE_OPTIONS",
    "NODE_PATH",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
  ])
    assert.ok(env[key] === undefined || env[key] === "", `unexpected override: ${key}`);
  assert.ok(
    env.JS2WASM_TEST262_TEMPORAL === undefined || env.JS2WASM_TEST262_TEMPORAL === "1",
    "provider disabled/overridden",
  );
}

// Canonical full tree census: no followed symlinks, escaping/broken links reject.
// Node_modules may itself point at the parent's isolated canonical dependency root.
export function treeSnapshot(path) {
  const root = realpathSync(path),
    entries = [];
  assert.ok(lstatSync(root).isDirectory(), "snapshot root is not directory");
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name),
        rel = relative(root, full),
        st = lstatSync(full);
      if (st.isSymbolicLink()) {
        assert.ok(inside(root, realpathSync(full)), `escaping tree link: ${rel}`);
        entries.push({ path: rel, type: "link", target: readlinkSync(full) });
      } else if (st.isDirectory()) {
        entries.push({ path: rel, type: "directory" });
        walk(full);
      } else {
        assert.ok(st.isFile(), `nonregular tree entry: ${rel}`);
        entries.push({ path: rel, type: "file", bytes: st.size, sha256: sha(readFileSync(full)) });
      }
    }
  }
  walk(root);
  assert.ok(
    entries.some((e) => e.type === "file"),
    "empty snapshot",
  );
  return { root, count: entries.length, sha256: sha(JSON.stringify(entries)), entries };
}
function regular(root, path) {
  const full = join(root, path);
  assert.equal(realpathSync(full), full, `aliased source: ${path}`);
  assert.ok(lstatSync(full).isFile(), `nonregular source: ${path}`);
  return readFileSync(full);
}
function inputSnapshot(root) {
  const trace = verifyObservationTrace(root);
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

export function requestPlan(mode, fixtures) {
  assert.ok(["alone", "seeded"].includes(mode));
  assert.deepEqual(Object.keys(fixtures).sort(), ["seed", "target"]);
  return (mode === "alone" ? ["target"] : ["seed", "target"]).map((role) => {
    const f = fixtures[role];
    assert.equal(f.path, role === "seed" ? SEED : TARGET);
    assert.equal(typeof f.primary, "string");
    assert.ok(f.primary.length > 0);
    assert.equal(typeof f.strict, "string");
    assert.ok(f.strict.length > 0, "both pinned fixtures require strict rerun");
    return {
      role,
      path: f.path,
      variants: [
        { label: f.path, source: f.primary },
        { label: `${f.path} [strict rerun]`, source: f.strict },
      ],
      options: f.options,
    };
  });
}

// Pure orchestration seam for synthetic tests. Original CompilerPool alone owns
// its existing crash retry; this driver never retries a runTest call.
export async function runControlledSequence(plan, pool, record, checkpoint) {
  const results = [];
  for (const fixture of plan) {
    for (const [index, variant] of fixture.variants.entries()) {
      const raw = await pool.runTest(variant.source, { ...fixture.options, label: variant.label }, 30_000);
      const row = { role: fixture.role, variant: index === 0 ? "primary" : "strict", label: variant.label, raw };
      results.push(row);
      record(row, results.length);
      assert.ok(
        raw && ["pass", "fail", "compile_error", "compile_timeout", "compiled", "skip"].includes(raw.status),
        "malformed raw result",
      );
      assert.ok(!raw.recycle, "worker requested recycling; history invalid");
      assert.ok(!["compile_timeout", "compiled", "skip"].includes(raw.status), "no executed diagnostic verdict");
      if (fixture.role === "seed") assert.equal(raw.status, "pass", "seed failed; history invalid");
      await checkpoint(results);
      if (raw.status !== "pass") break; // original conditional strict-rerun rule
    }
  }
  return { results, expectedVariantCount: results.length, maximumVariantCount: plan.length * 2 };
}

export function traceInventory(root) {
  const dir = join(root, "replay5807-traces");
  assert.equal(realpathSync(dir), dir, "aliased trace directory");
  return readdirSync(dir)
    .sort()
    .map((path) => {
      assert.match(path, /^\d+-[0-9a-f-]+\.jsonl$/, "unexpected trace artifact");
      return { path, sha256: sha(regular(dir, path)) };
    });
}
export function selectTrialTraces(current, preserved) {
  assert.equal(new Set(current.map((f) => f.path)).size, current.length, "duplicate current trace path");
  assert.equal(new Set(preserved.map((f) => f.path)).size, preserved.length, "duplicate preserved trace path");
  const old = new Map(preserved.map((f) => [f.path, f.sha256]));
  for (const [path, hash] of old)
    assert.equal(current.find((f) => f.path === path)?.sha256, hash, "preserved trace missing/drifted");
  return current.filter((f) => !old.has(f.path));
}
export function readControlledTraces(root, preserved = []) {
  const dir = join(root, "replay5807-traces");
  return selectTrialTraces(traceInventory(root), preserved).map(({ path }) => {
    const text = regular(dir, path).toString("utf8");
    assert.ok(text.endsWith("\n"), "partial trace line");
    return text.trimEnd().split("\n").map(JSON.parse);
  });
}

/** Separate controlled-history admission. Never calls/changes the 939 audit.
 * partial=true admits only the exact completed prefix, between sequential calls.
 */
export function auditControlledHistoryTrace(streams, mode, results, { partial = false } = {}) {
  assert.ok(["alone", "seeded"].includes(mode), "unknown controlled mode");
  assert.ok(results.length > 0, "silent-empty results");
  assert.ok(results.length <= (mode === "alone" ? 2 : 4), "too many requests");
  const labels = [],
    roles = mode === "alone" ? ["target"] : ["seed", "target"];
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
  assert.ok(streams.length >= 2, "silent-empty/missing worker trace");
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
    const linked = own.filter((r) => r.event === "instantiate");
    assert.equal(linked.length, 1, "missing/extra instantiation");
    const seed = results[index].role === "seed";
    assert.equal(start.data.temporalRequested, seed);
    assert.equal(linked[0].data.linkedModules, seed ? 1 : 0, "incorrect actual linkage");
    if (!seed) {
      const lastSeed = results.findLastIndex((r) => r.role === "seed");
      if (mode === "alone") assert.equal(start.precedingLinked, null, "fresh target inherited linked state");
      else
        assert.deepEqual(start.precedingLinked, starts[lastSeed].request, "target lacks exact preceding linked seed");
      assert.ok(!own.some((r) => r.event === "registry-reset"), "target reset intervention");
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
  return {
    status: partial ? "EXACT_COMPLETED_PREFIX" : "CONTROLLED_HISTORY_OBSERVED_NOT_CAUSAL_PROOF",
    mode,
    requests: labels.length,
    workerPid: worker.pid,
    workerBoot: worker.boot,
    generation: birth.data.generation,
    precedingLinked: starts.filter((r) => r.request.path.startsWith(TARGET)).map((r) => r.precedingLinked),
    factoryIdentity: "unavailable-without-extra-compiled-reads",
    tailLimit: "abrupt/unwritten final tails remain unavailable",
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
    assertLocalAdmission(mode, { node: process.version, platform: process.platform, arch: process.arch }, process.env);
    baseline = inputSnapshot(root);
    preserved = traceInventory(root);
    save(join(dir, "preserved-traces.json"), preserved);
    const { fixtures, receipts, CompilerPool } = await fixtureInputs(root, baseline.loader.path);
    const plan = requestPlan(mode, fixtures);
    save(join(dir, "admission.json"), {
      schema: "issue-5807-controlled-history-v1",
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
      (results) => auditControlledHistoryTrace(readControlledTraces(root, preserved), mode, results, { partial: true }),
    );
    coverage = auditControlledHistoryTrace(readControlledTraces(root, preserved), mode, completed.results);
  } catch (error) {
    stopReason = { message: error.message, stack: error.stack };
  } finally {
    if (pool) {
      // The original shutdown removes listeners before SIGTERM. Subscribe after
      // that call, without changing its signal, retries, timeouts, or decisions.
      const processes = pool.forks.map((state) => state.proc);
      pool.shutdown();
      await Promise.all(
        processes.map((proc) =>
          proc.exitCode !== null || proc.signalCode !== null
            ? undefined
            : new Promise((resolve) => proc.once("exit", resolve)),
        ),
      );
    }
  }
  try {
    if (baseline) assert.deepEqual(inputSnapshot(root), baseline, "post-run input/dependency/bundle/provider drift");
    save(join(dir, "trace-inventory.json"), selectTrialTraces(traceInventory(root), preserved));
    if (completed)
      coverage = auditControlledHistoryTrace(readControlledTraces(root, preserved), mode, completed.results);
    const stderr = readFileSync(join(dir, "stderr.log"), "utf8");
    assert.ok(
      !/built COLD|cacheHit=false|Temporal.*(?:NOT linked|unavailable)/i.test(stderr),
      "provider cold/unavailable diagnostic",
    );
    if (mode === "seeded" && completed)
      assert.match(stderr, /Temporal provider .*cacheHit=true/, "missing warm provider receipt");
  } catch (error) {
    stopReason ??= { message: error.message, stack: error.stack };
  }
  const result = {
    schema: "issue-5807-controlled-history-result-v1",
    mode,
    status: stopReason ? "INVALID_OR_INCOMPLETE_HISTORY" : "COMPLETE_LOCAL_DIAGNOSTIC_ONLY",
    stopReason,
    observedVariantCount: raw.length,
    expectedVariantCount: completed?.expectedVariantCount ?? null,
    maximumVariantCount: mode === "alone" ? 2 : 4,
    rawResults: raw,
    coverage,
    regressionCleared: false,
  };
  save(join(dir, "result.json"), result);
  process.exitCode = stopReason ? 2 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  const mode = argv[0],
    root = realpathSync(process.cwd());
  assertLocalAdmission(mode, { node: process.version, platform: process.platform, arch: process.arch }, process.env);
  assert.equal(process.execArgv.length, 0, "invoke plain pinned node; loader registered from subject dependencies");
  const dir = join(root, `replay5807-controlled-${mode}`);
  if (argv.length === 2 && argv[1] === "--internal-child") {
    const launch = readJSON(join(dir, "launch.json"));
    assert.equal(launch.parentPid, process.ppid);
    assert.equal(launch.mode, mode);
    assert.equal(launch.driverSha256, sha(readFileSync(SELF)));
    return executeChild(mode, root, dir);
  }
  assert.equal(
    argv.length,
    1,
    "usage: node <control>/scripts/issue-5807-controlled-history.mjs alone|seeded (cwd subject)",
  );
  // A fixed exclusive directory prevents reusing or overwriting a prior trial.
  mkdirSync(dir, { mode: 0o700 });
  save(join(dir, "launch.json"), {
    parentPid: process.pid,
    mode,
    root,
    driverSha256: sha(readFileSync(SELF)),
    node: process.version,
    argv: process.argv,
  });
  const out = openSync(join(dir, "stdout.log"), "wx"),
    err = openSync(join(dir, "stderr.log"), "wx");
  try {
    const child = spawn(process.execPath, [SELF, mode, "--internal-child"], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", out, err],
    });
    const terminal = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    save(join(dir, "terminal.json"), { ...terminal, pid: child.pid ?? null, parentPid: process.pid, mode });
    process.exitCode = terminal.code === 0 ? 0 : 2;
    console.log(JSON.stringify({ artifactDirectory: dir, terminal, regressionCleared: false }));
  } finally {
    closeSync(out);
    closeSync(err);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) await main();
