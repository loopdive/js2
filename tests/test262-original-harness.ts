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

/**
 * (#3461) Split assembly for the FAST native-harness oracle (host lane only).
 * Unlike {@link OriginalHarnessVariant} — which concatenates `prefix + body`
 * into one `.source` compiled whole — the fast lane runs the harness prefix
 * NATIVELY (once, strict-neutral) in the per-test sandbox and compiles ONLY
 * `bindingShim + body` to wasm. `bodyLineOffset` = `lineCount(bindingShim)` so
 * the worker's body error-line mapping stays exact.
 */
export interface NativeHarnessVariant {
  /** Runtime shim + includes + assert.js + sta.js [+ doneprintHandle]; NO
   *  `"use strict"` directive — the prefix is executed natively and is
   *  strict-neutral, so it is run exactly once for both variants. */
  harnessPrefix: string;
  /** `[ "use strict";\n ] var assert = globalThis.assert; …` — binds ONLY the
   *  harness symbols the body references (see {@link buildBindingShim}). Carries
   *  the strict directive for the strict variant so it is the first statement of
   *  the compiled body unit. */
  bindingShim: string;
  /** Untouched upstream test body. */
  body: string;
  /** Lines in `bindingShim` (the body starts after it in the compiled unit). */
  bodyLineOffset: number;
  strict: boolean;
}

export interface NativeHarnessAssembly {
  primary: NativeHarnessVariant;
  strictRerun?: NativeHarnessVariant;
  async: boolean;
  raw: boolean;
}

/**
 * One literal source file contributing to the Test262 harness prefix. Keeping
 * the ordered parts visible lets the linked-harness inventory derive stable
 * content keys and attribute duplicate declarations without reimplementing the
 * authoritative assembly order.
 */
export interface HarnessSourcePart {
  name: string;
  source: string;
}

/**
 * (#3451) One body-only compilation unit for the future static-link path.
 * `bodySource` deliberately contains no host binding shim: unresolved harness
 * names must eventually become linker symbols, not `globalThis` host accesses.
 */
export interface LinkedHarnessVariant {
  /** Strict directive (when needed) followed by the untouched test body. */
  bodySource: string;
  /** Untouched upstream test body. */
  body: string;
  /** Lines prepended to `body` inside `bodySource`. */
  bodyLineOffset: number;
  strict: boolean;
}

/**
 * (#3451) Deterministic split used by the inventory and, after the linker grows
 * the required shared-realm substrate, by the linked Test262 runner.
 */
