// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Untyped JS on purpose (#6450): the `--platform node` lane's DOM-free lib is
// what hono's `src/utils/crypto.test.ts` compiles under, and a `.ts` annotation
// would change how the callee resolves.

import { createHash, randomUUID } from "node:crypto";
import { sha256 } from "./lib.js";

export function hex() {
  return createHash("sha256").update("a").digest("hex");
}

export function uuid() {
  return randomUUID();
}

// Anti-vacuity control: the same bare name, reached through the module that
// actually declares it. The new arm must claim only the IMPORT binding — this
// call has to keep resolving to `lib.js`'s own async function.
export function viaLib(data) {
  return sha256(data);
}
