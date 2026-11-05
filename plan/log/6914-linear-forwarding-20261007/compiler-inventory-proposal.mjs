#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Parent-invoked serial replay only. Never applies the owner-review patch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HEAD = "891412c5eb84fbb7d2570976ca33b143e24d37d2";
const POLICY_HASH = "8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1";
const POLICY = "scripts/compiler-boundaries.json";
const CHECKER = "scripts/check-compiler-boundaries.mjs";
const README = "src/codegen-linear/runtime/arrays/README.md";
const LEAF = "src/codegen-linear/runtime/arrays/forwarding-resolver.ts";
const TEST = "tests/issue-6914-linear-ir-array-forwarding-provider-body.test.ts";
const DOC = { path: README, reason: "Linear array runtime body documentation; not implementation or type code." };
const CLASSIFICATION = { path: LEAF, state: "unmigrated", layer: "legacy-linear" };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const here = dirname(fileURLToPath(import.meta.url));
let output;

function record(kind, fields) {
  const row = { issue: 6914, kind, canonicalAcceptance: false, ...fields };
  console.log(JSON.stringify(row));
  return row;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { env: cleanEnv, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function safeRelative(path) {
  assert(
    typeof path === "string" && !isAbsolute(path) && !path.split(/[\\/]/).some((p) => !p || p === "." || p === ".."),
    `unsupported custody path: ${path}`,
  );
  return path;
}

function file(root, path) {
  safeRelative(path);
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = resolve(cursor, part);
    assert(!lstatSync(cursor).isSymbolicLink(), `unsupported custody symlink: ${path}`);
  }
  const stat = lstatSync(cursor);
  assert(stat.isFile(), `missing/non-file custody input: ${path}`);
  const bytes = readFileSync(cursor);
  return { path, bytes: bytes.length, sha256: sha(bytes), mode: stat.mode & 0o777 };
}

function population(root, directory) {
  const rows = [];
  const walk = (path) => {
    const stat = lstatSync(resolve(root, path));
    assert(!stat.isSymbolicLink(), `unsupported source/test symlink: ${path}`);
    if (stat.isDirectory()) {
      rows.push({ path, directory: true, mode: stat.mode & 0o777 });
      for (const name of readdirSync(resolve(root, path)).sort()) walk(`${path}/${name}`);
    } else rows.push(file(root, path));
  };
  walk(directory);
  assert(
    rows.some((row) => !row.directory),
    `empty custody population: ${directory}`,
  );
  return rows;
}

function configPaths(root, policy) {
  // Include every root configuration spelling, not just the checker-selected one.
  const paths = new Set([POLICY, CHECKER, "package.json", "pnpm-lock.yaml", policy.tsconfig]);
  for (const name of readdirSync(root))
    if (
      /^(tsconfig.*\.json|.*\.config\.(?:ts|js|mjs|cjs)|biome\.json|\.prettierrc|\.prettierignore|\.npmrc)$/.test(name)
    )
      paths.add(name);
  for (const asset of policy.externalAssets ?? []) paths.add(safeRelative(asset.path));
  const config = JSON.parse(readFileSync(resolve(root, policy.tsconfig), "utf8"));
  assert(
    !config.extends && !config.references,
    "unsupported custody tsconfig extends/references; request explicit review",
  );
  return [...paths].sort();
}

function snapshot(root, paths) {
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), HEAD, "source HEAD changed");
  assert.deepEqual(configPaths(root, originalPolicy), paths, "configuration path population changed");
  const source = [...population(root, "src"), ...population(root, "tests")];
  const configs = paths.map((path) => file(root, path));
  const require = createRequire(resolve(root, CHECKER));
  const packagePath = require.resolve("typescript/package.json");
  const enginePath = require.resolve("typescript");
  const toolchain = [packagePath, enginePath].map((path) => ({
    path: realpathSync(path),
    sha256: sha(readFileSync(path)),
  }));
  const referenceTrees = {
    src: git(root, ["rev-parse", `${HEAD}:src`]).trim(),
    tests: git(root, ["rev-parse", `${HEAD}:tests`]).trim(),
  };
  const manifest = { head: HEAD, referenceTrees, source, configs, toolchain };
  assert.equal(configs.find((row) => row.path === POLICY)?.sha256, POLICY_HASH, "canonical policy changed");
  return manifest;
}

