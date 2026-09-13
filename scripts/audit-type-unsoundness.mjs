// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Reproduce the finite unsoundness matrix in fresh Node/Wasm processes. */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = resolve(root, "plan/audit/type-unsoundness-2026-09-08/cases.json");
const output = resolve(process.argv[2] ?? ".tmp/unsoundness-candidate.jsonl");
const cases = JSON.parse(readFileSync(spec, "utf8"));
if (cases.length !== 26 || new Set(cases.map((row) => row.id)).size !== 26)
  throw new Error("Audit specimen inventory changed; update its explicit denominator");
const compilerCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain", "--", "src"], { cwd: root, encoding: "utf8" }).trim().length > 0;
function sourceFingerprint() {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .sort();
  const hash = createHash("sha256");
  for (const file of files)
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(resolve(root, file)))
      .update("\0");
  return hash.digest("hex");
}
const sourceTreeSha256 = sourceFingerprint();
const specimensSha256 = createHash("sha256").update(readFileSync(spec)).digest("hex");
writeFileSync(output, "");
let matches = 0;
let diagnostics = 0;
let failures = 0;
for (const specimen of cases) {
  let reference;
  for (const lane of ["node", "gc", "standalone"]) {
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-wasm-exnref",
        "--import",
        "tsx",
        resolve(root, "scripts/audit-type-unsoundness-probe.ts"),
        spec,
        specimen.id,
        lane,
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (child.status !== 0) throw new Error(`${specimen.id}/${lane} probe failed: ${child.stderr}`);
    const row = JSON.parse(child.stdout.trim());
    appendFileSync(
      output,
      `${JSON.stringify({ compilerCommit, dirty, sourceTreeSha256, specimensSha256, nodeVersion: process.version, ...row })}\n`,
    );
    if (lane === "node") {
      if (row.status !== "ran") throw new Error(`Reference did not execute: ${specimen.id}`);
      reference = row.output;
    } else if (specimen.expected[lane] === "diagnostic") {
      const actionable =
        row.status === "compile_error" &&
        row.errors?.some(
          (error) =>
            error.severity === "error" &&
            /^\[JS2WASM_(UNSOUND|UNSUPPORTED)_/.test(error.message) &&
            error.file &&
            error.line > 0 &&
            error.column > 0,
        );
      if (actionable) diagnostics++;
      else failures++;
    } else if (row.status === "ran" && JSON.stringify(row.output) === JSON.stringify(reference)) {
      matches++;
    } else failures++;
  }
  console.log(`${specimen.id}: measured Node + 2 Wasm lanes`);
}
console.log(
  JSON.stringify({
    sourcePrograms: cases.length,
    referenceRuns: cases.length,
    wasmRuns: cases.length * 2,
    matches,
    diagnostics,
    failures,
    output,
  }),
);
if (sourceFingerprint() !== sourceTreeSha256)
  throw new Error("Compiler sources changed during the audit; discard this run and rerun after edits finish");
if (failures) process.exitCode = 1;
