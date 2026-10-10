import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const archiveRoot = resolve("plan/log/6915-linear-append-20261007/ci-trusted-parent-20261008");
const archived = (name) => JSON.parse(gunzipSync(readFileSync(join(archiveRoot, `${name}.json.gz`))));
const oldExpected = archived("expected");
const configPaths = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/test262-concurrency.mjs",
  "tsconfig.json",
  "tsconfig.ts7.json",
  "vite.config.lib.ts",
  "vite.config.ts",
  "vitest.config.ts",
];
const fixedPaths = {
  runtime: "src/codegen-linear/runtime.ts",
  consumer: "src/ir/backend/frozen-body-consumer.ts",
  integration: "src/ir/backend/linear-integration.ts",
  testSha256: "tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts",
  fixture: "website/public/benchmarks/competitive/programs/string-hash.js",
};
const selfTest = process.argv[2] === "--self-test";
const frozen = selfTest
  ? {
      runnerPath: resolve("scripts/hooks/run-linear-append-provenance.mjs"),
      runnerSha256: "b6106b0ef3b686bb67d713cf6133d3235a5c4c29666fa889680b531193263e77",
      toolchain: { node: "v22.23.2", v8: "12.4.254.21-node.56" },
      command: archived("command"),
      files: archived("before").files,
    }
  : JSON.parse(readFileSync(resolve(process.argv[4]), "utf8"));
assert.equal(sha(readFileSync(frozen.runnerPath)), frozen.runnerSha256, "runner changed before import");
const { decodeGraph, validateAppendReceipt, readRecords } = await import(pathToFileURL(frozen.runnerPath).href);

const baselineFile = resolve("plan/log/6915-linear-append-20261007/ci-trusted-parent-20261008/graphs.ndjson.gz");
const baselineBytes = gunzipSync(readFileSync(baselineFile));
assert.equal(baselineBytes.length, 44267645);
assert.equal(
  createHash("sha256").update(baselineBytes).digest("hex"),
  "bb1f7239ff371e6f373d3b45450a458f88c319a2d47b397b080681ce1d8f2b3e",
);
const parse = (bytes) =>
  bytes
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const original = parse(baselineBytes);
const ids = [
  ...Array.from({ length: 22 }, (_, i) => `Runtime${String(i + 1).padStart(2, "0")}`),
  "Source01",
  "Source02",
  "Source03",
  "Source04",
  "Import01",
  "Import02",
  ...Array.from({ length: 8 }, (_, i) => `Negative${String(i + 1).padStart(2, "0")}`),
];
function population(rows) {
  assert.equal(rows.length, 38);
  assert.ok(rows.every((row) => row.schema === "6915-evidence-graph-v1"));
  assert.equal(rows[0].kind, "provenance");
  assert.equal(rows[37].kind, "completion");
  assert.deepEqual(
    rows.slice(1, 37).map((row) => row.id),
    ids,
  );
}
function firstDifference(left, right, path = "$") {
  if (isDeepStrictEqual(left, right)) return null;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return path;
  if (Array.isArray(left) !== Array.isArray(right)) return path;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return `${path}.${key}`;
    const difference = firstDifference(left[key], right[key], `${path}.${key}`);
    if (difference !== null) return difference;
  }
  return path;
}
function compare(rows) {
  population(original);
  population(rows);
  for (let i = 1; i < 38; i++) {
    const path = firstDifference(original[i], rows[i]);
    if (path !== null)
      throw new Error(`complete graph mismatch: envelope ${i}, ${rows[i].id ?? rows[i].kind}, ${path}`);
  }
}

