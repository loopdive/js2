// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// hono `src/utils/crypto.test.ts` imports: the BARE `'crypto'` builtin plus a
// sibling module that is itself named `crypto.js` (#6450).

import { createHash } from "crypto";
import { sha256 } from "./crypto.js";

export function hex() {
  return createHash("sha256").update("a").digest("hex");
}

export function viaLib(data) {
  return sha256(data);
}
