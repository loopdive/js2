// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Tables for the ES5 IR-only census write-up, from census.mts rows.
 *
 *   node scripts/ir-census/analyze.mjs --rows <today.jsonl> [--base <older.jsonl>]
 *        [--top 40] [--greedy 25] [--json <summary.json>]
 *
 * Prints Markdown: headline, gained/lost against `--base`, refusal reasons by
 * files carrying and by sole-blocker count, a greedy set cover, levers
 * (levers.mjs) alone and stacked, and the per-directory table.
 * - "sole blocker" = the only reason of a blocked file;
 * - "files carrying" = blocked files where the reason appears;
 * - a lever "frees" a blocked file when every reason of the file is in it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LEVERS, leverOf } from "./levers.mjs";
import { fileReasons } from "./reasons.mjs";

function arg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function readRows(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const compiled = (row) => row.status === "compiled";
const passing = (row) => row.standalone?.status === "pass";
const pct = (part, whole) => `${((100 * part) / whole).toFixed(1)} %`;
const table = (head, rows) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join(
    "\n",
  );

function headline(rows) {
  const done = rows.filter(compiled);
  const irOnly = done.filter((row) => row.irOnly);
  const blocked = done.filter((row) => !row.irOnly);
  const reasonCounts = new Map();
  for (const row of blocked)
    for (const reason of row.reasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  const histogram = [1, 2, 3, 4, 5].map(
    (n) => blocked.filter((row) => (n < 5 ? row.reasons.size === n : row.reasons.size >= 5)).length,
  );
  return {
    files: rows.length,
    skipped: rows.filter((row) => row.status === "skip").length,
    notCompiled: rows.filter((row) => !compiled(row) && row.status !== "skip").length,
    compiled: done.length,
    irOnly: irOnly.length,
    irOnlyRun: irOnly.filter((row) => row.standalone).length,
    irOnlyPass: irOnly.filter(passing).length,
    blocked: blocked.length,
    postClaimFiles: done.filter((row) => row.postClaim > 0).length,
    reasons: reasonCounts.size,
    histogram,
    reasonCounts,
  };
}

function headlineTable(today, base) {
  const keys = [
    ["ES5 files", "files"],
    ["skipped (negative, raw, module, runner skip)", "skipped"],
    ["not compiled (compile error, throw, timeout)", "notCompiled"],
    ["compiled", "compiled"],
    ["**IR-only**", "irOnly"],
    ["IR-only AND standalone pass", "irOnlyPass"],
    ["blocked", "blocked"],
    ["files with post-claim errors", "postClaimFiles"],
    ["distinct refusal reasons", "reasons"],
  ];
  const head = base ? ["", "base", "today", "change"] : ["", "today"];
  const rows = keys.map(([label, key]) => {
    const cells = base ? [base[key], today[key], today[key] - base[key]] : [today[key]];
    return [label, ...cells.map(String)];
  });
  const histogram = (h) => `one ${h[0]} · two ${h[1]} · three ${h[2]} · four ${h[3]} · five or more ${h[4]}`;
  return `${table(head, rows)}\n\nBlocked files by reasons carried: ${histogram(today.histogram)}${base ? ` (base: ${histogram(base.histogram)})` : ""}.`;
}

function flips(today, base) {
  const before = new Map(base.map((row) => [row.file, row]));
  const gained = [];
  const lost = [];
  for (const row of today) {
    const old = before.get(row.file);
    const was = old !== undefined && compiled(old) && old.irOnly;
    const is = compiled(row) && row.irOnly;
    if (is && !was) gained.push(row.file);
    if (was && !is) lost.push(row.file);
  }
  return { gained: gained.sort(), lost: lost.sort() };
}

function reasonTables(summary, blocked, top) {
  const sole = new Map();
  for (const row of blocked)
    if (row.reasons.size === 1) for (const r of row.reasons) sole.set(r, (sole.get(r) ?? 0) + 1);
  const entries = [...summary.reasonCounts].map(([reason, carrying]) => ({
    reason,
    carrying,
    sole: sole.get(reason) ?? 0,
  }));
  const render = (list) =>
    table(
      ["#", "reason", "files carrying", "sole blocker", "lever"],
      list
        .slice(0, top)
        .map((e, i) => [
          String(i + 1),
          `\`${e.reason}\``,
          String(e.carrying),
          String(e.sole),
          leverOf(e.reason)?.id ?? "",
        ]),
    );
  const byCarrying = [...entries].sort((a, b) => b.carrying - a.carrying || b.sole - a.sole);
  const bySole = [...entries].sort((a, b) => b.sole - a.sole || b.carrying - a.carrying);
  return { byCarrying: render(byCarrying), bySole: render(bySole), bySoleEntries: bySole };
}

function greedy(blocked, startIrOnly, steps) {
  const removed = new Set();
  const out = [];
  let irOnly = startIrOnly;
  let left = blocked.map((row) => new Set(row.reasons));
  for (let step = 1; step <= steps && left.length > 0; step++) {
    const frees = new Map();
    const nearly = new Map();
    for (const reasons of left) {
      if (reasons.size === 1) for (const r of reasons) frees.set(r, (frees.get(r) ?? 0) + 1);
      if (reasons.size === 2) for (const r of reasons) nearly.set(r, (nearly.get(r) ?? 0) + 1);
    }
    const candidates = new Set([...frees.keys(), ...nearly.keys()]);
    const score = (r) => [frees.get(r) ?? 0, nearly.get(r) ?? 0];
    const best = [...candidates].sort(
      (a, b) => score(b)[0] - score(a)[0] || score(b)[1] - score(a)[1] || a.localeCompare(b),
    )[0];
    if (best === undefined) break;
    removed.add(best);
    const freed = frees.get(best) ?? 0;
    irOnly += freed;
    left = left.map((reasons) => new Set([...reasons].filter((r) => r !== best))).filter((reasons) => reasons.size > 0);
    out.push([String(step), `\`${best}\``, String(freed), String(irOnly)]);
  }
  return table(["step", "reason", "files freed", "IR-only after"], out);
}

/** Files a set of levers frees: every reason of the file belongs to one of them. */
function freedBy(blocked, ids) {
  return blocked.filter((row) => [...row.reasons].every((r) => ids.has(leverOf(r)?.id))).length;
}

function leverTable(blocked, summary) {
  const rows = [];
  const stack = [];
  const ranked = LEVERS.map((lever) => ({ lever, alone: freedBy(blocked, new Set([lever.id])) }))
    .map((entry) => ({
      ...entry,
      carrying: blocked.filter((row) => [...row.reasons].some((r) => leverOf(r)?.id === entry.lever.id)).length,
      reasons: [...summary.reasonCounts.keys()].filter((r) => leverOf(r)?.id === entry.lever.id).length,
    }))
    .sort((a, b) => b.alone - a.alone || b.carrying - a.carrying);
  for (const { lever, alone, carrying, reasons } of ranked) {
    stack.push(lever.id);
    const withTwo = freedBy(blocked, new Set(stack.slice(-3)));
    const cumulative = freedBy(blocked, new Set(stack));
    rows.push([
      lever.id,
      lever.issue,
      String(reasons),
      String(carrying),
      String(alone),
      String(withTwo),
      String(cumulative),
    ]);
  }
  const unmapped = blocked.filter((row) => [...row.reasons].some((r) => !leverOf(r))).length;
  return `${table(
    ["lever", "issue", "reasons", "files carrying", "frees alone", "with the two before", "all levers so far"],
    rows,
  )}\n\nBlocked files carrying a reason no lever covers: ${unmapped}.`;
}

function directoryTable(rows) {
  const dirs = new Map();
  for (const row of rows) {
    const parts = row.file.split("/");
    const key = parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0];
    const d = dirs.get(key) ?? { files: 0, compiled: 0, irOnly: 0, pass: 0 };
    d.files += 1;
    if (compiled(row)) d.compiled += 1;
    if (compiled(row) && row.irOnly) d.irOnly += 1;
    if (compiled(row) && row.irOnly && passing(row)) d.pass += 1;
    dirs.set(key, d);
  }
  return table(
    ["directory", "files", "compiled", "IR-only", "IR-only and pass", "blocked"],
    [...dirs]
      .sort((a, b) => b[1].files - a[1].files)
      .map(([dir, d]) => [`\`${dir}\``, d.files, d.compiled, d.irOnly, d.pass, d.compiled - d.irOnly].map(String)),
  );
}

function withReasons(rows) {
  return rows.map((row) =>
    compiled(row) && !row.irOnly ? { ...row, reasons: fileReasons(row) } : { ...row, reasons: new Set() },
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const today = withReasons(readRows(arg("--rows")));
  const basePath = arg("--base");
  const base = basePath ? withReasons(readRows(basePath)) : undefined;
  const top = Number(arg("--top", 40));
  const summary = headline(today);
  const blocked = today.filter((row) => compiled(row) && !row.irOnly);
  const sections = [`## Headline\n\n${headlineTable(summary, base && headline(base))}`];
  sections.push(
    `IR-only files run: ${summary.irOnlyRun} of ${summary.irOnly}; passing ${summary.irOnlyPass} (${pct(summary.irOnlyPass, summary.compiled)} of compiled).`,
  );
  if (base) {
    const { gained, lost } = flips(today, base);
    sections.push(
      `## Gained (${gained.length}) / lost (${lost.length})\n\nLost:\n${lost.map((f) => `- \`${f}\``).join("\n") || "- none"}`,
    );
  }
  const reasons = reasonTables(summary, blocked, top);
  sections.push(`## Reasons by files carrying\n\n${reasons.byCarrying}`);
  sections.push(`## Reasons by sole-blocker count\n\n${reasons.bySole}`);
  sections.push(
    `## Greedy set cover (start ${summary.irOnly})\n\n${greedy(blocked, summary.irOnly, Number(arg("--greedy", 25)))}`,
  );
  sections.push(`## Levers\n\n${leverTable(blocked, summary)}`);
  sections.push(`## Per directory\n\n${directoryTable(today)}`);
  console.log(sections.join("\n\n"));
  const jsonOut = arg("--json");
  if (jsonOut) {
    const { reasonCounts, ...rest } = summary;
    const flipped = base ? flips(today, base) : undefined;
    writeFileSync(jsonOut, `${JSON.stringify({ ...rest, ...(flipped ?? {}) }, null, 2)}\n`);
  }
}