function verifyReferenceTree(root, manifest) {
  assert.equal(
    git(root, ["rev-parse", "--show-object-format"]).trim(),
    "sha1",
    "unsupported custody reference-tree object format",
  );
  const entries = git(root, ["ls-tree", "-rz", HEAD, "--", "src", "tests"]).split("\0").filter(Boolean);
  const expected = entries
    .map((entry) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
      assert(match, `unsupported custody reference-tree entry: ${entry}`);
      return { path: match[3], blob: match[2] };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const actual = manifest.source
    .filter((row) => !row.directory)
    .map(({ path }) => {
      const bytes = readFileSync(resolve(root, path));
      return { path, blob: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(actual, expected, "source/test path population or content differs from frozen reference tree");
  const configEntries = git(root, ["ls-tree", "-z", HEAD, "--", ...manifest.configs.map((row) => row.path)])
    .split("\0")
    .filter(Boolean);
  assert.equal(
    configEntries.length,
    manifest.configs.length,
    "unsupported untracked/missing checker/config custody input",
  );
  for (const entry of configEntries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    assert(match, `unsupported checker/config reference-tree entry: ${entry}`);
    const bytes = readFileSync(resolve(root, match[3]));
    assert.equal(
      createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
      match[2],
      `checker/config differs from frozen HEAD: ${match[3]}`,
    );
  }
  for (const path of ["src/codegen-linear/runtime.ts", LEAF, README, TEST])
    assert(
      actual.some((row) => row.path === path),
      `missing required input: ${path}`,
    );
}

function verifyManifest(expected, actual) {
  for (const group of ["source", "configs", "toolchain"]) {
    assert.equal(actual[group].length, expected[group].length, `${group} population changed`);
    for (let i = 0; i < expected[group].length; i++)
      assert.deepEqual(actual[group][i], expected[group][i], `custody mismatch: ${expected[group][i].path}`);
  }
  assert.equal(actual.head, expected.head);
  assert.deepEqual(actual.referenceTrees, expected.referenceTrees, "custody reference trees changed");
}

function verifierNegatives(manifest) {
  for (const path of ["src/codegen-linear/runtime.ts", LEAF, TEST]) {
    const bad = structuredClone(manifest);
    const row = bad.source.find((item) => item.path === path);
    assert(row, `missing negative input: ${path}`);
    row.sha256 = "0".repeat(64);
    let rejection;
    try {
      verifyManifest(manifest, bad);
    } catch (error) {
      rejection = error.message;
    }
    assert(rejection?.includes(path), `wrong-hash manifest was not rejected with affected path: ${path}`);
    writeFileSync(
      resolve(output, `wrong-hash-${path === TEST ? "test" : path === LEAF ? "leaf" : "runtime"}.json`),
      JSON.stringify(bad, null, 2) + "\n",
      { flag: "wx" },
    );
    record("custody-negative", { path, rejection, editedRealInput: false });
  }
}

function policies(original) {
  assert(
    !original.nonModules.some((row) => row.path === README) && !original.files.some((row) => row.path === LEAF),
    "proposal entries already present",
  );
  const proposed = structuredClone(original);
  proposed.nonModules.push(DOC);
  const index = proposed.files.findIndex((row) => row.path === "src/codegen-linear/runtime.ts");
  assert(index >= 0);
  assert.deepEqual(proposed.files[index], {
    path: "src/codegen-linear/runtime.ts",
    state: "unmigrated",
    layer: "legacy-linear",
  });
  proposed.files.splice(index + 1, 0, CLASSIFICATION);
  const omit = (readme, leaf) => {
    const copy = structuredClone(proposed);
    if (readme) copy.nonModules = copy.nonModules.filter((row) => row.path !== README);
    if (leaf) copy.files = copy.files.filter((row) => row.path !== LEAF);
    return copy;
  };
  assert.deepEqual(omit(true, true), original, "removal does not deeply restore original policy ordering/fields");
  return { proposed, "omit-readme": omit(true, false), "omit-leaf": omit(false, true), "omit-both": omit(true, true) };
}

function replay(root, name, config, manifest, paths) {
  const before = snapshot(root, paths);
  verifyManifest(manifest, before);
  writeFileSync(resolve(output, `${name}.before.json`), JSON.stringify(before, null, 2) + "\n", { flag: "wx" });
  const configHash = sha(readFileSync(config));
  const args = [
    resolve(root, CHECKER),
    "--root",
    root,
    "--config",
    config,
    "--mode",
    "inventory",
    "--base",
    HEAD,
    "--json",
  ];
  const child = spawnSync(process.execPath, args, {
    cwd: root,
    env: cleanEnv,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  for (const channel of ["stdout", "stderr"])
    writeFileSync(resolve(output, `${name}.${channel}.log`), child[channel] ?? "", { flag: "wx" });
  const receipt = {
    name,
    command: [process.execPath, ...args],
    status: child.status,
    signal: child.signal,
    error: child.error?.message ?? null,
    configHash,
    stdoutSha256: sha(child.stdout ?? ""),
    stderrSha256: sha(child.stderr ?? ""),
  };
  writeFileSync(resolve(output, `${name}.exit.json`), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  const after = snapshot(root, paths);
  writeFileSync(resolve(output, `${name}.after.json`), JSON.stringify(after, null, 2) + "\n", { flag: "wx" });
  verifyManifest(before, after);
  assert.equal(sha(readFileSync(config)), configHash, `${name}: replay policy changed`);
  record("replay", receipt);
  assert(
    !child.error && child.signal === null && Number.isInteger(child.status),
    `${name}: incomplete checker execution`,
  );
  const report = JSON.parse(child.stdout);
  assert.equal(report.schema, "compiler-boundary-report-v1");
  assert.equal(report.sourceRevision, HEAD);
  assert.equal(report.policyHash, configHash);
  assert.equal(report.mode, "inventory");
  assert.deepEqual(report.comparisonBase, {
    requested: HEAD,
    revision: HEAD,
    policyPresent: name === "canonical",
    policyHash: name === "canonical" ? POLICY_HASH : null,
  });
  assert.equal(report.architectureComplete, false);
  assert.equal(report.graphComplete, false, "unexpected graph-completeness change");
  assert(
    report.modules.length > 0 && report.debt.length > 0 && report.unknownEdges.length > 0,
    "missing full inventory/debt/incomplete-graph observations",
  );
  for (const [path, hash] of Object.entries(report.resolver.configInputs))
    assert.equal(
      manifest.configs.find((row) => row.path === path)?.sha256,
      hash,
      `uncaptured resolver config: ${path}`,
    );
  const modules = manifest.source.filter(
    (row) =>
      !row.directory &&
      originalPolicy.moduleExtensions.some((ext) => row.path.endsWith(ext)) &&
      row.path.startsWith("src/"),
  );
  assert.deepEqual(
    report.modules.map((row) => ({ path: row.path, hash: row.hash })).sort((a, b) => a.path.localeCompare(b.path)),
    modules.map((row) => ({ path: row.path, hash: row.sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
    "checker module population/hashes differ from custody",
  );
  return { report, status: child.status };
}

let originalPolicy;
function expectedReport(base, policy, readme, leaf, actual) {
  const expected = structuredClone(base);
  expected.policyHash = actual.policyHash;
  expected.comparisonBase = { requested: HEAD, revision: HEAD, policyPresent: false, policyHash: null };
  expected.errors = base.errors.filter(({ detail }) => !(readme && detail === README) && !(leaf && detail === LEAF));
  if (readme) expected.excludedNonModules.find((row) => row.path === README).reason = DOC.reason;
  if (leaf) {
    for (const rows of [expected.modules, expected.debt])
      Object.assign(
        rows.find((row) => row.path === LEAF),
        CLASSIFICATION,
      );
    for (const [key, target] of [
      ["byState", "unmigrated"],
      ["byLayer", "legacy-linear"],
    ]) {
      expected.counts[key][target]++;
      if (--expected.counts[key].unclassified === 0) delete expected.counts[key].unclassified;
    }
    const incoming = expected.unresolvedEdges.filter((edge) => edge.to === LEAF);
    assert.equal(incoming.length, 1, "unexpected incoming resolver edge population");
    expected.unresolvedEdges = expected.unresolvedEdges.filter((edge) => edge.to !== LEAF);
    const edge = { ...incoming[0], targetLayer: "legacy-linear" };
    const ordinal = new Map(expected.modules.map((row, i) => [row.path, i]));
    const pos = expected.edges.findIndex(
      (row) => ordinal.get(row.from) > ordinal.get(edge.from) || (row.from === edge.from && row.line > edge.line),
    );
    expected.edges.splice(pos < 0 ? expected.edges.length : pos, 0, edge);
    expected.resolvedEdgeCount++;
    expected.counts.resolvedEdgesBySyntax[edge.syntax]++;
    expected.counts.resolvedEdgesByType[edge.typeOnly ? "typeOnly" : "runtime"]++;
    const removed = expected.forbiddenEdges.filter((row) => row.from === LEAF);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].reason, "layer undefined -> wasm-model");
    assert.equal(removed[0].enforced, false);
    expected.forbiddenEdges = expected.forbiddenEdges.filter((row) => row.from !== LEAF);
  }
  expected.inventoryValid = expected.errors.length === 0;
  expected.status = expected.inventoryValid ? "inventory-valid-architecture-incomplete" : "invalid-inventory";
  expected.dirtyContentFingerprint = sha(
    JSON.stringify({
      modules: expected.modules.map(({ path, realPath, hash }) => ({ path, realPath, hash })),
      policyHash: expected.policyHash,
      configInputs: expected.resolver.configInputs,
      assets: expected.excludedNonModules,
      externalAssets: expected.edges.filter((edge) => edge.asset),
    }),
  );
  assert.equal(sha(JSON.stringify(policy, null, 2) + "\n"), actual.policyHash);
  return expected;
}

try {
  assert.equal(
    process.argv.length,
    4,
    "usage: node compiler-inventory-proposal.mjs --root /absolute/frozen/source-worktree",
  );
  assert.equal(process.argv[2], "--root");
  assert(isAbsolute(process.argv[3]));
  assert.equal(process.env.NODE_OPTIONS ?? "", "", "NODE_OPTIONS must be empty");
  const root = realpathSync(process.argv[3]);
  originalPolicy = JSON.parse(readFileSync(resolve(root, POLICY), "utf8"));
  assert.equal(originalPolicy.sourceRoot, "src");
  const paths = configPaths(root, originalPolicy);
  const manifest = snapshot(root, paths);
  verifyReferenceTree(root, manifest);
  // Fresh output is inside the source root so temporary policy historical absence is meaningful.
  output = mkdtempSync(resolve(root, ".tmp-6914-inventory-proposal-"));
  record("start", {
    root,
    output,
    head: HEAD,
    policyHash: POLICY_HASH,
    scriptHash: sha(readFileSync(fileURLToPath(import.meta.url))),
    patchHash: sha(readFileSync(resolve(here, "compiler-inventory-wiring.patch"))),
    node: process.version,
    v8: process.versions.v8,
    execArgv: process.execArgv,
    manifestHash: sha(JSON.stringify(manifest)),
    sourcePopulation: manifest.source.length,
  });
  writeFileSync(resolve(output, "custody.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  verifierNegatives(manifest);
  const variants = policies(originalPolicy);
  const baseline = replay(root, "canonical", resolve(root, POLICY), manifest, paths);
  assert.equal(baseline.status, 1, "canonical inventory failure must remain visible");
  assert.deepEqual(baseline.report.errors, [
    { code: "unclassified-nonmodule", detail: README },
    { code: "unclassified-module", detail: LEAF },
    { code: "unclassified-target", detail: LEAF },
  ]);
  for (const [name, policy] of Object.entries(variants)) {
    const config = resolve(output, `${name}.policy.json`);
    writeFileSync(config, JSON.stringify(policy, null, 2) + "\n", { flag: "wx" });
    const result = replay(root, name, config, manifest, paths);
    const readme = policy.nonModules.some((row) => row.path === README);
    const leaf = policy.files.some((row) => row.path === LEAF);
    assert.deepEqual(
      result.report,
      expectedReport(baseline.report, policy, readme, leaf, result.report),
      `${name}: unexpected report deltas`,
    );
    assert.equal(result.status, name === "proposed" ? 0 : 1);
  }
  verifyManifest(manifest, snapshot(root, paths));
  record("complete", {
    output,
    temporaryMetadataProposalVerified: true,
    canonicalInventoryFailed: true,
    architectureComplete: false,
    graphComplete: false,
    holdReleased: false,
    canonicalOwnerCheckRequired: true,
  });
} catch (error) {
  record("incomplete", { output: output ?? null, error: error.stack, canonicalInventoryWaived: false });
  process.exitCode = 1;
}
