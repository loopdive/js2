// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Sixteen successor preservation controls; separate from P01–P08 and AE01–AE40.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  authenticateIrAllocationProvenanceLookupReceipt,
  assertIrAllocationProvenanceLookupReceiptStructure,
  assertIrAllocationProvenanceLookupSourceRoles,
  irAllocationProvenanceLookupBeforePaths,
  irAllocationProvenanceLookupCurrentPaths,
  irAllocationProvenanceLookupReceiptPath,
  readBeforeIrAllocationProvenanceLookup,
  reconstructBeforeIrAllocationProvenanceLookup,
  reconstructIrAllocationProvenanceLookupDraft,
  replayIrAllocationProvenanceLookupDraft,
  type IrAllocationProvenanceLookupSuccessorReceipt,
} from "./helpers/ir-allocation-provenance-lookup-successor.js";
import {
  assertIrValidationAnalysisReceiptStructure,
  assertIrValidationAnalysisSource,
  authenticateIrValidationAnalysisRelocation,
  beforeIrValidationAnalysisRelocation,
  irValidationAnalysisCurrentPaths,
  irValidationAnalysisOriginalPaths,
  irValidationAnalysisReceiptPath,
  readIrValidationAnalysisActual,
  reconstructIrValidationAnalysisSources,
} from "./helpers/ir-validation-analysis-relocation.js";

const paths = {
  contract: "src/ir/analysis/contracts/allocations.ts",
  verifier: "src/ir/analysis/alloc-verification.ts",
  program: "src/ir/program/allocations.ts",
  helper: "src/ir/program/allocation-body-validation.ts",
};
const raw = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const OLD_SHA = "9a52664fbba6044d168f428f9398e5d2bff923cf7cac1adc6aae04827431e969";
const beforePins = [
  [paths.contract, 1508, "65a55b5e766280af62d728b8c54a6ead6f39e2c5c74d7eee6cb9c0aab697a813"],
  [paths.verifier, 6498, "93b78752e411016cc490655c0fc981ec3beaadc227682ae35c0599fcc5c6e2a4"],
  [paths.program, 6602, "e2da59c2bf90e2a833c35206d014e6745f79a94bade7f04c882cdb6495eb7e5f"],
] as const;
const currentPins = [
  [paths.contract, 1715, "8f72c7cf5563171d02522fc7b1581db8cb68d67574fa97d17098e3594565b9e4"],
  [paths.verifier, 6525, "5a0e389a0694ed087154974b17be8e3edbd14c9781f01a97acb18b0dc2260238"],
  [paths.program, 5638, "aec062632da95addb294e203514e8218284177bfccd7154f3cbb1d8bdd412c33"],
  [paths.helper, 1864, "d48bf8cec3edbdb89759df63dbb5a8e3f455b7d739b1e990d669a1eceb69430a"],
] as const;
type Mutable<T> = T extends readonly (infer E)[]
  ? Mutable<E>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
