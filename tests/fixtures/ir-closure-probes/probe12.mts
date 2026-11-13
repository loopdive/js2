// #7144 fixture — planned member-closure probe p12 (from the #6834 review rounds; see
// plan/issues/7144-ir-shared-operand-admissibility-predicate.md). Not a test: run by hand,
//   npx tsx tests/fixtures/ir-closure-probes/probe12.mts <worktree-root> [row,row,…]
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
const C: Record<string, [string, string, string?, string?]> = {
  // JSDoc-typed closure parameter (doc attached to the `subject.f = …` statement)
  jsSubNoR2: [
    `function (m, k) { ${R}m -= 1; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
    undefined,
    `/** @param {number} m @param {number} k */\n`,
  ],
  jsSubR2: [
    `function (m, k) { ${R}${D}m -= 1; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
    undefined,
    `/** @param {number} m @param {number} k */\n`,
  ],
  jsAddR2: [
    `function (m, k) { ${R}var r = k ? k : 1; m += r; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 3) n += 1; }`,
    undefined,
    `/** @param {number} m */\n`,
  ],
  jsEqR2: [
    `function (m, k) { ${R}var r = k ? k : 1; m = r; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
    undefined,
    `/** @param {number} m */\n`,
  ],
  // base-comparison rows for the probe11 PCE rows (same write, no minted local)
  mAddNullCoal: [
    `function (m, k) { ${R}m += null ?? 1; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 3) n += 1; }`,
  ],
  mAddNulVar: [
    `function (m, k) { ${R}var nul = null; m += nul; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  nulVarOnly: [
    `function (m, k) { ${R}var nul = null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  mAddCommaNull: [
    `function (m, k) { ${R}m += (0, null); throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  uEqNullNoR: [
    `function (m, k) { ${R}var s; s = null; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  sEqMPlus: [
    `function (m, k) { ${R}var s = "a"; s = m + 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 3) n += 1; }`,
  ],
  chainConcM: [
    `function (m, k) { ${R}var s = "a"; var t; s = t = m; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  rEqNullIf: [
    `function (m, k) { ${R}${D}if (k === 1) r = null; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; } try { subject.f(2,1); } catch (e) { if (e === null) n += 2; }`,
  ],
  rEqNullIfNoR: [
    `function (m, k) { ${R}if (k === 1) m = null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; } try { subject.f(2,1); } catch (e) { if (e === null) n += 2; }`,
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
