// SOUNDNESS BUG (linear backend): string-literal data segments start at
// DATA_SEGMENT_BASE=64 (src/codegen-linear/index.ts:36) and the bump allocator's
// __heap_ptr starts at HEAP_START=1024 (src/codegen-linear/runtime.ts:12).
// Nothing checks that the literals fit in the 960-byte window between them, so
// a long literal spills past HEAP_START and the arena's first allocation
// overwrites it -> silently wrong charCodeAt / length. No diagnostic.
//
// Workaround exercised here: any `<number>.toString()` in the source flips
// number-format mode (number-format.ts:74-80), which moves literals to
// LINEAR_NUMBER_FORMAT_DATA_BASE=16384 and heapStart to 65536.
import { compile } from "../src/index.ts";

const mk = (n, withToString) => {
  const s = "x".repeat(n - 1) + "y";
  const extra = withToString ? `\nexport function pad(v: number): number { const t = v.toString(); return t.length; }` : "";
  return {
    s,
    src: `export function cca(i: number): number { const s = ${JSON.stringify(s)}; return s.charCodeAt(i); }
export function len(): number { const s = ${JSON.stringify(s)}; return s.length; }
export function alloc(k: number): number { const a: number[] = []; for (let i = 0; i < k; i++) a.push(i); return a.length; }${extra}`,
  };
};

for (const withToString of [false, true]) {
  console.log(`\n=== number-format mode ${withToString ? "ON (via a number .toString() in source)" : "OFF (default)"} ===`);
  for (const n of [512, 900, 940, 960, 980, 1024, 2048, 4096, 32768]) {
    const { s, src } = mk(n, withToString);
    const r = await compile(src, { fileName: "o.ts", skipSemanticDiagnostics: true, target: "linear" });
    if (!r.binary?.length) {
      console.log(`  len=${String(n).padStart(6)}  CE`);
      continue;
    }
    const ex = (await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {})).exports;
    try {
      ex.alloc(64); // force the arena to hand out memory
      let bad = 0;
      for (let i = 0; i < n; i++) if (ex.cca(i) !== s.charCodeAt(i)) bad++;
      const L = ex.len();
      console.log(
        `  len=${String(n).padStart(6)}  reported .length=${String(L).padStart(6)}${L === n ? "" : " WRONG"}  corrupted chars=${bad}${bad ? "  *** SILENT CORRUPTION ***" : ""}`,
      );
    } catch (e) {
      console.log(`  len=${String(n).padStart(6)}  TRAP: ${String(e.message ?? e).slice(0, 50)}`);
    }
  }
}
