#!/usr/bin/env node
// Audit `as unknown as Instr` cast usage in src/.
//
// Walks every TypeScript file under src/, finds occurrences of
// `as unknown as Instr`, attempts to extract the Wasm op being emitted
// from the surrounding text, groups by op name, and writes a categorised
// report to plan/log/instr-cast-inventory.md.
//
// Usage: node scripts/audit-instr-casts.mjs

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = join(ROOT, "src");
const REPORT = join(ROOT, "plan/log/instr-cast-inventory.md");
const NEEDLE = "as unknown as Instr";

/** Recursively walk a directory yielding absolute file paths. */
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      yield* walk(abs);
    } else if (st.isFile() && abs.endsWith(".ts")) {
      yield abs;
    }
  }
}

/**
 * Given a string of source text up to (but not including) `as unknown as Instr`,
 * extract the Wasm op name being emitted.
 *
 * Patterns we handle (heuristic, not a parser):
 *   { op: "f64.copysign" }
 *   { op: "f64.copysign", ... }
 *   { op: "ref.cast", typeIdx: ... }
 *   { op: jsBitwiseToI32(instr.op) }   -> op is a dynamic expression
 *   { op: instr.op }                    -> dynamic
 *
 * Returns the literal op string when present, otherwise a synthetic marker
 * starting with "<dynamic:".
 */
function extractOp(prefix) {
  // Search backwards for the nearest `{ op: ...` clause.
  // Use a regex that matches the closest `op:` literal pattern.
  const matchesLit = [...prefix.matchAll(/\bop\s*:\s*"([^"]+)"/g)];
  if (matchesLit.length > 0) {
    return matchesLit[matchesLit.length - 1][1];
  }
  const matchesDyn = [...prefix.matchAll(/\bop\s*:\s*([A-Za-z_$][\w.$()]*)/g)];
  if (matchesDyn.length > 0) {
    return `<dynamic:${matchesDyn[matchesDyn.length - 1][1]}>`;
  }
  return "<unknown>";
}

/**
 * For each match of NEEDLE in the file, look back up to a small window
 * of bytes to find the op literal. We rewind to the nearest preceding
 * `{` then scan forward inside that brace pair for `op: "..."`.
 */
