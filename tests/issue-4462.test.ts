// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, type IrObservedOutcome } from "../src/index.js";

/**
 * #4462 — the IR knew only the HOST-IMPORT form of two surfaces that standalone
 * has had host-free implementations for since #3469 (`__stdout_append`) and
 * #3912 (native `number_toString`). So on the `check:ir-only` standalone corpus
 * `console` was the FIRST-wins reject arm (`host-surface-unavailable`), and
 * behind it sat `<number>.toString()` (`primitive-method-unsupported`).
 *
 * The three things these tests pin, in the order the fix had to happen:
 *   1. the capability row + lowering exist (host-free `console`, host-free
 *      `.toString()`), and produce output identical to node with ZERO imports;
 *   2. the SELECTOR narrowing is exactly as wide as the lowering — `document`
 *      still defers, and a console shape the builder does not lower is still
 *      rejected BEFORE claim rather than demoted after it;
 *   3. the host lane is untouched.
 */

const HOST_BRIDGE = { hostBridge: "always" } as const;

/** Compile standalone and drain the host-free stdout sink (#3469 readout). */
async function runStandaloneCapturingStdout(
  source: string,
  fileName = "test.ts",
): Promise<{ readonly stdout: string; readonly importCount: number }> {
  const r = await compile(source, { fileName, target: "standalone", ...HOST_BRIDGE });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance, module } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as Record<string, unknown>;
  (ex.__module_init as (() => void) | undefined)?.();
  (ex.main as (() => void) | undefined)?.();
  const prepare = ex.__stdout_prepare as (() => number) | undefined;
  const charAt = ex.__stdout_char as ((i: number) => number) | undefined;
  expect(prepare, "standalone stdout sink was not minted").toBeTypeOf("function");
  const len = prepare!();
  let stdout = "";
  for (let i = 0; i < len; i++) stdout += String.fromCharCode(charAt!(i));
  return { stdout, importCount: WebAssembly.Module.imports(module).length };
}

function outcomeFor(outcomes: readonly IrObservedOutcome[], displayName: string): IrObservedOutcome {
  const found = outcomes.find((o) => o.displayName === displayName);
  expect(found, `no IR outcome recorded for ${displayName}`).toBeDefined();
  return found!;
}

