// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  assertCoreVocabularySource,
  authenticateCoreVocabularyEvolution,
  beforeCoreVocabularyReceiptSource,
  coreVocabularyCurrentPaths,
  coreVocabularyDeclarationReceipt,
  coreVocabularyGitBlob,
  coreVocabularyHistoricalPaths,
  coreVocabularyReceiptPath,
  coreVocabularySha256,
  readCoreVocabularyActual,
  readCoreVocabularyReceiptSource,
  reconstructCoreVocabularyReceiptSources,
} from "./helpers/ir-core-vocabulary-evolution.js";
import { irSourceContractCurrentPaths } from "./helpers/ir-source-contract-relocation.js";

const receiptText = readCoreVocabularyActual(coreVocabularyReceiptPath);
const receipt = authenticateCoreVocabularyEvolution(receiptText);
const core = "src/ir/core/intrinsics.ts",
  contracts = "src/ir/core/intrinsic-contracts.ts";
const vocabulary = "src/ir/core/intrinsic-vocabulary.ts",
  analysis = "src/ir/analysis/intrinsics.ts";
const asyncCore = "src/ir/core/async-intents.ts",
  asyncSchema = "src/runtime/contracts/async-provider-schema.ts";
const callables = "src/ir/core/string-callables.ts";
function changed(path: string, text: string): (requested: string) => string {
  return (requested) => (requested === path ? text : readCoreVocabularyActual(requested));
}
function replaceOnce(source: string, from: string, to: string): string {
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) !== -1 || from === to)
    throw new Error("mutation requires one changed exact span");
  return source.slice(0, at) + to + source.slice(at + from.length);
}
function declaration(path: string, name: string) {
  const found = receipt.current.find((r) => r.path === path)?.declarations.filter((d) => d.name === name);
  if (found?.length !== 1) throw new Error(`missing unique role ${path}/${name}`);
  return found[0]!;
}
function editSpan(path: string, span: { start: number; end: number }, edit: (text: string) => string): string {
  const source = readCoreVocabularyActual(path),
    old = source.slice(span.start, span.end),
    next = edit(old);
  if (old === next) throw new Error("mutation did not alter actual source");
  return source.slice(0, span.start) + next + source.slice(span.end);
}
function editDeclaration(path: string, name: string, edit: (text: string) => string): string {
  return editSpan(path, declaration(path, name), edit);
}
function swap(path: string, first: string, second: string): string {
  const a = declaration(path, first),
    b = declaration(path, second),
    source = readCoreVocabularyActual(path);
  if (a.end > b.start) throw new Error("fixture declaration order mismatch");
  return (
    source.slice(0, a.start) +
    source.slice(b.start, b.end) +
    source.slice(a.end, b.start) +
    source.slice(a.start, a.end) +
    source.slice(b.end)
  );
}
const edits = receipt.transfers.filter((t) => t.edits.length !== 0);
const mutations: readonly [string, string, () => string][] = [
  ["deleted moved tuple", vocabulary, () => editDeclaration(vocabulary, "PURE_MATH_INTRINSIC_IDS", () => "")],
  ["duplicated moved tuple", vocabulary, () => editDeclaration(vocabulary, "PURE_MATH_INTRINSIC_IDS", (s) => s + s)],
  [
    "reordered moved tuples",
    vocabulary,
    () => swap(vocabulary, "PURE_MATH_INTRINSIC_IDS", "NUMERIC_COERCION_INTRINSIC_IDS"),
  ],
  [
    "changed tuple documentation",
    vocabulary,
    () =>
      replaceOnce(readCoreVocabularyActual(vocabulary), "Closed semantic vocabulary", "Changed semantic vocabulary"),
  ],
  [
    "changed interface readonly",
    contracts,
    () => editDeclaration(contracts, "IntrinsicDefinition", (s) => replaceOnce(s, "readonly feature", "feature")),
  ],
  [
    "changed interface optionality",
    contracts,
    () =>
      editDeclaration(contracts, "IntrinsicDefinition", (s) =>
        replaceOnce(s, "readonly feature:", "readonly feature?:"),
      ),
  ],
  [
    "changed generic constraint",
    contracts,
    () => editDeclaration(contracts, "IntrinsicDefinition", (s) => replaceOnce(s, "extends string", "extends unknown")),
  ],
  [
    "changed definition default operand",
    core,
    () => editDeclaration(core, "definition", (s) => replaceOnce(s, "= id", '= "js.boolean.box"')),
  ],
  [
    "changed retained definition body",
    core,
    () =>
      editDeclaration(core, "definition", (s) =>
        replaceOnce(s, "Object.freeze({ id, signature, feature })", "Object.freeze({ id, signature, feature: id })"),
      ),
  ],
  [
    "changed definition signature",
    core,
    () =>
      editDeclaration(core, "definition", (s) => replaceOnce(s, "signature: IntrinsicSignature", "signature: unknown")),
  ],
  [
    "changed remaining table entry",
    core,
    () =>
      editDeclaration(core, "INTRINSIC_DEFINITIONS", (s) =>
        replaceOnce(
          s,
          '"js.boolean.box": definition("js.boolean.box", I32_TO_EXTERNREF_INTRINSIC_SIGNATURE)',
          '"js.boolean.box": definition("js.boolean.box", F64_TO_EXTERNREF_INTRINSIC_SIGNATURE)',
        ),
      ),
  ],
  [
    "changed preserved verifier condition",
    analysis,
    () =>
      editDeclaration(analysis, "signatureMismatch", (s) =>
        replaceOnce(s, "use.resultType.val.boolean !== true", "use.resultType.val.boolean !== false"),
      ),
  ],
  [
    "redirected public facade route",
    "src/ir/intrinsics.ts",
    () =>
      replaceOnce(
        readCoreVocabularyActual("src/ir/intrinsics.ts"),
        'import type { IntrinsicDefinition } from "./runtime/contracts/intrinsics.js";',
        'import type { IntrinsicDefinition } from "./core/intrinsic-contracts.js";',
      ),
  ],
  [
    "redirected async facade",
    "src/ir/async-runtime-providers.ts",
    () =>
      readCoreVocabularyActual("src/ir/async-runtime-providers.ts").replaceAll(
        '"./runtime/async-providers.js"',
        '"./runtime/wrong-providers.js"',
      ),
  ],
  [
    "changed async set initializer",
    asyncCore,
    () => editDeclaration(asyncCore, "ASYNC_RUNTIME_FEATURE_SET", (s) => replaceOnce(s, "new Set", "new WeakSet")),
  ],
  [
    "reordered async guard and set",
    asyncCore,
    () => swap(asyncCore, "ASYNC_RUNTIME_FEATURE_SET", "isAsyncRuntimeFeature"),
  ],
  [
    "changed async schema value union",
    asyncSchema,
    () => replaceOnce(readCoreVocabularyActual(asyncSchema), '"externref" | "i32"', '"externref" | "f64"'),
  ],
  [
    "removed async schema role",
    asyncSchema,
    () => editSpan(asyncSchema, receipt.current.find((r) => r.path === asyncSchema)!.declarations[0]!, () => ""),
  ],
  [
    "changed concat-many arity guard",
    callables,
    () => replaceOnce(readCoreVocabularyActual(callables), "arity < 3", "arity < 2"),
  ],
  [
    "changed concat-many body",
    callables,
    () =>
      replaceOnce(
        readCoreVocabularyActual(callables),
        "${IR_STRING_CONCAT_MANY_PREFIX}${arity}",
        "${IR_STRING_CONCAT_MANY_PREFIX}${arity + 1}",
      ),
  ],
  [
    "changed concat-many prefix",
    callables,
    () => replaceOnce(readCoreVocabularyActual(callables), '"string.concat$arity"', '"string.changed$arity"'),
  ],
  [
    "redirected direct dependency",
    "src/ir/instruction-digest.ts",
    () => `${readCoreVocabularyActual("src/ir/instruction-digest.ts")}\nexport { wrong } from "./wrong.js";\n`,
  ],
  [
    "changed Phase A canonical body",
    "src/ir/core/global-binding-keys.ts",
    () =>
      replaceOnce(
        readCoreVocabularyActual("src/ir/core/global-binding-keys.ts"),
        'typeof value !== "string"',
        'typeof value === "string"',
      ),
  ],
  [
    "changed Phase A forwarding link",
    "src/ir/declared-types.ts",
    () =>
      replaceOnce(
        readCoreVocabularyActual("src/ir/declared-types.ts"),
        '"./core/declared-types.js"',
        '"./core/wrong-declared-types.js"',
      ),
  ],
  ["unknown declaration", core, () => `${readCoreVocabularyActual(core)}\nexport const unreviewed = true;\n`],
  ["shifted source offsets", core, () => `\n${readCoreVocabularyActual(core)}`],
];

