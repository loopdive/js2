// #7144 fixture — planned member-closure probe p17 (from the #6834 review rounds; see
// plan/issues/7144-ir-shared-operand-admissibility-predicate.md). Not a test: run by hand,
//   npx tsx tests/fixtures/ir-closure-probes/probe17.mts <worktree-root> [row,row,…]
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
  stmtNull: [`function (m, k) { ${R}null; throw m; }`, `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`],
  stmtNullR: [
    `function (m, k) { ${R}${D}null; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtParenNull: [
    `function (m, k) { ${R}(null); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtComma1Null: [
    `function (m, k) { ${R}(1, null); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtCommaNoParen: [
    `function (m, k) { ${R}1, null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtNullComma1: [
    `function (m, k) { ${R}null, 1; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtMCommaNull: [
    `function (m, k) { ${R}m, null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtNullCommaM: [
    `function (m, k) { ${R}null, m; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtCallCommaNull: [
    `function (m, k) { ${R}subject(), null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtNullNested: [
    `function (m, k) { ${R}(1, (2, null)); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtIfNull: [
    `function (m, k) { ${R}if (k) null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtIfBlockNull: [
    `function (m, k) { ${R}if (k) { null; } throw m; }`,
    `try { subject.f(2,1); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtCondNull: [
    `function (m, k) { ${R}k ? null : 1; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtAndNull: [
    `function (m, k) { ${R}k && null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  forUpdNull: [
    `function (m, k) { ${R}for (var i = 0; i < 1; i++, null) {} throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  forUpdNullFirst: [
    `function (m, k) { ${R}for (var i = 0; i < 1; null, i++) {} throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  forUpdOnlyNull: [
    `function (m, k) { ${R}for (var i = 0; i < 1; null) { i++; } throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  forInitNull: [
    `function (m, k) { ${R}for (null; k < 1; k++) {} throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtVoidNull: [
    `function (m, k) { ${R}void null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtNullTwice: [
    `function (m, k) { ${R}null; null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtTryNull: [
    `function (m, k) { ${R}try { null; } catch (e) {} throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtCatchNull: [
    `function (m, k) { ${R}try { throw m; } catch (e) { null; throw e; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  stmtWhileNull: [
    `function (m, k) { ${R}while (k) { null; k = 0; } throw m; }`,
    `try { subject.f(2,1); } catch (e) { if (e === 2) n += 1; }`,
  ],
  thrCommaStmt: [
    `function (m, k) { ${R}throw (null, m); }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  thrCommaStmtK: [
    `function (m, k) { ${R}throw (null, k ? m : "a"); }`,
    `try { subject.f(2,0); } catch (e) { if (e === "a") n += 1; }`,
  ],
  eqSideNull: [
    `function (m, k) { ${R}if ((null, m) === null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  top: [
    `function (m, k) { return 0; }`,
    `function top(m) { null; (1, null); throw m; } try { top(2); } catch (e) { if (e === 2) n += 1; }`,
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
