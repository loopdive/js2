// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  assertProgramPreAPin,
  authenticateProgramPreAEvolution,
  beforeProgramPreAEvolution,
  programPreADependencies,
  programPreAGitBlob,
  programPreAPaths,
  programPreAReceiptPath,
  programPreARetainedReceipt,
  programPreASha256,
  readBeforeProgramPreAEvolution,
  readProgramPreAActual,
  reconstructProgramPreA,
} from "./helpers/ir-program-pre-a-evolution.js";

const receiptText = readProgramPreAActual(programPreAReceiptPath);
const receipt = authenticateProgramPreAEvolution(receiptText);
const population = [...receipt.records.map((r) => ({ path: r.path, ...r.current })), ...receipt.dependencies];
const identity = "src/ir/identity.ts";
const canonicalIdentity = "src/shared/contracts/ir-identity.ts";
const dependencies = "src/ir/prepared-component-dependencies.ts";
const input = "src/ir/program/input-contracts.ts";
const prepared = "src/ir/program/prepared-contracts.ts";

function changed(path: string, source: string): (requested: string) => string {
  return (requested) => (requested === path ? source : readProgramPreAActual(requested));
}
function replaceOnce(source: string, before: string, after: string): string {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + 1) >= 0 || before === after)
    throw new Error("mutation requires one changed exact span");
  return source.slice(0, at) + after + source.slice(at + before.length);
}
function editBytes(path: string, span: { startByte: number; endByte: number }, edit: (text: string) => string): string {
  const source = Buffer.from(readProgramPreAActual(path));
  const text = source.subarray(span.startByte, span.endByte).toString("utf8"),
    replacement = edit(text);
  if (text === replacement) throw new Error("mutation did not alter live bytes");
  return Buffer.concat([
    source.subarray(0, span.startByte),
    Buffer.from(replacement),
    source.subarray(span.endByte),
  ]).toString("utf8");
}
function change(path: string, index: number) {
  const found = receipt.records.find((r) => r.path === path)?.changes[index];
  if (!found) throw new Error("missing fixed change fixture");
  return found;
}
function liveInterface(index: number) {
  const replacement = change(identity, index).replacement;
  if (replacement.kind !== "live") throw new Error("expected canonical live interface");
  return replacement.span;
}
function swappedInterfaces(): string {
  const source = Buffer.from(readProgramPreAActual(canonicalIdentity));
  const first = liveInterface(2),
    second = liveInterface(3);
  return Buffer.concat([
    source.subarray(0, first.startByte),
    source.subarray(second.startByte, second.endByte),
    source.subarray(first.endByte, second.startByte),
    source.subarray(first.startByte, first.endByte),
    source.subarray(second.endByte),
  ]).toString("utf8");
}

