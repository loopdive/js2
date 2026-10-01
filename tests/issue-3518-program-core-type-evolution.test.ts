// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  assertProgramCoreTypePin,
  assertProgramCoreTypeRecipe,
  assertProgramCoreTypeRoles,
  assertProgramCoreTypeSpan,
  authenticateProgramCoreTypeEvolution,
  ProgramCoreTypeEvolutionError,
  programCoreTypeInputPaths,
  programCoreTypePath,
  programCoreTypePin,
  programCoreTypeReceiptPath,
  readBeforeProgramCoreTypeEvolution,
  readProgramCoreTypeActual,
  reconstructProgramCoreTypeEvolution,
  verifyProgramCoreTypeReciprocal,
  type ProgramCoreTypeReader,
  type ProgramCoreTypeReceipt,
} from "./helpers/ir-program-core-type-evolution.js";

function actual(path: string): string {
  const text = readProgramCoreTypeActual(path);
  if (typeof text !== "string") throw new Error(`missing healthy input: ${path}`);
  return text;
}
const receiptText = actual(programCoreTypeReceiptPath);
const receipt = authenticateProgramCoreTypeEvolution(receiptText);
const current = actual(programCoreTypePath);
function copy(): ProgramCoreTypeReceipt {
  return JSON.parse(receiptText) as ProgramCoreTypeReceipt;
}
function changed(path: string, text: string | undefined): ProgramCoreTypeReader {
  return (requested) => (requested === path ? text : actual(requested));
}
function replaceOnce(text: string, before: string, after: string): string {
  const at = text.indexOf(before);
  if (at < 0 || text.indexOf(before, at + 1) !== -1 || before === after)
    throw new Error("control requires one changed operand");
  return text.slice(0, at) + after + text.slice(at + before.length);
}
function editRole(index: number, edit: (text: string) => string): string {
  const span = receipt.changes[index]!.current,
    bytes = Buffer.from(current);
  const old = bytes.subarray(span.startByte, span.endByte).toString("utf8"),
    next = edit(old);
  if (next === old) throw new Error("role mutant did not change bytes");
  return Buffer.concat([bytes.subarray(0, span.startByte), Buffer.from(next), bytes.subarray(span.endByte)]).toString(
    "utf8",
  );
}
function rejects(code: string, run: () => unknown): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ProgramCoreTypeEvolutionError);
  expect((error as ProgramCoreTypeEvolutionError).code).toBe(code);
}
function positive(): string {
  const output = reconstructProgramCoreTypeEvolution();
  expect([...output.keys()]).toEqual([programCoreTypePath]);
  expect(output.size).toBe(1);
  const original = output.get(programCoreTypePath)!;
  expect(programCoreTypePin(original)).toEqual({
    bytes: receipt.output.bytes,
    sha256: receipt.output.sha256,
    gitBlob: receipt.output.gitBlob,
  });
  return original;
}

