// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The property keys the native realm defines on its intrinsics, read from the
// realm catalog: a selector that reasons about a missing own key asks here
// whether the prototype chain would answer it instead.

import { NATIVE_REALM_CATALOG } from "../runtime/contracts/native-realm-catalog.js";

/** The string keys the catalog gives the named intrinsics (Annex B members included). */
export function realmStringKeys(...intrinsicIds: readonly string[]): ReadonlySet<string> {
  return new Set(
    NATIVE_REALM_CATALOG.intrinsics
      .filter(({ id }) => intrinsicIds.includes(id))
      .flatMap(({ properties }) => properties.flatMap(({ key }) => (key.kind === "string" ? [key.value] : []))),
  );
}

/** The string keys `Object.prototype` owns (§20.1.3, Annex B.2.2 included). */
export const OBJECT_PROTOTYPE_KEYS = realmStringKeys("%Object.prototype%");
