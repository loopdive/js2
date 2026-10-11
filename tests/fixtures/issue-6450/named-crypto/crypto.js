// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// hono's `dist/utils/crypto.js` shape (#6450): a module FILE named `crypto.js`
// in the graph that exports an ASYNC `createHash`. The checker's resolved
// signature for the entry's builtin `createHash('sha256')` call lands on THIS
// async arrow, so the async-call repair wrapped the builtin's Hash in
// `Promise_resolve` and `.update` was "not a function".

var createHash = async (data, algorithm) => {
  return "lib:" + algorithm + ":" + data;
};

var sha256 = async (data) => {
  const hash = await createHash(data, "SHA-256");
  return hash;
};

export { createHash, sha256 };
