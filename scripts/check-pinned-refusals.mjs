#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7365) A change that moves where a pinned refusal is observed must not drop or weaken one. For every test
 * file the diff touches, this compares the base and head versions:
 *
 * - the multiset of expected refusals (the source text of each `.toThrow(…)` argument) is unchanged;
 * - the number of `it(` / `it.each(` / `test(` cases is unchanged;
 * - no `.not.toThrow(` is added.
 *
 * It prints one row per file (refusals, re-pointed lines through the audit-point helper) and exits 1 on any
 * difference.
 *
 *   node scripts/check-pinned-refusals.mjs [--base <ref>]   # default: origin/main
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? args[baseIndex + 1] : "origin/main";
const HELPER = /\b(queryAfterAudit|completionCheck|sealed|expectUnemittable)\(/g;

const git = (...argv) => execFileSync("git", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const show = (ref, path) => {
  try {
    return git("show", `${ref}:${path}`);
  } catch {
    return undefined;
  }
};

/** The argument source of every `.toThrow(` call, balanced over parentheses. */
function refusals(text) {
  const out = [];
  for (const match of text.matchAll(/\.toThrow\(/g)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (depth > 0 && index < text.length) {
      const ch = text[index++];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    out.push(
      text
        .slice(start, index - 1)
        .replace(/\s+/g, " ")
        .trim()
        // Formatting only: a trailing comma does not change the expectation.
        .replace(/,$/, ""),
    );
  }
  return out.sort();
}

const count = (text, pattern) => (text.match(pattern) ?? []).length;
const cases = (text) => count(text, /\b(?:it|test)(?:\.each\([^)]*\))?\(/g);

const changed = git("diff", "--name-only", `${base}...HEAD`)
  .split("\n")
  .filter((path) => /^tests\/.*\.test\.ts$/.test(path));
let failures = 0;
console.log("| file | refusals base → head | cases base → head | helper calls added |");
console.log("|---|---|---|---|");
for (const path of changed) {
  const before = show(base, path);
  const after = show("HEAD", path);
  if (before === undefined || after === undefined) continue;
  const a = refusals(before);
  const b = refusals(after);
  const sameRefusals = a.length === b.length && a.every((text, i) => text === b[i]);
  const caseDelta = cases(after) - cases(before);
  const weakened = count(after, /\.not\.toThrow\(/g) - count(before, /\.not\.toThrow\(/g);
  const helpers = count(after, HELPER) - count(before, HELPER);
  const ok = sameRefusals && caseDelta === 0 && weakened <= 0;
  if (!ok) failures++;
  console.log(
    `| ${path} | ${a.length} → ${b.length}${sameRefusals ? "" : " **CHANGED**"} | ${cases(before)} → ${cases(after)} | ${helpers}${weakened > 0 ? ` (**+${weakened} not.toThrow**)` : ""} |`,
  );
  if (!sameRefusals) {
    const missing = a.filter((text) => !b.includes(text));
    const added = b.filter((text) => !a.includes(text));
    for (const text of missing) console.log(`  dropped: ${text}`);
    for (const text of added) console.log(`  added:   ${text}`);
  }
}
console.log(failures === 0 ? "check-pinned-refusals: OK" : `check-pinned-refusals: FAILED (${failures} file(s))`);
process.exit(failures === 0 ? 0 : 1);
