// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  NativeDeclaredSignature,
  NativeResourceRecipe,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { freezeNativeResourceRecipe } from "./native-resource-declarations.js";

export interface NativeObjectAccessTypeKeys {
  readonly object: string;
  readonly propEntry: string;
  readonly nativeString: string;
}
export interface NativeObjectAccessDeclarationPlan extends NativeResourceRecipe {
  readonly key: string;
  readonly types: NativeObjectAccessTypeKeys;
  readonly functions: {
    readonly hash: string;
    readonly keyEquals: string;
    readonly findOwn: string;
    readonly lookup: string;
    readonly has: string;
    readonly get: string;
  };
}

/** The internal three-state read ABI is deliberately distinct from public generic Get/Has. */
export function declareNativeObjectAccessResources(
  key: string,
  types: NativeObjectAccessTypeKeys,
): NativeObjectAccessDeclarationPlan {
  if (!key || typeof key !== "string" || Object.values(types).some((v) => typeof v !== "string" || !v))
    throw new Error("native object access: invalid declaration key/type dependency");
  const functions = {
    hash: key + ":hash",
    keyEquals: key + ":key-equals",
    findOwn: key + ":find-own",
    lookup: key + ":lookup",
    has: key + ":has",
    get: key + ":get",
  };
  const signatures: Record<keyof typeof functions, NativeDeclaredSignature> = {
    hash: { params: [{ kind: "externref" }], results: [{ kind: "i32" }] },
    keyEquals: {
      params: [{ kind: "anyref" }, { kind: "i32" }, { kind: "i32" }, { kind: "ref_null", typeKey: types.nativeString }],
      results: [{ kind: "i32" }],
    },
    findOwn: {
      params: [{ kind: "ref", typeKey: types.object }, { kind: "externref" }],
      results: [{ kind: "ref_null", typeKey: types.propEntry }],
    },
    lookup: {
      params: [{ kind: "ref", typeKey: types.object }, { kind: "externref" }],
      results: [{ kind: "i32" }, { kind: "ref_null", typeKey: types.propEntry }],
    },
    has: {
      params: [{ kind: "ref", typeKey: types.object }, { kind: "externref" }],
      results: [{ kind: "i32" }],
    },
    get: {
      params: [{ kind: "ref", typeKey: types.object }, { kind: "externref" }, { kind: "externref" }],
      results: [{ kind: "i32" }, { kind: "externref" }],
    },
  };
  const declarations = (Object.keys(functions) as (keyof typeof functions)[]).map((role) => ({
    key: functions[role],
    role: ["ordinary-object-access", role],
    space: "function" as const,
    name: "__ordinary_object_" + role,
    signature: signatures[role],
  }));
  return freezeNativeResourceRecipe({
    key,
    types: { ...types },
    functions,
    declarations,
    reservationSteps: declarations.map((row) => ({
      phase: "resources" as const,
      kind: "reserve" as const,
      resourceKey: row.key,
    })),
  });
}

/** The lookup subgraph has no value conversion or invocation dependency. */
export function declareNativeObjectLookupResources(
  key: string,
  types: NativeObjectAccessTypeKeys,
): NativeResourceRecipe {
  const plan = declareNativeObjectAccessResources(key, types);
  return freezeNativeResourceRecipe({
    declarations: plan.declarations.filter((row) => row.key !== plan.functions.get),
    reservationSteps: plan.reservationSteps.filter(
      (row) => row.kind !== "reserve" || row.resourceKey !== plan.functions.get,
    ),
  });
}
