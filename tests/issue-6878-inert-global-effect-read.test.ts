// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// G-only acceptance: library identity is not a blanket inert global-read vote.
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { TsCheckerOracle } from "../src/checker/oracle.js";
import { analyzeNumericPropertyNames } from "../src/codegen/numeric-property-analysis.js";
import { forEachChild, ts } from "../src/ts-api.js";

const FILE_NAME = "issue-6878-receiver-adapter.ts";
const STRING = `
function Tok(input) { this.input = input; this.pos = 0; }
Tok.prototype.nextCode = function () { var c = this.input.charCodeAt(this.pos); this.pos = this.pos + 1; return c; };
function drive(s) { var t = new Tok(s); return t.nextCode(); }
export function main() { return drive("A"); }
`;
const LITERAL_MODULE = "export {}; const c = 'A'.charCodeAt(0); ";

function inspect(source: string) {
  // Match the exact original analysis file/default options, including its lib.d.ts.
  const { sourceFile, checker } = analyzeSource(source, FILE_NAME);
  const oracle = new TsCheckerOracle(checker);
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    forEachChild(node, visit);
  };
  visit(sourceFile);
  const verdicts = analyzeNumericPropertyNames({ oracle }, [sourceFile]);
  const declaration = (name: string): ts.VariableDeclaration => {
    const matches = nodes.filter(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
    );
    if (matches.length !== 1) throw new Error(`UNKNOWN declaration inventory: ${name}/${matches.length}`);
    return matches[0]!;
  };
  const numeric = (name: string): boolean => verdicts.isNumericLocal(declaration(name).name, name);
  const provenance = (name: string) => {
    const expression = declaration(name).initializer;
    if (!expression || !ts.isIdentifier(expression)) throw new Error(`UNKNOWN original identifier: ${name}`);
    const resolved = oracle.valueDeclarationOf(expression);
    return resolved
      ? {
          kind: ts.SyntaxKind[resolved.kind],
          text: resolved.getText(),
          fileName: resolved.getSourceFile().fileName,
          isDeclarationFile: resolved.getSourceFile().isDeclarationFile,
          inOriginalSource: resolved.getSourceFile() === sourceFile,
        }
      : null;
  };
  const receipt = (label: string, readName?: string): void => {
    console.info(
      "[6878-inert-global-read]",
      JSON.stringify({
        label,
        source,
        analysisFile: FILE_NAME,
        analysisOptions: "default (no override)",
        numericC: numeric("c"),
        declaration: readName ? provenance(readName) : "not an identifier-read control",
        numericProperties: [...verdicts.numeric].sort(),
        numericFunctions: [...verdicts.numericFunctions].sort(),
        privateLegacyVote: "UNKNOWN",
        privateBridgedP2Vote: "UNKNOWN",
        privateFinalRVote: "UNKNOWN",
      }),
    );
  };
  return { numeric, provenance, receipt };
}

const READ_ROWS = [
  ["baseline closed String", "", true],
  ["exact original library external", "const seen = external;", false],
  ["truly unbound", "const seen = __6878_unbound_effect_20261009;", false],
  ["explicit source ambient", "declare var external: number; const seen = external;", false],
  ["library host object document", "const seen = document;", false],
  ["library host member/getter context", "const seen = external.AddSearchProvider;", false],
  ["source getter", "const object = { get value() { return 1; } }; const seen = object.value;", false],
  ["lexical source external", "const external = 1; const seen = external;", true],
  ["lexical Number data binding", "const Number = 1; const seen = Number;", true],
  ["immutable NaN data read", "const seen = NaN;", true],
  ["immutable Infinity data read", "const seen = Infinity;", true],
  ["deferred safe undefined data read requires proven identity", "const seen = undefined;", true],
  ["lexical NaN shadow data read", "const NaN = 'shadow'; const seen = NaN;", true],
  ["bare Number handle is not a supported data read", "const seen = Number;", false],
  ["bare Math handle is not a supported data read", "const seen = Math;", false],
  ["String source shadow", "function String(value) { return 'shadow'; } String(0);", false],
  ["Number binding mutation", "Number = function () { return false; }; Number(0);", false],
  ["Math member mutation", "Math.abs = function () { return false; }; Math.abs(-1);", false],
  ["Date member mutation", "Date.now = function () { return false; }; Date.now();", false],
  ["NaN binding mutation", "NaN = 0; const seen = NaN;", false],
  ["Infinity binding mutation", "Infinity = 0; const seen = Infinity;", false],
  ["reflective NaN mutation", "globalThis['NaN'] = 0; const seen = NaN;", false],
  ["requested String key mutation", "String.prototype.charCodeAt = function () { return false; };", false],
  ["unknown String key mutation", "String.prototype[key] = function () { return false; };", false],
] as const;

for (const [path, base] of [
  ["original constructor", STRING],
  ["matched module literal", LITERAL_MODULE],
] as const) {
  describe(`#6878 inert global effect read — ${path}`, () => {
    it.each(READ_ROWS)("enforces finite effect-read capability: %s", (label, tail, expected) => {
      const fixture = inspect(base + tail);
      fixture.receipt(`${path}/${label}`, label.includes("undefined") ? "seen" : undefined);
      expect(fixture.numeric("c")).toBe(expected);
    });
  });
}

describe("#6878 inert global effect read — dedicated intrinsic contexts unchanged", () => {
  it.each([
    [
      "Number/String/Boolean conversions",
      "const converted = Number('1'); const text = String(1); const truth = Boolean(0);",
    ],
    ["Math/Date numeric calls", "const maximum = Math.abs(-1); const now = Date.now();"],
    ["unrelated String key write", "String.prototype.indexOf = function () { return false; };"],
  ] as const)("keeps legacy literal completion positive: %s", (label, tail) => {
    const fixture = inspect(LITERAL_MODULE + tail);
    fixture.receipt(`dedicated context/${label}`);
    expect(fixture.numeric("c")).toBe(true);
    if (label === "Number/String/Boolean conversions") {
      expect(fixture.numeric("converted")).toBe(true);
      expect(fixture.numeric("truth")).toBe(false);
    }
  });

  it("captures the exact external library declaration without granting inert evaluation", () => {
    const fixture = inspect(STRING + "const seen = external;");
    const declaration = fixture.provenance("seen");
    fixture.receipt("exact external provenance", "seen");
    expect(declaration?.kind).toBe("VariableDeclaration");
    expect(declaration?.text).toBe("external: External");
    expect(declaration?.isDeclarationFile).toBe(true);
    expect(declaration?.inOriginalSource).toBe(false);
    expect(declaration?.fileName).toMatch(/(?:^|[/\\])lib[^/\\]*\.d\.ts$/);
    expect(fixture.numeric("c")).toBe(false);
  });
});
