// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The physical plan's binding of a program's `js.object.*` calls: each call route binds the realm function
 * that serves its contract (`native-source-objects.ts`), through the same row builder as native invocation.
 */
import type { NativeRealmRequirements } from "../../../ir/program/native-realm-requirements.js";
import type { IrUnitId } from "../../../shared/contracts/ir-identity.js";
import { nativeSourceObjectResourceKey } from "../resources/native-source-objects.js";
import { nativeCallAbiBindings, type NativeInvocationAbiBinding } from "./native-invocation-abi.js";

export interface NativeSourceObjectPhysicalSetup {
  readonly key: string;
  readonly bindings: readonly NativeInvocationAbiBinding[];
}

/** The rows for every object use the realm selected, or a gap per contract with no native source provider. */
export function planNativeSourceObjectSetup(
  realm: NativeRealmRequirements | undefined,
  declarationOrder: number,
): {
  readonly setup: NativeSourceObjectPhysicalSetup | undefined;
  readonly gaps: readonly { readonly detail: string; readonly unitId: IrUnitId }[];
} {
  const uses = realm?.description.objectUses ?? [];
  if (!realm || uses.length === 0) return { setup: undefined, gaps: [] };
  const gaps: { detail: string; unitId: IrUnitId }[] = [];
  const served = uses.flatMap((use) => {
    const resourceKey = nativeSourceObjectResourceKey(realm.description.key, use.feature);
    if (resourceKey === undefined) {
      gaps.push({ detail: `${use.feature} has no native source provider`, unitId: use.ownerUnitId });
      return [];
    }
    return [{ occurrence: use.occurrence, ownerUnitId: use.ownerUnitId, resourceKey }];
  });
  const bindings = nativeCallAbiBindings(realm.access.demands, served, declarationOrder, "native source object ABI");
  return { setup: { key: realm.description.key, bindings }, gaps };
}
