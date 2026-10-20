// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  AllocSiteId,
  IrConst,
  IrDeclaredSignature,
  IrModule,
  IrValueId,
  IrFunction,
} from "../../../core/nodes.js";
import type { IrType } from "../../../core/types.js";
import type { IrFuncRef, IrGlobalRef } from "../../../core/value-references.js";
import type { IrBindingId, IrClassId, IrUnitId } from "../../../../shared/contracts/ir-identity.js";
import type { IrJsClassBody, IrJsClassDefinition, IrJsClassRole } from "../../../core/js-class-contracts.js";

export type NativeJsValueFamily = "Undefined" | "Null" | "Number" | "Boolean" | "String" | "Object" | "Function";
export type NativeJsValueRoot =
  | {
      readonly kind: "allocation";
      readonly unitId: IrUnitId;
      readonly site: AllocSiteId;
      readonly definitionId: IrBindingId | null;
      readonly view: IrJsClassRole;
      readonly memberOrdinal: number | null;
    }
  | { readonly kind: "external"; readonly bindingId: IrBindingId };
export type NativeJsValueDomain =
  | { readonly kind: "bottom" }
  | { readonly kind: "unknown" }
  | {
      readonly kind: "known";
      readonly families: readonly NativeJsValueFamily[];
      readonly roots: readonly NativeJsValueRoot[];
    };
export interface NativeJsClassValueDomainLocation {
  readonly unitId: IrUnitId;
  readonly blockOrdinal: number;
  /** Alternating nested-buffer ordinal and enclosing instruction ordinal from the block. */
  readonly nestedPath: readonly number[];
  readonly instructionOrdinal: number;
}
export type NativeJsClassValueDomainReason =
  | "unknown-callee"
  | "incomplete-population"
  | "opaque-effect"
  | "unsupported-value"
  | "unsupported-control"
  | "missing-argument-adaptation"
  | "default-ordering"
  | "mutable-binding-carrier"
  | "unsafe-scalar-projection"
  | "unknown-property"
  | "absent-currentness";
