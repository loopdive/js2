// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  acceptedHistoricalDeclarations,
  assertNamedForward,
  currentDeclarations,
  historicalIntrinsicSource,
  liveSourceReader,
  parseLive,
  type SourceReader,
} from "./helpers/ir-historical-runtime-reconstruction.js";

const read = liveSourceReader(resolve(import.meta.dirname, ".."));
const contract = "src/ir/runtime/contracts/intrinsics.ts";
const core = "src/ir/core/intrinsic-contracts.ts";
const intrinsic = "src/ir/core/intrinsics.ts";
const semantic = "src/ir/analysis/intrinsics.ts";
const verifier = "src/ir/runtime/intrinsic-verification.ts";
const support = "src/ir/intrinsic-support.ts";
const manifest = "src/ir/runtime/manifest.ts";
const attachment = "src/ir/runtime/async-attachment.ts";

function mutation(path: string, edit: (text: string) => string): SourceReader {
  const before = read(path),
    after = edit(before);
  expect(after, "control must actually alter " + path).not.toBe(before);
  return (file) => (file === path ? after : read(file));
}

function declarationMutation(
  path: string,
  name: string,
  change: "missing" | "renamed" | "duplicate" | "reorder",
  ordinal = 0,
): SourceReader {
  const rows = currentDeclarations(path, read);
  const at = rows.findIndex((row) => row.name === name && row.ordinal === ordinal);
  expect(at).toBeGreaterThanOrEqual(0);
  const { node, file } = rows[at]!;
  return mutation(path, (text) => {
    if (change === "missing") return text.slice(0, node.getFullStart()) + text.slice(node.end);
    if (change === "duplicate") return text + "\n" + node.getFullText(file);
    if (change === "renamed")
      return text.slice(0, node.getStart()) + node.getText(file).replace(name, "Renamed" + name) + text.slice(node.end);
    const next = rows[at + 1]!.node;
    return text.slice(0, node.getFullStart()) + next.getFullText(file) + node.getFullText(file) + text.slice(next.end);
  });
}