const sourceMutants: readonly [string, () => string][] = [
  [
    "runtime import module",
    () => editRole(0, (s) => replaceOnce(s, "binding-key-primitives", "foreign-key-primitives")),
  ],
  ["runtime import type form", () => editRole(0, (s) => replaceOnce(s, "import {", "import type {"))],
  ["runtime import operand", () => editRole(0, (s) => replaceOnce(s, "requireBindingId", "requireNonEmpty"))],
  ["interface deletion", () => editRole(1, () => "")],
  ["interface duplication", () => editRole(1, (s) => s + s)],
  ["interface readonly contract", () => editRole(1, (s) => replaceOnce(s, "readonly nullable", "nullable"))],
  [
    "attached interface documentation",
    () =>
      editRole(1, (s) =>
        replaceOnce(s, "physical ownership is resolved later", "physical ownership is guessed earlier"),
      ),
  ],
  ["factory deletion", () => editRole(2, () => "")],
  ["factory duplication", () => editRole(2, (s) => s + s)],
  [
    "interface/factory reordering",
    () => {
      const first = receipt.changes[1]!.current,
        second = receipt.changes[2]!.current,
        bytes = Buffer.from(current);
      return Buffer.concat([
        bytes.subarray(0, first.startByte),
        bytes.subarray(second.startByte, second.endByte),
        bytes.subarray(first.startByte, first.endByte),
        bytes.subarray(second.endByte),
      ]).toString("utf8");
    },
  ],
  [
    "factory reference validation",
    () => editRole(2, (s) => replaceOnce(s, 'ref.binding?.kind !== "support"', 'ref.binding?.kind !== "runtime"')),
  ],
  [
    "factory binding validation",
    () => editRole(2, (s) => replaceOnce(s, '"support-ref bindingId", "type"', '"support-ref bindingId", "global"')),
  ],
  [
    "factory nullability validation",
    () => editRole(2, (s) => replaceOnce(s, 'typeof nullable !== "boolean"', 'typeof nullable === "boolean"')),
  ],
  [
    "factory return",
    () => editRole(2, (s) => replaceOnce(s, 'return { kind: "support-ref"', 'return { kind: "foreign-ref"')),
  ],
  ["union member", () => editRole(3, (s) => replaceOnce(s, "IrSupportRefType", "IrTypeRef"))],
  [
    "equality condition",
    () => editRole(4, (s) => replaceOnce(s, 'a.kind === "support-ref"', 'a.kind !== "support-ref"')),
  ],
  ["equality body", () => editRole(4, (s) => replaceOnce(s, "a.nullable === b.nullable", "a.nullable !== b.nullable"))],
  [
    "retained equality body",
    () => replaceOnce(current, "return tagRefinementEquals(a.tag, b.tag)", "return tagRefinementEquals(b.tag, a.tag)"),
  ],
  [
    "retained ABI documentation",
    () =>
      replaceOnce(
        current,
        "Field indices are part of the compiler/runtime vector ABI",
        "Field indices are absent from the compiler/runtime vector ABI",
      ),
  ],
  [
    "retained ABI type",
    () => replaceOnce(current, "readonly dataFieldIndex: number", "readonly dataFieldIndex: string"),
  ],
  ["extra executable declaration", () => current + "\nexport const foreignExecutable = 1;\n"],
];

