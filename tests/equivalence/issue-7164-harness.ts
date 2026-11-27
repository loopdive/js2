// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7164 — what the three issue-7164 test files share. The issue's rows are
// split across files only so the equivalence shards can run them in parallel
// (#7565); the lanes, the pins and the way a summary is read are one table.
import { compile } from "../../src/index.js";
import { instantiateWithRuntime } from "./helpers.js";

/** Module-side string hash: a test export returns `enc(value)`, diffed against node's. */
export const ENC = `function enc(s: string): number { let h = s.length; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h; }\n`;

export const LANES = [
  { lane: "gc", options: {} },
  { lane: "standalone", options: { target: "standalone" } },
  { lane: "wasi", options: { target: "wasi" } },
] as const;
export type Lane = (typeof LANES)[number]["lane"];
export const ALL: readonly Lane[] = ["gc", "standalone", "wasi"];
// (#6979 S7-c) WASI lowers with the native semantic regime, so it carries
// standalone's pins: every known gap and origin/main base is looked up for
// `pinLane(lane)`. The WASI-only pins these tables used to carry belonged to
// WASI's pre-regime arms; on the regime those rows match node.
export const pinLane = (lane: Lane): Lane => (lane === "wasi" ? "standalone" : lane);

/** By default the generated sweeps run a sample of their rows; JS2WASM_FULL_SWEEP=1 runs all. */
export const FULL_SWEEP = process.env.JS2WASM_FULL_SWEEP === "1";

/** The string an `at(i)` export summarises: `at(-1)` is its length, `at(i)` its i-th char code. */
export function readSummary(at: (i: number) => number): string {
  const n = at(-1);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(at(i));
  return s;
}

/** Head's summary of `src` on one lane, or `CE <message>` / `TRAP <error>`. */
export async function headSummary(src: string, options: (typeof LANES)[number]["options"]): Promise<string> {
  try {
    const result = await compile(src, { fileName: "probe.ts", ...options });
    if (!result.success) return `CE ${result.errors[0]?.message}`;
    return readSummary((await instantiateWithRuntime(result)).exports.at as (i: number) => number);
  } catch (e) {
    return `TRAP ${String(e)}`;
  }
}
