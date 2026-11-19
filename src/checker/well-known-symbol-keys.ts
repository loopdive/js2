// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7410, #7427) The keys a symbol-keyed property has where the program can observe them, recovered from the source key.
 *
 * TypeScript names a `[Symbol.replace]` member `__@replace@<id>`, where `<id>` comes from its process-global
 * symbol counter. The id depends on how many compiles the process ran before, so a runtime string built from that
 * escaped name is both wrong and dependent on compile order.
 */
import { ts } from "../ts-api.js";
import { wellKnownSymbolId } from "../runtime/contracts/well-known-symbols.js";
import { isCurrentCompilerLibrarySourceFile } from "./index.js";

const ESCAPED_SYMBOL_KEY = /^__@(.+)@\d+$/;

/** Whether `expression` is `Symbol.<name>` on the compiler library's `Symbol`. */
function isLibrarySymbolMember(checker: ts.TypeChecker, expression: ts.Expression, name: string): boolean {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== name) return false;
  if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "Symbol") return false;
  const declarations = checker.getSymbolAtLocation(expression.expression)?.declarations;
  return (
    declarations !== undefined &&
    declarations.length > 0 &&
    declarations.every((declaration) => isCurrentCompilerLibrarySourceFile(declaration.getSourceFile()))
  );
}

/**
 * The well-known symbol a property is keyed by (`"replace"` for `[Symbol.replace]`), when every declaration names
 * it as `Symbol.<name>` on the library's `Symbol`; otherwise undefined.
 */
function wellKnownSymbolKeyName(checker: ts.TypeChecker, property: ts.Symbol): string | undefined {
  const name = ESCAPED_SYMBOL_KEY.exec(property.escapedName as string)?.[1];
  const declarations = property.declarations;
  if (name === undefined || declarations === undefined || declarations.length === 0) return undefined;
  for (const declaration of declarations) {
    const key = ts.getNameOfDeclaration(declaration);
    if (key === undefined || !ts.isComputedPropertyName(key)) return undefined;
    if (!isLibrarySymbolMember(checker, key.expression, name)) return undefined;
  }
  return name;
}

/**
 * A string key's name, or `spell` of the well-known symbol a symbol-keyed property names. Any other symbol key
 * answers undefined: its identity is a runtime value.
 */
function keyOfProperty(
  checker: ts.TypeChecker,
  property: ts.Symbol,
  spell: (wellKnownName: string) => string | undefined,
): string | undefined {
  if (!ESCAPED_SYMBOL_KEY.test(property.escapedName as string)) return property.name;
  const name = wellKnownSymbolKeyName(checker, property);
  return name === undefined ? undefined : spell(name);
}

/**
 * The `name` SetFunctionName (§10.2.9) gives a function stored under `property`: `"[Symbol.replace]"` for a
 * well-known symbol and the name itself for a string key.
 */
export function functionNameForKey(checker: ts.TypeChecker, property: ts.Symbol): string | undefined {
  return keyOfProperty(checker, property, (name) => `[Symbol.${name}]`);
}

/**
 * (#7427) The key a built-in prototype member has in the native-prototype tables: `@@<id>` (`WELL_KNOWN_SYMBOL_IDS`)
 * for a well-known symbol and the name itself for a string key.
 */
export function memberKeyForProperty(checker: ts.TypeChecker, property: ts.Symbol): string | undefined {
  return keyOfProperty(checker, property, (name) => {
    const id = wellKnownSymbolId(name);
    return id === undefined ? undefined : `@@${id}`;
  });
}
