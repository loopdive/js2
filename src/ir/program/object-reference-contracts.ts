// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrSourceId } from "../../shared/contracts/ir-identity.js";
import type { IrObjectShape, IrType } from "../core/types.js";
import type { IrFuncRef } from "../core/value-references.js";

/** Logical property-call contract. This does not materialize a physical carrier. */
export interface IrObjectReferencePlan {
  readonly schema: "ir-object-reference-plan-v1";
  readonly sourceId: IrSourceId;
  /** The entire program's record types, including nested storage and callees. */
  readonly shapes: readonly IrObjectShape[];
}

export interface IrObjectReferenceCallable {
  readonly ref: IrFuncRef;
  readonly params: readonly IrType[];
  readonly results: readonly IrType[];
  readonly field: string;
  readonly operation: "get" | "set" | "setSloppy";
  readonly receiver: Extract<IrType, { kind: "object" }>;
}
