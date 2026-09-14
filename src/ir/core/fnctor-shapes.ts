// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrSourceId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrType, IrTypeRef } from "./types.js";
import type { IrFuncRef } from "./value-references.js";

export interface IrFnctorField {
  readonly name: string;
  readonly type: IrType;
  /** Stable field ordinal in the reserved constructor layout. */
  readonly ordinal: number;
}

export interface IrFnctorCapture {
  readonly name: string;
  readonly type: IrType;
  /** Whether this capture carries the paired TDZ flag parameter. */
  readonly hasTdzFlag: boolean;
  /** Stable capture ordinal in the constructor ABI. */
  readonly ordinal: number;
}

/**
 * Nominal, source-qualified shape of one approved function-style constructor.
 * `name` fields are diagnostics only; source/unit/layout bindings are the
 * semantic identity and must be checked by every resolver.
 */
export interface IrFnctorShape {
  readonly kind: "fnctor-shape";
  readonly sourceId: IrSourceId;
  readonly constructorUnitId: IrUnitId;
  readonly constructorName: string;
  readonly constructorTarget: IrFuncRef;
  /** Symbolic identity of the reserved `__fnctor_<name>` struct layout. */
  readonly reservedLayout: IrTypeRef;
  readonly fields: readonly IrFnctorField[];
  readonly captures: readonly IrFnctorCapture[];
  readonly userParamTypes: readonly IrType[];
  /** Whether the active ABI carries the final hidden externref identity argument. */
  readonly hiddenIdentity: boolean;
  /** Identity metadata remains source/unit-qualified even when the active ABI omits the operand (WASI). */
  readonly constructorIdentity: {
    readonly unitId: IrUnitId;
    readonly paramIndex: number;
  };
}
