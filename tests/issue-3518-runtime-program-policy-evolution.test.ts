// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureNestedStackificationPredecessorPolicy,
  captureNestedStackificationPredecessorPolicySource,
  captureCanonical489dPredecessorPolicy,
  beforeCanonical3c6InventoryPolicy,
  captureCanonical489dPredecessorPolicySource,
  beforeCanonical3c6InventoryPolicySource,
  authenticateIrRuntimeProgramPolicy,
  authenticateIrRuntimeProgramPolicyEvolution,
  beforeIrRuntimeProgramPolicy,
  beforeWellKnownSymbolPolicy,
  beforeGeneratorInventoryPolicy,
  beforeHostCarrierInventoryPolicy,
  beforeDynamicCodeInventoryPolicy,
  beforeGeneratorInventoryPolicySource,
  beforeHostCarrierInventoryPolicySource,
  beforeDynamicCodeInventoryPolicySource,
  beforeRuntimePreparationPolicy,
  beforeNumberPrerequisitePolicy,
  beforeRuntimePreparationPolicySource,
  beforeNumberPrerequisitePolicySource,
  beforeWellKnownSymbolPolicySource,
  irRuntimeProgramPolicyReceiptPath,
  type MutableIrRuntimeProgramPolicy as Policy,
  type IrRuntimeProgramPolicyReceipt as Receipt,
  beforeCurrentMainInventoryPolicy,
  beforeCurrentMainInventoryPolicySource,
} from "./helpers/ir-runtime-program-policy-evolution.js";
import {
  authenticateIrValidationPolicy,
  beforeIrValidationPolicyActivations,
  historicalIrValidationPolicyView,
} from "./helpers/ir-validation-policy-evolution.js";
afterEach(async () => {
  // Yield between synchronous source proofs so Vitest can process task-update RPCs.
  await setImmediate();
});
import { c1HistoricalArtifactPath, type C1HistoricalLogicalPath } from "./helpers/ir-c1-historical-authority.js";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const historicalPolicyOperandPaths: readonly string[] = [
  "tests/issue-3518-runtime-program-relocation.test.ts",
  "tests/issue-3518-program-data-contract-seam.test.ts",
  "tests/issue-3518-program-ownership-runtime-seam.test.ts",
  "tests/issue-3518-program-pre-a-evolution.test.ts",
  "tests/issue-3518-program-initial-graph-evolution.test.ts",
  "tests/helpers/ir-runtime-program-policy-evolution.ts",
];
const historicalPolicyPhysicalPath = (path: string): string =>
  historicalPolicyOperandPaths.includes(path) ? c1HistoricalArtifactPath(path as C1HistoricalLogicalPath) : path;
