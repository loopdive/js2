// Read-only admission capture. Never imports a compiler or launches an arm.
// Output is deliberately NOT accepted by the execution driver.
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sourceSnapshot,
  dependencySnapshot,
  sha,
  ORIGINAL_INSTRUMENTS,
  validateRequiredFiles,
} from "./lib/frame-delay-three-arm-contract.mjs";
import { extractPublicArmSource, addManifestAdmission } from "./verify-frame-delay-three-arm.mjs";

export function captureReview(config) {
  const instrumentRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  assert.equal(process.env.NODE_OPTIONS, "--max-old-space-size=2048");
  assert.deepEqual(process.execArgv, ["--max-old-space-size=2048"], "capture the intended coordinator invocation");
  const instruments = { ...ORIGINAL_INSTRUMENTS };
  for (const p of ["scripts/verify-frame-delay-three-arm.mjs", "scripts/lib/frame-delay-three-arm-contract.mjs"])
    instruments[p] = sha(readFileSync(join(instrumentRoot, p)));
  for (const [p, digest] of Object.entries(instruments))
    assert.equal(sha(readFileSync(join(instrumentRoot, p))), digest);
  const programs = {},
    suites = {},
    repairs = {},
    evidence = [];
  const patchManifestPath = join(
    instrumentRoot,
    "plan/agent-context/3518-three-arm-repair-artifacts/postimage-manifest.json",
  );
  const patchManifest = JSON.parse(readFileSync(patchManifestPath));
  assert.equal(
    sha(readFileSync(patchManifestPath)),
    "daba0e6d864187ee81f7f75a1a9cec2fcf6385b2e359df9e097b28d2821ec196",
  );
  const dependencies = dependencySnapshot(join(config.candidate, "node_modules"));
  for (const suite of ["frame", "delay"]) {
    const record = patchManifest.roots.find((r) => r.armFamily === suite);
    const sourcePath =
      suite === "frame"
        ? "tests/issue-3518-async-frame-body-source-preservation.test.ts"
        : "tests/helpers/native-delay-combinator-source-receipts.mjs";
    programs[suite] = addManifestAdmission(
      extractPublicArmSource(readFileSync(join(instrumentRoot, sourcePath)), ORIGINAL_INSTRUMENTS[sourcePath]),
    ).adaptedSha256;
    const originalReceiptPath = realpathSync(config[suite].originalReceipt);
    const originalReceipt = JSON.parse(readFileSync(originalReceiptPath));
    evidence.push({ path: originalReceiptPath, sha256: sha(readFileSync(originalReceiptPath)) });
    const candidateReceiptPath = realpathSync(config[suite].candidateReceipt);
    evidence.push({ path: candidateReceiptPath, sha256: sha(readFileSync(candidateReceiptPath)) });
    repairs[suite] = {
      patch: join(dirname(patchManifestPath), record.patch),
      sha256: record.patchSha256,
      difference: record.difference,
    };
    assert.equal(sha(readFileSync(repairs[suite].patch)), record.patchSha256);
    suites[suite] = {};
    for (const [role, rootInput] of Object.entries({
      original: config[suite].original,
      repaired: config[suite].repaired,
      candidate: config.candidate,
    })) {
      const root = realpathSync(rootInput),
        snapshot = sourceSnapshot(root),
        files = {};
      assert.equal(realpathSync(join(root, "node_modules")), dependencies.root, "different dependency tree");
      for (const p of [
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.json",
        "node_modules/typescript/package.json",
        "node_modules/typescript/lib/typescript.js",
        "node_modules/tsx/package.json",
        "tests/helpers/semantic-provider-source-receipts.mjs",
      ])
        files[p] = sha(readFileSync(join(root, p)));
      for (const fixture of originalReceipt.fixtures) {
        files[fixture.path] = sha(readFileSync(join(root, fixture.path)));
        assert.equal(files[fixture.path], fixture.sourceFileSha256, "fixture drift during capture");
      }
      validateRequiredFiles(files, suite);
      suites[suite][role] = { ...snapshot, files };
    }
    assert.equal(suites[suite].original.sourceSha256, record.originalSourceCensusSha256);
    assert.equal(suites[suite].repaired.sourceSha256, record.repairedSourceCensusSha256);
    assert.equal(suites[suite].candidate.sourceSha256, patchManifest.candidate.sourceCensusSha256);
  }
  return {
    schema: "frame-delay-three-arm-execution-v1",
    status: "REVIEW_REQUIRED_NOT_AUTHORIZED",
    capture: {
      sourceSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
      comparisonRuns: 0,
      compilerInvocations: 0,
    },
    instrumentRoot,
    instruments,
    programs,
    dependencies,
    suites,
    repairs,
    evidence,
    environment: {
      node: realpathSync(process.execPath),
      nodeSha256: sha(readFileSync(process.execPath)),
      version: process.version,
      platform: process.platform,
      arch: process.arch,
      execArgv: process.execArgv,
      controls: Object.fromEntries(
        Object.entries(process.env)
          .filter(([k]) => /^(JS2WASM_|IR_VERIFY_|TSX_|NODE_|ESBUILD_)/.test(k))
          .sort(),
      ),
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert([3, 4].includes(process.argv.length), "explicit configuration path and optional output section required");
  const manifest = captureReview(JSON.parse(readFileSync(process.argv[2])));
  const section = process.argv[3];
  assert(section === undefined || ["metadata", "frame", "delay"].includes(section), "unknown output section");
  const output = section === "metadata" ? { ...manifest, suites: {} } : section ? manifest.suites[section] : manifest;
  console.log(JSON.stringify(output, null, 2));
}
