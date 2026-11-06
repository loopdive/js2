// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachChild, ts } from "../../ts-api.js";

/**
 * A String replacement callback is the one escaping function boundary whose
 * parameter ABI is deliberately dynamic here: replace supplies a mixture of
 * strings and numeric offsets that body-only arithmetic cannot soundly narrow.
 * Other host callbacks (notably Array HOF predicates) have established native
 * scalar ABIs, so treating every value escape as dynamic corrupts their call
 * frames and their synthesized `arguments` objects.
 */
export function functionNameIsStringReplacement(funcName: string, sourceFile: ts.SourceFile): boolean {
  return stringReplacementCallbackNames(sourceFile).has(funcName);
}

/**
 * (#6988) Names passed as the replacement argument of a `replace`/`replaceAll`
 * call anywhere in the file, indexed once per file. The per-name whole-file walk
 * this replaces was quadratic — 99 % of a 25+ minute compile of the 5 MB Octane
 * mandreel driver (one walk per uncalled function with an implicit-any param).
 */
const stringReplacementNamesBySourceFile = new WeakMap<ts.SourceFile, Set<string>>();

function stringReplacementCallbackNames(sourceFile: ts.SourceFile): Set<string> {
  const cached = stringReplacementNamesBySourceFile.get(sourceFile);
  if (cached) return cached;
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length >= 2) {
      const replacement = node.arguments[1];
      if (ts.isIdentifier(replacement)) {
        let methodName: string | undefined;
        if (ts.isPropertyAccessExpression(node.expression)) {
          methodName = node.expression.name.text;
        } else if (
          ts.isElementAccessExpression(node.expression) &&
          node.expression.argumentExpression &&
          ts.isStringLiteralLike(node.expression.argumentExpression)
        ) {
          methodName = node.expression.argumentExpression.text;
        }
        if (methodName === "replace" || methodName === "replaceAll") names.add(replacement.text);
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  stringReplacementNamesBySourceFile.set(sourceFile, names);
  return names;
}
