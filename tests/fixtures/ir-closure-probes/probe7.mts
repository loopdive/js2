// #7144 fixture — planned member-closure probe p7 (from the #6834 review rounds; see
// plan/issues/7144-ir-shared-operand-admissibility-predicate.md). Not a test: run by hand,
//   npx tsx tests/fixtures/ir-closure-probes/probe7.mts <worktree-root> [row,row,…]
// (PROBE_LANES=standalone,gc restricts the lanes). One line per row × lane: compile ok,
// binary hash, node result, run result, post-claim errors (PCE), <module-init> outcome.
import { createHash } from "node:crypto";
import { WASI } from "node:wasi";
const tree = process.argv[2];
const { compile } = await import(`${tree}/src/index.ts`);
const SUBJ = `/** @returns {number} */ function subject() { return 0; }\n`;
const R = `if (k === 9) return; `;
// [body, calls] — closures take (m, k)
const C: Record<string, [string, string, string?]> = {
  // finding F — string slot, each compound op, return-bearing + throw-only
  sAddR: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = "a"; s += r; throw s; }`,
    `try { subject.f(0,0); } catch (e) { if (e === "a1") n += 1; } try { subject.f("x",0); } catch (e) { if (e === "ax") n += 2; }`,
  ],
  sAddT: [
    `function (m) { var r = m ? m : 1; var s = "a"; s += r; throw s; }`,
    `try { subject.f(0); } catch (e) { if (e === "a1") n += 1; } try { subject.f("x"); } catch (e) { if (e === "ax") n += 2; }`,
  ],
  sSubR: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = "a"; s -= r; throw s; }`,
    `try { subject.f(0,0); } catch (e) { if (e !== e) n += 1; }`,
  ],
  sMulR: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = "a"; s *= r; throw s; }`,
    `try { subject.f(0,0); } catch (e) { if (e !== e) n += 1; }`,
  ],
  sDivR: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = "a"; s /= r; throw s; }`,
    `try { subject.f(0,0); } catch (e) { if (e !== e) n += 1; }`,
  ],
  sAddM: [
    `function (m, k) { ${R}var s = "a"; s += m; throw s; }`,
    `try { subject.f("x",0); } catch (e) { if (e === "ax") n += 1; }`,
  ],
  sAddParen: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = "a"; s += (r); throw s; }`,
    `try { subject.f(0,0); } catch (e) { if (e === "a1") n += 1; }`,
  ],
  // number slot, each op
  qAddR: [
    `function (m, k) { ${R}var r = m ? m : 1; var q = 5; q += r; throw q; }`,
    `try { subject.f(0,0); } catch (e) { if (e === 6) n += 1; }`,
  ],
  qSubR: [
    `function (m, k) { ${R}var r = m ? m : 1; var q = 5; q -= r; throw q; }`,
    `try { subject.f(0,0); } catch (e) { if (e === 4) n += 1; }`,
  ],
  qMulR: [
    `function (m, k) { ${R}var r = m ? m : 1; var q = 5; q *= r; throw q; }`,
    `try { subject.f(0,0); } catch (e) { if (e === 5) n += 1; }`,
  ],
  qDivR: [
    `function (m, k) { ${R}var r = m ? m : 1; var q = 5; q /= r; throw q; }`,
    `try { subject.f(0,0); } catch (e) { if (e === 5) n += 1; }`,
  ],
  qAddM: [
    `function (m, k) { ${R}var q = 5; q += m; throw q; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 7) n += 1; }`,
  ],
  qAddT: [
    `function (m) { var r = m ? m : 1; var q = 5; q += r; throw q; }`,
    `try { subject.f(0); } catch (e) { if (e === 6) n += 1; }`,
  ],
  // dynamic slots (admitted): uninit local, param
  dAddR: [
    `function (m, k) { ${R}var r = m ? m : 1; var s; s += r; throw s; }`,
    `try { subject.f(0,0); } catch (e) { if (e === "undefined1") n += 1; } try { subject.f("x",0); } catch (e) { if (e === "undefinedx") n += 2; }`,
  ],
  dAddT: [
    `function (m) { var r = m ? m : 1; var s; s += r; throw s; }`,
    `try { subject.f(0); } catch (e) { if (e === "undefined1") n += 1; } try { subject.f("x"); } catch (e) { if (e === "undefinedx") n += 2; }`,
  ],
  dSubR: [
    `function (m, k) { ${R}var r = m ? m : 1; var s; s -= r; throw s; }`,
    `try { subject.f(0,0); } catch (e) { if (e !== e) n += 1; }`,
  ],
  dmAddR: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = m; s += r; throw s; }`,
    `try { subject.f(0,0); } catch (e) { if (e === 1) n += 1; } try { subject.f("x",0); } catch (e) { if (e === "xx") n += 2; } try { subject.f(2,0); } catch (e) { if (e === 4) n += 4; }`,
  ],
  pAddR: [
    `function (m, k) { ${R}var r = m ? m : 1; m += r; throw m; }`,
    `try { subject.f(1,0); } catch (e) { if (e === 2) n += 1; } try { subject.f("x",0); } catch (e) { if (e === "xx") n += 2; } try { subject.f(0,0); } catch (e) { if (e === 1) n += 4; } try { subject.f(undefined,0); } catch (e) { if (e !== e) n += 8; }`,
  ],
  pAddT: [
    `function (m) { var r = m ? m : 1; m += r; throw m; }`,
    `try { subject.f(1); } catch (e) { if (e === 2) n += 1; } try { subject.f("x"); } catch (e) { if (e === "xx") n += 2; } try { subject.f(0); } catch (e) { if (e === 1) n += 4; }`,
  ],
  pSubR: [
    `function (m, k) { ${R}var r = m ? m : 1; m -= r; throw m; }`,
    `try { subject.f(5,0); } catch (e) { if (e === 0) n += 1; } try { subject.f("7",0); } catch (e) { if (e === 0) n += 2; } try { subject.f(0,0); } catch (e) { if (e === -1) n += 4; } try { subject.f("x",0); } catch (e) { if (e !== e) n += 8; }`,
  ],
  pMulR: [
    `function (m, k) { ${R}var r = m ? m : 1; m *= r; throw m; }`,
    `try { subject.f(3,0); } catch (e) { if (e === 9) n += 1; } try { subject.f("4",0); } catch (e) { if (e === 16) n += 2; } try { subject.f(0,0); } catch (e) { if (e === 0) n += 4; }`,
  ],
  pDivR: [
    `function (m, k) { ${R}var r = m ? m : 1; m /= r; throw m; }`,
    `try { subject.f(3,0); } catch (e) { if (e === 1) n += 1; } try { subject.f("4",0); } catch (e) { if (e === 1) n += 2; } try { subject.f(0,0); } catch (e) { if (e === 0) n += 4; } try { subject.f(null,0); } catch (e) { if (e === 0) n += 8; }`,
  ],
  pAddM: [
    `function (m, k) { ${R}m += m; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 4) n += 1; } try { subject.f("x",0); } catch (e) { if (e === "xx") n += 2; }`,
  ],
  kAddM: [
    `function (m, k) { ${R}k += m; throw k; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; } try { subject.f("x",0); } catch (e) { if (e === "0x") n += 2; }`,
  ],
  // other compound ops the arm refuses
  pModR: [
    `function (m, k) { ${R}var r = m ? m : 1; m %= r; throw m; }`,
    `try { subject.f(5,0); } catch (e) { if (e === 0) n += 1; }`,
  ],
  sModR: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = "a"; s %= r; throw s; }`,
    `try { subject.f(5,0); } catch (e) { if (e !== e) n += 1; }`,
  ],
  sOrR: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = "a"; s ||= r; throw s; }`,
    `try { subject.f(5,0); } catch (e) { if (e === "a") n += 1; }`,
  ],
  sNullR: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = "a"; s ??= r; throw s; }`,
    `try { subject.f(5,0); } catch (e) { if (e === "a") n += 1; }`,
  ],
  sExpR: [
    `function (m, k) { ${R}var r = m ? m : 1; var q = 2; q **= r; throw q; }`,
    `try { subject.f(3,0); } catch (e) { if (e === 8) n += 1; }`,
  ],
  sShlR: [
    `function (m, k) { ${R}var r = m ? m : 1; var q = 2; q <<= r; throw q; }`,
    `try { subject.f(3,0); } catch (e) { if (e === 16) n += 1; }`,
  ],
  sAndR: [
    `function (m, k) { ${R}var r = m ? m : 1; var q = 7; q &= r; throw q; }`,
    `try { subject.f(3,0); } catch (e) { if (e === 3) n += 1; }`,
  ],
  // member / element / destructuring targets with compound
  memAddR: [
    `function (m, k) { ${R}var r = m ? m : 1; subject.x += r; throw subject.x; }`,
    `subject.x = "p"; try { subject.f(0,0); } catch (e) { if (e === "p1") n += 1; }`,
  ],
  memAddM: [
    `function (m, k) { ${R}subject.x += m; throw subject.x; }`,
    `subject.x = "p"; try { subject.f("q",0); } catch (e) { if (e === "pq") n += 1; }`,
  ],
  memEqM: [
    `function (m, k) { ${R}subject.x = m; throw subject.x; }`,
    `subject.x = "p"; try { subject.f("q",0); } catch (e) { if (e === "q") n += 1; }`,
  ],
  elAddR: [
    `function (m, k) { ${R}var r = m ? m : 1; var a = [1]; a[0] += r; throw a[0]; }`,
    `try { subject.f(0,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  elAddM: [
    `function (m, k) { ${R}var a = [1]; a[0] += m; throw a[0]; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 3) n += 1; }`,
  ],
  destR: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = "a"; [s] = [r]; throw s; }`,
    `try { subject.f(0,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  // chains
  chainEq: [
    `function (m, k) { ${R}var s = "a"; var r; s = r = m; throw s; }`,
    `try { subject.f("x",0); } catch (e) { if (e === "x") n += 1; }`,
  ],
  chainEqT: [
    `function (m) { var s = "a"; var r; s = r = m; throw s; }`,
    `try { subject.f("x"); } catch (e) { if (e === "x") n += 1; }`,
  ],
  chainAdd: [
    `function (m, k) { ${R}var s = "a"; var r; s += r = m; throw s; }`,
    `try { subject.f("x",0); } catch (e) { if (e === "ax") n += 1; }`,
  ],
  chainDyn: [
    `function (m, k) { ${R}var s; var r; s = r = m; throw s; }`,
    `try { subject.f("x",0); } catch (e) { if (e === "x") n += 1; }`,
  ],
  // direct conditional into compound
  sAddCond: [
    `function (m, k) { ${R}var s = "a"; s += (m ? m : 1); throw s; }`,
    `try { subject.f(0,0); } catch (e) { if (e === "a1") n += 1; }`,
  ],
  dAddCond: [
    `function (m, k) { ${R}var s; s += (m ? m : 1); throw s; }`,
    `try { subject.f(0,0); } catch (e) { if (e === "undefined1") n += 1; }`,
  ],
  pAddCond: [
    `function (m, k) { ${R}m += (m ? m : 1); throw m; }`,
    `try { subject.f(0,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  pEqCond: [
    `function (m, k) { ${R}m = (m ? m : 1); throw m; }`,
    `try { subject.f(0,0); } catch (e) { if (e === 1) n += 1; } try { subject.f("s",0); } catch (e) { if (e === "s") n += 2; }`,
  ],
  // regression: plain = rows from r3
  c16: [
    `function (m) { var r = m ? m : 1; var s = "a"; s = r; throw s; }`,
    `try { subject.f(0); } catch (e) { if (e === 1) n += 1; } try { subject.f("x"); } catch (e) { if (e === "x") n += 2; }`,
  ],
  c9: [
    `function (m) { var r; r = m ? m : 1; throw r; }`,
    `try { subject.f(0); } catch (e) { if (e === 1) n += 1; } try { subject.f("s"); } catch (e) { if (e === "s") n += 2; }`,
  ],
  c10: [
    `function (m) { var r = m; r = m ? m : 1; throw r; }`,
    `try { subject.f(0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  // compound in loop / nested block / with typed JSDoc slot
  loopAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; var s = "a"; for (var i = 0; i < 2; i++) { s += r; } throw s; }`,
    `try { subject.f(0,0); } catch (e) { if (e === "a11") n += 1; }`,
  ],
  jsdocAdd: [
    `function (m, k) { ${R}var r = m ? m : 1; /** @type {number} */ var q = 5; q += r; throw q; }`,
    `try { subject.f(0,0); } catch (e) { if (e === 6) n += 1; }`,
  ],
  // top-level (not closure) — must be byte-identical
  top: [
    `function (m, k) { ${R}throw m; }`,
    `try { subject.f(1,0); } catch (e) { if (e === 1) n += 1; }`,
    `function top(m) { var r = m ? m : 1; var s = "a"; s += r; return s; }\nif (top(0) !== "a1") throw 1;\n`,
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
      console.log(`${k.padEnd(9)} ${l.padEnd(10)} COMPILE-THROW ${String(e.message).slice(0, 120)}`);
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
    if (r.success && l === "gc") {
      try {
        const mod = await WebAssembly.compile(r.binary);
        const imports: any = {};
        for (const imp of WebAssembly.Module.imports(mod)) {
          (imports[imp.module] ??= {})[imp.name] =
            imp.kind === "function"
              ? () => {
                  throw new Error("stub:" + imp.module + "." + imp.name);
                }
              : undefined;
        }
        const instance = await WebAssembly.instantiate(mod, imports);
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
      `${k.padEnd(9)} ${l.padEnd(10)} ok=${r.success ? 1 : 0} ${h} node=${nodeRes} ran=${ran} ${cmp} PCE=${JSON.stringify(pce.map((e: any) => [e.func, String(e.message ?? e.detail ?? "").slice(0, 90)]))} ${rows.join(" ")}`,
    );
    if (!r.success) console.log("   errors:", r.errors.map((e: any) => e.message.slice(0, 120)).join(" | "));
  }
}