export interface LinkedHarnessAssembly {
  /** Strict-neutral, de-duplicated literal harness source compiled once. */
  harnessPrefix: string;
  /** Ordered, pre-dedupe inputs used to build `harnessPrefix`. */
  harnessParts: HarnessSourcePart[];
  primary: LinkedHarnessVariant;
  strictRerun?: LinkedHarnessVariant;
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

/**
 * The harness include-concatenation shared by the honest and fast paths, in the
 * order test262.fyi/data/runner/read.js uses: async helper, metadata includes,
 * runtime shim, assert.js, sta.js. Excludes the `"use strict"` directive and the
 * duplicate-declaration dedupe — callers add those (the directive is variant-
 * specific; the honest path dedupes the directive+includes together, which is
 * byte-identical to deduping includes alone since the directive line contains no
 * function declaration).
 */
export function harnessSourceParts(meta: HarnessMeta, async: boolean): HarnessSourcePart[] {
  const parts: HarnessSourcePart[] = [];
  if (async) parts.push({ name: "doneprintHandle.js", source: harnessSource("doneprintHandle.js") });
  for (const include of meta.includes ?? []) {
    parts.push({ name: include, source: harnessSource(include) });
  }
  parts.push({ name: "__js2wasm_test262_runtime__.js", source: cachedSource(RUNTIME_PATH) });
  parts.push({ name: "assert.js", source: harnessSource("assert.js") });
  parts.push({ name: "sta.js", source: harnessSource("sta.js") });
  return parts;
}

function assemblePrefixIncludes(meta: HarnessMeta, async: boolean): string {
  return harnessSourceParts(meta, async)
    .map((part) => part.source)
    .join("");
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
  // (#3427) Our TS front-end rejects the upstream harness's duplicate top-level
  // helper declarations (e.g. `isPrimitive` in both testTypedArray.js + assert.js)
  // that a JS engine tolerates last-wins. Rename all-but-last in place (line-count
  // preserving) so bodyLineOffset below stays exact.
  const prefix = dedupeTopLevelFunctionDeclarations(
    (strict ? '"use strict";\n' : "") + assemblePrefixIncludes(meta, async),
  );
  return {
    source: prefix + source,
    bodyLineOffset: lineCount(prefix),
    strict,
  };
}

/**
 * (#3461) Harness symbols eligible for the native-harness binding shim. In a
 * body-only compile a MEMBER access on an undeclared global — `assert.sameValue`,
 * `verifyProperty(...)`, `Array.prototype.slice` — lowers to
 * `__throw_reference_error(<root>)` because a member-get on an undeclared global
 * does NOT consult the `globalSandbox` bridge (only a BARE reference does). The
 * shim binds `var <name> = globalThis.<name>;` for each referenced root so the
 * member access resolves through the sandbox host object.
 *
 * The set is the worker's `ORIGINAL_HARNESS_SANDBOX_GLOBALS` (built-ins the
 * sandbox re-exposes) ∪ the harness API surface (assert.js / sta.js / include
 * helpers). Binding the built-ins is DELIBERATE: it routes the body's built-in
 * member access through the sandbox's host copy — the spike-proven V8-delegation
 * (`Array.prototype.slice.length` read from the host) that the fast lane bakes
 * into its OWN baseline. `undefined`/`NaN`/`Infinity` are omitted: they are
 * value-only sandbox props (a `var undefined = …` rebind is a strict-mode
 * SyntaxError) already handled by `buildOriginalHarnessSandbox`.
 */
const NATIVE_HARNESS_BINDABLE_GLOBALS: readonly string[] = [
  // Built-in globals re-exposed by the sandbox (mirror of the worker's
  // ORIGINAL_HARNESS_SANDBOX_GLOBALS, minus the value-only NaN/Infinity/undefined).
  "Array",
  "Object",
  "Function",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "Math",
  "JSON",
  "Reflect",
  // Harness API surface (assert.js / sta.js / include helpers).
  "assert",
  "Test262Error",
  "verifyProperty",
  "verifyEqualTo",
  "verifyWritable",
  "verifyNotWritable",
  "verifyEnumerable",
  "verifyNotEnumerable",
  "verifyConfigurable",
  "verifyNotConfigurable",
  "compareArray",
  "arrayContains",
  "isConstructor",
  "testWithTypedArrayConstructors",
  "assertRelativeDateMs",
  "dataPropertyAttributesAreCorrect",
  "isSameValue",
  "isWritable",
  "$DONE",
  "$ERROR",
  "asyncTest",
  "byteConversionValues",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * (#3461) Emit `var <name> = globalThis.<name>;` for each bindable harness symbol
 * whose identifier token appears in `body`. Matches identifier tokens only —
 * boundaries reject `[\w$]` neighbours so `$DONE`/`$ERROR` and substrings
 * (`assertFoo`) are handled correctly. A false positive (a name that appears only
 * inside a string/comment) yields a harmless extra `var`; the only real failure
 * mode is a wrongly-OMITTED binding, so matching liberally is the safe bias.
 */
export function buildBindingShim(body: string): string {
  let shim = "";
  for (const name of NATIVE_HARNESS_BINDABLE_GLOBALS) {
    const token = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
    if (token.test(body)) shim += `var ${name} = globalThis.${name};\n`;
  }
  return shim;
}

function assembleNativeVariant(
  source: string,
  meta: HarnessMeta,
  strict: boolean,
  raw: boolean,
  async: boolean,
): NativeHarnessVariant {
  // Raw tests carry no harness — nothing to run natively, nothing to bind. The
  // strict directive (if any) still leads the compiled body unit.
  const harnessPrefix = raw ? "" : dedupeTopLevelFunctionDeclarations(assemblePrefixIncludes(meta, async));
  const binds = raw ? "" : buildBindingShim(source);
  const bindingShim = (strict ? '"use strict";\n' : "") + binds;
  return {
    harnessPrefix,
    bindingShim,
    body: source,
    bodyLineOffset: lineCount(bindingShim),
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

/**
 * (#3461) Assemble the SAME strata as {@link assembleOriginalHarness} but SPLIT
 * for the fast native-harness oracle: the harness prefix (to run natively, once)
 * is kept separate from the `bindingShim + body` compile unit. The primary /
 * optional strictRerun variant split mirrors {@link assembleOriginalHarness}
 * exactly (same `raw`/`async`/`onlyStrict`/`module`/`noStrict` gating), so the
 * fast lane keeps the honest lane's 1.7× body-compile multiplier — only the
 * harness bytes are lifted out of each compile.
 */
export function assembleNativeHarness(source: string, meta: HarnessMeta): NativeHarnessAssembly {
  const flags = new Set(meta.flags ?? []);
  const raw = flags.has("raw");
  const async = flags.has("async");
  const onlyStrict = flags.has("onlyStrict");
  const strictRerun = !raw && !flags.has("module") && !onlyStrict && !flags.has("noStrict");

  return {
    primary: assembleNativeVariant(source, meta, onlyStrict, raw, async),
    ...(strictRerun ? { strictRerun: assembleNativeVariant(source, meta, true, raw, async) } : {}),
    async,
    raw,
  };
}

function assembleLinkedVariant(source: string, strict: boolean): LinkedHarnessVariant {
  const directive = strict ? '"use strict";\n' : "";
  return {
    bodySource: directive + source,
    body: source,
    bodyLineOffset: lineCount(directive),
    strict,
  };
}

/**
 * (#3451) Split the authoritative Test262 assembly at the future static-link
 * boundary while preserving its variant rules exactly.
 *
 * The harness object is strict-neutral: strictness belongs to the beginning of
 * the body compilation unit, so primary and strict-rerun variants reuse the
 * same immutable harness object. Raw tests have no harness and bypass linking.
 */
export function assembleLinkedHarness(source: string, meta: HarnessMeta): LinkedHarnessAssembly {
  const flags = new Set(meta.flags ?? []);
  const raw = flags.has("raw");
  const async = flags.has("async");
  const onlyStrict = flags.has("onlyStrict");
  const strictRerun = !raw && !flags.has("module") && !onlyStrict && !flags.has("noStrict");
  const harnessParts = raw ? [] : harnessSourceParts(meta, async);
  const harnessPrefix = raw ? "" : dedupeTopLevelFunctionDeclarations(harnessParts.map((part) => part.source).join(""));

  return {
    harnessPrefix,
    harnessParts,
    primary: assembleLinkedVariant(source, onlyStrict),
    ...(strictRerun ? { strictRerun: assembleLinkedVariant(source, true) } : {}),
    async,
    raw,
  };
}
