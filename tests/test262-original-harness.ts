// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface HarnessMeta {
  flags?: string[];
  includes?: string[];
}

export interface OriginalHarnessVariant {
  source: string;
  bodyLineOffset: number;
  strict: boolean;
}

export interface OriginalHarnessAssembly {
  primary: OriginalHarnessVariant;
  strictRerun?: OriginalHarnessVariant;
  async: boolean;
  raw: boolean;
}

const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..");
const HARNESS_ROOT = join(PROJECT_ROOT, "test262", "harness");
const RUNTIME_PATH = join(PROJECT_ROOT, "scripts", "test262-fyi-runtime.js");
const sourceCache = new Map<string, string>();

function cachedSource(path: string): string {
  let source = sourceCache.get(path);
  if (source === undefined) {
    source = readFileSync(path, "utf8");
    sourceCache.set(path, source);
  }
  return source;
}

function harnessSource(name: string): string {
  return cachedSource(join(HARNESS_ROOT, name));
}

function lineCount(source: string): number {
  if (source.length === 0) return 0;
  return source.split("\n").length - 1;
}

/**
 * (#3427) De-duplicate TOP-LEVEL `function NAME(...)` declarations across the
 * assembled harness prefix. The authoritative upstream harness (#3370) defines
 * the same helper in more than one include — notably `isPrimitive`, declared by
 * BOTH `testTypedArray.js` and `assert.js` with identical bodies. A real JS
 * engine (which is what test262.fyi runs) tolerates duplicate top-level function
 * declarations under last-wins semantics, so the reference runner is unaffected;
 * but our TypeScript front-end treats two `function isPrimitive` declarations as
 * a hard `Duplicate identifier 'isPrimitive'` compile error at L1 — which failed
 * ~2k TypedArray/Array tests in EACH lane before this fix.
 *
 * Rename every duplicate declaration EXCEPT the last to a dead `NAME$dupK`
 * identifier. This matches JS last-wins exactly (the final declaration is the
 * one all call sites bind to — function declarations hoist, so calls that appear
 * before it still resolve to it), leaves the renamed earlier definitions as
 * harmless unused functions, and — because only the declaration's name token is
 * rewritten (no lines added/removed) — keeps `bodyLineOffset` (`lineCount`)
 * exact so test-body error line mapping is unchanged. Only column-0
 * declarations match (`^`, multiline), so nested/inner functions and named
 * function EXPRESSIONS (`x = function foo(){}`) are never touched, and the
 * untouched test body is deliberately excluded (dedup runs on the prefix only).
 */
function dedupeTopLevelFunctionDeclarations(prefix: string): string {
  const declRe = /^((?:async[ \t]+)?function[ \t]+)([A-Za-z_$][\w$]*)([ \t]*\()/gm;
  const total = new Map<string, number>();
  prefix.replace(declRe, (full, _kw: string, name: string) => {
    total.set(name, (total.get(name) ?? 0) + 1);
    return full;
  });
  const dup = new Set([...total].filter(([, count]) => count > 1).map(([name]) => name));
  if (dup.size === 0) return prefix;
  const seen = new Map<string, number>();
  return prefix.replace(declRe, (full, kw: string, name: string, paren: string) => {
    if (!dup.has(name)) return full;
    const idx = seen.get(name) ?? 0;
    seen.set(name, idx + 1);
    // Keep the LAST declaration (JS last-wins); rename the earlier ones.
    if (idx === total.get(name)! - 1) return full;
    return `${kw}${name}$dup${idx}${paren}`;
  });
}

function assembleVariant(
  source: string,
  meta: HarnessMeta,
  strict: boolean,
  raw: boolean,
  async: boolean,
): OriginalHarnessVariant {
  if (raw) return { source, bodyLineOffset: 0, strict };

  // Keep this order byte-for-byte equivalent to test262.fyi/data/runner/read.js:
  // strict directive, async helper, metadata includes, runtime shim, assert.js,
  // sta.js, and finally the untouched upstream test body.
  let prefix = strict ? '"use strict";\n' : "";
  if (async) prefix += harnessSource("doneprintHandle.js");
  for (const include of meta.includes ?? []) prefix += harnessSource(include);
  prefix += cachedSource(RUNTIME_PATH);
  prefix += harnessSource("assert.js");
  prefix += harnessSource("sta.js");
  // (#3427) Our TS front-end rejects the upstream harness's duplicate top-level
  // helper declarations (e.g. `isPrimitive` in both testTypedArray.js + assert.js)
  // that a JS engine tolerates last-wins. Rename all-but-last in place (line-count
  // preserving) so bodyLineOffset below stays exact.
  prefix = dedupeTopLevelFunctionDeclarations(prefix);
  return {
    source: prefix + source,
    bodyLineOffset: lineCount(prefix),
    strict,
  };
}

/**
 * Assemble exactly the source variants executed by test262.fyi's original
 * harness reader. The raw test body is never rewritten.
 */
export function assembleOriginalHarness(source: string, meta: HarnessMeta): OriginalHarnessAssembly {
  const flags = new Set(meta.flags ?? []);
  const raw = flags.has("raw");
  const async = flags.has("async");
  const onlyStrict = flags.has("onlyStrict");
  const strictRerun = !raw && !flags.has("module") && !onlyStrict && !flags.has("noStrict");

  return {
    primary: assembleVariant(source, meta, onlyStrict, raw, async),
    ...(strictRerun ? { strictRerun: assembleVariant(source, meta, true, raw, async) } : {}),
    async,
    raw,
  };
}
