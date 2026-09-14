// Bounded evidence wrapper; never substitutes a test or verdict.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (path) => JSON.parse(readFileSync(path));
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}
const mode = process.argv[2];
assert(["pre", "post"].includes(mode));
const observationTrace = process.env.REPLAY_OBSERVATION_TRACE === "1";
// Preserve the actual runner terminal before any post-run admission can fail.
const code = mode === "post" ? Number(process.argv[3]) : null;
if (mode === "post") {
  assert.equal(process.argv.length, 4);
  assert(Number.isInteger(code));
  save("replay5807-terminal.json", { code, head: process.env.REPLAY_HEAD });
}
assert([undefined, "1"].includes(process.env.REPLAY_OBSERVATION_TRACE), "unexpected trace mode");
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
assert.equal(process.version, "v25.9.0");
assert.equal(execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(), "10.30.2", "pinned package manager");
const controls = {
  COMPILER_POOL_SIZE: "4",
  VITEST_FORK_MAX_OLD_SPACE_SIZE: "1024",
  TEST262_WORKER_MAX_OLD_SPACE_SIZE: "1024",
  TEST262_INCLUDE_PROPOSALS: "1",
  TEST262_TARGET: "gc",
  TEST262_RESULT_PREFIX: "test262",
  TEST262_CHUNK_INDEX: "33",
  TEST262_CHUNK_TOTAL: "52",
  TEST262_PATH_FILTER: "",
  JS2WASM_IR_FIRST: "",
  JS2WASM_FNCTOR_LAYOUT_EMIT: "",
  JS2WASM_EVAL_ENGINE: "",
  TEST262_IT_TIMEOUT_MS: "",
  TEST262_FULL_RUNTIME_EVAL: "",
  JS2WASM_TEMPORAL_CACHE: ".test262-cache/temporal",
};
for (const [key, value] of Object.entries(controls)) assert.equal(process.env[key], value, key);
assert([undefined, "", "honest"].includes(process.env.TEST262_ORACLE_MODE), "unexpected oracle override");
assert([undefined, "", "auto"].includes(process.env.TEST262_SEMANTIC_PROVIDERS), "unexpected provider override");
assert([undefined, "recycle"].includes(process.env.TEST262_REALM_CANARY), "unexpected recycling override");
assert(
  ["129e3efd4530ae1be56dbf5fdea54ddbbd87443e", "efa0908e09998c73da592fba32708c7ecca8d6e5"].includes(
    process.env.REPLAY_HEAD,
  ),
);
assert.equal(git("rev-parse", "HEAD"), process.env.REPLAY_HEAD);
assert.equal(git("-C", "test262", "rev-parse", "HEAD"), "b363f29d3c43c626dc852744ad64a0b48a003693");
const inputs = ["src", "tests", "scripts", "package.json", "pnpm-lock.yaml", "tsconfig.json", "vitest.config.ts"];
let traceReceipt = null;
if (observationTrace && mode === "post") {
  const { verifyObservationTrace } = await import("./issue-5807-observation-trace.mjs");
  traceReceipt = verifyObservationTrace(process.cwd());
  assert(traceReceipt.modifiedPaths.length > 0, "trace patch census missing");
  const expected = [
    ...traceReceipt.modifiedPaths.map((path) => ` M ${path}`),
    ...traceReceipt.untrackedPaths.map((path) => `?? ${path}`),
  ].sort();
  const actual = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...inputs], {
    encoding: "utf8",
  })
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(actual, expected, "only exact verified observation patches may differ");
} else {
  assert.equal(
    git("status", "--porcelain", "--untracked-files=all", "--", ...inputs),
    "",
    "compiler/harness/config drift",
  );
}
assert.equal(git("-C", "test262", "status", "--porcelain", "--untracked-files=all"), "", "corpus drift");
const historicalFiles = files("historical-shard");
const manifests = historicalFiles.filter((p) => p.endsWith(".complete.json"));
assert.equal(manifests.length, 1, "one historical completion manifest");
const original = read(manifests[0]);
assert.equal(original.registeredPaths.length, 939);
assert.equal(new Set(original.registeredPaths).size, 939);
assert.equal(
  hash(JSON.stringify(original.registeredPaths)),
  "a96bc8efe43b6924c8d35af68d108a1ac1dd30a970d21212f8b0845971f5c737",
);
const census = original.registeredPaths.map((path) => {
  assert(path.startsWith("test/") && !path.split("/").includes(".."));
  return [path, hash(readFileSync(join("test262", path)))];
});
assert.equal(hash(JSON.stringify(census)), "7d0764bfc810a3e590b347cf4aebcdaf2a0120ba52b0f35ddde7327cf5e71178");
const providers = files(".test262-cache/temporal").filter((p) => p.endsWith(".wasm"));
assert.equal(providers.length, 1, "one original Temporal provider");
assert.equal(hash(readFileSync(providers[0])), "1e277d9b4bc3e634f5838bdeff0f8088f56dba8c7e8a394ee38c2c63286df18b");
assert.equal(
  read(".test262-cache/temporal/prewarm.json").key,
  "372a41be9bdeb22ade63a811b4b26afce75694ee0d9b7cf928c24ddad739020b",
);
if (mode === "pre") {
  assert.equal(process.argv.length, 3);
  save("replay5807-admission.json", {
    head: process.env.REPLAY_HEAD,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    controls,
    observationTrace,
    imageOS: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    originalImageVersion: "20260831.293.1",
    limitation: "Hosted image and worker scheduling may differ; this is diagnostic replay, not regression clearance.",
    registeredPathsSha256: hash(JSON.stringify(original.registeredPaths)),
    files: historicalFiles.map((path) => ({ path, sha256: hash(readFileSync(path)) })),
  });
} else {
  assert([0, 1].includes(code), "unexpected Vitest terminal; retain incomplete evidence");
  const prefix = `benchmarks/results/test262-results-${process.env.RUN_TIMESTAMP}`;
  const completionPath = prefix + ".shard-34-of-52.complete.json";
  const completion = read(completionPath);
  assert.deepEqual(completion.registeredPaths, original.registeredPaths, "exact ordered shard membership");
  execFileSync(
    process.execPath,
    [
      "scripts/validate-test262-completeness.mjs",
      "--input",
      prefix + ".jsonl",
      "--manifest",
      completionPath,
      "--expected-shards",
      "1",
    ],
    { stdio: "inherit" },
  );
  const rows = readFileSync(prefix + ".jsonl", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 939);
  for (const row of rows) {
    assert.equal(row.oracle_lane, "honest", "non-honest row");
    assert.equal(row.semantic_providers, "auto", "unexpected row provider mode");
  }
  const target = "test/built-ins/TypedArrayConstructors/ctors-bigint/object-arg/new-instance-extensibility.js";
  const targetRows = rows.filter((r) => r.file === target);
  assert.equal(targetRows.length, 1, "target present exactly once");
  let traceCoverage = null;
  if (observationTrace) {
    const { auditObservationTrace } = await import("./issue-5807-observation-trace.mjs");
    traceCoverage = auditObservationTrace(process.cwd());
  }
  save("replay5807-result.json", {
    status: "COMPLETE_DIAGNOSTIC_ONLY",
    code,
    canonicalRows: rows.length,
    targetRows,
    regressionCleared: false,
    observationTrace,
    traceReceipt,
    traceCoverage,
    excludesOtherRegression: "BigInt set is in shard31, not this approved shard34 replay",
  });
}