// Raw physical operand reads let the original mutation assertions inspect corruption before the guard rejects it.
const readHistoricalPolicyOperand = (path: string): string => read(historicalPolicyPhysicalPath(path));
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const digest = (value: unknown): string => sha(JSON.stringify(value));
const receiptText = read(irRuntimeProgramPolicyReceiptPath);
const receipt = authenticateIrRuntimeProgramPolicyEvolution(receiptText);
function actual(): Policy {
  const policy = beforeWellKnownSymbolPolicy(
    beforeNumberPrerequisitePolicy(
      beforeRuntimePreparationPolicy(
        beforeDynamicCodeInventoryPolicy(
          beforeHostCarrierInventoryPolicy(
            beforeGeneratorInventoryPolicy(
              beforeCurrentMainInventoryPolicy(
                beforeCanonical3c6InventoryPolicy(
                  captureCanonical489dPredecessorPolicy(
                    captureNestedStackificationPredecessorPolicy(JSON.parse(read("scripts/compiler-boundaries.json"))),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ) as Policy;
  authenticateIrRuntimeProgramPolicy(policy);
  return policy;
}
function refused(value: unknown): void {
  expect(() => authenticateIrRuntimeProgramPolicy(value)).toThrow("runtime program policy evolution:");
  expect(() => beforeIrRuntimeProgramPolicy(value)).toThrow("runtime program policy evolution:");
}
function rejected(change: (policy: Policy) => void): void {
  const policy = actual(),
    before = digest(policy);
  change(policy);
  expect(digest(policy)).not.toBe(before);
  refused(policy);
  authenticateIrRuntimeProgramPolicy(actual());
}
function deepFrozen(value: unknown): void {
  if (value !== null && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) deepFrozen(child);
  }
}
function replay(before: Policy): Policy {
  const p = JSON.parse(JSON.stringify(before)) as Policy;
  p.files.push(
    { path: "src/ir/program/owner.ts", state: "clean", layer: "ir-program" },
    { path: "src/ir/program/draft-abi-lookup.ts", state: "clean", layer: "ir-program" },
    { path: "src/ir/program/runtime-support-dependencies.ts", state: "clean", layer: "ir-program" },
    { path: "src/ir/runtime/generator-support.ts", state: "clean", layer: "ir-runtime" },
  );
  const program = [
    "src/ir/program/owner.ts",
    "src/ir/program/draft-abi-lookup.ts",
    "src/ir/program/runtime-support-dependencies.ts",
  ];
  p.layers[9]!.entries!.push(...program);
  p.layers[9]!.minModules = 43;
  p.layers[8]!.entries!.push("src/ir/runtime/generator-support.ts");
  p.layers[8]!.minModules = 19;
  p.activationHistory.push(
    { layer: "ir-program", entries: program, minModules: 3 },
    { layer: "ir-runtime", entries: ["src/ir/runtime/generator-support.ts"], minModules: 1 },
  );
  return p;
}

describe("C1 exact policy inverse and reciprocal B proof", () => {
  it("authenticates WKS-derived C1 raw and complete ordered data with independently fixed populations", () => {
    const raw = beforeWellKnownSymbolPolicySource(
        beforeNumberPrerequisitePolicySource(
          beforeRuntimePreparationPolicySource(
            beforeDynamicCodeInventoryPolicySource(
              beforeHostCarrierInventoryPolicySource(
                beforeGeneratorInventoryPolicySource(
                  beforeCurrentMainInventoryPolicySource(
                    beforeCanonical3c6InventoryPolicySource(
                      captureCanonical489dPredecessorPolicySource(
                        captureNestedStackificationPredecessorPolicySource(read("scripts/compiler-boundaries.json")),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      p = actual();
    expect(Buffer.byteLength(raw)).toBe(565188);
    expect(sha(raw)).toBe("460eb6835dff1d22322ac9fb0fdd9526f04cd09d99d4dec8138f8e66b91ffd57");
    expect(digest(p)).toBe("f24c0f10d4e8e9b5dc23471ec327f2fab7312890a5d4db035066e8c189ed2a11");
    expect(p.files).toHaveLength(1769);
    expect(p.activationHistory).toHaveLength(96);
    expect(p.layers).toHaveLength(20);
    expect([p.layers[9]!.entries!.length, p.layers[8]!.entries!.length]).toEqual([43, 19]);
    expect(
      ["ir-program", "ir-runtime", "native-runtime"].map((id) => p.files.filter((row) => row.layer === id).length),
    ).toEqual([44, 19, 103]);
    expect(Object.keys(p)).toEqual([
      "schema",
      "description",
      "sourceRoot",
      "tsconfig",
      "requireGitProvenance",
      "externalAssets",
      "frontendWrapper",
      "moduleExtensions",
      "layers",
      "allowedEdges",
      "externalPackages",
      "activationHistory",
      "nonModules",
      "moves",
      "evidence",
      "files",
    ]);
  });
  it("pins all eighteen unchanged B authority, C1 source proof and reader inputs", () => {
    const read = readHistoricalPolicyOperand;
    expect(receipt.provenance.immutableInputs).toHaveLength(18);
    for (const pin of receipt.provenance.immutableInputs) {
      const text = read(pin.path);
      expect(Buffer.byteLength(text)).toBe(pin.bytes);
      expect(sha(text)).toBe(pin.sha256);
    }
  });
  it("derives B from actual C1 and independently replays complete ordered C1", () => {
    const p = actual(),
      original = JSON.stringify(p),
      b = beforeIrRuntimeProgramPolicy(p);
    expect(digest(b)).toBe("e8d0034c26f59e042da49dfcc4af562436b562421b9e231ae78d664ab70c73e3");
    expect(b.files).toHaveLength(1765);
    expect(b.activationHistory).toHaveLength(94);
    expect(JSON.stringify(replay(b))).toBe(original);
    authenticateIrValidationPolicy(b);
    expect(beforeIrValidationPolicyActivations(b.activationHistory)).toHaveLength(91);
    const historical = historicalIrValidationPolicyView(b);
    expect(historical.layers.reduce((n, row) => n + row.entries.length, 0)).toBe(56);
    expect(historical.activationHistory).toHaveLength(9);
    expect(JSON.stringify(p)).toBe(original);
  });
  it("returns frozen detached current and mutable detached B copies on every call", () => {
    const p = actual(),
      original = JSON.stringify(p),
      a = authenticateIrRuntimeProgramPolicy(p),
      a2 = authenticateIrRuntimeProgramPolicy(p);
    deepFrozen(a);
    expect(a).not.toBe(p);
    expect(a2).not.toBe(a);
    expect(a.files[0]).not.toBe(p.files[0]);
    const b = beforeIrRuntimeProgramPolicy(p),
      b2 = beforeIrRuntimeProgramPolicy(p);
    expect(b).not.toBe(b2);
    expect(b.files).not.toBe(b2.files);
    expect(b.files[0]).not.toBe(b2.files[0]);
    expect(Object.isFrozen(b)).toBe(false);
    expect(Object.isFrozen(b.layers[9]!.entries)).toBe(false);
    b.files[0]!.state = "unmigrated";
    expect(b.files[0]!.state).toBe("unmigrated");
    expect(() => authenticateIrValidationPolicy(b)).toThrow("validation policy evolution:");
    expect(JSON.stringify(p)).toBe(original);
    authenticateIrValidationPolicy(b2);
    authenticateIrRuntimeProgramPolicy(actual());
  });
  for (const [name, input] of [
    ["before-C1 B", () => beforeIrRuntimeProgramPolicy(actual())],
    ["pre-B historical view", () => historicalIrValidationPolicyView(beforeIrRuntimeProgramPolicy(actual()))],
    ["history-only", () => actual().activationHistory],
    ["empty object", () => ({})],
  ] as const)
    it(`rejects ${name} as full current policy`, () => refused(input()));

  for (const index of [1765, 1766, 1767, 1768]) {
    for (const operation of [
      "delete",
      "duplicate",
      "replace",
      "reorder",
      "unknown-addition",
      "state",
      "layer",
      "key-order",
    ] as const) {
      it(`rejects new file ${index} ${operation}`, () =>
        rejected((p) => {
          const row = p.files[index]!;
          if (operation === "delete") p.files.splice(index, 1);
          if (operation === "duplicate") p.files.splice(index, 0, { ...row });
          if (operation === "replace") row.path = "src/ir/program/unknown.ts";
          if (operation === "unknown-addition")
            p.files.splice(index, 0, { path: "src/ir/program/unknown.ts", state: "clean", layer: "ir-program" });
          if (operation === "reorder") [p.files[index], p.files[0]] = [p.files[0]!, row];
          if (operation === "state") row.state = "unmigrated";
          if (operation === "layer") row.layer = "ir-core";
          if (operation === "key-order") p.files[index] = { layer: row.layer!, path: row.path!, state: row.state! };
        }));
    }
  }
  for (const [index, label, entry] of [
    [9, "program old", 0],
    [9, "program owner", 40],
    [9, "program lookup", 41],
    [9, "program support", 42],
    [8, "runtime old", 0],
    [8, "runtime generator", 18],
  ] as const) {
    for (const operation of ["delete", "duplicate", "replace", "reorder", "unknown-addition"] as const) {
      it(`rejects ${label} entry ${operation}`, () =>
        rejected((p) => {
          const entries = p.layers[index]!.entries!,
            old = entries[entry]!;
          if (operation === "delete") entries.splice(entry, 1);
          if (operation === "duplicate") entries.splice(entry, 0, old);
          if (operation === "replace") entries[entry] = "src/ir/program/unknown.ts";
          if (operation === "reorder") [entries[entry], entries[1]] = [entries[1]!, old];
          if (operation === "unknown-addition") entries.push("src/ir/program/unknown.ts");
        }));
    }
  }
  for (const index of [94, 95])
    for (const operation of [
      "delete",
      "duplicate",
      "replace",
      "reorder",
      "unknown-addition",
      "layer",
      "floor",
      "entry-delete",
      "entry-duplicate",
      "entry-replace",
      "key-order",
    ] as const) {
      it(`rejects activation ${index} ${operation}`, () =>
        rejected((p) => {
          const row = p.activationHistory[index]!;
          if (operation === "delete") p.activationHistory.splice(index, 1);
          if (operation === "duplicate") p.activationHistory.splice(index, 0, row);
          if (operation === "replace")
            p.activationHistory[index] = { layer: "ir-core", entries: ["src/ir/core/types.ts"], minModules: 1 };
          if (operation === "reorder")
            [p.activationHistory[index], p.activationHistory[0]] = [p.activationHistory[0]!, row];
          if (operation === "unknown-addition")
            p.activationHistory.push({ layer: "unknown", entries: [], minModules: 0 });
          if (operation === "layer") row.layer = "ir-core";
          if (operation === "floor") row.minModules += 1;
          if (operation === "entry-delete") row.entries.pop();
          if (operation === "entry-duplicate") row.entries.push(row.entries[0]!);
          if (operation === "entry-replace") row.entries[0] = "src/ir/program/unknown.ts";
          if (operation === "key-order")
            p.activationHistory[index] = { entries: row.entries, minModules: row.minModules, layer: row.layer };
        }));
    }
  it("rejects order-only program activation entry changes", () =>
    rejected((p) => p.activationHistory[94]!.entries.reverse()));
  for (const index of [8, 9])
    for (const field of ["id", "status", "required", "roots", "minModules"] as const) {
      it(`rejects layer ${index} ${field}`, () =>
        rejected((p) => {
          const row = p.layers[index]!;
          if (field === "id") row.id = "unknown";
          if (field === "status") row.status = "planned";
          if (field === "required") row.required = false;
          if (field === "roots") row.roots[0] = "src/ir";
          if (field === "minModules") row.minModules! -= 1;
        }));
    }
  for (const collection of ["files", "activationHistory", "layers"] as const)
    for (const operation of ["delete", "duplicate", "replace", "reorder", "unknown-addition"] as const) {
      it(`rejects original ${collection} prefix ${operation}`, () =>
        rejected((p) => {
          // Keep the three independently typed arrays distinct; the operations are identical.
          const rows: unknown[] = p[collection];
          const old = rows[0];
          if (operation === "delete") rows.splice(0, 1);
          if (operation === "duplicate") rows.splice(0, 0, old);
          if (operation === "replace") rows[0] = { unknown: true };
          if (operation === "reorder") [rows[0], rows[1]] = [rows[1], old];
          if (operation === "unknown-addition") rows.push({ unknown: true });
        }));
    }
  for (const path of [
    "src/ir/analysis/dominance.ts",
    "src/ir/verify.ts",
    "src/ir/verify-alloc.ts",
    "src/ir/program-allocations.ts",
    "src/ir/program-class-layouts.ts",
  ]) {
    it(`rejects old classification change ${path}`, () =>
      rejected((p) => {
        const row = p.files.find((row) => row.path === path)!;
        expect(row).toBeDefined();
        row.layer = "ir-core";
      }));
  }
  for (const [id, index] of [
    ["analysis", 6],
    ["core", 5],
    ["native", 12],
  ] as const) {
    it(`rejects preserved ${id} floor`, () =>
      rejected((p) => {
        p.layers[index]!.minModules! += 1;
      }));
  }
  for (const [name, mutate] of [
    [
      "before digest",
      (r: Receipt) => {
        r.before.dataSha256 = "0".repeat(64);
      },
    ],
    [
      "current digest",
      (r: Receipt) => {
        r.current.dataSha256 = "0".repeat(64);
      },
    ],
    [
      "reviewed base",
      (r: Receipt) => {
        r.provenance.reviewedBase = "unknown";
      },
    ],
    [
      "immutable B authority",
      (r: Receipt) => {
        r.provenance.immutableInputs[17]!.sha256 = "0".repeat(64);
      },
    ],
    [
      "raw bytes",
      (r: Receipt) => {
        r.current.source.bytes -= 1;
      },
    ],
    [
      "raw pin",
      (r: Receipt) => {
        r.current.source.sha256 = "0".repeat(64);
      },
    ],
    [
      "file denominator",
      (r: Receipt) => {
        r.current.fileCount -= 1;
      },
    ],
    [
      "history denominator",
      (r: Receipt) => {
        r.current.activationCount -= 1;
      },
    ],
    [
      "recipe suffix",
      (r: Receipt) => {
        r.addedFiles[0]!.path = "unknown";
      },
    ],
    [
      "recipe layer",
      (r: Receipt) => {
        r.layerDeltas[0]!.beforeEntries -= 1;
      },
    ],
    [
      "receipt census",
      (r: Receipt) => {
        r.census.classifiedProgram = 43;
      },
    ],
  ] as const)
    it(`rejects changed receipt ${name}`, () => {
      const r = JSON.parse(receiptText);
      mutate(r);
      const text = JSON.stringify(r);
      expect(text).not.toBe(receiptText);
      expect(() => authenticateIrRuntimeProgramPolicyEvolution(text)).toThrow("receipt digest mismatch");
    });
  it("rejects allowed edge replacement at fixed count", () =>
    rejected((p) => {
      const key = Object.keys(p.allowedEdges).find((key) => p.allowedEdges[key]!.length > 0)!;
      p.allowedEdges[key]![0] = "unknown";
    }));
  for (const field of [
    "schema",
    "description",
    "sourceRoot",
    "tsconfig",
    "requireGitProvenance",
    "externalAssets",
    "frontendWrapper",
    "moduleExtensions",
    "externalPackages",
    "nonModules",
    "moves",
    "evidence",
  ]) {
    it(`rejects unrelated field ${field}`, () =>
      rejected((p) => {
        p[field] = { altered: true };
      }));
  }
  for (const [name, mutate] of [
    [
      "old row",
      (p: Policy) => {
        p.files[0]!.state = "altered";
      },
    ],
    [
      "new row",
      (p: Policy) => {
        p.files[1765]!.state = "altered";
      },
    ],
    [
      "layer entry",
      (p: Policy) => {
        p.layers[9]!.entries![40] = "altered";
      },
    ],
    [
      "history tail",
      (p: Policy) => {
        p.activationHistory[95]!.minModules = 2;
      },
    ],
  ] as const)
    it(`recaptures previously accepted object after changing ${name}`, () => {
      const p = actual(),
        first = authenticateIrRuntimeProgramPolicy(p),
        original = digest(first);
      mutate(p);
      expect(digest(p)).not.toBe(original);
      refused(p);
      expect(digest(first)).toBe(original);
      authenticateIrRuntimeProgramPolicy(actual());
    });

  for (const location of ["root", "row", "array-index"] as const)
    it(`rejects ${location} getter without invoking it`, () => {
      const p = actual();
      let calls = 0;
      const target = location === "root" ? p : location === "row" ? p.files[1765]! : p.files;
      const key = location === "root" ? "files" : location === "row" ? "path" : "1765";
      Object.defineProperty(target, key, {
        enumerable: true,
        configurable: true,
        get() {
          calls++;
          throw new Error("getter executed");
        },
      });
      expect(Object.getOwnPropertyDescriptor(target, key)!.get).toBeDefined();
      refused(p);
      expect(calls).toBe(0);
    });
  for (const location of ["root", "row", "array"] as const)
    for (const kind of ["hidden", "symbol", "toJSON"] as const) {
      it(`rejects ${location} ${kind} without serialization effects`, () => {
        const p = actual();
        let calls = 0;
        const target = location === "root" ? p : location === "row" ? p.files[1765]! : p.files;
        const key = kind === "symbol" ? Symbol("extra") : kind === "toJSON" ? "toJSON" : "hidden";
        Object.defineProperty(target, key, {
          enumerable: kind !== "hidden",
          value:
            kind === "toJSON"
              ? () => {
                  calls++;
                  return {};
                }
              : true,
        });
        expect(Reflect.ownKeys(target)).toContain(key);
        refused(p);
        expect(calls).toBe(0);
      });
    }
  for (const prototype of ["null", "foreign", "inherited"] as const)
    it(`rejects ${prototype} record prototype`, () => {
      const p = actual(),
        row = p.files[1765]!;
      Object.setPrototypeOf(
        row,
        prototype === "null" ? null : prototype === "foreign" ? Date.prototype : { path: row.path },
      );
      expect(Object.getPrototypeOf(row)).not.toBe(Object.prototype);
      refused(p);
    });
  it("rejects foreign array prototype", () => {
    const p = actual();
    Object.setPrototypeOf(p.files, {});
    refused(p);
  });
  it("rejects sparse array", () => {
    const p = actual(),
      length = p.files.length;
    expect(Reflect.deleteProperty(p.files, "1765")).toBe(true);
    expect(p.files).toHaveLength(length);
    expect(Object.hasOwn(p.files, "1765")).toBe(false);
    refused(p);
  });
  it("rejects inherited array element", () => {
    const p = actual(),
      length = p.files.length,
      proto = Object.create(Array.prototype) as object;
    Object.defineProperty(proto, "1765", { value: p.files[1765] });
    expect(Reflect.deleteProperty(p.files, "1765")).toBe(true);
    expect(p.files).toHaveLength(length);
    Object.setPrototypeOf(p.files, proto);
    expect(Object.hasOwn(p.files, "1765")).toBe(false);
    expect("1765" in p.files).toBe(true);
    refused(p);
  });
  it("rejects array extra field", () => {
    const p = actual();
    Object.defineProperty(p.files, "extra", { value: true, enumerable: true });
    expect(Object.hasOwn(p.files, "extra")).toBe(true);
    refused(p);
  });
  it("rejects cycle", () => {
    const p = actual();
    p.cycle = p;
    expect(p.cycle).toBe(p);
    refused(p);
  });
  for (const [name, value] of [
    ["undefined", undefined],
    ["bigint", 1n],
    ["function", () => true],
    ["symbol", Symbol("value")],
    ["NaN", NaN],
    ["infinity", Infinity],
    ["negative infinity", -Infinity],
    ["negative zero", -0],
  ] as const) {
    it(`rejects non-JSON ${name}`, () => {
      const p = actual();
      p.invalid = value;
      expect(Object.is(p.invalid, value)).toBe(true);
      refused(p);
    });
  }
  it("rejects a literal extra __proto__ key without prototype pollution", () => {
    const p = actual();
    Object.defineProperty(p, "__proto__", { value: { polluted: true }, enumerable: true });
    expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
    refused(p);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
  for (const [name, value] of [
    ["null", null],
    ["string", "policy"],
    ["number", 1],
    ["boolean", true],
  ] as const)
    it(`rejects ${name} as complete policy`, () => refused(value));
  for (const field of [
    "schema",
    "kind",
    "provenance",
    "before",
    "current",
    "allowedEdgesSha256",
    "layerDeltas",
    "addedFiles",
    "activationAdditions",
    "census",
  ]) {
    it(`rejects fixed receipt replacement ${field}`, () => {
      const r = JSON.parse(receiptText) as Record<string, unknown>;
      r[field] = "altered";
      const text = JSON.stringify(r);
      expect(text).not.toBe(receiptText);
      expect(() => authenticateIrRuntimeProgramPolicyEvolution(text)).toThrow("receipt digest mismatch");
    });
  }
  for (const text of ["{", "null", "", receiptText + " ", receiptText.replace('"schema": 1', '"schema": 2')]) {
    it(`rejects malformed or noncanonical receipt ${sha(text).slice(0, 12)}`, () =>
      expect(() => authenticateIrRuntimeProgramPolicyEvolution(text)).toThrow("receipt digest mismatch"));
  }
  it("rejects receipt missing field and extra field", () => {
    const missing = JSON.parse(receiptText) as Record<string, unknown>;
    expect(Reflect.deleteProperty(missing, "census")).toBe(true);
    expect(Object.hasOwn(missing, "census")).toBe(false);
    const extra = JSON.parse(receiptText) as Record<string, unknown>;
    extra.permitHistoricalFallback = true;
    for (const r of [missing, extra])
      expect(() => authenticateIrRuntimeProgramPolicyEvolution(JSON.stringify(r))).toThrow("receipt digest mismatch");
  });
  it("repeated independently fresh controls remain accepted and detached", () => {
    const p = actual(),
      q = actual();
    expect(p).not.toBe(q);
    expect(p.files[0]).not.toBe(q.files[0]);
    const b = beforeIrRuntimeProgramPolicy(p),
      c = beforeIrRuntimeProgramPolicy(q);
    expect(b.files[0]).not.toBe(c.files[0]);
    authenticateIrValidationPolicy(b);
    authenticateIrValidationPolicy(c);
    expect(JSON.stringify(replay(b))).toBe(JSON.stringify(q));
  });
});
