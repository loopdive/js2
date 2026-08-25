import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4674-switch-caseblock.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, (result.errors ?? []).map((e) => e.message).join("\n")).toBe(true);
  const instance = await instantiateTest262Module(
    result.binary,
    {},
    { target: "standalone", providerLabel: "issue-4674-switch-caseblock" },
  );
  return (instance.exports as { test(): number }).test();
}

describe("#4674 switch CaseBlock lexical environment", () => {
  it("opens the CaseBlock before case selectors and keeps selector closures", async () => {
    const source = `
      let x = "outside";
      let probeExpr: () => string;
      let probeSelector: () => string;
      let probeStmt: () => string;
      switch (probeExpr = function () { return x; }, null) {
        case probeSelector = function () { return x; }, null:
          probeStmt = function () { return x; };
          let x = "inside";
      }
      export function test(): number {
        return (probeExpr() === "outside" ? 1 : 0) +
          (probeSelector() === "inside" ? 2 : 0) +
          (probeStmt() === "inside" ? 4 : 0);
      }
    `;
    expect(await runStandalone(source)).toBe(7);
  });

  it("keeps a default-clause closure in the CaseBlock scope", async () => {
    const source = `
      let x = "outside";
      let probeExpr: () => string;
      let probeStmt: () => string;
      switch (probeExpr = function () { return x; }) {
        default:
          probeStmt = function () { return x; };
          let x = "inside";
      }
      export function test(): number {
        return (probeExpr() === "outside" ? 1 : 0) +
          (probeStmt() === "inside" ? 2 : 0);
      }
    `;
    expect(await runStandalone(source)).toBe(3);
  });

  it("removes the CaseBlock environment after fall-through", async () => {
    const source = `
      let x = "outside";
      let probe1: () => string;
      let probe2: () => string;
      switch (null) {
        case null:
          let x = "inside";
          probe1 = function () { return x; };
        case null:
          probe2 = function () { return x; };
      }
      export function test(): number {
        return (probe1() === "inside" ? 1 : 0) +
          (probe2() === "inside" ? 2 : 0) +
          (x === "outside" ? 4 : 0);
      }
    `;
    expect(await runStandalone(source)).toBe(7);
  });

  it("uses a fresh CaseBlock slot when a function-local name is shadowed", async () => {
    const source = `
      export function test(): number {
        let x = "outside";
        let probe: () => string = function () { return "unset"; };
        switch (0) {
          default:
            let x = "inside";
            probe = function () { return x; };
        }
        return (probe() === "inside" ? 1 : 0) + (x === "outside" ? 2 : 0);
      }
    `;
    expect(await runStandalone(source)).toBe(3);
  });

  it("preserves a pre-hoisted CaseBlock slot with no outer shadow", async () => {
    const source = `
      let probe: () => string;
      switch (0) {
        default:
          let x = "inside";
          probe = function () { return x; };
      }
      export function test(): number {
        return probe() === "inside" ? 1 : 0;
      }
    `;
    expect(await runStandalone(source)).toBe(1);
  });

  it("does not leak CaseBlock const/let bindings", async () => {
    const source = `
      switch (0) { default: const x = 1; }
      switch (0) { default: let y = 1; }
      export function test(): number {
        let result = 0;
        try { x; } catch (e) { if (e instanceof ReferenceError) result += 1; }
        try { y; } catch (e) { if (e instanceof ReferenceError) result += 2; }
        return result;
      }
    `;
    expect(await runStandalone(source)).toBe(3);
  });
});
