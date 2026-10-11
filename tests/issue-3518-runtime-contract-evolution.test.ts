// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  beforeRemainderRuntimeContractOwners,
  reconstructRemainderRuntimeContractReceiptSources,
  beforeRemainderRuntimeContractReceiptSource,
  readRemainderRuntimeContractReceiptSource,
} from "./helpers/ir-remainder-runtime-contract-evolution.js";
import { createHash } from "node:crypto";
import { beforeSourceMapProgramValidatorRelocation } from "./helpers/ir-program-validator-relocation.js";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import * as unchangedKernel from "./helpers/ir-runtime-contract-evolution.js";
import {
  assertRuntimeContractSource,
  authenticateRuntimeContractEvolution,
  beforeRuntimeContractReceiptSource as originalBeforeRuntimeContractReceiptSource,
  readRuntimeContractActual as originalReadRuntimeContractActual,
  readRuntimeContractReceiptSource as originalReadRuntimeContractReceiptSource,
  reconstructRuntimeContractReceiptSources as originalReconstructRuntimeContractReceiptSources,
  runtimeContractCurrentPaths,
  runtimeContractGitBlob,
  runtimeContractReceiptPath,
  runtimeContractSha256,
} from "./helpers/ir-runtime-contract-evolution.js";
import {
  acceptedHistoricalDeclarations,
  assertIntrinsicSpecialization,
  callableSourceView,
  historicalIntrinsicSource,
  receiptRows,
} from "./helpers/ir-historical-runtime-reconstruction.js";

import { beforeRemainderRuntimePreparationRelocation as beforeRuntimePreparationRelocation } from "./helpers/ir-remainder-runtime-preparation-relocation.js";

type SourceReader = (path: string) => string;
// These tests' "current" is the immutable pre-C2a evolution input.
const prePreparationRead = (): SourceReader =>
  beforeRuntimePreparationRelocation(beforeProgramValidatorRelocation(originalReadRuntimeContractActual));
// Original331 source/AST/recipe mutants are applied after this authenticated association.
// The local legacy name denotes the immutable receipt-era input, not live compiler bytes.
const priorContractRead = (): SourceReader => beforeRemainderRuntimeContractOwners(prePreparationRead());
const readRuntimeContractActual: SourceReader = (path) => priorContractRead()(path);
function reconstructRuntimeContractReceiptSources(reader?: SourceReader, receiptText?: string) {
  return originalReconstructRuntimeContractReceiptSources(reader ?? priorContractRead(), receiptText);
}
function beforeRuntimeContractReceiptSource(path: string, source: string, reader?: SourceReader): string {
  return originalBeforeRuntimeContractReceiptSource(path, source, reader ?? priorContractRead());
}
function readRuntimeContractReceiptSource(path: string, reader?: SourceReader): string {
  return originalReadRuntimeContractReceiptSource(path, reader ?? priorContractRead());
}

const receiptText = readRuntimeContractActual(runtimeContractReceiptPath);
const receipt = authenticateRuntimeContractEvolution(receiptText);
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const manifest = "src/ir/runtime/manifest.ts",
  callables = "src/ir/runtime/callable-declarations.ts";
const policy = "src/runtime/contracts/provider-policy.ts",
  contracts = "src/ir/runtime/contracts/manifest.ts";
const core = "src/ir/core/intrinsics.ts",
  support = "src/ir/intrinsic-support.ts";
const abi = "src/ir/program/runtime-abi-identity.ts",
  abiFacade = "src/ir/program-runtime-abi.ts";
const generic = "src/ir/core/intrinsic-contracts.ts",
  analysis = "src/ir/analysis/intrinsics.ts";
let restored: ReadonlyMap<string, string>;
beforeAll(() => {
  restored = reconstructRuntimeContractReceiptSources();
});
afterEach(async () => {
  await setImmediate();
});

function required(path: string): string {
  const source = restored.get(path);
  if (source === undefined) throw new Error(`missing mapped test source: ${path}`);
  return source;
}
function historical(path: string): string {
  return runtimeContractCurrentPaths.includes(path) ? required(path) : readRuntimeContractActual(path);
}
function parsed(path: string, source: string): ts.SourceFile {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  expect((tree as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics).toEqual(
    [],
  );
  return tree;
}
function changed(path: string, source: string): (requested: string) => string {
  return (requested) => (requested === path ? source : readRuntimeContractActual(requested));
}
function replaceOnce(source: string, from: string, to: string): string {
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) !== -1 || from === to)
    throw new Error("mutation requires one changed exact span");
  return source.slice(0, at) + to + source.slice(at + from.length);
}
function declaration(path: string, name: string) {
  const found = receipt.records.find((r) => r.path === path)?.current.declarations.filter((d) => d.name === name);
  if (found?.length !== 1) throw new Error(`missing unique declaration ${path}/${name}`);
  return found[0]!;
}
function editSpan(
  path: string,
  span: { readonly start: number; readonly end: number },
  transform: (text: string) => string,
): string {
  const raw = readRuntimeContractActual(path),
    previous = raw.slice(span.start, span.end),
    next = transform(previous);
  if (previous === next) throw new Error("mutation did not alter the actual raw source");
  return raw.slice(0, span.start) + next + raw.slice(span.end);
}
function editDeclaration(path: string, name: string, transform: (text: string) => string): string {
  return editSpan(path, declaration(path, name), transform);
}
function swapped(
  path: string,
  a: { readonly start: number; readonly end: number },
  b: { readonly start: number; readonly end: number },
): string {
  const raw = readRuntimeContractActual(path);
  if (a.end > b.start) throw new Error("test source spans are not ordered");
  return (
    raw.slice(0, a.start) +
    raw.slice(b.start, b.end) +
    raw.slice(a.end, b.start) +
    raw.slice(a.start, a.end) +
    raw.slice(b.end)
  );
}
function refused(path: string, mutant: string, validSyntax = false): void {
  const raw = readRuntimeContractActual(path),
    row = receipt.records.find((r) => r.path === path)!;
  expect(runtimeContractSha256(raw)).toBe(row.current.sha256);
  expect(runtimeContractSha256(required(path))).toBe(row.target.sha256);
  expect(mutant).not.toBe(raw);
  if (validSyntax) parsed(path, mutant);
  expect(() => reconstructRuntimeContractReceiptSources(changed(path, mutant))).toThrow(
    `runtime contract evolution: complete source SHA256/length mismatch: ${path}`,
  );
}
const spans = receipt.records.flatMap((r) => r.spans.map((span) => ({ path: r.path, span })));
const changedRecords = receipt.records.filter((r) => r.spans.length !== 0);
const orderedPairs = receipt.records.filter((r) => r.spans.length > 1);

