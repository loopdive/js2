// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ts } from "../src/frontend/typescript.js";
import { ts as legacyTs } from "../src/ts-api.js";
import { IrUnsupportedError } from "../src/shared/contracts/ir-preparation-errors.js";
import { IrUnsupportedError as legacyError } from "../src/ir/outcomes.js";
import {
  IR_ALLOCATION_SOURCE_FACTS,
  isSourceObjectConstruction,
} from "../src/shared/contracts/allocation-source-facts.js";
import { IR_ALLOCATION_SOURCE_FACTS as analysisKey } from "../src/ir/analysis/contracts/allocations.js";
import {
  SOURCE_OBJECT_CONSTRUCTION,
  isSourceObjectConstruction as legacyValidator,
} from "../src/ir/runtime/object-construction.js";
import { references } from "../scripts/check-compiler-boundaries.mjs";
import { buildGraph } from "../scripts/check-import-cycles.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const parse = (path: string, text = read(path)) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

describe("frontend dependency cuts without changing source authority", () => {
  it("uses exactly the existing parser namespace and diagnostic constructor", () => {
    expect(ts).toBe(legacyTs);
    expect(ts.SyntaxKind.SourceFile).toBe(legacyTs.SyntaxKind.SourceFile);
    expect(IrUnsupportedError).toBe(legacyError);
    const error = new IrUnsupportedError("type-resolution-unsupported", "build", "same source boundary");
    expect(error).toBeInstanceOf(legacyError);
    expect(error.kind).toBe("unsupported");
  });

  it("the dependency scanner sees both value and type-only legacy-shim references", () => {
    const source = parse(
      "positive-control.ts",
      [
        'import { ts } from "../ts-api.js";',
        'import type { ts as types } from "../ts-api.js";',
        'const lazy = import("../ts-api.js");',
      ].join("\n"),
    );
    const refs = references(source, {});
    expect(refs).toHaveLength(3);
    expect(refs.map((row: { specifier: string; typeOnly: boolean }) => [row.specifier, row.typeOnly])).toEqual([
      ["../ts-api.js", false],
      ["../ts-api.js", true],
      ["../ts-api.js", false],
    ]);
  });

  it("no frontend module imports the legacy runtime-selection shim", () => {
    const graph = buildGraph(resolve(root, "src/frontend"));
    expect(graph.refs.size).toBeGreaterThanOrEqual(14);
    const required = [
      "logical-record-type.ts",
      "boolean-return-boundary.ts",
      "source-strictness.ts",
      "use-strict-directive.ts",
      "builtins/build-ir.ts",
      "object-write.ts",
    ];
    for (const path of required) {
      expect(graph.refs.has(path)).toBe(true);
      expect(
        graph.refs.get(path).some((row: { specifier: string }) => /(?:^|\/)typescript\.js$/.test(row.specifier)),
      ).toBe(true);
    }
    for (const [path, refs] of graph.refs)
      expect(
        refs.filter((row: { specifier: string }) => /(?:^|\/)ts-api\.(?:ts|js)$/.test(row.specifier)),
        path,
      ).toEqual([]);
  });

  it("source metadata is a real shared leaf, not a facade importing the old IR owner", () => {
    const file = parse("src/shared/contracts/allocation-source-facts.ts");
    expect(references(file, {})).toEqual([]);
    expect(IR_ALLOCATION_SOURCE_FACTS).toBe("source-facts");
    expect(analysisKey).toBe(IR_ALLOCATION_SOURCE_FACTS);
    expect(SOURCE_OBJECT_CONSTRUCTION).toBe(IR_ALLOCATION_SOURCE_FACTS);
    expect(legacyValidator).toBe(isSourceObjectConstruction);
    const imports = references(parse("src/frontend/object-construction.ts"), {});
    expect(
      imports.filter(
        (row: { specifier: string; typeOnly: boolean }) => !row.typeOnly && row.specifier.includes("/ir/"),
      ),
    ).toEqual([]);
  });

  it("preserves the exact complete validator declaration from the signed parent", () => {
    const file = parse("src/shared/contracts/allocation-source-facts.ts");
    const validator = file.statements.filter(
      (row) => ts.isFunctionDeclaration(row) && row.name?.text === "isSourceObjectConstruction",
    );
    expect(validator).toHaveLength(1);
    const digest = createHash("sha256")
      .update(validator[0]!.getText(file) + "\n")
      .digest("hex");
    // Complete declaration at 46d313b1b790a6cd9ebecf60216110c78ca085f0;
    // CI needs no historical Git object or current-tree-derived expected hash.
    expect(digest).toBe("2c006f6b2dafd9c2db1539ff892523aa3f113fe59af380a21470da4b3d0422f5");
  });

  it.each(["data", "prototype-setter", "method"])(
    "validates the unchanged %s facts without granting a provider",
    (kind) => {
      const facts = { schema: "source-object-construction-v1", kind, keys: ["z", "a"] };
      expect(isSourceObjectConstruction(facts, [{ name: "a" }, { name: "z" }])).toBe(true);
      expect(legacyValidator(facts, [{ name: "a" }, { name: "z" }])).toBe(true);
    },
  );

  it.each([
    undefined,
    null,
    {},
    { schema: "source-object-construction-v1", kind: "unknown", keys: ["a", "z"] },
    { schema: "source-object-construction-v1", kind: "data", keys: ["a", "a"] },
    { schema: "source-object-construction-v1", kind: "data", keys: ["a", "foreign"] },
    { schema: "source-object-construction-v1", kind: "data", keys: ["a", "z"], completion: true },
  ])("retains structural rejection for malformed facts: %j", (facts) => {
    expect(isSourceObjectConstruction(facts, [{ name: "a" }, { name: "z" }])).toBe(false);
  });
});
