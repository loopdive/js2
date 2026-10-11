// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";
import {
  assertIrValidationAnalysisReceiptStructure,
  assertIrValidationAnalysisSource,
  authenticateIrValidationAnalysisRelocation,
  beforeIrValidationAnalysisRelocation,
  irValidationAnalysisCurrentPaths,
  irValidationAnalysisGitBlob,
  irValidationAnalysisOriginalPaths,
  irValidationAnalysisReceiptPath,
  irValidationAnalysisSha256,
  readBeforeIrValidationAnalysisRelocation,
  readIrValidationAnalysisActual,
  reconstructIrValidationAnalysisSources,
  type IrValidationAnalysisRelocationReceipt,
} from "./helpers/ir-validation-analysis-relocation.js";

const receiptText = readIrValidationAnalysisActual(irValidationAnalysisReceiptPath);
const receipt = authenticateIrValidationAnalysisRelocation(receiptText);
type Mutable<T> = T extends readonly (infer E)[]
  ? Mutable<E>[]
  : T extends object
    ? { -readonly [P in keyof T]: Mutable<T[P]> }
    : T;
type Draft = Mutable<IrValidationAnalysisRelocationReceipt>;
const draft = (): Draft => JSON.parse(receiptText) as Draft;
const runtimePath = "src/ir/runtime/verify.ts";
const allocationPath = "src/ir/analysis/alloc-verification.ts";

afterEach(async () => {
  await setImmediate();
});

function positive() {
  const result = reconstructIrValidationAnalysisSources();
  expect([...result.keys()]).toEqual(irValidationAnalysisOriginalPaths);
  for (const record of receipt.originals)
    assertIrValidationAnalysisSource(result.get(record.path)!, record, record.path);
  return result;
}
function changed(path: string, source: string) {
  return (requested: string) => (requested === path ? source : readIrValidationAnalysisActual(requested));
}
function bytes(source: string, start: number, end: number): string {
  return Buffer.from(source).subarray(start, end).toString("utf8");
}
function replaceBytes(source: string, start: number, end: number, replacement: string): string {
  const data = Buffer.from(source);
  return Buffer.concat([data.subarray(0, start), Buffer.from(replacement), data.subarray(end)]).toString("utf8");
}
function replaceOnce(source: string, from: string, to: string): string {
  const index = source.indexOf(from);
  if (index < 0 || source.indexOf(from, index + 1) >= 0)
    throw new Error(`mutation span is absent or repeated: ${from}`);
  return source.slice(0, index) + to + source.slice(index + from.length);
}
function declaration(path: string, name: string) {
  const found = receipt.current.find((r) => r.path === path)?.declarations.filter((d) => d.name === name);
  if (found?.length !== 1) throw new Error(`expected one current declaration ${path}/${name}`);
  return found[0]!;
}
function editDeclaration(path: string, name: string, edit: (source: string) => string): string {
  const source = readIrValidationAnalysisActual(path),
    d = declaration(path, name);
  const original = bytes(source, d.startByte, d.endByte),
    replacement = edit(original);
  if (replacement === original) throw new Error("declaration mutation did not alter bytes");
  return replaceBytes(source, d.startByte, d.endByte, replacement);
}
function reorder(path: string, left: string, right: string): string {
  const source = readIrValidationAnalysisActual(path),
    a = declaration(path, left),
    b = declaration(path, right);
  if (a.endByte > b.startByte) throw new Error("declarations are not in the expected original order");
  return replaceBytes(
    source,
    a.startByte,
    b.endByte,
    bytes(source, b.startByte, b.endByte) +
      bytes(source, a.endByte, b.startByte) +
      bytes(source, a.startByte, a.endByte),
  );
}

