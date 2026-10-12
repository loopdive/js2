import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseTest262CompilerPath,
  requireTest262CompilerPath,
  summarizeTest262CompilerPaths,
  test262RequestedCompilerPathMetadata,
  test262CacheDirectoryName,
  test262CompilerPathStatus,
} from "./test262-compiler-path.mjs";
import { test262ResultPrefix } from "./test262-lane.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("path selection accepts explicit routes and refuses misspellings", () => {
  assert.equal(parseTest262CompilerPath("legacy"), "legacy");
  assert.equal(parseTest262CompilerPath("ir"), "ir");
  assert.throws(() => parseTest262CompilerPath("IR"));
});

test("historical rows cannot be relabelled by a current legacy request", () => {
  const identity = summarizeTest262CompilerPaths([{ status: "pass" }], "legacy");
  assert.equal(identity.compilerPath, "unknown");
  assert.equal(identity.requestedCompilerPath, "legacy");
  assert.equal(identity.compilerPathVerified, false);
});

test("compatibility request records hybrid configuration without proving execution", () => {
  const identity = test262RequestedCompilerPathMetadata("legacy", "standalone");
  assert.equal(identity.configuredCompilerPath, "hybrid");
  assert.equal(identity.executionCompilerPath, "unknown");
  assert.equal(identity.compilerPathVerified, false);
  assert.equal(test262RequestedCompilerPathMetadata("legacy", "wasi").configuredCompilerPath, "hybrid");
  assert.equal(test262RequestedCompilerPathMetadata("legacy", "unrecognised").configuredCompilerPath, "unknown");
});

test("cache and artifact namespaces preserve the old lane and isolate IR", () => {
  assert.equal(test262CacheDirectoryName("legacy"), ".test262-cache");
  assert.equal(test262CacheDirectoryName("ir"), ".test262-cache-ir");
  assert.equal(test262ResultPrefix("standalone", "auto", "legacy"), "test262-standalone");
  assert.equal(test262ResultPrefix("standalone", "auto", "ir"), "test262-standalone-ir");
});

test("neither IR_FIRST nor caller supplied verified flags admit IR numbers", () => {
  assert.throws(() => requireTest262CompilerPath("ir"), { code: "ir-only-compiler-api-unavailable" });
  assert.throws(() => summarizeTest262CompilerPaths([{ compilerPath: "ir", compilerPathVerified: true }]));
  assert.throws(() => summarizeTest262CompilerPaths([{ compilerPath: "legacy", executionCompilerPath: "ir" }]));
  assert.throws(() => summarizeTest262CompilerPaths([{ executionCompilerPath: "garbage" }]));
});

test("mixed old and labelled rows stay mixed even when a duplicate would hide history", () => {
  const identity = summarizeTest262CompilerPaths([{ file: "x" }, { file: "x", compilerPath: "legacy" }]);
  assert.equal(identity.compilerPath, "mixed");
  assert.equal(identity.compilerPathVerified, false);
});

test("the CLI writes an unavailable status with no conformance counts", () => {
  const directory = mkdtempSync(join(tmpdir(), "test262-path-"));
  try {
    const status = join(directory, "test262-ir-status.json");
    const child = spawnSync(
      process.execPath,
      [join(root, "scripts/check-test262-compiler-path.mjs"), "--compiler-path", "ir", "--status", status],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 2);
    const data = JSON.parse(readFileSync(status, "utf8"));
    assert.equal(data.state, "unavailable");
    assert.equal(data.compilerPathVerified, false);
    assert.equal(Object.hasOwn(data, "summary"), false);
    assert.equal(Object.hasOwn(data, "total"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the real report builder preserves historical numbers as path unknown", () => {
  const directory = mkdtempSync(join(tmpdir(), "test262-path-report-"));
  try {
    const input = join(directory, "rows.jsonl");
    const output = join(directory, "report.json");
    writeFileSync(
      input,
      JSON.stringify({ file: "language/x.js", status: "pass", category: "language", scope: "standard" }) + "\n",
    );
    const child = spawnSync(
      process.execPath,
      [
        join(root, "scripts/build-test262-report.mjs"),
        "--input",
        input,
        "--output",
        output,
        "--target",
        "standalone",
        "--compiler-path",
        "legacy",
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    const data = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(data.summary.pass, 1);
    assert.equal(data.summary.total, 1);
    assert.equal(data.compilerPath, "unknown");
    assert.equal(data.compilerPathVerified, false);
    const categories = JSON.parse(readFileSync(join(directory, "test262-standalone-categories.json"), "utf8"));
    assert.equal(categories.compilerPath, data.compilerPath);
    assert.equal(categories.compilerPathVerified, false);
    assert.equal(categories.executionCompilerPath, "unknown");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("published unavailable states match the actual gate and contain no numbers", () => {
  for (const name of ["test262-ir-status.json", "test262-standalone-ir-status.json"]) {
    const status = JSON.parse(readFileSync(join(root, "benchmarks/results", name), "utf8"));
    assert.deepEqual(status, test262CompilerPathStatus("ir"));
    assert.equal(Object.hasOwn(status, "summary"), false);
  }
});
