// #7354 O — first-gap tally of a 411-row real-runner JSONL (rebuilt; the original l420.txt/myrun.sh are not in the repo).
import { readFileSync } from "node:fs";
const rows = readFileSync(process.argv[2], "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const c = new Map();
for (const r of rows) {
  const e = (r.error ?? "")
    .replace(/^L\d+:\d+ /, "")
    .split(";")[0]
    .replace(/ir-unit:v1:\S+/g, "<unit>")
    .slice(0, 120);
  const k = r.status + (r.status === "pass" ? "" : " | " + e);
  c.set(k, (c.get(k) ?? 0) + 1);
}
for (const [k, n] of [...c].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), k);
