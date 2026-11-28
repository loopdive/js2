// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { agreesWithNode, freshRealmOut, refusal, runnerOptions } from "./helpers/prepared-node-agreement.js";

it.each([
  ["prefix and postfix in both statement positions", 'var n=4; function f(){--n; (n--);} f(); var out=""+n;'],
  [
    "an update observed before throwing",
    'var n=0; function f(){n++; throw 7;} var out=""; try{f();}catch(e){out=""+n+e;}',
  ],
  [
    "an update in a conversion method",
    'var n=0; var o={valueOf:function(){n++;return 7;}}; var out=Number(o)===7 && n===1 ? "ok":"wrong";',
  ],
  ["a shadowing parameter", 'var n=9; function f(n){n++; return n;} var out=f(1)===2 && n===9 ? "ok" : "wrong";'],
  [
    "effects inside a loop and a trailing assignment",
    'var n=1; function f(){for(var j=0;j<2;j++){++n;} (n=n+1);} f(); var out=""+n;',
  ],
])("%s", async (_, source) => {
  await agreesWithNode(source, true, runnerOptions(), freshRealmOut);
});

it("keeps a read-only binding out of the write path", async () => {
  expect(await refusal("const n=4; function f(){n++;} f();", runnerOptions())).toMatch(/immutable|const/i);
});
