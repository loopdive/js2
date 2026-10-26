// #7144 fixture — planned member-closure probe p21 (from the #6834 review rounds; see
// plan/issues/7144-ir-shared-operand-admissibility-predicate.md). Not a test: run by hand,
//   npx tsx tests/fixtures/ir-closure-probes/probe21.mts <worktree-root> [row,row,…]
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
  chainNoD: [
    `function (m, k) { ${R}var s = "a"; var t; s = t = m; throw s; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  chainNumNoD: [
    `function (m, k) { ${R}var q = 1; var t; q = t = m; throw q; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  chainR: [
    `function (m, k) { ${R}${D}var s = "a"; var t; s = t = r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  chainDynR: [
    `function (m, k) { ${R}${D}var s; var t; s = t = r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  chainLitR: [
    `function (m, k) { ${R}${D}var s = "a"; var t = "b"; s = t = "c"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  commaWriteR: [
    `function (m, k) { ${R}${D}var s = "a"; s = (1, r); throw s; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  commaWriteNoD: [
    `function (m, k) { ${R}var s = "a"; s = (1, m); throw s; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  constEqNoD: [`function (m, k) { ${R}const s = m; s = 1; throw s; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  constAddNoD: [
    `function (m, k) { ${R}const s = m; s += m; throw s; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  constEqR: [
    `function (m, k) { ${R}${D}const s = m; s = r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  constNumR: [
    `function (m, k) { ${R}${D}const q = 1; q = 2; throw r; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  constNumNoD: [
    `function (m, k) { ${R}const q = 1; q = 2; throw m; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  sPlusNoD: [
    `function (m, k) { ${R}var s = "a"; s = m + 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  sPlusR: [
    `function (m, k) { ${R}${D}var s = "a"; s = r + 1; throw s; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  sPlusStrR: [
    `function (m, k) { ${R}${D}var s = "a"; s = "b" + r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  qPlusR: [
    `function (m, k) { ${R}${D}var q = 1; q = r + 1; throw q; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  qMinusR: [
    `function (m, k) { ${R}${D}var q = 1; q = r - 1; throw q; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  qMemR: [`function (m, k) { ${R}${D}var q = 1; q = m.x; throw r; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  qMemNoD: [`function (m, k) { ${R}var q = 1; q = m.x; throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  sCallR: [
    `function (m, k) { ${R}${D}var s = "a"; s = m(); throw r; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  rEqArrR: [
    `function (m, k) { ${R}${D}var a = [4]; r = a; throw r; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  rAddArrR: [
    `function (m, k) { ${R}${D}var a = [4]; r += a; throw r; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  negArrR: [
    `function (m, k) { ${R}${D}var a = [4]; var t = -a; throw r; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  arrPlusR: [
    `function (m, k) { ${R}${D}var a = [4]; var t = a + 1; throw r; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  arrMinusR: [
    `function (m, k) { ${R}${D}var a = [4]; var t = a - 1; throw r; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  arrPlusNoD: [
    `function (m, k) { ${R}var a = [4]; var t = a + 1; throw m; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  condWriteR: [
    `function (m, k) { ${R}${D}var s = "a"; s = k ? r : "b"; throw s; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  rEqStrR: [`function (m, k) { ${R}${D}r = "s"; throw r; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  rEqKR: [`function (m, k) { ${R}${D}r = k; throw r; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  rEqMemR: [`function (m, k) { ${R}${D}r = m.x; throw r; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
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
