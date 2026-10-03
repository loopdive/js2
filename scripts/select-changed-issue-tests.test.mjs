// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Synthetic selector/workflow controls only: no compiler or real Git repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selector = join(repository, "scripts/select-changed-issue-tests.mjs");
const workflow = readFileSync(join(repository, ".github/workflows/ci.yml"), "utf8");
const pinned = [
  "tests/issue-3529-selector-preclaim.test.ts",
  "tests/ir/fnctor-abi.test.ts",
  "tests/ir/fnctor-admission.test.ts",
  "tests/ir/fnctor-argument-projection.test.ts",
  "tests/ir/fnctor-producer.test.ts",
  "tests/ir/inline-small.test.ts",
  "tests/ir/phase3c.test.ts",
  "tests/illegal-cast-closures-585.test.ts",
  "tests/issue-1058-function-hoist-facts.test.ts",
  "tests/issue-1128-dstr-tdz.test.ts",
  "tests/issue-1528-closure-construct.test.ts",
  "tests/issue-1712-capture-closure-dispatch.test.ts",
  "tests/issue-2637-b2-ctor-closure-registration.test.ts",
  "tests/issue-3036-late-microtask-closure.test.ts",
  "tests/issue-3520-closure-host-bridge-abi.test.ts",
  "tests/issue-6419-closure-area-red-on-main.test.ts",
];
const fixtureParent = join(repository, ".tmp/ci-file-shards");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

