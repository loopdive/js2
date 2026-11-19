// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Per-mechanism file lists from prepared-census.mts rows: one `<slug>.tsv` per
 * first-gap mechanism (prepared-mechanisms.mjs), rows `file<TAB>gap detail`.
 *
 *   node scripts/ir-census/prepared-lists.mjs --rows <prepared.jsonl> --out <dir>
 *
 * Re-measure one list after a slice:
 *   cut -f1 <dir>/<slug>.tsv > .tmp/subset.txt
 *   npx tsx scripts/ir-census/prepared-census.mts --files .tmp/subset.txt \
 *     --out .tmp/subset.jsonl --harness stand-in
 *   node scripts/ir-census/prepared-analyze.mjs --rows .tmp/subset.jsonl
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { readRows } from "./analyze.mjs";
import { mechanismOf } from "./prepared-mechanisms.mjs";

const TEST262 = resolve(import.meta.dirname, "../../test262");

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function listOf(row) {
  return slug(mechanismOf(row, readFileSync(join(TEST262, "test", row.file), "utf8")));
}

const out = resolve(arg("--out"));
mkdirSync(out, { recursive: true });
const lists = new Map();
for (const row of readRows(arg("--rows"))) {
  if (row.status !== "compile_error" && row.status !== "crash") continue;
  const name = listOf(row);
  const line = `${row.file}\t${(row.detail ?? "").replace(/\s+/g, " ").slice(0, 120)}`;
  lists.set(name, [...(lists.get(name) ?? []), line]);
}
for (const [name, lines] of [...lists].sort((a, b) => b[1].length - a[1].length)) {
  writeFileSync(join(out, `${name}.tsv`), `${lines.sort().join("\n")}\n`);
  console.log(`${String(lines.length).padStart(5)}  ${name}.tsv`);
}
