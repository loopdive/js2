// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { it } from "vitest";
import { agreesWithNode, freshRealmOut, runnerOptions } from "./helpers/prepared-node-agreement.js";

it.each([
  ["fallthrough", 'var n=0; function f(){n=n+1;} var out=f()===undefined ? "yes"+n : "wrong";'],
  ["bare return", 'function f(){return;} var out=f()===undefined ? "yes" : "wrong";'],
  [
    "an exception propagates",
    'function fail(){throw 7;} var out="returned"; try {fail()===undefined;} catch(e){out=e===7?"caught":"wrong";}',
  ],
  ["an actual value survives", 'function f(){return 42;} var out=f()===42?"value":"wrong";'],
])("%s", async (_, source) => {
  await agreesWithNode(source, true, runnerOptions(), freshRealmOut);
});
