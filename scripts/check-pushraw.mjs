#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2953 — BackendEmitter.pushRaw escape-hatch ratchet.
//
// The default gate is change-scoped: compare the five lowering modules with this
// change-set's own git base and reject every newly-added `pushRaw(` call that
// does not carry `// pushraw-ok(#NNNN)` on the same or immediately preceding
// line. Tagged additions are explicit, reviewable debt; untagged additions are
// never allowed, even when another raw site is removed in the same change.
//
// The committed baseline is the whole-tree fallback and count dashboard. It
// records the untagged legacy residue, while tagged sites are excluded from the
// debt ceiling. `--update-on-decrease` can therefore bank removal of a legacy
// site even if the same change adds a reviewed, tagged escape hatch.
//
// Usage:
//   node scripts/check-pushraw.mjs
//   node scripts/check-pushraw.mjs --all
//   node scripts/check-pushraw.mjs --update
//   node scripts/check-pushraw.mjs --update-on-decrease
//   node scripts/check-pushraw.mjs --json

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { baseBlob, resolveChangeBase } from "./lib/change-scope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const LEGACY_TARGET = "src/ir/lower.ts";
const TARGET = "src/ir/lower-generic.ts";
export const LOWERING_TARGETS = Object.freeze([
  LEGACY_TARGET,
  TARGET,
  "src/ir/backend/lower-contracts.ts",
  "src/ir/backend/wasm-constants.ts",
  "src/ir/backend/wasm-lowering.ts",
]);

