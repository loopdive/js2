// #7144 fixture — planned member-closure probe p22 (from the #6834 review rounds; see
// plan/issues/7144-ir-shared-operand-admissibility-predicate.md). Not a test: run by hand,
//   npx tsx tests/fixtures/ir-closure-probes/probe22.mts <worktree-root> [row,row,…]
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
  varV0: [`function (m, k) { ${R}var t = void 0; throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  varV0R: [`function (m, k) { ${R}${D}var t = void 0; throw r; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  plusV0: [`function (m, k) { ${R}var t = (void 0) + 1; throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  negV0: [`function (m, k) { ${R}var t = -(void 0); throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  qV0: [`function (m, k) { ${R}var q = 1; q = void 0; throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  mV0: [`function (m, k) { ${R}m = void 0; throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  rV0R: [`function (m, k) { ${R}${D}r = void 0; throw r; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  mAddV0: [`function (m, k) { ${R}m += void 0; throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  argV0: [`function (m, k) { ${R}m(void 0); throw k; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  arrV0: [`function (m, k) { ${R}var a = [void 0]; throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  eq1V0: [
    `function (m, k) { ${R}if (void 0 === 1) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  eqMV0: [
    `function (m, k) { ${R}if (void 0 === m) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  condV0: [`function (m, k) { ${R}var t = k ? void 0 : 1; throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  tplV0: [`function (m, k) { ${R}var s = "a" + (void 0); throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  andV0: [
    `function (m, k) { ${R}if (k && void 0) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  varVN: [`function (m, k) { ${R}var t = void null; throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  varVNR: [`function (m, k) { ${R}${D}var t = void null; throw r; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  plusVN: [
    `function (m, k) { ${R}var t = (void null) + 1; throw m; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  negVN: [`function (m, k) { ${R}var t = -(void null); throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  qVN: [`function (m, k) { ${R}var q = 1; q = void null; throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  mVN: [`function (m, k) { ${R}m = void null; throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  rVNR: [`function (m, k) { ${R}${D}r = void null; throw r; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  mAddVN: [`function (m, k) { ${R}m += void null; throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  argVN: [`function (m, k) { ${R}m(void null); throw k; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  arrVN: [`function (m, k) { ${R}var a = [void null]; throw m; }`, `try { subject.f(2,0); } catch (e) { n += 1; }`],
  eq1VN: [
    `function (m, k) { ${R}if (void null === 1) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  eqMVN: [
    `function (m, k) { ${R}if (void null === m) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  condVN: [
    `function (m, k) { ${R}var t = k ? void null : 1; throw m; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  tplVN: [
    `function (m, k) { ${R}var s = "a" + (void null); throw m; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
  ],
  andVN: [
    `function (m, k) { ${R}if (k && void null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { n += 1; }`,
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
