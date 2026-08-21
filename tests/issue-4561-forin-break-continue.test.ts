import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

/**
 * #4561 — `break` / `continue` inside a `for-in` body were NO-OPS under
 * `--target standalone`.
 *
 * The standalone lane unrolls `for (k in o)` when the receiver is a CLOSED
 * WasmGC struct: the `__for_in_*` host imports are deliberately absent (#2572)
 * and a closed shape cannot gain or lose keys, so the static key set is exact.
 * That unroll emitted the body as a bare straight-line SEQUENCE — no enclosing
 * `block`, no `breakStack`/`continueStack` entry — so the loop had no break
 * target and every iteration ran, including the statements after the `break`.
 *
 * Three symptoms, one omission (see `src/codegen/statements/for-in-static-unroll.ts`):
 * an unlabeled `break` resolved to `breakStack.length - 1` (nothing pushed ⇒
 * silently dropped at top level, and the WRONG loop inside an enclosing one); a
 * labeled `break` looked up the index `compileLabeledStatement` had reserved
 * for the loop, which the loop never filled; and `continue` shared both.
 * `return` worked throughout, which is what made it read as break-specific.
 *
 * Every expectation here is the answer the JS-host lane already produced.
 */
async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e: { message: string }) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#4561 — break/continue in a standalone for-in", () => {
  it("stops the loop on `break` (was: ran every iteration)", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o = { a: 1, b: 2, c: 3 }; let n = 0; for (const k in o) { n = n + 1; break; } return n; }`,
      ),
    ).toBe(1);
  });

  it("does not execute statements after the `break`", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o = { a: 1, b: 2, c: 3 }; let n = 0; for (const k in o) { break; n = n + 1; } return n; }`,
      ),
    ).toBe(0);
  });

  it("honours a CONDITIONAL break part-way through the enumeration", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o = { a: 1, b: 2, c: 3 }; let n = 0; for (const k in o) { n = n + 1; if (n > 1) break; } return n; }`,
      ),
    ).toBe(2);
  });

  it("skips the rest of the body on `continue` and keeps enumerating", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o = { a: 1, b: 2, c: 3 }; let n = 0; for (const k in o) { if (k === "b") continue; n = n + 1; } return n; }`,
      ),
    ).toBe(2);
  });

  it("breaks only the INNER for-in when nested in a plain for", async () => {
    // The pre-fix unlabeled `break` resolved to the enclosing `for`'s depth —
    // not a no-op there but a break of the wrong loop, so the outer counter
    // would have stopped at 1.
    expect(
      await runStandalone(
        `export function run(): number {
           const o = { a: 1, b: 2, c: 3 };
           let inner = 0, outer = 0;
           for (let i = 0; i < 2; i++) { outer = outer + 1; for (const k in o) { inner = inner + 1; break; } }
           return outer * 10 + inner;
         }`,
      ),
    ).toBe(22);
  });

  it("honours a LABELED break that targets the for-in itself", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o = { a: 1, b: 2, c: 3 }; let n = 0; lbl: for (const k in o) { n = n + 1; break lbl; } return n; }`,
      ),
    ).toBe(1);
  });

  it("honours a LABELED continue that targets the for-in itself", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o = { a: 1, b: 2, c: 3 }; let n = 0; lbl: for (const k in o) { if (k === "b") continue lbl; n = n + 1; } return n; }`,
      ),
    ).toBe(2);
  });

  it("honours a LABELED break out of an enclosing loop from inside the for-in", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           const o = { a: 1, b: 2, c: 3 };
           let n = 0;
           outer: for (let i = 0; i < 2; i++) { for (const k in o) { n = n + 1; break outer; } }
           return n;
         }`,
      ),
    ).toBe(1);
  });

  it("breaks the inner for-in when a for-in is nested in a for-in", async () => {
    // 3 outer iterations x 1 inner each.
    expect(
      await runStandalone(
        `export function run(): number {
           const o = { a: 1, b: 2, c: 3 };
           let n = 0;
           for (const j in o) { for (const k in o) { n = n + 1; break; } }
           return n;
         }`,
      ),
    ).toBe(3);
  });

  it("leaves the DYNAMIC-receiver path (a real loop, not the unroll) working", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o: any = { a: 1, b: 2, c: 3 }; let n = 0; for (const k in o) { n = n + 1; break; } return n; }`,
      ),
    ).toBe(1);
  });

  it("leaves the ARRAY-receiver path working", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a = [10, 20, 30]; let n = 0; for (const k in a) { n = n + 1; break; } return n; }`,
      ),
    ).toBe(1);
  });

  it("still enumerates every key when the body has no abrupt completion", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o = { a: 1, b: 2, c: 3 }; let n = 0; for (const k in o) { n = n + 1; } return n; }`,
      ),
    ).toBe(3);
  });
});
