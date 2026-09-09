// Additive, repair-aware contract. Original historical comparators are unchanged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const sha = (value) => createHash("sha256").update(value).digest("hex");
export const SPEC = {
  frame: {
    head: "0194b64c246d2b5beab2db00af33a73498e2eb6e",
    count: 1306,
    source: "5670027d6b5815133f5058ef785a55f7522d82d1058676de532cbe933ab210b0",
    fixtures: "ada123e98a8e5af9675bac070db2dfd1c1bf106792476264948d0fcb4b4c553f",
    ids: ["family", "multi-await", "try-catch", "try-finally", "late-import"],
    executions: 12,
    schema: "frame-body-source-preservation-v1",
  },
  delay: {
    head: "1cb0f5c7f36be14d7be7eb4592973aea84a8c4e5",
    count: 1311,
    source: "d37ac41c596e80e223a7576003cec7c9a9ec0968c8b497da8c35876cdc77562a",
    fixtures: "e060ddbfe9c704bdcdc8c18798c84bcaf56935555090e9280f051672443d21cd",
    ids: [
      "family",
      "delay",
      "race-vector",
      "all-settled-vector",
      "any-vector",
      "empty-all-settled",
      "empty-any",
      "invalid-before-empty",
      "grown-vector",
      "thenable-all",
      "poisoned-then-all",
    ],
    executions: 19,
    schema: "delay-combinator-source-preservation-v1",
  },
};
export const CANDIDATE = {
  head: "63079597adbfa485a1201de9eecabd9482aac8ce",
  count: 1379,
  source: "787d3bdc1ecaa8deb77939c0269ef8c6c380297681a4570595655f73491b6950",
};
const repairedPins = {
  frame: {
    source: "b58c7e57596e5f2fce3a2798c6564cdf42108d81779623d6dbd97b353234bce1",
    patch: "0f599134535848034b5dc43a14721a443a724dabad763a87b8910db13ed8f880",
  },
  delay: {
    source: "4a0c50c7fe09e175ee3c07def8197921034999e8b6d87c38756473e99815be7c",
    patch: "5c4c6c9e53e2cb4fb6a4c9dc5b64c02284c1d20796b8b89a549416bf3fdda83c",
  },
};
export const ORIGINAL_INSTRUMENTS = {
  "tests/issue-3518-async-frame-body-source-preservation.test.ts":
    "985663fc40aded2a6e585e2e8a571b2dd433036b8dee78b2e95d40c0b3faa34b",
  "tests/issue-3518-native-delay-combinator-source-preservation.test.ts":
    "26cf721ece91a9d468a42555eaeac49f5375ded7a9bafec2775cad5efb07749c",
  "tests/helpers/native-delay-combinator-source-receipts.mjs":
    "dcb2101fbfbb4e7a03c38ac0ec097da725d9c9bd254c24541ac07b997a45143f",
  "tests/helpers/native-delay-combinator-b1-inverse.mjs":
    "2db08ac6dfb265df815f57a31f275dac1fa9887a740eb5b5ddd351afee8d575c",
  "tests/helpers/semantic-provider-source-receipts.mjs":
    "83e8424be0406fb84b81e72496b5602362d4ff20687f27f0d234ce180f0f9093",
};
const allowed = [
  "src/codegen/async-scheduler.ts",
  "src/codegen/closed-method-dispatch.ts",
  "src/codegen/parse-number-native.ts",
  "src/ir/backend/wasmgc-emitter.ts",
];
const familyActions = [
  "pending-70",
  "non-i31",
  "sequential",
  "parallel-reverse",
  "empty",
  "sequential-reject",
  "parallel-reject",
  "undefined",
];
const fixturePaths = {
  frame: [
    "website/playground/examples/js/async.ts",
    "tests/issue-2906-async-multiawait.test.ts",
    "tests/issue-2906-3c-trycatch.test.ts",
    "tests/issue-2906-gap3-tryfinally.test.ts",
    "tests/issue-2710-late-bind.test.ts",
  ],
  delay: [
    "website/playground/examples/js/async.ts",
    "tests/issue-4573-standalone-native-promise-delay.test.ts",
    "tests/issue-2867-gap4.test.ts",
    "tests/issue-3137.test.ts",
    "tests/issue-3125.test.ts",
    "tests/issue-3125-widen.test.ts",
  ],
};
export function validateRequiredFiles(files, suite) {
  assert(fixturePaths[suite], "unknown suite");
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "node_modules/typescript/package.json",
    "node_modules/typescript/lib/typescript.js",
    "node_modules/tsx/package.json",
    "tests/helpers/semantic-provider-source-receipts.mjs",
    ...fixturePaths[suite],
  ])
    assert(Object.hasOwn(files, path), "missing pre-execution file pin: " + path);
}
const historicalReceipts = [
  "41578b8c1fc9df2b8b803d5bd6e97d5c71f473dcff6ab89a9679588a2654195a",
  "cf24823ed7f2b2ddc26e111c9088b3cc9f9b09757437cadd162bb538d2b267c4",
  "48afb8db8e7b20bea3b63ecdc837acfe53a7588581eda554dbd5db1a5f521977",
  "b9b71337846e7dc82ecefcbe525a76019dc6763a5486efb2a3acc05eb004d33b",
];
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
export function sourceSnapshot(root) {
  root = realpathSync(root);
  const sourceFiles = [];
  function visit(dir) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = dir + "/" + entry.name;
      if (entry.isDirectory()) visit(path);
      else {
        assert(entry.isFile(), "nonregular source: " + path);
        sourceFiles.push([path, sha(readFileSync(join(root, path)))]);
      }
    }
  }
  visit("src");
  return { root, head: git(root, ["rev-parse", "HEAD"]), sourceFiles, sourceSha256: sha(JSON.stringify(sourceFiles)) };
}
export function readManifest(path, digest) {
  assert.match(digest, /^[0-9a-f]{64}$/);
  const bytes = readFileSync(path);
  assert.equal(sha(bytes), digest, "execution manifest digest");
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.schema, "frame-delay-three-arm-execution-v1");
  assert.equal(manifest.status, "REVIEWED_FOR_EXECUTION", "not execution-approved");
  return manifest;
}
function filePin(root, path, digest) {
  assert(
    typeof path === "string" &&
      path.length > 0 &&
      !path.startsWith("/") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "unsafe relative pin path",
  );
  assert.equal(resolve(root, path), join(root, path), "relative canonical file pin");
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(sha(readFileSync(join(root, path))), digest, "file pin: " + path);
}
export function dependencySnapshot(root) {
  root = realpathSync(root);
  const entries = [];
  function visit(dir) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = dir ? dir + "/" + entry.name : entry.name;
      if (entry.isDirectory()) visit(path);
      else if (entry.isSymbolicLink()) {
        const target = realpathSync(join(root, path));
        assert(target.startsWith(root + "/"), "dependency symlink escapes pinned tree: " + path);
        entries.push([path, "link", target.slice(root.length + 1)]);
      } else {
        assert(entry.isFile(), "nonregular dependency");
        entries.push([path, "file", sha(readFileSync(join(root, path)))]);
      }
    }
  }
  visit("");
  assert(entries.length > 0, "empty dependency census");
  return { root, count: entries.length, sha256: sha(JSON.stringify(entries)) };
}
export function assertAdmission(manifest, instrumentRoot, invocation = null) {
  return assertAdmissionImpl(manifest, instrumentRoot, invocation, "REVIEWED_FOR_EXECUTION");
}
// Same read-only checks, but cannot authorize the driver or any child process.
export function assertReviewAdmission(manifest, instrumentRoot) {
  return assertAdmissionImpl(manifest, instrumentRoot, null, "REVIEW_REQUIRED_NOT_AUTHORIZED");
}
function assertAdmissionImpl(manifest, instrumentRoot, invocation, expectedStatus) {
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
  ])
    assert(process.env[key] === undefined, "Git-root override must be absent: " + key);
  assert.equal(manifest.schema, "frame-delay-three-arm-execution-v1");
  assert.equal(manifest.status, expectedStatus);
  assert.equal(realpathSync(instrumentRoot), manifest.instrumentRoot);
  const required = [
    ...Object.keys(ORIGINAL_INSTRUMENTS),
    "scripts/verify-frame-delay-three-arm.mjs",
    "scripts/lib/frame-delay-three-arm-contract.mjs",
  ];
  assert.deepEqual(Object.keys(manifest.instruments).sort(), required.sort(), "complete instrument pins");
  for (const [path, digest] of Object.entries(manifest.instruments)) {
    if (ORIGINAL_INSTRUMENTS[path]) assert.equal(digest, ORIGINAL_INSTRUMENTS[path]);
    filePin(instrumentRoot, path, digest);
  }
  assert.equal(manifest.environment.node, realpathSync(process.execPath));
  assert.equal(manifest.environment.nodeSha256, sha(readFileSync(process.execPath)));
  assert.equal(manifest.environment.version, process.version);
  assert.equal(manifest.environment.platform, process.platform);
  assert.equal(manifest.environment.arch, process.arch);
  if (invocation === null) assert.deepEqual(manifest.environment.execArgv, process.execArgv);
  else {
    assert(["frame", "delay"].includes(invocation.suite));
    assert(["original", "repaired", "candidate"].includes(invocation.role));
    assert.equal(process.execArgv.length, 6, "child invocation shape");
    assert.deepEqual(process.execArgv.slice(0, 5), [
      "--max-old-space-size=2048",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
    ]);
    assert.equal(sha(process.execArgv[5]), manifest.programs[invocation.suite], "independently pinned child program");
    assert.equal(process.argv[1], manifest.suites[invocation.suite][invocation.role].root, "child root argument");
    assert.equal(process.argv[2], invocation.role === "original" ? "baseline" : invocation.role, "child role argument");
  }
  assert.equal(process.env.NODE_OPTIONS, "--max-old-space-size=2048", "same reviewed parent/child controls required");
  assert(process.execArgv.includes("--max-old-space-size=2048"), "explicit coordinator heap required");
  const relevant = Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) => /^(JS2WASM_|IR_VERIFY_|TSX_|NODE_|ESBUILD_)/.test(k))
      .sort(),
  );
  assert.deepEqual(relevant, manifest.environment.controls, "unexpected runtime environment");
  assert.deepEqual(
    dependencySnapshot(manifest.dependencies.root),
    manifest.dependencies,
    "complete dependency census drift",
  );
  assert.deepEqual(Object.keys(manifest.suites).sort(), ["delay", "frame"]);
  const allRoots = new Set();
  for (const suite of ["frame", "delay"]) {
    const arms = manifest.suites[suite],
      spec = SPEC[suite];
    assert.deepEqual(Object.keys(arms).sort(), ["candidate", "original", "repaired"]);
    const snapshots = {};
    for (const role of ["original", "repaired", "candidate"]) {
      const pin = arms[role],
        snapshot = sourceSnapshot(pin.root);
      assert.equal(
        realpathSync(join(pin.root, "node_modules")),
        manifest.dependencies.root,
        "unpinned dependency root",
      );
      assert.equal(snapshot.root, pin.root, "canonical root");
      // C may be reused across suites, never across roles; O and R are distinct.
      const key = role === "candidate" ? "candidate:" + snapshot.root : snapshot.root;
      if (role !== "candidate") assert(!allRoots.has(key), "aliased original/repaired roots");
      allRoots.add(key);
      assert.deepEqual(
        snapshot,
        { root: pin.root, head: pin.head, sourceFiles: pin.sourceFiles, sourceSha256: pin.sourceSha256 },
        "source census drift",
      );
      const expected = role === "candidate" ? CANDIDATE : spec;
      assert.equal(pin.head, expected.head, "immutable root HEAD");
      assert.equal(pin.sourceFiles.length, expected.count);
      if (role !== "repaired") {
        assert.equal(pin.sourceSha256, expected.source);
        assert.equal(
          git(pin.root, ["status", "--porcelain", "--untracked-files=all", "--", "src"]),
          "",
          "original/candidate source dirty",
        );
      } else assert.equal(pin.sourceSha256, repairedPins[suite].source, "unapproved repaired census");
      assert.equal(git(pin.root, ["ls-files", "--others", "--exclude-standard", "--", "src"]), "", "untracked source");
      assert(pin.files && Object.keys(pin.files).length > 0, "fixture and dependency pins required");
      validateRequiredFiles(pin.files, suite);
      for (const [path, digest] of Object.entries(pin.files)) filePin(pin.root, path, digest);
      for (const path of [
        "pnpm-lock.yaml",
        "tsconfig.json",
        "node_modules/typescript/package.json",
        "node_modules/typescript/lib/typescript.js",
        "node_modules/tsx/package.json",
        "tests/helpers/semantic-provider-source-receipts.mjs",
      ])
        assert(Object.hasOwn(pin.files, path), "missing required dependency: " + path);
      snapshots[role] = snapshot;
    }
    assert.equal(new Set(Object.values(arms).map((p) => p.root)).size, 3, "aliased arms");
    const before = new Map(snapshots.original.sourceFiles),
      after = new Map(snapshots.repaired.sourceFiles);
    assert.deepEqual([...before.keys()], [...after.keys()], "new/missing source file");
    const difference = [...before]
      .filter(([p, digest]) => after.get(p) !== digest)
      .map(([path, preimageSha256]) => ({ path, preimageSha256, postimageSha256: after.get(path) }));
    assert.deepEqual(difference.map((x) => x.path).sort(), allowed, "unapproved repaired source file");
    assert.deepEqual(difference, manifest.repairs[suite].difference, "unapproved repair hunk/postimage");
    assert.equal(sha(readFileSync(manifest.repairs[suite].patch)), manifest.repairs[suite].sha256, "patch drift");
    assert.equal(manifest.repairs[suite].sha256, repairedPins[suite].patch, "unapproved patch");
  }
  const originals = [manifest.suites.frame.original.root, manifest.suites.delay.original.root];
  for (const suite of Object.values(manifest.suites))
    for (const role of ["repaired", "candidate"])
      assert(!originals.includes(suite[role].root), "protected original alias");
  const repairedRoots = Object.values(manifest.suites).map((s) => s.repaired.root);
  for (const suite of Object.values(manifest.suites))
    assert(!repairedRoots.includes(suite.candidate.root), "candidate/repaired alias");
  assert.deepEqual(
    manifest.evidence.map((x) => x.sha256).sort(),
    [...historicalReceipts].sort(),
    "original evidence denominator",
  );
  for (const evidence of manifest.evidence)
    assert.equal(sha(readFileSync(evidence.path)), evidence.sha256, "original receipt changed");
}
export function validatePopulation(report, suite) {
  const spec = SPEC[suite];
  assert(spec, "unknown suite");
  assert.equal(report.schema, spec.schema);
  assert.deepEqual(
    report.rows.map((x) => x.id),
    spec.ids,
  );
  assert.deepEqual(
    report.fixtures.map((x) => x.id),
    spec.ids,
  );
  let executions = 0;
  for (const [i, row] of report.rows.entries()) {
    assert.equal(row.kind, "executed", "nonexecuted row: " + row.id);
    assert.deepEqual(row.fixture, report.fixtures[i]);
    assert.equal(sha(row.fixture.source), row.fixture.sourceSha256);
    assert(Buffer.from(row.binary, "base64").length > 8);
    assert(row.wat.length > 0);
    assert.equal(row.values.length, row.id === "family" ? 8 : row.id === "delay" ? 2 : 1);
    if (row.id === "family")
      assert.deepEqual(
        row.values.map((x) => x.action),
        familyActions,
      );
    if (row.id === "delay")
      assert.deepEqual(
        row.values.map((x) => x.action),
        ["concurrent-delay", "registration-rejection"],
      );
    for (const value of row.values) assert.equal(value.instantiatedBinary, row.binary, "instantiated bytes mismatch");
    executions += row.values.length;
  }
  assert.equal(executions, spec.executions);
  for (const key of ["closureCertified", "physicalAcceptanceCertified", "retirementCertified"])
    assert.equal(report[key], false);
}
export function validateReceipt(report, suite, pin) {
  validatePopulation(report, suite);
  assert.equal(sha(JSON.stringify(report.fixtures)), SPEC[suite].fixtures, "original fixture drift");
  assert.equal(report.root, pin.root);
  assert.deepEqual(report.sourceFiles, pin.sourceFiles);
  assert.deepEqual(
    report.urls,
    [
      "src/index.ts",
      "src/runtime.ts",
      "tests/helpers/semantic-provider-source-receipts.mjs",
      "node_modules/typescript/lib/typescript.js",
    ].map((p) => pathToFileURL(join(pin.root, p)).href),
  );
  for (const fixture of report.fixtures) {
    assert.equal(pin.files[fixture.path], fixture.sourceFileSha256, "missing fixture file pin");
    filePin(pin.root, fixture.path, fixture.sourceFileSha256);
  }
}
// Compact verdict only; retain complete source receipts rather than huge diffs.
export function compareSuite(original, repaired, candidate) {
  const exact = (a, b) => isDeepStrictEqual(a.fixtures, b.fixtures) && isDeepStrictEqual(a.rows, b.rows);
  const result = {
    originalCandidateExact: exact(original, candidate),
    repairedCandidateExact: exact(repaired, candidate),
  };
  result.mismatches = repaired.rows.filter((row, i) => !isDeepStrictEqual(row, candidate.rows[i])).map((row) => row.id);
  const control = original.rows.findIndex((x) => x.id === "late-import");
  result.lateImportExact =
    control < 0
      ? null
      : isDeepStrictEqual(original.rows[control], repaired.rows[control]) &&
        isDeepStrictEqual(original.rows[control], candidate.rows[control]);
  result.pass = result.repairedCandidateExact && result.lateImportExact !== false;
  return result;
}
