// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrClassId, IrSourceId, IrUnitId } from "../../shared/contracts/ir-identity.js";

export type IrModuleInitTarget = "host" | "standalone" | "wasi";
export type IrModuleInitInvocationKind = "none" | "wasm-start" | "deferred-export" | "wasi-start-export";

export interface IrModuleInitInvocationPolicy {
  readonly target: IrModuleInitTarget;
  readonly kind: IrModuleInitInvocationKind;
  readonly exactlyOnce: true;
}

export type IrModuleBindingDeclarationKind = "var" | "let" | "const";

export interface IrModuleInitBindingIntent {
  readonly declarationOrdinal: number;
  readonly names: readonly string[];
  readonly declarationKind: IrModuleBindingDeclarationKind;
  readonly mutable: boolean;
  readonly initialization: "undefined-at-instantiation" | "tdz";
  readonly globalBindingId: IrBindingId | null;
  readonly tdzBindingId: IrBindingId | null;
  readonly start: number;
  readonly end: number;
}

export interface IrModuleInitLiveSeedIntent {
  readonly name: string;
  readonly unitId: IrUnitId;
  readonly callableBindingId: IrBindingId;
  readonly liveGlobalBindingId: IrBindingId;
  readonly declarationOrdinal: number;
  readonly legacyKey: string;
}

export type IrModuleInitEvaluationKind =
  | "statement"
  | "variable-initializer"
  | "export-assignment"
  | "class-static-field"
  | "class-static-block";

export interface IrModuleInitEvaluationEntry {
  readonly key: string;
  readonly kind: IrModuleInitEvaluationKind;
  readonly sourceOrdinal: number;
  readonly statementOrdinal: number;
  readonly nestedOrdinal: number;
  readonly start: number;
  readonly end: number;
  readonly classId: IrClassId | null;
  readonly bindingIds: readonly IrBindingId[];
  /** Exact legacy queue identity used only by the migration parity observer. */
  readonly legacyKey: string;
}

export interface IrModuleInitExportIntent {
  readonly externalName: string;
  readonly localName: string | null;
  readonly targetBindingId: IrBindingId | null;
  readonly start: number;
  readonly end: number;
}

export type IrModuleInitPlanGapCode =
  | "missing-module-init-unit"
  | "destructuring-binding-abi"
  | "unresolved-export-target";

export interface IrModuleInitPlanGap {
  readonly code: IrModuleInitPlanGapCode;
  readonly detail: string;
  readonly start: number;
  readonly end: number;
}

/** Immutable, backend-neutral semantic inventory for one source module. */
export interface IrModuleInitPlan {
  readonly sourceId: IrSourceId;
  readonly unitId: IrUnitId | null;
  readonly executable: boolean;
  readonly bindings: readonly IrModuleInitBindingIntent[];
  readonly liveSeeds: readonly IrModuleInitLiveSeedIntent[];
  readonly evaluations: readonly IrModuleInitEvaluationEntry[];
  readonly exports: readonly IrModuleInitExportIntent[];
  readonly invocation: IrModuleInitInvocationPolicy;
  readonly gaps: readonly IrModuleInitPlanGap[];
}
