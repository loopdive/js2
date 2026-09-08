import { beforeAll, expect, it } from "vitest";
import { loadAcorn, runEval, runInterp } from "./harness.js";

beforeAll(loadAcorn);
const cases = [
  "(function({a}){return a;})({a:7})",
  "(function(x,{a},z){return x+a+z;})(2,{a:7},3)",
  "(({a})=>a)({a:7})",
  "(function({a:b}){return b;})({a:7})",
  "(function({a:{b}}){return b;})({a:{b:7}})",
  "try {(function({}){return 7;})(null)} catch(e){e.name}",
  "try {(function({}){return 7;})()} catch(e){e.name}",
  "(function({}){return 7;})(3)",
  "(function({a}){return function(){return ++a;};})({a:7})()",
  "(function({a}){var a;return a;})({a:7})",
  "(function({a}){function a(){return 9;}return a();})({a:7})",
  "var n=0;(function({a,b}){return a*10+b;})({get a(){return ++n;},get b(){return ++n;}})",
];
for (const source of cases) it(source, () => expect(runInterp(source)).toEqual(runEval(source)));
