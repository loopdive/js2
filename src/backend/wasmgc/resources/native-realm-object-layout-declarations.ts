// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  createRealmIdentityDeclaration,
  createRealmObjectStateDeclaration,
  createRealmObjectPrototypeDeclaration,
  createRealmOrdinaryObjectDeclaration,
} from "../../../runtime/wasmgc/values/realm-object-layouts.js";
import { freezeNativeResourceRecipe } from "./native-resource-declarations.js";
const typeRoles = ["identity", "state", "objectPrototype", "ordinary"] as const;
const initializerNames = {
  prototypeInitializer: "__realm_object_state",
  sourceInitializer: "__realm_source_state",
} as const;
function fail(detail: string): never {
  throw new Error("native realm object layouts: " + detail);
}
/** No catalog or source demand is invented to reserve these physical prerequisites. */
function declareRealmLayouts(
  key: string,
  storage?: { readonly objectKey: string; readonly mapKey: string },
  borrowedStateKey?: string,
): NativeResourceRecipe {
  const { objectKey, mapKey } = storage ?? {};
  for (const value of [key, ...(storage ? [objectKey, mapKey] : []), ...(borrowedStateKey ? [borrowedStateKey] : [])])
    if (typeof value !== "string" || !value) fail("invalid declaration key");
  const identity = key + ":identity",
    state = borrowedStateKey ?? key + ":state";
  const shapes = [
    ...(borrowedStateKey ? [] : [createRealmIdentityDeclaration(), createRealmObjectStateDeclaration(identity)]),
    ...(storage
      ? [
          createRealmObjectPrototypeDeclaration(storage.objectKey, storage.mapKey),
          createRealmOrdinaryObjectDeclaration(storage.objectKey, storage.mapKey, state),
        ]
      : []),
  ];
  const declarations: NativeResourceRecipe["declarations"] = [
    ...typeRoles.slice(borrowedStateKey ? 2 : 0, borrowedStateKey ? 4 : shapes.length).map((role, index) => ({
      key: key + ":" + role,
      role: ["realm-carrier", role],
      space: "type" as const,
      shape: shapes[index]!,
    })),
    ...(borrowedStateKey
      ? []
      : ([
          {
            key: key + ":realm",
            role: ["realm-carrier", "realm-anchor"],
            space: "global",
            name: "__realm_identity",
            valueType: { kind: "ref_null", typeKey: identity },
            mutable: true,
          },
          {
            key: key + ":functionPrototype",
            role: ["realm-carrier", "function-prototype-anchor"],
            space: "global",
            name: "__realm_function_prototype",
            valueType: { kind: "externref" },
            mutable: true,
          },
          {
            key: key + ":prototypeInitializer",
            role: ["realm-carrier", "prototype-state-initializer"],
            space: "function",
            name: initializerNames.prototypeInitializer,
            signature: { params: [{ kind: "externref" }], results: [{ kind: "ref", typeKey: state }] },
          },
          {
            key: key + ":sourceInitializer",
            role: ["realm-carrier", "source-state-initializer"],
            space: "function",
            name: initializerNames.sourceInitializer,
            signature: { params: [], results: [{ kind: "ref", typeKey: state }] },
          },
        ] as const)),
  ];
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({
      phase: "resources" as const,
      kind: "reserve" as const,
      resourceKey: row.key,
    })),
  });
}
export function declareNativeRealmObjectState(key: string): NativeResourceRecipe {
  return declareRealmLayouts(key);
}
export function declareNativeRealmObjectLayouts(key: string, objectKey: string, mapKey: string): NativeResourceRecipe {
  return declareRealmLayouts(key, { objectKey, mapKey });
}

/** Extend storage over an existing state; no second identity, anchors or initializer. */
export function declareNativeRealmObjectLayoutExtension(
  key: string,
  objectKey: string,
  mapKey: string,
  stateKey: string,
): NativeResourceRecipe {
  if (typeof stateKey !== "string" || !stateKey) fail("invalid declaration key");
  return declareRealmLayouts(key, { objectKey, mapKey }, stateKey);
}