export interface NativeJsClassValueDomainObligation {
  readonly location: NativeJsClassValueDomainLocation | null;
  readonly unitId: IrUnitId | null;
  readonly reason: NativeJsClassValueDomainReason;
}
export interface NativeJsClassValueDomainUnit {
  readonly unitId: IrUnitId;
  readonly kind: "source" | "derived" | "builtin";
  readonly sourceClassId: IrClassId | null;
  readonly sourceBodyKind: IrJsClassBody["sourceBodyKind"] | null;
  readonly target: IrFuncRef;
}
export interface NativeJsClassValueDomainGlobal {
  readonly ref: IrGlobalRef;
  readonly type: IrType;
  readonly mutable: boolean;
  readonly initial:
    | { readonly kind: "uninitialized" }
    | { readonly kind: "constant"; readonly value: IrConst }
    | { readonly kind: "issued-builtin"; readonly target: IrFuncRef }
    | { readonly kind: "unknown" };
}
export interface NativeJsClassRuntimeDataRecord {
  readonly [field: string]: unknown;
}
export interface NativeJsClassRuntimeContext {
  readonly inventory: import("../../../../shared/contracts/ir-unit-inventory.js").IrUnitInventory;
  readonly derivedUnits: readonly NativeJsClassRuntimeDataRecord[];
  readonly abiEntries: readonly NativeJsClassRuntimeDataRecord[];
  readonly startup: readonly NativeJsClassRuntimeDataRecord[];
  readonly original: Pick<IrModule, "functions">;
  readonly runtimeSupport: NativeJsClassRuntimeDataRecord | null;
  readonly projections: readonly {
    readonly backend: string;
    readonly target: string;
    readonly functions: readonly IrFunction[];
    readonly manifest: NativeJsClassRuntimeDataRecord;
    readonly providers: readonly {
      readonly intrinsicId: string;
      readonly plan: NativeJsClassRuntimeDataRecord;
    }[];
  }[];
}
export interface NativeJsClassValueDomainInput {
  readonly runtimeContext?: NativeJsClassRuntimeContext;
  readonly schema: "native-js-class-value-domain-input-v1";
  readonly namespace: "original" | "selected";
  /** Actual complete functions; declared Maps are normalized by the owning orchestration below. */
  readonly module: Pick<IrModule, "functions">;
  readonly declarations: {
    readonly signatures: readonly { readonly key: string; readonly signature: IrDeclaredSignature }[];
    readonly globals: readonly { readonly key: string; readonly type: IrType }[];
  };
  readonly units: readonly NativeJsClassValueDomainUnit[];
  readonly definitions: readonly { readonly bindingId: IrBindingId; readonly definition: IrJsClassDefinition }[];
  readonly globals: readonly NativeJsClassValueDomainGlobal[];
  /** Exact authenticated startup invocation sequence, not descriptor order inferred by this analysis. */
  readonly startupUnits: readonly IrUnitId[];
  readonly exports: readonly {
    readonly externalName: string;
    readonly target: IrFuncRef;
    readonly logicalParams: readonly IrType[];
    readonly logicalResult: IrType | null;
  }[];
  readonly entryInputs: readonly {
    readonly unitId: IrUnitId;
    readonly parameter: number;
    readonly transport: "external-js" | "scalar-ir";
    readonly type: IrType;
  }[];
}
export interface NativeJsClassValueDomainTarget {
  readonly target: IrFuncRef;
  readonly unitId: IrUnitId;
  readonly definitionId: IrBindingId | null;
  readonly sourceBodyKind: IrJsClassBody["sourceBodyKind"] | null;
}
export interface NativeJsClassValueDomainHeapCell {
  readonly root: NativeJsValueRoot;
  readonly key:
    | { readonly kind: "literal"; readonly value: string }
    | { readonly kind: "wildcard" }
    | { readonly kind: "internal"; readonly value: string };
  readonly presence: "absent" | "present" | "maybe";
  readonly valueDomain: NativeJsValueDomain;
  readonly prototypeRoots: readonly NativeJsValueRoot[];
}
export interface NativeJsClassValueDomainResult {
  readonly schema: "native-js-class-value-domain-result-v1";
  readonly namespace: "original" | "selected";
  readonly census: {
    readonly functions: number;
    readonly instructions: number;
    readonly parameters: number;
    readonly blockArguments: number;
    readonly definitions: number;
    readonly globals: number;
    readonly invokes: number;
    readonly constructs: number;
  };
  readonly values: readonly {
    readonly unitId: IrUnitId;
    readonly value: IrValueId;
    readonly domain: NativeJsValueDomain;
  }[];
  readonly calls: readonly {
    readonly location: NativeJsClassValueDomainLocation;
    readonly kind: "invoke" | "construct" | "direct";
    readonly calleeDomain: NativeJsValueDomain;
    readonly receiverDomain: NativeJsValueDomain | null;
    readonly argumentDomains: readonly NativeJsValueDomain[];
    readonly targets: readonly NativeJsClassValueDomainTarget[];
    readonly normalDomain: NativeJsValueDomain;
    readonly mayThrow: boolean;
    readonly obligations: readonly NativeJsClassValueDomainObligation[];
  }[];
  readonly functions: readonly {
    readonly unitId: IrUnitId;
    readonly parameterDomains: readonly NativeJsValueDomain[];
    readonly normalResultDomains: readonly NativeJsValueDomain[];
    /** Distinguish reachable empty return from a nonreturning zero-result function. */
    readonly normalCompletion: boolean;
    readonly mayThrow: boolean;
    readonly readsGlobals: readonly IrBindingId[];
    readonly writesGlobals: readonly IrBindingId[];
    readonly escapedRoots: readonly NativeJsValueRoot[];
  }[];
  readonly globals: readonly {
    readonly bindingId: IrBindingId;
    readonly initialization: "uninitialized" | "initialized" | "maybe";
    readonly domain: NativeJsValueDomain;
  }[];
  readonly heap: readonly NativeJsClassValueDomainHeapCell[];
  /** Complete authentic CFG/call edges; independent replay solves its own least fixed point. */
  readonly edges: readonly {
    readonly fromUnitId: IrUnitId;
    readonly fromBlockOrdinal: number;
    readonly toUnitId: IrUnitId;
    readonly toBlockOrdinal: number;
    readonly kind: "cfg" | "call" | "startup";
  }[];
  readonly projections: readonly {
    readonly externalName: string;
    readonly target: IrFuncRef;
    readonly normalDomain: NativeJsValueDomain;
    readonly decision: "number" | "boolean" | "void-undefined" | "dynamic-required" | "unknown";
    readonly obligations: readonly NativeJsClassValueDomainObligation[];
  }[];
  readonly obligations: readonly NativeJsClassValueDomainObligation[];
}
export interface NativeJsClassValueDomainProblem {
  readonly reason: "invalid-input" | "invalid-output" | "population" | "equation" | "projection";
  readonly unitId: IrUnitId | null;
  readonly detail: string;
}