function fixture(action) {
  mkdirSync(fixtureParent, { recursive: true });
  const directory = mkdtempSync(join(fixtureParent, "selector-fixture-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const driver = join(directory, "fake-git.mjs");
  writeFileSync(
    driver,
    `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.GIT_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "merge-base") {
  if (process.env.MOCK_MERGE_FAIL === "true") process.exit(1);
  process.stdout.write("mock-merge-base\\n");
} else if (args[0] === "diff") {
  if (process.env.MOCK_DIFF_FAIL === "true") process.exit(1);
  process.stdout.write(process.env.MOCK_CHANGED ?? "");
} else process.exit(2);
`,
  );
  const git = join(bin, "git");
  writeFileSync(git, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(driver)} "$@"\n`);
  chmodSync(git, 0o755);
  const callsPath = join(directory, "git-calls.jsonl");
  writeFileSync(callsPath, "");
  const create = (file) => {
    const target = join(directory, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "// synthetic test path\n");
  };
  const run = (args, changed = [], env = {}) =>
    spawnSync(process.execPath, [selector, ...args], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PR_BASE_SHA: "",
        MERGE_GROUP_BASE_SHA: "",
        PATH: bin + ":" + process.env.PATH,
        GIT_CALLS: callsPath,
        MOCK_CHANGED: changed.join("\n") + (changed.length ? "\n" : ""),
        MOCK_MERGE_FAIL: "",
        MOCK_DIFF_FAIL: "",
        ...env,
      },
    });
  const calls = () =>
    readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  try {
    action({ create, run, calls, directory });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  return result.stdout;
}

function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, name);
  const remainder = workflow.slice(start + 1);
  const next = /\n  [a-z][a-z0-9-]*:\n/.exec(remainder);
  return next ? remainder.slice(0, next.index) : remainder;
}
function inlineNode(jobName, stepName) {
  const text = job(jobName);
  const start = text.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(start, -1, stepName);
  const match = /node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/.exec(text.slice(start));
  assert.ok(match, stepName);
  return match[1]
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
}
const aggregate = inlineNode("issue-tests", "Verify issue-test jobs completed");
function aggregateResult(overrides = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", aggregate], {
    encoding: "utf8",
    env: {
      ...process.env,
      CHANGES_RESULT: "success",
      CHANGES_CODE: "true",
      PINNED_RESULT: "success",
      DISCOVERY_RESULT: "success",
      CHANGED_RESULT: "success",
      SELECTED_FILES: '["tests/issue-synthetic.test.ts"]',
      SELECTED_COUNT: "1",
      ...overrides,
    },
  });
}

test("legacy lines and JSON retain exact regex families, pinned exclusion, existence, deduplication and order", () =>
  fixture(({ create, run, calls }) => {
    const changed = [
      "tests/issue-z.test.ts",
      "tests/ir/a.test.ts",
      pinned[0],
      "tests/issue-z.test.ts",
      "tests/issue-removed.test.ts",
      "tests/issue-nested/a.test.ts",
      "tests/other.test.ts",
    ];
    changed.filter((file) => file !== "tests/issue-removed.test.ts").forEach(create);
    const expected = ["tests/ir/a.test.ts", "tests/issue-z.test.ts"];
    assert.equal(success(run(["--changed", "--base", "explicit"], changed)), expected.join("\n") + "\n");
    assert.deepEqual(
      JSON.parse(success(run(["--changed", "--base", "explicit", "--strict", "--json"], changed))),
      expected,
    );
    assert.deepEqual(calls(), Array(2).fill(["diff", "--name-only", "--diff-filter=d", "explicit...HEAD"]));
  }));

test("default cap keeps the first 15 sorted paths and explicit cap keeps the same prefix", () =>
  fixture(({ create, run }) => {
    const changed = Array.from({ length: 20 }, (_, i) => `tests/issue-${String(i).padStart(2, "0")}.test.ts`).reverse();
    changed.forEach(create);
    const sorted = [...changed].sort();
    assert.deepEqual(JSON.parse(success(run(["--changed", "--strict", "--json"], changed))), sorted.slice(0, 15));
    assert.equal(success(run(["--changed"], changed)), sorted.slice(0, 15).join("\n") + "\n");
    assert.deepEqual(
      JSON.parse(success(run(["--changed", "--strict", "--json", "--max", "3"], changed))),
      sorted.slice(0, 3),
    );
  }));

test("pinned order/population stays literal and does not consult Git", () =>
  fixture(({ create, run, calls }) => {
    pinned.forEach(create);
    assert.equal(success(run(["--pinned"])), pinned.join("\n") + "\n");
    assert.deepEqual(JSON.parse(success(run(["--pinned", "--json"]))), pinned);
    assert.deepEqual(calls(), []);
  }));

test("genuine empty selection has empty legacy lines and a validated JSON empty array", () =>
  fixture(({ run }) => {
    assert.equal(success(run(["--changed"])), "");
    assert.deepEqual(JSON.parse(success(run(["--changed", "--strict", "--json"]))), []);
  }));

for (const [label, args, env, expected] of [
  ["explicit base", ["--base", "explicit"], { PR_BASE_SHA: "pr", MERGE_GROUP_BASE_SHA: "merge" }, "explicit"],
  ["PR base", [], { PR_BASE_SHA: "pr", MERGE_GROUP_BASE_SHA: "merge" }, "pr"],
  ["merge-group base", [], { MERGE_GROUP_BASE_SHA: "merge" }, "merge"],
  ["push merge-base", [], {}, "mock-merge-base"],
  ["push HEAD^ fallback", [], { MOCK_MERGE_FAIL: "true" }, "HEAD^"],
])
  test(`base precedence preserves ${label}`, () =>
    fixture(({ run, calls }) => {
      success(run(["--changed", "--strict", "--json", ...args], [], env));
      const actual = calls();
      assert.deepEqual(actual.at(-1), ["diff", "--name-only", "--diff-filter=d", `${expected}...HEAD`]);
      assert.equal(actual.length, expected === "mock-merge-base" || expected === "HEAD^" ? 2 : 1);
    }));

for (const [label, args, env] of [
  ["unavailable explicit base", ["--base", "bad-base"], { MOCK_DIFF_FAIL: "true" }],
  ["unavailable fallback base", [], { MOCK_MERGE_FAIL: "true", MOCK_DIFF_FAIL: "true" }],
])
  test(`strict ${label} refuses false-empty; legacy behavior stays unchanged`, () =>
    fixture(({ run }) => {
      const strict = run(["--changed", "--strict", "--json", ...args], [], env);
      assert.notEqual(strict.status, 0);
      assert.equal(strict.stdout, "");
      assert.match(strict.stderr, /diff against .* failed/);
      assert.equal(success(run(["--changed", ...args], [], env)), "");
    }));

for (const value of ["bad", "-1", "1.5", "", "Infinity"])
  test(`strict invalid cap ${JSON.stringify(value)} fails without changing legacy CLI`, () =>
    fixture(({ run }) => {
      assert.equal(run(["--changed", "--strict", "--json", "--max", value]).status, 2);
      success(run(["--changed", "--max", value]));
    }));
test("strict missing cap fails and explicit zero remains a real empty selection", () =>
  fixture(({ run }) => {
    assert.equal(run(["--changed", "--strict", "--max"]).status, 2);
    assert.deepEqual(JSON.parse(success(run(["--changed", "--strict", "--json", "--max", "0"]))), []);
  }));

test("workflow keeps fatal pins, exact per-file flags/heaps, isolated checkout, timeout and step-only advisory policy", () => {
  const fatal = job("issue-tests-pinned"),
    changed = job("issue-tests-changed"),
    select = job("issue-tests-select"),
    gate = job("issue-tests");
  assert.match(fatal, /VITEST_FORK_MAX_OLD_SPACE_SIZE: "1024"/);
  assert.match(fatal, /--pinned > \/tmp\/issue-tests-pinned\.txt/);
  assert.match(
    fatal,
    /pnpm exec vitest run "\$\{FILES\[@\]\}" \\\n\s+--pool=forks --poolOptions\.forks\.singleFork=true --no-file-parallelism/,
  );
  assert.doesNotMatch(fatal, /continue-on-error/);
  assert.match(select, /fetch-depth: 0/);
  assert.match(select, /--changed --strict --json/);
  assert.doesNotMatch(select, /continue-on-error|\|\| true/);
  assert.match(select, /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(select, /MERGE_GROUP_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/);
  assert.doesNotMatch(select, /github\.event\.before/);
  assert.match(changed, /fail-fast: false/);
  assert.match(changed, /max-parallel: 15/);
  assert.match(changed, /VITEST_FORK_MAX_OLD_SPACE_SIZE: "4096"/);
  assert.match(changed, /actions\/checkout@v5/);
  assert.match(changed, /pnpm install --frozen-lockfile/);
  assert.match(changed, /matrix: \$\{\{ fromJSON\(needs\.issue-tests-select\.outputs\.matrix\) \}\}/);
  assert.match(changed, /outputs\.count != '0'/);
  assert.match(
    changed,
    /pnpm exec vitest run "\$ISSUE_TEST_FILE" \\\n\s+--pool=forks --poolOptions\.forks\.singleFork=false \\\n\s+--poolOptions\.forks\.maxForks=1 --no-file-parallelism/,
  );
  assert.equal((changed.match(/continue-on-error: true/g) ?? []).length, 1);
  assert.match(changed, /id: tests\n        continue-on-error: true/);
  assert.match(changed, /TEST_OUTCOME: \$\{\{ steps\.tests\.outcome \}\}/);
  assert.match(changed, /\*\) echo "::error::Changed issue test did not execute"; exit 1/);
  for (const text of [fatal, select, changed, gate]) assert.match(text, /timeout-minutes: 40/);
  assert.match(gate, /needs: \[changes, issue-tests-pinned, issue-tests-select, issue-tests-changed\]/);
  assert.match(
    gate,
    /if: always\(\) && \(needs\.changes\.result != 'success' \|\| needs\.changes\.outputs\.code != 'false'\)/,
  );
});

test("actual inline aggregate accepts completed jobs, including advisory Vitest failure", () => {
  // A completed nonzero advisory step leaves its matrix job successful; its raw
  // failure remains visible in steps.tests.outcome and the reporting step above.
  success(aggregateResult());
});
test("actual inline aggregate accepts only validated zero selection with skipped matrix", () => {
  success(aggregateResult({ SELECTED_FILES: "[]", SELECTED_COUNT: "0", CHANGED_RESULT: "skipped" }));
});
for (const [label, env] of [
  ["changed setup failure", { CHANGED_RESULT: "failure" }],
  ["changed timeout/cancellation", { CHANGED_RESULT: "cancelled" }],
  ["positive-count matrix skipped", { CHANGED_RESULT: "skipped" }],
  ["positive-count matrix missing", { CHANGED_RESULT: "" }],
  ["empty successful matrix", { SELECTED_FILES: "[]", SELECTED_COUNT: "0", CHANGED_RESULT: "success" }],
  ["pinned failure", { PINNED_RESULT: "failure" }],
  ["pinned cancellation", { PINNED_RESULT: "cancelled" }],
  ["pinned skip", { PINNED_RESULT: "skipped" }],
  ["discovery failure", { DISCOVERY_RESULT: "failure" }],
  ["discovery cancellation", { DISCOVERY_RESULT: "cancelled" }],
  ["discovery skip", { DISCOVERY_RESULT: "skipped" }],
  ["failed changes", { CHANGES_RESULT: "failure", CHANGES_CODE: "" }],
  ["unknown classification", { CHANGES_CODE: "" }],
  ["missing discovery output", { SELECTED_FILES: "", SELECTED_COUNT: "" }],
  ["count mismatch", { SELECTED_COUNT: "0" }],
  ["duplicate paths", { SELECTED_FILES: '["tests/issue-a.test.ts","tests/issue-a.test.ts"]', SELECTED_COUNT: "2" }],
  ["invalid path", { SELECTED_FILES: '["src/compiler.ts"]' }],
])
  test(`actual inline aggregate refuses ${label}`, () => assert.notEqual(aggregateResult(env).status, 0));

const discovery = inlineNode("issue-tests-select", "Select changed issue test files");
const membership = inlineNode("issue-tests-changed", "Validate selected file manifest");
function discoveryResult(directory, value) {
  const input = join(directory, "selection.json"),
    output = join(directory, "github-output.txt");
  writeFileSync(input, JSON.stringify(value));
  writeFileSync(output, "");
  const script = discovery.replace('"/tmp/issue-tests-changed.json"', JSON.stringify(input));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  return { ...result, output: readFileSync(output, "utf8") };
}

test("actual discovery publishes the same ordered paths with contiguous per-file ordinals", () =>
  fixture(({ create, run, directory }) => {
    const expected = ["tests/ir/a.test.ts", "tests/issue-b.test.ts"];
    expected.forEach(create);
    const files = JSON.parse(success(run(["--changed", "--strict", "--json"], [...expected].reverse())));
    const result = discoveryResult(directory, files);
    success(result);
    const output = Object.fromEntries(
      result.output
        .trim()
        .split("\n")
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    assert.deepEqual(JSON.parse(output.files), expected);
    assert.equal(output.count, "2");
    assert.deepEqual(JSON.parse(output.matrix), { include: expected.map((file, ordinal) => ({ ordinal, file })) });
    for (const [ordinal, file] of expected.entries()) {
      success(
        spawnSync(process.execPath, ["--input-type=module", "-e", membership], {
          cwd: directory,
          encoding: "utf8",
          env: {
            ...process.env,
            SELECTED_FILES: output.files,
            ISSUE_TEST_FILE: file,
            ISSUE_TEST_ORDINAL: String(ordinal),
          },
        }),
      );
    }
  }));
test("actual discovery publishes authoritative zero/empty matrix, without a test placeholder", () =>
  fixture(({ directory }) => {
    const result = discoveryResult(directory, []);
    success(result);
    assert.equal(result.output, 'files=[]\ncount=0\nmatrix={"include":[]}\n');
  }));
for (const [label, value] of [
  ["non-array", { include: [] }],
  ["missing path", ["tests/issue-missing.test.ts"]],
  ["duplicate", ["tests/issue-a.test.ts", "tests/issue-a.test.ts"]],
  ["unsorted", ["tests/issue-b.test.ts", "tests/issue-a.test.ts"]],
  ["non-string", [3]],
  ["invalid family", ["tests/other.test.ts"]],
  ["over cap", Array.from({ length: 16 }, (_, i) => `tests/issue-${i}.test.ts`)],
])
  test(`actual discovery rejects ${label} without success-shaped outputs`, () =>
    fixture(({ create, directory }) => {
      create("tests/issue-a.test.ts");
      create("tests/issue-b.test.ts");
      const result = discoveryResult(directory, value);
      assert.notEqual(result.status, 0);
      assert.equal(result.output, "");
    }));
for (const [label, ordinal, file] of [
  ["ordinal mismatch", "1", "tests/issue-a.test.ts"],
  ["different file", "0", "tests/issue-b.test.ts"],
  ["missing ordinal", "", "tests/issue-a.test.ts"],
])
  test(`actual per-file membership rejects ${label}`, () =>
    fixture(({ create, directory }) => {
      create("tests/issue-a.test.ts");
      create("tests/issue-b.test.ts");
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", membership], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          SELECTED_FILES: '["tests/issue-a.test.ts"]',
          ISSUE_TEST_FILE: file,
          ISSUE_TEST_ORDINAL: ordinal,
        },
      });
      assert.notEqual(result.status, 0);
    }));

const report = job("issue-tests-changed")
  .split("      - name: Report changed issue-test outcome\n")[1]
  .split("        run: |\n")[1]
  .split("\n")
  .filter((line) => line.startsWith("          "))
  .map((line) => line.slice(10))
  .join("\n");
for (const [outcome, status] of [
  ["success", 0],
  ["failure", 0],
  ["skipped", 1],
  ["cancelled", 1],
  ["", 1],
]) {
  test(`actual outcome reporter preserves ${JSON.stringify(outcome)} status policy`, () => {
    const result = spawnSync("bash", ["-c", report], {
      encoding: "utf8",
      env: { ...process.env, TEST_OUTCOME: outcome, ISSUE_TEST_FILE: "tests/issue-synthetic.test.ts" },
    });
    assert.equal(result.status, status, result.stderr);
    if (outcome === "failure") assert.match(result.stdout, /::warning::.*advisory/);
  });
}
