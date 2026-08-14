// #2815 — suppress the spurious TS2304 "Cannot find name 'Deno'" diagnostic on
// the natively-lowered `Deno.{stdin,stdout,stderr}` synchronous-stdio surface.
//
// loopdive/js2wasm#389: js2wasm recognizes `Deno.stdin/stdout.{readSync,writeSync}`
// and lowers it to WASI fd IO (src/codegen/deno-api.ts), and the single-source
// checker path injects an ambient `Deno` d.ts (#2684) so it never warns. But the
// MULTI-FILE paths (analyzeMultiSource / analyzeFiles — used the moment the entry
// imports a shared core, the reporter's exact layout) inject no d.ts, so TS2304
// leaked as `warning: Cannot find name 'Deno'. (2×)`. The reporter asked "what's
// up with that warning?" — it's noise, same class as the `process` TS2580 that
// was already downgraded (#1951/#2603).
//
// The fix suppresses TS2304 'Deno' ONLY when the flagged identifier is the root
// of a recognized `Deno.{stdin,stdout,stderr}` property access — a genuinely
// unknown reference (bare `Deno`, `Deno.notAThing`, or any other unknown name)
// still surfaces its error.
import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { ts } from "../src/ts-api.js";
import { compileMultiSource } from "../src/compiler.js";

/** TS2304 messages mentioning a specific name, across all user files. */
function notFoundFor(files: Record<string, string>, entry: string, name: string): string[] {
  const ast = analyzeMultiSource(files, entry);
  return ast.diagnostics
    .filter((d) => d.category === 1 && d.code === 2304)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
    .filter((m) => m.includes(`'${name}'`));
}

// The reporter's layout: a thin Deno adapter that imports a shared, host-agnostic
// core. The import routes compilation through the multi-file analyzer.
const CORE = `export function run(read: (b: Uint8Array) => number | null, write: (b: Uint8Array) => number): number {
  const buf = new Uint8Array(4);
  const r = read(buf);
  if (r === null) return 0;
  return write(buf);
}`;
const DENO_ADAPTER = `import { run } from "./core";
function denoRead(b: Uint8Array): number | null { return Deno.stdin.readSync(b); }
function denoWrite(b: Uint8Array): number { return Deno.stdout.writeSync(b); }
export function main(): number { return run(denoRead, denoWrite); }`;

describe("#2815 — suppress spurious 'Cannot find name Deno'", () => {
  it("does NOT warn on the recognized Deno.stdin/stdout stdio surface (multi-file)", () => {
    expect(notFoundFor({ "core.ts": CORE, "main.ts": DENO_ADAPTER }, "main.ts", "Deno")).toEqual([]);
  });

  it("still compiles the Deno adapter to a valid wasi module without the warning", async () => {
    const r = await compileMultiSource({ "core.ts": CORE, "main.ts": DENO_ADAPTER }, "main.ts", {
      target: "wasi",
    });
    expect(r.success).toBe(true);
    expect(r.binary).toBeInstanceOf(Uint8Array);
    expect(r.binary?.length ?? 0).toBeGreaterThan(8);
    // No "Cannot find name 'Deno'" in either errors or warnings.
    const all = [...(r.errors ?? [])];
    expect(all.some((e) => e.message.includes("Cannot find name 'Deno'"))).toBe(false);
  });

  it("STILL warns on a non-stdio Deno member (genuinely unknown)", () => {
    const files = { "core.ts": "export const x = 1;", "main.ts": `import { x } from "./core"; Deno.notAThing.foo();` };
    expect(notFoundFor(files, "main.ts", "Deno")).not.toEqual([]);
  });

  it("STILL warns on a bare Deno reference (not a recognized member access)", () => {
    const files = { "core.ts": "export const x = 1;", "main.ts": `import { x } from "./core"; const d = Deno; d;` };
    expect(notFoundFor(files, "main.ts", "Deno")).not.toEqual([]);
  });

  it("does not affect unrelated unknown identifiers", () => {
    const files = { "core.ts": "export const x = 1;", "main.ts": `import { x } from "./core"; Foo.bar();` };
    expect(notFoundFor(files, "main.ts", "Foo")).not.toEqual([]);
  });
});
