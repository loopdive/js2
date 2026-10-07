// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { beforeOptionalFieldModuleRecords } from "./helpers/ir-initial-graph-optional-fields-source.js";
import { captureSourceMapSchemaSourceEpoch } from "./helpers/ir-program-validator-relocation.js";
import {
  assertProgramInitialGraphPin,
  assertProgramInitialGraphRecipe,
  assertProgramInitialGraphSpan,
  authenticateProgramInitialGraphEvolution,
  createProgramInitialGraphReader,
  ProgramInitialGraphEvolutionError,
  programInitialGraphInputPaths,
  programInitialGraphPaths,
  programInitialGraphPin,
  programInitialGraphReceiptPath,
  readProgramInitialGraphActual,
  reconstructProgramInitialGraph,
  verifyProgramInitialGraphReciprocal,
  type ProgramInitialGraphReader,
  type ProgramInitialGraphReceipt,
} from "./helpers/ir-program-initial-graph-evolution.js";
import { programPreAReceiptPath, reconstructProgramPreA } from "./helpers/ir-program-pre-a-evolution.js";

import {
  runtimeProgramRelocationPairs,
  runtimeProgramRelocationPopulationPaths,
  runtimeProgramRelocationReceiptPath,
} from "./helpers/ir-runtime-program-relocation.js";
import { beforeCanonicalInstructionsSource, reconstructC1CurrentSources } from "./helpers/ir-c1-current-source.js";

afterEach(async () => {
  // Yield between synchronous source proofs so Vitest can process task-update RPCs.
  await setImmediate();
});

function beforeC1(readLive: (path: string) => string = actual, captureCalls?: string[]): (path: string) => string {
  const sources = reconstructC1CurrentSources((path) => {
    captureCalls?.push(path);
    return readLive(path);
  });
  const epoch = captureSourceMapSchemaSourceEpoch(readLive);
  const beforeDonorsAndInstructions = (path: string): string => {
    if (runtimeProgramRelocationPairs.some(([donor]) => donor === path)) {
      const source = sources.get(path as Parameters<typeof sources.get>[0]);
      if (source === undefined) throw new Error(`missing checked C1 output: ${path}`);
      return source;
    }
    const source = readLive(path);
    return path === "src/wasm/model/instructions.ts" ? beforeCanonicalInstructionsSource(source) : source;
  };
  const beforeSourceEpoch = (path: string): string => {
    const source = beforeDonorsAndInstructions(path);
    return [
      "src/ir/program/input-contracts.ts",
      "src/ir/program/prepared-contracts.ts",
      "src/ir/program/input.ts",
      "src/shared/contracts/ir-unit-inventory.ts",
    ].includes(path)
      ? epoch.before(path, source)
      : source;
  };
  return beforeOptionalFieldModuleRecords(beforeSourceEpoch);
}

function actual(path: string): string {
  const value = readProgramInitialGraphActual(path);
  if (typeof value !== "string") throw new Error(`missing actual control input: ${path}`);
  return value;
}
const receiptText = actual(programInitialGraphReceiptPath);
const receipt = authenticateProgramInitialGraphEvolution(receiptText);
const input = "src/ir/program/input.ts";
const handles = "src/wasm/physical/function-handles.ts";
const inputContract = "src/ir/program/input-contracts.ts";
const preparedContract = "src/ir/program/prepared-contracts.ts";
function historicalControlSource(path: string): string {
  if (![input, inputContract, preparedContract].includes(path))
    throw new Error("historical control source: expected one of three fixed source paths");
  return captureSourceMapSchemaSourceEpoch(actual).before(path, actual(path));
}
function changed(read: (path: string) => string, path: string, text: string | undefined): ProgramInitialGraphReader {
  return (requested) => (requested === path ? text : read(requested));
}
function replaceOnce(source: string, before: string, after: string): string {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + 1) !== -1 || before === after)
    throw new Error("control requires exactly one changed span");
  return source.slice(0, at) + after + source.slice(at + before.length);
}
function record(path: string) {
  const found = receipt.records.find((r) => r.path === path);
  if (!found) throw new Error(`missing control recipe: ${path}`);
  return found;
}
function editDeclaration(path: string, name: string, edit: (text: string) => string): string {
  const r = record(path),
    d = r.currentDeclarations.filter((d) => d.name === name);
  if (d.length !== 1) throw new Error("control requires one declaration");
  const source = Buffer.from(actual(path)),
    span = d[0]!,
    old = source.subarray(span.startByte, span.endByte).toString("utf8"),
    replacement = edit(old);
  if (replacement === old) throw new Error("control did not change declaration bytes");
  return Buffer.concat([
    source.subarray(0, span.startByte),
    Buffer.from(replacement),
    source.subarray(span.endByte),
  ]).toString("utf8");
}
function reorderDeclarations(path: string, firstName: string, secondName: string): string {
  const r = record(path),
    first = r.currentDeclarations.find((d) => d.name === firstName),
    second = r.currentDeclarations.find((d) => d.name === secondName);
  if (!first || !second || first.endByte > second.startByte) throw new Error("invalid ordered control declarations");
  const source = Buffer.from(actual(path));
  return Buffer.concat([
    source.subarray(0, first.startByte),
    source.subarray(second.startByte, second.endByte),
    source.subarray(first.endByte, second.startByte),
    source.subarray(first.startByte, first.endByte),
    source.subarray(second.endByte),
  ]).toString("utf8");
}
function positive(read: (path: string) => string): ReadonlyMap<string, string> {
  const output = reconstructProgramInitialGraph(read);
  expect([...output.keys()]).toEqual(programInitialGraphPaths);
  expect(output.size).toBe(4);
  return output;
}
function copiedReceipt(): ProgramInitialGraphReceipt {
  return JSON.parse(receiptText) as ProgramInitialGraphReceipt;
}
function rejectsWith(code: string, run: () => unknown): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ProgramInitialGraphEvolutionError);
  expect((error as ProgramInitialGraphEvolutionError).code).toBe(code);
}

