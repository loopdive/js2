// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Twelve source-successor controls, separate from all semantic and historical cohorts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertIrAllocationRuleSharingReceiptStructure,
  assertIrAllocationRuleSharingSourceRoles,
  authenticateIrAllocationRuleSharingReceipt,
  inverseIrAllocationRuleSharingDraft,
  irAllocationRuleSharingAnchorPaths,
  irAllocationRuleSharingPaths,
  irAllocationRuleSharingReceiptPath,
  readBeforeIrAllocationRuleSharing,
  reconstructBeforeIrAllocationRuleSharing,
  reconstructIrAllocationRuleSharingDraft,
  replayIrAllocationRuleSharingDraft,
  type IrAllocationRuleSharingSuccessorReceipt,
} from "./helpers/ir-allocation-rule-sharing-successor.js";
import {
  authenticateIrAllocationProvenanceLookupReceipt,
  irAllocationProvenanceLookupBeforePaths,
  irAllocationProvenanceLookupCurrentPaths,
  irAllocationProvenanceLookupReceiptPath,
  reconstructBeforeIrAllocationProvenanceLookup,
  readBeforeIrAllocationProvenanceLookup,
} from "./helpers/ir-allocation-provenance-lookup-successor.js";
import {
  assertIrValidationAnalysisSource,
  authenticateIrValidationAnalysisRelocation,
  irValidationAnalysisCurrentPaths,
  irValidationAnalysisOriginalPaths,
  irValidationAnalysisReceiptPath,
  readIrValidationAnalysisActual,
  reconstructIrValidationAnalysisSources,
} from "./helpers/ir-validation-analysis-relocation.js";

const raw = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const [ownershipPath, escapePath, encodingPath, rulePath, censusPath] = irAllocationRuleSharingPaths;
const expectedBefore = [
  [ownershipPath, 23654, "9c622ef53c8c9c1ecbc1c0bc8eee907dfb00da82a5f16c89feecb0c6d918495f"],
  [escapePath, 10829, "72d036b3565c778b29425f9c853276d67d48b13e2dfff6d38d8d4afa327e4c53"],
  [encodingPath, 10358, "e1a4e863db13b51769904457502adcca368cf4a9d8bacf79659daaba34596c23"],
  [rulePath, 5949, "8b59082258a7422a6a7913e3af593aa98b0f2fa57b1cd3b7d9b84f799d7ca761"],
  [censusPath, 9853, "ed9b780817a6f2521b67b9b748ea9e4b6bb2328ea17539be574b7639b8c57e60"],
] as const;
const immutable = [
  [
    "tests/helpers/ir-validation-analysis-relocation.json",
    327660,
    "9a52664fbba6044d168f428f9398e5d2bff923cf7cac1adc6aae04827431e969",
  ],
  [
    "tests/helpers/ir-allocation-provenance-lookup-successor.json",
    11637,
    "4528c914b70535665feebbd0f93ed5d43ef0a5fbb9b4a752e056da84f89a2c7d",
  ],
  [
    "tests/helpers/ir-allocation-provenance-lookup-successor.ts",
    29831,
    "7f818067a0ecb8963f582e232f1692af9d3ca9283b9596f42e9ab8846f1f6443",
  ],
] as const;
type Mutable<T> = T extends readonly (infer E)[]
  ? Mutable<E>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
