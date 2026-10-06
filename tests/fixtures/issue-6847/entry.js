// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Untyped JS on purpose (#6847): the shape of hono's `parseSigned` — an async
// for-of over `Object.entries(…)` with a destructured head, guard-clause
// `continue`s, and an `await` in the body.

const check = async (value) => {
  await null;
  return value.length > 1;
};

// Defect 2: the for-of is the body's only non-linear construct.
export async function forOfOnly(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const ok = await check(value);
    out[key] = ok ? value : false;
  }
  return JSON.stringify(out);
}

// Defect 3: destructured head names read in a state after the suspension.
export async function destructuredAcrossAwait(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value.length >= 1) {
      const ok = await check(value);
      out[key] = ok ? value : false;
    }
  }
  return JSON.stringify(out);
}

// Defect 1: `continue` guard clauses — two of them, as in `parseSigned`.
export async function continueGuards(obj) {
  const out = {};
  const prefix = await Promise.resolve("");
  for (const [key, value] of Object.entries(obj)) {
    const dot = value.lastIndexOf(".");
    if (dot < 1) {
      continue;
    }
    const head = value.substring(0, dot);
    if (head === "skip") continue;
    const ok = await check(value.substring(dot + 1));
    out[prefix + key] = ok ? head : false;
  }
  return JSON.stringify(out);
}
