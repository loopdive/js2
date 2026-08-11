// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrHostDateSnapshotGetter } from "./ast-lowering-plans.js";

export const IR_DATE_SNAPSHOT_GETTER_PREFIX = "date.snapshot.get:";

export function irDateSnapshotGetterSymbol(getter: IrHostDateSnapshotGetter): string {
  return `${IR_DATE_SNAPSHOT_GETTER_PREFIX}${getter}`;
}

export function parseIrDateSnapshotGetter(symbol: string): IrHostDateSnapshotGetter | undefined {
  if (!symbol.startsWith(IR_DATE_SNAPSHOT_GETTER_PREFIX)) return undefined;
  const getter = symbol.slice(IR_DATE_SNAPSHOT_GETTER_PREFIX.length);
  return getter === "getDate" || getter === "getMonth" || getter === "getFullYear" ? getter : undefined;
}