describe("historical runtime receipts reconstructed strictly from mandatory live sources", () => {
  it.each([
    [contract, 20, 0],
    ["src/ir/async-runtime-providers.ts", 26, 12],
    ["src/ir/runtime-manifest.ts", 85, 38],
    ["src/ir/intrinsics.ts", 24, 5],
    ["src/ir/async-plan.ts", 48, 39],
    [support, 41, 24],
  ] as const)("accepts original unchanged receipt %s (%i declarations/%i functions)", (path, count, functions) => {
    const rows = acceptedHistoricalDeclarations(path, read);
    expect(rows).toHaveLength(count);
    expect(rows.filter((row) => row.kind === "function")).toHaveLength(functions);
    expect(new Set(rows.map((row) => [row.path, row.kind, row.name, row.ordinal].join("#"))).size).toBe(count);
  });

  it("retains the three overload records with their individual source-qualified ordinals", () => {
    const rows = acceptedHistoricalDeclarations(support, read).filter((row) => row.name === "prepareIrRuntimeManifest");
    expect(rows.map(({ path, kind, ordinal }) => [path, kind, ordinal])).toEqual([
      [support, "function", 0],
      [support, "function", 1],
      [support, "function", 2],
    ]);
    expect(rows.map(({ node }) => ts.isFunctionDeclaration(node) && Boolean(node.body))).toEqual([false, false, true]);
  });

  it("rebases exactly the two live core imports without putting core contracts into historical graph population", () => {
    const source = historicalIntrinsicSource(read);
    const file = parseLive(contract, () => source);
    expect(file.statements.filter(ts.isImportDeclaration).map((node) => node.getText())).toEqual([
      'import type { IntrinsicId, IntrinsicSignatureVersion } from "../../core/intrinsic-vocabulary.js";',
      'import type { IrType } from "../../core/types.js";',
    ]);
    expect(file.statements.filter(ts.isExportDeclaration)).toHaveLength(0);
    expect(source).not.toContain("intrinsic-contracts.js");
    expect(source).not.toContain("CoreIntrinsicDefinition");
  });

  it.each(["missing", "renamed", "duplicate", "reorder"] as const)(
    "rejects a %s live core declaration before producing a fixture",
    (change) => {
      expect(() => historicalIntrinsicSource(declarationMutation(core, "IntrinsicSignature", change))).toThrow();
    },
  );

  it.each([0, 1, 2])("rejects deletion of overload occurrence %i", (ordinal) => {
    expect(() =>
      acceptedHistoricalDeclarations(
        support,
        declarationMutation(support, "prepareIrRuntimeManifest", "missing", ordinal),
      ),
    ).toThrow();
  });

  it.each(["renamed", "duplicate"] as const)("rejects a %s overload", (change) => {
    expect(() =>
      acceptedHistoricalDeclarations(support, declarationMutation(support, "prepareIrRuntimeManifest", change, 1)),
    ).toThrow();
  });

  it.each([
    [core, "Feature extends string", "Feature extends number"],
    [core, "readonly feature: Feature;", "feature: Feature;"],
    [core, "readonly feature: Feature;", ""],
    [core, "readonly id: IntrinsicId;", "readonly id?: IntrinsicId;"],
    [core, "readonly column: number;", "readonly column: string;"],
    [contract, "CoreIntrinsicDefinition<RuntimeFeature>", "CoreIntrinsicDefinition<string>"],
    [contract, "Provider requirements reachable", "Changed provider documentation reachable"],
    [contract, "IntrinsicDefinition as CoreIntrinsicDefinition", "IntrinsicUse as CoreIntrinsicDefinition"],
    [contract, "../../core/intrinsic-contracts.js", "../../core/wrong-contracts.js"],
    [core, "./types.js", "./wrong-types.js"],
    [core, "IntrinsicId, IntrinsicSignatureVersion", "IntrinsicId, WrongVersion"],
  ])("rejects live contract change %s: %s", (path, before, after) => {
    expect(() => historicalIntrinsicSource(mutation(path!, (text) => text.replaceAll(before!, after!)))).toThrow();
  });

  it.each([core, contract])("rejects forbidden extra imports, exports and syntax in %s", (path) => {
    for (const extra of [
      '\nimport type { Program } from "../../program.js";',
      '\nexport type { Extra } from "../../program.js";',
      '\nimport extra = require("../../program.js");',
      "\nconst extra = import(globalThis.toString());",
      "\nexport interface Malformed {",
    ])
      expect(() => historicalIntrinsicSource(mutation(path, (text) => text + extra))).toThrow();
  });

  it("fails when mandatory core contracts are absent even though the historical fixture does not copy that module", () => {
    const missing: SourceReader = (path) => {
      if (path === core) throw new Error("missing mandatory current core contract");
      return read(path);
    };
    expect(() => historicalIntrinsicSource(missing)).toThrow(/missing mandatory/);
  });

  it.each([
    [
      intrinsic,
      '"math.sin": definition("math.sin", F64_UNARY_INTRINSIC_SIGNATURE)',
      '"math.sin": definition("math.cos", F64_UNARY_INTRINSIC_SIGNATURE)',
      "src/ir/intrinsics.ts",
    ],
    [intrinsic, "Record typing makes an added ID fail closed.", "Changed table documentation.", "src/ir/intrinsics.ts"],
    [
      intrinsic,
      "return Object.freeze({ id, signature, feature });",
      "return { id, signature, feature };",
      "src/ir/intrinsics.ts",
    ],
    [intrinsic, "function definition(", "function* definition(", "src/ir/intrinsics.ts"],
    [manifest, '#state: BuilderState = "open"', '#state: BuilderState = "failed"', "src/ir/runtime-manifest.ts"],
    [manifest, 'this.#state = "building";', 'this.#state = "failed";', "src/ir/runtime-manifest.ts"],
    [attachment, "if (!previous) preparedManifestByPlan.delete(input.plan);", "", "src/ir/async-plan.ts"],
    ["src/ir/intrinsics.ts", "= canonicalIntrinsicDefinitions;", "= {} as never;", "src/ir/intrinsics.ts"],
  ])("rejects changed initializer/body/private field/documentation in %s", (path, before, after, historical) => {
    expect(() =>
      acceptedHistoricalDeclarations(
        historical!,
        mutation(path!, (text) => text.replace(before!, after!)),
      ),
    ).toThrow();
  });

  it.each([
    [semantic, "export function verifyIrIntrinsicSignature", "export async function verifyIrIntrinsicSignature"],
    [semantic, "export function verifyIrIntrinsicSignature", "export function* verifyIrIntrinsicSignature"],
    [semantic, "export function verifyIrIntrinsicSignature", "function verifyIrIntrinsicSignature"],
    [semantic, "return errors;", "return [];"],
    [verifier, "const errors = [...verifyIrIntrinsicSignature(instr, typeOf)];", "const errors: string[] = [];"],
    [verifier, "verifyIrIntrinsicSignature(instr, typeOf)", "verifyIrIntrinsicSignature(instr, new Map())"],
    [verifier, "binding.symbol !== instr.id", "binding.symbol === instr.id"],
    [
      verifier,
      "Verify the closed semantic signature and any post-freeze provider binding.",
      "Changed wrapper documentation.",
    ],
    [verifier, "return errors;", "errors.length = 0; return errors;"],
  ])("rejects altered semantic result/adapter/provider suffix in %s", (path, before, after) => {
    expect(() =>
      acceptedHistoricalDeclarations(
        support,
        mutation(path!, (text) => text.replace(before!, after!)),
      ),
    ).toThrow();
  });

  it("rejects reordered provider suffix statements rather than canonicalizing them", () => {
    const file = parseLive(verifier, read),
      fn = file.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === "verifyIrIntrinsicInstruction",
      ) as ts.FunctionDeclaration;
    expect(fn.body!.statements).toHaveLength(4);
    const first = fn.body!.statements[1]!,
      second = fn.body!.statements[2]!;
    expect(ts.isIfStatement(first)).toBe(true);
    expect(ts.isIfStatement(second)).toBe(true);
    const changed = mutation(
      verifier,
      (text) =>
        text.slice(0, first.getFullStart()) +
        second.getFullText(file) +
        first.getFullText(file) +
        text.slice(second.end),
    );
    expect(() => acceptedHistoricalDeclarations(support, changed)).toThrow();
  });

  it.each([
    [intrinsic, "F64_TYPE", "src/ir/intrinsics.ts"],
    [semantic, "IntrinsicEffectEvidence", "src/ir/intrinsics.ts"],
    [manifest, "ALL_TARGETS", "src/ir/runtime-manifest.ts"],
    [attachment, "preparedManifestByPlan", "src/ir/async-plan.ts"],
  ])("rejects reordered canonical declarations from %s", (path, name, historical) => {
    expect(() => acceptedHistoricalDeclarations(historical!, declarationMutation(path!, name!, "reorder"))).toThrow(
      /current declaration order/,
    );
  });

  it.each(["star", "wrong target", "duplicate", "renamed", "local replacement"] as const)(
    "rejects a %s live forwarding hop",
    (change) => {
      const path = "src/ir/async-runtime-providers.ts",
        owner = "src/ir/runtime/async-providers.ts",
        name = "ASYNC_RUNTIME_PROVIDERS";
      assertNamedForward(path, owner, name, false, read);
      const changed = mutation(path, (text) => {
        if (change === "star") return text + '\nexport * from "./runtime/async-providers.js";';
        if (change === "wrong target") return text.replaceAll("./runtime/async-providers.js", "./wrong.js");
        if (change === "duplicate")
          return text + '\nexport { ASYNC_RUNTIME_PROVIDERS } from "./runtime/async-providers.js";';
        if (change === "renamed")
          return text.replace("  ASYNC_RUNTIME_PROVIDERS,", "  WRONG as ASYNC_RUNTIME_PROVIDERS,");
        return text + "\nexport const ASYNC_RUNTIME_PROVIDERS = [];";
      });
      expect(() => assertNamedForward(path, owner, name, false, changed)).toThrow();
    },
  );
});
