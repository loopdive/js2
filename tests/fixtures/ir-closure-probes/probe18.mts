// #7144 fixture — planned member-closure probe p18 (from the #6834 review rounds; see
// plan/issues/7144-ir-shared-operand-admissibility-predicate.md). Not a test: run by hand,
//   npx tsx tests/fixtures/ir-closure-probes/probe18.mts <worktree-root> [row,row,…]
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
  // ---- nullCompareOperandSources: declaration kinds / initializer kinds (strict)
  letObjEqR: [
    `function (m, k) { ${R}${D}let o = { a: 1 }; if (o === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  constObjEqR: [
    `function (m, k) { ${R}${D}const o = { a: 1 }; if (o === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  blockLetObjEqR: [
    `function (m, k) { ${R}${D}{ let o = { a: 1 }; if (o === null) throw "n"; } throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  shadowParamObjEqR: [
    `function (o, k) { ${R}var r = o ? o : 1; { let o = { a: 1 }; if (o === null) throw "n"; } throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  shadowLocalDynEqR: [
    `function (m, k) { ${R}${D}var o = { a: 1 }; { let o = m; if (o === null) throw "n"; } throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  destrObjEqR: [
    `function (m, k) { ${R}${D}var [o] = [{ a: 1 }]; if (o === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  condObjObjEqR: [
    `function (m, k) { ${R}${D}var o = k ? { a: 1 } : { b: 2 }; if (o === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  condObjNumEqR: [
    `function (m, k) { ${R}${D}var o = k ? { a: 1 } : 1; if (o === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  commaObjEqR: [
    `function (m, k) { ${R}${D}var o = (1, { a: 1 }); if (o === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  commaObjEq: [
    `function (m, k) { ${R}var o = (1, { a: 1 }); if (o === null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  aliasObjEqR: [
    `function (m, k) { ${R}${D}var o = { a: 1 }; var p = o; if (p === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  aliasObjEq: [
    `function (m, k) { ${R}var o = { a: 1 }; var p = o; if (p === null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  aliasArrEqR: [
    `function (m, k) { ${R}${D}var a = [1]; var b = a; if (b === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  lateObjEqR: [
    `function (m, k) { ${R}${D}var o; o = { a: 1 }; if (o === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  objElEqR: [
    `function (m, k) { ${R}${D}var o = [{ a: 1 }]; if (o[0] === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  objElEq: [
    `function (m, k) { ${R}var o = [{ a: 1 }]; if (o[0] === null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  objMemEqR: [
    `function (m, k) { ${R}${D}var o = { a: { b: 1 } }; if (o.a === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  objMemEq: [
    `function (m, k) { ${R}var o = { a: { b: 1 } }; if (o.a === null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  objNumMemEqR: [
    `function (m, k) { ${R}${D}var o = { a: 1 }; if (o.a === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  objLeftEqR: [
    `function (m, k) { ${R}${D}var o = { a: 1 }; if (null === (o)) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  objNeR: [
    `function (m, k) { ${R}${D}var o = { a: 1 }; if (o !== null) throw r; throw "n"; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  callInitDynEqR: [
    `function (m, k) { ${R}${D}var o = m(); if (o === null) throw "n"; throw r; }`,
    `try { subject.f(function () { return 1; },0); } catch (e) { if (e !== "n") n += 1; }`,
  ],
  callInitNumEqR: [
    `function (m, k) { ${R}${D}var o = subject(); if (o === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // ---- loose: operand kinds
  strLenLooseR: [
    `function (m, k) { ${R}${D}var s = "ab"; if (s.length == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  strLenLoose: [
    `function (m, k) { ${R}var s = "ab"; if (s.length == null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  vecElLooseR: [
    `function (m, k) { ${R}${D}var a = [1]; if (a[0] == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  vecElLoose: [
    `function (m, k) { ${R}var a = [1]; if (a[0] == null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  typeofLooseR: [
    `function (m, k) { ${R}${D}if (typeof m == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  typeofLoose: [
    `function (m, k) { ${R}if (typeof m == null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  notObjLooseR: [
    `function (m, k) { ${R}${D}var o = { a: 1 }; if (!o == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  notObjLoose: [
    `function (m, k) { ${R}var o = { a: 1 }; if (!o == null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  negObjLooseR: [
    `function (m, k) { ${R}${D}var o = { a: 1 }; if (-o == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  negObjLoose: [
    `function (m, k) { ${R}var o = { a: 1 }; if (-o == null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  objLooseR: [
    `function (m, k) { ${R}${D}var o = { a: 1 }; if (o == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  objMemLooseR: [
    `function (m, k) { ${R}${D}var o = { a: 1 }; if (o.a == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  objMemLoose: [
    `function (m, k) { ${R}var o = { a: 1 }; if (o.a == null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  parenNumLooseR: [
    `function (m, k) { ${R}${D}var q = 5; if (((q)) == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  letNumLooseR: [
    `function (m, k) { ${R}${D}let q = 5; if (q == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  kPlusLooseR: [
    `function (m, k) { ${R}${D}if (k + 1 == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  kPlusLoose: [
    `function (m, k) { ${R}if (k + 1 == null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  mPlusLooseR: [
    `function (m, k) { ${R}${D}if (m + 1 == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  voidLooseR: [
    `function (m, k) { ${R}${D}if (void 0 == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "n") n += 1; }`,
  ],
  voidLoose: [
    `function (m, k) { ${R}if (void 0 == null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "n") n += 1; }`,
  ],
  // ---- ??
  qqRightR: [
    `function (m, k) { ${R}${D}var t = 1 ?? r; throw t; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  qqRight: [
    `function (m, k) { ${R}var t = 1 ?? m; throw t; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  qqMemR: [
    `function (m, k) { ${R}${D}var t = r.x ?? 1; throw t; }`,
    `try { subject.f({x:2},0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  qqCommaR: [
    `function (m, k) { ${R}${D}var t = (1, r) ?? 1; throw t; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  qqParenR: [
    `function (m, k) { ${R}${D}var t = ((r)) ?? 1; throw t; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  qqParamR: [
    `function (m, k) { ${R}${D}var t = m ?? 1; throw t; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  qqKR: [
    `function (m, k) { ${R}${D}var t = k ?? 1; throw t; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  qqNumR: [
    `function (m, k) { ${R}${D}var q = 5; var t = q ?? 1; throw t; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 5) n += 1; }`,
  ],
  qqStrR: [
    `function (m, k) { ${R}${D}var s = "a"; var t = s ?? "b"; throw t; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "a") n += 1; }`,
  ],
  qqCatchR: [
    `function (m, k) { ${R}${D}try { throw m; } catch (e) { var t = e ?? 1; throw t; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  qqAliasR: [
    `function (m, k) { ${R}${D}var t = r; var u = t ?? 1; throw u; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  qqStmtR: [
    `function (m, k) { ${R}${D}r ?? 1; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  qqThrowR: [`function (m, k) { ${R}${D}throw r ?? 1; }`, `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`],
  qqCondR: [
    `function (m, k) { ${R}${D}if (r ?? 1) throw r; throw "n"; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  qqAssignR: [
    `function (m, k) { ${R}${D}r = r ?? 1; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  qqObjR: [
    `function (m, k) { ${R}${D}var o = { a: 1 }; var t = o ?? 1; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // ---- discarded null: statement contexts
  lblNull: [
    `function (m, k) { ${R}lbl: { null; } throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  doWhileNull: [
    `function (m, k) { ${R}do { null; } while (k); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  switchCaseNull: [
    `function (m, k) { ${R}switch (k) { case 0: null; break; } throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  switchDiscComma: [
    `function (m, k) { ${R}switch ((null, k)) { case 0: break; } throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  switchCaseComma: [
    `function (m, k) { ${R}switch (k) { case (null, 0): break; } throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  arrowExprNull: [
    `function (m, k) { ${R}var f = () => null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  arrowBlockNull: [
    `function (m, k) { ${R}var f = () => { null; }; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  arrowMember: [
    `function (m, k) { ${R}null; throw m; }`,
    `try { subject.g(2, 0); } catch (e) { if (e === 2) n += 1; }`,
    undefined,
    `subject.g = (m, k) => { null; throw m; };\n`,
  ],
  elseNull: [
    `function (m, k) { ${R}if (k) throw m; else null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  forBodyNull: [
    `function (m, k) { ${R}for (var i = 0; i < 1; i++) null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // ---- comma-left reach: positions from-ast may not lower as discarded
  forInitComma: [
    `function (m, k) { ${R}for ((null, 1); k < 1; k++) {} throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  forInitCommaNP: [
    `function (m, k) { ${R}for (null, 1; k < 1; k++) {} throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  forCondComma: [
    `function (m, k) { ${R}for (var i = 0; (null, i < 1); i++) {} throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  forIncParenComma: [
    `function (m, k) { ${R}for (var i = 0; i < 1; (null, i++)) {} throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  forIncNestParen: [
    `function (m, k) { ${R}for (var i = 0; i < 1; i++, (null, i++)) {} throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  forIncParenNull: [
    `function (m, k) { ${R}for (var i = 0; i < 1; (null), i++) {} throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  forIncRightNull: [
    `function (m, k) { ${R}for (var i = 0; i < 1; i++, (1, null)) {} throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  callArgComma: [
    `function (m, k) { ${R}m((null, 1)); throw m; }`,
    `try { subject.f(function (x) { return x; },0); } catch (e) { if (typeof e === "function") n += 1; }`,
  ],
  subjArgComma: [
    `function (m, k) { ${R}subject((null, 1)); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  arrLitComma: [
    `function (m, k) { ${R}var a = [(null, 1)]; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  defaultParamComma: [
    `function (m, k, d = (null, 1)) { ${R}throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  tplComma: [
    `function (m, k) { ${R}var s = \`\${(null, 1)}\`; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  ifCondComma: [
    `function (m, k) { ${R}if ((null, k)) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  whileCondComma: [
    `function (m, k) { ${R}while ((null, k)) { k = 0; } throw m; }`,
    `try { subject.f(2,1); } catch (e) { if (e === 2) n += 1; }`,
  ],
  assignRhsComma: [
    `function (m, k) { ${R}var q = 5; q = (null, 1); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  assignDynRhsComma: [
    `function (m, k) { ${R}m = (null, 1); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  varInitComma: [
    `function (m, k) { ${R}var t = (null, 1); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  returnComma: [`function (m, k) { ${R}return (null, 1); }`, `if (subject.f(2,0) === 1) n += 1;`],
  returnCommaK: [
    `function (m, k) { if (k === 9) return (null, 1); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  throwParenComma: [
    `function (m, k) { ${R}throw ((null, m)); }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  throwCommaNullNull: [
    `function (m, k) { ${R}throw (null, null); }`,
    `try { subject.f(2,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  condArmComma: [
    `function (m, k) { ${R}k ? (null, 1) : 2; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  condValueArmComma: [
    `function (m, k) { ${R}var t = k ? (null, 1) : 2; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  plusComma: [
    `function (m, k) { ${R}var t = (null, 1) + 1; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  eqComma: [
    `function (m, k) { ${R}if ((null, k) === 1) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  memRecvComma: [
    `function (m, k) { ${R}(null, m).x; throw m; }`,
    `try { subject.f({x:1},0); } catch (e) { if (e !== "n") n += 1; }`,
  ],
  // ---- void / conditional in VALUE position (deviation 1): base lowers these?
  varVoidNull: [
    `function (m, k) { ${R}var t = void null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  varVoidNullR: [
    `function (m, k) { ${R}${D}var t = void null; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  ifVoidNull: [
    `function (m, k) { ${R}if (void null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  plusVoidNull: [
    `function (m, k) { ${R}var t = (void null) + 1; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  throwVoidNull: [
    `function (m, k) { ${R}throw void null; }`,
    `try { subject.f(2,0); } catch (e) { if (e === undefined) n += 1; }`,
  ],
  throwVoid0: [
    `function (m, k) { ${R}throw void 0; }`,
    `try { subject.f(2,0); } catch (e) { if (e === undefined) n += 1; }`,
  ],
  throwCondNullM: [
    `function (m, k) { ${R}throw k ? null : m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  throwCondNullNull: [
    `function (m, k) { ${R}throw k ? null : null; }`,
    `try { subject.f(2,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  throwCommaCondNull: [
    `function (m, k) { ${R}throw (1, k ? null : m); }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  throwCondCommaNull: [
    `function (m, k) { ${R}throw k ? (null, m) : m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  varCondNull: [
    `function (m, k) { ${R}var t = k ? null : 1; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtCondNested: [
    `function (m, k) { ${R}k ? (k ? null : 2) : 1; throw m; }`,
    `try { subject.f(2,1); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtVoidCond: [
    `function (m, k) { ${R}void (k ? null : 1); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtCondVoid: [
    `function (m, k) { ${R}k ? void null : 1; throw m; }`,
    `try { subject.f(2,1); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtCommaCond: [
    `function (m, k) { ${R}1, (k ? null : 1); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtCondComma: [
    `function (m, k) { ${R}k ? (null, 1) : (null, 2); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtCondInCond: [
    `function (m, k) { ${R}null ? 1 : 2; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  top: [
    `function (m, k) { return 0; }`,
    `function top(m) { var t = void null; (1, null); throw m; } try { top(2); } catch (e) { if (e === 2) n += 1; }`,
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
