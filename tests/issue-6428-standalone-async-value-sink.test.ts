import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProject } from "../src/index.js";

/**
 * (#6428) Standalone / WASI: the #1727 raw-value sink must unwrap a settled
 * native `$Promise`.
 *
 * §27.7.5.2 resolves an async function's promise capability with the return
 * value and §27.2.1.3.2 makes a thenable result adopt. #5371 fixed the
 * RESULT-CARRIER half — a legacy pass-through async fn whose body can `return`
 * a thenable keeps its wasm result on the externref carrier — which on the host
 * lane lets the call site's adopting `Promise.resolve` settle with the inner
 * value. On the host-free carrier lane (`--target wasi` / `--target
 * standalone`) there is no host adopt, so the raw-value consumer
 * `(f() as unknown as number)` coerced that `$Promise` externref straight to
 * f64 → `NaN`.
 *
 * Rows r1–r4 read `NaN` on the parent commit (8 of these 12 assertions are red
 * there). Controls c1/c2 already answered `7` on the parent and are the
 * anti-vacuity check: they pin the two shapes whose async result is a raw f64
 * and must NOT move, so a blanket "unwrap everything" fix is distinguishable
 * from the guarded one.
 *
 * Two files on purpose (an imported producer module + a `.ts` entry holding the
 * sinks): the sink is a TS-cast idiom by construction, and the cross-module
 * shape is the one the dogfood consumers hit. An UNTYPED `.js` producer half
 * cannot be used here — on `--target wasi` a `compileProject` whose graph
 * contains a `.js` module traps at the first exported call regardless of async
 * (a plain `export function c2() { return 7 }` traps identically); that is a
 * separate pre-existing defect, tracked as its own issue, not this one.
 */

const roots: string[] = [];

afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const MOD_TS = `
export async function r1(): Promise<number> { return Promise.resolve(7); }
function mk(): Promise<number> { return Promise.resolve(8); }
export async function r2(): Promise<number> { return mk(); }
export async function r3(): Promise<number> { const p = Promise.resolve(9); return p; }
async function r4inner(): Promise<number> { return Promise.resolve(7); }
export async function r4(): Promise<number> { const v = await r4inner(); return v; }
export async function c1(): Promise<number> { return await Promise.resolve(7); }
export async function c2(): Promise<number> { return 7; }
`;

const ENTRY_TS = `
import { r1, r2, r3, r4, c1, c2 } from "./mod.js";
export function t1(): number { return (r1() as unknown as number); }
export function t2(): number { return (r2() as unknown as number); }
export function t3(): number { return (r3() as unknown as number); }
export function t4(): number { return (r4() as unknown as number); }
export function tc1(): number { return (c1() as unknown as number); }
export function tc2(): number { return (c2() as unknown as number); }
`;

async function buildExports(target: "wasi" | "standalone"): Promise<Record<string, () => number>> {
  const root = mkdtempSync(join(tmpdir(), "js2-6428-"));
  roots.push(root);
  writeFileSync(join(root, "mod.ts"), MOD_TS);
  writeFileSync(join(root, "entry.ts"), ENTRY_TS);
  const result = await compileProject(join(root, "entry.ts"), { target });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as unknown as Record<string, () => number>;
}

for (const target of ["wasi", "standalone"] as const) {
  describe(`#6428 async value sink (--target ${target})`, () => {
    it("r1: `return Promise.resolve(7)` from an async fn reaches the cast sink as 7", async () => {
      expect((await buildExports(target)).t1()).toBe(7);
    });

    it("r2: `return mk()` (a plain Promise-returning callee) reaches the cast sink as 8", async () => {
      expect((await buildExports(target)).t2()).toBe(8);
    });

    it("r3: `const p = Promise.resolve(9); return p` reaches the cast sink as 9", async () => {
      expect((await buildExports(target)).t3()).toBe(9);
    });

    it("r4: an awaiting async fn returning the awaited value reaches the cast sink as 7", async () => {
      expect((await buildExports(target)).t4()).toBe(7);
    });

    it("control c1: `return await Promise.resolve(7)` is unchanged (7)", async () => {
      expect((await buildExports(target)).tc1()).toBe(7);
    });

    it("control c2: `return 7` is unchanged (7)", async () => {
      expect((await buildExports(target)).tc2()).toBe(7);
    });
  });
}
