// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ValType } from "../../../wasm/model/instructions.js";
import type { FieldDef } from "../../../wasm/model/module-records.js";

export type NativeDeclaredValType =
  | Exclude<ValType, { kind: "ref" | "ref_null" }>
  | { readonly kind: "ref" | "ref_null"; readonly typeKey: string };
export interface NativeDeclaredSignature {
  readonly params: readonly NativeDeclaredValType[];
  readonly results: readonly NativeDeclaredValType[];
}
export type NativeDeclaredName =
  | string
  | { readonly kind: "array-ref-index" | "builtin-function-metadata-index"; readonly typeKey: string };
export type NativeDeclaredType =
  | {
      readonly kind: "struct";
      readonly name: NativeDeclaredName;
      readonly fields: readonly (Omit<FieldDef, "type"> & { readonly type: NativeDeclaredValType })[];
      readonly parent?: { readonly kind: "root" } | { readonly kind: "resource"; readonly typeKey: string };
      readonly final?: boolean;
    }
  | {
      readonly kind: "array";
      readonly name: NativeDeclaredName;
      readonly element: NativeDeclaredValType;
      readonly mutable: boolean;
    };
export type NativeStringValueDeclaration = { readonly key: string; readonly role: readonly string[] } & (
  | { readonly space: "type"; readonly shape: NativeDeclaredType }
  | {
      readonly space: "global";
      readonly name: string;
      readonly valueType: NativeDeclaredValType;
      readonly mutable: boolean;
    }
  | { readonly space: "function"; readonly name: string; readonly signature: NativeDeclaredSignature }
);
export type NativeStringValueReservationStep = { readonly phase: "string-types" | "resources" } & (
  | { readonly kind: "reserve"; readonly resourceKey: string }
  | {
      readonly kind: "intern-signature";
      readonly signature: NativeDeclaredSignature;
      readonly key?: string;
      readonly name?: string;
    }
);
export interface NativeResourceRecipe {
  readonly declarations: readonly NativeStringValueDeclaration[];
  readonly reservationSteps: readonly NativeStringValueReservationStep[];
}