function provenance(envelope, expected, before, after, command, freeze = frozen) {
  assert.deepEqual(
    Object.keys(expected).sort(),
    [
      "runtime",
      "consumer",
      "integration",
      "sourceTree",
      "testSha256",
      "fixture",
      "head",
      "command",
      "effectiveFlags",
    ].sort(),
  );
  for (const path of [...Object.values(fixedPaths), ...configPaths]) {
    assert.ok(Object.hasOwn(freeze.files, path), `missing fixed input ${path}`);
    assert.equal(freeze.files[path], archived("before").files[path], `fixed input ${path}`);
  }
  assert.deepEqual(Object.keys(envelope).sort(), ["schema", "issue", "kind", "id", "graph"].sort());
  assert.equal(envelope.schema, "6915-evidence-graph-v1");
  assert.equal(envelope.issue, 6915);
  assert.equal(envelope.kind, "provenance");
  assert.equal(envelope.id, null);
  const value = decodeGraph(envelope.graph);
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      "kind",
      "schema",
      "issue",
      "head",
      "sourceTree",
      "baseline",
      "baselineSourceTree",
      "sourceDirty",
      "testSha256",
      "fixtureSha256",
      "productionHashes",
      "options",
      "node",
      "v8",
      "execArgv",
      "argv",
      "nodeOptions",
      "linearIrFlag",
      "command",
      "ids",
      "expectedObservations",
    ].sort(),
  );
  assert.equal(value.kind, envelope.kind);
  assert.equal(value.schema, "6915-append-baseline-v2");
  assert.equal(value.issue, envelope.issue);
  for (const key of ["head", "sourceTree"]) {
    assert.equal(value[key], expected[key], key);
    assert.equal(before[key], expected[key], key);
    assert.equal(after[key], expected[key], key);
  }
  for (const [key, path] of Object.entries(fixedPaths)) {
    assert.equal(expected[key], oldExpected[key], `fixed pin ${key}`);
    const actual = ["runtime", "consumer", "integration"].includes(key)
      ? value.productionHashes[key]
      : value[key === "fixture" ? "fixtureSha256" : key];
    assert.equal(actual, expected[key], `graph ${key}`);
    assert.equal(before.files[path], expected[key], `before ${key}`);
    assert.equal(after.files[path], expected[key], `after ${key}`);
    assert.equal(freeze.files[path], expected[key], `frozen ${key}`);
  }
  assert.deepEqual(Object.keys(value.productionHashes).sort(), ["runtime", "consumer", "integration"].sort());
  for (const key of ["node", "v8"]) {
    assert.equal(value[key], freeze.toolchain[key]);
    assert.equal(before[key], freeze.toolchain[key]);
    assert.equal(after[key], freeze.toolchain[key]);
  }
  assert.equal(value.command, oldExpected.command);
  assert.equal(expected.command, oldExpected.command);
  assert.deepEqual(command, freeze.command);
  assert.deepEqual(command, archived("command"));
  assert.deepEqual(expected.effectiveFlags, oldExpected.effectiveFlags);
  assert.deepEqual(value.execArgv, oldExpected.effectiveFlags.execArgv);
  assert.equal(value.linearIrFlag, "1");
  assert.equal(value.nodeOptions, null);
  assert.equal(value.sourceDirty, "");
  assert.equal(value.baseline, "c41bca2bc07e9d8fddbb38ca77904dd1f0cac438");
  assert.equal(value.baselineSourceTree, "68296a0d34ceea94dbc9ca9398f71bc8a1b742b8");
  assert.deepEqual(Object.keys(value.options).sort(), ["target", "allocator", "fileName"].sort());
  assert.equal(value.options.target, "linear");
  assert.equal(value.options.allocator, "bump");
  assert.equal(value.options.fileName, fixedPaths.fixture);
  assert.deepEqual(value.ids, ids);
  assert.equal(value.expectedObservations, 36);
  assert.ok(Array.isArray(value.argv) && value.argv.length <= 256 && value.argv.every((x) => typeof x === "string"));
  for (const [path, digest] of Object.entries(freeze.files)) {
    assert.equal(before.files[path], digest, `frozen input ${path}`);
    assert.equal(after.files[path], digest, `after frozen input ${path}`);
  }
  return value;
}
function rawBinding(stdout, stderr, graphs) {
  const recovered = readRecords(stdout, stderr);
  assert.deepEqual(recovered.errors, [], "raw evidence decoding errors");
  assert.deepEqual(recovered.diagnostics, [], "raw failed diagnostics");
  assert.deepEqual(recovered.envelopes, graphs, "raw output/graph archive mismatch");
  return recovered.records;
}

