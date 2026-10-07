// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Untyped JS on purpose (#6846): every row is an `await` nested inside its
// statement whose only pre-await work is replay-safe (a const / function /
// import read, a literal, a stable ambient such as `String`).

import { arrowStr, pair, sus } from "./lib.js";

function show(value) {
  return typeof value + ":" + String(value);
}

export async function callArgument() {
  return show(await sus());
}

export async function binaryOperand() {
  return "x" + (await sus());
}

export async function destructuredInitializer() {
  const [a, b] = await pair();
  return a + b;
}

export async function objectLiteralProperty() {
  const init = { body: await sus(), n: 1 };
  return init.body + init.n;
}

export async function ambientCallee() {
  return String(await arrowStr("ok"));
}

export async function settledOperand() {
  return show(await Promise.resolve("p"));
}
