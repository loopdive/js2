import { readFileSync, readdirSync } from "node:fs";
import { ts } from "../../../src/ts-api.js";
const progs = JSON.parse(readFileSync("tests/fixtures/prepared-proving-programs.json", "utf8"));
const texts: [string, string][] = [];
for (const [i, p] of progs.entries()) for (const [f, t] of Object.entries(p.files)) texts.push([`${i}:${f}`, t as string]);
for (const f of readdirSync("scripts/emit-identity-corpus")) texts.push([f, readFileSync("scripts/emit-identity-corpus/" + f, "utf8")]);
let imports = 0, classExprNames = 0, argumentsUse = 0, tsValueDeclarations = 0, loopHeadInitializers = 0;
for (const [name, text] of texts) {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const v = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n)) { imports++; console.log("import", name, n.getText().slice(0, 80)); }
    if (ts.isClassExpression(n) && n.name) { classExprNames++; console.log("classexpr", name, n.name.text); }
    if (ts.isIdentifier(n) && n.text === "arguments") argumentsUse++;
    // v3 (PRV-7628 round 2): declarations the binding record now counts as `any`.
    if (ts.isEnumDeclaration(n) || ts.isModuleDeclaration(n) || ts.isNamespaceExportDeclaration(n) || ts.isExportAssignment(n)) {
      tsValueDeclarations++;
      console.log("ts-decl", name, ts.SyntaxKind[n.kind], n.getText().slice(0, 60));
    }
    if ((ts.isForInStatement(n) || ts.isForOfStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer) &&
      n.initializer.declarations.some((d) => d.initializer)) { loopHeadInitializers++; console.log("loop-head-init", name); }
    ts.forEachChild(n, v);
  };
  v(sf);
}
console.log({ texts: texts.length, imports, classExprNames, argumentsUse, tsValueDeclarations, loopHeadInitializers });