if (selfTest) {
  compare(original);
  const mutation = structuredClone(original);
  mutation[1].extraComparisonControl = "must not be filtered";
  assert.throws(() => compare(mutation), /complete graph mismatch/);
  const completionMutation = structuredClone(original);
  completionMutation[37].extraComparisonControl = "must not be filtered";
  assert.throws(() => compare(completionMutation), /complete graph mismatch/);
  assert.throws(() => compare(original.slice(0, 37)));
  const before = archived("before"),
    after = archived("after"),
    command = archived("command");
  provenance(original[0], oldExpected, before, after, command);
  const currentHead = "5bbbabe13d077a2a2b4fbb0891da7674bfc37203";
  const currentTree = "2a8c200cbb4862b6ffdd5952be7f6fa8f9ce1e63";
  const currentExpected = { ...oldExpected, head: currentHead, sourceTree: currentTree };
  const currentBefore = { ...before, head: currentHead, sourceTree: currentTree };
  const current = structuredClone(original[0]);
  const property = (row, key) => row.graph.nodes[0].properties.find((p) => p.key === key);
  property(current, "head").value = currentHead;
  property(current, "sourceTree").value = currentTree;
  provenance(current, currentExpected, currentBefore, currentBefore, command);
  let controls = 6;
  assert.throws(() => provenance(original[0], currentExpected, currentBefore, currentBefore, command));
  controls++;
  for (const key of [
    "kind",
    "schema",
    "issue",
    "head",
    "sourceTree",
    "baseline",
    "baselineSourceTree",
    "sourceDirty",
    "testSha256",
    "fixtureSha256",
    "node",
    "v8",
    "nodeOptions",
    "linearIrFlag",
    "command",
    "expectedObservations",
  ]) {
    const row = structuredClone(current);
    property(row, key).value = "corrupted-control";
    assert.throws(() => provenance(row, currentExpected, currentBefore, currentBefore, command));
    controls++;
  }
  for (const key of ["head", "productionHashes", "testSha256", "fixtureSha256", "execArgv", "ids", "options", "argv"]) {
    const row = structuredClone(current);
    row.graph.nodes[0].properties = row.graph.nodes[0].properties.filter((p) => p.key !== key);
    assert.throws(() => provenance(row, currentExpected, currentBefore, currentBefore, command));
    controls++;
  }
  for (const key of ["runtime", "consumer", "integration"]) {
    const row = structuredClone(current);
    const node = row.graph.nodes.find((n) => n.properties?.some((p) => p.key === key));
    node.properties.find((p) => p.key === key).value = "corrupted-control";
    assert.throws(() => provenance(row, currentExpected, currentBefore, currentBefore, command));
    controls++;
    const snapshot = structuredClone(currentBefore);
    snapshot.files[fixedPaths[key]] = "corrupted-together";
    assert.throws(() => provenance(current, currentExpected, snapshot, snapshot, command));
    controls++;
  }
  const wrongEnvelope = { ...current, kind: "completion" };
  assert.throws(() => provenance(wrongEnvelope, currentExpected, currentBefore, currentBefore, command));
  controls++;
  const alteredFlags = structuredClone(current);
  alteredFlags.graph.nodes
    .find((n) => n.properties?.some((p) => p.value === "--max-old-space-size=4096"))
    .properties.find((p) => p.value === "--max-old-space-size=4096").value = "--max-old-space-size=8192";
  assert.throws(() => provenance(alteredFlags, currentExpected, currentBefore, currentBefore, command));
  controls++;
  for (const index of [1, 37]) {
    const rows = structuredClone(original);
    rows[index].graph.nodes[0].properties[0].value = "nested-corruption";
    assert.throws(() => compare(rows), /complete graph mismatch/);
    controls++;
  }
  for (const path of configPaths) {
    const incompleteFreeze = structuredClone(frozen);
    delete incompleteFreeze.files[path];
    assert.throws(() => provenance(current, currentExpected, currentBefore, currentBefore, command, incompleteFreeze));
    controls++;
    const changedFreeze = structuredClone(frozen);
    changedFreeze.files[path] = "corrupted-config";
    assert.throws(() => provenance(current, currentExpected, currentBefore, currentBefore, command, changedFreeze));
    controls++;
  }
  const rawControl = JSON.stringify(original[0]) + "\n";
  rawBinding(rawControl, "", [original[0]]);
  controls++;
  assert.throws(() => rawBinding(rawControl, "", []));
  controls++;
  assert.throws(() => rawBinding("prefix" + rawControl, "", [original[0]]));
  controls++;
  console.log(`full-graph/provenance comparison controls: ${controls} passed; no candidate execution`);
} else {
  assert.equal(
    process.argv.length,
    5,
    "usage: node compare-full-graphs.mjs <archive-directory> <frozen-manifest> <independent-freeze>",
  );
  const directory = resolve(process.argv[2]);
  const expected = JSON.parse(readFileSync(resolve(process.argv[3]), "utf8"));
  const json = (name) => JSON.parse(readFileSync(join(directory, name), "utf8"));
  assert.equal(expected.sourceTree, "2a8c200cbb4862b6ffdd5952be7f6fa8f9ce1e63");
  assert.deepEqual(json("expected.json"), expected);
  const before = json("before.json");
  assert.equal(before.head, expected.head);
  assert.equal(before.sourceTree, expected.sourceTree);
  assert.deepEqual(json("after.json"), before);
  const receipt = json("receipt.json");
  assert.equal(receipt.code, 0);
  assert.equal(receipt.signal, null);
  assert.equal(receipt.killed, false);
  assert.equal(receipt.spawnError, null);
  assert.deepEqual(receipt.failures, []);
  const reporter = json("reporter.json");
  for (const [key, value] of Object.entries({
    numTotalTests: 36,
    numPassedTests: 36,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
  }))
    assert.equal(reporter[key], value);
  assert.equal(reporter.success, true);
  const candidate = parse(readFileSync(join(directory, "graphs.ndjson")));
  provenance(candidate[0], expected, before, json("after.json"), json("command.json"));
  const recovered = rawBinding(
    readFileSync(join(directory, "stdout.log"), "utf8"),
    readFileSync(join(directory, "stderr.log"), "utf8"),
    candidate,
  );
  validateAppendReceipt(recovered, reporter, expected);
  compare(candidate);
  console.log(
    JSON.stringify(
      {
        executionHead: expected.head,
        sourceTree: expected.sourceTree,
        observationGraphsEqual: 36,
        completionEqual: true,
        envelopes: 38,
        filteredFields: [],
        beforeAfterCustodyEqual: true,
        childExit: 0,
        limitation: "Bounded append comparison only; no native completion, performance, retirement or main delivery.",
      },
      null,
      2,
    ),
  );
}
