// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// (#3521 R2-T1) Dependency half of the two-file host graph that drives the
// multi-source overlay driver. Kept trivially preparable so the ONLY reason its
// row is compile-twice is the driver itself.
export function helper(a: number): number {
  return a + 1;
}
