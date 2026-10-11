// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  assertIrSourceContractSource,
  authenticateIrSourceContractRelocation,
  beforeIrSourceContractRelocation,
  irSourceContractCurrentPaths,
  irSourceContractDonors,
  irSourceContractOwners,
  irSourceContractRelocationReceiptPath,
  irSourceContractSha256,
  irSourceContractGitBlob,
  readBeforeIrSourceContractRelocation,
  readIrSourceContractActual,
  reconstructIrSourceContractDonors,
} from "./helpers/ir-source-contract-relocation.js";

const receiptText = readIrSourceContractActual(irSourceContractRelocationReceiptPath);
const receipt = authenticateIrSourceContractRelocation(receiptText);

function changed(path: string, text: string): (requested: string) => string {
  return (requested) => (requested === path ? text : readIrSourceContractActual(requested));
}
function declaration(path: string, name: string) {
  const found = receipt.current.find((r) => r.path === path)?.declarations.filter((d) => d.name === name);
  if (found?.length !== 1) throw new Error(`expected one recorded declaration ${path}/${name}`);
  return found[0]!;
}
function editDeclaration(path: string, name: string, edit: (text: string) => string): string {
  const source = readIrSourceContractActual(path),
    d = declaration(path, name);
  const text = source.slice(d.start, d.end),
    replacement = edit(text);
  if (text === replacement) throw new Error("mutation did not change the declaration");
  return source.slice(0, d.start) + replacement + source.slice(d.end);
}
function replaceOnce(source: string, from: string, to: string): string {
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) >= 0) throw new Error("mutation span is missing or duplicated");
  return source.slice(0, at) + to + source.slice(at + from.length);
}

const errorOwner = "src/shared/contracts/ir-preparation-errors.ts";
const mutations: readonly [string, string, () => string][] = [
  ["missing moved declaration", errorOwner, () => editDeclaration(errorOwner, "IrUnsupportedError", () => "")],
  [
    "duplicated moved declaration",
    errorOwner,
    () => editDeclaration(errorOwner, "IrUnsupportedError", (text) => `${text}\n${text}`),
  ],
  [
    "reordered declarations",
    errorOwner,
    () => {
      const source = readIrSourceContractActual(errorOwner);
      const first = declaration(errorOwner, "IrUnsupportedError"),
        second = declaration(errorOwner, "IrInvariantError");
      return (
        source.slice(0, first.start) +
        source.slice(second.start, second.end) +
        source.slice(first.end, second.start) +
        source.slice(first.start, first.end) +
        source.slice(second.end)
      );
    },
  ],
  [
    "changed constructor body",
    errorOwner,
    () =>
      editDeclaration(errorOwner, "IrUnsupportedError", (text) =>
        replaceOnce(text, 'this.name = "IrUnsupportedError"', 'this.name = "wrong"'),
      ),
  ],
  [
    "changed type import",
    errorOwner,
    () => replaceOnce(readIrSourceContractActual(errorOwner), '"./ir-preparation-failure.js"', '"./wrong-failure.js"'),
  ],
  [
    "changed module documentation",
    "src/ir/core/fnctor-abi.ts",
    () =>
      replaceOnce(
        readIrSourceContractActual("src/ir/core/fnctor-abi.ts"),
        "Backend-neutral ABI contract",
        "Changed ABI contract",
      ),
  ],
  [
    "removed readonly",
    "src/ir/core/fnctor-abi.ts",
    () =>
      editDeclaration("src/ir/core/fnctor-abi.ts", "IrFnctorResolution", (text) =>
        replaceOnce(text, "readonly hiddenIdentity", "hiddenIdentity"),
      ),
  ],
  [
    "changed optionality",
    "src/ir/core/string-runtime.ts",
    () =>
      editDeclaration("src/ir/core/string-runtime.ts", "IrStringRuntimeSpec", (text) =>
        replaceOnce(text, "readonly index?:", "readonly index:"),
      ),
  ],
  [
    "extra top-level declaration",
    errorOwner,
    () => `${readIrSourceContractActual(errorOwner)}\nexport const unreviewed = true;\n`,
  ],
  ["shifted source", errorOwner, () => `\n${readIrSourceContractActual(errorOwner)}`],
  [
    "changed retained declaration",
    "src/ir/outcomes.ts",
    () =>
      editDeclaration("src/ir/outcomes.ts", "PreparedProgramAbiCommitError", (text) =>
        replaceOnce(text, "super(`prepared ABI", "super(`changed ABI"),
      ),
  ],
  [
    "changed compatibility link",
    "src/ir/declared-types.ts",
    () =>
      replaceOnce(
        readIrSourceContractActual("src/ir/declared-types.ts"),
        '"./core/declared-types.js"',
        '"./core/wrong-declared-types.js"',
      ),
  ],
];

