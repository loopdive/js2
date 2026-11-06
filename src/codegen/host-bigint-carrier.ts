// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Select the arbitrary-width JS BigInt carrier only for host-assisted semantics. */
import { isBigIntType } from "../checker/type-mapper.js";

export function hasStaticBigIntOperand(
  left: Parameters<typeof isBigIntType>[0],
  right: Parameters<typeof isBigIntType>[0],
): boolean {
  return isBigIntType(left) || isBigIntType(right);
}