type Draft = Mutable<IrAllocationRuleSharingSuccessorReceipt>;
function pin(text: string) {
  return {
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
    gitBlob: createHash("sha1")
      .update(`blob ${Buffer.byteLength(text)}\0`)
      .update(text)
      .digest("hex"),
  };
}
function receipt() {
  return authenticateIrAllocationRuleSharingReceipt(raw(irAllocationRuleSharingReceiptPath));
}
function draft(): Draft {
  return JSON.parse(raw(irAllocationRuleSharingReceiptPath)) as Draft;
}
function current(): ReadonlyMap<string, string> {
  return new Map(irAllocationRuleSharingPaths.map((p) => [p, raw(p)]));
}
function positive() {
  const before = reconstructBeforeIrAllocationRuleSharing(raw);
  expect([...before.keys()]).toEqual(irAllocationRuleSharingPaths);
  for (const [path, bytes, sha256] of expectedBefore) {
    expect(Buffer.byteLength(before.get(path)!)).toBe(bytes);
    expect(pin(before.get(path)!).sha256).toBe(sha256);
  }
  return before;
}
function changed(path: string, text: string) {
  return (requested: string) => (requested === path ? text : raw(requested));
}
function replaceOnce(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0 || source.indexOf(from, start + 1) >= 0) throw Error(`mutation span missing or repeated: ${from}`);
  return source.slice(0, start) + to + source.slice(start + from.length);
}
function failure(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw Error("negative control did not fail");
}
function roleMutation(path: string, edit: (text: string) => string): void {
  const sources = current();
  expect(() => assertIrAllocationRuleSharingSourceRoles(sources)).not.toThrow();
  const original = sources.get(path)!,
    mutation = edit(original);
  expect(mutation).not.toBe(original);
  const altered = new Map(sources);
  altered.set(path, mutation);
  const error = failure(() => assertIrAllocationRuleSharingSourceRoles(altered));
  expect(error.message).toMatch(/^allocation rule sharing successor: (?:parsed role|unique role|syntax)/);
  expect(error.message).not.toMatch(/source pin|SHA256|Git blob|digest|receipt authentication/);
  expect(() => reconstructBeforeIrAllocationRuleSharing(changed(path, mutation))).toThrow();
}
function stageSources() {
  return new Map(irValidationAnalysisCurrentPaths.map((p) => [p, readIrValidationAnalysisActual(p)]));
}
function stageReader(sources: ReadonlyMap<string, string>, calls: string[] = []) {
  return (path: string) => {
    calls.push(path);
    if (path === irValidationAnalysisReceiptPath) return raw(path);
    const text = sources.get(path);
    if (text === undefined) throw Error(`historical stage has no ${path}`);
    return text;
  };
}
function composed(reader: (path: string) => string) {
  return (path: string) =>
    readBeforeIrAllocationProvenanceLookup(path, (requested) => readBeforeIrAllocationRuleSharing(requested, reader));
}
function oldPositive(reader?: (path: string) => string) {
  const old = authenticateIrValidationAnalysisRelocation(raw(irValidationAnalysisReceiptPath));
  const originals = reconstructIrValidationAnalysisSources(reader);
  expect([...originals.keys()]).toEqual(irValidationAnalysisOriginalPaths);
  expect(old.originals).toHaveLength(9);
  expect(old.current).toHaveLength(13);
  expect(old.transfers).toHaveLength(135);
  for (const record of old.originals)
    assertIrValidationAnalysisSource(originals.get(record.path)!, record, record.path);
  return originals;
}

// Test-side reciprocal assembly is independent of the helper's inverse/replay implementation.
// It consumes only authentic reconstructed predecessors and the recorded forward data, never an executable baseline.
function independentForward(r: IrAllocationRuleSharingSuccessorReceipt, before: ReadonlyMap<string, string>) {
  return new Map(
    r.current.map((record) => {
      const original = Buffer.from(before.get(record.path)!),
        chunks: Buffer[] = [];
      let cursor = 0;
      for (const step of r.forward.filter((s) => s.path === record.path)) {
        const piece = original.subarray(step.span.start, step.span.end).toString("utf8");
        expect(pin(piece)).toEqual({ bytes: step.span.bytes, sha256: step.span.sha256, gitBlob: step.span.gitBlob });
        expect(piece).toBe(step.expected.text);
        chunks.push(original.subarray(cursor, step.span.start), Buffer.from(step.replacement.text));
        cursor = step.span.end;
      }
      chunks.push(original.subarray(cursor));
      return [record.path, Buffer.concat(chunks).toString("utf8")];
    }),
  );
}