const mutations: readonly [string, string, () => string][] = [
  [
    "renamed public declaration",
    runtimePath,
    () =>
      editDeclaration(runtimePath, "verifyIrFunction", (s) =>
        replaceOnce(s, "export function verifyIrFunction(", "export function changedVerifier("),
      ),
  ],
  ["deleted moved body", allocationPath, () => editDeclaration(allocationPath, "assertFinalAllocProvenance", () => "")],
  ["duplicated private body", allocationPath, () => editDeclaration(allocationPath, "checkId", (s) => `${s}\n${s}`)],
  [
    "reordered private declarations",
    allocationPath,
    () => reorder(allocationPath, "checkId", "assertFinalAllocProvenance"),
  ],
  [
    "changed full verifier body",
    runtimePath,
    () =>
      editDeclaration(runtimePath, "verifyIrFunction", (s) =>
        replaceOnce(s, "const defs = new Set<IrValueId>();", "const defs = new Set<IrValueId>([0 as IrValueId]);"),
      ),
  ],
  [
    "changed moved documentation",
    runtimePath,
    () =>
      replaceOnce(
        readIrValidationAnalysisActual(runtimePath),
        "IR invariant verifier — validates",
        "Changed verifier — validates",
      ),
  ],
  [
    "changed readonly public option",
    runtimePath,
    () =>
      editDeclaration(runtimePath, "IrVerificationOptions", (s) =>
        replaceOnce(s, "readonly verifyDominanceNaive", "verifyDominanceNaive"),
      ),
  ],
  [
    "changed optional declared-table API",
    runtimePath,
    () =>
      editDeclaration(runtimePath, "verifyIrFunction", (s) =>
        replaceOnce(s, "declarations?: IrModuleDeclarations", "declarations: IrModuleDeclarations"),
      ),
  ],
  [
    "erased PreparedIrFunction type owner",
    runtimePath,
    () =>
      replaceOnce(
        readIrValidationAnalysisActual(runtimePath),
        "PreparedIrFunction as IrFunction",
        "IrFunction as IrFunction",
      ),
  ],
  [
    "changed private dominance cache initializer",
    "src/ir/analysis/dominance.ts",
    () => editDeclaration("src/ir/analysis/dominance.ts", "cache", (s) => replaceOnce(s, "new WeakMap", "new Map")),
  ],
  [
    "changed retained debug-flag body",
    "src/ir/verify-alloc.ts",
    () =>
      editDeclaration("src/ir/verify-alloc.ts", "allocVerifyEnabled", (s) => replaceOnce(s, '=== "true"', '=== "yes"')),
  ],
  [
    "changed canonical delegate alias",
    "src/ir/verify-alloc.ts",
    () =>
      replaceOnce(
        readIrValidationAnalysisActual("src/ir/verify-alloc.ts"),
        "as assertVerifiedAllocProvenance",
        "as replacementAssertion",
      ),
  ],
  [
    "changed allocation kind table",
    allocationPath,
    () =>
      editDeclaration(allocationPath, "ALLOC_INSTR_KIND", (s) =>
        replaceOnce(s, '"string.const": "string"', '"string.const": "object"'),
      ),
  ],
  [
    "removed readonly error field",
    allocationPath,
    () => editDeclaration(allocationPath, "AllocVerifyError", (s) => replaceOnce(s, "readonly message", "message")),
  ],
  [
    "changed live import into type-only import",
    "src/ir/program/allocations.ts",
    () =>
      replaceOnce(
        readIrValidationAnalysisActual("src/ir/program/allocations.ts"),
        "import { AllocSiteRegistry, ALLOC_NAMESPACES }",
        "import type { AllocSiteRegistry, ALLOC_NAMESPACES }",
      ),
  ],
  [
    "changed analysis dependency authority",
    "src/ir/analysis/ownership.ts",
    () =>
      replaceOnce(
        readIrValidationAnalysisActual("src/ir/analysis/ownership.ts"),
        'import { ALLOC_NAMESPACES } from "./alloc-registry.js";',
        'import { ALLOC_NAMESPACES } from "../alloc-registry.js";',
      ),
  ],
  [
    "inserted verifier overload",
    runtimePath,
    () =>
      editDeclaration(
        runtimePath,
        "verifyIrFunction",
        (s) => `export function verifyIrFunction(value: unknown): never;\n${s}`,
      ),
  ],
  [
    "wildcard compatibility forwarding",
    "src/ir/program-class-layouts.ts",
    () =>
      replaceOnce(
        readIrValidationAnalysisActual("src/ir/program-class-layouts.ts"),
        "export { assertPreparedIrClassLayouts }",
        "export *",
      ),
  ],
  [
    "duplicate compatibility forwarding",
    "src/ir/program-allocations.ts",
    () => {
      const s = readIrValidationAnalysisActual("src/ir/program-allocations.ts");
      return s + s.slice(s.indexOf("export {"));
    },
  ],
  [
    "unaccounted executable top-level statement",
    runtimePath,
    () => `${readIrValidationAnalysisActual(runtimePath)}\nvoid 0;\n`,
  ],
  [
    "shifted full source",
    "src/ir/analysis/encoding.ts",
    () => `\n${readIrValidationAnalysisActual("src/ir/analysis/encoding.ts")}`,
  ],
  [
    "changed unchanged-lattice documentation",
    "src/ir/analysis/lattice.ts",
    () =>
      replaceOnce(
        readIrValidationAnalysisActual("src/ir/analysis/lattice.ts"),
        "Ownership + access lattices",
        "Changed ownership lattices",
      ),
  ],
];