describe("Phase A live source relocation transport", () => {
  it.each(receipt.originals)("reconstructs the exact original $path from live owners", (record) => {
    const source = readBeforeIrSourceContractRelocation(record.path);
    expect(irSourceContractSha256(source)).toBe(record.sha256);
    expect(irSourceContractGitBlob(source)).toBe(record.gitBlob);
    expect(Buffer.byteLength(source)).toBe(record.bytes);
    expect(source).not.toBe(readIrSourceContractActual(record.path));
  });

  it("authenticates the full declaration population and reciprocal live owner reconstruction", () => {
    expect(receipt.originals.map((r) => r.path)).toEqual(irSourceContractDonors);
    expect(receipt.originals).toHaveLength(13);
    expect(irSourceContractOwners).toHaveLength(12);
    expect(receipt.current).toHaveLength(25);
    expect(receipt.transfers).toHaveLength(184);
    expect(receipt.transfers.filter((t) => t.moved)).toHaveLength(115);
    expect([...reconstructIrSourceContractDonors().keys()]).toEqual(irSourceContractDonors);
    expect(receipt.transfers.filter((t) => t.transform !== null).map((t) => [t.before.name, t.transform])).toEqual([
      ["requireString", "remove-require-string-export"],
    ]);
    expect(receipt.base).toBe("a8cd258d553278d8e5f908878f56a81377ba8e40");
    expect(receipt.candidateProvenance).toContain("uncommitted");
  });

  it("stores only non-executable scaffold in literal recipe fragments", () => {
    const literals = [...receipt.originals, ...receipt.current].flatMap((r) =>
      r.recipe.flatMap((p) => ("literal" in p ? [p.literal] : [])),
    );
    expect(literals.length).toBeGreaterThan(100);
    for (const literal of literals) {
      const source = ts.createSourceFile("scaffold.ts", literal, ts.ScriptTarget.Latest, true);
      expect(source.statements.every((s) => ts.isImportDeclaration(s) || ts.isExportDeclaration(s))).toBe(true);
    }
    expect(receipt.originals.every((r) => r.recipe.some((p) => "slice" in p))).toBe(true);
  });

  it.each(irSourceContractCurrentPaths)(
    "requires the live owner %s even for an unrelated requested donor",
    (missing) => {
      expect(readBeforeIrSourceContractRelocation("src/ir/outcomes.ts")).toContain("export class IrUnsupportedError");
      const failure = new Error(`missing actual owner ${missing}`);
      expect(() =>
        readBeforeIrSourceContractRelocation("src/ir/outcomes.ts", (path) => {
          if (path === missing) throw failure;
          return readIrSourceContractActual(path);
        }),
      ).toThrow(failure);
      const altered = `${readIrSourceContractActual(missing)}\n`;
      expect(() => readBeforeIrSourceContractRelocation("src/ir/outcomes.ts", changed(missing, altered))).toThrow(
        /complete source SHA256\/length mismatch/,
      );
    },
  );

  it.each(mutations)("refuses %s after a genuine positive control", (_label, path, mutate) => {
    expect(reconstructIrSourceContractDonors().size).toBe(13);
    const bad = mutate();
    expect(bad).not.toBe(readIrSourceContractActual(path));
    expect(() => reconstructIrSourceContractDonors(changed(path, bad))).toThrow(
      /complete source SHA256\/length mismatch/,
    );
  });

  it("uses a fresh full population audit after warm reads", () => {
    const path = "src/ir/core/runtime-symbols.ts";
    for (let i = 0; i < 2; i++)
      expect(readBeforeIrSourceContractRelocation("src/ir/outcomes.ts")).toContain("class IrInvariantError");
    const original = readIrSourceContractActual(path);
    expect(() => readBeforeIrSourceContractRelocation("src/ir/outcomes.ts", changed(path, `${original}\n`))).toThrow(
      /complete source SHA256\/length mismatch/,
    );
    expect(readBeforeIrSourceContractRelocation("src/ir/outcomes.ts")).toContain("class IrInvariantError");
  });

  it("checks Git blob independently when SHA256 and bytes are correct", () => {
    const record = receipt.current[0]!,
      source = readIrSourceContractActual(record.path);
    expect(() => assertIrSourceContractSource(source, record, record.path)).not.toThrow();
    expect(() => assertIrSourceContractSource(source, { ...record, gitBlob: "0".repeat(40) }, record.path)).toThrow(
      /Git blob mismatch/,
    );
    expect(() => assertIrSourceContractSource(source, { ...record, sha256: "0".repeat(64) }, record.path)).toThrow(
      /SHA256\/length mismatch/,
    );
  });

  it.each([
    "current blob",
    "original blob",
    "slice hash",
    "slice name",
    "slice occurrence",
    "slice kind",
    "slice offset",
    "owner",
    "executable literal",
  ])("refuses a changed %s in the fixed receipt", (kind) => {
    expect(authenticateIrSourceContractRelocation(receiptText).transfers).toHaveLength(184);
    const bad = JSON.parse(receiptText);
    const piece = bad.originals[0].recipe.find((p: { slice?: unknown }) => p.slice);
    switch (kind) {
      case "current blob":
        bad.current[0].gitBlob = "0".repeat(40);
        break;
      case "original blob":
        bad.originals[0].gitBlob = "0".repeat(40);
        break;
      case "slice hash":
        piece.slice.sha256 = "0".repeat(64);
        break;
      case "slice name":
        piece.slice.name += "Changed";
        break;
      case "slice occurrence":
        piece.slice.occurrence++;
        break;
      case "slice kind":
        piece.slice.kind = "VariableStatement";
        break;
      case "slice offset":
        piece.slice.start++;
        break;
      case "owner":
        piece.slice.path = "src/ir/outcomes.ts";
        break;
      case "executable literal":
        bad.originals[0].recipe.unshift({ literal: "export const substituted = true;\n" });
        break;
    }
    expect(() => reconstructIrSourceContractDonors(readIrSourceContractActual, JSON.stringify(bad))).toThrow(
      "receipt digest mismatch",
    );
  });

  it("does not normalize an already historical mutation input again", () => {
    const path = "src/ir/outcomes.ts",
      current = readIrSourceContractActual(path);
    const prior = beforeIrSourceContractRelocation(path, current);
    expect(irSourceContractSha256(prior)).toBe(receipt.originals[0]!.sha256);
    expect(() => beforeIrSourceContractRelocation(path, prior)).toThrow(/complete source SHA256\/length mismatch/);
    expect(() => beforeIrSourceContractRelocation(path, `${prior}\n`)).toThrow(
      /complete source SHA256\/length mismatch/,
    );
  });

  it("passes unknown paths through raw without requesting other files", () => {
    const requested: string[] = [];
    const reader = (path: string) => {
      requested.push(path);
      return "raw source";
    };
    expect(readBeforeIrSourceContractRelocation("unrelated.ts", reader)).toBe("raw source");
    expect(requested).toEqual(["unrelated.ts"]);
    expect(
      beforeIrSourceContractRelocation("unrelated.ts", "mutation input", () => {
        throw new Error("unneeded read");
      }),
    ).toBe("mutation input");
  });
});
