// How far does the linear bump arena get before it trips? Find the allocation
// count at which `target: "linear"` traps with OOB, and whether the memory ever
// grows. This is the real cost of the arena's "never reclaim" model.
import { compile } from "../src/index.ts";

const src = `class Node { kind: number; val: number; left: Node | null; right: Node | null;
  constructor(k: number, v: number, l: Node | null, r: Node | null) { this.kind = k; this.val = v; this.left = l; this.right = r; } }
function build(d: number): Node | null { if (d === 0) return null; return new Node(d, d, build(d - 1), build(d - 1)); }
function checksum(x: Node | null): number { if (x === null) return 0; return x.kind + checksum(x.left) + checksum(x.right); }
export function bench(n: number): number { let a = 0; for (let i = 0; i < n; i++) a = (a + checksum(build(10))) | 0; return a; }`;

const PER_REP = 2 ** 10 - 1;

for (const target of ["linear", "standalone"]) {
  const r = await compile(src, { fileName: "a.ts", skipSemanticDiagnostics: true, target, optimize: 3 });
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {});
  const ex = inst.exports;
  const mem = Object.values(ex).find((v) => v instanceof WebAssembly.Memory);
  let reps = 0;
  let trapped = null;
  const t0 = performance.now();
  try {
    for (let b = 0; b < 2000; b++) {
      ex.bench(10);
      reps += 10;
    }
  } catch (e) {
    trapped = String(e.message ?? e);
  }
  const ms = performance.now() - t0;
  console.log(
    `${target.padEnd(11)} survived ${reps} reps (${(reps * PER_REP).toLocaleString()} node allocations) in ${ms.toFixed(0)} ms` +
      (mem ? `   final memory ${(mem.buffer.byteLength / 1048576).toFixed(1)} MiB` : "   (GC heap)") +
      (trapped ? `   *** TRAPPED: ${trapped} ***` : "   no trap"),
  );
}