const semanticMutations: readonly [string, string, () => string][] = [
  [
    "manifest private state",
    manifest,
    () =>
      replaceOnce(
        readRuntimeContractActual(manifest),
        '#state: BuilderState = "open"',
        '#state: BuilderState = "failed"',
      ),
  ],
  [
    "manifest function body",
    manifest,
    () => replaceOnce(readRuntimeContractActual(manifest), 'this.#state = "building";', 'this.#state = "failed";'),
  ],
  [
    "manifest delegated provider operand",
    manifest,
    () =>
      replaceOnce(
        readRuntimeContractActual(manifest),
        "semanticCallableProviderMismatch(provider)",
        "semanticCallableProviderMismatch(undefined)",
      ),
  ],
  [
    "manifest delegated policy receiver",
    manifest,
    () =>
      replaceOnce(
        readRuntimeContractActual(manifest),
        "semanticCallablePolicyMismatch(feature, this.#policy)",
        "semanticCallablePolicyMismatch(feature, undefined)",
      ),
  ],
  [
    "manifest native Boolean policy",
    manifest,
    () =>
      editDeclaration(manifest, "booleanBoundaryProviderId", (s) =>
        replaceOnce(s, 'policy.unbox === "native"', 'policy.unbox === "unsupported"'),
      ),
  ],
  [
    "Number policy readonly",
    policy,
    () => editDeclaration(policy, "NumberBoundaryPolicy", (s) => replaceOnce(s, "readonly box:", "box:")),
  ],
  [
    "Boolean policy optionality",
    policy,
    () =>
      editDeclaration(policy, "BooleanBoundaryPolicy", (s) => replaceOnce(s, "readonly unbox?:", "readonly unbox:")),
  ],
  [
    "Boolean policy native member",
    policy,
    () =>
      editDeclaration(policy, "BooleanBoundaryPolicy", (s) =>
        replaceOnce(s, 'readonly unbox?: "native" | "unsupported";', 'readonly unbox?: "unsupported";'),
      ),
  ],
  [
    "provider interface readonly",
    contracts,
    () => editDeclaration(contracts, "RuntimeProviderDefinition", (s) => replaceOnce(s, "readonly id:", "id:")),
  ],
  [
    "generic contract parameter",
    generic,
    () =>
      editDeclaration(generic, "IntrinsicDefinition", (s) =>
        replaceOnce(s, "Feature extends string", "Feature extends number"),
      ),
  ],
  [
    "generic contract readonly",
    generic,
    () => editDeclaration(generic, "IntrinsicDefinition", (s) => replaceOnce(s, "readonly feature:", "feature:")),
  ],
  [
    "runtime specialization alias",
    "src/ir/runtime/contracts/intrinsics.ts",
    () =>
      editDeclaration("src/ir/runtime/contracts/intrinsics.ts", "IntrinsicDefinition", (s) =>
        replaceOnce(s, "CoreIntrinsicDefinition<RuntimeFeature>", "CoreIntrinsicDefinition<string>"),
      ),
  ],
  [
    "generic implementation body",
    core,
    () =>
      editDeclaration(core, "definition", (s) =>
        replaceOnce(s, "Object.freeze({ id, signature, feature })", "Object.freeze({ id, signature, feature: id })"),
      ),
  ],
  [
    "generic table annotation",
    core,
    () =>
      editDeclaration(core, "INTRINSIC_DEFINITIONS", (s) =>
        replaceOnce(s, "IntrinsicDefinition<IntrinsicId>", "IntrinsicDefinition<string>"),
      ),
  ],
  [
    "Boolean signature brand",
    core,
    () =>
      editDeclaration(core, "EXTERNREF_TO_BOOLEAN_INTRINSIC_SIGNATURE", (s) =>
        replaceOnce(s, "boolean: true as const", "boolean: false as const"),
      ),
  ],
  [
    "Boolean table signature",
    core,
    () =>
      editDeclaration(core, "INTRINSIC_DEFINITIONS", (s) =>
        replaceOnce(
          s,
          '"js.boolean.unbox": definition("js.boolean.unbox", EXTERNREF_TO_BOOLEAN_INTRINSIC_SIGNATURE)',
          '"js.boolean.unbox": definition("js.boolean.unbox", EXTERNREF_TO_I32_INTRINSIC_SIGNATURE)',
        ),
      ),
  ],
  [
    "Boolean result verifier",
    analysis,
    () =>
      editDeclaration(analysis, "signatureMismatch", (s) =>
        replaceOnce(s, "use.resultType.val.boolean !== true", "use.resultType.val.boolean !== false"),
      ),
  ],
  [
    "semantic provider spread",
    callables,
    () =>
      editDeclaration(callables, "SEMANTIC_CALLABLE_RUNTIME_PROVIDERS", (s) =>
        replaceOnce(s, "...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS", "...ORDINARY_OBJECT_RUNTIME_PROVIDERS"),
      ),
  ],
  [
    "semantic provider first call",
    callables,
    () =>
      editDeclaration(callables, "semanticCallableProviderMismatch", (s) =>
        replaceOnce(s, "nativeAsyncProviderMismatch(provider)", "nativeAsyncProviderMismatch(undefined)"),
      ),
  ],
  [
    "semantic policy condition",
    callables,
    () =>
      editDeclaration(callables, "semanticCallablePolicyMismatch", (s) =>
        replaceOnce(s, "entry === feature", "entry !== feature"),
      ),
  ],
  [
    "semantic policy native argument",
    callables,
    () =>
      editDeclaration(callables, "semanticCallablePolicyMismatch", (s) =>
        replaceOnce(
          s,
          "nativeAsyncCallablePolicyMismatch(feature, policy)",
          "nativeAsyncCallablePolicyMismatch(feature, undefined)",
        ),
      ),
  ],
  [
    "callable lookup vector body",
    callables,
    () =>
      editDeclaration(callables, "irRuntimeCallableDeclaration", (s) =>
        replaceOnce(s, "irVectorCallableDeclaration(ref)", "irVectorCallableDeclaration(undefined)"),
      ),
  ],
  [
    "ABI anchor function body",
    abi,
    () =>
      editDeclaration(abi, "preparedIrRuntimeAbiAnchor", (s) =>
        replaceOnce(s, "entries.length !== 1", "entries.length !== 2"),
      ),
  ],
  [
    "ABI callable body",
    abi,
    () =>
      editDeclaration(abi, "preparedIrRuntimeCallableBindingId", (s) =>
        replaceOnce(s, "ownerId: preparedIrRuntimeAbiAnchor(inventory).id", "ownerId: inventory.entryId"),
      ),
  ],
  [
    "ABI live documentation",
    abi,
    () =>
      replaceOnce(
        readRuntimeContractActual(abi),
        "Shared ABI identity is anchored at the entry source",
        "Changed ABI identity is anchored at the entry source",
      ),
  ],
  ["ABI donor import", abi, () => replaceOnce(readRuntimeContractActual(abi), '"./errors.js"', '"./wrong-errors.js"')],
  [
    "ABI forwarding link",
    abiFacade,
    () =>
      replaceOnce(
        readRuntimeContractActual(abiFacade),
        '"./program/runtime-abi-identity.js"',
        '"./program/wrong-runtime-abi-identity.js"',
      ),
  ],
  [
    "retained support call body",
    support,
    () =>
      replaceOnce(
        readRuntimeContractActual(support),
        "runtimeCallFeatures.add(declaration.feature);",
        "runtimeCallFeatures.delete(declaration.feature);",
      ),
  ],
  [
    "support current guarded predicate",
    support,
    () =>
      replaceOnce(
        readRuntimeContractActual(support),
        'declaration.feature === "error.reference.construct"',
        'declaration.feature !== "error.reference.construct"',
      ),
  ],
];