const mutations: readonly [string, string, () => string][] = [
  ["missing first lifted interface", canonicalIdentity, () => editBytes(canonicalIdentity, liveInterface(2), () => "")],
  [
    "duplicate second lifted interface",
    canonicalIdentity,
    () => editBytes(canonicalIdentity, liveInterface(3), (s) => s + s),
  ],
  ["reordered lifted interfaces", canonicalIdentity, swappedInterfaces],
  [
    "removed lifted readonly",
    canonicalIdentity,
    () => editBytes(canonicalIdentity, liveInterface(2), (s) => replaceOnce(s, "readonly parentId", "parentId")),
  ],
  [
    "changed lifted optionality",
    canonicalIdentity,
    () => editBytes(canonicalIdentity, liveInterface(2), (s) => replaceOnce(s, "sourceUnit?:", "sourceUnit:")),
  ],
  [
    "changed second interface documentation",
    canonicalIdentity,
    () =>
      editBytes(canonicalIdentity, liveInterface(3), (s) =>
        replaceOnce(s, "Exact lowering-side provenance", "Changed lowering-side provenance"),
      ),
  ],
  [
    "changed retained identity factory body",
    "src/shared/contracts/identity-values.ts",
    () =>
      replaceOnce(
        readProgramPreAActual("src/shared/contracts/identity-values.ts"),
        "value.toString(10)",
        "value.toString(16)",
      ),
  ],
  [
    "redirected identity forwarding link",
    "src/ir/identity-values.ts",
    () =>
      replaceOnce(
        readProgramPreAActual("src/ir/identity-values.ts"),
        '"../shared/contracts/identity-values.js"',
        '"../shared/contracts/wrong-identity-values.js"',
      ),
  ],
  [
    "missing identity insertion anchor",
    identity,
    () =>
      replaceOnce(
        readProgramPreAActual(identity),
        "export interface IrLiftedFunctionArtifactOwner",
        "export interface ChangedLiftedFunctionArtifactOwner",
      ),
  ],
  [
    "redirected donor identity import",
    identity,
    () =>
      editBytes(identity, change(identity, 0).current, (s) =>
        replaceOnce(s, '"../shared/contracts/ir-identity.js"', '"../shared/contracts/wrong-identity.js"'),
      ),
  ],
  [
    "missing added support function",
    dependencies,
    () => editBytes(dependencies, change(dependencies, 1).current, () => ""),
  ],
  [
    "duplicate added support function",
    dependencies,
    () => editBytes(dependencies, change(dependencies, 1).current, (s) => s + s),
  ],
  [
    "changed added support body",
    dependencies,
    () =>
      editBytes(dependencies, change(dependencies, 1).current, (s) =>
        replaceOnce(s, "anchors.length !== 1", "anchors.length !== 2"),
      ),
  ],
  [
    "changed support documentation",
    dependencies,
    () =>
      editBytes(dependencies, change(dependencies, 1).current, (s) =>
        replaceOnce(s, "Semantic dependency proof", "Changed dependency proof"),
      ),
  ],
  [
    "changed new support-ref arm",
    dependencies,
    () =>
      editBytes(dependencies, change(dependencies, 2).current, (s) =>
        replaceOnce(s, "recordSupportTypeReference(", "wrongSupportTypeReference("),
      ),
  ],
  [
    "duplicate new support-ref arm",
    dependencies,
    () => editBytes(dependencies, change(dependencies, 2).current, (s) => s + s),
  ],
  [
    "redirected support import",
    dependencies,
    () =>
      editBytes(dependencies, change(dependencies, 0).current, (s) =>
        replaceOnce(s, '"./program/formatter-support.js"', '"./program/wrong-support.js"'),
      ),
  ],
  [
    "removed input readonly",
    input,
    () => replaceOnce(readProgramPreAActual(input), "readonly runtimeSupport?:", "runtimeSupport?:"),
  ],
  [
    "removed input optionality",
    input,
    () => replaceOnce(readProgramPreAActual(input), "runtimeSupport?:", "runtimeSupport:"),
  ],
  [
    "changed input documentation",
    input,
    () =>
      replaceOnce(
        readProgramPreAActual(input),
        "Internal preparation data produced",
        "Changed preparation data produced",
      ),
  ],
  [
    "removed prepared readonly",
    prepared,
    () => replaceOnce(readProgramPreAActual(prepared), "readonly runtimeSupport?:", "runtimeSupport?:"),
  ],
  [
    "removed prepared optionality",
    prepared,
    () => replaceOnce(readProgramPreAActual(prepared), "runtimeSupport?:", "runtimeSupport:"),
  ],
  [
    "changed prepared documentation",
    prepared,
    () =>
      replaceOnce(
        readProgramPreAActual(prepared),
        "The single source-to-backend handoff",
        "The changed source-to-backend handoff",
      ),
  ],
  [
    "unreviewed executable declaration",
    prepared,
    () => `${readProgramPreAActual(prepared)}\nexport const unreviewed = true;\n`,
  ],
  ["shifted donor offsets", identity, () => `\n${readProgramPreAActual(identity)}`],
];

