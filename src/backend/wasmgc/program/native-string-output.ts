// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  assertNativeStringOutputRequirementsCurrent,
  type NativeStringOutputOptions,
  type NativeStringOutputRequirements,
} from "../../../ir/program/native-string-output-requirements.js";
import { freezePreparedIrValue } from "../../../ir/program/data.js";
import type {
  NativeStringValueDeclaration,
  NativeStringValueReservationStep,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { declareNativeStringOutputResources } from "../resources/native-string-output.js";

export interface NativeStringOutputPhysicalPlan {
  readonly key: string;
  readonly stringKey: string;
  readonly flattenKey: string;
  readonly options: NativeStringOutputOptions;
  readonly binaryConcat: boolean;
  readonly batchArities: readonly number[];
  readonly stdout: boolean;
  readonly declarations: readonly NativeStringValueDeclaration[];
  readonly reservationSteps: readonly NativeStringValueReservationStep[];
}

/** Description only; the resource owner authenticates the exact admitted dependencies. */
export function planNativeStringOutputResources(
  requirements: NativeStringOutputRequirements,
  keys: { readonly key: string; readonly stringKey: string; readonly flattenKey: string },
): NativeStringOutputPhysicalPlan {
  assertNativeStringOutputRequirementsCurrent(requirements);
  const { key, stringKey, flattenKey } = freezePreparedIrValue(keys) as typeof keys;
  if (typeof flattenKey !== "string" || !flattenKey) throw new Error("native string output: invalid flatten key");
  const { binaryConcat, batchArities, stdout, options } = requirements;
  const recipe = declareNativeStringOutputResources(key, stringKey, { binaryConcat, batchArities, stdout });
  return freezePreparedIrValue({
    key,
    stringKey,
    flattenKey,
    options,
    binaryConcat,
    batchArities,
    stdout,
    ...recipe,
  }) as NativeStringOutputPhysicalPlan;
}
