// #6796 — check:tracked-ignored must FAIL on a tracked-and-ignored path that is
// not on the dated allow-list, and on an allow-list entry that matches nothing.
import { describe, expect, it } from "vitest";
import { evaluate, parseCheckIgnoreVerbose } from "../scripts/check-tracked-ignored.mjs";

const record = (source: string, line: number, pattern: string, path: string) =>
  `${source}\0${line}\0${pattern}\0${path}\0`;

describe("#6796 check-tracked-ignored", () => {
  it("drops paths whose last matching rule is a `!` negation (not ignored)", () => {
    const text =
      record(".gitignore", 79, ".tmp/", ".tmp/probe.mjs") +
      record(".gitignore", 14, "!benchmarks/results/latest.json", "benchmarks/results/latest.json");
    expect(parseCheckIgnoreVerbose(text)).toEqual([{ path: ".tmp/probe.mjs", rule: ".gitignore:79: .tmp/" }]);
  });

  it("reports an ignored path that is not allow-listed", () => {
    const hits = [{ path: ".tmp/probe.mjs", rule: ".gitignore:79: .tmp/" }];
    const { offenders, stale } = evaluate(hits, [{ path: "vendor/x", since: "2026-10-02", reason: "r" }]);
    expect(offenders.map((h) => h.path)).toEqual([".tmp/probe.mjs"]);
    expect(stale.map((e) => e.path)).toEqual(["vendor/x"]);
  });

  it("accepts exact paths and directory prefixes, and nothing else", () => {
    const allowed = [
      { path: "tests/fixtures/node_modules/", since: "2026-10-02", reason: "r" },
      { path: "vendor/x", since: "2026-10-02", reason: "r" },
    ];
    const hits = [
      { path: "tests/fixtures/node_modules/a/index.js", rule: "r" },
      { path: "vendor/x", rule: "r" },
      { path: "vendor/xy", rule: "r" },
    ];
    const { offenders, stale } = evaluate(hits, allowed);
    expect(offenders.map((h) => h.path)).toEqual(["vendor/xy"]);
    expect(stale).toEqual([]);
  });

  it("is clean on an empty result with an empty allow-list", () => {
    expect(evaluate([], [])).toEqual({ offenders: [], stale: [] });
  });
});