const mutations: readonly [string, string, () => string][] = [
  [
    "retained kernel initializer",
    handles,
    () => editDeclaration(handles, "STABLE_FUNC_BASE", (s) => replaceOnce(s, "1 << 21", "1 << 20")),
  ],
  [
    "retained predicate body",
    handles,
    () =>
      editDeclaration(handles, "inLiveShiftRange", (s) =>
        replaceOnce(s, "idx < STABLE_FUNC_BASE", "idx <= STABLE_FUNC_BASE"),
      ),
  ],
  [
    "kernel documentation",
    handles,
    () => replaceOnce(actual(handles), "the two-regime function handle space", "the changed function handle space"),
  ],
  [
    "removed ordinal mint body",
    handles,
    () => editDeclaration(handles, "mintDefinedFunc", (s) => replaceOnce(s, "push(Number.NaN)", "push(0)")),
  ],
  [
    "removed commit body",
    handles,
    () =>
      editDeclaration(handles, "commitDefinedFuncOrdinal", (s) =>
        replaceOnce(s, "storage.functions.length", "storage.functions.length + 1"),
      ),
  ],
  [
    "removed append body",
    handles,
    () =>
      editDeclaration(handles, "appendDefinedFunc", (s) =>
        replaceOnce(s, "storage.functions.push(fn)", "storage.functions.unshift(fn)"),
      ),
  ],
  [
    "removed storage data type",
    handles,
    () =>
      editDeclaration(handles, "DefinedFunctionStorage", (s) =>
        replaceOnce(s, "functions: WasmFunction[]", "functions: readonly WasmFunction[]"),
      ),
  ],
  ["removed declaration deletion", handles, () => editDeclaration(handles, "mintDefinedFunc", () => "")],
  [
    "removed declaration duplication",
    handles,
    () => editDeclaration(handles, "appendDefinedFunc", (s) => `${s}\n${s}`),
  ],
  ["retained predicate deletion", handles, () => editDeclaration(handles, "inLiveShiftRange", () => "")],
  [
    "allocator declaration order",
    handles,
    () => reorderDeclarations(handles, "mintDefinedFunc", "commitDefinedFuncOrdinal"),
  ],
  [
    "allocator import order",
    handles,
    () => reorderDeclarations(handles, "../model/instructions.js", "../model/module-records.js"),
  ],
  [
    "allocator import target",
    handles,
    () => replaceOnce(actual(handles), '"../model/module-records.js"', '"../model/foreign-records.js"'),
  ],
  ["allocator import deletion", handles, () => editDeclaration(handles, "../model/module-records.js", () => "")],
  [
    "allocator import runtime promotion",
    handles,
    () => replaceOnce(actual(handles), "import type { WasmFunction }", "import { WasmFunction }"),
  ],
  [
    "callee live operand",
    input,
    () => replaceOnce(historicalControlSource(input), "  fields(\n    captured,", "  foreignFields(\n    captured,"),
  ],
  [
    "receiver live operand",
    input,
    () => replaceOnce(historicalControlSource(input), "  fields(\n    captured,", "  fields(\n    input,"),
  ],
  [
    "required field live operand",
    input,
    () =>
      replaceOnce(
        historicalControlSource(input),
        '["inventory", "ir", "derivedUnits", "startup", "callables", "globals", "allocations"]',
        '["inventory", "ir", "derivedUnits", "startup", "callables", "globals"]',
      ),
  ],
  [
    "later optional operand",
    input,
    () => replaceOnce(historicalControlSource(input), '["runtimeSupport"],', '["foreignSupport"],'),
  ],
  [
    "later validation body",
    input,
    () =>
      replaceOnce(
        historicalControlSource(input),
        "assertIrRuntimeSupport(captured, captured.runtimeSupport)",
        "assertIrRuntimeSupport(input, captured.runtimeSupport)",
      ),
  ],
  [
    "retained input body",
    input,
    () => replaceOnce(historicalControlSource(input), "assertGlobalStorage(captured)", "assertGlobalStorage(input)"),
  ],
  [
    "later validation deletion",
    input,
    () =>
      replaceOnce(
        historicalControlSource(input),
        "    assertIrRuntimeSupport(captured, captured.runtimeSupport);\n",
        "",
      ),
  ],
  [
    "input runtime-support import",
    input,
    () => replaceOnce(historicalControlSource(input), '"./runtime-support.js"', '"./foreign-support.js"'),
  ],
  [
    "input readonly member",
    inputContract,
    () => replaceOnce(historicalControlSource(inputContract), "readonly runtimeSupport?:", "runtimeSupport?:"),
  ],
  [
    "input optional member",
    inputContract,
    () => replaceOnce(historicalControlSource(inputContract), "runtimeSupport?:", "runtimeSupport:"),
  ],
  [
    "prepared readonly member",
    preparedContract,
    () => replaceOnce(historicalControlSource(preparedContract), "readonly runtimeSupport?:", "runtimeSupport?:"),
  ],
  [
    "prepared optional member",
    preparedContract,
    () => replaceOnce(historicalControlSource(preparedContract), "runtimeSupport?:", "runtimeSupport:"),
  ],
  [
    "retained contract member",
    inputContract,
    () => replaceOnce(historicalControlSource(inputContract), "readonly globals:", "globals:"),
  ],
  ["foreign appended executable", handles, () => `${actual(handles)}\nexport const foreign = true;\n`],
  ["shifted allocator coordinates", handles, () => `\n${actual(handles)}`],
];

