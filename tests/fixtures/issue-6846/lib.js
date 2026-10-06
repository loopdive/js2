// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6846 — callees that GENUINELY suspend (`await null` / a host promise), so an
// `await` that the async planner declines is observable: the pass-through
// hands the caller the Promise object instead of the settled value.

export async function sus() {
  await null;
  return "v";
}

export async function pair() {
  const first = await Promise.resolve(5);
  return [first, 2];
}

export const arrowStr = async (x) => {
  return await Promise.resolve(x);
};
