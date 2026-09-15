// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { collectUnsafeLookups } from "../src/compiler/lookup-semantic-safety.js";

function findings(source: string, standalone = false) {
  const ast = analyzeSource(source, "lookup.ts");
  return collectUnsafeLookups(ast.checker, ast.sourceFile, { standalone });
}

describe("#5389: missing lookup semantic safety", () => {
  it.each([false, true])("detects observable numeric-array absence (standalone %s)", (standalone) => {
    const source = "const xs=[1,2,3];\nconst n=xs[3]; console.log(n); console.log(typeof n);";
    const result = findings(source, standalone);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("JS2WASM_UNSOUND_LOOKUP");
    expect(result[0].node.getText()).toBe("xs[3]");
    expect(result[0].node.getSourceFile().fileName).toBe("lookup.ts");
    expect(result[0].node.getSourceFile().getLineAndCharacterOfPosition(result[0].node.getStart()).line).toBe(1);
    expect(
      findings('const xs=[1,2,3]; try { console.log(xs[3].toFixed(1)); } catch(e) {console.log("threw");}', standalone),
    ).toHaveLength(1);
  });

  it("follows transparent wrappers and both container and value aliases", () => {
    expect(
      findings("const xs=[1]; const ys=(xs as number[]); const n=(ys[2]); const m=n; console.log(m);"),
    ).toHaveLength(1);
    expect(findings("const xs=[1]; {const xs=[1,2,3]; console.log(xs[2]);} console.log(xs[2]);")).toHaveLength(1);
  });

  it.each(["n+1", "n-1", "n*2", "n/2", "n%2", "n**2", "+n", "-n", "Number(n)"])(
    "preserves numeric-only use %s",
    (expression) => {
      expect(findings(`const xs=[1]; const n=xs[2]; console.log(${expression});`)).toEqual([]);
    },
  );

  it("preserves numeric-only value aliases, but detects a separate observable use", () => {
    expect(findings("const xs=[1]; const n=xs[2]; const m=n; console.log(m+1);")).toEqual([]);
    expect(findings("const xs=[1]; const n=xs[2]; console.log(n+1); console.log(typeof n);")).toHaveLength(1);
    expect(findings('const xs=[1]; console.log(xs[2]+"x");')).toHaveLength(1);
  });

  it("limits typed-map absence to standalone and preserves present and inherited keys", () => {
    const source = 'const ids:{[key:string]:string}={known:"yes"}; const value=ids["missing"]; console.log(value);';
    expect(findings(source)).toEqual([]);
    expect(findings(source, true)).toHaveLength(1);
    expect(findings('const ids:{[key:string]:string}={known:"yes"}; console.log(ids["known"]);', true)).toEqual([]);
    expect(findings('const ids:{[key:string]:string}={known:"yes"}; console.log(ids["toString"]);', true)).toEqual([]);
  });

  it.each([
    "const xs=[1]; console.log(xs[0]);",
    "const xs=[1]; xs.push(2); console.log(xs[1]);",
    "const xs=[1]; const ys=xs; ys.push(2); console.log(xs[1]);",
    "const xs=[1]; xs[2]=3; console.log(xs[2]);",
    "const xs=[1]; declare function grow(a:number[]):void; grow(xs); console.log(xs[2]);",
    "const xs=[1]; Array.prototype[2]=3; console.log(xs[2]);",
    "const xs=[1]; let n=2; console.log(xs[n]);",
    "const xs=[1]; const ys=[...xs]; console.log(ys[2]);",
    'const ids:{[key:string]:string}={__proto__:{missing:"yes"}}; console.log(ids["missing"]);',
  ])("does not claim absence without a closed literal proof: %s", (source) => {
    expect(findings(source, true)).toEqual([]);
  });
});
