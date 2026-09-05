// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// (#3521 R2-T1) Entry half of the two-file host graph — see the sibling dep.
import { helper } from "./issue-3521-r2-multi-dep.js";

export function entryAdd(a: number, b: number): number {
  return helper(a) + b;
}