const metadataMutations: readonly [string, (value: Draft) => void][] = [
  [
    "schema",
    (r) => {
      r.schema++;
    },
  ],
  [
    "base revision",
    (r) => {
      r.base = "wrong";
    },
  ],
  [
    "freeze provenance",
    (r) => {
      r.freezeManifestSha256 = "0".repeat(64);
    },
  ],
  [
    "unearned committed provenance",
    (r) => {
      r.candidateProvenance = "landed on main";
    },
  ],
  [
    "prior full-source hash",
    (r) => {
      r.originals[0]!.sha256 = "0".repeat(64);
    },
  ],
  [
    "prior full-source Git blob",
    (r) => {
      r.originals[0]!.gitBlob = "0".repeat(40);
    },
  ],
  [
    "current full-source hash",
    (r) => {
      r.current[0]!.sha256 = "0".repeat(64);
    },
  ],
  [
    "wrong current owner path",
    (r) => {
      r.current[0]!.path = "src/ir/unreviewed.ts";
    },
  ],
  [
    "missing mandatory current owner",
    (r) => {
      r.current.pop();
    },
  ],
  [
    "extra owner",
    (r) => {
      r.current.push(r.current[0]!);
    },
  ],
  [
    "missing declaration transfer",
    (r) => {
      r.transfers.pop();
    },
  ],
  [
    "duplicate transfer identity",
    (r) => {
      r.transfers[1]!.id = 0;
    },
  ],
  [
    "unapproved private body change",
    (r) => {
      r.transfers[0]!.current.sha256 = "0".repeat(64);
    },
  ],
  [
    "unexpected wrapper body rewrite",
    (r) => {
      r.retainedWrapperNames.reverse();
    },
  ],
  [
    "extra type import edit",
    (r) => {
      r.inlineTypeImportChangeCount++;
    },
  ],
  [
    "wrong ImportType qualifier",
    (r) => {
      const t = r.transfers.find((t) => t.inlineImports.length)!;
      t.inlineImports[0]!.current.qualifier = "IrClassShape";
    },
  ],
  [
    "wrong ImportType owner",
    (r) => {
      const t = r.transfers.find((t) => t.inlineImports.length)!;
      t.inlineImports[0]!.current.module = "../nodes.js";
    },
  ],
  [
    "shifted reciprocal ImportType offset",
    (r) => {
      const t = r.transfers.find((t) => t.inlineImports.length)!;
      t.inlineImports[0]!.current.startByte++;
    },
  ],
  [
    "reordered source recipe",
    (r) => {
      r.current[0]!.recipe.reverse();
    },
  ],
];