type Draft = Mutable<IrAllocationProvenanceLookupSuccessorReceipt>;
function receipt() {
  return authenticateIrAllocationProvenanceLookupReceipt(raw(irAllocationProvenanceLookupReceiptPath));
}
function draft(): Draft {
  return JSON.parse(raw(irAllocationProvenanceLookupReceiptPath)) as Draft;
}
function current(): ReadonlyMap<string, string> {
  return new Map(irAllocationProvenanceLookupCurrentPaths.map((path) => [path, raw(path)]));
}
function positive() {
  const before = reconstructBeforeIrAllocationProvenanceLookup(raw);
  expect([...before.keys()]).toEqual(irAllocationProvenanceLookupBeforePaths);
  for (const [path, bytes, sha] of beforePins) {
    expect(Buffer.byteLength(before.get(path)!)).toBe(bytes);
    expect(hash(before.get(path)!)).toBe(sha);
  }
  return before;
}
function changed(path: string, text: string) {
  return (requested: string) => (requested === path ? text : raw(requested));
}
function replaceOnce(source: string, from: string, to: string): string {
  const index = source.indexOf(from);
  if (index < 0 || source.indexOf(from, index + 1) >= 0) throw Error(`mutation span missing or repeated: ${from}`);
  return source.slice(0, index) + to + source.slice(index + from.length);
}
function bytes(source: string, start: number, end: number): string {
  return Buffer.from(source).subarray(start, end).toString("utf8");
}
function replaceBytes(source: string, start: number, end: number, text: string): string {
  const sourceBytes = Buffer.from(source);
  return Buffer.concat([sourceBytes.subarray(0, start), Buffer.from(text), sourceBytes.subarray(end)]).toString("utf8");
}
function rejectSource(path: string, edit: (text: string) => string) {
  positive();
  const original = raw(path),
    mutation = edit(original);
  expect(mutation).not.toBe(original);
  expect(() => reconstructBeforeIrAllocationProvenanceLookup(changed(path, mutation))).toThrow();
}
function rejectRole(path: string, edit: (text: string) => string) {
  positive();
  const source = current();
  expect(() => assertIrAllocationProvenanceLookupSourceRoles(source)).not.toThrow();
  const original = source.get(path)!,
    mutation = edit(original);
  expect(mutation).not.toBe(original);
  const altered = new Map(source);
  altered.set(path, mutation);
  let error: unknown;
  try {
    assertIrAllocationProvenanceLookupSourceRoles(altered);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw Error("role diagnostic did not reject actual mutation");
  // Syntax/binding diagnostics must be independently live, rather than another outer complete-file pin.
  expect(error.message).toMatch(/^allocation provenance successor:/);
  expect(error.message).not.toMatch(
    /SHA256|Git blob|source pin|pin shape|digest|receipt authentication|complete.*mismatch/,
  );
}
function initializer(path: string, text: string): string {
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const name =
    path === paths.helper ? "assertPreparedIrFunctionAllocationTypesAndStates" : "assertPreparedIrProgramAllocations";
  const fn = ast.statements.find(
    (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  const declarations = fn?.body?.statements
    .filter(ts.isVariableStatement)
    .flatMap((s) => [...s.declarationList.declarations])
    .filter((d) => ts.isIdentifier(d.name) && d.name.text === "invalid");
  if (declarations?.length !== 1 || !declarations[0]!.initializer)
    throw Error("one real local invalid initializer required");
  return declarations[0]!.initializer!.getText(ast);
}
function oldReceipt() {
  return authenticateIrValidationAnalysisRelocation(raw(irValidationAnalysisReceiptPath));
}
function oldStage(): ReadonlyMap<string, string> {
  return new Map(irValidationAnalysisCurrentPaths.map((path) => [path, readIrValidationAnalysisActual(path)]));
}
function stageReader(source: ReadonlyMap<string, string>, calls: string[] = []) {
  return (path: string) => {
    calls.push(path);
    if (path === irValidationAnalysisReceiptPath) return raw(path);
    const text = source.get(path);
    if (text === undefined) throw Error(`historical fixture has no owner ${path}`);
    return text;
  };
}
function oldPositive(reader?: (path: string) => string) {
  const value = oldReceipt(),
    originals = reconstructIrValidationAnalysisSources(reader);
  expect([...originals.keys()]).toEqual(irValidationAnalysisOriginalPaths);
  expect(value.originals).toHaveLength(9);
  expect(value.current).toHaveLength(13);
  expect(value.transfers).toHaveLength(135);
  for (const record of value.originals)
    assertIrValidationAnalysisSource(originals.get(record.path)!, record, record.path);
  return originals;
}

describe("issue-6920 allocation provenance successor preservation (sixteen controls)", () => {
  it("S01 complete four-source inverse and reciprocal", () => {
    const before = positive(),
      value = receipt(),
      actual = current();
    const reconstructed = reconstructIrAllocationProvenanceLookupDraft(value, actual);
    expect([...reconstructed.before]).toEqual([...before]);
    expect([...reconstructed.current.keys()]).toEqual(irAllocationProvenanceLookupCurrentPaths);
    expect(before.has(paths.helper)).toBe(false);
    expect(value.helper.absentBefore).toBe(true);
    const replay = replayIrAllocationProvenanceLookupDraft(value, before);
    for (const [path, count, sha] of currentPins) {
      expect(reconstructed.current.get(path)).toBe(actual.get(path));
      expect(replay.get(path)).toBe(actual.get(path));
      expect(Buffer.byteLength(replay.get(path)!)).toBe(count);
      expect(hash(replay.get(path)!)).toBe(sha);
    }
    expect(Buffer.byteLength(raw(irValidationAnalysisReceiptPath))).toBe(327660);
    expect(hash(raw(irValidationAnalysisReceiptPath))).toBe(OLD_SHA);
    for (const path of [paths.verifier, paths.program]) {
      const old = oldReceipt().current.find((row) => row.path === path)!;
      expect(hash(before.get(path)!)).toBe(old.sha256);
      expect(Buffer.byteLength(before.get(path)!)).toBe(old.bytes);
    }
  });
  it("S02 actual Phase B chain remains exact", () => {
    positive();
    const originals = oldPositive(),
      value = oldReceipt();
    expect(value.transfers.flatMap((transfer) => transfer.inlineImports)).toHaveLength(7);
    expect(() => assertIrValidationAnalysisReceiptStructure(value)).not.toThrow();
    // The real old helper performs its independent reciprocal replay; these are its independently pinned13 inputs.
    for (const record of value.current)
      assertIrValidationAnalysisSource(readIrValidationAnalysisActual(record.path), record, record.path);
    expect(originals.size).toBe(9);
  });
  it("S03 every live source is mandatory", () => {
    for (const missing of [...irAllocationProvenanceLookupCurrentPaths, irValidationAnalysisReceiptPath]) {
      positive();
      const calls: string[] = [];
      expect(() =>
        reconstructBeforeIrAllocationProvenanceLookup((path) => {
          calls.push(path);
          if (path === missing) throw Error(`missing owner: ${missing}`);
          return raw(path);
        }),
      ).toThrow(`missing owner: ${missing}`);
      expect(calls).toContain(missing);
    }
    positive();
    const wrong = "src/ir/program/unreviewed-allocation-body-validation.ts",
      calls: string[] = [];
    expect(() =>
      reconstructBeforeIrAllocationProvenanceLookup((path) => {
        if (path === paths.helper) {
          calls.push(wrong);
          return raw(wrong);
        }
        return raw(path);
      }),
    ).toThrow();
    expect(calls).toEqual([wrong]);
  });
  it("S04 warmed source drift is rejected", () => {
    for (const path of irAllocationProvenanceLookupCurrentPaths) {
      let mutation: string | undefined;
      const reader = (requested: string) => (requested === path && mutation !== undefined ? mutation : raw(requested));
      positive();
      expect([...reconstructBeforeIrAllocationProvenanceLookup(reader)]).toEqual([...positive()]);
      mutation = raw(path) + "\n// changed after a successful operation\n";
      expect(mutation).not.toBe(raw(path));
      expect(() => reconstructBeforeIrAllocationProvenanceLookup(reader)).toThrow();
      mutation = undefined;
      expect([...reconstructBeforeIrAllocationProvenanceLookup(reader)]).toEqual([...positive()]);
    }
  });
  it("S05 helper body and diagnostics are authenticated", () => {
    const edits: readonly [string, string][] = [
      ["lacks a typed entry block", "lost its typed entry block"],
      ["references stale site", "references unknown site"],
      ["contradicts body", "contradicts owner"],
      ["program allocations:", "different allocation prefix:"],
      ["new PreparedIrProgramInvariantError", "new Error"],
      ['"invalid-prepared-data"', '"abi-not-sealed"'],
      [
        "if (instruction.resultType && preparedIrTypeKey(site.type) !== preparedIrTypeKey(instruction.resultType))",
        "if (false)",
      ],
      [
        "assertFinalAllocProvenance({ ...fn, blocks: [{ ...block, instrs: state.body }] }, lookup);",
        "void state.body;",
      ],
    ];
    for (const [from, to] of edits) {
      positive();
      expect(initializer(paths.helper, raw(paths.helper))).toBe(initializer(paths.program, raw(paths.program)));
      rejectSource(paths.helper, (text) => replaceOnce(text, from, to));
    }
  });
  it("S06 call order and helper binding are fixed", () => {
    const call = "    assertPreparedIrFunctionAllocationTypesAndStates(fn, registry);\n",
      analyze = "    analyze(fn);\n";
    const variants: readonly [string, (text: string) => string][] = [
      [paths.program, (text) => replaceOnce(text, analyze + call, call + analyze)],
      [paths.program, (text) => replaceOnce(text, call, call + call)],
      [paths.program, (text) => replaceOnce(text, call, "")],
      [paths.program, (text) => replaceOnce(text, call, call.replace("(fn, registry)", "(registry, fn)"))],
      [
        paths.program,
        (text) => replaceOnce(text, 'from "./allocation-body-validation.js"', 'from "./unreviewed-body-validation.js"'),
      ],
      [
        paths.helper,
        (text) =>
          replaceOnce(
            text,
            "const site = lookup.resolve(instruction.alloc);",
            "const lookup = instruction;\n        const site = lookup.resolve(instruction.alloc);",
          ),
      ],
    ];
    for (const [path, edit] of variants) rejectRole(path, edit);
  });
  it("S07 four type-only parameter edits are bounded", () => {
    for (const edit of receipt().verifier.slice(1))
      rejectRole(paths.verifier, (text) => {
        expect(bytes(text, edit.current.start, edit.current.end)).toBe("AllocProvenanceLookup");
        return replaceBytes(text, edit.current.start, edit.current.end, "typeof AllocProvenanceLookup");
      });
    for (const edit of [
      (text: string) => replaceOnce(text, "readonly message: string;", "readonly message: AllocProvenanceLookup;"),
      (text: string) => text + "\nvoid AllocProvenanceLookup;\n",
      (text: string) => replaceOnce(text, "import type { AllocProvenanceLookup }", "import { AllocProvenanceLookup }"),
      (text: string) =>
        replaceOnce(
          text,
          "import type { AllocProvenanceLookup }",
          "import type { AllocProvenanceLookup as RenamedLookup }",
        ),
    ])
      rejectRole(paths.verifier, edit);
  });
  it("S08 exact interface declaration is covered", () => {
    const first = "  isKnown(id: AllocSiteId): boolean;\n",
      second = "  resolve(id: AllocSiteId): AllocSite | null;\n";
    const edits: readonly [string, string][] = [
      [first + second, second + first],
      [first, first.replace("boolean", "number")],
      [first, first.replace("isKnown(", "isKnown?(")],
      [second, second + "  extra(): void;\n"],
      [first, "  isKnown = true;\n"],
    ];
    for (const [from, to] of edits) rejectRole(paths.contract, (text) => replaceOnce(text, from, to));
    rejectRole(paths.contract, (text) => text + "\nvoid 0;\n");
  });
  it("S09 unchanged scaffold remains covered", () => {
    for (const path of irAllocationProvenanceLookupCurrentPaths) {
      rejectSource(path, (text) => replaceOnce(text, "Copyright (c) 2026", "Changed copyright 2026"));
      rejectSource(path, (text) => "\n" + text);
      rejectSource(path, (text) => text + "\nimport type { NeverReviewed } from './unreviewed.js';\n");
      rejectSource(path, (text) => text + "\nvoid 0;\n");
    }
  });
  it("S10 role proof rejects spelling-only equivalence", () => {
    const state = "assertFinalAllocProvenance({ ...fn, blocks: [{ ...block, instrs: state.body }] }, lookup);";
    for (const [path, edit] of [
      [paths.helper, (text: string) => replaceOnce(text, state, state.replace(", lookup)", ", state.lookup)"))],
      [paths.helper, (text: string) => replaceOnce(text, state, state.replace(", lookup)", ', "lookup")'))],
      [
        paths.helper,
        (text: string) =>
          replaceOnce(text, "lookup.resolve(instruction.alloc)", "instruction.lookup.resolve(instruction.alloc)"),
      ],
      [
        paths.helper,
        (text: string) =>
          replaceOnce(
            text,
            "lookup.resolve(instruction.alloc)",
            "((lookup) => lookup.resolve(instruction.alloc))(instruction)",
          ),
      ],
      [
        paths.verifier,
        (text: string) =>
          replaceOnce(
            text,
            "export function verifyAllocProvenance(func: IrFunction, registry: AllocProvenanceLookup)",
            "export function verifyAllocProvenance(registry: AllocProvenanceLookup, func: IrFunction)",
          ),
      ],
      [
        paths.helper,
        (text: string) => text + "\nexport function assertPreparedIrFunctionAllocationTypesAndStates(): void {}\n",
      ],
    ] as const)
      rejectRole(path, edit);
  });
  it("S11 receipt authentication cannot be repinned by caller", () => {
    const text = raw(irAllocationProvenanceLookupReceiptPath),
      value = receipt();
    positive();
    const altered = text + " ";
    expect(altered).not.toBe(text);
    expect(JSON.parse(altered)).toEqual(value);
    expect(() => authenticateIrAllocationProvenanceLookupReceipt(altered)).toThrow(/digest/);
    expect(() =>
      reconstructBeforeIrAllocationProvenanceLookup(changed(irAllocationProvenanceLookupReceiptPath, altered)),
    ).toThrow(/digest/);
    const equivalent = JSON.stringify(value);
    expect(equivalent).not.toBe(text);
    expect(JSON.parse(equivalent)).toEqual(value);
    expect(() => assertIrAllocationProvenanceLookupReceiptStructure(draft())).not.toThrow();
    expect(() => authenticateIrAllocationProvenanceLookupReceipt(equivalent)).toThrow(/digest/);
  });
  it("S12 transfer metadata is closed", () => {
    const edits: readonly ((value: Draft) => void)[] = [
      (r) => {
        r.before.pop();
      },
      (r) => {
        r.current.push(r.current[0]!);
      },
      (r) => {
        r.current.reverse();
      },
      (r) => {
        r.verifier[1]!.current.start++;
      },
      (r) => {
        r.verifier[1]!.current.end--;
      },
      (r) => {
        r.transfer.renames.pop();
      },
      (r) => {
        r.transfer.renames.push(r.transfer.renames[0]!);
      },
      (r) => {
        r.transfer.renames.reverse();
      },
      (r) => {
        Reflect.deleteProperty(r, "contract");
      },
      (r) => {
        Object.assign(r.contract, { extraDeclaration: "type Unreviewed = string;" });
      },
      (r) => {
        Object.assign(r, { executableLiteral: "void 0;" });
      },
      (r) => {
        Object.assign(r.helper, { extraOwner: paths.program });
      },
    ];
    for (const edit of edits) {
      positive();
      const value = receipt();
      expect(() => assertIrAllocationProvenanceLookupReceiptStructure(value)).not.toThrow();
      const altered = draft();
      edit(altered);
      expect(JSON.stringify(altered)).not.toBe(JSON.stringify(value));
      expect(() => assertIrAllocationProvenanceLookupReceiptStructure(altered)).toThrow();
    }
  });
  it("S13 independent reciprocal catches wrong forward recipe", () => {
    const before = positive(),
      wrongScaffold = draft();
    wrongScaffold.helper.prefix = replaceOnce(wrongScaffold.helper.prefix, "Copyright", "Copywrong");
    // This same-length comment change passes structure and roles but cannot reproduce the pinned live helper.
    expect(() => assertIrAllocationProvenanceLookupReceiptStructure(wrongScaffold)).not.toThrow();
    expect(() => replayIrAllocationProvenanceLookupDraft(wrongScaffold, before)).toThrow(
      /source pin replayed src\/ir\/program\/allocation-body-validation\.ts/,
    );
    const edits: readonly ((value: Draft) => void)[] = [
      (r) => {
        r.helper.prefix += "void 0;\n";
      },
      (r) => {
        r.programImports[2]!.currentText = r.programImports[2]!.currentText.replace(
          "./allocation-body-validation.js",
          "./unreviewed.js",
        );
      },
      (r) => {
        r.transfer.renames[0]!.current.start++;
      },
      (r) => {
        r.forward.reverse();
      },
    ];
    for (const edit of edits) {
      const before = positive(),
        value = receipt(),
        live = current();
      const replay = replayIrAllocationProvenanceLookupDraft(value, before);
      expect([...replay]).toEqual([...live]);
      const altered = draft();
      edit(altered);
      expect(JSON.stringify(altered)).not.toBe(JSON.stringify(value));
      expect(() => replayIrAllocationProvenanceLookupDraft(altered, before)).toThrow();
    }
  });
  it("S14 old-stage mutants remain old-stage", () => {
    positive();
    oldPositive();
    const stage = oldStage(),
      value = oldReceipt(),
      path = "src/ir/runtime/verify.ts";
    const declaration = value.current
      .find((row) => row.path === path)!
      .declarations.filter((d) => d.name === "verifyIrFunction");
    expect(declaration).toHaveLength(1);
    const span = declaration[0]!,
      text = stage.get(path)!,
      original = bytes(text, span.startByte, span.endByte);
    const mutation = replaceOnce(
      original,
      "const defs = new Set<IrValueId>();",
      "const defs = new Set<IrValueId>([0 as IrValueId]);",
    );
    expect(mutation).not.toBe(original);
    const changedStage = new Map(stage);
    changedStage.set(path, replaceBytes(text, span.startByte, span.endByte, mutation));
    const calls: string[] = [];
    expect(() => reconstructIrValidationAnalysisSources(stageReader(changedStage, calls))).toThrow(
      /validation analysis relocation:.*SHA256\/length mismatch/,
    );
    expect(calls).not.toContain(irAllocationProvenanceLookupReceiptPath);
    expect(calls).not.toContain(paths.helper);
  });
  it("S15 operation capture is fresh and bounded", () => {
    positive();
    const calls: string[] = [],
      reader = (path: string) => {
        calls.push(path);
        return raw(path);
      };
    const expected = [
      irAllocationProvenanceLookupReceiptPath,
      ...irAllocationProvenanceLookupCurrentPaths,
      irValidationAnalysisReceiptPath,
    ];
    reconstructBeforeIrAllocationProvenanceLookup(reader);
    expect(calls).toEqual(expected);
    reconstructBeforeIrAllocationProvenanceLookup(reader);
    expect(calls).toEqual([...expected, ...expected]);
    const passthroughCalls: string[] = [],
      passthrough = (path: string) => {
        passthroughCalls.push(path);
        return `raw:${path}`;
      };
    expect(readBeforeIrAllocationProvenanceLookup("unknown.ts", passthrough)).toBe("raw:unknown.ts");
    expect(readBeforeIrAllocationProvenanceLookup(paths.helper, passthrough)).toBe(`raw:${paths.helper}`);
    expect(passthroughCalls).toEqual(["unknown.ts", paths.helper]);
  });
  it("S16 supplied historical input is never live proof", () => {
    positive();
    const stage = oldStage(),
      calls: string[] = [];
    oldPositive(stageReader(stage, calls));
    expect(calls).toEqual([irValidationAnalysisReceiptPath, ...irValidationAnalysisCurrentPaths]);
    const originals = oldPositive(),
      historical = originals.get("src/ir/verify.ts")!;
    expect(() => beforeIrValidationAnalysisRelocation("src/ir/verify.ts", historical)).toThrow(
      /SHA256\/length mismatch/,
    );
    for (const fault of ["missing", "changed"] as const) {
      positive();
      const brokenLive = (path: string) => {
        if (path === paths.helper) {
          if (fault === "missing") throw Error("current helper absent");
          return raw(path) + "\nvoid 0;\n";
        }
        return raw(path);
      };
      expect(() => reconstructBeforeIrAllocationProvenanceLookup(brokenLive)).toThrow();
      expect([...reconstructIrValidationAnalysisSources(stageReader(stage))]).toEqual([...originals]);
    }
  });
});
