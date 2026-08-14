// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4218) TS5 checker usage tracer — measurement instrument for the
 * TypeScript-7 migration.
 *
 * The migration question is "given a parsed AST, what does the compiler still
 * need from the TS5 `ts.TypeChecker`?" — grep counts (~933 `ctx.checker`
 * references) overstate the answer because many sites are cold on real
 * inputs. This module answers it empirically: when `JS2WASM_TRACE_TS5=1`, the
 * checker handed to the pipeline is wrapped in a recording proxy that counts
 * every method invocation and attributes it to the first `src/` stack frame.
 *
 * Zero overhead when the env var is unset (the wrap sites call
 * {@link traceTs5Checker} which returns the checker untouched), so this can
 * stay wired permanently at the three `program.getTypeChecker()` sites in
 * `checker/index.ts`.
 *
 * Consumers: `scripts/audit-ts5-checker-usage.mts` compiles a corpus under
 * both oracle backends (`checker` vs `inhouse`, #4218) and diffs the traces —
 * the inhouse-backend trace IS the list of remaining TS5 checker
 * dependencies given the AST.
 */
import type { ts } from "../ts-api.js";

interface MethodTrace {
  calls: number;
  /** call-site (repo-relative file:line) → count; capped, see SITE_CAP. */
  sites: Map<string, number>;
}

/** Per-method stack captures stop after this many calls (stacks are costly). */
const STACK_SAMPLE_CAP = 400;
/** Distinct attributed sites kept per method. */
const SITE_CAP = 40;

const registry = new Map<string, MethodTrace>();

function isEnabled(): boolean {
  return typeof process !== "undefined" && !!process.env && process.env.JS2WASM_TRACE_TS5 === "1";
}

/** First stack frame inside src/ that is not this module — the caller we blame. */
function callerSite(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  for (const line of stack.split("\n").slice(1)) {
    const m = /[(\s]((?:file:\/\/)?\/[^\s)]*\/src\/[^\s)]+?):(\d+):\d+\)?$/.exec(line);
    if (!m) continue;
    if (m[1].includes("checker/ts5-trace")) continue;
    const rel = m[1].replace(/^file:\/\//, "").replace(/^.*?\/src\//, "src/");
    return `${rel}:${m[2]}`;
  }
  return undefined;
}

function record(method: string): void {
  let entry = registry.get(method);
  if (!entry) {
    entry = { calls: 0, sites: new Map() };
    registry.set(method, entry);
  }
  entry.calls++;
  if (entry.calls <= STACK_SAMPLE_CAP) {
    const site = callerSite();
    if (site && (entry.sites.has(site) || entry.sites.size < SITE_CAP)) {
      entry.sites.set(site, (entry.sites.get(site) ?? 0) + 1);
    }
  }
}

/**
 * Wrap a freshly created TS5 checker in the recording proxy. No-op (returns
 * the argument) unless `JS2WASM_TRACE_TS5=1`.
 */
export function traceTs5Checker(checker: ts.TypeChecker): ts.TypeChecker {
  if (!isEnabled()) return checker;
  const wrapped = new Map<string | symbol, unknown>();
  return new Proxy(checker, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      let fn = wrapped.get(prop);
      if (!fn) {
        fn = function (this: unknown, ...args: unknown[]) {
          record(prop);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
        wrapped.set(prop, fn);
      }
      return fn;
    },
  });
}

export interface Ts5TraceReport {
  method: string;
  calls: number;
  sites: { site: string; calls: number }[];
}

/** Snapshot the recorded trace, methods sorted by call count descending. */
export function readTs5CheckerTrace(): Ts5TraceReport[] {
  return [...registry.entries()]
    .map(([method, t]) => ({
      method,
      calls: t.calls,
      sites: [...t.sites.entries()].map(([site, calls]) => ({ site, calls })).sort((a, b) => b.calls - a.calls),
    }))
    .sort((a, b) => b.calls - a.calls);
}

/** Clear the trace between corpus files / backend runs. */
export function resetTs5CheckerTrace(): void {
  registry.clear();
}