const recipeFaults: readonly [string, (value: Draft) => void][] = [
  [
    "nonexistent transfer",
    (r) => {
      r.originals[0]!.recipe[1] = { transfer: 999 };
    },
  ],
  [
    "declaration owner mismatch",
    (r) => {
      r.transfers[0]!.current.path = allocationPath;
    },
  ],
  [
    "reciprocal transfer order",
    (r) => {
      const row = r.current[0]!;
      const ids = row.recipe.flatMap((p, i) => ("transfer" in p ? [i] : []));
      [row.recipe[ids[0]!]!, row.recipe[ids[1]!]!] = [row.recipe[ids[1]!]!, row.recipe[ids[0]!]!];
    },
  ],
  [
    "reciprocal declaration offset",
    (r) => {
      const t = r.transfers[0]!,
        row = r.current.find((p) => p.path === t.current.path)!;
      for (const d of [t.current, row.declarations[t.current.ordinal]!]) {
        d.startByte++;
        d.endByte++;
        d.statementStartByte++;
      }
    },
  ],
  [
    "omitted facade replay",
    (r) => {
      r.current.find((p) => p.path === "src/ir/verify.ts")!.recipe = [];
    },
  ],
  [
    "executable literal",
    (r) => {
      r.current[0]!.recipe.unshift({ literal: "const unreviewed = 1;\n" });
    },
  ],
  [
    "type declaration literal",
    (r) => {
      r.current[0]!.recipe.unshift({ literal: "type Unreviewed = string;\n" });
    },
  ],
];

// Independent forward replay in the test uses only the helper's returned exact
// originals, fixed non-executable scaffolding and the seven pinned import tokens.
function forwardSource(record: (typeof receipt.current)[number], originals: ReadonlyMap<string, string>): string {
  return record.recipe
    .map((piece) => {
      if ("literal" in piece) return piece.literal;
      const t = receipt.transfers[piece.transfer]!,
        before = originals.get(t.before.path);
      if (before === undefined) throw new Error("missing reconstructed original");
      let source = bytes(before, t.before.startByte, t.before.endByte);
      for (const edit of [...t.inlineImports].reverse()) {
        const current = bytes(source, edit.before.startByte, edit.before.endByte);
        expect(current).toBe(JSON.stringify(edit.before.module));
        source = replaceBytes(source, edit.before.startByte, edit.before.endByte, JSON.stringify(edit.current.module));
      }
      return source;
    })
    .join("");
}

