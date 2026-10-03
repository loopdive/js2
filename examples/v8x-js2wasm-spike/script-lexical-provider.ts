// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** AOT-native declarative record. Compile into the owning Context provider,
 * not into each Script. Operation numbers match shared-script-lexical-access.
 * Cells are module-private and never installed on globalThis. */
const scriptLexicalCells: any = Object.create(null);

export function scriptLexicalOperation(name: any, operation: number, value: any): any {
  const key = String(name);
  const present = Object.prototype.hasOwnProperty.call(scriptLexicalCells, key);
  if (operation === 9) return present;
  if (operation <= 2) {
    if (present) throw new SyntaxError("Identifier already declared: " + key);
    if (operation !== 0) {
      const descriptor: any = Object.getOwnPropertyDescriptor(globalThis, key);
      if (descriptor !== undefined && !descriptor.configurable) {
        throw new SyntaxError("Restricted global lexical declaration: " + key);
      }
    } else if (!Object.prototype.hasOwnProperty.call(globalThis, key) && !Object.isExtensible(globalThis)) {
      throw new TypeError("Global object is not extensible");
    }
    return undefined;
  }
  if (operation === 3 || operation === 4) {
    if (present) throw new SyntaxError("Identifier already declared: " + key);
    scriptLexicalCells[key] = { value: undefined, initialized: false, immutable: operation === 4 };
    return undefined;
  }
  if (!present) throw new ReferenceError("Unknown lexical binding: " + key);
  const cell: any = scriptLexicalCells[key];
  if (operation === 8) return cell.initialized;
  if (operation === 7) {
    if (cell.initialized) throw new TypeError("Lexical binding already initialized: " + key);
    cell.value = value;
    cell.initialized = true;
    return undefined;
  }
  if (!cell.initialized) throw new ReferenceError("Lexical binding is uninitialized: " + key);
  if (operation === 5) return cell.value;
  if (operation === 6) {
    if (cell.immutable) throw new TypeError("Assignment to constant binding: " + key);
    cell.value = value;
    return undefined;
  }
  throw new TypeError("Unknown Script lexical operation");
}
