// #7144 fixture — planned member-closure probe p15 (from the #6834 review rounds; see
// plan/issues/7144-ir-shared-operand-admissibility-predicate.md). Not a test: run by hand,
//   npx tsx tests/fixtures/ir-closure-probes/probe15.mts <worktree-root> [row,row,…]
// (PROBE_LANES=standalone,gc restricts the lanes). One line per row × lane: compile ok,
// binary hash, node result, run result, post-claim errors (PCE), <module-init> outcome.
import { createHash } from "node:crypto";
const tree = process.argv[2];
const { compile } = await import(`${tree}/src/index.ts`);
const SUBJ = `/** @returns {number} */ function subject() { return 0; }\n`;
const C: Record<string, [string, string, string?]> = {
  boolLocalNoR: [
    `function (m, k) { if (k === 9) return; var b = true; if (b === null) throw "n"; throw m; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  boolLocalLooseNoR: [
    `function (m, k) { if (k === 9) return; var b = true; if (b == null) throw "n"; throw m; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  numLocalNoR: [
    `function (m, k) { if (k === 9) return; var q = 5; if (q === null) throw "n"; throw m; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  strLocalNoR: [
    `function (m, k) { if (k === 9) return; var s = "a"; if (s === null) throw "n"; throw m; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  cmpLocalNoR: [
    `function (m, k) { if (k === 9) return; var c = m === 1; if (c === null) throw "n"; throw m; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  loopCatchNoR: [
    `function (m, k) { if (k === 9) return; for (var i = 0; i < 1; i++) { try { throw m; } catch (e) { if (e === null) throw "n"; throw e; } } }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  lenNoR: [
    `function (m, k) { if (k === 9) return; if (m.length === null) throw "n"; throw m; }`,
    `try { subject.f("ab", 0); } catch (e) { if (e === "ab") n += 1; }`,
  ],
  arithNoR: [
    `function (m, k) { if (k === 9) return; if (k + 1 === null) throw "n"; throw m; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  typeofNoR: [
    `function (m, k) { if (k === 9) return; if (typeof m === null) throw "n"; throw m; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  undefIdNoR: [
    `function (m, k) { if (k === 9) return; if (m === undefined) throw "u"; throw m; }`,
    `try { subject.f(); } catch (e) { if (e === "u") n += 1; }`,
  ],
  catchEq: [
    `function (m, k) { if (k === 9) return; var r = m ? m : 1; try { throw r; } catch (e) { if (e === null) throw "n"; throw e; } }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  catchEqNoR: [
    `function (m, k) { if (k === 9) return; try { throw m; } catch (e) { if (e === null) throw "n"; throw e; } }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 0) n += 1; } try { subject.f(null, 0); } catch (e) { if (e === "n") n += 2; }`,
  ],
  boolParam: [
    `/** @param {boolean} b */ function (m, b) { var r = m ? m : 1; if (b === null) throw "n"; throw r; }`,
    `try { subject.f(0, true); } catch (e) { if (e === 1) n += 1; }`,
  ],
  boolParamNoR: [
    `/** @param {boolean} b */ function (m, b) { if (b === null) throw "n"; throw m; }`,
    `try { subject.f(0, true); } catch (e) { if (e === 0) n += 1; }`,
  ],
  numParamNoR: [
    `/** @param {number} q */ function (m, q) { if (q === null) throw "n"; throw m; }`,
    `try { subject.f(0, 1); } catch (e) { if (e === 0) n += 1; }`,
  ],
  qEqNull: [
    `function (m, k) { if (k === 9) return; var r = m ? m : 1; var q = 5; if (q === null) throw "n"; throw r; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  qLooseNull: [
    `function (m, k) { if (k === 9) return; var r = m ? m : 1; var q = 5; if (q == null) throw "n"; throw r; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  throwCommaNull: [
    `function (m, k) { if (k === 9) return; var r = m ? m : 1; if (r === 1) throw (1, null); throw r; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === null) n += 1; }`,
  ],
  throwCommaNullL: [
    `function (m, k) { if (k === 9) return; var r = m ? m : 1; if (r === 1) throw (null, 1); throw r; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  throwCommaNullLNoR: [
    `function (m, k) { if (k === 9) return; if (m === 1) throw (null, 1); throw m; }`,
    `try { subject.f(1, 0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  nullNull: [
    `function (m, k) { if (k === 9) return; var r = m ? m : 1; if (null === null) throw "n"; throw r; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === "n") n += 1; }`,
  ],
  rLoose: [
    `function (m, k) { if (k === 9) return; var r = m ? m : 1; if (r == null) throw "n"; throw r; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  strEq: [
    `function (m, k) { if (k === 9) return; var r = m ? m : 1; var s = "a"; if (s === null) throw "n"; throw r; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  undefEq: [
    `function (m, k) { if (k === 9) return; var r = m ? m : 1; if (null === undefined) throw "n"; throw r; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  boolLitEq: [
    `function (m, k) { if (k === 9) return; var r = m ? m : 1; if (true === null) throw "n"; throw r; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  litEq: [
    `function (m, k) { if (k === 9) return; var r = m ? m : 1; if (5 == null) throw "n"; throw r; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  kEq: [
    `function (m, k) { if (k === 9) return; var r = m ? m : 1; if (k === null) throw "n"; throw r; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  notR: [
    `function (m, k) { if (k === 9) return; var r = m ? m : 1; if (!r === null) throw "n"; throw r; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  th1: [`function (m) { var n = 5; throw n; }`, `try { subject.f(0); } catch (e) { if (e === 5) n += 1; }`],
  th2: [`function (m) { throw 1 + 1; }`, `try { subject.f(0); } catch (e) { if (e === 2) n += 1; }`],
  th3: [
    `function (m) { throw m + 1; }`,
    `try { subject.f(1); } catch (e) { if (e === 2) n += 1; } try { subject.f("a"); } catch (e) { if (e === "a1") n += 2; }`,
  ],
  th4: [`function (m) { throw true; }`, `try { subject.f(0); } catch (e) { if (e === true) n += 1; }`],
  th5: [`function (m) { throw 1 < 2; }`, `try { subject.f(0); } catch (e) { if (e === true) n += 1; }`],
  th7: [`function (m) { throw -m; }`, `try { subject.f(1); } catch (e) { if (e === -1) n += 1; }`],
  th8: [`function (m) { throw (42); }`, `try { subject.f(0); } catch (e) { if (e === 42) n += 1; }`],
  th9: [`function (m) { throw m ? 1 : 2; }`, `try { subject.f(0); } catch (e) { if (e === 2) n += 1; }`],
  th10: [
    `function (m) { throw m ? m : 1; }`,
    `try { subject.f(0); } catch (e) { if (e === 1) n += 1; } try { subject.f("s"); } catch (e) { if (e === "s") n += 2; }`,
  ],
  th11: [
    `function (m) { var r = m ? m : 1; throw r + 1; }`,
    `try { subject.f(0); } catch (e) { if (e === 2) n += 1; } try { subject.f("s"); } catch (e) { if (e === "s1") n += 2; }`,
  ],
  th12: [`function (m) { throw typeof m; }`, `try { subject.f(0); } catch (e) { if (e === "number") n += 1; }`],
  th14: [`function (m) { throw 1e3; }`, `try { subject.f(0); } catch (e) { if (e === 1000) n += 1; }`],
  th15: [`function (m) { var n = m; n = 5; throw n; }`, `try { subject.f(0); } catch (e) { if (e === 5) n += 1; }`],
  th16: [`function (m) { throw NaN; }`, `try { subject.f(0); } catch (e) { if (e !== e) n += 1; }`],
  th17: [`function (m) { throw Infinity; }`, `try { subject.f(0); } catch (e) { if (e === Infinity) n += 1; }`],
  th18: [`function (m) { throw m === undefined; }`, `try { subject.f(); } catch (e) { if (e === true) n += 1; }`],
  th19: [`function (m) { throw !m; }`, `try { subject.f(0); } catch (e) { if (e === true) n += 1; }`],
  th20: [`function (m) { throw m.length; }`, `try { subject.f("ab"); } catch (e) { if (e === 2) n += 1; }`],
  th21: [`function (m) { throw 0.5; }`, `try { subject.f(0); } catch (e) { if (e === 0.5) n += 1; }`],
  th22: [
    `function (m) { var k = 5; if (m) return; throw k; }`,
    `try { subject.f(0); } catch (e) { if (e === 5) n += 1; }`,
  ],
  th23: [`function (m) { if (m) return; throw 1 + 1; }`, `try { subject.f(0); } catch (e) { if (e === 2) n += 1; }`],
  th24: [`function (m) { throw m - 1; }`, `try { subject.f(2); } catch (e) { if (e === 1) n += 1; }`],
  // closure calls a top-level helper that throws 42 (helper has pre-existing top-level PCE)
  th13: [
    `function (m) { helper(); }`,
    `try { subject.f(0); } catch (e) { if (e === 42) n += 1; }`,
    `function helper() { throw 42; }\n`,
  ],
  c1: [
    `function (m, k) { if (k === 9) return; var n = 5; n = k ? (m ? m : 1) : m; throw n; }`,
    `try { subject.f(0, 1); } catch (e) { if (e === 1) n += 1; } try { subject.f("s", 0); } catch (e) { if (e === "s") n += 2; }`,
  ],
  c2: [
    `function (m, k) { if (k === 9) return; var n = 5; n = k ? m : m; throw n; }`,
    `try { subject.f("s", 1); } catch (e) { if (e === "s") n += 1; }`,
  ],
  c4: [
    `function (m) { subject.g(m ? m : 1); }`,
    `subject.g = function (x) { throw x; }; try { subject.f(0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  c5: [
    `function (m, k) { k = m ? m : 1; throw k; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; } try { subject.f("s", 0); } catch (e) { if (e === "s") n += 2; }`,
  ],
  c6: [
    `function (m) { /** @type {number} */ var r = m ? m : 1; throw r; }`,
    `try { subject.f(0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  c7: [
    `function (m) { let r = m ? m : 1; throw r; }`,
    `try { subject.f(0); } catch (e) { if (e === 1) n += 1; } try { subject.f("s"); } catch (e) { if (e === "s") n += 2; }`,
  ],
  c7b: [
    `function (m) { const r = m ? m : 1; throw r; }`,
    `try { subject.f(0); } catch (e) { if (e === 1) n += 1; } try { subject.f("s"); } catch (e) { if (e === "s") n += 2; }`,
  ],
  c9: [`function (m) { var r; r = m ? m : 1; throw r; }`, `try { subject.f(0); } catch (e) { if (e === 1) n += 1; }`],
  c10: [
    `function (m) { var r = m; r = m ? m : 1; throw r; }`,
    `try { subject.f(0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  c11: [
    `function (m) { throw (m ? m : 1); }`,
    `try { subject.f(0); } catch (e) { if (e === 1) n += 1; } try { subject.f("s"); } catch (e) { if (e === "s") n += 2; }`,
  ],
  c12: [
    `function (m) { m = (m ? m : 1); throw m; }`,
    `try { subject.f(0); } catch (e) { if (e === 1) n += 1; } try { subject.f("s"); } catch (e) { if (e === "s") n += 2; }`,
  ],
  c13: [
    `function (m, k) { var r = (m ? m : 1) ? k : 2; throw r; }`,
    `try { subject.f(0, "k"); } catch (e) { if (e === "k") n += 1; }`,
  ],
  c14: [
    `function (m, k) { var r = k ? (m ? m : 1) : 2; throw r; }`,
    `try { subject.f(0, 1); } catch (e) { if (e === 1) n += 1; } try { subject.f("s", 1); } catch (e) { if (e === "s") n += 2; } try { subject.f("s", 0); } catch (e) { if (e === 2) n += 4; }`,
  ],
  c15: [
    `function (m, k) { var r = k ? (m ? m : 1) : (k ? k : 2); throw r; }`,
    `try { subject.f(0, 1); } catch (e) { if (e === 1) n += 1; } try { subject.f("s", 0); } catch (e) { if (e === 2) n += 2; }`,
  ],
  c16: [
    `function (m) { var r = m ? m : 1; var s = "a"; s = r; throw s; }`,
    `try { subject.f(0); } catch (e) { if (e === 1) n += 1; } try { subject.f("x"); } catch (e) { if (e === "x") n += 2; }`,
  ],
  c16b: [
    `function (m) { var s = "a"; s = m; throw s; }`,
    `try { subject.f("x"); } catch (e) { if (e === "x") n += 1; }`,
  ],
  c18: [`function (m) { if (m ? m : 1) throw 'y'; }`, `try { subject.f(0); } catch (e) { if (e === "y") n += 1; }`],
  c19: [
    `function (m, k) { if (k === 9) return; var n = 5; n = (m ? m : 1); throw n; }`,
    `try { subject.f(0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  c20: [
    `function (m, k) { var r = m ? \`a\${k}\` : m; throw r; }`,
    `try { subject.f("s", 1); } catch (e) { if (e === "a1") n += 1; }`,
  ],
  c21: [
    `function (m, k) { var r = m ? m : 1, q = k ? k : 2; throw r; }`,
    `try { subject.f(0, 0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  c22: [
    `function (m) { var r = m ? m : 1; var t = r ? r : 2; throw t; }`,
    `try { subject.f(0); } catch (e) { if (e === 1) n += 1; } try { subject.f("s"); } catch (e) { if (e === "s") n += 2; }`,
  ],
  c23: [
    `function (m) { for (var i = 0; i < 1; i++) { var r = m ? m : 1; throw r; } }`,
    `try { subject.f(0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  c24: [
    `function (m) { m ? m : 1; m = m ? m : 'q'; throw m; }`,
    `try { subject.f(0); } catch (e) { if (e === "q") n += 1; } try { subject.f("s"); } catch (e) { if (e === "s") n += 2; }`,
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
    const r = await compile(src, {
      ...LANES[l],
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
      allowJs: true,
      fileName: `${k}.js`,
      deferTopLevelInit: true,
    } as any);
    const rows = (r.irOutcomes ?? [])
      .filter((e: any) => e.displayName === "<module-init>" || e.displayName === "helper")
      .map(
        (e: any) =>
          `${e.displayName}:ir=${e.irBodyEmitted ? 1 : 0}/leg=${e.legacyBodyEmitted ? 1 : 0}${e.code ? `:${e.code}` : ""}${e.shapeReason ? `{${e.shapeReason}}` : ""}`,
      );
    let ran = "-";
    if (l === "standalone" || l === "fast") {
      try {
        const { instance } = await WebAssembly.instantiate(r.binary, {});
        (instance.exports.__module_init as any)?.();
        ran = String((instance.exports.run as any)());
      } catch (e: any) {
        ran = "ERR " + String(e.message).slice(0, 60);
      }
    }
    const h = r.binary ? createHash("sha256").update(r.binary).digest("hex").slice(0, 12) : "nobin";
    const pce = (r.irPostClaimErrors ?? []).filter((e: any) => e.func !== "run");
    const cmp = l === "standalone" || l === "fast" ? (ran === nodeRes ? "SAME" : "DIFF") : "";
    console.log(
      `${k.padEnd(5)} ${l.padEnd(10)} ok=${r.success ? 1 : 0} ${h} node=${nodeRes} ran=${ran} ${cmp} PCE=${JSON.stringify(pce.map((e: any) => [e.func, String(e.message ?? e.detail ?? "").slice(0, 90)]))} ${rows.join(" ")}`,
    );
    if (!r.success) console.log("   errors:", r.errors.map((e: any) => e.message.slice(0, 120)).join(" | "));
  }
}
