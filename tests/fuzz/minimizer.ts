// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1855 — Validity-preserving test-case minimization.
 *
 * Nobody debugs a 2000-line random repro. On any differential failure this
 * shrinks the program by iteratively deleting body statements and keeping only
 * reductions that (a) **still compile** (the validity predicate: still valid TS
 * in our subset — we use successful compilation as the proxy) AND (b) **still
 * mismatch** the V8 oracle. The result is a small repro carrying the same bug.
 *
 * The reducer is a simple line-granularity ddmin-style greedy pass: it is
 * deterministic and total (it only ever removes lines, never edits them, so it
 * can't introduce new UB), which is the right safety property for a minimizer
 * whose whole value rests on never changing *why* a case fails.
 */
import { compile } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";
import type { GeneratedProgram } from "./generator.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

function toJs(source: string): string {
  return source.replace(/export function/g, "function").replace(/: number/g, "");
}

function oracleValue(source: string, args: readonly number[]): number | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const main = new Function(`${toJs(source)}\nreturn main;`)() as (...a: number[]) => number;
    const v = main(...args);
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

async function wasmValue(source: string, args: readonly number[], seed: number): Promise<number | undefined> {
  const r = await compile(source, { fileName: `fuzz-min-${seed}.ts` });
  if (!r.success) return undefined;
  try {
    const built = buildImports(r.imports, ENV_STUB, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, {
      env: built.env,
      string_constants: built.string_constants,
    });
    built.setInstance?.(instance);
    const main = (instance.exports as Record<string, unknown>).main;
    if (typeof main !== "function") return undefined;
    return (main as (...a: number[]) => number)(...args);
  } catch {
    return undefined;
  }
}

/**
 * The validity-AND-failure predicate: a candidate source still reproduces the
 * bug iff it (a) the oracle produces a finite value, (b) the wasm backend
 * compiles+runs, and (c) the two DISAGREE. Compilation success is the
 * "still valid TS in our subset" validity check; a candidate that no longer
 * compiles is rejected (it changed the failure mode).
 */
async function stillFails(source: string, args: readonly number[], seed: number): Promise<boolean> {
  const ov = oracleValue(source, args);
  if (ov === undefined) return false; // broke the oracle — not a valid reduction
  const wv = await wasmValue(source, args, seed);
  if (wv === undefined) return false; // no longer compiles/runs — invalid reduction
  return !Object.is(ov, wv);
}

/** Split a `main` function source into its head, body lines, and tail. */
function splitBody(source: string): { head: string; lines: string[]; tail: string } | null {
  const open = source.indexOf("{");
  const close = source.lastIndexOf("}");
  if (open < 0 || close < 0 || close <= open) return null;
  const head = source.slice(0, open + 1);
  const inner = source.slice(open + 1, close);
  const tail = source.slice(close);
  const lines = inner
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return { head, lines, tail };
}

function rebuild(head: string, lines: string[], tail: string): string {
  return `${head}\n  ${lines.join("\n  ")}\n${tail}\n`;
}

export interface MinimizeResult {
  /** The minimized source (or the original if no reduction held). */
  readonly source: string;
  /** Body-line count before / after. */
  readonly before: number;
  readonly after: number;
  /** The reproduced oracle/wasm values on the minimized case. */
  readonly oracle: number;
  readonly wasm: number;
}

/**
 * Greedily remove body lines while a `predicate(lines)` keeps holding. Pure
 * (no compiler dependency) and deterministic — extracted so the reduction
 * algorithm itself is unit-testable with a synthetic predicate. Lines for
 * which `keep(line)` is true (e.g. the `return`) are never removed. Repeats
 * full passes until one removes nothing (a fixpoint).
 */
export async function reduceLines(
  lines: readonly string[],
  predicate: (candidate: readonly string[]) => Promise<boolean> | boolean,
  keep: (line: string) => boolean = (l) => l.startsWith("return"),
): Promise<string[]> {
  let current = [...lines];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < current.length; i++) {
      if (keep(current[i]!)) continue;
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      if (await predicate(candidate)) {
        current = candidate;
        changed = true;
        i--; // re-examine the new line now at this index
      }
    }
  }
  return current;
}

/**
 * Greedily remove body statements while preserving the mismatch + validity.
 * Always keeps the `return` line (removing it changes the program's meaning).
 * Deterministic: passes over the lines repeatedly until a full pass removes
 * nothing.
 */
export async function minimize(program: GeneratedProgram): Promise<MinimizeResult | null> {
  const split = splitBody(program.source);
  if (!split) return null;
  const { head, tail } = split;
  const before = split.lines.length;

  // Sanity: the full program must actually fail, else nothing to minimize.
  if (!(await stillFails(rebuild(head, split.lines, tail), program.args, program.seed))) {
    return null;
  }

  const lines = await reduceLines(split.lines, (candidate) =>
    stillFails(rebuild(head, candidate, tail), program.args, program.seed),
  );

  const minimized = rebuild(head, lines, tail);
  const oracle = oracleValue(minimized, program.args)!;
  const wasm = (await wasmValue(minimized, program.args, program.seed))!;
  return { source: minimized, before, after: lines.length, oracle, wasm };
}
