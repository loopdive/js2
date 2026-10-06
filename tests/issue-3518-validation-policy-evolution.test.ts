// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { capture5883Main4bffInventoryViewSource } from "./helpers/ir-5883-main-4bff-inventory-views.js";
import { capturePositionFinallyMainPredecessorPolicySource } from "./helpers/ir-position-finally-main-successor.js";
import { capturePositionClassFieldsMainPredecessorPolicySource } from "./helpers/ir-position-class-fields-main-successor.js";
import { captureSourceMapPositionInventoryPredecessorPolicySource } from "./helpers/ir-source-map-position-inventory-successor.js";
import { captureMainInventoryPredecessorPolicySource } from "./helpers/ir-main-inventory-source-successor.js";
import {
  captureArrayBufferIsViewMainPredecessorPolicy,
  capturePresentationClassificationPredecessorPolicy,
  captureLoweringAnalysisPredecessorPolicy,
  captureWasmGcHelperPredecessorPolicy,
} from "./helpers/ir-runtime-program-policy-evolution.js";
import { captureProgramValidatorPredecessorPolicy } from "./helpers/ir-runtime-program-policy-evolution.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateIrValidationPolicy,
  authenticateIrValidationPolicyEvolution,
  beforeIrValidationPolicyActivations,
  historicalIrValidationPolicyView,
  irValidationPolicyActivations,
  irValidationPolicyReceiptPath,
} from "./helpers/ir-validation-policy-evolution.js";
import {
  captureNestedStackificationPredecessorPolicy,
  captureCanonical489dPredecessorPolicy,
  beforeCanonical3c6InventoryPolicy,
  beforeIrRuntimeProgramPolicy,
  beforeWellKnownSymbolPolicy,
  beforeGeneratorInventoryPolicy,
  beforeHostCarrierInventoryPolicy,
  beforeDynamicCodeInventoryPolicy,
  beforeRuntimePreparationPolicy,
  beforeNumberPrerequisitePolicy,
  beforeCurrentMainInventoryPolicy,
} from "./helpers/ir-runtime-program-policy-evolution.js";

afterEach(async () => {
  // Yield between synchronous source proofs so Vitest can process task-update RPCs.
  await setImmediate();
});