describe("authenticated initial program core-type evolution", () => {
  it("preserves the exact one-output, seven-input source population and complete two-way bytes", () => {
    const seen: string[] = [];
    const original = reconstructProgramCoreTypeEvolution((path) => {
      seen.push(path);
      return actual(path);
    }).get(programCoreTypePath)!;
    expect(seen).toEqual(programCoreTypeInputPaths);
    expect(receipt.changes).toHaveLength(5);
    expect(receipt.changes.map((c) => c.current.bytes).reduce((a, b) => a + b, 0)).toBe(1018);
    expect(receipt.changes[1]!.originalOffset).toBe(1783);
    expect(receipt.changes[2]!.originalOffset).toBe(1783);
    expect(receipt.currentDeclarations).toHaveLength(32);
    expect(receipt.originalDeclarations).toHaveLength(29);
    assertProgramCoreTypeRoles(current, receipt, "current");
    assertProgramCoreTypeRoles(original, receipt, "original");
    verifyProgramCoreTypeReciprocal(current, original);
    const parsed = ts.createSourceFile(programCoreTypePath, original, ts.ScriptTarget.Latest, true);
    expect(parsed.statements.filter(ts.isImportDeclaration)).toHaveLength(5);
    expect(original).toContain("export interface IrVecLayoutRef");
    expect(original).not.toContain("export function irSupportRef");
    expect(original).not.toContain("IrSupportRefType");
    expect(actual(programCoreTypePath)).toBe(current);
  });
  it.each(sourceMutants)("rejects changed %s before historical projection", (_label, mutation) => {
    positive();
    const mutant = mutation();
    expect(mutant).not.toBe(current);
    rejects("pin", () => reconstructProgramCoreTypeEvolution(changed(programCoreTypePath, mutant)));
  });
  it.each(programCoreTypeInputPaths)("requires actual input %s", (path) => {
    positive();
    rejects("missing-source", () => reconstructProgramCoreTypeEvolution(changed(path, undefined)));
  });
  it.each(programCoreTypeInputPaths.slice(1))("authenticates complete dependency %s", (path) => {
    positive();
    const raw = actual(path),
      mutant = raw + "\n// changed dependency\n";
    expect(mutant).not.toBe(raw);
    rejects("pin", () => reconstructProgramCoreTypeEvolution(changed(path, mutant)));
  });
  it("rejects a throwing input reader as unavailable", () => {
    positive();
    rejects("missing-source", () =>
      reconstructProgramCoreTypeEvolution((path) => {
        if (path === programCoreTypePath) throw new Error("unavailable");
        return actual(path);
      }),
    );
  });
  it("does not reuse successful source or dependency authentication", () => {
    for (const path of [programCoreTypePath, programCoreTypeInputPaths[6]!]) {
      let altered = false;
      const reader: ProgramCoreTypeReader = (requested) =>
        requested === path && altered ? actual(requested) + "\n// stale authentication\n" : actual(requested);
      expect(reconstructProgramCoreTypeEvolution(reader).get(programCoreTypePath)).toBe(positive());
      altered = true;
      rejects("pin", () => reconstructProgramCoreTypeEvolution(reader));
    }
  });
  it("reads mapped paths afresh and keeps unknown paths raw", () => {
    const original = positive();
    expect(readBeforeProgramCoreTypeEvolution(programCoreTypePath)).toBe(original);
    const rawPath = programCoreTypeInputPaths[6]!,
      raw = actual(rawPath) + "\n// raw unknown-path mutant\n";
    expect(readBeforeProgramCoreTypeEvolution(rawPath, changed(rawPath, raw))).toBe(raw);
    rejects("missing-source", () => readBeforeProgramCoreTypeEvolution("missing.ts", () => undefined));
    rejects("pin", () =>
      readBeforeProgramCoreTypeEvolution(programCoreTypePath, changed(programCoreTypePath, original)),
    );
  });
  it("returned map mutations cannot become a successful current input or cached output", () => {
    const output = reconstructProgramCoreTypeEvolution() as Map<string, string>,
      original = output.get(programCoreTypePath)!;
    output.set(programCoreTypePath, original + "\n// injected later\n");
    expect(positive()).toBe(original);
    rejects("pin", () =>
      reconstructProgramCoreTypeEvolution(changed(programCoreTypePath, output.get(programCoreTypePath))),
    );
    rejects("pin", () => verifyProgramCoreTypeReciprocal(current, output.get(programCoreTypePath)!));
  });
  it("rejects swapped same-offset replay contents and historical body mutants", () => {
    const original = positive(),
      bytes = Buffer.from(original),
      live = Buffer.from(current);
    const replay = (reverse: boolean): string => {
      const parts: Buffer[] = [];
      let cursor = 0;
      for (const [index, change] of receipt.changes.entries()) {
        const span = receipt.changes[reverse && index === 1 ? 2 : reverse && index === 2 ? 1 : index]!.current;
        parts.push(bytes.subarray(cursor, change.originalOffset), live.subarray(span.startByte, span.endByte));
        cursor = change.originalOffset;
      }
      parts.push(bytes.subarray(cursor));
      return Buffer.concat(parts).toString("utf8");
    };
    expect(replay(false)).toBe(current);
    const reversed = replay(true);
    expect(Buffer.byteLength(reversed)).toBe(Buffer.byteLength(current));
    expect(reversed).not.toBe(current);
    rejects("pin", () => verifyProgramCoreTypeReciprocal(reversed, original));
    const mutant = replaceOnce(
      original,
      "return tagRefinementEquals(a.tag, b.tag)",
      "return tagRefinementEquals(b.tag, a.tag)",
    );
    expect(mutant).not.toBe(original);
    rejects("pin", () => verifyProgramCoreTypeReciprocal(current, mutant));
  });
});