describe("issue-6920 AE28 allocation rule sharing preservation (twelve controls)", () => {
  it("AP01 complete five-source inverse and independent forward equality", () => {
    const before = positive(),
      r = receipt(),
      replayed = independentForward(r, before);
    expect([...replayed.keys()]).toEqual(irAllocationRuleSharingPaths);
    for (const record of r.current) {
      expect(replayed.get(record.path)).toBe(raw(record.path));
      expect(pin(replayed.get(record.path)!)).toEqual({
        bytes: record.bytes,
        sha256: record.sha256,
        gitBlob: record.gitBlob,
      });
    }
    const old = authenticateIrValidationAnalysisRelocation(raw(irValidationAnalysisReceiptPath));
    for (const path of irAllocationRuleSharingPaths.slice(0, 3)) {
      const previous = r.before.find((row) => row.path === path)!;
      const historical = old.current.find((row) => row.path === path)!;
      expect([previous.bytes, previous.sha256, previous.gitBlob]).toEqual([
        historical.bytes,
        historical.sha256,
        historical.gitBlob,
      ]);
    }
    expect([...reconstructIrAllocationRuleSharingDraft(r, current()).before]).toEqual([...before]);
  });
  it("AP02 actual AE28 J1 Phase B chain preserves original receipts and populations", () => {
    const before = positive();
    for (const [path, bytes, sha256] of immutable) {
      expect(Buffer.byteLength(raw(path))).toBe(bytes);
      expect(pin(raw(path)).sha256).toBe(sha256);
    }
    const j1 = authenticateIrAllocationProvenanceLookupReceipt(raw(irAllocationProvenanceLookupReceiptPath));
    expect(j1.current).toHaveLength(4);
    expect(j1.before).toHaveLength(3);
    expect([...reconstructBeforeIrAllocationProvenanceLookup(raw).keys()]).toEqual(
      irAllocationProvenanceLookupBeforePaths,
    );
    expect(irAllocationProvenanceLookupCurrentPaths).toHaveLength(4);
    for (const path of irAllocationRuleSharingPaths.slice(0, 3))
      expect(readIrValidationAnalysisActual(path)).toBe(before.get(path));
    oldPositive();
    expect(Object.isFrozen(receipt())).toBe(true);
    expect(Object.isFrozen(receipt().forward[0]!.replacement)).toBe(true);
  });
  it("AP03 every live source and historical receipt is mandatory", () => {
    positive();
    const dependencies = [
      irAllocationRuleSharingReceiptPath,
      ...irAllocationRuleSharingPaths,
      ...irAllocationRuleSharingAnchorPaths,
    ];
    expect(dependencies).toHaveLength(10);
    for (const path of dependencies) {
      expect(() =>
        reconstructBeforeIrAllocationRuleSharing((p) => {
          if (p === path) throw Error(`required path absent: ${path}`);
          return raw(p);
        }),
      ).toThrow(`required path absent: ${path}`);
      const other = path === ownershipPath ? raw(escapePath) : raw(ownershipPath);
      expect(other).not.toBe(raw(path));
      expect(() => reconstructBeforeIrAllocationRuleSharing(changed(path, other))).toThrow();
    }
    // The composed chain must also read the two J1 production owners outside the old thirteen-file census.
    for (const path of irAllocationProvenanceLookupCurrentPaths) {
      const missing = (p: string) => {
        if (p === path) throw Error(`J1 live source absent: ${path}`);
        return raw(p);
      };
      expect(() => reconstructIrValidationAnalysisSources(composed(missing))).toThrow(`J1 live source absent: ${path}`);
      const other = raw(ownershipPath);
      expect(() => reconstructIrValidationAnalysisSources(composed(changed(path, other)))).toThrow();
    }
    // Also require the complete old chain's thirteen current sources, including J1 owners.
    oldPositive();
    for (const path of irValidationAnalysisCurrentPaths) {
      expect(() =>
        reconstructIrValidationAnalysisSources((p) => {
          if (p === path) throw Error(`old required path absent: ${path}`);
          return readIrValidationAnalysisActual(p);
        }),
      ).toThrow(`old required path absent: ${path}`);
    }
  });
  it("AP04 warm success never hides fresh source drift", () => {
    for (const path of [...irAllocationRuleSharingPaths, ...irAllocationRuleSharingAnchorPaths]) {
      let mutation: string | undefined;
      const reader = (p: string) => (p === path && mutation !== undefined ? mutation : raw(p));
      const expected = reconstructBeforeIrAllocationRuleSharing(reader);
      mutation = raw(path) + "\n// fresh source drift\n";
      expect(() => reconstructBeforeIrAllocationRuleSharing(reader)).toThrow(/complete source pin/);
      mutation = undefined;
      expect([...reconstructBeforeIrAllocationRuleSharing(reader)]).toEqual([...expected]);
    }
  });
  it("AP05 ownership bindings placement and ordered events are independently checked", () => {
    positive();
    const mutations = [
      (s: string) => replaceOnce(s, "allocationEvidenceRule(instr)", "undefined"),
      (s: string) =>
        replaceOnce(s, "touch(state, value, allocOf, null, event.op)", "markEscaped(state, value, allocOf)"),
      (s: string) =>
        replaceOnce(s, "markEscaped(state, value, allocOf)", "touch(state, value, allocOf, null, event.op)"),
      (s: string) =>
        replaceOnce(
          s,
          "allocationEvidenceOperand(instr, event.operand)",
          'allocationEvidenceOperand(instr, "newValue")',
        ),
      (s: string) => {
        const without = replaceOnce(s, "      const rule = allocationEvidenceRule(instr);\n", "");
        return replaceOnce(
          without,
          "  if (instr.result !== null && aliasDerived.has(instr.result)",
          "  const rule = allocationEvidenceRule(instr);\n  if (instr.result !== null && aliasDerived.has(instr.result)",
        );
      },
      (s: string) =>
        replaceOnce(
          s,
          "  if (instr.result !== null && aliasDerived.has(instr.result)",
          '  const allocationEvidenceRule = () => ({ kind: "effects" });\n  if (instr.result !== null && aliasDerived.has(instr.result)',
        ),
    ];
    for (const mutate of mutations) roleMutation(ownershipPath, mutate);
  });
  it("AP06 escape child backstop and encoding traversal roles remain live", () => {
    positive();
    const mutations: readonly [string, (s: string) => string][] = [
      [escapePath, (s) => replaceOnce(s, "rule.directEscape.length !== 0", "rule.directEscape.length === 0")],
      [escapePath, (s) => replaceOnce(s, "        for (const sub of instr.else) visitInstr(sub);\n", "")],
      [escapePath, (s) => replaceOnce(s, "!ownership.isStackAllocatable(v)", "true")],
      [
        escapePath,
        (s) =>
          replaceOnce(
            s,
            "        const rule = allocationEvidenceRule(instr);",
            '        const rule = allocationEvidenceRule(instr);\n        allocationEvidenceOperand(instr, "vec");',
          ),
      ],
      [
        encodingPath,
        (s) =>
          replaceOnce(
            s,
            "forEachInstrDeep(instr, (nested) => classifyInstr(nested, enc, record))",
            "classifyInstr(instr, enc, record)",
          ),
      ],
      [encodingPath, (s) => replaceOnce(s, 'rule.kind === "effects"', 'rule.kind === "unsupported"')],
      [encodingPath, (s) => replaceOnce(s, "allocationEvidenceRule(instr)", "allocationEvidenceEffect(instr)")],
    ];
    for (const [path, mutate] of mutations) roleMutation(path, mutate);
  });
  it("AP07 descriptor census facets carrier and reuse guards cannot be erased", () => {
    positive();
    const mutations: readonly [string, (s: string) => string][] = [
      [rulePath, (s) => replaceOnce(s, 'Object.freeze({ kind: "unsupported" })', '({ kind: "unsupported" })')],
      [
        rulePath,
        (s) =>
          replaceOnce(
            s,
            'Object.freeze({ op: "write", operand: "vec" } as const)',
            'Object.freeze({ op: "escape", operand: "newValue" } as const)',
          ),
      ],
      [rulePath, (s) => replaceOnce(s, "return VECTOR_READ_RULE;", "return VECTOR_WRITE_RULE;")],
      [
        rulePath,
        (s) =>
          replaceOnce(
            s,
            'if (instr.kind !== "vec.new_fixed" && instr.alloc !== undefined) return "instruction-kind";\n',
            "",
          ),
      ],
      [
        rulePath,
        (s) =>
          replaceOnce(
            s,
            'const ownership: { value: IrValueId; op: OwnershipRuleEvent["op"] }[] = [];',
            'const ownership: { value: IrValueId; op: OwnershipRuleEvent["op"] }[] = rule.ownership;',
          ),
      ],
      [
        rulePath,
        (s) =>
          replaceOnce(
            s,
            'return { kind: "effects", ownership, directEscape: [], encoding: rule.encoding };',
            'return { kind: "effects", ownership: [], directEscape: [], encoding: rule.encoding };',
          ),
      ],
      [rulePath, (s) => replaceOnce(s, "ownership.push(", "ownership.unshift(")],
      [
        rulePath,
        (s) =>
          replaceOnce(
            s,
            "ownership.push({ value: allocationEvidenceOperand(instr, event.operand), op: event.op });",
            "({ value: allocationEvidenceOperand(instr, event.operand), op: event.op });",
          ),
      ],
      [rulePath, (s) => replaceOnce(s, "op: event.op", 'op: "read"')],
      [
        rulePath,
        (s) =>
          replaceOnce(s, "allocationEvidenceOperand(instr, event.operand)", 'allocationEvidenceOperand(instr, "vec")'),
      ],
      [
        rulePath,
        (s) =>
          replaceOnce(
            s,
            'if (rule.kind === "unsupported") return { kind: "unsupported" };',
            'if (rule.kind === "unsupported") return UNSUPPORTED_RULE;',
          ),
      ],
      [rulePath, (s) => replaceOnce(s, 'rule.kind === "unsupported"', 'rule.kind !== "unsupported"')],
      [
        rulePath,
        (s) =>
          replaceOnce(
            s,
            'return { kind: "effects", ownership, directEscape: [], encoding: rule.encoding };',
            'return { kind: "unsupported", ownership, directEscape: [], encoding: rule.encoding };',
          ),
      ],
      [rulePath, (s) => replaceOnce(s, "encoding: rule.encoding", 'encoding: "no-write"')],
      [
        rulePath,
        (s) =>
          replaceOnce(
            s,
            'return { kind: "effects", ownership, directEscape: [], encoding: rule.encoding };',
            'return { kind: "effects", ownership, directEscape: rule.directEscape, encoding: rule.encoding };',
          ),
      ],
      [
        censusPath,
        (s) =>
          replaceOnce(
            s,
            'rule.directEscape.length !== 0 || rule.encoding !== "no-write"',
            'rule.encoding !== "no-write"',
          ),
      ],
      [
        censusPath,
        (s) => replaceOnce(s, 'if (state.allocations.has(id)) return uncovered("allocation-site-reuse", at);\n', ""),
      ],
      [censusPath, (s) => replaceOnce(s, "allocationEvidenceOperand(at.instr, event.operand)", "event.value")],
    ];
    for (const [path, mutate] of mutations) roleMutation(path, mutate);
  });
  it("AP08 complete unchanged scaffold imports diagnostics and trailing bytes are authenticated", () => {
    positive();
    for (const path of irAllocationRuleSharingPaths) {
      const text = raw(path);
      for (const mutation of [
        text + "\n// altered trailing byte\n",
        "// changed leading scaffold\n" + text,
        text.slice(0, -1),
      ]) {
        expect(mutation).not.toBe(text);
        expect(() => reconstructBeforeIrAllocationRuleSharing(changed(path, mutation))).toThrow(/complete source pin/);
      }
    }
    const mutations: readonly [string, string, string][] = [
      [
        ownershipPath,
        'import { ALLOC_NAMESPACES } from "./alloc-registry.js";',
        'import { ALLOC_NAMESPACES } from "../alloc-registry.js";',
      ],
      [escapePath, "allocation rule mismatch: vector direct escape", "changed rule mismatch: vector direct escape"],
      [encodingPath, "allocation rule mismatch: encoding contribution", "changed rule mismatch: encoding contribution"],
      [
        censusPath,
        '    const root = state.roots.get(value);\n    if (!root) return uncovered("nonroot-receiver", at);',
        '    const root = state.roots.get(value);\n    if (!root) return uncovered("instruction-kind", at);',
      ],
    ];
    for (const [path, from, to] of mutations)
      expect(() => reconstructBeforeIrAllocationRuleSharing(changed(path, replaceOnce(raw(path), from, to)))).toThrow(
        /complete source pin/,
      );
  });
  it("AP09 closed receipt roles spans populations and trust authority reject repins", () => {
    positive();
    const mutations: readonly ((r: Draft) => void)[] = [
      (r) => {
        r.current.reverse();
      },
      (r) => {
        r.before[0]!.path = r.before[1]!.path;
      },
      (r) => {
        r.forward.pop();
      },
      (r) => {
        r.inverse[1]!.role = r.inverse[0]!.role;
      },
      (r) => {
        r.forward[1]!.span.start = -1;
      },
      (r) => {
        r.inverse[0]!.span.end = 0.5;
      },
      (r) => {
        r.forward[1]!.span.end = r.before[0]!.bytes + 1;
      },
      (r) => {
        r.forward[2]!.span.start = r.forward[1]!.span.start;
      },
      (r) => {
        r.forward[1]!.replacement.text += "changed";
      },
      (r) => {
        r.anchors[0]!.sha256 = "0".repeat(64);
      },
      (r) => {
        Reflect.set(r, "unreviewed", true);
      },
    ];
    for (const mutate of mutations) {
      const r = draft();
      mutate(r);
      expect(() => assertIrAllocationRuleSharingReceiptStructure(r)).toThrow();
      expect(() => authenticateIrAllocationRuleSharingReceipt(JSON.stringify(r))).toThrow(/fixed receipt digest/);
    }
    const repinned = draft(),
      text = replaceOnce(raw(ownershipPath), "Licensed under", "LicensEd under");
    Object.assign(repinned.current[0]!, pin(text));
    expect(() => assertIrAllocationRuleSharingReceiptStructure(repinned)).not.toThrow();
    expect(() => authenticateIrAllocationRuleSharingReceipt(JSON.stringify(repinned))).toThrow(/fixed receipt digest/);
    expect(() =>
      reconstructBeforeIrAllocationRuleSharing(changed(irAllocationRuleSharingReceiptPath, JSON.stringify(repinned))),
    ).toThrow(/fixed receipt digest/);
  });
  it("AP10 independent forward replay rejects a plausible wrong recipe", () => {
    const before = positive(),
      r = draft();
    const step = r.forward.find((s) => s.role === "static-rule-definitions")!;
    const wrong = replaceOnce(
      step.replacement.text,
      "Shared instruction-local policy.",
      "Mutant instruction-local policy.",
    );
    expect(Buffer.byteLength(wrong)).toBe(step.replacement.bytes);
    step.replacement = { text: wrong, ...pin(wrong) };
    expect(() => assertIrAllocationRuleSharingReceiptStructure(r)).not.toThrow();
    expect([...inverseIrAllocationRuleSharingDraft(r, current())]).toEqual([...before]);
    expect(() => replayIrAllocationRuleSharingDraft(r, before)).toThrow(
      /complete source pin replayed src\/ir\/analysis\/allocation-evidence\/effect-rules.ts/,
    );
    expect(() => reconstructIrAllocationRuleSharingDraft(r, current())).toThrow(/complete source pin replayed/);
    expect(() => authenticateIrAllocationRuleSharingReceipt(JSON.stringify(r))).toThrow(/fixed receipt digest/);
  });
  it("AP11 historical donor mutants remain historical and cannot authenticate live source", () => {
    const before = positive(),
      stage = stageSources();
    oldPositive(stageReader(stage));
    for (const path of irAllocationRuleSharingPaths.slice(0, 3)) {
      const text = stage.get(path)!,
        altered = new Map(stage),
        calls: string[] = [];
      const mutation = text + "\n// historical donor mutant\n";
      expect(mutation).not.toBe(text);
      altered.set(path, mutation);
      expect(() => reconstructIrValidationAnalysisSources(stageReader(altered, calls))).toThrow(
        /validation analysis relocation: complete SHA256\/length mismatch/,
      );
      expect(calls).not.toContain(irAllocationRuleSharingReceiptPath);
      expect(calls).not.toContain(irAllocationProvenanceLookupReceiptPath);
      expect(() => reconstructBeforeIrAllocationRuleSharing(changed(path, before.get(path)!))).toThrow(
        /complete source pin current/,
      );
    }
  });
  it("AP12 operation capture is fresh bounded and preserves passthrough", () => {
    positive();
    const calls: string[] = [],
      reader = (p: string) => {
        calls.push(p);
        return raw(p);
      };
    const expected = [
      irAllocationRuleSharingReceiptPath,
      ...irAllocationRuleSharingPaths,
      ...irAllocationRuleSharingAnchorPaths,
    ];
    reconstructBeforeIrAllocationRuleSharing(reader);
    expect(calls).toEqual(expected);
    reconstructBeforeIrAllocationRuleSharing(reader);
    expect(calls).toEqual([...expected, ...expected]);
    const passCalls: string[] = [],
      pass = (p: string) => {
        passCalls.push(p);
        return `raw:${p}`;
      };
    for (const path of ["unknown.ts", irAllocationRuleSharingReceiptPath, irAllocationRuleSharingAnchorPaths[0]!])
      expect(readBeforeIrAllocationRuleSharing(path, pass)).toBe(`raw:${path}`);
    expect(passCalls).toEqual([
      "unknown.ts",
      irAllocationRuleSharingReceiptPath,
      irAllocationRuleSharingAnchorPaths[0]!,
    ]);
    const stage = stageSources(),
      original = oldPositive(stageReader(stage));
    for (const fault of ["missing", "changed"] as const) {
      const broken = (p: string) => {
        if (p === rulePath) {
          if (fault === "missing") throw Error("actual shared rule absent");
          return raw(p) + "\n// drift\n";
        }
        return raw(p);
      };
      expect(() => reconstructBeforeIrAllocationRuleSharing(broken)).toThrow();
      expect(() => reconstructIrValidationAnalysisSources(composed(broken))).toThrow();
      expect([...reconstructIrValidationAnalysisSources(stageReader(stage))]).toEqual([...original]);
      expect([...positive()]).toEqual([...reconstructBeforeIrAllocationRuleSharing(raw)]);
    }
  });
});
