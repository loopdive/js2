// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3400 — R-FUNC per-function LOC ceiling ratchet (check:func-budget). These
// tests lock in the two pure pieces the gate is built on:
//   • collectFunctionSizes — the TS-AST measurement (line span per function
//     unit; nested functions counted independently; contextual/qualified
//     naming; ordinal disambiguation; block-body arrows only), and
//   • classifyFunctionChanges — the change-scoped verdict (grandfather base,
//     fail on regrowth / newly-over / brand-new-over, honor the allow set,
//     collect shrink-banking candidates).
import { describe, it, expect } from "vitest";
import { collectFunctionSizes, classifyFunctionChanges } from "../scripts/check-func-budget.mjs";

/** A function declaration whose body spans exactly `bodyLines` blank lines. */
function fnOf(name: string, bodyLines: number): string {
  return `function ${name}() {\n${"\n".repeat(bodyLines)}}`;
}

describe("#3400 collectFunctionSizes — measurement", () => {
  it("measures the 1-based inclusive line span of a function declaration", () => {
    // `function f() {` (1) + 248 blank body lines + `}` (1) = 250 lines.
    const sizes = collectFunctionSizes(fnOf("f", 248) + "\n", "x.ts");
    expect(sizes.get("x.ts::f")).toBe(250);
  });

  it("counts a nested arrow independently of its parent (both entries, parent NOT reduced)", () => {
    // parent spans ~200 lines and contains a ~400-line inner arrow — TWO entries.
    const inner = `const inner = () => {\n${"\n".repeat(398)}};`; // 400 lines
    const parent = `function parent() {\n${"\n".repeat(50)}${inner}\n${"\n".repeat(50)}}`;
    const sizes = collectFunctionSizes(parent + "\n", "x.ts");
    expect(sizes.get("x.ts::parent")).toBeGreaterThan(300); // the whole span, incl. the inner arrow
    expect(sizes.get("x.ts::inner")).toBe(400); // measured on its own, not subtracted from parent
    expect([...sizes.keys()].filter((k) => k.startsWith("x.ts::")).length).toBe(2);
  });

  it("names an anonymous arrow from its const binding", () => {
    const sizes = collectFunctionSizes(`const handler = (a: number) => {\nreturn a;\n};\n`, "x.ts");
    expect(sizes.has("x.ts::handler")).toBe(true);
  });

  it("qualifies methods / accessors / constructor with the class name", () => {
    const src = [
      "class Widget {",
      "  constructor() {}",
      "  render() { return 1; }",
      "  get size() { return 2; }",
      "  set size(v: number) {}",
      "}",
      "",
    ].join("\n");
    const keys = [...collectFunctionSizes(src, "x.ts").keys()];
    expect(keys).toContain("x.ts::Widget.constructor");
    expect(keys).toContain("x.ts::Widget.render");
    expect(keys).toContain("x.ts::Widget.get size");
    expect(keys).toContain("x.ts::Widget.set size");
  });

  it("disambiguates same-name functions in one file with an ordinal", () => {
    const sizes = collectFunctionSizes(fnOf("dup", 1) + "\n" + fnOf("dup", 1) + "\n", "x.ts");
    expect(sizes.has("x.ts::dup")).toBe(true);
    expect(sizes.has("x.ts::dup#2")).toBe(true);
  });

  it("excludes expression-bodied arrows (block body only)", () => {
    const sizes = collectFunctionSizes(`const add = (a: number, b: number) => a + b;\n`, "x.ts");
    expect(sizes.size).toBe(0);
  });
});

describe("#3400 classifyFunctionChanges — change-scoped verdict", () => {
  const base = new Map<string, number>([
    ["f.ts::grandfathered", 350], // already over 300 at base
    ["f.ts::normal", 250],
  ]);

  it("passes a shrink of an already-over-limit function (grandfathered)", () => {
    const cur = new Map([["f.ts::grandfathered", 320]]); // 350 -> 320, still over but shrank
    const v = classifyFunctionChanges(cur, base, null, 300);
    expect(v.regrown).toHaveLength(0);
    expect(v.newGiants).toHaveLength(0);
    expect(v.shrunk).toEqual([["f.ts::grandfathered", 320]]);
  });

  it("fails regrowth of an already-over-limit function", () => {
    const cur = new Map([["f.ts::grandfathered", 360]]); // 350 -> 360
    const v = classifyFunctionChanges(cur, base, null, 300);
    expect(v.regrown).toEqual([{ key: "f.ts::grandfathered", ceiling: 350, size: 360, delta: 10 }]);
  });

  it("fails a brand-new function over the threshold", () => {
    const cur = new Map([["f.ts::brandNew", 350]]); // not in base
    const v = classifyFunctionChanges(cur, base, null, 300);
    expect(v.newGiants).toEqual([{ key: "f.ts::brandNew", size: 350, delta: 50 }]);
  });

  it("fails a function that newly crosses the threshold", () => {
    const cur = new Map([["f.ts::normal", 350]]); // 250 -> 350
    const v = classifyFunctionChanges(cur, base, null, 300);
    expect(v.newGiants).toEqual([{ key: "f.ts::normal", size: 350, delta: 50 }]);
  });

  it("passes a new under-threshold function", () => {
    const cur = new Map([["f.ts::small", 200]]);
    const v = classifyFunctionChanges(cur, base, null, 300);
    expect(v.regrown).toHaveLength(0);
    expect(v.newGiants).toHaveLength(0);
  });

  it("honors the allow set (func-budget-allow) instead of faulting", () => {
    const cur = new Map([["f.ts::brandNew", 350]]);
    const allow = new Map([["f.ts::brandNew", ["plan/issues/3400-...md"]]]);
    const v = classifyFunctionChanges(cur, base, allow, 300);
    expect(v.newGiants).toHaveLength(0);
    expect(v.regrown).toHaveLength(0);
    expect(v.granted).toEqual([{ key: "f.ts::brandNew", prior: 0, size: 350 }]);
  });
});