describe("Phase B complete live validation/analysis preservation", () => {
  it.each(receipt.originals)("reconstructs exact original $path from live owners", (record) => {
    const text = readBeforeIrValidationAnalysisRelocation(record.path);
    expect(irValidationAnalysisSha256(text)).toBe(record.sha256);
    expect(irValidationAnalysisGitBlob(text)).toBe(record.gitBlob);
    expect(Buffer.byteLength(text)).toBe(record.bytes);
    if (record.path === "src/ir/analysis/lattice.ts") expect(text).toBe(readIrValidationAnalysisActual(record.path));
    else expect(text).not.toBe(readIrValidationAnalysisActual(record.path));
  });

  it("accounts for all 135 bodies/types and reproduces all thirteen complete current sources", () => {
    const originals = positive();
    expect(receipt.originals).toHaveLength(9);
    expect(receipt.current).toHaveLength(13);
    expect(receipt.transfers).toHaveLength(135);
    expect(receipt.transfers.filter((t) => t.before.path !== t.current.path)).toHaveLength(67);
    expect(receipt.transfers.flatMap((t) => t.inlineImports)).toHaveLength(7);
    for (const record of receipt.current) {
      const replayed = forwardSource(record, originals);
      expect(replayed).toBe(readIrValidationAnalysisActual(record.path));
      assertIrValidationAnalysisSource(replayed, record, `independent forward ${record.path}`);
    }
    const wrappers = receipt.transfers.filter((t) => receipt.retainedWrapperNames.includes(t.before.name));
    expect(wrappers).toHaveLength(2);
    for (const wrapper of wrappers) {
      expect(wrapper.inlineImports).toEqual([]);
      expect(wrapper.current.sha256).toBe(wrapper.before.sha256);
      expect(wrapper.current.path).toBe("src/ir/verify-alloc.ts");
    }
  });

  it("stores no executable declaration or body in literal recipes", () => {
    const pieces = [...receipt.originals, ...receipt.current].flatMap((r) =>
      r.recipe.flatMap((p) => ("literal" in p ? [p.literal] : [])),
    );
    expect(pieces.length).toBeGreaterThan(0);
    for (const source of pieces) {
      const parsed = ts.createSourceFile("scaffold.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      expect(parsed.statements.every((s) => ts.isImportDeclaration(s) || ts.isExportDeclaration(s))).toBe(true);
    }
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.transfers[0]!.current)).toBe(true);
  });

  it("captures each dependency and fixed receipt exactly once per operation, including a fresh later operation", () => {
    const counts = new Map<string, number>();
    const reader = (path: string) => {
      counts.set(path, (counts.get(path) ?? 0) + 1);
      return readIrValidationAnalysisActual(path);
    };
    const paths = [irValidationAnalysisReceiptPath, ...irValidationAnalysisCurrentPaths];
    reconstructIrValidationAnalysisSources(reader);
    expect([...counts.keys()]).toEqual(paths);
    expect([...counts.values()]).toEqual(paths.map(() => 1));
    reconstructIrValidationAnalysisSources(reader);
    expect([...counts.values()]).toEqual(paths.map(() => 2));
  });

  it("normalizes only an initial supplied raw donor and leaves unknown paths raw", () => {
    const path = "src/ir/verify.ts",
      raw = readIrValidationAnalysisActual(path);
    const expected = readBeforeIrValidationAnalysisRelocation(path);
    const reader = (requested: string) => {
      if (requested === path) throw new Error("must use the provided original raw read");
      return readIrValidationAnalysisActual(requested);
    };
    expect(beforeIrValidationAnalysisRelocation(path, raw, reader)).toBe(expected);
    const calls: string[] = [],
      passthrough = (requested: string) => {
        calls.push(requested);
        return `raw:${requested}`;
      };
    expect(readBeforeIrValidationAnalysisRelocation("unknown.ts", passthrough)).toBe("raw:unknown.ts");
    expect(readBeforeIrValidationAnalysisRelocation(runtimePath, passthrough)).toBe(`raw:${runtimePath}`);
    expect(beforeIrValidationAnalysisRelocation("unknown.ts", "already raw", passthrough)).toBe("already raw");
    expect(calls).toEqual(["unknown.ts", runtimePath]);
  });

  it.each(receipt.originals.filter((r) => r.path !== "src/ir/analysis/lattice.ts"))(
    "refuses to normalize historical $path twice",
    (record) => {
      const historical = readBeforeIrValidationAnalysisRelocation(record.path);
      expect(historical).not.toBe(readIrValidationAnalysisActual(record.path));
      expect(() => beforeIrValidationAnalysisRelocation(record.path, historical)).toThrow(/SHA256\/length mismatch/);
    },
  );

  it.each(receipt.current)("requires actual dependency $path", (record) => {
    positive();
    expect(() =>
      reconstructIrValidationAnalysisSources((path) => {
        if (path === record.path) throw new Error(`missing owner: ${path}`);
        return readIrValidationAnalysisActual(path);
      }),
    ).toThrow(`missing owner: ${record.path}`);
  });

  it.each(receipt.current)("rejects changed $path after a warmed successful read", (record) => {
    let mutation: string | undefined;
    const reader = (path: string) =>
      path === record.path && mutation !== undefined ? mutation : readIrValidationAnalysisActual(path);
    reconstructIrValidationAnalysisSources(reader);
    mutation = readIrValidationAnalysisActual(record.path) + "\n// changed after previous proof\n";
    expect(() => reconstructIrValidationAnalysisSources(reader)).toThrow(/SHA256\/length mismatch/);
    mutation = undefined;
    expect([...reconstructIrValidationAnalysisSources(reader).keys()]).toEqual(irValidationAnalysisOriginalPaths);
  });

  it("refuses another genuine file substituted for a required raw owner", () => {
    positive();
    const other = readIrValidationAnalysisActual(allocationPath);
    expect(other).not.toBe(readIrValidationAnalysisActual(runtimePath));
    expect(() => reconstructIrValidationAnalysisSources(changed(runtimePath, other))).toThrow(
      /SHA256\/length mismatch/,
    );
  });

  it.each(receipt.current)("independently checks length, SHA256 and Git blob for $path", (record) => {
    const source = readIrValidationAnalysisActual(record.path);
    expect(() => assertIrValidationAnalysisSource(source, record, record.path)).not.toThrow();
    expect(() => assertIrValidationAnalysisSource(source, { ...record, bytes: record.bytes + 1 }, record.path)).toThrow(
      /SHA256\/length mismatch/,
    );
    expect(() => assertIrValidationAnalysisSource(source, { ...record, sha256: "0".repeat(64) }, record.path)).toThrow(
      /SHA256\/length mismatch/,
    );
    expect(() => assertIrValidationAnalysisSource(source, { ...record, gitBlob: "0".repeat(40) }, record.path)).toThrow(
      /Git blob mismatch/,
    );
  });

  it.each(mutations)("refuses actual current-source mutation: %s", (_label, path, change) => {
    positive();
    const original = readIrValidationAnalysisActual(path),
      mutation = change();
    expect(mutation).not.toBe(original);
    expect(() => reconstructIrValidationAnalysisSources(changed(path, mutation))).toThrow(/SHA256\/length mismatch/);
  });

  it.each(
    receipt.transfers.flatMap((t) => t.inlineImports.map((edit) => ({ name: t.before.name, transfer: t, edit }))),
  )("refuses changed live ImportType token in $name", ({ transfer, edit }) => {
    positive();
    const source = readIrValidationAnalysisActual(transfer.current.path);
    const start = transfer.current.startByte + edit.current.startByte,
      end = transfer.current.startByte + edit.current.endByte;
    expect(bytes(source, start, end)).toBe(JSON.stringify(edit.current.module));
    const mutation = replaceBytes(source, start, end, JSON.stringify(edit.before.module));
    expect(mutation).not.toBe(source);
    expect(() => reconstructIrValidationAnalysisSources(changed(transfer.current.path, mutation))).toThrow(
      /SHA256\/length mismatch/,
    );
  });

  it.each(metadataMutations)("refuses modified receipt authority: %s", (_label, mutate) => {
    expect(authenticateIrValidationAnalysisRelocation(receiptText).transfers).toHaveLength(135);
    const value = draft();
    mutate(value);
    const altered = JSON.stringify(value);
    expect(altered).not.toBe(JSON.stringify(receipt));
    // This deliberately tests the outer immutable receipt authority, not an
    // assertion that these changed metadata reach deeper reconstruction code.
    expect(() => authenticateIrValidationAnalysisRelocation(altered)).toThrow("fixed receipt digest mismatch");
    expect(() => reconstructIrValidationAnalysisSources(changed(irValidationAnalysisReceiptPath, altered))).toThrow(
      "fixed receipt digest mismatch",
    );
  });

  it.each(recipeFaults)("also rejects structural reciprocal recipe fault: %s", (_label, mutate) => {
    expect(() => assertIrValidationAnalysisReceiptStructure(receipt)).not.toThrow();
    const value = draft();
    mutate(value);
    expect(JSON.stringify(value)).not.toBe(JSON.stringify(receipt));
    // The same void diagnostic used inside authenticated reads; passing this
    // guard never grants access to a caller-supplied reconstruction recipe.
    expect(() => assertIrValidationAnalysisReceiptStructure(value)).toThrow(/validation analysis relocation:/);
  });
});
