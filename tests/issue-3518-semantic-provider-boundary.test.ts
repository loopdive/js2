import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

// The policy-history and source-profile receipts of this boundary were retired by #7380 PR 2a: each compared a
// reconstructed raw source profile with a stored one and broke on every edit of a pinned file. What remains is the
// living rule that the native resource declaration contract stays erased and model-only.
const declarationContract = resolve(
  import.meta.dirname,
  "..",
  "src/runtime/wasmgc/values/native-resource-declaration-types.ts",
);

function assertModelOnlyDeclarations(text: string) {
  const source = ts.createSourceFile("declarations.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      expect(statement.importClause?.isTypeOnly).toBe(true);
      expect(ts.isStringLiteral(statement.moduleSpecifier)).toBe(true);
      imports.push((statement.moduleSpecifier as ts.StringLiteral).text);
    } else {
      expect(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)).toBe(true);
    }
  }
  expect(imports).toEqual(["../../../wasm/model/instructions.js", "../../../wasm/model/module-records.js"]);
  const visit = (node: ts.Node): void => {
    expect(ts.isImportTypeNode(node)).toBe(false);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

describe("semantic verification and provider ownership boundary", () => {
  it("keeps the actual declaration contract erased and model-only", () => {
    assertModelOnlyDeclarations(readFileSync(declarationContract, "utf8"));
  });

  it.each([
    'import { extra } from "../../../wasm/model/instructions.js";',
    'import type { Extra } from "../../../wasm/physical/module-reservations.js";',
    'export type Extra = import("../../../wasm/physical/module-reservations.js").TypeReservation;',
    "export const runtimeValue = 1;",
  ])("rejects declaration-contract coupling: %s", (mutation) => {
    const text = readFileSync(declarationContract, "utf8");
    assertModelOnlyDeclarations(text);
    expect(() => assertModelOnlyDeclarations(text + "\n" + mutation)).toThrow();
  });
});