describe("live program pre-A historical evolution transport", () => {
  it.each(receipt.records)("recovers the exact original $path and replays current bytes", (record) => {
    const original = readBeforeProgramPreAEvolution(record.path);
    expect(programPreASha256(original)).toBe(record.original.sha256);
    expect(programPreAGitBlob(original)).toBe(record.original.gitBlob);
    expect(Buffer.byteLength(original)).toBe(record.original.bytes);
    expect(original).not.toBe(readProgramPreAActual(record.path));
    expect([...reconstructProgramPreA().keys()]).toEqual(programPreAPaths);
  });

  it("pins the entire live population and keeps only non-executable literal scaffold", () => {
    expect(receipt.records).toHaveLength(4);
    expect(receipt.dependencies.map((r) => r.path)).toEqual(programPreADependencies);
    expect(receipt.dependencies).toHaveLength(9);
    expect(population).toHaveLength(13);
    expect(receipt.records.map((r) => r.changes.length)).toEqual([4, 3, 2, 2]);
    const replacements = receipt.records.flatMap((r) => r.changes.map((c) => c.replacement));
    expect(replacements.filter((r) => r.kind === "live")).toHaveLength(2);
    for (const r of replacements) {
      if (r.kind !== "scaffold") continue;
      const parsed = ts.createSourceFile("scaffold.ts", r.text, ts.ScriptTarget.Latest, true);
      expect(parsed.statements.every((s) => ts.isImportDeclaration(s) || ts.isExportDeclaration(s))).toBe(true);
    }
  });

  it.each([
    [identity, 62, 34, "085e2c77ab3f040ea2aa9b4b215a751bdbef69761c1812687f5fed4f16ff0879"],
    [dependencies, 41, 28, "7645e249fd03cedd881938e7844535d71b333b8679194e7a5d2eaabba6842121"],
  ] as const)("preserves the unchanged declaration/function floor for %s", (path, declarations, functions, sha256) => {
    expect(programPreARetainedReceipt(path, readBeforeProgramPreAEvolution(path))).toEqual({
      declarations,
      functions,
      sha256,
    });
  });

  it.each([
    [input, "TypedIrProgramInput", "1dc69663b93552c16a75cac76486906801e697cb33dcc3cfe1201f1717824805"],
    [prepared, "PreparedIrProgram", "83eff15645a15944208dbc46f9dd83bace7fc7f74fca8fcfdf450568c6381392"],
  ] as const)("retains the original documented %s interface receipt", (path, name, expected) => {
    const source = ts.createSourceFile(path, readBeforeProgramPreAEvolution(path), ts.ScriptTarget.Latest, true);
    const nodes = source.statements.filter((s) => ts.isInterfaceDeclaration(s) && s.name.text === name);
    expect(nodes).toHaveLength(1);
    const documented = nodes[0]!
      .getFullText(source)
      .trim()
      .replace(/^\/\/ Copyright[^\n]*\n\s*/, "");
    expect(programPreASha256(documented)).toBe(expected);
  });

  it.each(population)("requires unmodified live $path for every supported read", (record) => {
    expect(reconstructProgramPreA().size).toBe(4);
    const missing = new Error(`missing current ${record.path}`);
    expect(() =>
      readBeforeProgramPreAEvolution(identity, (path) => {
        if (path === record.path) throw missing;
        return readProgramPreAActual(path);
      }),
    ).toThrow(missing);
    expect(() =>
      readBeforeProgramPreAEvolution(identity, changed(record.path, `${readProgramPreAActual(record.path)}\n`)),
    ).toThrow(/SHA256\/length mismatch/);
  });

  it.each(mutations)("refuses %s after the genuine positive control", (_label, path, mutate) => {
    expect(reconstructProgramPreA().size).toBe(4);
    const bad = mutate();
    expect(bad).not.toBe(readProgramPreAActual(path));
    expect(() => reconstructProgramPreA(changed(path, bad))).toThrow(/SHA256\/length mismatch/);
  });

  it.each(population)("independently checks the Git blob for $path", (record) => {
    const source = readProgramPreAActual(record.path);
    expect(() => assertProgramPreAPin(source, record, record.path)).not.toThrow();
    expect(() => assertProgramPreAPin(source, { ...record, gitBlob: "0".repeat(40) }, record.path)).toThrow(
      /Git blob mismatch/,
    );
  });

  it.each([
    "current blob",
    "original blob",
    "span hash",
    "interface name",
    "interface occurrence",
    "interface order",
    "anchor",
    "change order",
    "executable scaffold",
  ])("rejects fixed receipt corruption: %s", (kind) => {
    expect(authenticateProgramPreAEvolution(receiptText).records).toHaveLength(4);
    const bad = JSON.parse(receiptText);
    const first = bad.records[0],
      live = first.changes[2].replacement.span;
    switch (kind) {
      case "current blob":
        first.current.gitBlob = "0".repeat(40);
        break;
      case "original blob":
        first.original.gitBlob = "0".repeat(40);
        break;
      case "span hash":
        live.sha256 = "0".repeat(64);
        break;
      case "interface name":
        live.declaration.name += "Changed";
        break;
      case "interface occurrence":
        live.declaration.occurrence++;
        break;
      case "interface order":
        live.declaration.ordinal++;
        break;
      case "anchor":
        first.changes[2].currentAnchor.startByte++;
        break;
      case "change order":
        first.changes.reverse();
        break;
      case "executable scaffold":
        first.changes[0].replacement.text += "export const substitute = true;\n";
        break;
    }
    expect(() => reconstructProgramPreA(readProgramPreAActual, JSON.stringify(bad))).toThrow("receipt digest mismatch");
  });

  it("reauthenticates every complete current input after warm reads", () => {
    const requested: string[] = [];
    const reader = (path: string) => {
      requested.push(path);
      return readProgramPreAActual(path);
    };
    for (let i = 0; i < 2; i++) expect(reconstructProgramPreA(reader).size).toBe(4);
    expect(requested).toEqual([...population, ...population].map((r) => r.path));
    const path = programPreADependencies[0]!;
    expect(() => reconstructProgramPreA(changed(path, `${readProgramPreAActual(path)}\n`))).toThrow(
      /SHA256\/length mismatch/,
    );
    expect(reconstructProgramPreA().size).toBe(4);
  });

  it.each(receipt.records)("refuses already historical and mutated historical $path", (record) => {
    const original = beforeProgramPreAEvolution(record.path, readProgramPreAActual(record.path));
    expect(programPreASha256(original)).toBe(record.original.sha256);
    expect(() => beforeProgramPreAEvolution(record.path, original)).toThrow(/SHA256\/length mismatch/);
    expect(() => beforeProgramPreAEvolution(record.path, `${original}\n`)).toThrow(/SHA256\/length mismatch/);
  });

  it("leaves current compiler-facing contracts and support validation raw", () => {
    const before = population.map((r) => readProgramPreAActual(r.path));
    expect(reconstructProgramPreA().size).toBe(4);
    expect(population.map((r) => readProgramPreAActual(r.path))).toEqual(before);
    for (const path of [input, prepared]) {
      expect(readProgramPreAActual(path)).toContain("readonly runtimeSupport?: IrRuntimeSupport;");
      expect(readBeforeProgramPreAEvolution(path)).not.toContain("runtimeSupport");
    }
    expect(readProgramPreAActual(dependencies)).toContain(
      "export function assertPreparedIrRuntimeSupportDependencies(",
    );
    expect(readProgramPreAActual(dependencies)).toContain('case "support-ref":');
    expect(readBeforeProgramPreAEvolution(dependencies)).not.toContain("assertPreparedIrRuntimeSupportDependencies");
    expect(readBeforeProgramPreAEvolution(dependencies)).not.toContain('case "support-ref":');
  });

  it("passes unknown paths through raw without reading the receipt population", () => {
    const requested: string[] = [];
    expect(
      readBeforeProgramPreAEvolution("unrelated.ts", (path) => {
        requested.push(path);
        return "raw current";
      }),
    ).toBe("raw current");
    expect(requested).toEqual(["unrelated.ts"]);
    expect(
      beforeProgramPreAEvolution("unrelated.ts", "arbitrary mutation", () => {
        throw new Error("unneeded read");
      }),
    ).toBe("arbitrary mutation");
  });
});