const metadataMutations: readonly [string, (r: Mutable<typeof receipt>) => void][] = [
  [
    "schema",
    (r) => {
      r.schema = 2;
    },
  ],
  [
    "kind",
    (r) => {
      r.kind = "caller-authored";
    },
  ],
  [
    "current revision",
    (r) => {
      r.head = "0".repeat(40);
    },
  ],
  [
    "golden revision",
    (r) => {
      r.golden = "0".repeat(40);
    },
  ],
  [
    "Boolean predecessor",
    (r) => {
      r.booleanBeforeStage = r.golden;
    },
  ],
  [
    "authoring requirement pin",
    (r) => {
      r.authoring.requirementSource.sha256 = "0".repeat(64);
    },
  ],
  [
    "reviewed source specification",
    (r) => {
      r.authoring.priorSpecSha256 = "0".repeat(64);
    },
  ],
  [
    "merge parent population",
    (r) => {
      r.provenance.find((p) => p.parents.length === 2)!.parents.pop();
    },
  ],
  [
    "provenance diff",
    (r) => {
      r.provenance[0]!.diffSha256 = "0".repeat(64);
    },
  ],
  [
    "source path order",
    (r) => {
      r.paths.reverse();
    },
  ],
  [
    "removed source",
    (r) => {
      r.records.pop();
    },
  ],
  [
    "unknown source path",
    (r) => {
      r.records[0]!.path = "src/ir/unknown.ts";
    },
  ],
  [
    "whole source blob independently",
    (r) => {
      r.records[0]!.current.gitBlob = "0".repeat(40);
    },
  ],
  [
    "target whole hash",
    (r) => {
      r.records[0]!.target.sha256 = "0".repeat(64);
    },
  ],
  [
    "declaration role",
    (r) => {
      r.records[0]!.current.declarations[0]!.name += "Changed";
    },
  ],
  [
    "declaration occurrence",
    (r) => {
      r.records[0]!.current.declarations[0]!.occurrence++;
    },
  ],
  [
    "doc prefix",
    (r) => {
      r.records[0]!.current.declarations[0]!.fullText.sha256 = "0".repeat(64);
    },
  ],
  [
    "span ordering",
    (r) => {
      r.records.find((p) => p.spans.length > 1)!.spans.reverse();
    },
  ],
  [
    "context position",
    (r) => {
      r.records.find((p) => p.spans.length)!.spans[0]!.current.start++;
    },
  ],
  [
    "removed live residue",
    (r) => {
      r.currentResidues.pop();
    },
  ],
  [
    "ABI donor function order",
    (r) => {
      r.abiDonor.declarations.reverse();
    },
  ],
  [
    "ABI donor source link",
    (r) => {
      r.abiDonor.functions.path = manifest;
    },
  ],
  [
    "original historical hash",
    (r) => {
      r.historicalReceipts[0]!.sha256 = "0".repeat(64);
    },
  ],
  [
    "original link hash",
    (r) => {
      r.goldenReceipts[0]!.linkHash = "0".repeat(64);
    },
  ],
  [
    "stored executable literal",
    (r) => {
      const piece = r.records.flatMap((p) => p.spans.flatMap((s) => s.recipe)).find((p) => p.kind === "literal");
      if (!piece || piece.kind !== "literal") throw new Error("missing literal control");
      piece.text = "return undefined;";
    },
  ],
  [
    "live token parent role",
    (r) => {
      const piece = r.records.flatMap((p) => p.spans.flatMap((s) => s.recipe)).find((p) => p.kind === "live");
      if (!piece || piece.kind !== "live") throw new Error("missing live control");
      piece.tokens.first.kind = "Unknown";
    },
  ],
];

