// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// (#3927) Compare two `cold-tail-differential.mjs` reports.
//
// Exit 0 = the two builds agree on every per-field hash, every presence count,
// the node count and `body.length`. Exit 1 names the fields that differ.
//
// Usage: node tests/dogfood/cold-tail-diff.mjs .tmp/off.json .tmp/k24.json
import { readFileSync } from "node:fs";

const [a, b] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, "utf-8")));
if (!a || !b) {
  process.stderr.write("usage: node tests/dogfood/cold-tail-diff.mjs <a.json> <b.json>\n");
  process.exit(2);
}
const names = Object.keys(a.hashes);
const diverged = names.filter((n) => a.hashes[n] !== b.hashes[n]);
const seenDiff = names.filter((n) => a.seen[n] !== b.seen[n]);
process.stdout.write(
  `K=${a.k}/${a.readMode} vs K=${b.k}/${b.readMode}  nodes ${a.nodes} vs ${b.nodes}  body ${a.bodyLength} vs ${b.bodyLength}\n` +
    `  hash diverged (${diverged.length}): ${diverged.length === 0 ? "(none)" : diverged.join(", ")}\n` +
    `  presence diverged: ${
      seenDiff.length === 0 ? "(none)" : seenDiff.map((n) => `${n} ${a.seen[n]}->${b.seen[n]}`).join(", ")
    }\n`,
);
process.exit(diverged.length === 0 && seenDiff.length === 0 && a.nodes === b.nodes ? 0 : 1);
