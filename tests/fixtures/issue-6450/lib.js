// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// hono's own `src/utils/crypto.ts` shape (#6450): a module in the graph that
// exports an ASYNC function under the very name the entry imports from the
// node builtin. `closureMap`/`funcMap` are keyed by the bare identifier across
// the whole linked graph, so before the fix the entry's `createHash('sha256')`
// called THIS function and its Promise answered `update is not a function`.

export const createHash = async (data, algorithm) => {
  return "lib:" + algorithm + ":" + data;
};

export function sha256(data) {
  return createHash(data, "SHA-256");
}