describe("issue 3518: runtime contract initial-source evolution", () => {
  it("captures exactly 27 production sources once, without reading authoring test provenance", () => {
    const reads: string[] = [];
    const result = reconstructRuntimeContractReceiptSources((path) => {
      reads.push(path);
      return readRuntimeContractActual(path);
    });
    expect(reads).toEqual(runtimeContractCurrentPaths);
    expect([...result.keys()]).toEqual(runtimeContractCurrentPaths);
    expect(reads).not.toContain(receipt.authoring.requirementSource.path);
    expect(result).toEqual(restored);
  });

  it.each(receipt.records)("recovers exact target and complete reciprocal bytes for $path", (record) => {
    const target = required(record.path),
      raw = readRuntimeContractActual(record.path);
    expect(Buffer.byteLength(target)).toBe(record.target.bytes);
    expect(runtimeContractSha256(target)).toBe(record.target.sha256);
    expect(runtimeContractGitBlob(target)).toBe(record.target.gitBlob);
    let cursor = 0,
      replay = "";
    for (const span of record.spans) {
      const before = target.slice(span.target.start, span.target.end),
        current = raw.slice(span.current.start, span.current.end);
      expect(runtimeContractSha256(before)).toBe(span.target.sha256);
      expect(runtimeContractGitBlob(current)).toBe(span.current.gitBlob);
      replay += target.slice(cursor, span.target.start) + current;
      cursor = span.target.end;
    }
    replay += target.slice(cursor);
    expect(replay).toBe(raw);
    expect(runtimeContractSha256(replay)).toBe(record.current.sha256);
  });

  it("retains the exact live manifest 79 and callable 10 declaration census", () => {
    for (const [path, count] of [
      [contracts, 79],
      [callables, 10],
    ] as const) {
      const tree = parsed(path, readRuntimeContractActual(path));
      expect(tree.statements.filter((n) => !ts.isImportDeclaration(n) && !ts.isExportDeclaration(n))).toHaveLength(
        count,
      );
    }
    expect(receipt.records.filter((r) => r.spans.length)).toHaveLength(11);
    expect(spans).toHaveLength(34);
    expect(receipt.currentResidues).toHaveLength(8);
  });

  it("retains both actual live ABI function bodies and documentation in the old owner", () => {
    expect(receipt.abiDonor.declarations.map((d) => d.name)).toEqual([
      "preparedIrRuntimeAbiAnchor",
      "preparedIrRuntimeCallableBindingId",
    ]);
    const raw = readRuntimeContractActual(abi),
      part = receipt.abiDonor.functions;
    const bodies = raw.slice(part.start, part.end),
      target = required(abiFacade);
    expect(target.indexOf(bodies)).toBeGreaterThan(0);
    expect(target.indexOf(bodies, target.indexOf(bodies) + 1)).toBe(-1);
    expect(bodies).toContain('throw new PreparedIrProgramInvariantError("invalid-prepared-data"');
    expect(target).not.toContain('from "./program/runtime-abi-identity.js"');
    expect(required(abi)).toBe(raw);
  });

  it("preserves generic runtime specialization and actual core bodies outside the Boolean inverse", () => {
    expect(() => assertIntrinsicSpecialization(historical)).not.toThrow();
    expect(required("src/ir/runtime/contracts/intrinsics.ts")).toContain(
      "IntrinsicDefinition = CoreIntrinsicDefinition<RuntimeFeature>",
    );
    const definition = declaration(core, "definition"),
      raw = readRuntimeContractActual(core);
    expect(required(core)).toContain(raw.slice(definition.start, definition.end));
    expect(required(core)).toContain("IntrinsicDefinition<IntrinsicId>");
    expect(required(core)).not.toContain("EXTERNREF_TO_BOOLEAN_INTRINSIC_SIGNATURE");
    expect(historicalIntrinsicSource(historical)).toContain("export interface IntrinsicDefinition");
  });

  it.each(["pre-vector-clock", "pre-clock-callable"] as const)(
    "preserves all old link/owner checks and the %s stage",
    (stage) => {
      const view = callableSourceView(historical, stage);
      expect(view(callables)).toContain("irRuntimeCallableDeclaration");
      expect(view(manifest)).toContain("RuntimeManifestBuilder");
    },
  );

  it.each(receipt.historicalReceipts)("preserves the original $count declaration receipt for $path", (row) => {
    const declarations = acceptedHistoricalDeclarations(row.path, historical);
    expect(declarations).toHaveLength(row.count);
    expect(declarations.filter((d) => d.kind === "function")).toHaveLength(row.functions);
    expect(runtimeContractSha256(JSON.stringify(receiptRows(declarations)))).toBe(row.sha256);
    expect(declarations.map((d) => [d.path, d.kind, d.name, d.ordinal])).toEqual(row.order);
  });

  it.each(runtimeContractCurrentPaths)("requires the complete raw owner %s", (path) => {
    expect(() =>
      reconstructRuntimeContractReceiptSources((p) =>
        p === path ? (undefined as unknown as string) : readRuntimeContractActual(p),
      ),
    ).toThrow(`complete source SHA256/length mismatch: ${path}`);
  });

  it.each(runtimeContractCurrentPaths)("rejects an outside-span raw edit in %s", (path) => {
    refused(path, "// unreviewed current source prefix\n" + readRuntimeContractActual(path), true);
  });

  it.each(spans)("rejects missing raw span $span.ordinal in $path", ({ path, span }) => {
    refused(
      path,
      editSpan(path, span.current, () => ""),
    );
  });
  it.each(spans)("rejects duplicated raw span $span.ordinal in $path", ({ path, span }) => {
    refused(
      path,
      editSpan(path, span.current, (text) => text + text),
    );
  });
  it.each(spans)("rejects changed raw span $span.ordinal in $path", ({ path, span }) => {
    refused(
      path,
      editSpan(path, span.current, (text) => "/* changed reviewed span */" + text),
    );
  });
  it.each(spans)("rejects shifted raw span $span.ordinal in $path", ({ path, span }) => {
    const raw = readRuntimeContractActual(path),
      text = raw.slice(span.current.start, span.current.end),
      remainder = raw.slice(0, span.current.start) + raw.slice(span.current.end);
    refused(path, span.current.end === raw.length ? text + remainder : remainder + text);
  });
  it.each(orderedPairs)("rejects reordered reviewed spans in $path", (record) => {
    refused(record.path, swapped(record.path, record.spans[0]!.current, record.spans[1]!.current));
  });
  it.each(receipt.currentResidues)("authenticates the removed live residue $path/$name before removing it", (row) => {
    refused(
      row.path,
      editSpan(row.path, row, () => ""),
      true,
    );
  });
  it.each(receipt.currentResidues)("rejects a duplicate current-only residue $path/$name", (row) => {
    refused(
      row.path,
      editSpan(row.path, row, (text) => text + "\n" + text),
      true,
    );
  });
  it.each(semanticMutations)("rejects the valid-syntax mutation: %s", (_name, path, make) => {
    refused(path, make(), true);
  });
  it.each(receipt.abiDonor.declarations)("refuses missing actual ABI function $name", (row) => {
    refused(
      abi,
      editSpan(abi, row, () => ""),
      true,
    );
  });
  it.each(receipt.abiDonor.declarations)("refuses duplicated actual ABI function $name", (row) => {
    refused(
      abi,
      editSpan(abi, row, (text) => text + "\n" + text),
      true,
    );
  });
  it("refuses changed order of the two actual ABI functions", () => {
    refused(abi, swapped(abi, receipt.abiDonor.declarations[0]!, receipt.abiDonor.declarations[1]!), true);
  });

  it.each(metadataMutations)("refuses stale or caller-altered receipt authority: %s", (_name, mutate) => {
    const copy = JSON.parse(receiptText) as Mutable<typeof receipt>;
    mutate(copy);
    const altered = JSON.stringify(copy, null, 2) + "\n";
    expect(altered).not.toBe(receiptText);
    expect(() => reconstructRuntimeContractReceiptSources(readRuntimeContractActual, altered)).toThrow(
      "receipt digest mismatch",
    );
  });

  it("checks Git blob independently of a correct full SHA256 and byte count", () => {
    const row = receipt.records[0]!,
      text = readRuntimeContractActual(row.path);
    expect(() => assertRuntimeContractSource(text, row.current, row.path)).not.toThrow();
    expect(() => assertRuntimeContractSource(text, { ...row.current, gitBlob: "0".repeat(40) }, row.path)).toThrow(
      "Git blob mismatch",
    );
  });

  it("performs fresh raw authentication after a warmed successful reconstruction", () => {
    let mutated = false;
    const reader = (path: string) => {
      const raw = readRuntimeContractActual(path);
      return mutated && path === abi ? raw + "\n// changed after the previous read\n" : raw;
    };
    expect(reconstructRuntimeContractReceiptSources(reader)).toEqual(restored);
    mutated = true;
    expect(() => reconstructRuntimeContractReceiptSources(reader)).toThrow(
      `complete source SHA256/length mismatch: ${abi}`,
    );
  });

  it.each(changedRecords)("refuses a second normalization of historical $path", (record) => {
    const old = required(record.path);
    expect(old).not.toBe(readRuntimeContractActual(record.path));
    expect(() => beforeRuntimeContractReceiptSource(record.path, old)).toThrow(
      `complete source SHA256/length mismatch: ${record.path}`,
    );
  });

  it("normalizes the exact supplied initial source and authenticates the other 26 owners", () => {
    const calls: string[] = [];
    expect(
      beforeRuntimeContractReceiptSource(abiFacade, readRuntimeContractActual(abiFacade), (path) => {
        calls.push(path);
        return readRuntimeContractActual(path);
      }),
    ).toBe(required(abiFacade));
    expect(calls).toEqual(runtimeContractCurrentPaths.filter((path) => path !== abiFacade));
    expect(() =>
      beforeRuntimeContractReceiptSource(abiFacade, readRuntimeContractActual(abiFacade), changed(abi, "")),
    ).toThrow(`complete source SHA256/length mismatch: ${abi}`);
  });

  it("passes an unknown external path through raw without mapping or other reads", () => {
    const path = "external/unchanged-facade.ts",
      seen: string[] = [];
    expect(
      readRuntimeContractReceiptSource(path, (p) => {
        seen.push(p);
        return "raw external source";
      }),
    ).toBe("raw external source");
    expect(seen).toEqual([path]);
    expect(
      beforeRuntimeContractReceiptSource(path, "provided raw source", () => {
        throw new Error("must not read");
      }),
    ).toBe("provided raw source");
  });

  it("keeps actual compiler inputs raw while the initial historical reader returns the old view", () => {
    const raw = readRuntimeContractActual(contracts);
    expect(raw).toContain("ORDINARY_OBJECT_RUNTIME_FEATURES");
    expect(readRuntimeContractReceiptSource(contracts)).not.toContain("ORDINARY_OBJECT_RUNTIME_FEATURES");
    expect(readRuntimeContractActual(contracts)).toBe(raw);
  });

  it("leaves an injected historical body mutant for the unchanged old owner checks", () => {
    const path = abiFacade,
      original = required(path);
    const mutant = replaceOnce(original, "entries.length !== 1", "entries.length !== 2");
    expect(mutant).not.toBe(original);
    parsed(path, mutant);
    expect(() => callableSourceView((p) => (p === path ? mutant : historical(p)), "pre-vector-clock")).toThrow(
      "current clock/vector owner receipt " + path,
    );
  });
});

