// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Post-exit READ-ONLY evidence collector. No subject/control-code imports.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ARMS = ["original", "sham", "reset"];
const RECEIPTS = ["replay5807-trace-admission.json", "replay5807-intervention-admission.json"];
const REQUIRED = [
  "launch.json",
  "admission.json",
  "preserved-traces.json",
  "worker-terminals.json",
  "pre-exit-trace-inventory.json",
  "result.json",
  "terminal.json",
  "final.json",
  "stdout.log",
  "stderr.log",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function collectRegistryInterventionEvidence(root, { processesExited = false } = {}) {
  if (processesExited !== true)
    throw new Error("explicit processes-exited confirmation required; collector cannot prove liveness");
  root = resolve(root);
  const files = [],
    issues = [],
    parsed = new Map(),
    directories = new Map();
  const issue = (path, reason) => issues.push({ path, reason });
  const exists = (path) => {
    try {
      return lstatSync(join(root, path));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      issue(path, "stat fault: " + error.message);
      return null;
    }
  };
  function file(path) {
    try {
      const full = join(root, path),
        before = lstatSync(full);
      if (!before.isFile() || before.isSymbolicLink()) {
        issue(path, "nonregular file or symlink");
        return;
      }
      const bytes = readFileSync(full),
        after = lstatSync(full);
      files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
      if (
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        bytes.length !== after.size
      )
        issue(path, "file changed during capture");
      if (path.endsWith(".json")) {
        try {
          parsed.set(path, JSON.parse(bytes.toString("utf8")));
        } catch (error) {
          issue(path, "invalid/partial JSON: " + error.message);
        }
      } else if (path.endsWith(".jsonl")) {
        const text = bytes.toString("utf8");
        if (!text || !text.endsWith("\n")) issue(path, "empty/partial trace; missing final newline");
        try {
          const records = text.trimEnd().split("\n").map(JSON.parse);
          if (!records.length || records[0]?.event !== "observer-boot") issue(path, "missing trace boot");
          if (records.length < 2 || !["observer-exit", "request-end"].includes(records.at(-1)?.event))
            issue(path, "silent-empty/incomplete final trace tail");
          for (const [i, r] of records.entries()) {
            if (
              !r ||
              r.seq !== i + 1 ||
              r.lost !== 0 ||
              r.boot !== records[0]?.boot ||
              r.pid !== records[0]?.pid ||
              r.schema !== "issue-5807-observation-v1"
            )
              issue(path, "trace gap/loss/identity/schema fault at record " + (i + 1));
          }
          parsed.set(path, records);
        } catch (error) {
          issue(path, "invalid/partial JSONL: " + error.message);
        }
      }
    } catch (error) {
      issue(path, "read fault: " + error.message);
    }
  }
  function tree(path) {
    try {
      const st = exists(path);
      if (!st?.isDirectory() || st.isSymbolicLink()) {
        issue(path, "missing/nonregular directory");
        return;
      }
      const names = readdirSync(join(root, path)).sort();
      directories.set(path, names);
      for (const name of names) {
        const next = path + "/" + name,
          child = exists(next);
        if (child?.isDirectory() && !child.isSymbolicLink()) tree(next);
        else file(next);
      }
    } catch (error) {
      issue(path, "directory fault: " + error.message);
    }
  }
  try {
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error("aliased/non-directory root");
  } catch (error) {
    return {
      schema: "issue-5807-registry-intervention-evidence-v1",
      root,
      captureStatus: "INCOMPLETE",
      files,
      issues: [{ path: root, reason: error.message }],
      recordedVerdicts: [],
      regressionCleared: false,
    };
  }
  for (const path of RECEIPTS) file(path);
  const install = parsed.get(RECEIPTS[1]);
  if (!ARMS.includes(install?.arm)) issue(RECEIPTS[1], "missing/invalid installed arm");
  const present = ARMS.filter((arm) => exists("replay5807-intervention-" + arm));
  if (!present.length) issue(root, "silent-empty: no trial directory");
  if (ARMS.includes(install?.arm) && !present.includes(install.arm))
    issue(root, "installed arm trial directory missing");
  if (present.some((arm) => arm !== install?.arm))
    issue(root, "trial directory differs from installed arm (all captured)");
  tree("replay5807-traces");
  const traces = files.filter((f) => f.path.startsWith("replay5807-traces/") && f.path.endsWith(".jsonl"));
  if (traces.length < 2) issue("replay5807-traces", "silent-empty/missing controller or worker trace (minimum two)");
  const recordedVerdicts = [];
  for (const arm of present) {
    const dir = "replay5807-intervention-" + arm;
    tree(dir);
    for (const name of REQUIRED)
      if (!files.some((f) => f.path === dir + "/" + name))
        issue(dir + "/" + name, "required raw file missing/unreadable");
    const result = parsed.get(dir + "/result.json"),
      terminal = parsed.get(dir + "/terminal.json"),
      final = parsed.get(dir + "/final.json");
    const count = result?.observedVariantCount;
    if (!Number.isInteger(count) || count < 1 || count > 4)
      issue(dir + "/result.json", "missing/invalid observed request count");
    else {
      const expected = Array.from({ length: count }, (_, i) => "request-" + (i + 1) + ".json");
      const actual = (directories.get(dir) ?? []).filter((name) => /^request-.*\.json$/.test(name));
      if (JSON.stringify(actual.sort()) !== JSON.stringify(expected.sort()))
        issue(dir, "missing/extra raw request receipts");
    }
    if (
      !terminal ||
      !(
        Number.isInteger(terminal.code) ||
        (terminal.code === null && (typeof terminal.signal === "string" || typeof terminal.error === "string"))
      )
    )
      issue(dir + "/terminal.json", "missing/invalid terminal outcome");
    if (!final || typeof final.status !== "string" || !Object.hasOwn(final, "stopReason"))
      issue(dir + "/final.json", "missing/invalid final verdict");
    // Exact recorded values, not a reinterpretation: a failed audit stays failed.
    // Raw final.json bytes are separately hashed; never emit source/program bodies.
    recordedVerdicts.push({
      arm,
      finalPath: dir + "/final.json",
      status: final?.status ?? null,
      stopReason: final?.stopReason ?? null,
      audited: final
        ? Object.hasOwn(final, "audited")
          ? final.audited === null
            ? null
            : "present-see-hashed-final"
          : "missing"
        : "missing",
      resultStatus: result?.status ?? null,
      terminal: terminal ?? null,
    });
  }
  // Detect membership changes, without modifying or locking a live producer.
  for (const [path, before] of directories) {
    try {
      if (JSON.stringify(readdirSync(join(root, path)).sort()) !== JSON.stringify(before))
        issue(path, "directory changed during capture");
    } catch (error) {
      issue(path, "directory disappeared/fault: " + error.message);
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    schema: "issue-5807-registry-intervention-evidence-v1",
    root,
    captureStatus: issues.length ? "INCOMPLETE" : "COMPLETE_RAW_CAPTURE",
    processesExitedUserConfirmed: true,
    livenessLimit: "Caller confirms all producers exited; collector does not independently establish process liveness.",
    traceFiles: traces.length,
    files,
    issues,
    recordedVerdicts,
    regressionCleared: false,
    meaning: "Raw capture completeness only, never diagnostic acceptance or merge clearance.",
  };
}

export function main(argv = process.argv.slice(2)) {
  if (
    argv[0] !== "--processes-exited" ||
    argv.length < 2 ||
    argv.length > 7 ||
    argv.slice(1).some((arg) => arg.startsWith("--"))
  )
    throw new Error(
      "usage: node issue-5807-registry-intervention-evidence.mjs --processes-exited <subject-root> [up to six roots]",
    );
  const roots = argv.slice(1).map((root) => resolve(root));
  if (new Set(roots).size !== roots.length) throw new Error("duplicate subject root");
  const subjects = roots.map((root) => collectRegistryInterventionEvidence(root, { processesExited: true }));
  process.exitCode = subjects.some((subject) => subject.captureStatus === "INCOMPLETE") ? 2 : 0;
  return { schema: "issue-5807-registry-intervention-evidence-set-v1", subjects, regressionCleared: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(main(), null, 2));
