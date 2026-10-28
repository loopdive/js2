// #7144 fixture — planned member-closure probe p10 (from the #6834 review rounds; see
// plan/issues/7144-ir-shared-operand-admissibility-predicate.md). Not a test: run by hand,
//   npx tsx tests/fixtures/ir-closure-probes/probe10.mts <worktree-root> [row,row,…]
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
  // pre-existence checks: same writes WITHOUT the conditional-minted local
  mAddNull: [
    `function (m, k) { ${R}m += null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  mSubLit: [`function (m, k) { ${R}m -= 1; throw m; }`, `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`],
  mMulQ: [
    `function (m, k) { ${R}var q = 5; m *= q; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 10) n += 1; }`,
  ],
  sMSubLit: [
    `function (m, k) { ${R}var s = m; s -= 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  uSubLit: [
    `function (m, k) { ${R}var s; s -= 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e !== e) n += 1; }`,
  ],
  constEqM: [
    `function (m, k) { ${R}const s = m; s = m; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e instanceof TypeError) n += 1; }`,
  ],
  constAddM: [
    `function (m, k) { ${R}const s = m; s += m; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e instanceof TypeError) n += 1; }`,
  ],
  constAddL: [
    `function (m, k) { ${R}const s = 1; s += 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e instanceof TypeError) n += 1; }`,
  ],
  mAddCall: [
    `function (m, k) { ${R}m += subject(); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // the conditional-minted local with concrete-RHS compound, the full set
  rSubQ: [
    `function (m, k) { ${R}var r = m ? m : 1; var q = 5; r -= q; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === -3) n += 1; }`,
  ],
  rDivLit: [
    `function (m, k) { ${R}var r = m ? m : 1; r /= 2; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  rSubM: [
    `function (m, k) { ${R}var r = m ? m : 1; r -= m; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  pSubLitR: [
    `function (m, k) { ${R}var r = m ? m : 1; m -= 1; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  dSubLitR: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = m; s -= 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  rAddUndef2: [
    `function (m, k) { ${R}var r = m ? m : 1; var u; r += u; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e !== e) n += 1; }`,
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
