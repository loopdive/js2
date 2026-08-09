// Does `allocator: "arena-reset"` lift the 409k-allocation / 16 MiB ceiling,
// and what does the reset cost? (`mod.memories.push({ min: 1, max: 256 })` in
// src/codegen-linear/runtime.ts:64 caps linear memory at 16 MiB, and __malloc
// deliberately does not branch on memory.grow returning -1 — runtime.ts:101.)
import { compile } from "../src/index.ts";

const src = `class Node { kind: number; val: number; left: Node | null; right: Node | null;
  constructor(k: number, v: number, l: Node | null, r: Node | null) { this.kind = k; this.val = v; this.left = l; this.right = r; } }
function build(d: number): Node | null { if (d === 0) return null; return new Node(d, d, build(d - 1), build(d - 1)); }
function checksum(x: Node | null): number { if (x === null) return 0; return x.kind + checksum(x.left) + checksum(x.right); }
export function bench(n: number): number { let a = 0; for (let i = 0; i < n; i++) a = (a + checksum(build(10))) | 0; return a; }`;

const PER_REP = 2 ** 10 - 1;

for (const allocator of ["bump", "arena-reset"]) {
  const r = await compile(src, { fileName: "a.ts", skipSemanticDiagnostics: true, target: "linear", optimize: 3, allocator });
  if (!r.binary?.length) {
    console.log(allocator, "CE", (r.errors ?? [])[0]?.message);
    continue;
  }
  const ex = (await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {})).exports;
  const hasReset = typeof ex.__arena_reset === "function";
  let reps = 0;
  let trapped = null;
  const t0 = performance.now();
  try {
    for (let b = 0; b < 3000; b++) {
      ex.bench(10);
      reps += 10;
      if (hasReset) ex.__arena_reset();
    }
  } catch (e) {
    trapped = String(e.message ?? e).slice(0, 40);
  }
  const ms = performance.now() - t0;
  console.log(
    `allocator=${allocator.padEnd(12)} exports __arena_reset=${hasReset}   survived ${reps} reps ` +
      `(${(reps * PER_REP).toLocaleString()} allocations) in ${ms.toFixed(0)} ms` +
      (trapped ? `   *** TRAPPED: ${trapped} ***` : "   no trap"),
  );
}
