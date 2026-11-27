import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import test from "node:test";
import { IR_ARTIFACTS, publishIrMeasurements } from "./test262-ir-site-measurements.mjs";

// Execute the actual deployment boundary with real temporary input/output files.
// These synthetic metadata fixtures do not represent compiler execution or scores.
const source = fs.readFileSync(resolve(import.meta.dirname, "build-pages.js"), "utf8");
const helper = source.slice(
  source.indexOf("function resolvePreferredFileOrNull("),
  source.indexOf("function writeJson("),
);
const start = source.indexOf("// IR measurements have their own namespace.");
assert.ok(start >= 0);
const hook = source.slice(start, source.indexOf("const equivTests =", start));

function check(input, expectedError = false, expectedFiles) {
  const directory = fs.mkdtempSync(join(tmpdir(), "js2-ir-pages-artifacts-"));
  try {
    const benchmarks = join(directory, "benchmarks");
    fs.mkdirSync(benchmarks, { recursive: true });
    for (const [file, data] of Object.entries(input)) {
      fs.mkdirSync(dirname(join(benchmarks, file)), { recursive: true });
      fs.writeFileSync(join(benchmarks, file), JSON.stringify(data));
    }
    const copies = [];
    const context = {
      join,
      existsSync: fs.existsSync,
      readFileSync: fs.readFileSync,
      rmSync: fs.rmSync,
      BENCHMARKS_RESULTS_DIR: benchmarks,
      PUBLIC_BENCH: join(directory, "public"),
      PAGES_DIST: join(directory, "pages"),
      PLAYGROUND_BENCHMARKS_RESULTS_DIR: join(directory, "playground"),
      copyFile: (src, dst) => {
        fs.mkdirSync(dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        assert.deepEqual(fs.readFileSync(dst), fs.readFileSync(src));
        copies.push(dst);
      },
    };
    const execute = () => vm.runInNewContext(helper + "\n" + hook, context);
    if (expectedError) assert.throws(execute);
    else {
      execute();
      assert.equal(
        copies.length,
        (expectedFiles || Object.keys(input).filter((file) => file !== "test262-report.json")).length * 2,
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const measured = {
  compilerPath: "ir",
  requestedCompilerPath: "ir",
  measurementState: "measured",
  compilerPathVerified: true,
  executionCompilerPath: "ir",
  mode: { target: "gc" },
  attemptedCases: 1,
  completedCases: 1,
  skippedCases: 0,
  compileErrorCases: 0,
  compileTimeoutCases: 0,
  verifiedExecutionCases: 1,
  unverifiedExecutionCases: 0,
};
const standalone = { ...measured, mode: { target: "standalone" } };
const allCompileErrors = {
  ...standalone,
  compilerPathVerified: false,
  executionCompilerPath: "unknown",
  attemptedCases: 3,
  completedCases: 3,
  compileErrorCases: 3,
  verifiedExecutionCases: 0,
  unverifiedExecutionCases: 3,
};
const unavailable = {
  compilerPath: "ir",
  compilerPathVerified: false,
  executionCompilerPath: "unknown",
  state: "unavailable",
  reason: "Not measured",
};

test("missing IR artifacts remain absent", () => check({}));
test("legacy reports are never copied as IR fallback", () =>
  check({ "test262-report.json": { summary: { pass: 100, total: 100 } } }));
test("unavailable IR status is copied without a score", () => check({ "test262-ir-status.json": unavailable }));
test("IR host and standalone reports have separate destinations", () =>
  check({ "test262-ir-report.json": measured, "test262-standalone-ir-report.json": standalone }));
test("IR editions and history retain their isolated envelopes", () =>
  check({
    "ir/test262-editions.json": { ...measured, editions: [] },
    "ir/runs/index.json": { ...measured, runs: [] },
  }));
test("IR feature envelopes deploy for both lanes", () =>
  check({
    "ir/feature-examples.json": { ...measured, features: [] },
    "ir/feature-examples-standalone.json": { ...standalone, features: [] },
  }));
test("legacy identity is rejected at an IR destination", () =>
  check({ "test262-ir-report.json": { ...measured, compilerPath: "legacy" } }, true));
test("contradictory aggregate verification is rejected", () =>
  check({ "test262-ir-report.json": { ...measured, compilerPathVerified: false } }, true));
test("unknown execution cannot supply IR numbers", () =>
  check({ "test262-ir-report.json": { ...measured, executionCompilerPath: "unknown" } }, true));
test("unlabelled arrays are rejected", () => check({ "ir/test262-editions.json": [] }, true));
test("IR standalone editions, their history and the edition maps deploy under the standalone identity", () =>
  check({
    "ir/test262-standalone-editions.json": { ...standalone, editions: [{ edition: "ES5", pass: 1, total: 1 }] },
    "ir/runs/standalone-editions-index.json": { ...standalone, runs: [] },
    // Frontmatter maps are lane-neutral: the standalone measurement's copy is the IR copy.
    "ir/test262-category-editions.json": { ...standalone, data: {} },
    "ir/test262-file-editions.json": { ...standalone, data: { editions: [], files: {} } },
  }));
test("raw generator output cannot occupy an IR edition destination", () => {
  check({ "ir/test262-standalone-editions.json": [{ edition: "ES5", pass: 1, total: 1 }] }, true);
  check({ "ir/runs/standalone-editions-index.json": [{ timestamp: "t", editions: [] }] }, true);
  check({ "ir/test262-file-editions.json": { editions: [], files: {} } }, true);
});
test("a host edition envelope cannot occupy the IR standalone destination", () =>
  check({ "ir/test262-standalone-editions.json": { ...measured, editions: [] } }, true));
test("an unavailable status must explain its reason", () =>
  check({ "test262-ir-status.json": { ...unavailable, reason: "" } }, true));

test("a completed requested IR attempt publishes genuine compilation errors with zero verified execution", () =>
  check({ "test262-standalone-ir-report.json": allCompileErrors }));
test("skip and retry denominators stay distinct from completed verdicts", () =>
  check({
    "test262-ir-report.json": {
      ...measured,
      compilerPathVerified: false,
      executionCompilerPath: "mixed",
      attemptedCases: 4,
      completedCases: 3,
      skippedCases: 1,
      compileErrorCases: 1,
      unverifiedExecutionCases: 1,
    },
  }));
test("a standalone report cannot occupy the IR host destination", () =>
  check({ "test262-ir-report.json": standalone }, true));
test("a host report cannot occupy the IR standalone destination", () =>
  check({ "test262-standalone-ir-report.json": measured }, true));
test("a request flag alone is not a measured attempt", () =>
  check({ "test262-ir-report.json": { ...measured, measurementState: undefined } }, true));
test("malformed measurement counts are rejected", () =>
  check({ "test262-standalone-ir-report.json": { ...allCompileErrors, attemptedCases: "3" } }, true));
test("zero actual compiler attempts cannot produce a measured score", () =>
  check({ "test262-standalone-ir-report.json": { ...allCompileErrors, attemptedCases: 0 } }, true));
test("unverified verdict counts cannot disappear", () =>
  check({ "test262-standalone-ir-report.json": { ...allCompileErrors, unverifiedExecutionCases: 0 } }, true));

test("compiler errors cannot be counted as verified runtime executions", () =>
  check({ "test262-ir-report.json": { ...measured, compileErrorCases: 1 } }, true));

const viewSource = fs.readFileSync(resolve(import.meta.dirname, "../website/components/t262-view-state.js"), "utf8");
function view(search = "?ir=1", payload) {
  const window = {
    location: {
      href: `https://example.test/${search}`,
      origin: "https://example.test",
      search,
      pathname: "/",
      hash: "",
    },
    fetch: async () => ({ ok: true, json: async () => payload }),
  };
  vm.runInNewContext(viewSource, { window, URL, URLSearchParams });
  return window.t262ViewState;
}
test("IR view displays an all-compile-error measurement without claiming execution", async () => {
  const state = view("?ir=1", allCompileErrors);
  assert.equal(await state.fetchData("./benchmarks/results/test262-standalone-report.json"), allCompileErrors);
  assert.match(
    state.irMeasurementLabel(allCompileErrors, "standalone"),
    /verified IR executions 0.*unverified cases 3/,
  );
});
test("IR view rejects a swapped runtime even when query parameters mention standalone", async () => {
  await assert.rejects(view("?ir=1", standalone).fetchData("./benchmarks/results/test262-report.json?note=standalone"));
});
test("IR view reads standalone editions and the lane-neutral edition maps from the standalone measurement", async () => {
  const editions = [{ edition: "ES5", pass: 1, total: 3 }];
  assert.equal(
    await view("?ir=1", { ...allCompileErrors, editions }).fetchData(
      "./benchmarks/results/test262-standalone-editions.json",
      "editions",
    ),
    editions,
  );
  const data = { editions: ["ES5"], files: {} };
  for (const map of ["test262-category-editions.json", "test262-file-editions.json"])
    assert.equal(
      await view("?ir=1", { ...allCompileErrors, data }).fetchData(`./benchmarks/results/${map}`, "data"),
      data,
    );
  // A bare regular-lane array at the IR URL is refused, not rendered.
  await assert.rejects(
    view("?ir=1", editions).fetchData("./benchmarks/results/test262-standalone-editions.json", "editions"),
  );
});
test("IR view never fetches remote legacy fallbacks", () => {
  assert.throws(() =>
    view().dataUrl("https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-current.json"),
  );
});
test("historical JS Host data stays untouched in the ordinary view", async () => {
  const historical = { timestamp: "2026-09-01T00:00:00Z", baseline_sha: "frozen", summary: { pass: 10, total: 20 } };
  assert.equal(await view("?mode=host", historical).fetchData("./benchmarks/results/test262-report.json"), historical);
});
test("IR provenance separates request, measurement, proof, source and date", () => {
  const label = view().irMeasurementLabel(
    {
      ...allCompileErrors,
      attemptedCases: 6,
      completedCases: 3,
      timestamp: "2026-10-19T00:00:00Z",
      baseline_sha: "source-revision",
    },
    "standalone",
  );
  assert.match(label, /IR requested.*measured 3 cases.*6 compiler attempts.*unverified cases 3/);
  assert.match(label, /source-revision.*2026-10-19/);
});

test("an edition row from a later edition-only run names its own commit and date; full-run rows add nothing", () => {
  const label = view().irEditionSourcesLabel([
    { edition: "ES5", pass: 2, total: 4, scope: "edition", sourceSha: "head", measuredAt: "2026-11-27T12:00:00Z" },
    { edition: "ES2015", pass: 0, total: 1 },
  ]);
  assert.match(label, /ES5 from a later edition-only run · source head · 2026-11-27T12:00:00Z/);
  assert.doesNotMatch(label, /ES2015/);
  assert.equal(view().irEditionSourcesLabel(rawEditions), "");
});

test("historical Host caption keeps the actual frozen date and revision", () => {
  assert.equal(
    view("?mode=host").historicalHostLabel({ baseline_sha: "old-revision", baseline_generated_at: "2026-09-01" }),
    "Historical JS Host · retired 2026-10-12 · frozen results · source old-revision · 2026-09-01",
  );
});

// Execute the actual workflow metadata programs without a compiler, shell, Git or network.
// An override lets the reviewed, unapplied workflow proposal be checked before approval.
const workflowRoot = process.env.TEST262_WORKFLOW_ROOT || resolve(import.meta.dirname, "..");
const workflow = fs.readFileSync(join(workflowRoot, ".github/workflows/test262-sharded.yml"), "utf8");
const pagesWorkflow = fs.readFileSync(join(workflowRoot, ".github/workflows/deploy-pages.yml"), "utf8");
function program(text, marker) {
  const start = text.indexOf(`// ${marker}_START`);
  const end = text.indexOf(`// ${marker}_END`, start);
  assert.ok(start >= 0 && end > start, `missing actual workflow program ${marker}`);
  return text
    .slice(start, end)
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
}
const currentEdition = fs.readFileSync(join(workflowRoot, "scripts/test262-current-edition.json"), "utf8");
async function selectMeasurement(event, day, inputs = {}) {
  return (await planMeasurement(event, day, inputs)).selected;
}
async function planMeasurement(event, day, inputs = {}) {
  let output = "";
  let selected;
  const snippet = program(workflow, "IR_MEASUREMENT_PLAN").replace(
    "const { appendFileSync } = await import('node:fs');",
    "const { appendFileSync } = fs;",
  );
  const context = {
    process: { env: { EVENT_NAME: event, CURRENT_EDITION: currentEdition, ...inputs } },
    fs: {
      appendFileSync: (_, value) => {
        output += value;
      },
    },
    Date: class {
      getUTCDay() {
        return day;
      }
    },
    console: {
      log: (value) => {
        selected = JSON.parse(value);
      },
    },
  };
  await vm.runInNewContext(`(async () => {${snippet}\n})()`, context);
  const outputs = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  assert.equal(outputs.run, String(selected.run));
  return { selected, outputs };
}
test("every scheduled (daily) run has exactly the full IR standalone cell and never Host", async () => {
  const full = {
    run: true,
    cells: [{ compilerPath: "ir", target: "standalone", scope: "full", edition: "", chunks: 102 }],
    promotion: false,
  };
  for (let day = 0; day < 7; day++) assert.deepEqual(await selectMeasurement("schedule", day), full);
  const { outputs } = await planMeasurement("schedule", 1);
  assert.equal(outputs.artifact, "test262-ir-standalone-measurement");
  assert.deepEqual(
    JSON.parse(outputs.matrix),
    Array.from({ length: 102 }, (_, i) => i + 1),
  );
  // The daily full run is throttled so the merge queue keeps runners.
  assert.equal(outputs.max_parallel, "40");
});
test("every merge to main measures only the configured current edition, under its own artifact name", async () => {
  const { edition, chunks } = JSON.parse(currentEdition);
  const { selected, outputs } = await planMeasurement("push", 3, { ACTOR: "a-developer" });
  assert.deepEqual(selected.cells, [{ compilerPath: "ir", target: "standalone", scope: "edition", edition, chunks }]);
  assert.equal(outputs.scope, "edition");
  assert.equal(outputs.edition, edition);
  assert.equal(outputs.chunks, String(chunks));
  assert.deepEqual(
    JSON.parse(outputs.matrix),
    Array.from({ length: chunks }, (_, i) => i + 1),
  );
  // The site reads an edition run only under the edition name, never as the full corpus.
  assert.equal(outputs.artifact, IR_ARTIFACTS.edition);
  assert.notEqual(outputs.artifact, IR_ARTIFACTS.full);
  // The edition run is on the merge queue's critical path: never throttled below its chunk count.
  assert.ok(Number(outputs.max_parallel) >= chunks, `max_parallel ${outputs.max_parallel} < ${chunks} chunks`);
});
test("a merge with an unusable current-edition config fails the plan instead of measuring the wrong scope", async () => {
  for (const config of [{ edition: "ES5" }, { edition: "ES5", chunks: 0 }, { chunks: 8 }])
    await assert.rejects(planMeasurement("push", 3, { ACTOR: "a-developer", CURRENT_EDITION: JSON.stringify(config) }));
});
test("a bot push, a pull request and a test262-irrelevant queue group select no IR measurement", async () => {
  const none = { run: false, cells: [], promotion: false };
  assert.deepEqual(await selectMeasurement("push", 1, { ACTOR: "github-actions[bot]" }), none);
  assert.deepEqual(await selectMeasurement("pull_request", 1), none);
  assert.deepEqual(await selectMeasurement("merge_group", 1, { RUN_SHARDS: "false" }), none);
});
test("the merge queue measures the current edition; the push after it reuses that measurement", async () => {
  const { edition, chunks } = JSON.parse(currentEdition);
  const edition_cell = [{ compilerPath: "ir", target: "standalone", scope: "edition", edition, chunks }];
  // run_shards true, or unknown because `changes` failed: measure (fail-safe).
  for (const RUN_SHARDS of ["true", ""]) {
    const { selected, outputs } = await planMeasurement("merge_group", 1, { RUN_SHARDS });
    assert.deepEqual(selected.cells, edition_cell);
    assert.equal(outputs.artifact, "test262-ir-standalone-edition-measurement");
  }
  // The queue already measured this exact commit: the push runs nothing.
  assert.equal(
    (await selectMeasurement("push", 1, { ACTOR: "github-merge-queue[bot]", QUEUE_MEASURED: "true" })).run,
    false,
  );
  // A direct push, or a probe miss, measures.
  assert.deepEqual(
    (await selectMeasurement("push", 1, { ACTOR: "a-developer", QUEUE_MEASURED: "false" })).cells,
    edition_cell,
  );
  // The probe looks for exactly the artifact name the plan assigns to edition runs.
  const plan = workflow.slice(
    workflow.indexOf("  compiler-path-measurement-plan:"),
    workflow.indexOf("  test262-ir-measurement-shard:"),
  );
  assert.match(plan, /ART_NAME: test262-ir-standalone-edition-measurement\n/);
  assert.match(plan, /QUEUE_MEASURED: \$\{\{ steps\.probe\.outputs\.measured \}\}/);
});
test("one full_run dispatch runs what the daily schedule runs (#7551)", async () => {
  const dispatch = { COMPILER_PATH: "ir", MEASUREMENT_TARGET: "standalone" };
  // The IR half: the same full cell the schedule selects.
  assert.deepEqual(
    await selectMeasurement("workflow_dispatch", 1, { ...dispatch, FULL_RUN: "true", MEASUREMENT: "false" }),
    await selectMeasurement("schedule", 1),
  );
  // The legacy half: test262-shard and promotion run on any dispatch without
  // compiler_path_measurement, which full_run must not be combined with.
  const legacy = workflow.slice(workflow.indexOf("\n  test262-shard:\n"), workflow.indexOf("\n  test262-shard-mg:\n"));
  assert.match(legacy, /github\.event_name == 'workflow_dispatch' && !inputs\.compiler_path_measurement/);
  await assert.rejects(
    selectMeasurement("workflow_dispatch", 1, { ...dispatch, FULL_RUN: "true", MEASUREMENT: "true" }),
    /full_run already includes/,
  );
  assert.match(workflow, /\n {6}full_run:\n {8}description:/);
});
test("manual measurement is immediate, explicit and standalone only", async () => {
  assert.equal(
    (
      await selectMeasurement("workflow_dispatch", 3, {
        MEASUREMENT: "true",
        COMPILER_PATH: "ir",
        MEASUREMENT_TARGET: "standalone",
      })
    ).run,
    true,
  );
  assert.equal((await selectMeasurement("workflow_dispatch", 1, { MEASUREMENT: "false" })).run, false);
  await assert.rejects(
    selectMeasurement("workflow_dispatch", 1, {
      MEASUREMENT: "true",
      COMPILER_PATH: "ir",
      MEASUREMENT_TARGET: "js-host",
    }),
  );
  await assert.rejects(
    selectMeasurement("workflow_dispatch", 1, {
      MEASUREMENT: "true",
      COMPILER_PATH: "legacy",
      MEASUREMENT_TARGET: "standalone",
    }),
  );
});
function memoryFiles(initial = {}) {
  const files = new Map(
    Object.entries(initial).map(([path, value]) => [path, typeof value === "string" ? value : JSON.stringify(value)]),
  );
  return {
    files,
    fs: {
      readFileSync: (path) => {
        if (!files.has(path)) throw new Error(`Missing fixture ${path}`);
        return files.get(path);
      },
      writeFileSync: (path, value) => files.set(path, value),
      mkdirSync: () => {},
      rmSync: (path) => files.delete(path),
    },
  };
}
test("actual artifact program retains all-fail measurements and isolated history", () => {
  const fixture = memoryFiles({
    "ir-measurement/test262-standalone-ir-report.json": {
      ...allCompileErrors,
      baseline_sha: "source",
      timestamp: "date",
      categories: [{ name: "language", compile_error: 3 }],
    },
  });
  const snippet = program(workflow, "IR_MEASUREMENT_ARTIFACTS").replace(
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const { readFileSync, writeFileSync } = fs;",
  );
  vm.runInNewContext(snippet, {
    fs: fixture.fs,
    process: { env: { RUN_ID: "12", RUN_ATTEMPT: "1", SOURCE_SHA: "source" } },
  });
  const history = JSON.parse(fixture.files.get("ir-measurement/ir/runs/standalone-index.json"));
  assert.equal(history.runs[0].verifiedExecutionCases, 0);
  assert.equal(history.runs[0].compileErrorCases, 3);
  assert.equal(history.mode.target, "standalone");
  assert.ok(!fixture.files.has("test262-current.json"));
  const categories = JSON.parse(fixture.files.get("ir-measurement/ir/test262-standalone-categories.json"));
  assert.equal(categories.categories[0].compile_error, 3);
});
const rawEditions = [
  { edition: "ES5", pass: 0, fail: 0, ce: 2, skip: 0, total: 2, pct: 0 },
  { edition: "ES2015", pass: 0, fail: 0, ce: 1, skip: 0, total: 1, pct: 0 },
];
function runArtifactProgram(rawFiles) {
  const fixture = memoryFiles({
    "ir-measurement/test262-standalone-ir-report.json": {
      ...allCompileErrors,
      baseline_sha: "source",
      timestamp: "2026-11-09T00:00:00.000Z",
      strict_summary: { pass: 0, total: 2 },
      categories: [],
    },
    ...rawFiles,
  });
  const snippet = program(workflow, "IR_MEASUREMENT_ARTIFACTS").replace(
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const { readFileSync, writeFileSync } = fs;",
  );
  vm.runInNewContext(snippet, {
    fs: fixture.fs,
    process: { env: { RUN_ID: "12", RUN_ATTEMPT: "1", SOURCE_SHA: "source" } },
  });
  return (path) => (fixture.files.has(path) ? JSON.parse(fixture.files.get(path)) : undefined);
}
test("actual artifact program labels the regular generators' edition output as this IR measurement", () => {
  const artifact = runArtifactProgram({
    "ir-editions-raw/test262-editions.json": rawEditions,
    "ir-editions-raw/runs/standalone-editions-index.json": [
      {
        timestamp: "20261109-000500",
        gitHash: "source",
        editions: rawEditions.map(({ edition, pass, total }) => ({ edition, pass, total })),
      },
    ],
    "ir-editions-raw/test262-category-editions.json": { language: { ES5: { pass: 0, fail: 0, ce: 2, skip: 0 } } },
    "ir-editions-raw/test262-file-editions.json": { editions: ["ES5"], files: { "language/x.js": 0 } },
  });
  const editions = artifact("ir-measurement/ir/test262-standalone-editions.json");
  assert.deepEqual(editions.editions, rawEditions);
  assert.equal(editions.compilerPath, "ir");
  assert.equal(editions.mode.target, "standalone");
  assert.equal(editions.baseline_sha, "source");
  const history = artifact("ir-measurement/ir/runs/standalone-editions-index.json");
  assert.equal(history.compilerPath, "ir");
  assert.deepEqual(history.runs, [
    {
      timestamp: "2026-11-09T00:00:00.000Z",
      gitHash: "source",
      editions: [
        { edition: "ES5", pass: 0, total: 2 },
        { edition: "ES2015", pass: 0, total: 1 },
      ],
    },
  ]);
  assert.deepEqual(artifact("ir-measurement/ir/test262-category-editions.json").data.language.ES5.ce, 2);
  assert.deepEqual(artifact("ir-measurement/ir/test262-file-editions.json").data.files, { "language/x.js": 0 });
  // The strict figure needs no file of its own: it travels in the report.
  assert.deepEqual(artifact("ir-measurement/test262-standalone-ir-report.json").strict_summary, { pass: 0, total: 2 });
});
test("actual artifact program leaves editions unmeasured when the generator produced none", () => {
  for (const rawFiles of [{}, { "ir-editions-raw/test262-editions.json": [] }]) {
    const artifact = runArtifactProgram(rawFiles);
    assert.ok(artifact("ir-measurement/ir/runs/standalone-index.json"));
    for (const file of [
      "test262-standalone-editions.json",
      "runs/standalone-editions-index.json",
      "test262-category-editions.json",
      "test262-file-editions.json",
    ])
      assert.equal(artifact(`ir-measurement/ir/${file}`), undefined);
  }
});
test("IR merge classifies editions with the regular lane's generators, outside the artifact", () => {
  const merge = workflow.slice(workflow.indexOf("  merge-ir-measurement:"), workflow.indexOf("\n  test262-shard:"));
  const step = merge.slice(
    merge.indexOf("      - name: Classify the IR results by ES edition"),
    merge.indexOf("      - name: Record separate status and run history"),
  );
  assert.match(step, /scripts\/generate-editions\.ts[\s\\]+--results ir-measurement\/results\.jsonl/);
  // The `test262-editions.json` basename is what makes the generator write the two maps beside it.
  assert.match(step, /--output ir-editions-raw\/test262-editions\.json[\s\\]+--host-free --no-feature-examples/);
  assert.match(step, /scripts\/append-run-history\.mjs --runs-dir ir-editions-raw\/runs/);
  assert.match(step, /--standalone-editions ir-editions-raw\/test262-editions\.json/);
  assert.match(step, /if: env\.SCOPE == 'full'/);
  assert.match(
    merge,
    /name: \$\{\{ needs\.compiler-path-measurement-plan\.outputs\.artifact \}\}\n\s+path: ir-measurement\n/,
  );
});
test("IR merge keeps the site-facing reports to the full scope and gates the edition scope per test", () => {
  const merge = workflow.slice(workflow.indexOf("  merge-ir-measurement:"), workflow.indexOf("\n  test262-shard:"));
  const step = (name) => {
    const start = merge.indexOf(`      - name: ${name}`);
    assert.ok(start >= 0, `missing step ${name}`);
    const next = merge.indexOf("\n      - ", start + 1);
    return merge.slice(start, next < 0 ? undefined : next);
  };
  for (const name of [
    "Build requested IR report including compiler failures",
    "Classify the IR results by ES edition",
    "Record separate status and run history",
  ])
    assert.match(step(name), /if: env\.SCOPE == 'full'/);
  const fetch = step("Download the nearest earlier IR measurement (#7551)");
  assert.match(fetch, /fetch-baseline \\\s+--from "\$FROM" --meta ir-measurement\/scope\.json --dest ir-baseline/);
  // The queue diffs against the commit its group was built on; a push against its parent.
  assert.match(
    fetch,
    /FROM: \$\{\{ github\.event_name == 'merge_group' && github\.event\.merge_group\.base_sha \|\| 'HEAD\^' \}\}/,
  );
  const report = step("Report the edition against that baseline (#7551)");
  assert.match(report, /--baseline-dir ir-baseline/);
  assert.match(report, /GITHUB_STEP_SUMMARY/);
  // The failure comes after the upload, so a regressed commit still becomes the next baseline.
  const upload = merge.indexOf("      - uses: actions/upload-artifact@v6");
  const fail = merge.indexOf("      - name: Fail on an edition regression (#7551)");
  assert.ok(upload > 0 && fail > upload);
  // Only exit 3 WITH a written report is a regression; any other non-zero exit
  // is a crash, failed under an "[infra]" step so auto-park does not park it.
  assert.match(
    step("Fail on an edition regression (#7551)"),
    /steps\.edition_report\.outputs\.verdict == 'regression'/,
  );
  assert.match(
    report,
    /if \[ "\$code" = 3 \] && \[ -s ir-measurement\/edition-report\.json \]; then verdict=regression/,
  );
  assert.match(
    step("Edition report did not complete (#7551) [infra]"),
    /steps\.edition_report\.outputs\.verdict == 'crashed'/,
  );
  // A narrowed discovery cannot shrink an edition run unnoticed.
  assert.match(
    step("Validate every planned shard before reporting any verdict"),
    /--expected-paths-file "\$RUNNER_TEMP\/edition-paths\.txt"/,
  );
});
test("IR shards take their partition from the plan and filter to the edition only in edition scope", () => {
  const shard = workflow.slice(
    workflow.indexOf("  test262-ir-measurement-shard:"),
    workflow.indexOf("  merge-ir-measurement:"),
  );
  assert.match(shard, /chunk: \$\{\{ fromJSON\(needs\.compiler-path-measurement-plan\.outputs\.matrix\) \}\}/);
  assert.match(shard, /TEST262_CHUNK_TOTAL: \$\{\{ needs\.compiler-path-measurement-plan\.outputs\.chunks \}\}/);
  assert.match(
    shard,
    /max-parallel: \$\{\{ fromJSON\(needs\.compiler-path-measurement-plan\.outputs\.max_parallel\) \}\}/,
  );
  const select = shard.slice(shard.indexOf("      - name: Select the current edition's tests"));
  assert.match(select, /if: needs\.compiler-path-measurement-plan\.outputs\.scope == 'edition'/);
  assert.match(select, /TEST262_PATH_FILTER_FILE=/);
  assert.ok(shard.indexOf("Select the current edition's tests") < shard.indexOf("      - name: Run shard"));
});
// main's first-parent line, newest first: "head" landed after the full run's "source", "older" before it.
const MAIN_LINE = ["head", "source", "older"];
const producerJob = { name: "merge complete IR standalone measurement", status: "completed", conclusion: "success" };
// A run id encodes its commit: run 42 measured "source"; an edition run `${sha}-run` measured `sha`.
const runSha = (runId) => (runId === "42" ? "source" : runId.replace(/-run$/, ""));
const editionArtifact = (id, sha, created_at = "2026-11-27T12:00:00Z") => ({
  id,
  expired: false,
  created_at,
  workflow_run: { id: `${sha}-run`, head_branch: `gh-readonly-queue/main/pr-1-${sha}`, head_sha: sha },
});
// What merge-ir-measurement writes for an edition run: rows of the edition, scope.json, the report.
function editionRunFiles(sha, { scope = {}, report = {}, rows } = {}) {
  const results = rows ?? [
    { file: "test/a.js", status: "pass" },
    { file: "test/b.js", status: "pass" },
    { file: "test/c.js", status: "compile_timeout" },
    { file: "test/d.js", status: "fail" },
  ];
  return {
    "scope.json": {
      compilerPath: "ir",
      target: "standalone",
      scope: "edition",
      edition: "ES5",
      sourceSha: sha,
      ...scope,
    },
    "edition-report.json": { edition: "ES5", sourceSha: sha, counts: { pass: 2, total: results.length }, ...report },
    "results.jsonl": results.map((row) => JSON.stringify(row)).join("\n") + "\n",
  };
}
const mainArtifact = (id) => ({
  id,
  expired: false,
  workflow_run: { id: "42", head_branch: "main", head_sha: "source" },
});
function retrieveMeasurements(artifacts, report = allCompileErrors, options = {}) {
  const fixture = memoryFiles();
  const commands = [];
  const warnings = [];
  const gh = (args) => {
    commands.push(["gh", ...args]);
    if (args[0] === "api") {
      const [path, query] = args[1].split("?");
      if (path.endsWith("/actions/artifacts"))
        return JSON.stringify({
          artifacts:
            new URLSearchParams(query).get("name") === IR_ARTIFACTS.full ? artifacts : (options.editionArtifacts ?? []),
        });
      if (path.endsWith("/jobs")) {
        const runId = path.split("/").at(-2);
        return JSON.stringify({ jobs: options.jobsOf?.(runId) ?? options.jobs ?? [producerJob] });
      }
      const runId = path.split("/").at(-1);
      return JSON.stringify({
        id: runId,
        name: "Test262 Sharded",
        status: "completed",
        conclusion: options.conclusion || "success",
        head_sha: runSha(runId),
        head_repository: { full_name: "owner/repo" },
      });
    }
    assert.deepEqual(Array.from(args.slice(0, 2)), ["run", "download"]);
    const dir = args.at(-1);
    if (args[args.indexOf("--name") + 1] === IR_ARTIFACTS.edition) {
      const sha = runSha(args[2]);
      for (const [file, payload] of Object.entries(options.editionRun?.(sha) ?? editionRunFiles(sha)))
        fixture.files.set(`${dir}/${file}`, typeof payload === "string" ? payload : JSON.stringify(payload));
      return "";
    }
    fixture.files.set(
      `${dir}/test262-standalone-ir-status.json`,
      JSON.stringify(
        options.status || {
          ...report,
          baseline_sha: "source",
          schema: "test262-compiler-path-status-v1",
          state: report.measurementState,
          ...(report.measurementState === "unavailable" ? { reason: "Actual strict compiler API is unavailable" } : {}),
        },
      ),
    );
    fixture.files.set(
      `${dir}/test262-standalone-ir-report.json`,
      JSON.stringify({ ...report, baseline_sha: "source" }),
    );
    fixture.files.set(
      `${dir}/ir/test262-standalone-categories.json`,
      JSON.stringify({ ...report, baseline_sha: "source", categories: [] }),
    );
    for (const [file, payload] of Object.entries(options.editionFiles?.(dir) ?? {}))
      fixture.files.set(`${dir}/ir/${file}`, JSON.stringify({ ...report, baseline_sha: "source", ...payload }));
    return "";
  };
  const git = (args) => {
    if (args[0] === "rev-list") return MAIN_LINE.join("\n") + "\n";
    assert.equal(args[0], "show");
    return JSON.stringify({ edition: options.configuredEdition ?? "ES5", chunks: 102 });
  };
  publishIrMeasurements({
    repository: "owner/repo",
    gh,
    git,
    fs: fixture.fs,
    warn: (message) => warnings.push(message),
  });
  return { ...fixture, commands, warnings };
}
test("Pages actual artifact bridge serves V0 all-fail IR and never mutates Git or dispatches", () => {
  const result = retrieveMeasurements([mainArtifact(100)]);
  assert.equal(
    JSON.parse(result.files.get("benchmarks/results/test262-standalone-ir-report.json")).compileErrorCases,
    3,
  );
  assert.equal(JSON.parse(result.files.get("benchmarks/results/ir/runs/standalone-index.json")).runs.length, 1);
  assert.ok(
    result.commands.every((command) => command[1] === "api" || (command[1] === "run" && command[2] === "download")),
  );
  assert.ok(!result.files.has("benchmarks/results/test262-report.json"));
});
const publishedEditionFiles = [
  "test262-standalone-editions.json",
  "test262-category-editions.json",
  "test262-file-editions.json",
  "runs/standalone-editions-index.json",
];
test("Pages publishes the latest IR editions and rebuilds their history across retained runs", () => {
  const result = retrieveMeasurements([mainArtifact(100), mainArtifact(200)], allCompileErrors, {
    editionFiles: (dir) => ({
      "test262-standalone-editions.json": { editions: rawEditions },
      "test262-category-editions.json": { data: {} },
      "test262-file-editions.json": { data: { editions: [], files: {} } },
      "runs/standalone-editions-index.json": { runs: [{ timestamp: dir, editions: [] }] },
    }),
  });
  const published = (file) => JSON.parse(result.files.get(`benchmarks/results/ir/${file}`));
  assert.deepEqual(published("test262-standalone-editions.json").editions, rawEditions);
  assert.equal(published("test262-standalone-editions.json").mode.target, "standalone");
  assert.ok(published("test262-category-editions.json").data);
  assert.ok(published("test262-file-editions.json").data.files);
  const history = published("runs/standalone-editions-index.json");
  assert.equal(history.compilerPath, "ir");
  assert.deepEqual(
    history.runs.map((run) => run.timestamp),
    [".ir-measurement-download/200", ".ir-measurement-download/100"],
  );
  assert.ok(history.runs.every((run) => run.runId === "42" && run.sourceSha === "source"));
});
test("Pages keeps one IR measurement per day, the newest", () => {
  const dated = (id, created_at) => ({ ...mainArtifact(id), created_at });
  const result = retrieveMeasurements([
    dated(100, "2026-11-15T09:00:00Z"),
    dated(200, "2026-11-16T09:00:00Z"),
    dated(300, "2026-11-16T12:00:00Z"),
  ]);
  const downloads = result.commands.filter((command) => command[1] === "run").map((command) => command.at(-1));
  assert.deepEqual(downloads, [".ir-measurement-download/300", ".ir-measurement-download/100"]);
  assert.equal(JSON.parse(result.files.get("benchmarks/results/ir/runs/standalone-index.json")).runs.length, 2);
});
test("Pages leaves IR editions absent when the retained measurement predates them", () => {
  const result = retrieveMeasurements([mainArtifact(100)]);
  assert.ok(result.files.has("benchmarks/results/ir/runs/standalone-index.json"));
  for (const file of publishedEditionFiles) assert.ok(!result.files.has(`benchmarks/results/ir/${file}`));
});
test("Pages refuses IR editions that belong to another source or runtime", () => {
  for (const payload of [
    { editions: rawEditions, baseline_sha: "other" },
    { editions: rawEditions, mode: { target: "gc" } },
    { baseline_sha: "source" },
  ])
    assert.throws(() =>
      retrieveMeasurements([mainArtifact(100)], allCompileErrors, {
        editionFiles: () => ({ "test262-standalone-editions.json": payload }),
      }),
    );
  assert.throws(() =>
    retrieveMeasurements([mainArtifact(100)], allCompileErrors, {
      editionFiles: () => ({ "runs/standalone-editions-index.json": { runs: [], baseline_sha: "other" } }),
    }),
  );
});
test("Pages publishes no IR editions for an unavailable measurement", () => {
  const result = retrieveMeasurements(
    [mainArtifact(100)],
    { ...allCompileErrors, measurementState: "unavailable", attemptedCases: 0 },
    { editionFiles: () => ({ "test262-standalone-editions.json": { editions: rawEditions } }) },
  );
  for (const file of publishedEditionFiles) assert.ok(!result.files.has(`benchmarks/results/ir/${file}`));
});
test("Pages missing/expired/fork measurement stays unavailable without legacy fallback", () => {
  const result = retrieveMeasurements([
    { id: 1, expired: true },
    { id: 2, expired: false, workflow_run: { id: 3, head_branch: "feature" } },
  ]);
  const status = JSON.parse(result.files.get("benchmarks/results/test262-standalone-ir-status.json"));
  assert.equal(status.state, "unavailable");
  assert.ok(!result.files.has("benchmarks/results/test262-standalone-ir-report.json"));
  assert.ok(!result.commands.some((command) => command[1] === "run"));
});
test("Pages bridge rejects a Host report in the standalone artifact", () => {
  assert.throws(() => retrieveMeasurements([mainArtifact(100)], measured));
});

test("explicit unavailable status suppresses an older IR score instead of serving fallback", () =>
  check(
    { "test262-standalone-ir-status.json": unavailable, "test262-standalone-ir-report.json": allCompileErrors },
    false,
    ["test262-standalone-ir-status.json"],
  ));
test("IR shards keep the actual dynamic full-corpus harness and completion boundary", () => {
  const measurement = workflow.slice(
    workflow.indexOf("  test262-ir-measurement-shard:"),
    workflow.indexOf("  merge-ir-measurement:"),
  );
  const legacy = workflow.slice(workflow.indexOf("  test262-shard:"), workflow.indexOf("  test262-shard-mg:"));
  const body = (block) =>
    block.slice(block.indexOf("      - name: Run shard"), block.indexOf("      - name: Upload shard artifacts")).trim();
  assert.equal(body(measurement), body(legacy));
  assert.match(measurement, /needs: \[compiler-path-measurement-plan\]/);
  assert.match(measurement, /TEST262_ORACLE_MODE: honest/);
  assert.match(measurement, /TEST262_PATH_FILTER: ""/);
  assert.doesNotMatch(measurement, /Download compiled|Download selected|prewarm|--require-cache/);
  assert.match(measurement, /--external:typescript7 --external:typescript7\/\*/);
  for (const name of ["test262-canary.yml", "test262-differential.yml"]) {
    const retired = fs.readFileSync(join(workflowRoot, ".github/workflows", name), "utf8").split("jobs:\n")[1];
    const jobs = retired.match(/^  [\w-]+:\n    if: false # JS-host Test262 measurement retired/gm) || [];
    assert.equal(jobs.length, name === "test262-canary.yml" ? 2 : 7);
  }
});

test("IR merge validates each shard manifest as its own --manifest", () => {
  // 2026-10-26: the merge wrote all 102 manifests into one JSON array and passed
  // that file once; the validator read it as a single malformed manifest
  // ("Expected 102 shard manifests but found 1") and the scheduled measurement
  // never published. Pass the per-shard files, as the other lanes do.
  const merge = workflow.slice(workflow.indexOf("  merge-ir-measurement:"));
  const validate = merge.slice(0, merge.indexOf("      - name: Build requested IR report"));
  assert.match(validate, /for manifest in ir-shards\/\*\.complete\.json; do\s+manifests\+=\(--manifest "\$manifest"\)/);
  assert.match(validate, /"\$\{manifests\[@\]\}" --expected-shards "\$EXPECTED_SHARDS"/);
  assert.match(validate, /EXPECTED_SHARDS: \$\{\{ needs\.compiler-path-measurement-plan\.outputs\.chunks \}\}/);
  assert.doesNotMatch(validate, /completion\.json'?, JSON\.stringify\(files\.map/);
});

test("complete IR producer publishes even when an unrelated workflow job failed", () => {
  const result = retrieveMeasurements([mainArtifact(100)], allCompileErrors, { conclusion: "failure" });
  assert.equal(
    JSON.parse(result.files.get("benchmarks/results/test262-standalone-ir-report.json")).compileErrorCases,
    3,
  );
});
test("a failed or missing IR producer cannot publish an artifact as a complete measurement", () => {
  for (const jobs of [
    [],
    [{ name: "merge complete IR standalone measurement", status: "completed", conclusion: "failure" }],
  ]) {
    const result = retrieveMeasurements([mainArtifact(100)], allCompileErrors, { jobs });
    assert.equal(
      JSON.parse(result.files.get("benchmarks/results/test262-standalone-ir-status.json")).state,
      "unavailable",
    );
    assert.ok(!result.commands.some((command) => command[1] === "run"));
  }
});

test("actual unavailable artifact keeps the original transport reason without a score or history", () => {
  const report = { ...allCompileErrors, measurementState: "unavailable", attemptedCases: 0 };
  const originalError = "PREPARED_TRANSPORT_INVALID: native kernel constructor unavailable";
  const fixture = memoryFiles({
    "ir-measurement/test262-standalone-ir-report.json": report,
    "ir-measurement/results.jsonl":
      JSON.stringify({ compilerPathFailureKind: "transport", error: originalError }) + "\n",
  });
  const snippet = program(workflow, "IR_MEASUREMENT_ARTIFACTS").replace(
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const { readFileSync, writeFileSync } = fs;",
  );
  vm.runInNewContext(snippet, {
    fs: fixture.fs,
    process: { env: { RUN_ID: "12", RUN_ATTEMPT: "1", SOURCE_SHA: "source" } },
  });
  const status = JSON.parse(fixture.files.get("ir-measurement/test262-standalone-ir-status.json"));
  assert.equal(status.state, "unavailable");
  assert.equal(status.reason, originalError);
  assert.equal(status.verifiedExecutionCases, 0);
  assert.ok(!fixture.files.has("ir-measurement/ir/runs/standalone-index.json"));
  assert.ok(!fixture.files.has("ir-measurement/ir/test262-standalone-categories.json"));
  assert.deepEqual(JSON.parse(fixture.files.get("ir-measurement/test262-standalone-ir-report.json")), report);
});
test("Pages publishes an explicit unavailable status, not an unavailable score or history", () => {
  const result = retrieveMeasurements([mainArtifact(100)], {
    ...allCompileErrors,
    measurementState: "unavailable",
    attemptedCases: 0,
  });
  assert.equal(
    JSON.parse(result.files.get("benchmarks/results/test262-standalone-ir-status.json")).reason,
    "Actual strict compiler API is unavailable",
  );
  assert.ok(!result.files.has("benchmarks/results/test262-standalone-ir-report.json"));
  assert.ok(!result.files.has("benchmarks/results/ir/runs/standalone-index.json"));
});
test("Pages refuses an unavailable status whose actual result was measured", () => {
  assert.throws(() =>
    retrieveMeasurements([mainArtifact(100)], allCompileErrors, {
      status: { ...allCompileErrors, baseline_sha: "source", state: "unavailable", reason: "contradiction" },
    }),
  );
});
// #7616: the merge queue's current-edition measurement on the site.
const fullWithEditions = (dir) => ({
  "test262-standalone-editions.json": { editions: rawEditions },
  "runs/standalone-editions-index.json": {
    runs: [{ timestamp: dir, editions: [] }],
  },
});
const publishedRows = (result) =>
  JSON.parse(result.files.get("benchmarks/results/ir/test262-standalone-editions.json")).editions;
const publishedHistory = (result) =>
  JSON.parse(result.files.get("benchmarks/results/ir/runs/standalone-editions-index.json")).runs;
test("a landed merge newer than the full run supplies the current edition's row, with its own commit and date", () => {
  const result = retrieveMeasurements([mainArtifact(100)], allCompileErrors, {
    editionFiles: fullWithEditions,
    editionArtifacts: [editionArtifact(500, "head")],
  });
  const [es5, es2015] = publishedRows(result);
  // Counted as generate-editions counts: compile_timeout is a compile error.
  assert.deepEqual(es5, {
    edition: "ES5",
    pass: 2,
    fail: 1,
    ce: 1,
    skip: 0,
    total: 4,
    pct: 50,
    scope: "edition",
    sourceSha: "head",
    measuredAt: "2026-11-27T12:00:00Z",
    runId: "head-run",
  });
  // The other editions stay the full run's, whose identity the envelope keeps.
  assert.deepEqual(es2015, rawEditions[1]);
  const envelope = JSON.parse(result.files.get("benchmarks/results/ir/test262-standalone-editions.json"));
  assert.equal(envelope.baseline_sha, "source");
  // The full-corpus score is never the edition run's.
  assert.equal(
    JSON.parse(result.files.get("benchmarks/results/test262-standalone-ir-report.json")).baseline_sha,
    "source",
  );
  const point = publishedHistory(result).find((run) => run.scope === "edition");
  assert.deepEqual(point.editions, [{ edition: "ES5", pass: 2, total: 4 }]);
  assert.equal(point.sourceSha, "head");
});
test("a queue group that never landed on main is not shown, and not even downloaded", () => {
  const result = retrieveMeasurements([mainArtifact(100)], allCompileErrors, {
    editionFiles: fullWithEditions,
    editionArtifacts: [editionArtifact(500, "ejected")],
  });
  assert.deepEqual(publishedRows(result), rawEditions);
  assert.ok(publishedHistory(result).every((run) => run.scope !== "edition"));
  assert.ok(!result.commands.some((command) => command.includes("ejected-run")));
});
test("an edition measurement older than the full run never overrides it, but stays in the history", () => {
  const result = retrieveMeasurements([mainArtifact(100)], allCompileErrors, {
    editionFiles: fullWithEditions,
    editionArtifacts: [editionArtifact(500, "older", "2026-11-28T12:00:00Z")],
  });
  assert.deepEqual(publishedRows(result), rawEditions);
  assert.deepEqual(
    publishedHistory(result)
      .filter((run) => run.scope === "edition")
      .map((run) => run.sourceSha),
    ["older"],
  );
});
test("the newest landed commit wins, whatever the upload order", () => {
  const result = retrieveMeasurements([mainArtifact(100)], allCompileErrors, {
    editionFiles: fullWithEditions,
    // The group of "head" uploaded first; a run of the earlier commit uploaded later the same day.
    editionArtifacts: [editionArtifact(600, "older"), editionArtifact(500, "head")],
  });
  assert.equal(publishedRows(result)[0].sourceSha, "head");
});
test("a wrong-edition, wrong-commit, non-IR or contradictory edition artifact is refused with a warning", () => {
  for (const [label, editionRun, configuredEdition] of [
    ["edition configured at that commit", () => editionRunFiles("head"), "ES2015"],
    ["scope edition", () => editionRunFiles("head", { scope: { edition: "ES2015" } }), undefined],
    ["scope commit", () => editionRunFiles("head", { scope: { sourceSha: "source" } }), undefined],
    ["report commit", () => editionRunFiles("head", { report: { sourceSha: "older" } }), undefined],
    ["report edition", () => editionRunFiles("head", { report: { edition: "ES2015" } }), undefined],
    ["compiler path", () => editionRunFiles("head", { scope: { compilerPath: "legacy" } }), undefined],
    ["target", () => editionRunFiles("head", { scope: { target: "gc" } }), undefined],
    ["scope.json predating #7616", () => editionRunFiles("head", { scope: { compilerPath: undefined } }), undefined],
    ["full-scope measurement", () => editionRunFiles("head", { scope: { scope: "full" } }), undefined],
    ["row count", () => editionRunFiles("head", { report: { counts: { pass: 2, total: 9 } } }), undefined],
  ]) {
    const result = retrieveMeasurements([mainArtifact(100)], allCompileErrors, {
      editionFiles: fullWithEditions,
      editionArtifacts: [editionArtifact(500, "head")],
      editionRun,
      configuredEdition,
    });
    assert.deepEqual(publishedRows(result), rawEditions, label);
    assert.ok(
      publishedHistory(result).every((run) => run.scope !== "edition"),
      label,
    );
    assert.equal(result.warnings.length, 1, label);
  }
});
test("an edition run whose producer job failed (a regression) is not shown", () => {
  const result = retrieveMeasurements([mainArtifact(100)], allCompileErrors, {
    editionFiles: fullWithEditions,
    editionArtifacts: [editionArtifact(500, "head")],
    jobsOf: (runId) => (runId === "head-run" ? [{ ...producerJob, conclusion: "failure" }] : undefined),
  });
  assert.deepEqual(publishedRows(result), rawEditions);
});
test("an edition run is never published without a measured full run", () => {
  const result = retrieveMeasurements([], allCompileErrors, {
    editionArtifacts: [editionArtifact(500, "head")],
  });
  assert.equal(
    JSON.parse(result.files.get("benchmarks/results/test262-standalone-ir-status.json")).state,
    "unavailable",
  );
  assert.ok(!result.files.has("benchmarks/results/test262-standalone-ir-report.json"));
  assert.ok(!result.files.has("benchmarks/results/ir/test262-standalone-editions.json"));
});
test("the edition history keeps the newest edition measurement of each day", () => {
  const result = retrieveMeasurements([mainArtifact(100)], allCompileErrors, {
    editionFiles: fullWithEditions,
    editionArtifacts: [
      editionArtifact(500, "head", "2026-11-27T10:00:00Z"),
      editionArtifact(400, "older", "2026-11-27T09:00:00Z"),
    ],
  });
  assert.deepEqual(
    publishedHistory(result)
      .filter((run) => run.scope === "edition")
      .map((run) => run.sourceSha),
    ["head"],
  );
});
test("the deploy publishes through the measurement script", () => {
  assert.match(pagesWorkflow, /run: node scripts\/test262-ir-site-measurements\.mjs\n/);
});
