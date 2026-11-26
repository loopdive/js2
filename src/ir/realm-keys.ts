// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Whether the program may have patched a realm prototype chain a selector reasons about. (#7354 M1) The catalog's
// property keys themselves are read in src/ir/program/builtin-prototype-keys.ts.

import { sourceMayPatchPrototype } from "../shared/intrinsic-prototype-writes.js";
import type { ts } from "../ts-api.js";

/**
 * Whether the program may patch what destructuring reads beyond a source's own
 * elements and keys: the array iterator and holes (`Array.prototype`), or a
 * missing key (`Object.prototype`).
 */
export function programPatchesDestructuringRealm(sourceFile: ts.SourceFile): boolean {
  return sourceMayPatchPrototype(sourceFile, "Array") || sourceMayPatchPrototype(sourceFile, "Object");
}
