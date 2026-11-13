// #7144 fixture — planned member-closure probe p23 (from the #6834 review rounds; see
// plan/issues/7144-ir-shared-operand-admissibility-predicate.md). Not a test: run by hand,
//   npx tsx tests/fixtures/ir-closure-probes/probe23.mts <worktree-root> [row,row,…]
// (PROBE_LANES=standalone,gc restricts the lanes). One line per row × lane: compile ok,
// binary hash, node result, run result, post-claim errors (PCE), <module-init> outcome.
import { createHash } from "node:crypto";
import { WASI } from "node:wasi";
const tree = process.argv[2];
const { compile } = await import(`${tree}/src/index.ts`);
const SUBJ = `var g1 = 0; var g2 = 0;\n/** @returns {number} */ function subject() { return 0; }\n`;
const R = `if (k === 9) return; `;
const D = `var r = m ? m : 1; `;
const T = `try { throw m; } catch (e) { `;
const E = (b: string) => `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`;
const row = (body: string): [string, string] => [`function (m, k) { ${R}${body} }`, E(body)];
const C: Record<string, [string, string, string?, string?]> = {
  // (a) numeric param as concrete slot
  kEqMemR: row(`${D}k = m.x; throw r;`),
  kEqMem: row(`k = m.x; throw m;`),
  kEqTypeofR: row(`${D}k = typeof m; throw r;`),
  kEqTypeof: row(`k = typeof m; throw m;`),
  kEqStrR: row(`${D}k = "s"; throw r;`),
  kEqStr: row(`k = "s"; throw m;`),
  kEqCmpR: row(`${D}k = (m === 1); throw r;`),
  kEqCmp: row(`k = (m === 1); throw m;`),
  kEqCallR: row(`${D}k = m(); throw r;`),
  kEqCall: row(`k = m(); throw m;`),
  kPlusEqMemR: row(`${D}k += m.x; throw r;`),
  kPlusEqMem: row(`k += m.x; throw m;`),
  kEqElR: row(`${D}k = m[0]; throw r;`),
  kEqBoolR: row(`${D}k = true; throw r;`),
  kEqBool: row(`k = true; throw m;`),
  kEqNumR: row(`${D}k = 3; throw r;`),
  // (c) vec element / member writes
  vecElDynR: row(`${D}var a = [1]; a[0] = r; throw r;`),
  vecElDyn: row(`var a = [1]; a[0] = m; throw m;`),
  vecElStrR: row(`${D}var a = [1]; a[0] = "s"; throw r;`),
  vecElStr: row(`var a = [1]; a[0] = "s"; throw m;`),
  vecElMemR: row(`${D}var a = [1]; a[0] = m.x; throw r;`),
  rMemWriteR: row(`${D}r.x = 1; throw r;`),
  mMemWrite: row(`m.x = 1; throw m;`),
  rElWriteR: row(`${D}r[0] = 1; throw r;`),
  mElWrite: row(`m[0] = 1; throw m;`),
  // (e) operators on the dynamic local
  rPlus1R: row(`${D}var t = r + 1; throw r;`),
  mPlus1: row(`var t = m + 1; throw m;`),
  rTimes2R: row(`${D}var t = r * 2; throw r;`),
  mTimes2: row(`var t = m * 2; throw m;`),
  rMinus1R: row(`${D}var t = r - 1; throw r;`),
  rMod2R: row(`${D}var t = r % 2; throw r;`),
  rDiv2R: row(`${D}var t = r / 2; throw r;`),
  rPowR: row(`${D}var t = r ** 2; throw r;`),
  negRR: row(`${D}var t = -r; throw r;`),
  negM: row(`var t = -m; throw m;`),
  posRR: row(`${D}var t = +r; throw r;`),
  tildeRR: row(`${D}var t = ~r; throw r;`),
  rOr0R: row(`${D}var t = r | 0; throw r;`),
  rShlR: row(`${D}var t = r << 1; throw r;`),
  rIncR: row(`${D}r++; throw r;`),
  rPreIncR: row(`${D}++r; throw r;`),
  rDecR: row(`${D}r--; throw r;`),
  mInc: row(`m++; throw m;`),
  rIncValR: row(`${D}var t = r++; throw r;`),
  rLtMR: row(`${D}if (r < m) throw "n"; throw r;`),
  mLtK: row(`if (m < k) throw "n"; throw m;`),
  rLt1R: row(`${D}if (r < 1) throw "n"; throw r;`),
  rGeStrR: row(`${D}if (r >= "a") throw "n"; throw r;`),
  rEq1R: row(`${D}if (r == 1) throw "n"; throw r;`),
  rEqqStrR: row(`${D}if (r === "a") throw "n"; throw r;`),
  rEqqMR: row(`${D}if (r !== m) throw "n"; throw r;`),
  rNeKR: row(`${D}if (r != k) throw "n"; throw r;`),
  rAndR: row(`${D}var t = r && 1; throw r;`),
  rOrR: row(`${D}var t = r || 1; throw r;`),
  mAnd: row(`var t = m && 1; throw m;`),
  rAndStmtR: row(`${D}r && k++; throw r;`),
  sPlusRR: row(`${D}var s = "a"; var t = s + r; throw r;`),
  sPlusM: row(`var s = "a"; var t = s + m; throw m;`),
  kPlusRR: row(`${D}var t = k + r; throw r;`),
  rPlusRR: row(`${D}var t = r + r; throw r;`),
  litPlusRR: row(`${D}var t = "a" + r; throw r;`),
  numPlusRR: row(`${D}var t = 1 + r; throw r;`),
  rPlusStmtR: row(`${D}r + 1; throw r;`),
  rPlusEqStrR: row(`${D}r += "a"; throw r;`),
  rPlusEqMemR: row(`${D}r += m.x; throw r;`),
  rPlusEqTypeofR: row(`${D}r += typeof m; throw r;`),
  rEqTypeofPlusR: row(`${D}r = typeof m; r += 1; throw r;`),
  rEqMemPlusR: row(`${D}r = m.x; var t = r + 1; throw r;`),
  rEqCmpR: row(`${D}r = (m === 1); throw r;`),
  rEqElR: row(`${D}r = m[0]; throw r;`),
  qCallPlusR: row(`${D}var q = m(); q += r; throw r;`),
  qCallR: row(`${D}var q = m(); throw r;`),
  qCall: row(`var q = m(); throw m;`),
  qCallPlus1R: row(`${D}var q = m(); var t = q + 1; throw r;`),
  // (f) member / call / misc values
  rLenR: row(`${D}var t = r.length; throw r;`),
  mLen: row(`var t = m.length; throw m;`),
  rMemR: row(`${D}var t = r.x; throw r;`),
  rElR: row(`${D}var t = r[0]; throw r;`),
  rElKR: row(`${D}var t = r[k]; throw r;`),
  rCallR: row(`${D}r(); throw r;`),
  mCallR: row(`${D}m(r); throw r;`),
  mCallM: row(`m(m); throw m;`),
  subjArgRR: row(`${D}subject(r); throw r;`),
  strCallR: row(`${D}var t = String(r); throw r;`),
  strCall: row(`var t = String(m); throw m;`),
  numCallR: row(`${D}var t = Number(r); throw r;`),
  tplRR: row(`${D}var t = \`\${r}\`; throw r;`),
  tplM: row(`var t = \`\${m}\`; throw m;`),
  typeofRR: row(`${D}var t = typeof r; throw r;`),
  deleteRR: row(`${D}delete r.x; throw r;`),
  inRR: row(`${D}if ("x" in r) throw "n"; throw r;`),
  instRR: row(`${D}if (r instanceof Object) throw "n"; throw r;`),
  switchRR: row(`${D}switch (r) { case 1: throw "n"; } throw r;`),
  switchM: row(`switch (m) { case 1: throw "n"; } throw m;`),
  switchKR: row(`${D}switch (k) { case 1: throw "n"; } throw r;`),
  forInRR: row(`${D}for (var i in r) { k++; } throw r;`),
  forOfRR: row(`${D}for (var x of r) { k++; } throw r;`),
  lblR: row(`${D}a: { if (k) break a; k++; } throw r;`),
  lbl: row(`a: { if (k) break a; k++; } throw m;`),
  tryFinR: row(`${D}try { k++; } finally { k--; } throw r;`),
  tryFin: row(`try { k++; } finally { k--; } throw m;`),
  tryCatchRR: row(`${D}try { throw r; } catch (e) { throw e; }`),
  argsR: row(`${D}var t = arguments.length; throw r;`),
  args: row(`var t = arguments.length; throw m;`),
  retRR: row(`${D}if (k) return r; throw r;`),
  retR: row(`${D}if (k) return; throw r;`),
  voidRR: row(`${D}void r; throw r;`),
  condRR: row(`${D}var t = r ? 1 : 2; throw r;`),
  ifRR: row(`${D}if (r) k++; throw r;`),
  whileRR: row(`${D}while (r) { r = 0; } throw r;`),
  remintR: row(`${D}r = r ? r : 2; throw r;`),
  remintM: row(`${D}r = m ? m : 2; throw r;`),
  nestedFnR: row(`${D}var f = function () { return r; }; throw r;`),
  arrowR: row(`${D}var f = () => r; throw r;`),
  notChainR: row(`${D}var t = !!r; throw r;`),
  notPlusR: row(`${D}var t = !r + 1; throw r;`),
  cmpPlusR: row(`${D}var t = (r === 1) + 1; throw r;`),
  typeofPlusR: row(`${D}var t = typeof r + 1; throw r;`),
  typeofPlusStrR: row(`${D}var t = typeof r + "a"; throw r;`),
  memPlusR: row(`${D}var t = m.x + 1; throw r;`),
  memPlus: row(`var t = m.x + 1; throw m;`),
  callPlusR: row(`${D}var t = m() + 1; throw r;`),
  lenPlusR: row(`${D}var t = m.length + 1; throw r;`),
  lenPlus: row(`var t = m.length + 1; throw m;`),
  negMemR: row(`${D}var t = -m.x; throw r;`),
  negCallR: row(`${D}var t = -m(); throw r;`),
  negTypeofR: row(`${D}var t = -(typeof m); throw r;`),
  negCmpR: row(`${D}var t = -(m === 1); throw r;`),
  negStrLitR: row(`${D}var t = -"3"; throw r;`),
  negStrLit: row(`var t = -"3"; throw m;`),
  plusStrNumR: row(`${D}var t = "a" + 1; throw r;`),
  plusStrNum: row(`var t = "a" + 1; throw m;`),
  strTimesR: row(`${D}var t = "3" * 2; throw r;`),
  strTimes: row(`var t = "3" * 2; throw m;`),
  boolPlusR: row(`${D}var t = true + 1; throw r;`),
  boolPlus: row(`var t = true + 1; throw m;`),
  boolTimesR: row(`${D}var t = true * 2; throw r;`),
  catchPlusR: row(`${D}try { throw 1; } catch (e) { var t = e + 1; } throw r;`),
  catchPlus: row(`try { throw 1; } catch (e) { var t = e + 1; } throw m;`),
  catchNegR: row(`${D}try { throw 1; } catch (e) { var t = -e; } throw r;`),
  // alias chains
  aliasRPlusR: row(`${D}var t = r; var u = t + 1; throw r;`),
  aliasStrPlusR: row(`${D}var s = "a"; var t = s; var u = t + 1; throw r;`),
  aliasArrPlusR: row(`${D}var a = [1]; var b = a; var u = b + 1; throw r;`),
  aliasArrPlus: row(`var a = [1]; var b = a; var u = b + 1; throw m;`),
  aliasUninitPlusR: row(`${D}var t; var u = t + 1; throw r;`),
  aliasUninitPlus: row(`var t; var u = t + 1; throw m;`),
  uninitEqObjR: row(`${D}var t; t = { a: 1 }; throw r;`),
  // concrete slot writes
  sEqNumR: row(`${D}var s = "a"; s = 1; throw r;`),
  sEqNum: row(`var s = "a"; s = 1; throw m;`),
  nEqStrR: row(`${D}var q = 1; q = "a"; throw r;`),
  nPlusEqStrR: row(`${D}var q = 1; q += "a"; throw r;`),
  nPlusEqStr: row(`var q = 1; q += "a"; throw m;`),
  sPlusEqNumR: row(`${D}var s = "a"; s += 1; throw r;`),
  sPlusEqBoolR: row(`${D}var s = "a"; s += true; throw r;`),
  sPlusEqBool: row(`var s = "a"; s += true; throw m;`),
  nPlusEqBoolR: row(`${D}var q = 1; q += true; throw r;`),
  nPlusEqBool: row(`var q = 1; q += true; throw m;`),
  nTimesEqR: row(`${D}var q = 1; q *= 2; throw r;`),
  nTimesEq: row(`var q = 1; q *= 2; throw m;`),
  bEqBoolR: row(`${D}var b = true; b = false; throw r;`),
  bEqCmpR: row(`${D}var b = true; b = (k === 1); throw r;`),
  bEqNotR: row(`${D}var b = true; b = !r; throw r;`),
  nEqNegR: row(`${D}var q = 1; q = -k; throw r;`),
  nEqKR: row(`${D}var q = 1; q = k; throw r;`),
  nEqCondR: row(`${D}var q = 1; q = k ? 1 : 2; throw r;`),
  sEqTplR: row(`${D}var s = "a"; s = \`b\`; throw r;`),
  sEqTypeofR: row(`${D}var s = "a"; s = typeof m; throw r;`),
  sEqTypeof: row(`var s = "a"; s = typeof m; throw m;`),
  nEqCommaR: row(`${D}var q = 1; q = (k, 2); throw r;`),
  // (h) alias-minted dynamic (no conditional) — outside the inversion
  aliasDAliasObjEq: row(`var r = m; var o = { a: 1 }; var p = o; if (p === null) throw "n"; throw r;`),
  aliasDArrObj: row(`var r = m; var o = [{ a: 1 }]; throw r;`),
  aliasDLateObj: row(`var r = m; var o; o = { a: 1 }; throw r;`),
  aliasDNegObj: row(`var r = m; var o = { a: 1 }; var t = -o; throw r;`),
  aliasDKEqMem: row(`var r = m; k = m.x; throw r;`),
  aliasDRPlus1: row(`var r = m; var t = r + 1; throw r;`),
  uninitDKEqMem: row(`var r; r = m; k = m.x; throw r;`),
  // (i) no-D rows for universal refusals
  qqKNoD: row(`var t = k ?? 1; throw m;`),
  qqMNoD: row(`var t = m ?? 1; throw m;`),
  throwQqNull: row(`throw m ?? null;`),
  qqStrNoD: row(`var s = "a"; var t = s ?? "b"; throw m;`),
  varVoid0: row(`var t = void 0; throw m;`),
  varVoidK: row(`var t = void k; throw m;`),
  voidPlus: row(`var t = (void 0) + 1; throw m;`),
  voidMinus: row(`var t = (void 0) - 1; throw m;`),
  voidMinusR: row(`${D}var t = (void 0) - 1; throw r;`),
  voidCond: row(`if (void 0) throw "n"; throw m;`),
  voidArg: row(`subject(void 0); throw m;`),
  kPlusEqVoid: row(`k += void 0; throw m;`),
  mPlusEqVoid: row(`m += void 0; throw m;`),
  nEqVoid: row(`var q = 1; q = void 0; throw m;`),
  chainNumNum: row(`var s = 1, t = 2; s = t = 3; throw m;`),
  chainStrStr: row(`var s = "a", t = "b"; s = t = "c"; throw m;`),
  chainDynDyn: row(`var s, t; s = t = 1; throw m;`),
  chainNumDyn: row(`var s = 1; var t; s = t = 1; throw m;`),
  chainStrNum: row(`var s = "a"; var t = 1; s = t = 1; throw m;`),
  chainStrDynR: row(`var s = "a"; var r; s = r = m; throw m;`),
  chainMod: row(`g1 = g2 = 1; throw m;`),
  chainMK: row(`m = k = 1; throw m;`),
  chainNumNumR: row(`${D}var s = 1, t = 2; s = t = 3; throw r;`),
  chainRM: row(`${D}r = m = 1; throw r;`),
  throwCommaVoid0: row(`throw (1, void 0);`),
  throwCondVoid0: row(`throw k ? void 0 : m;`),
  throwVoid0: row(`throw void 0;`),
  throwVoidNull: row(`throw void null;`),
  throwParenVoidM: row(`throw (void m);`),
  // (j) wasi residual
  subjCallNoD: row(`var o = subject(); throw m;`),
  subjCallD: row(`${D}var o = subject(); throw r;`),
  mPlusEqSubj: row(`m += subject(); throw m;`),
  rPlusEqSubjR: row(`${D}r += subject(); throw r;`),
  subjStmtNoD: row(`subject(); throw m;`),
  subjStmtD: row(`${D}subject(); throw r;`),
};
// [body, calls, pre?, doc?] — closures take (m, k)
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