// Fresh whole component authentication precedes each explicit source-epoch bridge.
function assertSourceMapValidatorComponent(readLive: (path: string) => string): void {
  const path = "tests/helpers/ir-program-validator-relocation.ts";
  const text = readLive(path);
  if (typeof text !== "string" || text.length === 0)
    throw new Error("program validator relocation: nonempty primitive text required: " + path);
  if (
    Buffer.byteLength(text) !== 46642 ||
    createHash("sha256").update(text).digest("hex") !==
      "6e32ca208775e8eeae765bf3345cdd3cb1e0f40a1784f684afd9c4dff3a4cfe0"
  )
    throw new Error("program validator relocation: complete source pin mismatch: " + path);
}
function beforeProgramValidatorRelocation(readLive: (path: string) => string): (path: string) => string {
  if (typeof readLive !== "function") throw new Error("program validator relocation: physical reader required");
  assertSourceMapValidatorComponent(readLive);
  return beforeSourceMapProgramValidatorRelocation(readLive);
}

// Independently literal current-source association proof; original331 mutation operands stay prior-stage.
const currentContractOwners = [
  {
    path: "src/ir/runtime/contracts/manifest.ts",
    prior: {
      bytes: 28324,
      sha256: "048358db8d8deeee38bb6d49e9fe9be41189441f6b26221733c832f16ce02cd1",
      gitBlob: "a9b945e529e106f61089a29440ae73d114d5d2c0",
    },
    current: {
      bytes: 28981,
      sha256: "0a1eb7cbbc6a1e963ed493f212a4b46ee92b2b3f445083c9d89ff9049c3ed74c",
      gitBlob: "240507b063b36f65b13c8bd3974a2b144832872f",
    },
    edits: [
      {
        beforeOffset: 1470,
        afterOffset: 1470,
        before: "",
        after: "  | NumberRemainderRuntimeFeature\n",
      },
      {
        beforeOffset: 18342,
        afterOffset: 18376,
        before: "",
        after:
          '/** The two existing numeric remainder recipes; not an open symbol family. */\nexport const NUMBER_REMAINDER_RUNTIME_FEATURES = Object.freeze([\n  "js.number.remainder",\n  "js.number.remainder.early-magnitude",\n] as const);\nexport type NumberRemainderRuntimeFeature = (typeof NUMBER_REMAINDER_RUNTIME_FEATURES)[number];\nexport const NUMBER_REMAINDER_RUNTIME_PROVIDER_IDS = Object.freeze([\n  "backend.js.number.remainder",\n  "backend.js.number.remainder.early-magnitude",\n] as const);\nexport type NumberRemainderRuntimeProviderId = (typeof NUMBER_REMAINDER_RUNTIME_PROVIDER_IDS)[number];\n\n',
      },
      {
        beforeOffset: 19019,
        afterOffset: 19639,
        before: "",
        after: "  | NumberRemainderRuntimeProviderId\n",
      },
    ],
  },
  {
    path: "src/ir/runtime/callable-declarations.ts",
    prior: {
      bytes: 5642,
      sha256: "6632f6ecb4221bf31e4cd733b51baf5095a0d7268da1b4f7d0ffa14c8cf27911",
      gitBlob: "81553cf192d6551d7a55b09553ad6cc6ee01e0f8",
    },
    current: {
      bytes: 5949,
      sha256: "9bb4316aea80478bcc21cf5424370a3ce1e393a43201ab156059499b9c0d061f",
      gitBlob: "bd1d3c872f6ca3aa85d2bb30ef36e774ee705ab2",
    },
    edits: [
      {
        beforeOffset: 1087,
        afterOffset: 1087,
        before: "",
        after:
          'import {\n  irNumberRemainderCallableDeclaration,\n  NUMBER_REMAINDER_RUNTIME_PROVIDERS,\n  numberRemainderProviderMismatch,\n} from "./number-remainder-callables.js";\n',
      },
      {
        beforeOffset: 4605,
        afterOffset: 4769,
        before: "",
        after: "        irNumberRemainderCallableDeclaration(ref) ??\n",
      },
      {
        beforeOffset: 4994,
        afterOffset: 5211,
        before: "",
        after: "  ...NUMBER_REMAINDER_RUNTIME_PROVIDERS,\n",
      },
      {
        beforeOffset: 5203,
        afterOffset: 5461,
        before: "    ordinaryObjectProviderMismatch(provider)\n",
        after: "    ordinaryObjectProviderMismatch(provider) ??\n    numberRemainderProviderMismatch(provider)\n",
      },
    ],
  },
  {
    path: "src/ir/runtime/manifest.ts",
    prior: {
      bytes: 104292,
      sha256: "ff36567f298b2ef4946caf7159d9e1647e0e9fdf920296735547dffca15a9ec8",
      gitBlob: "aadd390ab836833d18daff12282ffc2524f598f5",
    },
    current: {
      bytes: 104454,
      sha256: "1c10a56e7255e1db7897d184c7460ad07454252dd0a80176b211dc96918e54e9",
      gitBlob: "f76280d31ba32f6ad30abb2f7ed22397ddb6fd06",
    },
    edits: [
      {
        beforeOffset: 3761,
        afterOffset: 3761,
        before: "",
        after: "  NUMBER_REMAINDER_RUNTIME_FEATURES,\n  NUMBER_REMAINDER_RUNTIME_PROVIDER_IDS,\n",
      },
      {
        beforeOffset: 54395,
        afterOffset: 54473,
        before: "",
        after: "  ...NUMBER_REMAINDER_RUNTIME_FEATURES,\n",
      },
      {
        beforeOffset: 55372,
        afterOffset: 55490,
        before: "",
        after: "  ...NUMBER_REMAINDER_RUNTIME_PROVIDER_IDS,\n",
      },
    ],
  },
] as const;
function currentOwnerPin(source: string, owner: (typeof currentContractOwners)[number]): void {
  expect(Buffer.byteLength(source)).toBe(owner.current.bytes);
  expect(runtimeContractSha256(source)).toBe(owner.current.sha256);
  expect(runtimeContractGitBlob(source)).toBe(owner.current.gitBlob);
}
function independentPriorOwner(source: string, owner: (typeof currentContractOwners)[number]): string {
  currentOwnerPin(source, owner);
  let bytes = Buffer.from(source);
  for (const edit of [...owner.edits].reverse()) {
    const after = Buffer.from(edit.after);
    expect(bytes.subarray(edit.afterOffset, edit.afterOffset + after.length)).toEqual(after);
    bytes = Buffer.concat([
      bytes.subarray(0, edit.afterOffset),
      Buffer.from(edit.before),
      bytes.subarray(edit.afterOffset + after.length),
    ]);
  }
  const prior = bytes.toString("utf8");
  expect(bytes.length).toBe(owner.prior.bytes);
  expect(runtimeContractSha256(prior)).toBe(owner.prior.sha256);
  expect(runtimeContractGitBlob(prior)).toBe(owner.prior.gitBlob);
  for (const edit of [...owner.edits].reverse()) {
    const before = Buffer.from(edit.before);
    expect(bytes.subarray(edit.beforeOffset, edit.beforeOffset + before.length)).toEqual(before);
    bytes = Buffer.concat([
      bytes.subarray(0, edit.beforeOffset),
      Buffer.from(edit.after),
      bytes.subarray(edit.beforeOffset + before.length),
    ]);
  }
  expect(bytes.toString("utf8")).toBe(source);
  return prior;
}
function exactCurrentOutputs(reader: SourceReader): ReadonlyMap<string, string> {
  const outputs = reconstructRemainderRuntimeContractReceiptSources(reader);
  expect([...outputs.keys()]).toEqual(runtimeContractCurrentPaths);
  expect(outputs.size).toBe(27);
  for (const record of receipt.records) {
    const source = outputs.get(record.path)!;
    assertRuntimeContractSource(source, record.target, "current-epoch exact target " + record.path);
  }
  return outputs;
}
describe("finite remainder runtime-contract current interface", () => {
  it("observes all27 ordered supplied reads once and every exact target through the unchanged kernel", () => {
    const actual = prePreparationRead(),
      reads: string[] = [];
    const outputs = exactCurrentOutputs((path) => {
      reads.push(path);
      return actual(path);
    });
    expect(reads).toEqual(runtimeContractCurrentPaths);
    const prior = beforeRemainderRuntimeContractOwners(actual);
    expect(outputs).toEqual(originalReconstructRuntimeContractReceiptSources(prior));
    for (const owner of currentContractOwners) {
      currentOwnerPin(actual(owner.path), owner);
      expect(actual(owner.path)).toBe(originalReadRuntimeContractActual(owner.path));
      expect(prior(owner.path)).not.toBe(actual(owner.path));
    }
  });
  it("rejects invalid receipt before any supplied source observation", () => {
    let reads = 0;
    expect(() =>
      reconstructRemainderRuntimeContractReceiptSources(() => {
        reads++;
        throw new Error("source observed");
      }, "{}"),
    ).toThrow("runtime contract evolution:");
    expect(reads).toBe(0);
  });
  it("preserves zero-read before unknown input and one-read unknown delegation without coercion", () => {
    let reads = 0,
      touched = 0;
    const source = {
      toString() {
        touched++;
        throw new Error("coerced");
      },
    };
    expect(
      beforeRemainderRuntimeContractReceiptSource("unknown", source as unknown as string, () => {
        reads++;
        throw new Error("must not read");
      }),
    ).toBe(source);
    expect(reads).toBe(0);
    expect(touched).toBe(0);
    expect(
      readRemainderRuntimeContractReceiptSource("unknown", (path) => {
        reads++;
        expect(path).toBe("unknown");
        return "raw unknown";
      }),
    ).toBe("raw unknown");
    expect(reads).toBe(1);
  });
  it("keeps original historical source and recipe mutants beyond a valid current association", () => {
    const prior = priorContractRead(),
      canonical = originalReconstructRuntimeContractReceiptSources(prior);
    expect(canonical.size).toBe(27);
    const path = currentContractOwners[0].path;
    expect(() =>
      originalReconstructRuntimeContractReceiptSources((requested) =>
        requested === path ? prior(path) + "\n// prior-stage mutant\n" : prior(requested),
      ),
    ).toThrow("runtime contract evolution: complete source SHA256/length mismatch: " + path);
    const altered = JSON.parse(receiptText) as Mutable<typeof receipt>;
    altered.records[0].current.declarations[0].name += "_mutant";
    expect(() => originalReconstructRuntimeContractReceiptSources(prior, JSON.stringify(altered))).toThrow(
      "runtime contract evolution:",
    );
    const spy = vi.spyOn(unchangedKernel, "reconstructRuntimeContractReceiptSources");
    try {
      exactCurrentOutputs(prePreparationRead());
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
  for (const owner of currentContractOwners) {
    it(`derives exact prior and reciprocal current ${owner.path} without changing live raw input`, () => {
      const actual = prePreparationRead();
      const current = actual(owner.path),
        prior = independentPriorOwner(current, owner);
      expect(beforeRemainderRuntimeContractOwners(actual)(owner.path)).toBe(prior);
      expect(actual(owner.path)).toBe(originalReadRuntimeContractActual(owner.path));
      const reads: string[] = [];
      const target = beforeRemainderRuntimeContractReceiptSource(owner.path, current, (path) => {
        reads.push(path);
        return actual(path);
      });
      expect(reads).toEqual(runtimeContractCurrentPaths.filter((path) => path !== owner.path));
      expect(reads).toHaveLength(26);
      expect(target).toBe(
        originalReconstructRuntimeContractReceiptSources(beforeRemainderRuntimeContractOwners(actual)).get(owner.path),
      );
      expect(readRemainderRuntimeContractReceiptSource(owner.path, actual)).toBe(target);
    });
    it(`refuses exact prior source as current ${owner.path}`, () => {
      const actual = prePreparationRead(),
        prior = independentPriorOwner(actual(owner.path), owner);
      expect(() => beforeRemainderRuntimeContractReceiptSource(owner.path, prior, actual)).toThrow(
        "complete source SHA256/length/Git blob mismatch: " + owner.path,
      );
      exactCurrentOutputs(actual);
    });
    for (const kind of ["missing", "undefined", "empty", "object"] as const) {
      it(`refuses supplied ${kind} current ${owner.path} without coercion`, () => {
        const actual = prePreparationRead();
        let touched = 0;
        const marker = new Error("missing supplied current " + owner.path);
        const bad =
          kind === "empty"
            ? ""
            : kind === "undefined"
              ? undefined
              : {
                  toString() {
                    touched++;
                    throw marker;
                  },
                  valueOf() {
                    touched++;
                    throw marker;
                  },
                };
        if (kind === "missing") {
          let caught: unknown;
          try {
            reconstructRemainderRuntimeContractReceiptSources((path) => {
              if (path === owner.path) throw marker;
              return actual(path);
            });
          } catch (error) {
            caught = error;
          }
          expect(caught).toBe(marker);
        } else
          expect(() =>
            beforeRemainderRuntimeContractReceiptSource(owner.path, bad as unknown as string, actual),
          ).toThrow("missing nonempty primitive source: " + owner.path);
        expect(touched).toBe(0);
        exactCurrentOutputs(actual);
      });
    }
    for (const kind of [
      "changed addition",
      "deleted addition",
      "duplicated addition",
      "reordered additions",
      "unrelated body byte",
      "wrong owner",
      "appended",
      "truncated",
    ] as const) {
      it(`refuses ${kind} in actual current ${owner.path}`, () => {
        const actual = prePreparationRead(),
          source = actual(owner.path),
          bytes = Buffer.from(source),
          first = owner.edits[0],
          second = owner.edits[1];
        const firstAfter = Buffer.from(first.after),
          secondAfter = Buffer.from(second.after);
        expect(bytes.subarray(first.afterOffset, first.afterOffset + firstAfter.length)).toEqual(firstAfter);
        expect(bytes.subarray(second.afterOffset, second.afterOffset + secondAfter.length)).toEqual(secondAfter);
        let mutant: string;
        if (kind === "changed addition") {
          const changed = Buffer.from(bytes);
          changed[first.afterOffset] = changed[first.afterOffset] === 120 ? 121 : 120;
          mutant = changed.toString("utf8");
        } else if (kind === "deleted addition")
          mutant = Buffer.concat([
            bytes.subarray(0, first.afterOffset),
            bytes.subarray(first.afterOffset + firstAfter.length),
          ]).toString("utf8");
        else if (kind === "duplicated addition")
          mutant = Buffer.concat([
            bytes.subarray(0, first.afterOffset),
            firstAfter,
            bytes.subarray(first.afterOffset),
          ]).toString("utf8");
        else if (kind === "reordered additions")
          mutant = Buffer.concat([
            bytes.subarray(0, first.afterOffset),
            secondAfter,
            bytes.subarray(first.afterOffset + firstAfter.length, second.afterOffset),
            firstAfter,
            bytes.subarray(second.afterOffset + secondAfter.length),
          ]).toString("utf8");
        else if (kind === "unrelated body byte") mutant = source.replace("Copyright", "Copywrong");
        else if (kind === "wrong owner")
          mutant = actual(currentContractOwners.find((entry) => entry.path !== owner.path)!.path);
        else if (kind === "appended") mutant = source + "\n";
        else mutant = source.slice(0, -1);
        expect(mutant).not.toBe(source);
        expect(() => beforeRemainderRuntimeContractReceiptSource(owner.path, mutant, actual)).toThrow(
          "complete source SHA256/length/Git blob mismatch: " + owner.path,
        );
        exactCurrentOutputs(actual);
      });
    }
    it(`freshly captures changed and restored current ${owner.path} after success`, () => {
      const actual = prePreparationRead();
      let supplied = actual(owner.path);
      const reader = (path: string) => (path === owner.path ? supplied : actual(path));
      const lazy = beforeRemainderRuntimeContractOwners(reader);
      const prior = lazy(owner.path);
      exactCurrentOutputs(reader);
      supplied += "\n// after current success\n";
      expect(() => lazy(owner.path)).toThrow("complete source SHA256/length/Git blob mismatch: " + owner.path);
      expect(() => reconstructRemainderRuntimeContractReceiptSources(reader)).toThrow(
        "complete source SHA256/length/Git blob mismatch: " + owner.path,
      );
      supplied = actual(owner.path);
      expect(lazy(owner.path)).toBe(prior);
      exactCurrentOutputs(reader);
    });
  }
});
