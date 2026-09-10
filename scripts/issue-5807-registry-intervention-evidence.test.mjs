// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Tiny synthetic files only; never reads a subject runtime or executes fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { collectRegistryInterventionEvidence, main } from "./issue-5807-registry-intervention-evidence.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture({ failed = false } = {}) {
  const root = mkdtempSync("/private/tmp/js2-5807-evidence-synthetic-");
  const trial = "replay5807-intervention-original";
  mkdirSync(join(root, trial));
  mkdirSync(join(root, "replay5807-traces"));
  const json = (path, data) => writeFileSync(join(root, path), JSON.stringify(data) + "\n");
  json("replay5807-trace-admission.json", { schema: "synthetic-observer" });
  json("replay5807-intervention-admission.json", { arm: "original", schema: "synthetic-intervention" });
  for (const name of ["launch.json", "admission.json"]) json(trial + "/" + name, { synthetic: true });
  for (const name of ["preserved-traces.json", "worker-terminals.json", "pre-exit-trace-inventory.json"])
    json(trial + "/" + name, []);
  json(trial + "/result.json", {
    observedVariantCount: 1,
    status: failed ? "INVALID_OR_INCOMPLETE_INTERVENTION" : "PRE_EXIT_DIAGNOSTIC_ONLY",
  });
  json(trial + "/request-1.json", { synthetic: true, raw: { status: "fail" } });
  json(trial + "/terminal.json", { code: failed ? 2 : 0, signal: null, pid: 10 });
  json(trial + "/final.json", {
    status: failed ? "INVALID_OR_INCOMPLETE_INTERVENTION" : "COMPLETE_LOCAL_DIAGNOSTIC_ONLY",
    stopReason: failed ? "synthetic failed audit" : null,
    audited: failed ? null : { synthetic: true },
    regressionCleared: false,
  });
  writeFileSync(join(root, trial, "stdout.log"), "");
  writeFileSync(join(root, trial, "stderr.log"), "synthetic raw stderr\n");
  for (const [pid, last] of [
    [10, "observer-exit"],
    [11, "request-end"],
  ]) {
    const rows = ["observer-boot", last].map((event, i) => ({
      schema: "issue-5807-observation-v1",
      pid,
      boot: "b" + pid,
      seq: i + 1,
      lost: 0,
      event,
    }));
    writeFileSync(
      join(root, "replay5807-traces", pid + "-synthetic.jsonl"),
      rows.map(JSON.stringify).join("\n") + "\n",
    );
  }
  return { root, trial, json, collect: () => collectRegistryInterventionEvidence(root, { processesExited: true }) };
}
test("complete capture hashes every raw file and both source/install receipts", () => {
  const x = fixture(),
    r = x.collect();
  assert.equal(r.captureStatus, "COMPLETE_RAW_CAPTURE");
  assert.equal(r.files.length, 15);
  assert.equal(r.traceFiles, 2);
  for (const file of r.files) assert.equal(file.sha256, sha(readFileSync(join(x.root, file.path))));
  assert.equal(r.regressionCleared, false);
});
test("audited:null failed final still captures all trace hashes and exact failed verdict", () => {
  const x = fixture({ failed: true }),
    r = x.collect();
  assert.equal(r.captureStatus, "COMPLETE_RAW_CAPTURE");
  assert.equal(r.traceFiles, 2);
  assert.equal(r.recordedVerdicts[0].status, "INVALID_OR_INCOMPLETE_INTERVENTION");
  assert.equal(r.recordedVerdicts[0].stopReason, "synthetic failed audit");
  assert.equal(r.recordedVerdicts[0].audited, null);
  assert.equal(r.recordedVerdicts[0].terminal.code, 2);
  assert.equal(r.regressionCleared, false);
});
test("recursive extra raw files are captured without altering originals", () => {
  const x = fixture();
  mkdirSync(join(x.root, x.trial, "extra"));
  writeFileSync(join(x.root, x.trial, "extra", "opaque.bin"), Buffer.from([0, 1, 255]));
  const before = x.collect();
  const after = x.collect();
  assert.deepEqual(before, after);
  assert.equal(after.files.length, 16);
  assert.equal(after.files.find((f) => f.path.endsWith("opaque.bin")).bytes, 3);
});
test("caller must explicitly confirm exit before any collection", () => {
  assert.throws(() => collectRegistryInterventionEvidence("/nonexistent"), /processes-exited/);
});
test("empty existing root is incomplete, not success", () => {
  const root = mkdtempSync("/private/tmp/js2-5807-evidence-empty-");
  const r = collectRegistryInterventionEvidence(root, { processesExited: true });
  assert.equal(r.captureStatus, "INCOMPLETE");
  assert.equal(r.files.length, 0);
  assert.ok(r.issues.length > 0);
});
for (const [name, mutate, pattern] of [
  [
    "missing trial file",
    (x) => renameSync(join(x.root, x.trial, "stdout.log"), join(x.root, "saved-stdout.log")),
    /required raw file/,
  ],
  [
    "missing trace",
    (x) => renameSync(join(x.root, "replay5807-traces/11-synthetic.jsonl"), join(x.root, "saved-trace.jsonl")),
    /minimum two/,
  ],
  [
    "partial trace",
    (x) => writeFileSync(join(x.root, "replay5807-traces/11-synthetic.jsonl"), '{"seq":1}'),
    /partial trace/,
  ],
  ["truncated JSON", (x) => writeFileSync(join(x.root, x.trial, "final.json"), '{"status":'), /partial JSON/],
  [
    "empty trace file",
    (x) => writeFileSync(join(x.root, "replay5807-traces/11-synthetic.jsonl"), ""),
    /empty\/partial trace/,
  ],
  [
    "trace gap",
    (x) => {
      const p = join(x.root, "replay5807-traces/11-synthetic.jsonl");
      writeFileSync(p, readFileSync(p, "utf8").replace('"seq":2', '"seq":3'));
    },
    /trace gap/,
  ],
  [
    "boot-only trace",
    (x) => {
      const p = join(x.root, "replay5807-traces/11-synthetic.jsonl");
      writeFileSync(p, readFileSync(p, "utf8").split("\n")[0] + "\n");
    },
    /incomplete final trace tail/,
  ],
  ["zero requests", (x) => x.json(x.trial + "/result.json", { observedVariantCount: 0 }), /request count/],
  [
    "missing request",
    (x) => renameSync(join(x.root, x.trial, "request-1.json"), join(x.root, "saved-request.json")),
    /raw request receipts/,
  ],
  ["missing installed arm", (x) => x.json("replay5807-intervention-admission.json", {}), /installed arm/],
  ["malformed terminal", (x) => x.json(x.trial + "/terminal.json", {}), /terminal outcome/],
  ["read fault via nonregular file", (x) => mkdirSync(join(x.root, x.trial, "extra.json")), /./],
])
  test(`incomplete: ${name}`, () => {
    const x = fixture();
    mutate(x);
    const r = x.collect();
    if (name === "read fault via nonregular file") {
      // A directory is traversable, not a read fault. Make its child a symlink;
      // the collector must refuse dereferencing outside its evidence population.
      symlinkSync("../../../../", join(x.root, x.trial, "extra.json", "escape"));
      const fault = x.collect();
      assert.equal(fault.captureStatus, "INCOMPLETE");
      assert.ok(fault.issues.some((i) => /nonregular/.test(i.reason)));
      return;
    }
    assert.equal(r.captureStatus, "INCOMPLETE");
    assert.ok(
      r.issues.some((i) => pattern.test(i.reason)),
      JSON.stringify(r.issues),
    );
  });
test("symlinked root rejected without reading outside evidence", () => {
  const x = fixture(),
    alias = x.root + "-alias";
  symlinkSync(x.root, alias);
  assert.equal(collectRegistryInterventionEvidence(alias, { processesExited: true }).captureStatus, "INCOMPLETE");
});
test("CLI rejects missing confirmation, extra flags and duplicate roots", () => {
  assert.throws(() => main([]), /usage/);
  assert.throws(() => main(["--processes-exited", "--other"]), /usage/);
  assert.throws(() => main(["--processes-exited", "/same", "/same"]), /duplicate/);
});
