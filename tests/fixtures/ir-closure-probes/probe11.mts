// #7144 fixture — planned member-closure probe p11 (from the #6834 review rounds; see
// plan/issues/7144-ir-shared-operand-admissibility-predicate.md). Not a test: run by hand,
//   npx tsx tests/fixtures/ir-closure-probes/probe11.mts <worktree-root> [row,row,…]
// (PROBE_LANES=standalone,gc restricts the lanes). One line per row × lane: compile ok,
// binary hash, node result, run result, post-claim errors (PCE), <module-init> outcome.
import { createHash } from "node:crypto";
import { WASI } from "node:wasi";
const tree = process.argv[2];
const { compile } = await import(`${tree}/src/index.ts`);
const SUBJ = `/** @returns {number} */ function subject() { return 0; }\n`;
const R = `if (k === 9) return; `;
const D = `var r = m ? m : 1; `;
// [body, calls, pre?] — closures take (m, k)
const C: Record<string, [string, string, string?]> = {
  // --- bare-null detection
  rAddParenNull: [
    `function (m, k) { ${R}${D}r += (null); throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  rAddParen2Null: [
    `function (m, k) { ${R}${D}r += ((null)); throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  rAddNullCoal: [
    `function (m, k) { ${R}${D}r += null ?? 1; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 3) n += 1; }`,
  ],
  rAddNulVar: [
    `function (m, k) { ${R}${D}var nul = null; r += nul; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  rAddCommaNull: [
    `function (m, k) { ${R}${D}r += (0, null); throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  rAddCondNull: [
    `function (m, k) { ${R}${D}r += k ? null : 1; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 3) n += 1; }`,
  ],
  rEqNull: [
    `function (m, k) { ${R}${D}r = null; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  mEqNull: [
    `function (m, k) { ${R}m = null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  uEqNull: [
    `function (m, k) { ${R}${D}var s; s = null; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  rEqUndef: [
    `function (m, k) { ${R}${D}r = undefined; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === undefined) n += 1; }`,
  ],
  sAddNull: [
    `function (m, k) { ${R}${D}var s = "a"; s += null; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "anull") n += 1; }`,
  ],
  sAddNullNoR: [
    `function (m, k) { ${R}var s = "a"; s += null; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "anull") n += 1; }`,
  ],
  qAddNull: [
    `function (m, k) { ${R}${D}var q = 5; q += null; throw q; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 5) n += 1; }`,
  ],
  qAddNullNoR: [
    `function (m, k) { ${R}var q = 5; q += null; throw q; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 5) n += 1; }`,
  ],
  // --- closureLocalDeclaration: let / destructured / catch / hoisted / assigned-uninit
  letSub: [
    `function (m, k) { ${R}${D}let s = m; s -= 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  letMSub: [
    `function (m, k) { ${R}let s = m; s -= 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  letUSub: [
    `function (m, k) { ${R}${D}let s; s -= r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e !== e) n += 1; }`,
  ],
  constLetAdd: [
    `function (m, k) { ${R}${D}let s = "a"; s += r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "a2") n += 1; }`,
  ],
  destAdd: [
    `function (m, k) { ${R}${D}var [s] = [m]; s += r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; }`,
  ],
  destSub: [
    `function (m, k) { ${R}${D}const [s] = [5]; s -= 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e instanceof TypeError) n += 1; }`,
  ],
  catchAdd: [
    `function (m, k) { ${R}${D}try { throw m; } catch (s) { s += r; throw s; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; }`,
  ],
  catchSub: [
    `function (m, k) { ${R}${D}try { throw m; } catch (s) { s -= 1; throw s; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  catchSubNoR: [
    `function (m, k) { ${R}try { throw m; } catch (s) { s -= 1; throw s; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  hoistSub: [
    `function (m, k) { ${R}${D}s -= 1; var s = m; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  uAssignSub: [
    `function (m, k) { ${R}var s; s = 5; s -= 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; }`,
  ],
  uAssignSubR: [
    `function (m, k) { ${R}${D}var s; s = 5; s -= 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; }`,
  ],
  uAssignAdd: [
    `function (m, k) { ${R}var s; s = 5; s += 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 6) n += 1; }`,
  ],
  uAssignAddR: [
    `function (m, k) { ${R}${D}var s; s = 5; s += 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 6) n += 1; }`,
  ],
  uEqStrAdd: [
    `function (m, k) { ${R}${D}var s; s = "a"; s += "b"; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "ab") n += 1; }`,
  ],
  kSubLit: [`function (m, k) { ${R}k -= 1; throw k; }`, `try { subject.f(2,3); } catch (e) { if (e === 2) n += 1; }`],
  mSubM: [`function (m, k) { ${R}m -= m; throw m; }`, `try { subject.f(2,0); } catch (e) { if (e === 0) n += 1; }`],
  // JSDoc-typed parameter: is it still a "dynamic slot"?
  jsSubNoR: [
    `function (m, k) { ${R}m -= 1; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
    `/** @param {number} m @param {number} k */\n`,
  ],
  jsSubR: [
    `function (m, k) { ${R}${D}m -= 1; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
    `/** @param {number} m @param {number} k */\n`,
  ],
  // module bindings now excluded by closureLocalDeclaration
  modG: [
    `function (m, k) { ${R}var s = "a"; s = g; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
    `var m = 1; var g = m ? m : 1;\n`,
  ],
  modGAdd: [
    `function (m, k) { ${R}${D}g += r; throw g; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 3) n += 1; }`,
    `var m = 1; var g = m ? m : 1;\n`,
  ],
  modUEq: [
    `function (m, k) { ${R}${D}g = r; throw g; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
    `var g;\n`,
  ],
  // --- non-write positions / arms
  throwEq: [`function (m, k) { ${R}${D}throw (m = r); }`, `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`],
  callArgAdd: [
    `function (m, k) { ${R}${D}var s; subject.g(s += r); throw s; }`,
    `subject.g = function (x) { return x; }; try { subject.f(2,0); } catch (e) { if (e === "undefined2") n += 1; }`,
  ],
  chainDynR: [
    `function (m, k) { ${R}${D}var s; var t; s = t = r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  chainConcR: [
    `function (m, k) { ${R}${D}var s = "a"; var t; s = t = r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  condRArm: [
    `function (m, k) { ${R}${D}var s; s = k ? r : 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  sCondRQ: [
    `function (m, k) { ${R}${D}var s = "a"; var q = "b"; s = k ? r : q; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "b") n += 1; }`,
  ],
  commaStmt: [
    `function (m, k) { ${R}${D}var s; var t; s = r, t = r; throw t; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  commaStmtConc: [
    `function (m, k) { ${R}${D}var s; var t = "a"; s = r, t = r; throw t; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  forUpdAdd: [
    `function (m, k) { ${R}${D}var s; for (var i = 0; i < 2; s += r) { i++; } throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "undefined22") n += 1; }`,
  ],
  forUpdSub: [
    `function (m, k) { ${R}${D}for (var i = 0; i < 2; m -= 1) { i++; } throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  forUpdSubNoR: [
    `function (m, k) { ${R}for (var i = 0; i < 2; m -= 1) { i++; } throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  forUpdConc: [
    `function (m, k) { ${R}${D}var s = "a"; for (var i = 0; i < 2; s += r) { i++; } throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "a22") n += 1; }`,
  ],
  forInitEq: [
    `function (m, k) { ${R}${D}var s = "a"; var i; for (s = r, i = 0; i < 1; i++) { } throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  forInitEqDyn: [
    `function (m, k) { ${R}${D}var s; var i; for (s = r, i = 0; i < 1; i++) { } throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // --- `=` into dynamic slot / concrete slot via other RHS shapes
  rEqStr: [
    `function (m, k) { ${R}${D}var s = "a"; r = s; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "a") n += 1; }`,
  ],
  rEqMem: [
    `function (m, k) { ${R}${D}r = subject.x; throw r; }`,
    `subject.x = 4; try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; }`,
  ],
  mEqMem: [
    `function (m, k) { ${R}m = subject.x; throw m; }`,
    `subject.x = 4; try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; }`,
  ],
  sEqRPlus: [
    `function (m, k) { ${R}${D}var s = "a"; s = r + 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 3) n += 1; }`,
  ],
  qEqRPlus: [
    `function (m, k) { ${R}${D}var q = 5; q = r + 1; throw q; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 3) n += 1; }`,
  ],
  qEqMPlus: [
    `function (m, k) { ${R}var q = 5; q = m + 1; throw q; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 3) n += 1; }`,
  ],
  elEqR: [
    `function (m, k) { ${R}${D}var a = [1]; a[0] = r; throw a[0]; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  elEqM: [
    `function (m, k) { ${R}var a = [1]; a[0] = m; throw a[0]; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  memEqR: [
    `function (m, k) { ${R}${D}subject.x = r; throw subject.x; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // --- `+=` into the dynamic slot with RHS shapes from-ast may not box
  rAddArr: [
    `function (m, k) { ${R}${D}var a = [4]; r += a; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "24") n += 1; }`,
  ],
  mAddArr: [
    `function (m, k) { ${R}var a = [4]; m += a; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "24") n += 1; }`,
  ],
  rAddNot: [
    `function (m, k) { ${R}${D}r += !m; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  rAddNeg: [
    `function (m, k) { ${R}${D}r += -k; throw r; }`,
    `try { subject.f(2,3); } catch (e) { if (e === -1) n += 1; }`,
  ],
  rAddTypeof: [
    `function (m, k) { ${R}${D}r += typeof m; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "2number") n += 1; }`,
  ],
  rAddCmp: [
    `function (m, k) { ${R}${D}r += k > 1; throw r; }`,
    `try { subject.f(2,3); } catch (e) { if (e === 3) n += 1; }`,
  ],
  rAddLitCond: [
    `function (m, k) { ${R}${D}r += k ? 1 : 2; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; }`,
  ],
  rAddConcatDyn: [
    `function (m, k) { ${R}${D}r += "a" + m; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "2a2") n += 1; }`,
  ],
  rAddTmpl: [
    `function (m, k) { ${R}${D}r += \`\${k}\`; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "20") n += 1; }`,
  ],
  // regression pins
  pAddR: [
    `function (m, k) { ${R}${D}m += r; throw m; }`,
    `try { subject.f(1,0); } catch (e) { if (e === 2) n += 1; } try { subject.f("x",0); } catch (e) { if (e === "xx") n += 2; }`,
  ],
  rSubLit: [
    `function (m, k) { ${R}${D}r -= 1; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  top: [
    `function (m, k) { ${R}throw m; }`,
    `try { subject.f(1,0); } catch (e) { if (e === 1) n += 1; }`,
    `function top(m) { var r = m ? m : 1; r += null; m -= 1; return m + r; }\nif (top(0) !== 0) throw 1;\n`,
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
for (const [k, [body, calls, pre]] of Object.entries(C)) {
  if (only.length && !only.includes(k)) continue;
  const src = (pre ?? "") + SUBJ + `subject.f = ${body};\nexport function run() { var n = 0; ${calls} return n; }`;
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
