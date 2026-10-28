// #7144 fixture — planned member-closure probe p24 (from the #6834 review rounds; see
// plan/issues/7144-ir-shared-operand-admissibility-predicate.md). Not a test: run by hand,
//   npx tsx tests/fixtures/ir-closure-probes/probe24.mts <worktree-root> [row,row,…]
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
  regexR: row(`${D}var re = /a/; throw r;`),
  regex: row(`var re = /a/; throw m;`),
  regexTestR: row(`${D}var t = /a/.test("a"); throw r;`),
  newErrR: row(`${D}var e = new Error("x"); throw r;`),
  newErr: row(`var e = new Error("x"); throw m;`),
  newErrEqR: row(`${D}var e = new Error("x"); if (e === null) throw "n"; throw r;`),
  thisR: row(`${D}var t = this; throw r;`),
  mathPiR: row(`${D}var t = Math.PI; throw r;`),
  mathAbsR: row(`${D}var t = Math.abs(r); throw r;`),
  mathAbsKR: row(`${D}var t = Math.abs(k); throw r;`),
  mathAbsK: row(`var t = Math.abs(k); throw m;`),
  mathAliasR: row(`${D}var o = Math; throw r;`),
  mathAliasEqR: row(`${D}var o = Math; if (o === null) throw "n"; throw r;`),
  gEqMemR: row(`${D}g1 = m.x; throw r;`),
  gEqMem: row(`g1 = m.x; throw m;`),
  gEqStrR: row(`${D}g1 = "s"; throw r;`),
  gEqStr: row(`g1 = "s"; throw m;`),
  gEqKR: row(`${D}g1 = k; throw r;`),
  gEqK: row(`g1 = k; throw m;`),
  gPlusEqKR: row(`${D}g1 += k; throw r;`),
  sLenR: row(`${D}var s = "ab"; var t = s.length; throw r;`),
  sCharR: row(`${D}var s = "ab"; var t = s.charCodeAt(0); throw r;`),
  sChar: row(`var s = "ab"; var t = s.charCodeAt(0); throw m;`),
  arrLenR: row(`${D}var t = [1, 2].length; throw r;`),
  arrLen: row(`var t = [1, 2].length; throw m;`),
  arrLocLenR: row(`${D}var a = [1, 2]; var t = a.length; throw r;`),
  bigintR: row(`${D}var t = 1n; throw r;`),
  spreadR: row(`${D}var a = [1]; var b = [...a]; throw r;`),
  condMixedR: row(`${D}var t = k ? 1 : "a"; throw r;`),
  condMixed: row(`var t = k ? 1 : "a"; throw m;`),
  commaRR: row(`${D}var t = (r, 1); throw r;`),
  multiDeclR: row(`${D}var t = r, u = t; throw u;`),
  constDR: row(`const r = m ? m : 1; throw r;`),
  letDR: row(`let r = m ? m : 1; throw r;`),
  typedSlotMint: row(`var r = 0; r = m ? m : 1; throw r;`),
  twoMintsR: row(`${D}var u = r ? r : 2; throw u;`),
  twoMintsMR: row(`${D}var u = m ? m : 2; throw u;`),
  notMR: row(`${D}var t = !m; throw r;`),
  catchAssignR: row(`${D}try { throw 1; } catch (e) { r = e; } throw r;`),
  catchAssign: row(`try { throw 1; } catch (e) { m = e; } throw m;`),
  rEqArgsR: row(`${D}r = arguments; throw r;`),
  rEqSubjR: row(`${D}r = subject; throw r;`),
  rEqSubjFR: row(`${D}r = subject.f; throw r;`),
  tEqSubjFR: row(`${D}var t = subject.f; throw r;`),
  tEqSubjF: row(`var t = subject.f; throw m;`),
  rEqUndefR: row(`${D}r = undefined; throw r;`),
  rEqNullR: row(`${D}r = null; throw r;`),
  tEqUndefR: row(`${D}var t = undefined; throw r;`),
  tEqUndef: row(`var t = undefined; throw m;`),
  tEqNullR: row(`${D}var t = null; throw r;`),
  rEqNaNR: row(`${D}r = NaN; throw r;`),
  rEqInfR: row(`${D}r = Infinity; throw r;`),
  nanPlusR: row(`${D}var t = NaN + 1; throw r;`),
  nanPlus: row(`var t = NaN + 1; throw m;`),
  undefPlusR: row(`${D}var t = undefined + 1; throw r;`),
  doWhileRR: row(`${D}do { r = 0; } while (r); throw r;`),
  forCondRR: row(`${D}for (; r; ) { r = 0; } throw r;`),
  forLtRR: row(`${D}for (var i = 0; i < r; i++) { k++; } throw r;`),
  whileLtRR: row(`${D}var i = 0; while (i < r) i++; throw r;`),
  condGtRR: row(`${D}var t = r > 1 ? 1 : 2; throw r;`),
  rLooseMR: row(`${D}if (r == m) throw "n"; throw r;`),
  rEqqKR: row(`${D}if (r === k) throw "n"; throw r;`),
  kLooseRR: row(`${D}if (k == r) throw "n"; throw r;`),
  strLtRR: row(`${D}var s = "a"; if (s < r) throw "n"; throw r;`),
  strLtM: row(`var s = "a"; if (s < m) throw "n"; throw m;`),
  strLtStrR: row(`${D}var s = "a"; if (s < "b") throw r; throw "n";`),
  kLtStrR: row(`${D}if (k < "1") throw "n"; throw r;`),
  kLtStr: row(`if (k < "1") throw "n"; throw m;`),
  strEqNumR: row(`${D}var s = "1"; if (s == 1) throw r; throw "n";`),
  strEqNum: row(`var s = "1"; if (s == 1) throw m; throw "n";`),
  boolEqNumR: row(`${D}if (true == 1) throw r; throw "n";`),
  boolEqNum: row(`if (true == 1) throw m; throw "n";`),
  arrEqArrR: row(`${D}var a = [1]; var b = [1]; if (a === b) throw "n"; throw r;`),
  arrEqArr: row(`var a = [1]; var b = [1]; if (a === b) throw "n"; throw m;`),
  arrEqNumR: row(`${D}var a = [1]; if (a == 1) throw "n"; throw r;`),
  strTimesStrR: row(`${D}var s = "3"; var t = s * s; throw r;`),
  strTimesStr: row(`var s = "3"; var t = s * s; throw m;`),
  strMinusR: row(`${D}var s = "3"; var t = s - 1; throw r;`),
  strMinus: row(`var s = "3"; var t = s - 1; throw m;`),
  strPlusNumLocR: row(`${D}var s = "a"; var t = s + k; throw r;`),
  strPlusNumLoc: row(`var s = "a"; var t = s + k; throw m;`),
  boolPlusStrR: row(`${D}var t = true + "a"; throw r;`),
  boolPlusStr: row(`var t = true + "a"; throw m;`),
  boolMinusR: row(`${D}var b = true; var t = b - 1; throw r;`),
  boolMinus: row(`var b = true; var t = b - 1; throw m;`),
  cmpMinusR: row(`${D}var t = (k === 1) - 1; throw r;`),
  cmpMinus: row(`var t = (k === 1) - 1; throw m;`),
  notMinusR: row(`${D}var t = !k - 1; throw r;`),
  notMinus: row(`var t = !k - 1; throw m;`),
  typeofMinusR: row(`${D}var t = typeof k - 1; throw r;`),
  typeofMinus: row(`var t = typeof k - 1; throw m;`),
  tplMinusR: row(`${D}var t = \`3\` - 1; throw r;`),
  tplMinus: row(`var t = \`3\` - 1; throw m;`),
  tplSubMinusR: row(`${D}var t = \`\${k}\` - 1; throw r;`),
  tplSubMinus: row(`var t = \`\${k}\` - 1; throw m;`),
  tplSubKR: row(`${D}var t = \`\${k}\`; throw r;`),
  tplSubK: row(`var t = \`\${k}\`; throw m;`),
  tplSubSR: row(`${D}var s = "a"; var t = \`\${s}\`; throw r;`),
  incStrR: row(`${D}var s = "3"; s++; throw r;`),
  incStr: row(`var s = "3"; s++; throw m;`),
  incBoolR: row(`${D}var b = true; b++; throw r;`),
  incBool: row(`var b = true; b++; throw m;`),
  incKR: row(`${D}k++; throw r;`),
  incArrR: row(`${D}var a = [1]; a++; throw r;`),
  incArr: row(`var a = [1]; a++; throw m;`),
  incElR: row(`${D}var a = [1]; a[0]++; throw r;`),
  incEl: row(`var a = [1]; a[0]++; throw m;`),
  incMemR: row(`${D}m.x++; throw r;`),
  incUninitR: row(`${D}var t; t++; throw r;`),
  incUninit: row(`var t; t++; throw m;`),
  incCatchR: row(`${D}try { throw 1; } catch (e) { e++; } throw r;`),
  negUninitR: row(`${D}var t; var u = -t; throw r;`),
  negCatchR: row(`${D}try { throw 1; } catch (e) { var u = -e; } throw r;`),
  negArrR: row(`${D}var a = [1]; var u = -a; throw r;`),
  negArr: row(`var a = [1]; var u = -a; throw m;`),
  negBoolR: row(`${D}var u = -true; throw r;`),
  negBool: row(`var u = -true; throw m;`),
  negNotR: row(`${D}var u = -!k; throw r;`),
  negNot: row(`var u = -!k; throw m;`),
  negTplR: row(`${D}var u = -\`3\`; throw r;`),
  negVoidR: row(`${D}var u = -(void 0); throw r;`),
  negVoid: row(`var u = -(void 0); throw m;`),
  tildeStrR: row(`${D}var s = "3"; var u = ~s; throw r;`),
  tildeStr: row(`var s = "3"; var u = ~s; throw m;`),
  posStrR: row(`${D}var s = "3"; var u = +s; throw r;`),
  posStr: row(`var s = "3"; var u = +s; throw m;`),
  posBoolR: row(`${D}var u = +true; throw r;`),
  posBool: row(`var u = +true; throw m;`),
  arrPlusNumR: row(`${D}var a = [1]; var u = a + 1; throw r;`),
  arrPlusNum: row(`var a = [1]; var u = a + 1; throw m;`),
  arrPlusEqR: row(`${D}var a = [1]; a += 1; throw r;`),
  arrPlusEq: row(`var a = [1]; a += 1; throw m;`),
  arrEqNumWriteR: row(`${D}var a = [1]; a = 1; throw r;`),
  arrEqNumWrite: row(`var a = [1]; a = 1; throw m;`),
  arrEqArrWriteR: row(`${D}var a = [1]; a = [2]; throw r;`),
  arrEqArrWrite: row(`var a = [1]; a = [2]; throw m;`),
  arrEqStrArrR: row(`${D}var a = [1]; a = ["s"]; throw r;`),
  arrEqEmptyR: row(`${D}var a = [1]; a = []; throw r;`),
  arrEqEmpty: row(`var a = [1]; a = []; throw m;`),
  uninitEqArrR: row(`${D}var t; t = [1]; throw r;`),
  uninitEqArr: row(`var t; t = [1]; throw m;`),
  rEqArrR: row(`${D}r = [1]; throw r;`),
  mEqArr: row(`m = [1]; throw m;`),
  strArrR: row(`${D}var a = ["x"]; throw r;`),
  strArr: row(`var a = ["x"]; throw m;`),
  boolArrR: row(`${D}var a = [true]; throw r;`),
  boolArr: row(`var a = [true]; throw m;`),
  mixArrR: row(`${D}var a = [1, "x"]; throw r;`),
  kArrR: row(`${D}var a = [k]; throw r;`),
  negArrElR: row(`${D}var a = [-1]; throw r;`),
  negArrEl: row(`var a = [-1]; throw m;`),
  nestArrR: row(`${D}var a = [[1]]; throw r;`),
  nestArr: row(`var a = [[1]]; throw m;`),
  condArrR: row(`${D}var a = k ? [1] : [2]; throw r;`),
  condArr: row(`var a = k ? [1] : [2]; throw m;`),
  elEqStrR: row(`${D}var a = [1]; if (a[0] === "s") throw "n"; throw r;`),
  elPlusStrR: row(`${D}var a = [1]; var t = a[0] + "s"; throw r;`),
  elPlusStr: row(`var a = [1]; var t = a[0] + "s"; throw m;`),
  elPlusRR: row(`${D}var a = [1]; var t = a[0] + r; throw r;`),
  elEqRR: row(`${D}var a = [1]; if (a[0] === r) throw "n"; throw r;`),
  memEqMemR: row(`${D}if (m.x === m.y) throw "n"; throw r;`),
  memEqMem: row(`if (m.x === m.y) throw "n"; throw m;`),
  memPlusMemR: row(`${D}var t = m.x + m.y; throw r;`),
  memPlusMem: row(`var t = m.x + m.y; throw m;`),
  memPlusStrR: row(`${D}var t = m.x + "a"; throw r;`),
  memPlusStr: row(`var t = m.x + "a"; throw m;`),
  memTimesR: row(`${D}var t = m.x * 2; throw r;`),
  memTimes: row(`var t = m.x * 2; throw m;`),
  callTimesR: row(`${D}var t = m() * 2; throw r;`),
  callTimes: row(`var t = m() * 2; throw m;`),
  callPlusStrR: row(`${D}var t = m() + "a"; throw r;`),
  typeofTimesR: row(`${D}var t = typeof m * 2; throw r;`),
  lenTimesR: row(`${D}var t = m.length * 2; throw r;`),
  lenTimes: row(`var t = m.length * 2; throw m;`),
  lenPlusStrR: row(`${D}var t = m.length + "a"; throw r;`),
  elKR: row(`${D}var t = m[k]; throw r;`),
  elKPlusR: row(`${D}var t = m[k] + 1; throw r;`),
  elKPlus: row(`var t = m[k] + 1; throw m;`),
  callArgRR: row(`${D}m(r + 1); throw r;`),
  callArgStrR: row(`${D}m("a"); throw r;`),
  callArgArrR: row(`${D}m([1]); throw r;`),
  callArgArr: row(`m([1]); throw m;`),
  throwArrR: row(`${D}var a = [1]; throw a;`),
  throwArr: row(`var a = [1]; throw a;`),
  throwStrR: row(`${D}throw "s";`),
  throwMemR: row(`${D}throw m.x;`),
  throwCallR: row(`${D}throw m();`),
  throwTypeofR: row(`${D}throw typeof r;`),
  throwNotR: row(`${D}throw !r;`),
  throwNegR: row(`${D}throw -r;`),
  throwNeg: row(`throw -m;`),
  throwRPlusR: row(`${D}throw r + 1;`),
  throwRPlus: row(`throw m + 1;`),
  throwKPlusR: row(`${D}throw k + 1;`),
  throwKPlus: row(`throw k + 1;`),
  throwTplR: row(`${D}throw \`\${r}\`;`),
  throwLenR: row(`${D}throw r.length;`),
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