describe("authenticated core vocabulary historical reader", () => {
  it.each(receipt.originals)("reconstructs complete original $path from actual current owners", (record) => {
    const original = readCoreVocabularyReceiptSource(record.path);
    expect(coreVocabularySha256(original)).toBe(record.sha256);
    expect(coreVocabularyGitBlob(original)).toBe(record.gitBlob);
    expect(Buffer.byteLength(original)).toBe(record.bytes);
  });

  it("retains every original and current role with exactly four explicit current-only residues", () => {
    const outputs = reconstructCoreVocabularyReceiptSources();
    expect([...outputs.keys()]).toEqual(coreVocabularyHistoricalPaths);
    expect(receipt.current.map((r) => r.path)).toEqual(coreVocabularyCurrentPaths);
    expect(receipt.originals).toHaveLength(8);
    expect(receipt.current).toHaveLength(15);
    expect(receipt.transfers).toHaveLength(164);
    expect(receipt.current.flatMap((r) => r.declarations)).toHaveLength(168);
    expect(receipt.currentResidues.map((r) => [r.path, r.name])).toEqual([
      ["src/ir/intrinsics.ts", "INTRINSIC_DEFINITIONS"],
      ["src/ir/runtime/contracts/intrinsics.ts", "IntrinsicDefinition"],
      [core, "EXTERNREF_TO_BOOLEAN_INTRINSIC_SIGNATURE"],
      [analysis, "verifyIrIntrinsicSignature"],
    ]);
    expect(edits).toHaveLength(6);
    expect(receipt.rawOwners).toHaveLength(51);
    expect(receipt.phaseA.currentOwners.map((r) => r.path)).toEqual(irSourceContractCurrentPaths);
    expect(receipt.directDependencies).toHaveLength(13);
  });

  it.each(receipt.receiptProofs)("preserves the original moved and retained receipts for $old", (record) => {
    const originals = reconstructCoreVocabularyReceiptSources();
    expect(coreVocabularyDeclarationReceipt(record.old, originals.get(record.old)!)).toEqual(record.retained);
    expect(coreVocabularyDeclarationReceipt(record.canonical, originals.get(record.canonical)!)).toEqual(record.moved);
    expect(receipt.receiptProofs.map((r) => [r.moved.count, r.retained.count])).toEqual([
      [12, 44],
      [3, 36],
      [2, 31],
      [4, 32],
    ]);
  });

  it("stores no executable declaration in scaffold and no old body in bounded edit literals", () => {
    const pieces = [...receipt.current, ...receipt.originals].flatMap((r) => r.recipe);
    const literals = pieces.flatMap((p) => ("literal" in p ? [p.literal] : []));
    expect(literals.length).toBeGreaterThan(300);
    for (const literal of literals) {
      const source = ts.createSourceFile("scaffold.ts", literal, ts.ScriptTarget.Latest, true);
      expect(source.statements.every((s) => ts.isImportDeclaration(s) || ts.isExportDeclaration(s))).toBe(true);
    }
    for (const edit of edits.flatMap((t) => t.edits)) {
      expect(edit.replacement).not.toContain("return");
      expect(edit.replacement).not.toContain("{");
    }
  });

  it("preserves the actual definition body and the real async interleaving", () => {
    const original = readCoreVocabularyReceiptSource("src/ir/intrinsics.ts");
    const source = ts.createSourceFile("original.ts", original, ts.ScriptTarget.Latest, true);
    const fn = source.statements.find(
      (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === "definition",
    );
    const current = ts.createSourceFile(core, readCoreVocabularyActual(core), ts.ScriptTarget.Latest, true);
    const actual = current.statements.find(
      (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === "definition",
    );
    expect(fn?.body?.getText(source)).toBe(actual?.body?.getText(current));
    expect(fn?.body).toBeDefined();
    const schemaPositions = receipt.transfers
      .filter((t) => t.original.path === "src/ir/async-runtime-providers.ts" && t.current.path === asyncSchema)
      .map((t) => t.original.ordinal);
    expect(schemaPositions).toEqual([2, 3, 6, 7, 8, 9, 15, 16, 23, 24]);
    expect(
      receipt.transfers
        .filter((t) => t.original.path === "src/ir/string-runtime.ts" && t.current.path === callables)
        .map((t) => [t.original.ordinal, t.original.name]),
    ).toEqual([
      [3, "IR_STRING_CONCAT_FN"],
      [10, "IR_STRING_CONCAT_MANY_PREFIX"],
      [18, "irStringConcatManySymbol"],
    ]);
  });

  it.each(receipt.rawOwners)("requires genuine raw $path before reconstructing any requested output", (record) => {
    expect(reconstructCoreVocabularyReceiptSources().size).toBe(8);
    const missing = new Error(`missing ${record.path}`);
    expect(() =>
      readCoreVocabularyReceiptSource(coreVocabularyHistoricalPaths[0]!, (path) => {
        if (path === record.path) throw missing;
        return readCoreVocabularyActual(path);
      }),
    ).toThrow(missing);
    expect(() =>
      reconstructCoreVocabularyReceiptSources(changed(record.path, `${readCoreVocabularyActual(record.path)}\n`)),
    ).toThrow(/complete source SHA256\/length mismatch/);
  });

  it.each(mutations)("rejects %s after a genuine complete positive", (_label, path, mutate) => {
    expect(reconstructCoreVocabularyReceiptSources().size).toBe(8);
    const bad = mutate();
    expect(bad).not.toBe(readCoreVocabularyActual(path));
    expect(() => reconstructCoreVocabularyReceiptSources(changed(path, bad))).toThrow(
      /complete source SHA256\/length mismatch/,
    );
  });

  it.each(edits)("refuses altered edited role $current.path/$current.name", (transfer) => {
    expect(reconstructCoreVocabularyReceiptSources().size).toBe(8);
    const bad = editSpan(transfer.current.path, transfer.current, (text) =>
      text.replace(/^./, (c) => (c === "x" ? "y" : "x")),
    );
    expect(Buffer.byteLength(bad)).toBe(Buffer.byteLength(readCoreVocabularyActual(transfer.current.path)));
    expect(() => reconstructCoreVocabularyReceiptSources(changed(transfer.current.path, bad))).toThrow(
      /complete source SHA256\/length mismatch/,
    );
  });

  it.each(receipt.currentResidues)("rejects missing current-only $path/$name instead of ignoring it", (residue) => {
    expect(reconstructCoreVocabularyReceiptSources().size).toBe(8);
    for (const bad of [editSpan(residue.path, residue, () => ""), editSpan(residue.path, residue, (s) => s + s)])
      expect(() => reconstructCoreVocabularyReceiptSources(changed(residue.path, bad))).toThrow(
        /complete source SHA256\/length mismatch/,
      );
  });

  it.each(receipt.booleanHunks)("authenticates the actual Boolean hunk at $path:$start", (hunk) => {
    expect(reconstructCoreVocabularyReceiptSources().size).toBe(8);
    const current = readCoreVocabularyActual(hunk.path);
    expect(coreVocabularySha256(current.slice(hunk.start, hunk.end))).toBe(hunk.sha256);
    const bad = editSpan(hunk.path, hunk, () => "");
    expect(() => reconstructCoreVocabularyReceiptSources(changed(hunk.path, bad))).toThrow(
      /complete source SHA256\/length mismatch/,
    );
  });

  it("checks Git blob independently of a correct full SHA and length", () => {
    const record = receipt.rawOwners[0]!,
      text = readCoreVocabularyActual(record.path);
    expect(() => assertCoreVocabularySource(text, record, record.path)).not.toThrow();
    expect(() => assertCoreVocabularySource(text, { ...record, gitBlob: "0".repeat(40) }, record.path)).toThrow(
      /Git blob mismatch/,
    );
  });

  it.each([
    "epoch",
    "provenance",
    "owner blob",
    "original blob",
    "declaration occurrence",
    "declaration order",
    "edit role",
    "edit bytes",
    "unknown edit field",
    "residue",
    "scaffold body",
    "Phase A receipt",
  ])("rejects changed fixed receipt authority: %s", (kind) => {
    expect(authenticateCoreVocabularyEvolution(receiptText).transfers).toHaveLength(164);
    const bad = JSON.parse(receiptText),
      transfer = bad.transfers.find((t: { edits: unknown[] }) => t.edits.length);
    switch (kind) {
      case "epoch":
        bad.originalRev = bad.currentRev;
        break;
      case "provenance":
        bad.provenanceCommits.pop();
        break;
      case "owner blob":
        bad.rawOwners[0].gitBlob = "0".repeat(40);
        break;
      case "original blob":
        bad.originals[0].gitBlob = "0".repeat(40);
        break;
      case "declaration occurrence":
        bad.current[0].declarations[0].occurrence++;
        break;
      case "declaration order":
        bad.originals[0].declarations.reverse();
        break;
      case "edit role":
        transfer.current.name += "Changed";
        break;
      case "edit bytes":
        transfer.edits[0].replacement = "unreviewed";
        break;
      case "unknown edit field":
        transfer.edits[0].callback = "permit";
        break;
      case "residue":
        bad.currentResidues.pop();
        break;
      case "scaffold body":
        bad.originals[0].recipe.unshift({ literal: "export const substitute = true;\n" });
        break;
      case "Phase A receipt":
        bad.phaseA.receipt.sha256 = "0".repeat(64);
        break;
    }
    expect(() => reconstructCoreVocabularyReceiptSources(readCoreVocabularyActual, JSON.stringify(bad))).toThrow(
      "receipt digest mismatch",
    );
  });

  it("captures each raw owner once per operation and audits fresh after warm reads", () => {
    const requested: string[] = [];
    const reader = (path: string) => {
      requested.push(path);
      return readCoreVocabularyActual(path);
    };
    for (let i = 0; i < 2; i++) expect(reconstructCoreVocabularyReceiptSources(reader).size).toBe(8);
    expect(requested).toEqual([...receipt.rawOwners, ...receipt.rawOwners].map((r) => r.path));
    const path = receipt.phaseA.currentOwners[0]!.path;
    expect(() => reconstructCoreVocabularyReceiptSources(changed(path, `${readCoreVocabularyActual(path)}\n`))).toThrow(
      /complete source SHA256\/length mismatch/,
    );
    expect(reconstructCoreVocabularyReceiptSources().size).toBe(8);
  });

  it.each(receipt.originals)("refuses noncurrent historical mutation input for $path", (record) => {
    const original = readCoreVocabularyReceiptSource(record.path),
      current = readCoreVocabularyActual(record.path);
    if (original === current) {
      // Two unchanged canonical leaves carry identical bytes; string input has no extra provenance identity.
      expect(["src/ir/core/string-types.ts", "src/shared/contracts/ir-counted-string-identity.ts"]).toContain(
        record.path,
      );
      expect(beforeCoreVocabularyReceiptSource(record.path, original)).toBe(original);
    } else {
      expect(() => beforeCoreVocabularyReceiptSource(record.path, original)).toThrow(
        /complete source SHA256\/length mismatch/,
      );
    }
    expect(() => beforeCoreVocabularyReceiptSource(record.path, `${original}\n`)).toThrow(
      /complete source SHA256\/length mismatch/,
    );
  });

  it("keeps source and compiler-facing readers current after historical reconstruction", () => {
    const before = receipt.rawOwners.map((r) => readCoreVocabularyActual(r.path));
    expect(reconstructCoreVocabularyReceiptSources().size).toBe(8);
    expect(receipt.rawOwners.map((r) => readCoreVocabularyActual(r.path))).toEqual(before);
    expect(readCoreVocabularyActual(core)).toContain('"js.boolean.unbox": definition(');
    expect(readCoreVocabularyActual(analysis)).toContain("result must preserve its Boolean carrier brand");
    expect(readCoreVocabularyActual(asyncCore)).toContain("function isAsyncRuntimeFeature");
    expect(readCoreVocabularyActual(callables)).toContain("arity < 3");
    expect(readCoreVocabularyReceiptSource("src/ir/intrinsics.ts")).not.toContain('"js.boolean.unbox"');
  });

  it("passes unknown paths through without capturing or normalizing other files", () => {
    const seen: string[] = [];
    expect(
      readCoreVocabularyReceiptSource("unrelated.ts", (path) => {
        seen.push(path);
        return "raw";
      }),
    ).toBe("raw");
    expect(seen).toEqual(["unrelated.ts"]);
    expect(
      beforeCoreVocabularyReceiptSource("unrelated.ts", "mutation", () => {
        throw new Error("unexpected read");
      }),
    ).toBe("mutation");
  });
});
