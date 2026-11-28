// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { it } from "vitest";
import { agreesWithNode, freshRealmOut, runnerOptions } from "./helpers/prepared-node-agreement.js";

it.each([
  [
    "a callable returned by an expression",
    'function C(){} function get(){return C;} var out=new C() instanceof get() ? "yes" : "no";',
  ],
  [
    "a non-callable after both operands",
    'var n=0; var out="returned"; function left(){n=n+1;return 1;} function right(){n=n+2;return 3;} try {left() instanceof right();} catch(e){out=""+n+(e instanceof TypeError);}',
  ],
  [
    "an exception before the constructor check",
    'var left=function(){throw "left";}; var right=function(){throw "right";}; var out="returned"; try {left() instanceof right();} catch(e){out=e==="left"?"left":"wrong";}',
  ],
])("%s", async (_, source) => {
  await agreesWithNode(source, true, runnerOptions(), freshRealmOut);
});
