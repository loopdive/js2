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

function check(input, expectedError = false) {
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
      assert.equal(copies.length, Object.keys(input).filter((file) => file !== "test262-report.json").length * 2);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const measured = { compilerPath: "ir", compilerPathVerified: true, executionCompilerPath: "ir" };
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
  check({ "test262-ir-report.json": measured, "test262-standalone-ir-report.json": measured }));
test("IR editions and history retain their isolated envelopes", () =>
  check({
    "ir/test262-editions.json": { ...measured, editions: [] },
    "ir/runs/index.json": { ...measured, runs: [] },
  }));
test("IR feature envelopes deploy for both lanes", () =>
  check({
    "ir/feature-examples.json": { ...measured, features: [] },
    "ir/feature-examples-standalone.json": { ...measured, features: [] },
  }));
test("legacy identity is rejected at an IR destination", () =>
  check({ "test262-ir-report.json": { ...measured, compilerPath: "legacy" } }, true));
test("a request without verification is rejected", () =>
  check({ "test262-ir-report.json": { ...measured, compilerPathVerified: false } }, true));
test("unknown execution cannot supply IR numbers", () =>
  check({ "test262-ir-report.json": { ...measured, executionCompilerPath: "unknown" } }, true));
test("unlabelled arrays are rejected", () => check({ "ir/test262-editions.json": [] }, true));
test("an unavailable status must explain its reason", () =>
  check({ "test262-ir-status.json": { ...unavailable, reason: "" } }, true));
