// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  consumedHarnessSymbols,
  harnessObjectSourceKey,
  inventoryHarnessAbi,
} from "../scripts/test262-linked-harness-inventory.js";
import { assembleLinkedHarness, type HarnessSourcePart } from "./test262-original-harness.js";

describe("#3451 linked-harness split and key", () => {
  it("keeps the harness strict-neutral and puts strictness first in the body unit", () => {
    const assembly = assembleLinkedHarness("assert.sameValue(1, 1);\n", { flags: [] });

    expect(assembly.harnessPrefix.startsWith('"use strict"')).toBe(false);
    expect(assembly.primary.bodySource).toBe("assert.sameValue(1, 1);\n");
    expect(assembly.primary.bodyLineOffset).toBe(0);
    expect(assembly.strictRerun?.bodySource).toBe('"use strict";\nassert.sameValue(1, 1);\n');
    expect(assembly.strictRerun?.bodyLineOffset).toBe(1);
  });

  it("keys only the immutable harness input, not body text or strictness", () => {
    const first = assembleLinkedHarness("assert.sameValue(1, 1);\n", { flags: [] });
    const second = assembleLinkedHarness("assert.sameValue(2, 2);\n", { flags: ["onlyStrict"] });

    expect(harnessObjectSourceKey(first)).toBe(harnessObjectSourceKey(second));
  });

  it("distinguishes ordered include sets", () => {
    const a = assembleLinkedHarness("compareArray([], []);\n", {
      includes: ["compareArray.js", "propertyHelper.js"],
    });
    const b = assembleLinkedHarness("compareArray([], []);\n", {
      includes: ["propertyHelper.js", "compareArray.js"],
    });

    expect(harnessObjectSourceKey(a)).not.toBe(harnessObjectSourceKey(b));
  });

  it("makes raw tests bypass harness-object compilation", () => {
    const assembly = assembleLinkedHarness("throw 0;\n", { flags: ["raw"] });

    expect(assembly.harnessPrefix).toBe("");
    expect(assembly.harnessParts).toEqual([]);
    expect(assembly.strictRerun).toBeUndefined();
    expect(harnessObjectSourceKey(assembly)).toBe("raw");
  });
});

describe("#3451 harness ABI inventory", () => {
  const parts: HarnessSourcePart[] = [
    {
      name: "first.js",
      source: "function helper() {}\nvar assert = function () {};\nassert.sameValue = function () {};\n",
    },
    {
      name: "second.js",
      source: "function helper() {}\nclass Test262Error extends Error {}\nvar initialized = helper();\n",
    },
  ];
  const finalPrefix =
    "function helper$dup0() {}\n" +
    "var assert = function () {};\n" +
    "assert.sameValue = function () {};\n" +
    "function helper() {}\n" +
    "class Test262Error extends Error {}\n" +
    "var initialized = helper();\n";

  it("records final declarations, duplicate last-wins inputs, and ordered initialization", () => {
    const inventory = inventoryHarnessAbi(parts, finalPrefix);

    expect(inventory.declaredSymbols).toEqual(["Test262Error", "assert", "helper", "helper$dup0", "initialized"]);
    expect(inventory.duplicateDeclarations).toEqual({
      helper: ["first.js", "second.js"],
    });
    expect(inventory.topLevelEffectStatements).toBeGreaterThanOrEqual(4);
  });

  it("finds body-consumed harness roots but excludes properties and local shadows", () => {
    expect(
      consumedHarnessSymbols(
        "assert.sameValue(1, 1); new Test262Error('x'); obj.helper; function f(assert) { assert(); }",
        ["assert", "sameValue", "Test262Error", "helper"],
      ),
    ).toEqual(["Test262Error", "assert"]);
  });
});
