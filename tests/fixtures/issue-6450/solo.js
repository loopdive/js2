// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The bare reduction from the #6450 report: no same-named function anywhere in
// the graph, and the BARE `'crypto'` specifier rather than `'node:crypto'`.
// Before the fix the ladder reached its graceful `ref.null.extern` default, so
// `createHash("sha256")` was null and `.update` threw off null.

import { createHash } from "crypto";

export function hex() {
  return createHash("sha256").update("a").digest("hex");
}
