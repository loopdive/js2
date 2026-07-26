// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrClosureSignature, IrType } from "./nodes.js";

export interface IrImportedOptionalParamPlan {
  readonly constantDefault?:
    | { readonly kind: "f64"; readonly value: number }
    | { readonly kind: "i32"; readonly value: number };
  readonly hasExpressionDefault?: boolean;
}

export interface IrImportedCallLoweringPlan {
  /** Module-body import or same-file ambient host import (#3657). */
  readonly source: "module-import" | "ambient-host";
  readonly ownerName: string;
  readonly targetName: string;
  readonly params: readonly IrType[];
  readonly returnType: IrType | null;
  readonly optionalParams: ReadonlyMap<number, IrImportedOptionalParamPlan>;
  readonly needsArgc: boolean;
}

export interface IrTopLevelFunctionValueLoweringPlan {
  readonly ownerName: string;
  readonly targetName: string;
  readonly signature: IrClosureSignature;
  readonly trampolineName: string;
  readonly cacheGlobalName: string;
}

export interface IrHostVoidCallbackLoweringPlan {
  readonly ownerName: string;
  readonly signature: IrClosureSignature;
  readonly captureNames: ReadonlySet<string>;
  /** Exact source-order lift ordinal collision-proved before integration. */
  readonly liftedOrdinal: number;
}
