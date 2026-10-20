#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6920 — derive a `successor` epoch for one pinned successor record.
//
// A successor record (tests/helpers/ir-*-successor.json) pins the exact bytes
// of source, test and policy files at the epoch it was measured on, and maps
// them back to a historical "before" through recorded byte-span edits. When
// main moves one of those files, every pin breaks. This script derives the
// next epoch from the reconciled tree instead of re-pinning checksums: for
// every pinned path whose live bytes differ from the pin, it reconstructs the
// pinned text from `--base <rev>` (refusing if that text does not match the
// pin), records the exact byte-span edits from the pinned text to the live
// text, and — for a policy record — the rows inserted into
// scripts/compiler-boundaries.json. The reader applies the successor first
// (live → pinned epoch), then the record's original epoch unchanged, and
// replays both directions. The original epoch's data is never edited.
//
//   node scripts/derive-successor-epoch.mjs tests/helpers/<record>.json --base <rev> [--head <label>]
//
// It rewrites the record (prettier-formatted) and the receipt constants in the
// sibling helper (.ts). Records that pin each other must be derived in
// dependency order (a record before the records that pin its helper files).
// Readers are layered in the tests (one record's reader feeds the next), so a
// pin that is a lower layer's output rather than the raw file is left to that
// layer: only paths this record reads raw get a successor transform.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const POLICY = "scripts/compiler-boundaries.json";
const REPO = resolve(new URL("..", import.meta.url).pathname);

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function pin(text) {
  const buf = Buffer.from(text);
  return {
    bytes: buf.length,
    sha256: sha256(buf),
    gitBlob: createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex"),
  };
}
const samePin = (a, b) => a.bytes === b.bytes && a.sha256 === b.sha256 && a.gitBlob === b.gitBlob;
const read = (path) => readFileSync(join(REPO, path), "utf8");
const gitShow = (rev, path) => execFileSync("git", ["-C", REPO, "show", `${rev}:${path}`], { encoding: "utf8" });

/** Exact byte-span edits from `before` to `current`, in each text's own coordinates (git -U0 hunks). */
function byteEdits(before, current) {
  const dir = mkdtempSync(join(tmpdir(), "epoch-"));
  const a = join(dir, "a"),
    b = join(dir, "b");
  writeFileSync(a, before);
  writeFileSync(b, current);
  let out = "";
  try {
    execFileSync("git", ["diff", "--no-index", "--unified=0", "--no-color", a, b], { encoding: "utf8" });
  } catch (error) {
    if (error.status !== 1) throw error;
    out = error.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const offsets = (text) => {
    const lines = text.split(/(?<=\n)/);
    const starts = [0];
    for (const line of lines) starts.push(starts[starts.length - 1] + Buffer.byteLength(line));
    return (lineIndex) => starts[Math.min(lineIndex, starts.length - 1)];
  };
  const beforeAt = offsets(before),
    currentAt = offsets(current);
  const beforeBuf = Buffer.from(before),
    currentBuf = Buffer.from(current);
  const edits = [];
  for (const m of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const a1 = Number(m[1]),
      an = m[2] === undefined ? 1 : Number(m[2]);
    const c1 = Number(m[3]),
      cn = m[4] === undefined ? 1 : Number(m[4]);
    const beforeStart = an === 0 ? beforeAt(a1) : beforeAt(a1 - 1);
    const beforeEnd = an === 0 ? beforeStart : beforeAt(a1 - 1 + an);
    const currentStart = cn === 0 ? currentAt(c1) : currentAt(c1 - 1);
    const currentEnd = cn === 0 ? currentStart : currentAt(c1 - 1 + cn);
    edits.push({
      beforeStart,
      beforeEnd,
      beforeText: beforeBuf.subarray(beforeStart, beforeEnd).toString("utf8"),
      currentStart,
      currentEnd,
      currentText: currentBuf.subarray(currentStart, currentEnd).toString("utf8"),
    });
  }
  return edits;
}
function replay(text, edits, inverse) {
  let bytes = Buffer.from(text);
  for (const edit of [...edits].reverse()) {
    const start = inverse ? edit.currentStart : edit.beforeStart;
    const end = inverse ? edit.currentEnd : edit.beforeEnd;
    const from = inverse ? edit.currentText : edit.beforeText;
    const to = inverse ? edit.beforeText : edit.currentText;
    if (bytes.subarray(start, end).toString("utf8") !== from) throw new Error("edit replay mismatch");
    bytes = Buffer.concat([bytes.subarray(0, start), Buffer.from(to), bytes.subarray(end)]);
  }
  return bytes.toString("utf8");
}
function profile(raw) {
  const parsed = JSON.parse(raw);
  return {
    source: pin(raw),
    count: parsed.files.length,
    data: sha256(JSON.stringify(parsed)),
    files: sha256(JSON.stringify(parsed.files)),
    nonFiles: sha256(JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "files")))),
  };
}
/** Rows inserted into `files` between two policy texts; refuses any removal or in-place change. */
function insertedRows(beforeRaw, currentRaw) {
  const before = JSON.parse(beforeRaw).files,
    current = JSON.parse(currentRaw).files;
  const inserted = [];
  let i = 0;
  for (let j = 0; j < current.length; j++) {
    if (i < before.length && JSON.stringify(before[i]) === JSON.stringify(current[j])) i++;
    else inserted.push({ index: j, row: current[j] });
  }
  if (i !== before.length) throw new Error("policy rows were removed or changed; only insertions can be derived");
  const check = [...before];
  for (const { index, row } of inserted) check.splice(index, 0, row);
  if (JSON.stringify(check) !== JSON.stringify(current)) throw new Error("inserted-row replay mismatch");
  return inserted;
}