const PUSHRAW_RE = /\bpushRaw\s*\(/g;
const TAG_RE = /\/\/\s*pushraw-ok\(#([1-9]\d*)\)(?:\s*:\s*[^\r\n]+)?/;

function tagOn(line) {
  const match = line?.match(TAG_RE);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/** Return every textual `pushRaw(` call and its adjacent justification. */
export function scanPushRaw(source) {
  const lines = source.split(/\r?\n/);
  const sites = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    PUSHRAW_RE.lastIndex = 0;
    for (const match of line.matchAll(PUSHRAW_RE)) {
      const issue = tagOn(line) ?? tagOn(lines[index - 1]);
      sites.push({
        line: index + 1,
        column: match.index + 1,
        issue,
        tagged: issue !== undefined,
        source: line.trim(),
      });
    }
  }

  return {
    sites,
    total: sites.length,
    tagged: sites.filter((site) => site.tagged).length,
    untagged: sites.filter((site) => !site.tagged).length,
  };
}

/** Parse the new-side line numbers from a zero-context unified diff. */
export function addedLineNumbers(diff) {
  const added = new Set();
  let newLine;

  for (const line of diff.split(/\r?\n/)) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (newLine === undefined || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.add(newLine);
      newLine++;
    } else if (line.startsWith(" ")) {
      newLine++;
    }
    // A removed line has no position on the new side.
  }

  return added;
}

/** Pure fixture evaluator used by the focused #2953 tests. */
export function evaluatePushRawChange(baseSource, currentSource, addedLines) {
  const base = scanPushRaw(baseSource);
  const current = scanPushRaw(currentSource);
  const added = current.sites.filter((site) => addedLines.has(site.line));
  const untaggedAdded = added.filter((site) => !site.tagged);
  const growth = current.total - base.total;
  const unattributedGrowth = Math.max(0, growth - added.length);

  return {
    ok: untaggedAdded.length === 0 && unattributedGrowth === 0,
    base,
    current,
    added,
    untaggedAdded,
    growth,
    unattributedGrowth,
  };
}

// Diff the actual source pair, including untracked destinations. On the first
// split only, generic lowering is compared with the old monolithic file; the
// facade and new wrapper/contracts/constants receive no inherited site credit.
function sourceDiff(before, after) {
  const directory = mkdtempSync(join(tmpdir(), "js2-pushraw-diff-"));
  try {
    const left = join(directory, "before.ts");
    const right = join(directory, "after.ts");
    writeFileSync(left, before);
    writeFileSync(right, after);
    const diff = spawnSync("git", ["diff", "--no-index", "--no-ext-diff", "--unified=0", "--", left, right], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (diff.error || diff.signal || (diff.status !== 0 && diff.status !== 1)) {
      throw new Error(`Cannot compare lowering sources: ${diff.error?.message ?? diff.stderr}`);
    }
    return diff.stdout;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function scanLowering(root) {
  const scans = LOWERING_TARGETS.map((path) => {
    // Required regardless of the inventory/baseline: a missing moved module
    // must not silently turn its escape hatches into zero sites.
    const source = readFileSync(join(root, path), "utf8");
    const scan = scanPushRaw(source);
    return { path, source, ...scan, sites: scan.sites.map((site) => ({ path, ...site })) };
  });
  return {
    scans,
    sites: scans.flatMap((scan) => scan.sites),
    total: scans.reduce((count, scan) => count + scan.total, 0),
    tagged: scans.reduce((count, scan) => count + scan.tagged, 0),
    untagged: scans.reduce((count, scan) => count + scan.untagged, 0),
  };
}

function evaluateLoweringChange(root, base, current) {
  const oldGeneric = baseBlob(root, base, TARGET);
  const oldFacade = baseBlob(root, base, LEGACY_TARGET);
  if (oldGeneric === undefined && oldFacade === undefined) throw new Error("Missing lowering change-base source");
  const results = current.scans.map(({ path, source }) => {
    const before =
      path === TARGET
        ? (oldGeneric ?? oldFacade)
        : path === LEGACY_TARGET && oldGeneric === undefined
          ? ""
          : (baseBlob(root, base, path) ?? "");
    const result = evaluatePushRawChange(before, source, addedLineNumbers(sourceDiff(before, source)));
    return {
      ...result,
      added: result.added.map((site) => ({ path, ...site })),
      untaggedAdded: result.untaggedAdded.map((site) => ({ path, ...site })),
    };
  });
  return {
    ok: results.every((result) => result.ok),
    growth: results.reduce((count, result) => count + result.growth, 0),
    added: results.flatMap((result) => result.added),
    untaggedAdded: results.flatMap((result) => result.untaggedAdded),
    unattributedGrowth: results.reduce((count, result) => count + result.unattributedGrowth, 0),
  };
}

function loadBaseline(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function baselineFor(scan) {
  return {
    generated: new Date().toISOString().slice(0, 10),
    path: TARGET,
    paths: LOWERING_TARGETS,
    relocatedFrom: LEGACY_TARGET,
    total: scan.total,
    tagged: scan.tagged,
    untagged: scan.untagged,
  };
}

function writeBaseline(path, scan) {
  writeFileSync(path, JSON.stringify(baselineFor(scan), null, 2) + "\n", "utf-8");
}

function formatSite(site) {
  return `  ${site.path}:${site.line}:${site.column}  ${site.source}`;
}

function failChanged(result) {
  const lines = ["pushRaw ratchet FAILED (#2953):"];
  if (result.untaggedAdded.length > 0) {
    lines.push("", "New BackendEmitter escape hatches require an issue tag:");
    lines.push(...result.untaggedAdded.map(formatSite));
  }
  if (result.unattributedGrowth > 0) {
    lines.push("", `Could not attribute ${result.unattributedGrowth} added call site(s) to the working-tree diff.`);
  }
  lines.push(
    "",
    "Route the operation through a typed BackendEmitter method. If raw emission",
    "is temporarily unavoidable, add a reviewed justification on the same or",
    "immediately preceding line:",
    "",
    "  // pushraw-ok(#3296): rejected by non-Wasm backend legality",
    "  emitter.pushRaw(out, op);",
  );
  console.error(lines.join("\n"));
  process.exitCode = 1;
}

function run() {
  const argv = process.argv.slice(2);
  const rootIndex = argv.indexOf("--root");
  if (rootIndex !== -1 && !argv[rootIndex + 1]) throw new Error("--root requires a path");
  const root = rootIndex === -1 ? REPO_ROOT : resolve(argv[rootIndex + 1]);
  const baselinePath = join(root, "scripts/pushraw-baseline.json");
  const args = new Set(argv);
  const update = args.has("--update");
  const updateOnDecrease = args.has("--update-on-decrease");
  const auditAll = args.has("--all");
  const json = args.has("--json");
  const current = scanLowering(root);

  if (json) {
    const { scans, ...summary } = current;
    console.log(JSON.stringify({ path: TARGET, paths: LOWERING_TARGETS, ...summary }, null, 2));
    return;
  }

  if (update) {
    writeBaseline(baselinePath, current);
    console.log(
      `pushRaw baseline updated — total=${current.total}, tagged=${current.tagged}, untagged=${current.untagged}.`,
    );
    return;
  }

  if (!auditAll && !updateOnDecrease) {
    const { base, how } = resolveChangeBase(root);
    if (base) {
      const result = evaluateLoweringChange(root, base, current);
      if (!result.ok) {
        failChanged(result);
        return;
      }
      console.log(
        `pushRaw ratchet: OK — ${current.total} call sites ` +
          `(${result.growth >= 0 ? "+" : ""}${result.growth} vs ${how}; ` +
          `${result.added.length} added, ${result.added.filter((site) => site.tagged).length} tagged).`,
      );
      return;
    }
  }

  const baseline = loadBaseline(baselinePath);
  if (
    !baseline ||
    baseline.path !== TARGET ||
    !Number.isInteger(baseline.untagged) ||
    JSON.stringify(baseline.paths) !== JSON.stringify(LOWERING_TARGETS)
  ) {
    console.error(`pushRaw ratchet: missing/invalid ${baselinePath}; run with --update to seed it.`);
    process.exitCode = 1;
    return;
  }
  if (current.untagged > baseline.untagged) {
    console.error(
      `pushRaw ratchet FAILED (#2953): untagged escape hatches grew ` + `${baseline.untagged} -> ${current.untagged}.`,
    );
    process.exitCode = 1;
    return;
  }
  if (updateOnDecrease && current.untagged < baseline.untagged) {
    writeBaseline(baselinePath, current);
    console.log(
      `pushRaw baseline ratcheted down — untagged ${baseline.untagged} -> ${current.untagged} ` +
        `(total=${current.total}, tagged=${current.tagged}).`,
    );
    return;
  }
  console.log(
    `pushRaw ratchet: OK (whole-tree${auditAll ? " --all" : ""}) — ` +
      `total=${current.total}, tagged=${current.tagged}, untagged=${current.untagged} ` +
      `(baseline untagged=${baseline.untagged}).`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) run();
