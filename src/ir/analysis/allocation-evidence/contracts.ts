// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AllocSiteId, IrBlockId, IrSiteId, IrBlock, IrFunction, IrInstr, IrValueId } from "../../core/nodes.js";
import type { IrType } from "../../core/types.js";
import type { IrUnitId } from "../../../shared/contracts/ir-identity.js";

/** Observed global namespace materialization, never inferred producer controls. */
export type AllocationEvidenceNamespaceMode =
  | "encoding-only"
  | "ownership-only"
  | "escape-only"
  | "ownership-and-escape";

export interface AllocationEvidenceCensus {
  readonly functions: number;
  readonly buffers: number;
  readonly instructions: number;
  readonly allocations: number;
  readonly vectorReads: number;
  readonly vectorWrites: number;
  readonly registrySlots: number;
}

export type AllocationEvidenceLocation =
  | { readonly kind: "module" }
  | { readonly kind: "function"; readonly unitId: IrUnitId }
  | { readonly kind: "site"; readonly site: AllocSiteId }
  | {
      readonly kind: "instruction";
      readonly unitId: IrUnitId;
      readonly block: IrBlockId;
      readonly root: number;
      readonly arms: readonly { readonly arm: "then" | "else"; readonly index: number }[];
      readonly site?: IrSiteId;
    };

export type AllocationEvidenceCoverageReason =
  | "function-shape"
  | "instruction-kind"
  | "numeric-opcode"
  | "reference-carrier"
  | "nested-allocation"
  | "nonroot-receiver"
  | "allocation-alias"
  | "async-domain"
  | "resource-limit";

export type AllocationEvidenceMismatch =
  | "namespace-presence"
  | "namespace-value"
  | "unused-site-evidence"
  | "noncanonical-ownership-marker"
  | "occurrence-mismatch"
  | "lexical-definition"
  | "allocation-provenance"
  | "site-result-type";

/** An ephemeral report on the supplied operands, not a transferable capability. */
export type AllocationEvidenceCheck =
  | {
      readonly kind: "verified";
      readonly profile: "single-block-numeric-vector-if-v1";
      readonly namespaces: AllocationEvidenceNamespaceMode;
      readonly census: AllocationEvidenceCensus;
    }
  | {
      readonly kind: "not-covered";
      readonly reason: AllocationEvidenceCoverageReason;
      readonly at: AllocationEvidenceLocation;
    }
  | {
      readonly kind: "invalid";
      readonly code: AllocationEvidenceMismatch;
      readonly at: AllocationEvidenceLocation;
    };

export type AllocationEvidenceFailure = Exclude<AllocationEvidenceCheck, { readonly kind: "verified" }>;

/** Directory-internal traversal positions; only the public location is reported. */
export interface AllocationEvidenceArmPath {
  readonly parent?: AllocationEvidenceArmPath;
  readonly arm: "then" | "else";
  readonly index: number;
}
export interface AllocationEvidenceCursor {
  readonly fn: IrFunction;
  readonly block: IrBlock;
  readonly root: number;
  readonly instr: IrInstr;
  readonly path?: AllocationEvidenceArmPath;
}

export interface AllocationEvidenceArmResult {
  readonly value: IrValueId;
  readonly type: IrType;
  readonly at: AllocationEvidenceCursor;
}
export interface AllocationEvidenceBufferTask {
  readonly kind: "enter" | "buffer";
  readonly buffer: readonly IrInstr[];
  readonly index: number;
  readonly mark: number;
  readonly parent?: AllocationEvidenceCursor;
  readonly arm?: "then" | "else";
  readonly end?: AllocationEvidenceArmResult;
}
export type AllocationEvidenceTask =
  | AllocationEvidenceBufferTask
  | { readonly kind: "define"; readonly at: AllocationEvidenceCursor };
