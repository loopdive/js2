import { readFileSync } from "node:fs";
const load = (p) =>
  new Map(
    readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((r) => [r.file, r]),
  );
const [, , basePath, headPath] = process.argv;
const b = load(basePath),
  h = load(headPath);
const pass = (m) => [...m.values()].filter((r) => r.status === "pass").length;
const lost = [...b.keys()].filter((f) => b.get(f).status === "pass" && h.get(f)?.status !== "pass");
const gained = [...h.keys()].filter((f) => h.get(f).status === "pass" && b.get(f)?.status !== "pass");
const crashes = [...h.keys()].filter((f) => h.get(f).status === "crash" && b.get(f)?.status !== "crash");
const changed = [...h.keys()].filter(
  (f) => JSON.stringify({ ...h.get(f), aborts: undefined }) !== JSON.stringify({ ...b.get(f), aborts: undefined }),
).length;
console.log(
  JSON.stringify({
    rows: h.size,
    base: pass(b),
    head: pass(h),
    lost: lost.length,
    gained: gained.length,
    newCrashes: crashes.length,
    changedRows: changed,
  }),
);
for (const f of lost) console.log("  lost", f, h.get(f)?.status, (h.get(f)?.detail ?? "").slice(0, 120));