function findOccurrences(text, file) {
  const occs = [];
  let from = 0;
  while (true) {
    const idx = text.indexOf(NEEDLE, from);
    if (idx === -1) break;

    // Find the line number for reporting
    const lineNo = text.slice(0, idx).split("\n").length;

    // Skip comment / string mentions (we only count active casts).
    // Heuristic: walk back to start of the line and check whether the
    // match is preceded by `//` or sits inside a backtick run.
    const lineStart = text.lastIndexOf("\n", idx - 1) + 1;
    const linePrefix = text.slice(lineStart, idx);
    const beforeSlashSlash = linePrefix.indexOf("//");
    if (beforeSlashSlash >= 0) {
      from = idx + NEEDLE.length;
      continue;
    }
    // Crude check: equal numbers of backticks before the match on this
    // line implies we're outside a template string.
    const backticks = (linePrefix.match(/`/g) ?? []).length;
    if (backticks % 2 === 1) {
      from = idx + NEEDLE.length;
      continue;
    }

    // The cast `as unknown as Instr` comes right after a `}` that closes
    // the object literal we want to inspect. Walk back to find the matching
    // `{` for that `}`: skip whitespace until we hit `}`, then balance braces.
    let openIdx = -1;
    let i = idx - 1;
    while (i >= 0 && /\s/.test(text[i])) i--;
    if (i >= 0 && text[i] === "}") {
      let depth = 1;
      i--;
      for (; i >= Math.max(0, idx - 4096); i--) {
        const ch = text[i];
        if (ch === "}") depth++;
        else if (ch === "{") {
          depth--;
          if (depth === 0) {
            openIdx = i;
            break;
          }
        }
      }
    }
    let op;
    if (openIdx === -1) {
      op = "<unknown>";
    } else {
      const inner = text.slice(openIdx, idx);
      op = extractOp(inner);
    }
    occs.push({ file, line: lineNo, op });
    from = idx + NEEDLE.length;
  }
  return occs;
}

function main() {
  const all = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf-8");
    if (!text.includes(NEEDLE)) continue;
    all.push(...findOccurrences(text, file));
  }

  // Group by op
  const byOp = new Map();
  for (const o of all) {
    const arr = byOp.get(o.op) ?? [];
    arr.push(o);
    byOp.set(o.op, arr);
  }
  const groups = [...byOp.entries()].sort((a, b) => b[1].length - a[1].length);

  const total = all.length;
  const high = groups.filter(([, v]) => v.length > 10);
  const mid = groups.filter(([, v]) => v.length >= 2 && v.length <= 10);
  const low = groups.filter(([, v]) => v.length === 1);

  // Per-file totals
  const byFile = new Map();
  for (const o of all) {
    byFile.set(o.file, (byFile.get(o.file) ?? 0) + 1);
  }
  const fileSorted = [...byFile.entries()].sort((a, b) => b[1] - a[1]);

  const today = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push(`# \`as unknown as Instr\` cast inventory`);
  lines.push("");
  lines.push(`Generated: ${today} by \`scripts/audit-instr-casts.mjs\`.`);
  lines.push("");
  lines.push(
    `The cast \`as unknown as Instr\` bypasses TypeScript's instruction union and ` +
      `allows arbitrary opcode strings to flow into the Wasm emitter. Issue #1526 ` +
      `audited every site and removed the gratuitous casts (every op was already in ` +
      `the union — the casts were habitual style). \`scripts/instr-cast-baseline.json\` ` +
      `tracks the ceiling enforced by CI.`,
  );
  lines.push("");
  lines.push(`**Total occurrences:** ${total}`);
  lines.push("");
  if (total === 0) {
    lines.push(
      "All call sites use the typed `Instr` union directly. New casts will fail " +
        "the `Instr cast budget` CI check unless the baseline is updated.",
    );
    lines.push("");
  }
  lines.push(`## Top files`);
  lines.push("");
  if (fileSorted.length === 0) {
    lines.push("_(none)_");
    lines.push("");
  } else {
    lines.push("| File | Count |");
    lines.push("|------|------:|");
    for (const [file, count] of fileSorted.slice(0, 15)) {
      lines.push(`| \`${relative(ROOT, file)}\` | ${count} |`);
    }
    lines.push("");
  }

  const section = (heading, rows) => {
    lines.push(`## ${heading}`);
    lines.push("");
    if (rows.length === 0) {
      lines.push("_(none)_");
      lines.push("");
      return;
    }
    lines.push("| Op | Count | First occurrence |");
    lines.push("|----|------:|------------------|");
    for (const [op, occs] of rows) {
      const first = occs[0];
      const where = `${relative(ROOT, first.file)}:${first.line}`;
      lines.push(`| \`${op}\` | ${occs.length} | \`${where}\` |`);
    }
    lines.push("");
  };

  section("Ops with > 10 casts (high priority)", high);
  section("Ops with 2-10 casts (medium)", mid);
  section("Ops with 1 cast (long tail)", low);

  // For machine consumption, emit a JSON sidecar so other scripts can
  // diff op-by-op without re-parsing markdown.
  const json = {
    generated: today,
    total,
    byOp: Object.fromEntries(groups.map(([op, occs]) => [op, occs.length])),
  };
  writeFileSync(REPORT, lines.join("\n"));
  writeFileSync(REPORT.replace(/\.md$/, ".json"), JSON.stringify(json, null, 2) + "\n");

  // Also print a short summary so CI / interactive use shows the totals.
  process.stdout.write(`Wrote ${relative(ROOT, REPORT)}\n`);
  process.stdout.write(`Total casts: ${total}\n`);
  process.stdout.write(`High-priority ops (>10): ${high.length}\n`);
  for (const [op, occs] of high.slice(0, 15)) {
    process.stdout.write(`  ${op.padEnd(40)} ${occs.length}\n`);
  }
}

main();
