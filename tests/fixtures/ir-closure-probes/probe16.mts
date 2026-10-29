// #7144 fixture — planned member-closure probe p16 (from the #6834 review rounds; see
// plan/issues/7144-ir-shared-operand-admissibility-predicate.md). Not a test: run by hand,
//   npx tsx tests/fixtures/ir-closure-probes/probe16.mts <worktree-root> [row,row,…]
// (PROBE_LANES=standalone,gc restricts the lanes). One line per row × lane: compile ok,
// binary hash, node result, run result, post-claim errors (PCE), <module-init> outcome.
import { createHash } from "node:crypto";
import { WASI } from "node:wasi";
const tree = process.argv[2];
const { compile } = await import(`${tree}/src/index.ts`);
const SUBJ = `/** @returns {number} */ function subject() { return 0; }\n`;
const R = `if (k === 9) return; `;
const D = `var r = m ? m : 1; `;
const T = `try { throw m; } catch (e) { `;
// [body, calls, pre?, doc?] — closures take (m, k)
const C: Record<string, [string, string, string?, string?]> = {
  // ---- strict equality, other operand kinds the fold BAILS on (class/object/closure/callable) — "keep prior answer"
  fnEqR: [
    `function (m, k) { ${R}${D}var f = function () { return 1; }; if (f === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  fnEq: [
    `function (m, k) { ${R}var f = function () { return 1; }; if (f === null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  fnNeR: [
    `function (m, k) { ${R}${D}var f = function () { return 1; }; if (f !== null) throw r; throw "n"; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  fnDeclEqR: [
    `function (m, k) { ${R}${D}function g() { return 1; } if (g === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  arrowEqR: [
    `function (m, k) { ${R}${D}var f = () => 1; if (f === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  fnLitEqR: [
    `function (m, k) { ${R}${D}if (null === function () {}) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  objEqR: [
    `function (m, k) { ${R}${D}var o = { a: 1 }; if (o === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  objEq: [
    `function (m, k) { ${R}var o = { a: 1 }; if (o === null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  objLitEqR: [
    `function (m, k) { ${R}${D}if (null === {}) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  subjEqR: [
    `function (m, k) { ${R}${D}if (subject === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  subjMemEqR: [
    `function (m, k) { ${R}${D}if (subject.f === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  newClassEqR: [
    `function (m, k) { ${R}${D}var p = new C(); if (p === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
    `class C { constructor() { this.v = 1; } }\n`,
  ],
  newFnEqR: [
    `function (m, k) { ${R}${D}var p = new C(); if (p === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
    `function C() { this.v = 1; }\n`,
  ],
  thisEqR: [
    `function (m, k) { ${R}${D}if (this === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  argsEqR: [
    `function (m, k) { ${R}${D}if (arguments === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  argsLenEqR: [
    `function (m, k) { ${R}${D}if (arguments.length === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  argsLenLooseR: [
    `function (m, k) { ${R}${D}if (arguments.length == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // ---- loose compare, other operand a dynamic value the selector cannot name
  memLooseR: [
    `function (m, k) { ${R}${D}if (m.x == null) throw "n"; throw r; }`,
    `try { subject.f({x:1},0); } catch (e) { if (e !== "n") n += 1; }`,
  ],
  memLoose: [
    `function (m, k) { ${R}if (m.x == null) throw "n"; throw m; }`,
    `try { subject.f({x:1},0); } catch (e) { if (e !== "n") n += 1; }`,
  ],
  memStrictR: [
    `function (m, k) { ${R}${D}if (m.x === null) throw "n"; throw r; }`,
    `try { subject.f({x:1},0); } catch (e) { if (e !== "n") n += 1; }`,
  ],
  memLeftStrictR: [
    `function (m, k) { ${R}${D}if (null === m.x) throw "n"; throw r; }`,
    `try { subject.f({x:1},0); } catch (e) { if (e !== "n") n += 1; }`,
  ],
  elLooseR: [
    `function (m, k) { ${R}${D}if (m[0] == null) throw "n"; throw r; }`,
    `try { subject.f([1],0); } catch (e) { if (e !== "n") n += 1; }`,
  ],
  callLooseR: [
    `function (m, k) { ${R}${D}if (m() == null) throw "n"; throw r; }`,
    `try { subject.f(function () { return 1; },0); } catch (e) { if (e !== "n") n += 1; }`,
  ],
  methLooseR: [
    `function (m, k) { ${R}${D}if (m.g() == null) throw "n"; throw r; }`,
    `try { subject.f({ g: function () { return 1; } },0); } catch (e) { if (e !== "n") n += 1; }`,
  ],
  methStrictR: [
    `function (m, k) { ${R}${D}if (m.g() === null) throw "n"; throw r; }`,
    `try { subject.f({ g: function () { return 1; } },0); } catch (e) { if (e !== "n") n += 1; }`,
  ],
  subjCallLooseR: [
    `function (m, k) { ${R}${D}if (subject() == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  kLooseR: [
    `function (m, k) { ${R}${D}if (k == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  tChainLooseR: [
    `function (m, k) { ${R}${D}var t = r; if (t == null) throw "n"; throw t; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  tParenLooseR: [
    `function (m, k) { ${R}${D}if ((r) == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  tParen2StrictR: [
    `function (m, k) { ${R}${D}if (((r)) === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  qqLooseR: [
    `function (m, k) { ${R}${D}var t = r ?? 1; if (t == null) throw "n"; throw t; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  qqOnlyR: [
    `function (m, k) { ${R}${D}var t = r ?? 1; throw t; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  qqStrictR: [
    `function (m, k) { ${R}${D}var t = r ?? 1; if (t === null) throw "n"; throw t; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  condLooseR: [
    `function (m, k) { ${R}${D}if ((k ? r : 1) == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  condShapeLooseR: [
    `function (m, k) { ${R}${D}if ((k ? m : 1) == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  condShapeLoose: [
    `function (m, k) { ${R}if ((k ? m : 1) == null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  assignLooseR: [
    `function (m, k) { ${R}${D}if ((r = m) == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  commaLooseR: [
    `function (m, k) { ${R}${D}if ((1, r) == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  commaStrictR: [
    `function (m, k) { ${R}${D}if ((1, r) === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // ---- nullish / undefined spellings
  parenUndefR: [
    `function (m, k) { ${R}${D}if (null === (undefined)) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  shadowUndefR: [
    `function (m, k) { ${R}${D}var undefined = 1; if (null === undefined) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  voidEqR: [
    `function (m, k) { ${R}${D}if (null === void 0) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  nullParenNullR: [
    `function (m, k) { ${R}${D}if ((null) === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  nullNullParenR: [
    `function (m, k) { ${R}${D}if (null === (null)) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  nullLooseNullR: [
    `function (m, k) { ${R}${D}if (null == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "n") n += 1; }`,
  ],
  undefLooseNullR: [
    `function (m, k) { ${R}${D}if (undefined == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "n") n += 1; }`,
  ],
  commaNullEqR: [
    `function (m, k) { ${R}${D}if ((1, null) === r) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // ---- string-family operands
  typeofEqR: [
    `function (m, k) { ${R}${D}if (typeof r === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  strCallEqR: [
    `function (m, k) { ${R}${D}if (String(r) === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  concatEqR: [
    `function (m, k) { ${R}${D}if ((r + "") === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  tplEqR: [
    `function (m, k) { ${R}${D}if (\`\${r}\` === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  tplNoSubEqR: [
    `function (m, k) { ${R}${D}if (\`a\` === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  toStrEqR: [
    `function (m, k) { ${R}${D}if (r.toString() === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  letStrEqR: [
    `function (m, k) { ${R}${D}let s = "a"; if (s === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  constStrEqR: [
    `function (m, k) { ${R}${D}const s = "a"; if (s === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  jsdocStrEqR: [
    `function (m, k) { ${R}${D}/** @type {string} */ var s = m.x; if (s === null) throw "n"; throw r; }`,
    `try { subject.f({x:"a"},0); } catch (e) { if (e !== "n") n += 1; }`,
  ],
  jsdocStrDeclEqR: [
    `function (m, k) { ${R}${D}/** @type {string} */ var s; s = "a"; if (s === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  paramStrEqR: [
    `function (m, k) { ${R}${D}if (k === null) throw "n"; throw r; }`,
    `try { subject.f(2,"z"); } catch (e) { if (e === 2) n += 1; }`,
    undefined,
    `/** @param {*} m @param {string} k */\n`,
  ],
  strCondEqR: [
    `function (m, k) { ${R}${D}var s = k ? "a" : "b"; if (s === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  strDynCondEqR: [
    `function (m, k) { ${R}${D}var s = m ? m : "a"; if (s === null) throw "n"; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  strConcatVarEqR: [
    `function (m, k) { ${R}${D}var s = "a" + r; if (s === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  strAssignEqR: [
    `function (m, k) { ${R}${D}var s = "a"; s = s + "b"; if (s === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  strLooseR: [
    `function (m, k) { ${R}${D}var s = "a"; if (s == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // ---- numeric / boolean / vec operands
  boolEqR: [
    `function (m, k) { ${R}${D}var b = true; if (b === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  boolLitLooseR: [
    `function (m, k) { ${R}${D}if (true == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  numLooseR: [
    `function (m, k) { ${R}${D}var q = 5; if (q == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  numLitLooseR: [
    `function (m, k) { ${R}${D}if (5 == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  negLooseR: [
    `function (m, k) { ${R}${D}if (-r == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  notLooseR: [
    `function (m, k) { ${R}${D}if (!r == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  cmpLooseR: [
    `function (m, k) { ${R}${D}if ((r > 1) == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  vecLooseR: [
    `function (m, k) { ${R}${D}var a = [1]; if (a == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  vecLitEqR: [
    `function (m, k) { ${R}${D}if (null === [1]) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  vecElEqR: [
    `function (m, k) { ${R}${D}var a = [1]; if (a[0] === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  vecLenLooseR: [
    `function (m, k) { ${R}${D}var a = [1]; if (a.length == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // ---- catch binding, nested
  nestedCatchLooseR: [
    `function (m, k) { ${R}${D}try { try { throw r; } catch (e) { if (e != null) throw e; throw "n"; } } catch (f) { throw f; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  nestedCatchStrictR: [
    `function (m, k) { ${R}${D}try { try { throw r; } catch (e) { if (e !== null) throw e; throw "n"; } } catch (f) { throw f; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  catchOuterLooseR: [
    `function (m, k) { ${R}${D}try { throw r; } catch (e) { try { if (e == null) throw "n"; } catch (f) { throw f; } throw e; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  catchOuterStrictR: [
    `function (m, k) { ${R}${D}try { throw r; } catch (e) { try { if (e === null) throw "n"; } catch (f) { throw f; } throw e; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  catchLooseNoD: [
    `function (m, k) { ${R}try { throw m; } catch (e) { if (e == null) throw "n"; throw e; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  catchParenLooseR: [
    `function (m, k) { ${R}${D}try { throw r; } catch (e) { if ((e) == null) throw "n"; throw e; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  catchChainLooseR: [
    `function (m, k) { ${R}${D}try { throw r; } catch (e) { var t = e; if (t == null) throw "n"; throw t; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  catchLetLooseR: [
    `function (m, k) { ${R}${D}try { throw r; } catch (e) { let t = e; if (t == null) throw "n"; throw t; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // ---- throw climb: comma / parens / conditional / ??
  thCommaNest: [
    `function (m, k) { ${R}throw (1, (2, null)); }`,
    `try { subject.f(0,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  thCommaNestR: [
    `function (m, k) { ${R}${D}throw (1, (2, null)); }`,
    `try { subject.f(0,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  thCommaParen2: [
    `function (m, k) { ${R}throw ((1, null)); }`,
    `try { subject.f(0,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  thCommaParen2R: [
    `function (m, k) { ${R}${D}throw ((1, null)); }`,
    `try { subject.f(0,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  thCommaRightParen: [
    `function (m, k) { ${R}throw (1, (null)); }`,
    `try { subject.f(0,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  thCommaOuter: [
    `function (m, k) { ${R}throw (1, null), 2; }`,
    `try { subject.f(0,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  thCommaOuter2: [
    `function (m, k) { ${R}throw ((1, null), 2); }`,
    `try { subject.f(0,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  thCommaLeft: [
    `function (m, k) { ${R}throw (null, 1); }`,
    `try { subject.f(0,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  thCommaLeftR: [
    `function (m, k) { ${R}${D}throw (null, 1); }`,
    `try { subject.f(0,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  thCommaDynLeft: [
    `function (m, k) { ${R}throw (m, null); }`,
    `try { subject.f(0,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  thCommaKLeft: [
    `function (m, k) { ${R}throw (k, null); }`,
    `try { subject.f(0,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  thCommaCallLeft: [
    `function (m, k) { ${R}throw (subject(), null); }`,
    `try { subject.f(0,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  thCommaAssignR: [
    `function (m, k) { ${R}${D}throw (r = 2, null); }`,
    `try { subject.f(0,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  thCommaMid: [
    `function (m, k) { ${R}throw (1, null, 2); }`,
    `try { subject.f(0,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  thCommaMidRight: [
    `function (m, k) { ${R}throw (1, 2, null); }`,
    `try { subject.f(0,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  thCond: [
    `function (m, k) { ${R}throw k ? null : 1; }`,
    `try { subject.f(0,1); } catch (e) { if (e === null) n += 1; }`,
  ],
  thCondParen: [
    `function (m, k) { ${R}throw (k ? null : 1); }`,
    `try { subject.f(0,1); } catch (e) { if (e === null) n += 1; }`,
  ],
  thCondBoth: [
    `function (m, k) { ${R}throw k ? null : null; }`,
    `try { subject.f(0,1); } catch (e) { if (e === null) n += 1; }`,
  ],
  thCondM: [
    `function (m, k) { ${R}throw k ? null : m; }`,
    `try { subject.f(0,1); } catch (e) { if (e === null) n += 1; }`,
  ],
  thQq: [`function (m, k) { ${R}throw null ?? 1; }`, `try { subject.f(0,0); } catch (e) { if (e === 1) n += 1; }`],
  thQqRight: [`function (m, k) { ${R}throw k ?? null; }`, `try { subject.f(0,0); } catch (e) { if (e === 0) n += 1; }`],
  thAnd: [`function (m, k) { ${R}throw k && null; }`, `try { subject.f(0,1); } catch (e) { if (e === null) n += 1; }`],
  thOr: [`function (m, k) { ${R}throw k || null; }`, `try { subject.f(0,0); } catch (e) { if (e === null) n += 1; }`],
  thCommaCond: [
    `function (m, k) { ${R}throw (1, k ? null : 1); }`,
    `try { subject.f(0,1); } catch (e) { if (e === null) n += 1; }`,
  ],
  thCondComma: [
    `function (m, k) { ${R}throw k ? (1, null) : 1; }`,
    `try { subject.f(0,1); } catch (e) { if (e === null) n += 1; }`,
  ],
  exprCommaNullR: [
    `function (m, k) { ${R}${D}(1, null); throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  exprCommaNull: [
    `function (m, k) { ${R}(1, null); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  retCommaNull: [
    `function (m, k) { if (k === 9) return (1, null); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; } if (subject.f(2,9) === null) n += 10;`,
  ],
  varCommaNullR: [
    `function (m, k) { ${R}${D}var x = (1, null); throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  eqCommaNullR: [
    `function (m, k) { ${R}${D}if (r === (1, null)) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // ---- top-level control
  top: [
    `function (m, k) { return 0; }`,
    `function top(m) { var f = function () { return 1; }; if (f === null) throw "n"; if (m.x == null) throw "x"; throw (1, (2, null)); } try { top({x:1}); } catch (e) { if (e === null) n += 1; }`,
  ],
};
const LANES: Record<string, object> = {
  standalone: { target: "standalone" },
  wasi: { target: "wasi" },
  gc: { target: "gc" },
  gchost: { target: "gc", semanticProviders: "host-assisted" },
  fast: { target: "standalone", fast: true },
};
for (const l of Object.keys(LANES))
  if (process.env.PROBE_LANES && !process.env.PROBE_LANES.split(",").includes(l)) delete (LANES as any)[l];
const only = (process.argv[3] ?? "").split(",").filter(Boolean);
for (const [k, [body, calls, pre, doc]] of Object.entries(C)) {
  if (only.length && !only.includes(k)) continue;
  const src =
    (pre ?? "") + SUBJ + (doc ?? "") + `subject.f = ${body};\nexport function run() { var n = 0; ${calls} return n; }`;
  let nodeRes = "-";
  try {
    nodeRes = String(new Function(`"use strict";\n${src.replace(/\bexport /g, "")}\nreturn run();`)());
  } catch (e: any) {
    nodeRes = "NODE-ERR " + e.message;
  }
  for (const l of Object.keys(LANES)) {
    let r: any;
    try {
      r = await compile(src, {
        ...LANES[l],
        skipSemanticDiagnostics: true,
        trackIrOutcomes: true,
        allowJs: true,
        fileName: `${k}.js`,
        deferTopLevelInit: true,
      } as any);
    } catch (e: any) {
      console.log(`${k.padEnd(14)} ${l.padEnd(10)} COMPILE-THROW ${String(e.message).slice(0, 120)}`);
      continue;
    }
    const rows = (r.irOutcomes ?? [])
      .filter((e: any) => e.displayName === "<module-init>" || e.displayName === "top")
      .map(
        (e: any) =>
          `${e.displayName}:ir=${e.irBodyEmitted ? 1 : 0}/leg=${e.legacyBodyEmitted ? 1 : 0}${e.code ? `:${e.code}` : ""}${e.shapeReason ? `{${e.shapeReason}}` : ""}`,
      );
    let ran = "-";
    if (r.success && (l === "standalone" || l === "fast")) {
      try {
        const { instance } = await WebAssembly.instantiate(r.binary, {});
        (instance.exports.__module_init as any)?.();
        ran = String((instance.exports.run as any)());
      } catch (e: any) {
        ran = "ERR " + String(e.message).slice(0, 60);
      }
    }
    if (r.success && l === "wasi") {
      try {
        const wasi = new WASI({ version: "preview1", args: [], env: {} });
        const mod = await WebAssembly.compile(r.binary);
        const instance = await WebAssembly.instantiate(mod, wasi.getImportObject() as any);
        try {
          (wasi as any).initialize(instance);
        } catch {}
        (instance.exports.__module_init as any)?.();
        ran = String((instance.exports.run as any)());
      } catch (e: any) {
        ran = "ERR " + String(e.message).slice(0, 60);
      }
    }
    const h = r.binary ? createHash("sha256").update(r.binary).digest("hex").slice(0, 12) : "nobin";
    const pce = (r.irPostClaimErrors ?? []).filter((e: any) => e.func !== "run");
    const cmp = ran !== "-" ? (ran === nodeRes ? "SAME" : "DIFF") : "";
    console.log(
      `${k.padEnd(14)} ${l.padEnd(10)} ok=${r.success ? 1 : 0} ${h} node=${nodeRes} ran=${ran} ${cmp} PCE=${JSON.stringify(pce.map((e: any) => [e.func, String(e.message ?? e.detail ?? "").slice(0, 100)]))} ${rows.join(" ")}`,
    );
    if (!r.success) console.log("   errors:", r.errors.map((e: any) => e.message.slice(0, 120)).join(" | "));
  }
}
