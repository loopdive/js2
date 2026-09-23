import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ts } from "../../src/ts-api.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

function parseFixture(name: string): ts.SourceFile {
  const path = join(FIXTURES, name);
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stringConstants(sourceFile: ts.SourceFile): Map<string, string> {
  const values = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isStringLiteral(declaration.initializer)) {
        values.set(declaration.name.text, declaration.initializer.text);
      }
    }
  }
  return values;
}

function zeroArgumentRunCaseLiterals(sourceFile: ts.SourceFile): Map<string, string> {
  const values = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
    expect(statement.parameters, `${statement.name.text} must remain a zero-argument Wasm oracle`).toHaveLength(0);
    const returned = statement.body.statements.find(ts.isReturnStatement)?.expression;
    if (
      returned &&
      ts.isCallExpression(returned) &&
      ts.isIdentifier(returned.expression) &&
      returned.expression.text === "runCase" &&
      returned.arguments.length === 1 &&
      ts.isStringLiteral(returned.arguments[0])
    ) {
      values.set(statement.name.text, returned.arguments[0].text);
    }
  }
  return values;
}

describe("TypeScript standalone oracle fixtures", () => {
  it("preserves the exact pinned parser input bytes", () => {
    const values = stringConstants(parseFixture("typescript-parser-standalone-workload.ts"));
    expect(Object.fromEntries([...values].map(([name, value]) => [name, sha256(value)]))).toEqual({
      builderStatePublicSource: "93138f0f93fd9dff071c3def9feebc5f88fbe65bcb028d4ca8871d3155b9b522",
      corePublicSource: "a7b165ec7979470a90bd157c4a8e49da2ac6fa753f1f56ce1b2429d2667c4e04",
      performanceCoreSource: "7f6e15fcf84111901e95303399ba69c9baacc3466a3ad5b5b21633c3d382f7b4",
    });
  });

  it("preserves the exact binder inputs behind zero-argument exports", () => {
    const values = zeroArgumentRunCaseLiterals(parseFixture("typescript-binder-standalone-workload.ts"));
    expect(Object.fromEntries([...values].map(([name, value]) => [name, sha256(value)]))).toEqual({
      runConstLocal: "95befdd6e691d4d89031a2a2901cc74fc6242109980b060e08ddf87829924483",
      runDuplicateLet: "00ed58aa09db27c103cbd6b1913e174edbf2cde2d9789d46c1d9c80808f77bbb",
    });
  });
});