interface MutablePolicy {
  layers: { id: string; entries: string[]; roots: string[]; minModules: number; status: string; required: boolean }[];
  activationHistory: { layer: string; entries: string[]; minModules: number }[];
  files: Record<string, string>[];
  allowedEdges: Record<string, string[]>;
  [key: string]: unknown;
}
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const receiptText = read(irValidationPolicyReceiptPath);
const receipt = authenticateIrValidationPolicyEvolution(receiptText);
function actual(): MutablePolicy {
  const policy = beforeIrRuntimeProgramPolicy(
    beforeWellKnownSymbolPolicy(
      beforeNumberPrerequisitePolicy(
        beforeRuntimePreparationPolicy(
          beforeDynamicCodeInventoryPolicy(
            beforeHostCarrierInventoryPolicy(
              beforeGeneratorInventoryPolicy(
                beforeCurrentMainInventoryPolicy(
                  beforeCanonical3c6InventoryPolicy(
                    captureCanonical489dPredecessorPolicy(
                      captureNestedStackificationPredecessorPolicy(
                        captureProgramValidatorPredecessorPolicy(
                          captureWasmGcHelperPredecessorPolicy(
                            captureLoweringAnalysisPredecessorPolicy(
                              capturePresentationClassificationPredecessorPolicy(
                                captureArrayBufferIsViewMainPredecessorPolicy(
                                  JSON.parse(
                                    captureMainInventoryPredecessorPolicySource(
                                      captureSourceMapPositionInventoryPredecessorPolicySource(
                                        capturePositionClassFieldsMainPredecessorPolicySource(
                                          capturePositionFinallyMainPredecessorPolicySource(
                                            capture5883Main4bffInventoryViewSource(
                                              read("scripts/compiler-boundaries.json"),
                                              "union-to-incoming",
                                            ),
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ) as MutablePolicy;
  // Every negative begins with a genuinely passing current-policy control.
  authenticateIrValidationPolicy(policy);
  return policy;
}
function layer(policy: MutablePolicy, id: string) {
  const rows = policy.layers.filter((row) => row.id === id);
  if (rows.length !== 1) throw new Error(`expected one actual layer ${id}`);
  return rows[0]!;
}
function rejected(change: (policy: MutablePolicy) => void): void {
  const policy = actual(),
    before = digest(policy);
  change(policy);
  expect(digest(policy)).not.toBe(before);
  expect(() => authenticateIrValidationPolicy(policy)).toThrow("validation policy evolution:");
  expect(() => historicalIrValidationPolicyView(policy)).toThrow("validation policy evolution:");
}

describe("Phase B exact current policy and bounded historical metadata", () => {
  it("authenticates all actual rows, complete history, exact B order and reciprocal baseline", () => {
    const policy = actual();
    expect(policy.files).toHaveLength(1765);
    expect(policy.activationHistory).toHaveLength(94);
    expect(beforeIrValidationPolicyActivations(policy.activationHistory)).toHaveLength(91);
    expect(digest(policy.activationHistory.slice(0, 91))).toBe(
      "906d96d460433bb445216a2ed6fe10ffd7bf7dbbebbe1a9f557b0f878ad4403f",
    );
    expect(policy.activationHistory.slice(91)).toEqual(irValidationPolicyActivations);
    expect(irValidationPolicyActivations.map((row) => [row.layer, row.minModules])).toEqual([
      ["ir-analysis", 6],
      ["ir-runtime", 1],
      ["ir-program", 2],
    ]);
    expect(receipt.before.fileCount).toBe(1761);
    expect(receipt.fileReclassifications).toHaveLength(5);
    expect(receipt.addedFiles.map((row) => row.path)).toEqual([
      "src/ir/analysis/alloc-verification.ts",
      "src/ir/runtime/verify.ts",
      "src/ir/program/allocations.ts",
      "src/ir/program/class-layouts.ts",
    ]);
    expect(layer(policy, "ir-analysis").minModules).toBe(11);
    expect(layer(policy, "ir-runtime").minModules).toBe(18);
    expect(layer(policy, "ir-program").minModules).toBe(40);
    expect(layer(policy, "native-runtime").entries).toHaveLength(98);
    expect(layer(policy, "native-runtime").minModules).toBe(97);
  });

  it("projects exactly the old56 and actual original9 only after full authentication", () => {
    const policy = actual(),
      view = historicalIrValidationPolicyView(policy);
    expect(view.layers.map((row) => [row.id, row.entries.length, row.minModules])).toEqual([
      ["foundation", 6, 6],
      ["wasm-model", 1, 1],
      ["wasm-physical", 1, 1],
      ["native-runtime", 1, 1],
      ["ir-core", 15, 15],
      ["ir-analysis", 5, 5],
      ["ir-passes", 1, 1],
      ["ir-program", 12, 12],
      ["runtime-contracts", 4, 4],
      ["ir-runtime", 10, 10],
    ]);
    expect(view.layers.flatMap((row) => row.entries)).toHaveLength(56);
    expect(view.activationHistory).toHaveLength(9);
    expect(view.activationHistory).toEqual(policy.activationHistory.slice(66, 75));
    expect(digest(view.activationHistory)).toBe("820a39c3d3b05a1a20d030ae10b1e19621802cfed5cf9a29ccb5dccb80b3d6ee");
    expect(view.layerActivations).toHaveLength(10);
    for (const row of view.layers)
      expect(layer(policy, row.id).entries.slice(0, row.entries.length)).toEqual(row.entries);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.layers[0]!.entries)).toBe(true);
    expect(() => authenticateIrValidationPolicy(view)).toThrow();
  });

  it("keeps old history mutants mutable without changing the actual policy or a later read", () => {
    const policy = actual(),
      before = digest(policy);
    const prefix = beforeIrValidationPolicyActivations(policy.activationHistory),
      prefixBefore = digest(prefix);
    expect(Object.isFrozen(prefix)).toBe(false);
    expect(Object.isFrozen(prefix[0])).toBe(false);
    expect(Reflect.set(prefix[0]!, "minModules", -1)).toBe(true);
    expect(digest(prefix)).not.toBe(prefixBefore);
    expect(digest(policy)).toBe(before);
    expect(digest(beforeIrValidationPolicyActivations(policy.activationHistory))).toBe(prefixBefore);
    expect(() => beforeIrValidationPolicyActivations(prefix)).toThrow();
    authenticateIrValidationPolicy(policy);
  });

  const entryMutations = ["delete", "duplicate", "replace", "reorder", "unknown"] as const;
  const entries = ["ir-analysis", "ir-runtime", "ir-program"].flatMap((id) =>
    ["original", "new"].flatMap((position) => entryMutations.map((mutation) => ({ id, position, mutation }))),
  );
  it.each(entries)("rejects $mutation of $position $id entries", ({ id, position, mutation }) =>
    rejected((policy) => {
      const values = layer(policy, id).entries,
        index = position === "original" ? 0 : values.length - 1;
      if (mutation === "delete") values.splice(index, 1);
      if (mutation === "duplicate") values.splice(index, 0, values[index]!);
      if (mutation === "replace") values[index] += ".lookalike";
      if (mutation === "reorder")
        [values[index], values[index === 0 ? 1 : 0]] = [values[index === 0 ? 1 : 0]!, values[index]!];
      if (mutation === "unknown") values.splice(index, 0, "src/unreviewed.ts");
    }),
  );

  it.each([0, 66, 74, 88, 90, 91, 92, 93])("rejects altered or missing activation at %i", (index) => {
    for (const mutate of [
      (p: MutablePolicy) => {
        p.activationHistory[index]!.entries[0] += ".wrong";
      },
      (p: MutablePolicy) => {
        p.activationHistory.splice(index, 1);
      },
      (p: MutablePolicy) => {
        p.activationHistory.splice(index, 0, structuredClone(p.activationHistory[index]!));
      },
      (p: MutablePolicy) => {
        p.activationHistory[index]!.minModules++;
      },
    ]) {
      const p = actual();
      mutate(p);
      expect(() => beforeIrValidationPolicyActivations(p.activationHistory)).toThrow();
      expect(() => historicalIrValidationPolicyView(p)).toThrow();
    }
  });
  it("rejects reordered B activations and an unknown extra activation", () => {
    rejected((p) => {
      [p.activationHistory[91], p.activationHistory[92]] = [p.activationHistory[92]!, p.activationHistory[91]!];
    });
    rejected((p) => {
      p.activationHistory.push({ layer: "ir-analysis", entries: ["src/unknown.ts"], minModules: 1 });
    });
  });
  it.each(["ir-analysis", "ir-runtime", "ir-program", "native-runtime"])("rejects changed current floor %s", (id) => {
    rejected((p) => {
      layer(p, id).minModules++;
    });
    rejected((p) => {
      layer(p, id).minModules--;
    });
  });
  it("rejects broad analysis activation, missing roots, and an unreviewed allowed edge", () => {
    rejected((p) => {
      layer(p, "ir-analysis").roots = ["src/ir/analysis"];
    });
    rejected((p) => {
      layer(p, "ir-analysis").roots.pop();
    });
    rejected((p) => {
      p.allowedEdges["ir-analysis"]!.push("frontend-ts");
    });
  });
  it.each(receipt.fileReclassifications)("requires the exact current analysis row at $index", (change) => {
    rejected((p) => {
      p.files[change.index] = { ...change.before };
    });
    rejected((p) => {
      p.files[change.index]!.state = "unmigrated";
    });
    rejected((p) => {
      p.files[change.index]!.layer = "mixed-needs-split";
    });
  });
  it.each(receipt.addedFiles)("requires new classification $path", (row) => {
    rejected((p) => {
      p.files = p.files.filter((v) => v.path !== row.path);
    });
    rejected((p) => {
      p.files.push({ ...row });
    });
  });
  it.each(receipt.conservativeFacades)("keeps conservative facade $path", (row) => {
    rejected((p) => {
      p.files.find((v) => v.path === row.path)!.state = "clean";
    });
  });
  it("checks all existing rows and rereads a previously accepted object after mutation", () => {
    rejected((p) => {
      p.files[0]!.path += ".foreign";
    });
    rejected((p) => {
      [p.files[0], p.files[1]] = [p.files[1]!, p.files[0]!];
    });
    const p = actual();
    historicalIrValidationPolicyView(p);
    p.files[0]!.path += ".stale";
    expect(() => historicalIrValidationPolicyView(p)).toThrow();
  });
  it("rejects getter, hidden, symbol, cyclic, sparse and inherited policy data without executing getters", () => {
    let calls = 0;
    const p = actual();
    Object.defineProperty(p, "files", {
      enumerable: true,
      get() {
        calls++;
        return [];
      },
    });
    expect(() => authenticateIrValidationPolicy(p)).toThrow();
    expect(calls).toBe(0);
    for (const mutate of [
      (v: MutablePolicy) => {
        Object.defineProperty(v, "hidden", { value: 1 });
      },
      (v: MutablePolicy) => {
        Object.defineProperty(v, Symbol("extra"), { value: 1, enumerable: true });
      },
      (v: MutablePolicy) => {
        v.extra = v;
      },
      (v: MutablePolicy) => {
        v.extra = undefined;
      },
      (v: MutablePolicy) => {
        const originalLength = v.activationHistory.length;
        expect(Reflect.deleteProperty(v.activationHistory, "1")).toBe(true);
        expect(v.activationHistory.length).toBe(originalLength);
        expect(Object.hasOwn(v.activationHistory, "1")).toBe(false);
      },
      (v: MutablePolicy) => {
        Object.setPrototypeOf(v, { inherited: true });
      },
      (v: MutablePolicy) => {
        v.toJSON = () => actual();
      },
    ]) {
      const v = actual();
      mutate(v);
      expect(() => authenticateIrValidationPolicy(v)).toThrow();
    }
  });
  it("rejects a changed fixed receipt and a before-B or double-projected policy", () => {
    expect(() => authenticateIrValidationPolicyEvolution(receiptText + "\n")).toThrow("receipt digest mismatch");
    const p = actual();
    p.activationHistory.splice(91);
    expect(() => authenticateIrValidationPolicy(p)).toThrow();
    const prefix = beforeIrValidationPolicyActivations(actual().activationHistory);
    expect(() => beforeIrValidationPolicyActivations(prefix)).toThrow();
  });
});
