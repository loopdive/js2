// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Untyped JS on purpose (#6859): an async function that ASSIGNS one of its own
// identifier parameters before a suspension and reads it after.

const plainAssign = async (x) => {
  x = 2;
  await null;
  return x;
};

const logicalAssign = async (x) => {
  x ||= 3;
  await null;
  return x;
};

// hono `createPool().run`: a nested executor writes the parameter.
const closureAssign = async (fn, promise, resolve) => {
  promise ||= new Promise((r) => (resolve = r));
  const result = await fn();
  if (resolve) {
    resolve(result);
    return promise;
  }
  return -1;
};

const settle = async () => {
  await null;
  return 5;
};

// Anti-vacuity: a parameter that is only READ keeps its value.
const readOnly = async (x) => {
  await null;
  return x;
};

export async function rows() {
  const a = await plainAssign(1);
  const b = await logicalAssign();
  const c = await closureAssign(settle);
  const d = await readOnly(8);
  return a + "," + b + "," + c + "," + d;
}
