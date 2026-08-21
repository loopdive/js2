// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";

const CLASSES_SOURCE = readFileSync(new URL("../website/playground/examples/js/classes.ts", import.meta.url), "utf8");

function classBodyRoots(result: CompileResult): string[] {
  return (
    result.irBodyRouteAudit?.legacyEntries
      .filter((entry) => entry.entryPoint === "compileClassBodies" && entry.unitId === undefined)
      .map((entry) => entry.bodyName) ?? []
  );
}

async function compileClasses(target: "gc" | "standalone"): Promise<CompileResult> {
  return compile(CLASSES_SOURCE, {
    fileName: "website/playground/examples/js/classes.ts",
    target,
    experimentalIR: true,
    trackIrOutcomes: true,
    optimize: false,
  });
}

describe("#4584 standalone prepared class physical-route cutover", () => {
  it("bypasses the two exact prepared class walkers with byte-identical output", async () => {
    const previous = process.env.JS2WASM_PREPARED_CLASS_ROUTE_CUTOVER;
    try {
      Reflect.deleteProperty(process.env, "JS2WASM_PREPARED_CLASS_ROUTE_CUTOVER");
      const candidate = await compileClasses("standalone");
      expect(candidate.success, candidate.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(classBodyRoots(candidate)).toEqual([]);
      expect(candidate.irBodyRouteAudit?.legacyEntries.map((entry) => entry.entryPoint)).toEqual([
        "compileDeclarations",
      ]);
      expect(candidate.irBodyRouteAudit?.dispositions.filter((row) => row.unitKind.startsWith("class-"))).toHaveLength(
        10,
      );
      expect(
        candidate.irBodyRouteAudit?.dispositions
          .filter((row) => row.unitKind.startsWith("class-"))
          .every((row) => row.disposition === "terminal-ir"),
      ).toBe(true);

      process.env.JS2WASM_PREPARED_CLASS_ROUTE_CUTOVER = "0";
      const legacyCorrelationControl = await compileClasses("standalone");
      expect(
        legacyCorrelationControl.success,
        legacyCorrelationControl.errors.map((error) => error.message).join("\n"),
      ).toBe(true);
      expect(classBodyRoots(legacyCorrelationControl)).toEqual(["Animal", "Dog"]);
      expect(candidate.wat).toBe(legacyCorrelationControl.wat);
      expect(Buffer.compare(candidate.binary, legacyCorrelationControl.binary)).toBe(0);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_PREPARED_CLASS_ROUTE_CUTOVER");
      else process.env.JS2WASM_PREPARED_CLASS_ROUTE_CUTOVER = previous;
    }
  });

  it("keeps the WasmGC host lane on its established class walker", async () => {
    const result = await compileClasses("gc");
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(classBodyRoots(result)).toEqual(["Animal", "Dog"]);
  });

  it("rejects a malformed prepared allocation wrapper without a direct retry", async () => {
    const previousTamper = process.env.JS2WASM_TEST_TAMPER_PREPARED_CLASS_NEW;
    const previousDirectPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
    try {
      process.env.JS2WASM_TEST_TAMPER_PREPARED_CLASS_NEW = "Animal";
      process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Animal_new";
      const result = await compileClasses("standalone");
      expect(result.success).toBe(false);
      expect(
        result.errors.some((error) => error.message.includes("constructor wrapper body mismatch: Animal_new")),
      ).toBe(true);
      expect(result.errors.some((error) => error.message.includes("injected direct class-body poison"))).toBe(false);
      expect(classBodyRoots(result)).toEqual([]);
    } finally {
      if (previousTamper === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_TAMPER_PREPARED_CLASS_NEW");
      else process.env.JS2WASM_TEST_TAMPER_PREPARED_CLASS_NEW = previousTamper;
      if (previousDirectPoison === undefined) {
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
      } else {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previousDirectPoison;
      }
    }
  });

  it("leaves a mixed unsupported class on the fail-closed legacy route", async () => {
    const result = await compile(
      `
      class Box {
        constructor(public value: number) {}
        read(): number { return this.value; }
      }
      export function main(): number { return new Box(7).read(); }
      `,
      {
        fileName: "issue-4584-mixed-class.ts",
        target: "standalone",
        experimentalIR: true,
        trackIrOutcomes: true,
        optimize: false,
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(classBodyRoots(result)).toEqual(["Box"]);
    expect(
      result.irOutcomes?.find((outcome) => outcome.unitKind === "class-member" && outcome.displayName === "Box_new"),
    ).toMatchObject({ kind: "unsupported", legacyBodyEmitted: true, irBodyEmitted: false });
  });
});
