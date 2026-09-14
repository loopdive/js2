// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrSourceId, IrUnitId } from "./ir-identity.js";

declare const irCountedStringAppendSiteIdBrand: unique symbol;

/** Immutable source-qualified identity for one checker-proven counted append loop. */
export type IrCountedStringAppendSiteId = string & {
  readonly [irCountedStringAppendSiteIdBrand]: "IrCountedStringAppendSiteId";
};

/** Identity primitives retained after the live AST proof has been validated. */
export interface IrCountedStringAppendSiteIdentity {
  readonly sourceId: IrSourceId;
  readonly ownerUnitId: IrUnitId;
  readonly loopStart: number;
  readonly loopEnd: number;
}

/** Untrusted site claim paired with the exact identity it is expected to represent. */
export interface IrCountedStringAppendSiteClaim extends IrCountedStringAppendSiteIdentity {
  readonly siteId: string;
}
