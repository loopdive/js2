// #7144 fixture — planned member-closure probe p14 (from the #6834 review rounds; see
// plan/issues/7144-ir-shared-operand-admissibility-predicate.md). Not a test: run by hand,
//   npx tsx tests/fixtures/ir-closure-probes/probe14.mts <worktree-root> [row,row,…]
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
  // ---- equality: null on the LEFT / loose / parens / other operand kinds (without D = pre-existence twin)
  eqLeftM: [
    `function (m, k) { ${R}if (null === m) throw "n"; throw m; }`,
    `try { subject.f(null,0); } catch (e) { if (e === "n") n += 1; }`,
  ],
  eqLeftR: [
    `function (m, k) { ${R}${D}if (null === r) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  neR: [
    `function (m, k) { ${R}${D}if (r !== null) throw r; throw "n"; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  looseEqM: [
    `function (m, k) { ${R}if (m == null) throw "n"; throw m; }`,
    `try { subject.f(null,0); } catch (e) { if (e === "n") n += 1; }`,
  ],
  looseEqR: [
    `function (m, k) { ${R}${D}if (r == null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  looseNeM: [
    `function (m, k) { ${R}if (m != null) throw m; throw "n"; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  looseNeR: [
    `function (m, k) { ${R}${D}if (r != null) throw r; throw "n"; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  looseLeftR: [
    `function (m, k) { ${R}${D}if (null == r) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  eqK: [
    `function (m, k) { ${R}${D}if (k === null) throw "n"; throw r; }`,
    `try { subject.f(2,null); } catch (e) { if (e === "n") n += 1; }`,
  ],
  eqQ: [
    `function (m, k) { ${R}var q = 5; if (q === null) throw "n"; throw q; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 5) n += 1; }`,
  ],
  eqQR: [
    `function (m, k) { ${R}${D}var q = 5; if (q === null) throw "n"; throw q; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 5) n += 1; }`,
  ],
  looseEqQR: [
    `function (m, k) { ${R}${D}var q = 5; if (q == null) throw "n"; throw q; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 5) n += 1; }`,
  ],
  eqS: [
    `function (m, k) { ${R}var s = "a"; if (s === null) throw "n"; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "a") n += 1; }`,
  ],
  eqSR: [
    `function (m, k) { ${R}${D}var s = "a"; if (s === null) throw "n"; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "a") n += 1; }`,
  ],
  eqArr: [
    `function (m, k) { ${R}var a = [1]; if (a === null) throw "n"; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  eqArrR: [
    `function (m, k) { ${R}${D}var a = [1]; if (a === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  eqCatch: [
    `function (m, k) { ${R}${T}if (e === null) throw "n"; throw e; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  eqCatchR: [
    `function (m, k) { ${R}${D}${T}if (e === null) throw "n"; throw e; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  looseCatchR: [
    `function (m, k) { ${R}${D}${T}if (e == null) throw "n"; throw e; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  eqMem: [
    `function (m, k) { ${R}if (subject.x === null) throw "n"; throw m; }`,
    `subject.x = 4; try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  eqMemR: [
    `function (m, k) { ${R}${D}if (subject.x === null) throw "n"; throw r; }`,
    `subject.x = 4; try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  eqNullNull: [
    `function (m, k) { ${R}${D}if (null === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "n") n += 1; }`,
  ],
  eqNullUndef: [
    `function (m, k) { ${R}${D}if (null === undefined) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  parenRight: [
    `function (m, k) { ${R}if (m === (null)) throw "n"; throw m; }`,
    `try { subject.f(null,0); } catch (e) { if (e === "n") n += 1; }`,
  ],
  parenRightR: [
    `function (m, k) { ${R}${D}if (r === (null)) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  parenLeftR: [
    `function (m, k) { ${R}${D}if ((null) === r) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  parenWholeR: [
    `function (m, k) { ${R}${D}if ((r === null)) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  eqInCondR: [
    `function (m, k) { ${R}${D}var s = r === null ? 1 : 2; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  eqAndR: [
    `function (m, k) { ${R}${D}if (r !== null && r !== 5) throw r; throw "n"; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  eqNotR: [
    `function (m, k) { ${R}${D}if (!(r === null)) throw r; throw "n"; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // ---- throw operand variants
  throwParen: [
    `function (m, k) { ${R}${D}if (r === 2) throw (null); throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  throwParen2: [
    `function (m, k) { ${R}${D}if (r === 2) throw ((null)); throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  throwCommaL: [
    `function (m, k) { ${R}${D}if (r === 2) throw (null, 1); throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 1) n += 1; }`,
  ],
  throwCommaR: [
    `function (m, k) { ${R}${D}if (r === 2) throw (1, null); throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  throwCommaRNoR: [
    `function (m, k) { ${R}throw (1, null); }`,
    `try { subject.f(2,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  throwNullQqM: [
    `function (m, k) { ${R}${D}throw null ?? r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  throwNullQqE: [
    `function (m, k) { ${R}${T}throw null ?? e; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  throwNullQqER: [
    `function (m, k) { ${R}${D}${T}throw null ?? e; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  throwEQqNull: [
    `function (m, k) { ${R}${T}throw e ?? null; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  throwEQqNullR: [
    `function (m, k) { ${R}${D}${T}throw e ?? null; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  varEQqNull: [
    `function (m, k) { ${R}${T}var s = e ?? null; throw s; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  varEQqNullR: [
    `function (m, k) { ${R}${D}${T}var s = e ?? null; throw s; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  varMQqNull: [
    `function (m, k) { ${R}var s = m ?? null; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  throwMQqNull: [
    `function (m, k) { ${R}throw m ?? null; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  throwCondNull: [
    `function (m, k) { ${R}throw k ? null : "x"; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "x") n += 1; }`,
  ],
  throwCondNullR: [
    `function (m, k) { ${R}${D}throw k ? null : r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  throwAndNull: [
    `function (m, k) { ${R}${D}throw r && null; }`,
    `try { subject.f(2,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  throwOrNull: [
    `function (m, k) { ${R}${D}throw k || null; }`,
    `try { subject.f(2,0); } catch (e) { if (e === null) n += 1; }`,
  ],
  // ---- other value positions
  retNull: [
    `function (m, k) { if (k === 9) return null; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; } if (subject.f(2,9) === null) n += 10;`,
  ],
  retNullR: [
    `function (m, k) { ${D}if (k === 9) return null; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; } if (subject.f(2,9) === null) n += 10;`,
  ],
  retNullOnly: [`function (m, k) { return null; }`, `if (subject.f(2,9) === null) n += 1;`],
  argNullR: [
    `function (m, k) { ${R}${D}subject.g(null); throw r; }`,
    `subject.g = function (x) { return x; }; try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  arrNull: [
    `function (m, k) { ${R}var a = [null]; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  arrNullR: [
    `function (m, k) { ${R}${D}var a = [null]; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  objNull: [
    `function (m, k) { ${R}var o = { a: null }; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  objNullR: [
    `function (m, k) { ${R}${D}var o = { a: null }; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  typeofNull: [
    `function (m, k) { ${R}throw typeof null; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "object") n += 1; }`,
  ],
  typeofNullR: [
    `function (m, k) { ${R}${D}if (r === 2) throw typeof null; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === "object") n += 1; }`,
  ],
  notNull: [
    `function (m, k) { ${R}if (!null) throw m; throw k; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  notNullR: [
    `function (m, k) { ${R}${D}if (!null) throw r; throw k; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  voidNullR: [
    `function (m, k) { ${R}${D}if (r === 2) throw void null; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === undefined) n += 1; }`,
  ],
  condTestNull: [
    `function (m, k) { ${R}var s = null ? 1 : 2; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  condTestNullR: [
    `function (m, k) { ${R}${D}var s = null ? 1 : 2; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  ifNull: [
    `function (m, k) { ${R}if (null) throw k; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  ifNullR: [
    `function (m, k) { ${R}${D}if (null) throw k; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  nestedNull: [
    `function (m, k) { ${R}var f = function () { return null; }; throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  nestedNullR: [
    `function (m, k) { ${R}${D}var f = function () { return null; }; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  switchNullR: [
    `function (m, k) { ${R}${D}switch (r) { case null: throw "n"; default: throw r; } }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  memEqNullR: [
    `function (m, k) { ${R}${D}subject.x = null; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2 && subject.x === null) n += 1; }`,
  ],
  elEqNullR: [
    `function (m, k) { ${R}${D}var a = [1]; a[0] = null; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  // ---- write rule after the removal
  rAddNull: [
    `function (m, k) { ${R}${D}r += null; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  rSubNull: [
    `function (m, k) { ${R}${D}r -= null; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  sSubR: [
    `function (m, k) { ${R}${D}var s = "a"; s -= r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e !== e) n += 1; }`,
  ],
  qSubR: [
    `function (m, k) { ${R}${D}var q = 5; q -= r; throw q; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 3) n += 1; }`,
  ],
  sEqR: [
    `function (m, k) { ${R}${D}var s = "a"; s = r; throw s; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; }`,
  ],
  rEqUndefNull: [
    `function (m, k) { ${R}${D}r = undefined; if (r === null) throw "n"; throw r; }`,
    `try { subject.f(2,0); } catch (e) { if (e === undefined) n += 1; }`,
  ],
  top: [
    `function (m, k) { ${R}throw m; }`,
    `try { subject.f(2,0); } catch (e) { if (e === 2) n += 1; } try { top(null); } catch (e) { if (e === null) n += 10; }`,
    `function top(m) { var r = m ? m : 1; if (r == null) throw null; r = null; return r ?? null; }\n`,
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
