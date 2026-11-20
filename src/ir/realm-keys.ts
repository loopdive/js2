// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The property keys the native realm defines on its intrinsics, read from the
// realm catalog: a selector that reasons about a missing own key asks here
// whether the prototype chain would answer it instead, and whether the
// program may have patched that chain.

import { sourceMayPatchPrototype } from "../shared/intrinsic-prototype-writes.js";
import type { ts } from "../ts-api.js";

// (#7354 M1) The catalog reads live in the clean ir-program module the dynamic-value legalization shares.
export { OBJECT_PROTOTYPE_KEYS, realmStringKeys } from "./program/builtin-prototype-keys.js";

/**
 * Whether the program may patch what destructuring reads beyond a source's own
 * elements and keys: the array iterator and holes (`Array.prototype`), or a
 * missing key (`Object.prototype`).
 */
export function programPatchesDestructuringRealm(sourceFile: ts.SourceFile): boolean {
  return sourceMayPatchPrototype(sourceFile, "Array") || sourceMayPatchPrototype(sourceFile, "Object");
}
