// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Tables for prepared-census.mts rows.
 *
 *   node scripts/ir-census/prepared-analyze.mjs --rows <prepared.jsonl> [--rows <other.jsonl> …]
 *                                               [--base <older prepared.jsonl>]
 *
 * For each rows file: outcomes (pass / fail / compile error / crash / skipped),
 * where the first gap lies (harness file, stand-in, test body), the first gaps
 * by detail, and the first gaps of test bodies by mechanism with their slice
 * and issue (prepared-mechanisms.mjs). The Prepared path stops at its first
 * gap, so every count is a first-gap count: a file is charged to one
 * mechanism, and nothing behind that gap is seen.
 *
 * With `--base`, each report starts with the files that pass now and did not
 * pass in the base run, and those that passed there and no longer do.
 */
import { readRows } from "./analyze.mjs";
import { MECHANISMS, mechanismOf, sourceWithIncludes } from "./prepared-mechanisms.mjs";

const table = (head, rows) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join(
    "\n",
  );

const count = (items) => {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
};

const quoted = (detail) => /"([^"]+)"|'([^']+)'/.exec(detail)?.slice(1).find(Boolean) ?? "";

const normalise = (detail = "") =>
  detail
    .replace(/"[^"]*"|'[^']*'/g, "‹›")
    .replace(/\((?:<module-init>|[\w$]+)\)\s*$/, "")
    .replace(/ in [\w$<>.-]+$/, "")
    .replace(/\b(binding|class) [\w$]+/g, "$1 ‹›")
    .replace(/\d+/g, "N")
    .slice(0, 110)
    .trim();

function report(path) {
  const rows = readRows(path);
  const positive = rows.filter((row) => row.status !== "skip");
  const gaps = positive.filter((row) => row.status === "compile_error" || row.status === "crash");
  const out = [`## ${path}`];
  out.push(
    table(
      ["outcome", "files"],
      [["positive files", positive.length], ...count(positive.map((row) => row.status))].map((r) => r.map(String)),
    ),
  );
  const unmodelled = positive.filter((row) => row.unmodelled).length;
  if (unmodelled) out.push(`Files naming harness API the stand-in does not model: ${unmodelled}.`);
  out.push(
    table(
      ["first gap lies in", "files"],
      count(gaps.map((row) => (row.status === "crash" ? "crash (unlocated)" : row.origin))).map((r) => r.map(String)),
    ),
  );
  out.push(
    table(
      ["#", "first gap (normalised)", "where", "files"],
      count(gaps.map((row) => `${normalise(row.detail)}\u0000${row.origin?.split(":")[0] ?? ""}`))
        .slice(0, 25)
        .map(([key, n], i) => [String(i + 1), `\`${key.split("\u0000")[0]}\``, key.split("\u0000")[1], String(n)]),
    ),
  );
  // Every first gap by mechanism. A gap in the stand-in is charged to what the test asked of it
  // (`assert.throws` calls a function value); a gap in an include is shown under the include.
  const labelled = gaps.map((row) => {
    const mechanism = mechanismOf(row, sourceWithIncludes(row.file));
    const where = row.origin?.startsWith("harness:") ? `include ${row.origin.slice(8)}` : "";
    return { row, mechanism, where, name: quoted(row.detail ?? "") };
  });
  const byMechanism = count(labelled.map((entry) => entry.mechanism));
  out.push(
    `First gaps by mechanism, ${gaps.length} files (columns: in the test body or stand-in / in an include; top names):\n\n` +
      table(
        ["#", "mechanism", "slice · issue", "files", "body", "include", "top names"],
        byMechanism.map(([m, n], i) => {
          const mine = labelled.filter((entry) => entry.mechanism === m);
          const names = count(mine.map((entry) => entry.name).filter(Boolean))
            .slice(0, 4)
            .map(([name, k]) => `${name} ${k}`)
            .join(", ");
          const inInclude = mine.filter((entry) => entry.where).length;
          return [String(i + 1), m, MECHANISMS[m] ?? "", String(n), String(n - inInclude), String(inInclude), names];
        }),
      ),
  );
  const bySlice = count(labelled.map((entry) => (MECHANISMS[entry.mechanism] ?? "").split(" · ")[0] || "unmapped"));
  out.push(
    `First gaps by slice:\n\n${table(
      ["slice", "files"],
      bySlice.map((r) => r.map(String)),
    )}`,
  );
  return out.join("\n\n");
}

/** Passes gained and lost against an older run of the same files. */
function passDelta(rows, baseRows) {
  const passed = new Set(baseRows.filter((row) => row.status === "pass").map((row) => row.file));
  const now = rows.filter((row) => row.status === "pass").map((row) => row.file);
  const gained = now.filter((file) => !passed.has(file)).sort();
  const lost = [...passed].filter((file) => !now.includes(file)).sort();
  const list = (files) => files.map((file) => `- \`${file}\``).join("\n") || "- none";
  return `Passes gained (${gained.length}):\n${list(gained)}\n\nPasses lost (${lost.length}):\n${list(lost)}`;
}

const argv = process.argv;
const paths = argv.flatMap((arg, i) => (argv[i - 1] === "--rows" ? [arg] : []));
const basePath = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : undefined;
const baseRows = basePath ? readRows(basePath) : undefined;
console.log(
  paths
    .map((path) => (baseRows ? `${passDelta(readRows(path), baseRows)}\n\n${report(path)}` : report(path)))
    .join("\n\n"),
);
