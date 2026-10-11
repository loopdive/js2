// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Untyped JS on purpose (#6885): an array literal whose element ZERO is an
// object BINDING (not an inline literal) and whose later elements are
// primitives — the shape of test262's Temporal wrong-type tables
// (`[tooEarly, tooLate, "-271821-04-18", "+275760-09-14"]`).

export function bindingThenString() {
  const o = { a: 1 };
  const arr = [o, "s"];
  return JSON.stringify(arr) + " " + typeof arr[1];
}

export function bindingThenNumber() {
  const o = { a: 1 };
  const arr = [o, 5];
  return JSON.stringify(arr) + " " + typeof arr[1];
}

export function temporalTable() {
  const tooEarly = { year: -271821, month: 4, day: 18 };
  const tooLate = { year: 275760, month: 9, day: 14 };
  const out = [];
  for (const value of [tooEarly, tooLate, "-271821-04-18", "+275760-09-14"]) {
    out.push(typeof value);
  }
  return out.join(",");
}

// Controls that answered correctly before the fix: an inline object literal
// first, a string first, and a homogeneous object table.
export function inlineThenString() {
  return JSON.stringify([{ a: 1 }, "s"]);
}

export function stringThenBinding() {
  const o = { a: 1 };
  return JSON.stringify(["s", o]);
}

export function homogeneous() {
  const a = { k: 1 };
  const b = { k: 2 };
  return [a, b].map((v) => v.k).join(",");
}
