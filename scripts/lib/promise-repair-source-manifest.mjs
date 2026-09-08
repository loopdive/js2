// Independent, explicitly pinned source admission for the repair-only runner.
// This helper never imports the compiler or modifies either measured checkout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BASELINE = "2b9cb408c18446361fcf9837045067d1fd97c642";
const BASELINE_SOURCE_SHA = "48f52a45be1b9b37622d146297ec630dd4a2e3d8458852e804f30d57951bff18";
const REPAIR_PATHS = [
  "src/codegen/async-scheduler.ts",
  "src/codegen/closed-method-dispatch.ts",
  "src/runtime/wasmgc/promise/resolution-bodies.ts",
  "src/runtime/wasmgc/promise/thenable-bodies.ts",
];
export const sha = (value) => createHash("sha256").update(value).digest("hex");

export function sourceSnapshot(root) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        assert(entry.isFile(), "source census rejects nonregular entry: " + path);
        files.push([path, sha(readFileSync(join(root, path)))]);
      }
    }
  }
  walk("src");
  return {
    root,
    head: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all", "--", "src"], {
      encoding: "utf8",
    }),
    files,
    sha256: sha(JSON.stringify(files)),
  };
}

export function sourceDifference(baseline, candidate) {
  const old = new Map(baseline.files),
    current = new Map(candidate.files);
  return [...new Set([...old.keys(), ...current.keys()])]
    .sort()
    .filter((path) => old.get(path) !== current.get(path))
    .map((path) => ({ path, baseline: old.get(path) ?? null, candidate: current.get(path) ?? null }));
}

function cleanBaseline(root) {
  const baseline = sourceSnapshot(root);
  assert.equal(baseline.head, BASELINE, "original baseline commit");
  assert.equal(baseline.files.length, 1316, "original baseline census denominator");
  assert.equal(baseline.sha256, BASELINE_SOURCE_SHA, "original complete source census");
  assert.equal(
    execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }),
    "",
    "baseline must remain clean",
  );
  return baseline;
}

function producerReceipt(path, expectedSha256, candidate) {
  assert.match(expectedSha256, /^[0-9a-f]{64}$/, "explicit producer receipt SHA256");
  const bytes = readFileSync(path);
  assert.equal(sha(bytes), expectedSha256, "stale producer freeze receipt");
  const producer = JSON.parse(bytes.toString("utf8"));
  assert.equal(realpathSync(producer.worktree), candidate.root, "producer candidate root");
  assert.equal(producer.base, candidate.head, "producer candidate HEAD");
  const production = Object.keys(producer.sha256)
    .filter((path) => path.startsWith("src/"))
    .sort();
  assert.deepEqual(production, REPAIR_PATHS, "exact four repair owner paths; cumulative census is separate");
  const current = new Map(candidate.files);
  for (const path of production)
    assert.equal(current.get(path), producer.sha256[path], "stale producer source: " + path);
  return {
    path: realpathSync(path),
    sha256: expectedSha256,
    repairSourceFiles: production.map((path) => [path, producer.sha256[path]]),
  };
}

export function captureManifest(roots, producerPath, producerSha256) {
  const baseline = cleanBaseline(roots.baseline),
    candidate = sourceSnapshot(roots.candidate);
  assert.notEqual(baseline.root, candidate.root);
  const producer = producerReceipt(producerPath, producerSha256, candidate);
  const difference = sourceDifference(baseline, candidate);
  assert(difference.length >= REPAIR_PATHS.length, "nonempty complete repair/prerequisite source difference");
  for (const path of REPAIR_PATHS)
    assert(
      difference.some((entry) => entry.path === path),
      "missing repair source difference: " + path,
    );
  return { schema: "promise-repair-source-manifest-v1", roots, baseline, candidate, difference, producer };
}

export function readPinnedManifest(path, expectedSha256, roots) {
  assert.match(expectedSha256, /^[0-9a-f]{64}$/, "explicit independently reviewed manifest SHA256 required");
  const bytes = readFileSync(path);
  assert.equal(sha(bytes), expectedSha256, "stale candidate source manifest");
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert.equal(manifest.schema, "promise-repair-source-manifest-v1");
  assert.deepEqual(manifest.roots, roots, "positional baseline/candidate manifest roots");
  return manifest;
}

export function assertManifestCurrent(manifest, roots) {
  assert.deepEqual(manifest.roots, roots);
  assert.deepEqual(
    captureManifest(roots, manifest.producer.path, manifest.producer.sha256),
    manifest,
    "source/HEAD/status/census/producer drift since independent manifest capture",
  );
  return { baseline: manifest.baseline, candidate: manifest.candidate, changed: manifest.difference };
}

function main(argv) {
  const values = {};
  const required = ["--baseline", "--candidate", "--producer-receipt", "--producer-receipt-sha256", "--output"];
  for (let i = 0; i < argv.length; i += 2) {
    assert(required.includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith("--"), "unknown/missing option");
    assert.equal(values[argv[i]], undefined, "duplicate option");
    values[argv[i]] = argv[i + 1];
  }
  for (const key of required) assert(values[key], "required: " + key);
  const roots = { baseline: realpathSync(values["--baseline"]), candidate: realpathSync(values["--candidate"]) };
  const output = resolve(values["--output"]);
  const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  assert(
    realpathSync(dirname(output)) === join(ownRoot, ".tmp") && output.startsWith(join(ownRoot, ".tmp/")),
    "manifest writes restricted to instrument scratch",
  );
  const manifest = captureManifest(roots, values["--producer-receipt"], values["--producer-receipt-sha256"]);
  const text = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(output, text, { flag: "wx" });
  console.log(
    JSON.stringify({
      output,
      sha256: sha(text),
      candidateHead: manifest.candidate.head,
      sourceFiles: manifest.candidate.files.length,
      differingPaths: manifest.difference.length,
      instruction: "Independently review and pin this manifest before the compiler run; capture is not acceptance.",
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
