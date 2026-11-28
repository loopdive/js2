// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { agreesWithNode, freshRealmOut, refusal, runnerOptions } from "./helpers/prepared-node-agreement.js";

it.each([
  ["booleans", 'var out = ~true + "," + ~false;'],
  ["strings and 32-bit wrapping", 'var out = ~"4294967296" + "," + ~"-1.5" + "," + ~"xyz";'],
  ["null and undefined", 'var out = ~null + "," + ~undefined;'],
  [
    "valueOf before toString",
    'var log={s:""}; var obj={valueOf:function(){log.s=log.s+"v";return {};},toString:function(){log.s=log.s+"s";return "4";}}; var out=(~obj)+log.s;',
  ],
  [
    "abrupt operand",
    'var out="returned"; function read(fail){if(fail)throw "operand";return 1;} try {~read(true);} catch(e) {out=e;}',
  ],
])(
  "matches Node for %s",
  async (_, body) => {
    await agreesWithNode(body, true, runnerOptions(), freshRealmOut);
  },
  180000,
);

it("refuses an unsupported BigInt operand", async () => {
  expect(await refusal("var n=1n;var out=~n;if(out!==-2n)throw 1;", runnerOptions())).toContain("BigIntLiteral");
});
