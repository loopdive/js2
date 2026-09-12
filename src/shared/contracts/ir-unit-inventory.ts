// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrSourceId, IrUnitId, IrClassId, IrLexicalOwnerId, IrSyntheticUnitRole } from "./ir-identity.js";
import type { CompilerSourceProducer } from "./source-origin.js";
import type { IrPreparationFailure } from "./ir-preparation-failure.js";

export type IrSourceKind = "entry" | "source" | "library" | "synthetic";

/** Compiler-created class roles live in a namespace separate from source classes. */
export type IrSyntheticClassRole = `compiler-class:${CompilerSourceProducer}:${string}`;

export type IrUnitKind =
  | "top-level-function"
  | "nested-function"
  | "function-expression"
  | "arrow-function"
  | "class-constructor"
  | "class-implicit-constructor"
  | "class-instance-method"
  | "class-static-method"
  | "class-instance-getter"
  | "class-static-getter"
  | "class-instance-setter"
  | "class-static-setter"
  | "class-instance-field-initializer"
  | "class-static-field-initializer"
  | "class-static-block"
  | "object-method"
  | "object-getter"
  | "object-setter"
  | "export-assignment"
  | "module-init"
  | "synthetic-support";

export type IrTerminalObservedKind = "function" | "class-member" | "module-init";

export type IrUnownedUnitReason = "no-r0-attempt-root";

export interface IrSourceRecord {
  readonly id: IrSourceId;
  readonly kind: IrSourceKind;
  /** Dependency-first order with canonical tie-breaking, never caller Map order. */
  readonly order: number;
  /** Normalized program-relative key. Absolute checkout roots are removed. */
  readonly sourceKey: string;
  /** Diagnostic label only; it is deliberately not part of semantic lookup. */
  readonly displayName: string;
  /** Original TypeScript filename, retained only to join compiler-owned ASTs. */
  readonly originalFileName: string;
}

export interface IrClassRecord {
  readonly id: IrClassId;
  readonly sourceId: IrSourceId;
  readonly lexicalOwnerId: IrLexicalOwnerId | null;
  readonly declarationKind: "declaration" | "expression";
  readonly ordinal: number;
  /** Present only when the class identity is derived from a compiler role. */
  readonly syntheticRole?: IrSyntheticClassRole;
  readonly displayName: string;
  readonly line: number;
  readonly column: number;
  readonly declarationStart: number;
  readonly declarationEnd: number;
}

interface IrUnitRecordBase {
  readonly id: IrUnitId;
  readonly sourceId: IrSourceId;
  readonly lexicalOwnerId: IrLexicalOwnerId | null;
  readonly kind: IrUnitKind;
  /** Declaration ordinal within the structural owner and unit kind. */
  readonly ordinal: number;
  /** Present only when the unit identity is derived from a compiler/pass role. */
  readonly syntheticRole?: IrSyntheticUnitRole;
  /** Diagnostic label only. It is never used to encode the identity. */
  readonly displayName: string;
  readonly line: number;
  readonly column: number;
  /** Source-relative declaration span for validated AST→identity joins. */
  readonly declarationStart: number;
  readonly declarationEnd: number;
}

export interface IrOwnedSupportUnitRecord extends IrUnitRecordBase {
  readonly terminal: false;
  readonly terminalOwnerId: IrUnitId;
  readonly unownedReason?: never;
}

export interface IrUnownedSupportUnitRecord extends IrUnitRecordBase {
  readonly terminal: false;
  readonly terminalOwnerId: null;
  readonly unownedReason: IrUnownedUnitReason;
}

/** Exact structural counterpart of one existing R0 terminal outcome row. */
export interface IrTerminalUnitRecord extends IrUnitRecordBase {
  readonly terminal: true;
  readonly terminalOwnerId: IrUnitId;
  /**
   * Exact enclosing executable when a bounded nested body is promoted to its
   * own terminal. This is a component edge only: ownership and outcome
   * routing remain keyed by this terminal's own id.
   */
  readonly containingTerminalOwnerId?: IrUnitId;
  readonly unownedReason?: never;
  readonly observedKind: IrTerminalObservedKind;
  readonly legacyKey: string;
  readonly legacyMatchName: string;
  readonly legacyOrdinal: number;
  readonly staticClassMember: boolean;
  readonly legacyBodyAvailable: boolean;
  readonly directFailure?: IrPreparationFailure;
}

export type IrUnitRecord = IrTerminalUnitRecord | IrOwnedSupportUnitRecord | IrUnownedSupportUnitRecord;

export interface IrUnitInventory {
  readonly sources: readonly IrSourceRecord[];
  readonly classes: readonly IrClassRecord[];
  /** Exhaustive source-AST/compiler-prelude population for the R1a boundary. */
  readonly allUnits: readonly IrUnitRecord[];
  /** Exact R0 attempt-root population; no support unit manufactures a row. */
  readonly terminalUnits: readonly IrTerminalUnitRecord[];
}