/**
 * Every (path, pin) the record authenticates against the live tree, in the
 * order its reader reads them (B's suites pin the exact physical read sequence).
 */
function pinnedPaths(record) {
  const out = new Map();
  const add = (row) => {
    if (row && typeof row.path === "string" && typeof row.sha256 === "string" && !out.has(row.path))
      out.set(row.path, row);
  };
  const isPolicy = Boolean(record.current && record.current.source && typeof record.before?.count === "number");
  if (isPolicy) out.set(POLICY, { path: POLICY, ...record.current.source });
  // Read orders: policy records read policy, callers, anchors; class-layout reads
  // current, anchors; the source record reads sources, anchors, callers.
  const order = isPolicy ? ["callers", "anchors"] : ["sources", "current", "anchors", "callers"];
  for (const key of order) if (Array.isArray(record[key])) for (const row of record[key]) add(row);
  for (const t of record.transforms ?? []) if (t.current) add({ path: t.path, ...t.current });
  return out;
}

/**
 * `epoch`: the reader replays the live file back to the record's epoch (source
 * and policy files). `live`: the reader keeps the live text and authenticates
 * it against the successor pin — helper code and data another record pins
 * must agree with the live helper module, so they are re-pinned here with
 * the edits kept as the audit trail.
 */
const modeOf = (path) => (path.startsWith("tests/") ? "live" : "epoch");

function main(argv) {
  const recordPath = argv.find((a) => !a.startsWith("--"));
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const base = flag("--base");
  if (!recordPath || !base) {
    console.error("usage: derive-successor-epoch.mjs <record.json> --base <rev> [--head <label>]");
    return 2;
  }
  const head = flag("--head") ?? execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const helperPath = recordPath.replace(/\.json$/, ".ts");
  const record = JSON.parse(read(recordPath));
  if (record.successor) throw new Error("record already carries a successor epoch; chain a new record instead");
  const transforms = [];
  let policy;
  for (const [path, pinned] of pinnedPaths(record)) {
    const live = read(path);
    if (samePin(pin(live), pinned)) continue;
    const epochText = gitShow(base, path);
    if (samePin(pin(epochText), pin(live))) continue; // unchanged since the base; a lower reader layer owns the pin
    if (!samePin(pin(epochText), pinned)) {
      // A lower reader layer owns this path (the pin is that layer's output, not the raw file).
      console.log(`  ${path}: changed since ${base.slice(0, 8)}, but the pin belongs to a lower reader layer; skipped`);
      continue;
    }
    const edits = byteEdits(epochText, live);
    if (replay(live, edits, true) !== epochText || replay(epochText, edits, false) !== live)
      throw new Error(`${path}: edit replay is not reciprocal`);
    transforms.push({ path, mode: modeOf(path), before: pin(epochText), current: pin(live), edits });
    if (path === POLICY) {
      policy = { before: profile(epochText), current: profile(live), inserted: insertedRows(epochText, live) };
    }
  }
  if (transforms.length === 0) {
    console.log(`${recordPath}: every pin matches the live tree; nothing to derive`);
    return 0;
  }
  record.successor = { base, head, transforms, ...(policy ? { policy } : {}) };
  writeFileSync(join(REPO, recordPath), `${JSON.stringify(record, null, 2)}\n`);
  execFileSync("npx", ["prettier", "--write", recordPath], { cwd: REPO, stdio: "ignore" });
  const raw = read(recordPath);
  const bytes = Buffer.byteLength(raw);
  const rawHash = sha256(raw);
  const dataHash = sha256(JSON.stringify(JSON.parse(raw)));
  let helper = read(helperPath);
  const replaceConst = (name, value) => {
    const re = new RegExp(`(const ${name} = )(?:\\d+|"[0-9a-f]+")(;)`);
    if (!re.test(helper)) return false;
    helper = helper.replace(re, `$1${typeof value === "number" ? value : JSON.stringify(value)}$2`);
    return true;
  };
  replaceConst("receiptBytes", bytes);
  if (!replaceConst("receiptHash", rawHash) && !replaceConst("receiptSha256", rawHash))
    throw new Error("helper has no raw receipt hash constant");
  replaceConst("receiptDataHash", dataHash);
  replaceConst("canonicalReceiptSha256", dataHash);
  writeFileSync(join(REPO, helperPath), helper);
  console.log(
    `${recordPath}: successor epoch ${base.slice(0, 8)} → ${head.slice(0, 8)}: ${transforms.length} transform(s)` +
      (policy ? `, ${policy.inserted.length} inserted policy row(s)` : "") +
      `; receipt ${bytes} bytes`,
  );
  for (const t of transforms) console.log(`  ${t.path}: ${t.edits.length} edit(s)`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
