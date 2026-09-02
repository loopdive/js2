// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The npm-compat corpus is classified by the ECMAScript edition each package
// requires. Two properties keep that number worth reading, and both are pinned
// here:
//
//   1. It is DERIVED, not asserted. The library half comes from TypeScript's
//      own `lib.es<year>.*.d.ts` declarations, so a new edition lands without
//      anyone editing a table.
//   2. It never over-reports. A bare `x.flat()` cannot be attributed to Array
//      without types, and a file that declares its own `Promise` is not using
//      the global — both must leave the edition where it was.

import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs script library has no declaration file
import {
  BASELINE_EDITION,
  classifySource,
  ESNEXT,
  formatEdition,
  loadBuiltinEditionMap,
} from "../scripts/lib/es-edition.mjs";
// @ts-expect-error — .mjs script library has no declaration file
import { esEditionRollup } from "../scripts/lib/npm-compat-es-edition.mjs";

type Classification = {
  required: number | string;
  syntax: number | string;
  builtins: number | string;
  evidence: { syntax: Evidence[]; builtins: Evidence[]; heuristic: Evidence[] };
};
type Evidence = { feature: string; edition: number | string; file: string; line: number };

const classify = (source: string): Classification => classifySource(source, "case.js") as Classification;
const features = (list: Evidence[]) => list.map((item) => item.feature);

describe("ES-edition classifier — builtin map derived from TypeScript's lib files", () => {
  it("reads every ECMA-262 lib file and attributes statics to their global", () => {
    const map = loadBuiltinEditionMap();
    expect(map.libFiles).toBeGreaterThan(20);
    expect(map.statics.get("Object.entries")).toBe(2017);
    expect(map.statics.get("Object.fromEntries")).toBe(2019);
    expect(map.statics.get("Object.hasOwn")).toBe(2022);
    expect(map.statics.get("Promise.allSettled")).toBe(2020);
    expect(map.globals.get("WeakRef")).toBe(2021);
    expect(map.globals.get("Symbol")).toBe(2015);
  });

  it("never attributes an ES5 name to a later lib file that re-declares it", () => {
    const map = loadBuiltinEditionMap();
    // `Object.keys`/`Array.isArray` are ES5; later libs mention `ObjectConstructor`
    // again for new members, which must not drag the old ones forward.
    expect(map.statics.has("Object.keys")).toBe(false);
    expect(map.statics.has("Array.isArray")).toBe(false);
    expect(map.instanceMembers.has("map")).toBe(false);
  });

  it("excludes ECMA-402 (Intl), which is a separate standard from ECMA-262", () => {
    expect(classify("var f = new Intl.DisplayNames();").required).toBe(BASELINE_EDITION);
  });
});

describe("ES-edition classifier — syntax", () => {
  it.each([
    ["var x = 1; function f(a) { return a; }", BASELINE_EDITION],
    ["const f = (a) => a * 2;", 2015],
    ["var y = 2 ** 8;", 2016],
    ["async function g() { return 1; }", 2017],
    ["var merged = { ...a, b: 1 };", 2018],
    ["try { f(); } catch { g(); }", 2019],
    ["var v = a?.b ?? c;", 2020],
    ["let n = 0; n ||= 1;", 2021],
    ["class A { #p = 1; static { } }", 2022],
    ['import x from "./x.js" with { type: "json" };', 2025],
  ])("classifies %j as ES%s", (source, edition) => {
    expect(classify(source as string).syntax).toBe(edition);
  });

  it("separates a `using` declaration from an ordinary `const`", () => {
    // `NodeFlags.AwaitUsing` is `Const | Using`, so a naive bit test reads every
    // `const` as an ES2025 `using` declaration.
    expect(features(classify("const a = 1;").evidence.syntax)).toContain("let/const");
    expect(features(classify("const a = 1;").evidence.syntax)).not.toContain("using declaration");
    expect(features(classify("using handle = open();").evidence.syntax)).toContain("using declaration");
  });

  it("does not read a plain non-capturing group as an ES2025 regexp modifier", () => {
    expect(classify("var re = /(?:abc)+/;").required).toBe(BASELINE_EDITION);
    expect(features(classify("var re = /(?i:abc)/;").evidence.syntax)).toContain("regexp modifiers");
    expect(features(classify("var re = /(?<y>\\d{4})/;").evidence.syntax)).toContain("regexp named capture group");
  });

  it("counts module top-level await as ES2022, not ES2017", () => {
    const topLevel = classify('import "./x.js";\nawait ready();');
    expect(features(topLevel.evidence.syntax)).toContain("top-level await");
    expect(topLevel.syntax).toBe(2022);
    expect(classify("async function f() { await ready(); }").syntax).toBe(2017);
  });
});

describe("ES-edition classifier — library surface, and what it refuses to claim", () => {
  it("reports a static call and a global read at their introducing edition", () => {
    expect(classify("var e = Object.entries(o);").builtins).toBe(2017);
    expect(classify("var r = new WeakRef(o);").builtins).toBe(2021);
    expect(classify("var g = globalThis;").builtins).toBe(2020);
  });

  it("keeps syntax and library separate, because a transpiled bundle splits them", () => {
    // react's exact shape: ES5 grammar, ES2021 runtime requirement.
    const result = classify("var x = new AggregateError([], 'e');");
    expect(result.syntax).toBe(BASELINE_EDITION);
    expect(result.builtins).toBe(2021);
    expect(result.required).toBe(2021);
  });

  it("does not raise the edition for a bare prototype-method read", () => {
    // `x.flat()` is only `Array.prototype.flat` if `x` is an Array, which needs
    // type information this classifier deliberately does not use.
    const result = classify("var y = x.flat();");
    expect(result.required).toBe(BASELINE_EDITION);
    expect(features(result.evidence.heuristic)).toContain(".flat");
  });

  it("does not treat a locally declared name as the global builtin", () => {
    expect(classify("function f(Promise) { return new Promise(); }").builtins).toBe(BASELINE_EDITION);
    expect(classify("var p = Promise.resolve(1);").builtins).toBe(2015);
  });

  it("keeps the evidence that set the headline edition, however late it appears", () => {
    // Trimming evidence during collection dropped whichever feature came last,
    // which could be the one that set the number — a headline with nothing
    // behind it.
    const filler = Array.from({ length: 40 }, (_, i) => `const v${i} = (a) => a + ${i};`).join("\n");
    const result = classify(`${filler}\nclass Late { #hidden = 1; }`);
    expect(result.required).toBe(2022);
    expect(features(result.evidence.syntax)).toContain("private class member");
  });
});

describe("ES-edition rollup", () => {
  it("orders editions oldest first and names the packages behind each count", () => {
    const rollup = esEditionRollup([
      { name: "b", esEdition: { required: 2022 } },
      { name: "a", esEdition: { required: 2015 } },
      { name: "c", esEdition: { required: 2022 } },
      { name: "d", esEdition: { required: ESNEXT } },
      { name: "e", esEdition: { unavailable: "not extracted" } },
    ]);
    expect(rollup.editions.map((entry: { label: string }) => entry.label)).toEqual(["ES2015", "ES2022", "ESNext"]);
    expect(rollup.editions[1].packages).toEqual(["b", "c"]);
    expect(rollup.editions[1].count).toBe(2);
    expect(rollup.unclassified).toEqual(["e"]);
  });

  it("formats editions the way the spec names them", () => {
    expect(formatEdition(BASELINE_EDITION)).toBe("ES5");
    expect(formatEdition(2020)).toBe("ES2020");
    expect(formatEdition(ESNEXT)).toBe("ESNext");
  });
});
