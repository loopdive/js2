import { analyzeMultiSource } from "../../src/checker/index.js";
import { foldsBuiltinMember, pristineBuiltinGlobal } from "../../src/ir/builtin-global-binding.js";
import { ts } from "../../src/frontend/typescript.js";
for (const src of [
  'Object.defineProperty(this, "Number", {value: {isNaN: function () { return 7; }}});',
  'Object.assign(globalThis, {Number: {isNaN: function () { return 7; }}});',
  'this["Num" + "ber"] = {isNaN: function () { return 7; }};',
]) {
  const ast = analyzeMultiSource({ "./entry.js": src + "\nNumber.isNaN(1);" }, "./entry.js", undefined, { allowJs: true });
  const last = ast.entryFile.statements.at(-1) as ts.ExpressionStatement;
  const id = ((last.expression as ts.CallExpression).expression as ts.PropertyAccessExpression).expression as ts.Identifier;
  console.log(JSON.stringify({ src, pristine: pristineBuiltinGlobal(ast.checker, ast.sourceFiles)(id), fold: foldsBuiltinMember(ast.checker, ast.sourceFiles)(id) }));
}
