// #7144 fixture — planned member-closure probe p9 (from the #6834 review rounds; see
// plan/issues/7144-ir-shared-operand-admissibility-predicate.md). Not a test: run by hand,
//   npx tsx tests/fixtures/ir-closure-probes/probe9.mts <worktree-root> [row,row,…]
// (PROBE_LANES=standalone,gc restricts the lanes). One line per row × lane: compile ok,
// binary hash, node result, run result, post-claim errors (PCE), <module-init> outcome.
import { createHash } from "node:crypto";
import { WASI } from "node:wasi";
const tree = process.argv[2];
const { compile } = await import(`${tree}/src/index.ts`);
const SUBJ = `/** @returns {number} */ function subject() { return 0; }\n`;
const R = `if (k === 9) return; `;
// [body, calls, pre?] — closures take (m, k)
const C: Record<string, [string, string, string?]> = {
  // --- `+=` into a dynamic slot: RHS variants on the dynamic local r (r is newly minted by this PR)
  rAddLit: [
    `function (m, k) { ${R}var r = m ? m : 1; r += 1; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 3) n += 1; } try { subject.f("x",0); } catch (e) { if (e === "x1") n += 2; }`,
  ],
  rAddStr: [
    `function (m, k) { ${R}var r = m ? m : 1; r += "z"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "2z") n += 1; }`,
  ],
  rAddTrue: [
    `function (m, k) { ${R}var r = m ? m : 1; r += true; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 3) n += 1; }`,
  ],
  rAddNull: [
    `function (m, k) { ${R}var r = m ? m : 1; r += null; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  rAddUndef: [
    `function (m, k) { ${R}var r = m ? m : 1; r += undefined; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e !== e) n += 1; }`,
  ],
  rAddQ: [
    `function (m, k) { ${R}var r = m ? m : 1; var q = 5; r += q; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 7) n += 1; } try { subject.f("x",0); } catch (e) { if (e === "x5") n += 2; }`,
  ],
  rAddS: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = "a"; r += s; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "2a") n += 1; }`,
  ],
  rAddR: [
    `function (m, k) { ${R}var r = m ? m : 1; r += r; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; } try { subject.f("x",0); } catch (e) { if (e === "xx") n += 2; }`,
  ],
  rAddM: [
    `function (m, k) { ${R}var r = m ? m : 1; r += m; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; } try { subject.f(0,0); } catch (e) { if (e === 1) n += 2; }`,
  ],
  rAddK: [
    `function (m, k) { ${R}var r = m ? m : 1; r += k; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; } try { subject.f("x",1); } catch (e) { if (e === "x1") n += 2; }`,
  ],
  rAddR2: [
    `function (m, k) { ${R}var r = m ? m : 1; var r2 = k ? k : "b"; r += r2; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "2b") n += 1; } try { subject.f(2,3); } catch (e) { if (e === 5) n += 2; }`,
  ],
  rAddExpr: [
    `function (m, k) { ${R}var r = m ? m : 1; r += m + 1; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 5) n += 1; }`,
  ],
  rAddEl: [
    `function (m, k) { ${R}var r = m ? m : 1; var a = [4]; r += a[0]; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 6) n += 1; }`,
  ],
  rAddMem: [
    `function (m, k) { ${R}var r = m ? m : 1; r += subject.x; throw r; }`,
    `subject.x = 4; try { subject.f(2,0); } catch (e) { if (e === 6) n += 1; }`,
  ],
  rAddCall: [
    `function (m, k) { ${R}var r = m ? m : 1; r += subject(); throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  rAddCond: [
    `function (m, k) { ${R}var r = m ? m : 1; r += (k ? k : 2); throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; }`,
  ],
  rSubLit: [
    `function (m, k) { ${R}var r = m ? m : 1; r -= 1; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  rMulQ: [
    `function (m, k) { ${R}var r = m ? m : 1; var q = 5; r *= q; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 10) n += 1; }`,
  ],
  // laundered copies
  tAddM: [
    `function (m, k) { ${R}var r = m ? m : 1; var t = r; m += t; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; } try { subject.f(0,0); } catch (e) { if (e === 1) n += 2; }`,
  ],
  tAddS: [
    `function (m, k) { ${R}var r = m ? m : 1; var t = r; var s = "a"; s += t; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "a2") n += 1; }`,
  ],
  tSubM: [
    `function (m, k) { ${R}var r = m ? m : 1; var t = r; m -= t; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  ttAddD: [
    `function (m, k) { ${R}var r = m ? m : 1; var t = r; var u = t; var s; s += u; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "undefined2") n += 1; }`,
  ],
  parenAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; var s; s += ((r)); throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "undefined2") n += 1; }`,
  ],
  parenSub: [
    `function (m, k) { ${R}var r = m ? m : 1; m -= ((r)); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  // const / let targets
  constAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; const s = m; s += r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e instanceof TypeError) n += 1; }`,
  ],
  constEq: [
    `function (m, k) { ${R}var r = m ? m : 1; const s = m; s = r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e instanceof TypeError) n += 1; }`,
  ],
  letAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; let s; s += r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "undefined2") n += 1; }`,
  ],
  letMAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; let s = m; s += r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; }`,
  ],
  // loops
  loopDAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; var s; for (var i = 0; i < 2; i++) { s += r; } throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "undefined22") n += 1; }`,
  ],
  loopPAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; for (var i = 0; i < 2; i++) { m += r; } throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 6) n += 1; }`,
  ],
  loopDeclAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; for (var i = 0; i < 2; i++) { var s; s += r; } throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "undefined22") n += 1; }`,
  ],
  loopRDecl: [
    `function (m, k) { ${R}for (var i = 0; i < 2; i++) { var r = m ? m : 1; m += r; } throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 8) n += 1; }`,
  ],
  whileAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; var i = 0; while (i < 2) { m += r; i++; } throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 6) n += 1; }`,
  ],
  loopPSub: [
    `function (m, k) { ${R}var r = m ? m : 1; for (var i = 0; i < 2; i++) { m -= r; } throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === -2) n += 1; }`,
  ],
  // hoisting: use before declaration
  hoistAdd: [
    `function (m, k) { ${R}var s; s += r; var r = m ? m : 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "undefinedundefined") n += 1; }`,
  ],
  hoistPAdd: [
    `function (m, k) { ${R}m += r; var r = m ? m : 1; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e !== e) n += 1; }`,
  ],
  // module-level var targets
  modAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; g += r; throw g; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 7) n += 1; }`,
    `var g = 5;\n`,
  ],
  modUAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; g += r; throw g; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "undefined2") n += 1; }`,
    `var g;\n`,
  ],
  modSub: [
    `function (m, k) { ${R}var r = m ? m : 1; g -= r; throw g; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 3) n += 1; }`,
    `var g = 5;\n`,
  ],
  // captured variable (nested function)
  capAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; var s; function g() { return s; } s += r; throw g(); }`,
    `try { subject.f(2,0); } catch (e) { if (e === "undefined2") n += 1; }`,
  ],
  capPAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; function g() { return m; } m += r; throw g(); }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; }`,
  ],
  capRAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; var g = function () { return r; }; m += r; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; }`,
  ],
  // shadowing
  shadowLet: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = "a"; { let r = "q"; s += r; } throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "aq") n += 1; }`,
  ],
  shadowCatch: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = "a"; try { throw "c"; } catch (r) { s += r; } throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "ac") n += 1; }`,
  ],
  // compound as expression value (not a statement)
  throwAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; throw m += r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; }`,
  ],
  throwSub: [
    `function (m, k) { ${R}var r = m ? m : 1; throw m -= r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  valAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; var t = (m += r); throw t; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; }`,
  ],
  commaAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; var s; s += (0, r); throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "undefined2") n += 1; }`,
  ],
  ifAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; if (k === 0) m += r; else m -= r; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; } try { subject.f(2,1); } catch (e) { if (e === 0) n += 2; }`,
  ],
  // = regression rows with the new dynamic local
  rEqK: [
    `function (m, k) { ${R}var r = m ? m : 1; r = k; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  rEqLit: [
    `function (m, k) { ${R}var r = m ? m : 1; r = 5; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 5) n += 1; }`,
  ],
  sEqR: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = 3; s = r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // two params, second dynamic local, mixed
  kSubR: [
    `function (m, k) { ${R}var r = m ? m : 1; k -= r; throw k; }`,
    `try { subject.f(2,1); } catch (e) { if (e === -1) n += 1; }`,
  ],
  kAddR: [
    `function (m, k) { ${R}var r = m ? m : 1; k += r; throw k; }`,
    `try { subject.f(2,1); } catch (e) { if (e === 3) n += 1; } try { subject.f("x",1); } catch (e) { if (e === "1x") n += 2; }`,
  ],
  // string-literal-arm conditional as the dynamic local, `+=` into param
  rsAddM: [
    `function (m, k) { ${R}var r = m ? m : "d"; m += r; throw m; }`,
    `try { subject.f(0,0); } catch (e) { if (e === "0d") n += 1; } try { subject.f("x",0); } catch (e) { if (e === "xx") n += 2; }`,
  ],
  nestedCond: [
    `function (m, k) { ${R}var r = m ? (k ? k : 2) : 1; m += r; throw m; }`,
    `try { subject.f(3,0); } catch (e) { if (e === 5) n += 1; } try { subject.f(3,4); } catch (e) { if (e === 7) n += 2; }`,
  ],
  // top-level: must be byte-identical
  top: [
    `function (m, k) { ${R}throw m; }`,
    `try { subject.f(1,0); } catch (e) { if (e === 1) n += 1; }`,
    `function top(m) { var r = m ? m : 1; m += r; return m; }\nif (top(0) !== 1) throw 1;\n`,
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
      console.log(`${k.padEnd(11)} ${l.padEnd(10)} COMPILE-THROW ${String(e.message).slice(0, 120)}`);
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
      `${k.padEnd(11)} ${l.padEnd(10)} ok=${r.success ? 1 : 0} ${h} node=${nodeRes} ran=${ran} ${cmp} PCE=${JSON.stringify(pce.map((e: any) => [e.func, String(e.message ?? e.detail ?? "").slice(0, 100)]))} ${rows.join(" ")}`,
    );
    if (!r.success) console.log("   errors:", r.errors.map((e: any) => e.message.slice(0, 120)).join(" | "));
  }
}
