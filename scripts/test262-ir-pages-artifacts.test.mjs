import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import test from "node:test";

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

test("historical Host caption keeps the actual frozen date and revision", () => {
  assert.equal(
    view("?mode=host").historicalHostLabel({ baseline_sha: "old-revision", baseline_generated_at: "2026-09-01" }),
    "Historical JS Host · frozen results · source old-revision · 2026-09-01",
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
async function selectMeasurement(event, day, inputs = {}) {
  let output = "";
  let selected;
  const snippet = program(workflow, "IR_MEASUREMENT_PLAN").replace(
    "const { appendFileSync } = await import('node:fs');",
    "const { appendFileSync } = fs;",
  );
  const context = {
    process: { env: { EVENT_NAME: event, ...inputs } },
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
  assert.equal(output, `run=${selected.run}\n`);
  return selected;
}
test("automatic weekly plan has exactly the full IR standalone cell and never Host", async () => {
  for (let day = 0; day < 7; day++) {
    const selected = await selectMeasurement("schedule", day);
    assert.deepEqual(selected, {
      run: day === 1,
      cells: day === 1 ? [{ compilerPath: "ir", target: "standalone", chunks: 102 }] : [],
      promotion: false,
    });
  }
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
function retrieveMeasurements(artifacts, report = allCompileErrors, options = {}) {
  const fixture = memoryFiles();
  const commands = [];
  const execFileSync = (exe, args) => {
    commands.push([exe, ...args]);
    assert.equal(exe, "gh");
    if (args[0] === "api") {
      if (args[1].includes("/actions/artifacts?")) return JSON.stringify({ artifacts });
      if (args[1].includes("/jobs?"))
        return JSON.stringify({
          jobs: options.jobs ?? [
            { name: "merge complete IR standalone measurement", status: "completed", conclusion: "success" },
          ],
        });
      return JSON.stringify({
        id: 42,
        name: "Test262 Sharded",
        status: "completed",
        conclusion: options.conclusion || "success",
        head_sha: "source",
        head_repository: { full_name: "owner/repo" },
      });
    }
    assert.deepEqual(Array.from(args.slice(0, 2)), ["run", "download"]);
    const dir = args.at(-1);
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
    return "";
  };
  const snippet = program(pagesWorkflow, "IR_MEASUREMENT_FETCH")
    .replace("import { execFileSync } from 'node:child_process';", "const { execFileSync } = commands;")
    .replace(
      "import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';",
      "const { readFileSync, writeFileSync, mkdirSync, rmSync } = fs;",
    );
  vm.runInNewContext(snippet, {
    fs: fixture.fs,
    commands: { execFileSync },
    process: { env: { GITHUB_REPOSITORY: "owner/repo" } },
  });
  return { ...fixture, commands };
}
test("Pages actual artifact bridge serves V0 all-fail IR and never mutates Git or dispatches", () => {
  const result = retrieveMeasurements([{ id: 100, expired: false, workflow_run: { id: 42, head_branch: "main" } }]);
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
  assert.throws(() =>
    retrieveMeasurements([{ id: 100, expired: false, workflow_run: { id: 42, head_branch: "main" } }], measured),
  );
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

test("complete IR producer publishes even when an unrelated workflow job failed", () => {
  const result = retrieveMeasurements(
    [{ id: 100, expired: false, workflow_run: { id: 42, head_branch: "main" } }],
    allCompileErrors,
    { conclusion: "failure" },
  );
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
    const result = retrieveMeasurements(
      [{ id: 100, expired: false, workflow_run: { id: 42, head_branch: "main" } }],
      allCompileErrors,
      { jobs },
    );
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
  const result = retrieveMeasurements([{ id: 100, expired: false, workflow_run: { id: 42, head_branch: "main" } }], {
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
    retrieveMeasurements(
      [{ id: 100, expired: false, workflow_run: { id: 42, head_branch: "main" } }],
      allCompileErrors,
      { status: { ...allCompileErrors, baseline_sha: "source", state: "unavailable", reason: "contradiction" } },
    ),
  );
});