async function standaloneOutcomes(entry: string): Promise<readonly IrObservedOutcome[]> {
  const source = readFileSync(entry, "utf-8");
  const r = await compile(source, { fileName: entry, target: "standalone", trackIrOutcomes: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  return r.irOutcomes ?? [];
}

describe("#4462 host-free console sink", () => {
  it("prints through the in-module rope with zero imports", async () => {
    const { stdout, importCount } = await runStandaloneCapturingStdout(`
      export function main(): void {
        console.log("hello");
        console.log("world");
      }
    `);
    expect(stdout).toBe("hello\nworld\n");
    // The whole point of the sink (#3469/#2961): no host import may appear.
    expect(importCount).toBe(0);
  });

  it("covers every console method the IR lowers, each on its own line", async () => {
    const { stdout } = await runStandaloneCapturingStdout(`
      export function main(): void {
        console.log("a");
        console.warn("b");
        console.error("c");
        console.info("d");
        console.debug("e");
      }
    `);
    expect(stdout).toBe("a\nb\nc\nd\ne\n");
  });

  it("renders a numeric argument through the native formatter", async () => {
    const { stdout, importCount } = await runStandaloneCapturingStdout(`
      export function main(): void {
        const n: number = 42;
        console.log(n);
      }
    `);
    expect(stdout).toBe("42\n");
    expect(importCount).toBe(0);
  });

  it("does not claim a shadowed console through the host-free arm", async () => {
    // Shadow safety on the IR side: the selector's host-free arm consults the
    // checker-backed resolver, so a local `console` resolves to the USER
    // declaration and the arm never fires. The verdict below proves it routed
    // to the string-method arm instead of the console arm.
    //
    // NOTE, out of scope: LEGACY still matches `console` by identifier text
    // (`calls.ts`, no shadow guard), so a shadowed `console.log` in a
    // legacy-compiled body prints anyway. Pre-existing, untouched here.
    const r = await compile(`export function main(): void { const console: string = "x"; console.log("swallowed"); }`, {
      fileName: "test.ts",
      target: "standalone",
      trackIrOutcomes: true,
    });
    expect(r.success).toBe(true);
    const main = outcomeFor(r.irOutcomes ?? [], "main");
    expect(main.kind).toBe("unsupported");
    expect(main.kind === "unsupported" ? main.code : "").toBe("string-method-unsupported");
  });
});

describe("#4462 host-free number toString", () => {
  it("formats through the native adapter, matching node, with zero imports", async () => {
    const { stdout, importCount } = await runStandaloneCapturingStdout(`
      export function main(): void {
        const a: number = 42;
        const b: number = -7.5;
        const c: number = 0;
        console.log("a=" + a.toString() + " b=" + b.toString() + " c=" + c.toString());
      }
    `);
    expect(stdout).toBe(`a=${(42).toString()} b=${(-7.5).toString()} c=${(0).toString()}\n`);
    expect(importCount).toBe(0);
  });

  it("composes with the string-concat proof arms in a loop", async () => {
    // `joinNums`' exact shape from the standalone reference corpus: this is the
    // unit that moved out of `primitive-method-unsupported`.
    const { stdout } = await runStandaloneCapturingStdout(`
      function joinNums(arr: number[]): string {
        let s = "";
        for (let i = 0; i < arr.length; i++) {
          if (i > 0) s = s + ",";
          s = s + arr[i].toString();
        }
        return s;
      }
      export function main(): void {
        console.log(joinNums([1, 3, 5, 8]));
      }
    `);
    expect(stdout).toBe("1,3,5,8\n");
  });
});

describe("#4462 reference corpus, standalone lane", () => {
  it("claims classes.ts::main with no invariant and no legacy body", async () => {
    // The `invariant/build/unexpected-internal-throw` #4457 recorded was the
    // selector/capability-table disagreement `assertNotDeferred` is built to
    // catch: the probe opened the selector arm without the capability row or a
    // lowering. With the row and the lowering in place the disagreement cannot
    // arise, and the unit emits.
    const outcomes = await standaloneOutcomes("website/playground/examples/js/classes.ts");
    const main = outcomeFor(outcomes, "main");
    expect(main.kind).toBe("emitted");
    expect(main.irBodyEmitted).toBe(true);
    expect(main.legacyBodyEmitted).toBe(false);
    expect(outcomes.filter((o) => o.kind === "invariant")).toEqual([]);
  });

  it("claims algorithms.ts::joinNums, ::fibMemo and ::main", async () => {
    const outcomes = await standaloneOutcomes("website/playground/examples/js/algorithms.ts");
    expect(outcomeFor(outcomes, "joinNums").kind).toBe("emitted");
    // FLIPPED by #4508 — this arm was written as a tripwire and it fired.
    //
    // Composing `main` into the claim surface (this issue) enlarged the
    // prepared component until it could not seal, and both `main` and
    // `fibMemo` demoted to `resolve/late-preparation-unsupported` (`fibMemo`:
    // `source-global-outside-component` on the module-init-owned TDZ/module
    // bindings for `fibCache`; `main`: `foreign-source-unit` on the
    // now-non-candidate `fibMemo`). That was the parity gap #4494 named as its
    // manifestation 2 and explicitly did NOT close.
    //
    // #4508 fed module-binding storage edges into the same ownership fixpoint,
    // so `fibMemo` withdraws BEFORE it can claim and both units emit through
    // the post-direct overlay instead. The residual cost — four sibling units
    // losing compile-once to the bidirectional call closure — is pinned in
    // `tests/issue-4508.test.ts`, not here.
    for (const name of ["fibMemo", "main"]) {
      const observed = outcomeFor(outcomes, name);
      expect(observed.kind, `${name}: ${observed.kind === "unsupported" ? observed.code : ""}`).toBe("emitted");
      expect(observed.kind === "emitted" ? observed.irBodyEmitted : false).toBe(true);
    }
    expect(outcomes.filter((o) => o.kind === "invariant")).toEqual([]);
  });

  it("still defers the DOM surface — the narrowing is console-only", async () => {
    // `host-surface-unavailable` remains correct for `document`: legacy's own
    // standalone body for these units leaks `env.Document_createElement`, so
    // there is genuinely nothing host-free to lower to.
    const outcomes = await standaloneOutcomes("website/playground/examples/dom/calendar.ts");
    const el = outcomeFor(outcomes, "el");
    expect(el.kind).toBe("unsupported");
    expect(el.kind === "unsupported" ? el.code : "").toBe("host-surface-unavailable");
  });
});

describe("#4462 claim boundary", () => {
  /** Selector verdict for `main`, via the fallback ledger. */
  async function standaloneRejectReason(body: string): Promise<string> {
    const outcomes = await standaloneOutcomes2(`export function main(): void {${body}}`);
    const main = outcomes.find((o) => o.displayName === "main");
    expect(main, "no outcome for main").toBeDefined();
    return main!.kind === "emitted" ? "emitted" : (main as { readonly code: string }).code;
  }

  async function standaloneOutcomes2(source: string): Promise<readonly IrObservedOutcome[]> {
    const r = await compile(source, { fileName: "test.ts", target: "standalone", trackIrOutcomes: true });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    return r.irOutcomes ?? [];
  }

  it("claims the exact shape the builder lowers", async () => {
    expect(await standaloneRejectReason(`console.log("x");`)).toBe("emitted");
  });

  it.each([
    ["multi-arg", `console.log("a", "b");`],
    ["zero-arg", `console.log();`],
    ["method outside the lowered set", `console.table("x");`],
  ])("rejects %s BEFORE claim, not after", async (_label, body) => {
    // Pre-claim rejection is the point: a post-claim demote would be an
    // `irPostClaimErrors` row, and under #2138's IR-first skipped-slot rule a
    // hard error. `host-surface-unavailable` is the honest reason — the target
    // cannot service THIS console shape.
    expect(await standaloneRejectReason(body)).toBe("host-surface-unavailable");
  });
});

describe("#4462 host lane is untouched", () => {
  it("keeps lowering console through the per-variant host imports", async () => {
    const r = await compile(`export function main(): void { console.log("x"); }`, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    const names = WebAssembly.Module.imports(new WebAssembly.Module(r.binary)).map((i) => `${i.module}.${i.name}`);
    expect(names).toContain("env.console_log_string");
    // …and never mints the host-free sink there.
    expect(names.some((n) => n.includes("stdout"))).toBe(false);
  });

  it("keeps lowering <number>.toString() through env.number_toString", async () => {
    const r = await compile(`export function test(): string { const n: number = 7; return n.toString(); }`, {
      fileName: "test.ts",
    });
    expect(r.success).toBe(true);
    const names = WebAssembly.Module.imports(new WebAssembly.Module(r.binary)).map((i) => `${i.module}.${i.name}`);
    expect(names).toContain("env.number_toString");
  });
});
