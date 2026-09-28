// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ts } from "../ts-api.js";

/** A compiler limitation anchored to the source operation it cannot preserve. */
export interface UnsafeTypeAssumption {
  node: ts.Node;
  id: string;
  message: string;
}