describe("authenticated initial program graph evolution", () => {
  it("fixes four outputs and seventeen actual source inputs without adding graph modules", () => {
    const initialRead = beforeC1();
    expect(receipt.outputs.map((p) => p.path)).toEqual(programInitialGraphPaths);
    expect(receipt.inputs.map((p) => p.path)).toEqual(programInitialGraphInputPaths);
    expect(receipt.inputs).toHaveLength(17);
    expect(new Set(programInitialGraphInputPaths).size).toBe(17);
    expect(receipt.records.map((r) => r.changes.length)).toEqual([3, 2]);
    expect(receipt.records.map((r) => [r.currentDeclarations.length, r.originalDeclarations.length])).toEqual([
      [11, 10],
      [8, 2],
    ]);
    expect(receipt.records.flatMap((r) => r.operands.map((o) => o.slot))).toEqual([
      "callee",
      "receiver",
      "requiredFields",
    ]);
    expect(positive(initialRead).has("src/wasm/model/module-records.ts")).toBe(false);
    expect(positive(initialRead).has("src/ir/program/runtime-support.ts")).toBe(false);
  });

  it.each(receipt.outputs)("reconstructs the fixed full prior $path from current inputs", (output) => {
    const initialRead = beforeC1();
    const sources = positive(initialRead),
      original = sources.get(output.path)!;
    expect(programInitialGraphPin(original)).toEqual({
      bytes: output.bytes,
      sha256: output.sha256,
      gitBlob: output.gitBlob,
    });
    expect(original).not.toBe(initialRead(output.path));
    expect(original).not.toContain('"./runtime-support.js"');
    const r = receipt.records.find((r) => r.path === output.path);
    if (r)
      expect(() =>
        verifyProgramInitialGraphReciprocal(output.path, initialRead(output.path), original, initialRead),
      ).not.toThrow();
  });

  it("uses the existing complete pre-A owner rather than a second contract recipe", () => {
    const initialRead = beforeC1();
    const old = reconstructProgramPreA(initialRead),
      initial = positive(initialRead);
    for (const path of [inputContract, preparedContract]) expect(initial.get(path)).toBe(old.get(path));
    expect(receipt.preAReceipt.path).toBe(programPreAReceiptPath);
    expect(programInitialGraphPin(initialRead(programPreAReceiptPath))).toEqual({
      bytes: receipt.preAReceipt.bytes,
      sha256: receipt.preAReceipt.sha256,
      gitBlob: receipt.preAReceipt.gitBlob,
    });
  });

  it("keeps both original physical declarations and their bodies as exact live AST text", () => {
    const initialRead = beforeC1();
    const old = positive(initialRead).get(handles)!,
      current = initialRead(handles);
    const sf = ts.createSourceFile(handles, old, ts.ScriptTarget.Latest, true),
      live = ts.createSourceFile(handles, current, ts.ScriptTarget.Latest, true);
    expect(sf.statements).toHaveLength(2);
    expect(sf.statements.some(ts.isImportDeclaration)).toBe(false);
    expect(sf.statements.map((n) => n.getText(sf))).toEqual(live.statements.slice(2, 4).map((n) => n.getText(live)));
    expect(programInitialGraphPin(old)).toEqual({
      bytes: 2477,
      sha256: "daddc2fea3c4e2017c117b54863ec00a27341378f8acc796e54bfb751e5cdac0",
      gitBlob: "8b91e2391b574e75ee6db331ebaa5aaa9da5d436",
    });
  });

  it.each(receipt.inputs)("authenticates every full current $path after a genuine paired positive", (p) => {
    const initialRead = beforeC1();
    positive(initialRead);
    rejectsWith("pin", () => reconstructProgramInitialGraph(changed(initialRead, p.path, `${initialRead(p.path)}\n`)));
  });
  it.each(receipt.inputs)("requires the actual live $path rather than an empty or historical substitute", (p) => {
    const initialRead = beforeC1();
    positive(initialRead);
    rejectsWith("missing-source", () => reconstructProgramInitialGraph(changed(initialRead, p.path, undefined)));
    rejectsWith("pin", () => reconstructProgramInitialGraph(changed(initialRead, p.path, "")));
  });
  it.each(mutations)(
    "refuses %s even when projection would remove or rewrite the changed bytes",
    (_label, path, mutate) => {
      const initialRead = beforeC1();
      positive(initialRead);
      const bad = mutate();
      expect(bad).not.toBe(initialRead(path));
      rejectsWith("pin", () => reconstructProgramInitialGraph(changed(initialRead, path, bad)));
    },
  );
  it.each(receipt.outputs)("refuses prior and mutated prior $path as current-source operands", (p) => {
    const initialRead = beforeC1();
    const original = positive(initialRead).get(p.path)!;
    rejectsWith("pin", () => reconstructProgramInitialGraph(changed(initialRead, p.path, original)));
    rejectsWith("pin", () => reconstructProgramInitialGraph(changed(initialRead, p.path, `${original}\n`)));
  });
  it.each(receipt.records)("validates both complete reciprocal sides for $path", (r) => {
    const initialRead = beforeC1();
    const old = positive(initialRead).get(r.path)!,
      current = initialRead(r.path);
    expect(() => verifyProgramInitialGraphReciprocal(r.path, current, old, initialRead)).not.toThrow();
    rejectsWith("pin", () => verifyProgramInitialGraphReciprocal(r.path, `${current}\n`, old, initialRead));
    rejectsWith("pin", () => verifyProgramInitialGraphReciprocal(r.path, current, `${old}\n`, initialRead));
  });

  it("captures exactly seventeen sources and one nested receipt per fresh operation", () => {
    const c1Calls: string[] = [];
    const initialRead = beforeC1(actual, c1Calls);
    expect(c1Calls).toEqual([runtimeProgramRelocationReceiptPath, ...runtimeProgramRelocationPopulationPaths]);
    const calls: string[] = [],
      reader = (path: string) => {
        calls.push(path);
        return initialRead(path);
      };
    for (let i = 0; i < 2; i++) expect(reconstructProgramInitialGraph(reader).size).toBe(4);
    const one = [...programInitialGraphInputPaths, programPreAReceiptPath];
    expect(calls).toEqual([...one, ...one]);
    rejectsWith("pin", () =>
      reconstructProgramInitialGraph(changed(initialRead, handles, `${initialRead(handles)}\n`)),
    );
    positive(initialRead);
    expect(c1Calls).toEqual([runtimeProgramRelocationReceiptPath, ...runtimeProgramRelocationPopulationPaths]);
  });
  it("does not retain successful source authority after a caller changes its backing map", () => {
    const initialRead = beforeC1();
    const backing = new Map(programInitialGraphInputPaths.map((p) => [p, initialRead(p)]));
    backing.set(programPreAReceiptPath, initialRead(programPreAReceiptPath));
    const reader = (path: string) => backing.get(path);
    const initial = reconstructProgramInitialGraph(reader);
    expect(initial.size).toBe(4);
    backing.set(handles, `${initialRead(handles)}\n`);
    expect(initial.get(handles)).toBe(positive(initialRead).get(handles));
    rejectsWith("pin", () => reconstructProgramInitialGraph(reader));
  });
  it("keeps unowned reader paths raw, including appended back edges, and fails on missing paths", () => {
    const initialRead = beforeC1();
    const path = "src/wasm/model/instructions.ts",
      initial = createProgramInitialGraphReader(initialRead);
    expect(initial(path)).toBe(initialRead(path));
    const appended = `${initialRead(path)}\nexport type { Foreign } from "./foreign.js";\n`;
    let raw = initialRead(path);
    const reader = createProgramInitialGraphReader((p) => (p === path ? raw : initialRead(p)));
    raw = appended;
    expect(reader(path)).toBe(appended);
    expect(reader(handles)).toBe(positive(initialRead).get(handles));
    rejectsWith("missing-source", () => initial("src/absent-initial-graph-owner.ts"));
  });
  it("leaves copied fixture mutations raw after initial construction", () => {
    const initialRead = beforeC1();
    const initial = createProgramInitialGraphReader(initialRead),
      copied = new Map(programInitialGraphPaths.map((p) => [p, initial(p)]));
    const old = copied.get(handles)!,
      mutation = `${old}\nexport type { Foreign } from "../model/foreign.js";\n`;
    copied.set(handles, mutation);
    expect(copied.get(handles)).toBe(mutation);
    expect(copied.get(handles)).not.toBe(initial(handles));
    rejectsWith("pin", () => reconstructProgramInitialGraph(changed(initialRead, handles, copied.get(handles))));
  });
  it("preserves caller missing-read diagnostics as a typed fail-closed cause", () => {
    const initialRead = beforeC1();
    const missing = new Error("actual source missing"),
      reader: ProgramInitialGraphReader = (p) => {
        if (p === handles) throw missing;
        return initialRead(p);
      };
    positive(initialRead);
    try {
      reconstructProgramInitialGraph(reader);
      throw new Error("unexpected success");
    } catch (e) {
      expect(e).toBeInstanceOf(ProgramInitialGraphEvolutionError);
      expect((e as ProgramInitialGraphEvolutionError).code).toBe("missing-source");
      expect((e as Error).cause).toBe(missing);
    }
  });
  it.each(["missing", "changed"] as const)("requires the %s nested pre-A receipt", (kind) => {
    const initialRead = beforeC1();
    positive(initialRead);
    rejectsWith(kind === "missing" ? "missing-source" : "pin", () =>
      reconstructProgramInitialGraph(
        changed(
          initialRead,
          programPreAReceiptPath,
          kind === "missing" ? undefined : `${initialRead(programPreAReceiptPath)}\n`,
        ),
      ),
    );
  });
  it("refuses an unknown reciprocal record instead of using a name-shaped fallback", () => {
    const initialRead = beforeC1();
    positive(initialRead);
    rejectsWith("receipt", () =>
      verifyProgramInitialGraphReciprocal(
        "src/foreign.ts",
        initialRead(handles),
        positive(initialRead).get(handles)!,
        initialRead,
      ),
    );
  });

  it.each(receipt.inputs)("independently authenticates the Git blob for $path", (p) => {
    const initialRead = beforeC1();
    expect(() => assertProgramInitialGraphPin(initialRead(p.path), p, p.path)).not.toThrow();
    rejectsWith("pin", () =>
      assertProgramInitialGraphPin(initialRead(p.path), { ...p, gitBlob: "0".repeat(40) }, p.path),
    );
  });
  it.each(["negative start", "beyond source", "length mismatch", "partial UTF8", "span SHA", "span blob"] as const)(
    "rejects %s through the independent live-span guard",
    (kind) => {
      const r = record(handles),
        span = { ...r.changes[1]!.current },
        text = actual(handles);
      expect(() => assertProgramInitialGraphSpan(text, span, kind)).not.toThrow();
      if (kind === "negative start") {
        span.startByte = -1;
      }
      if (kind === "beyond source") {
        span.endByte++;
      }
      if (kind === "length mismatch") {
        span.bytes--;
      }
      if (kind === "span SHA") {
        span.sha256 = "0".repeat(64);
      }
      if (kind === "span blob") {
        span.gitBlob = "0".repeat(40);
      }
      if (kind === "partial UTF8") {
        const b = Buffer.from("π");
        rejectsWith("span", () =>
          assertProgramInitialGraphSpan(
            b,
            { startByte: 0, endByte: 1, ...programInitialGraphPin(b.subarray(0, 1)) },
            kind,
          ),
        );
        return;
      }
      rejectsWith(kind.startsWith("span ") ? "pin" : "span", () => assertProgramInitialGraphSpan(text, span, kind));
    },
  );

  const recipeMutations: readonly [string, (r: ProgramInitialGraphReceipt) => void, string][] = [
    [
      "schema",
      (r) => {
        (r as { schema: number }).schema++;
      },
      "receipt",
    ],
    [
      "provenance",
      (r) => {
        (r.provenance as { physicalCommit: string }).physicalCommit = "0".repeat(40);
      },
      "receipt",
    ],
    [
      "input order",
      (r) => {
        (r.inputs as unknown[]).reverse();
      },
      "receipt",
    ],
    [
      "missing input",
      (r) => {
        (r.inputs as unknown[]).pop();
      },
      "receipt",
    ],
    [
      "duplicate input",
      (r) => {
        (r.inputs as unknown[]).push(r.inputs[0]);
      },
      "receipt",
    ],
    [
      "unknown output",
      (r) => {
        (r.outputs[0] as { path: string }).path = "src/foreign.ts";
      },
      "receipt",
    ],
    [
      "current full pin",
      (r) => {
        (r.records[0]!.current as { sha256: string }).sha256 = "0".repeat(64);
      },
      "receipt",
    ],
    [
      "prior full pin",
      (r) => {
        (r.records[0]!.original as { gitBlob: string }).gitBlob = "0".repeat(40);
      },
      "receipt",
    ],
    [
      "declaration order",
      (r) => {
        (r.records[1]!.currentDeclarations as unknown[]).reverse();
      },
      "role",
    ],
    [
      "missing declaration",
      (r) => {
        (r.records[1]!.currentDeclarations as unknown[]).pop();
      },
      "receipt",
    ],
    [
      "operand kind",
      (r) => {
        (r.records[0]!.operands[0] as { kind: string }).kind = "StringLiteral";
      },
      "role",
    ],
    [
      "operand owner",
      (r) => {
        (r.records[0]!.operands[0] as { ownerName: string }).ownerName = "foreign";
      },
      "role",
    ],
    [
      "operand order",
      (r) => {
        (r.records[0]!.operands as unknown[]).reverse();
      },
      "role",
    ],
    [
      "change order",
      (r) => {
        (r.records[0]!.changes as unknown[]).reverse();
      },
      "receipt",
    ],
    [
      "unknown replacement",
      (r) => {
        (r.records[0]!.changes[0] as { replacement: string }).replacement = "saved-body";
      },
      "receipt",
    ],
    [
      "missing original anchor",
      (r) => {
        (r.records[1]!.changes[0] as { originalAnchor: unknown }).originalAnchor = null;
      },
      "span",
    ],
    [
      "shifted reciprocal coordinate",
      (r) => {
        (r.records[1]!.changes[0]!.original as { startByte: number }).startByte++;
      },
      "span",
    ],
  ];
  it.each(recipeMutations)(
    "independently refuses malformed %s recipe before fixed digest authority",
    (_label, mutate, code) => {
      const initialRead = beforeC1();
      const good = copiedReceipt();
      expect(() => assertProgramInitialGraphRecipe(good)).not.toThrow();
      const bad = copiedReceipt();
      mutate(bad);
      rejectsWith(code, () => assertProgramInitialGraphRecipe(bad));
      rejectsWith("receipt", () => reconstructProgramInitialGraph(initialRead, JSON.stringify(bad)));
    },
  );
  it.each([
    "",
    "{",
    `${receiptText}\n`,
    receiptText.replace("authenticated-live-program-initial-graph-evolution", "untrusted-old-body"),
  ])("rejects malformed receipt operand %#", (bad) => {
    const initialRead = beforeC1();
    positive(initialRead);
    rejectsWith("receipt", () => reconstructProgramInitialGraph(initialRead, bad));
  });
});