describe("core-type recipe and AST diagnostic controls cannot authorize reconstruction", () => {
  it.each(["bytes", "sha256", "gitBlob"] as const)("checks the complete %s pin independently", (field) => {
    positive();
    const pin = {
      ...programCoreTypePin(current),
      [field]: field === "bytes" ? current.length - 1 : "0".repeat(field === "sha256" ? 64 : 40),
    };
    assertProgramCoreTypePin(current, programCoreTypePin(current), "healthy");
    rejects("pin", () => assertProgramCoreTypePin(current, pin, "mutant"));
  });
  it("rejects altered fixed receipts even when structural diagnostics accept them", () => {
    positive();
    const mutated = copy();
    (mutated.inputs[0] as { sha256: string }).sha256 = "0".repeat(64);
    assertProgramCoreTypeRecipe(mutated);
    rejects("receipt", () => reconstructProgramCoreTypeEvolution(readProgramCoreTypeActual, JSON.stringify(mutated)));
    rejects("receipt", () => authenticateProgramCoreTypeEvolution(receiptText + " "));
  });
  it("rejects altered source provenance", () => {
    assertProgramCoreTypeRecipe(receipt);
    const mutant = copy();
    (mutant.provenance as { fixtureRevision: string }).fixtureRevision = "0".repeat(40);
    rejects("receipt", () => assertProgramCoreTypeRecipe(mutant));
  });
  it("rejects shifted and overlapping spans and reversed same-offset roles", () => {
    assertProgramCoreTypeRecipe(receipt);
    for (const mode of ["shift", "overlap", "reverse"] as const) {
      const mutant = copy(),
        changes = mutant.changes as unknown as {
          role: string;
          current: { startByte: number; endByte: number };
          originalOffset: number;
        }[];
      if (mode === "reverse") [changes[1], changes[2]] = [changes[2]!, changes[1]!];
      else if (mode === "shift") {
        changes[0]!.current.startByte++;
        changes[0]!.current.endByte++;
      } else changes[2]!.current.startByte--;
      rejects(mode === "reverse" ? "receipt" : "span", () => assertProgramCoreTypeRecipe(mutant));
    }
  });
  it("rejects AST ownership and declaration census mutants independently of whole pins", () => {
    assertProgramCoreTypeRoles(current, receipt, "current");
    const mutant = copy();
    (mutant.currentDeclarations[9] as { name: string }).name = "foreignFactory";
    rejects("role", () => assertProgramCoreTypeRoles(current, mutant, "current"));
    rejects("role", () => assertProgramCoreTypeRoles(current + "\nconst extraExecutable = 0;\n", receipt, "current"));
  });
  it("checks nested span ownership after the containing declaration pin is rederived", () => {
    assertProgramCoreTypeRoles(current, receipt, "current");
    const mutant = copy(),
      union = mutant.currentDeclarations[18]!,
      bytes = Buffer.from(current);
    const wrong = editRole(3, (s) => replaceOnce(s, "IrSupportRefType", "IrForeignRefType"));
    // Same-length valid TypeScript; only this diagnostic owner's pin is rederived.
    expect(Buffer.byteLength(wrong)).toBe(bytes.length);
    Object.assign(union, programCoreTypePin(Buffer.from(wrong).subarray(union.startByte, union.endByte)));
    rejects("role", () => assertProgramCoreTypeRoles(wrong, mutant, "current"));
    rejects("pin", () => reconstructProgramCoreTypeEvolution(changed(programCoreTypePath, wrong)));
  });
  it("requires exact span bytes and valid UTF-8 boundaries", () => {
    const span = receipt.changes[2]!.current;
    assertProgramCoreTypeSpan(current, span, "healthy factory");
    rejects("pin", () =>
      assertProgramCoreTypeSpan(
        editRole(2, (s) => replaceOnce(s, "nullable };", "nullable: false };")),
        span,
        "mutant factory",
      ),
    );
    const bytes = Buffer.from("é"),
      split = { startByte: 1, endByte: 2, ...programCoreTypePin(bytes.subarray(1)) };
    rejects("span", () => assertProgramCoreTypeSpan(bytes, split, "split code point"));
  });
});
