// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Allowlist of host imports tolerated under `--no-host-imports` / strict WASI
 * mode (#1524).
 *
 * Strict mode is the gate that enforces the **dual-mode** architectural
 * principle documented in `CLAUDE.md`: every user-facing feature should have
 * a Wasm-native path that does NOT depend on a JS runtime. JS-host imports
 * are an opt-in fast path when a host is available, not the default.
 *
 * Each entry on the allowlist is a host import that codegen still emits
 * during the dual-mode migration. The entry MUST name the tracking issue
 * that owns the Wasm-native replacement — once that work lands, the entry is
 * removed and strict-mode builds reject the import entirely.
 *
 * The CI gate forbids adding entries to this list without explicit sign-off:
 * a marker in the PR description (`[allowlist-grow]`) or a CODEOWNERS review
 * on this file is required. The accompanying budget test
 * (`tests/host-import-allowlist-budget.test.ts`) fails if the list grows
 * beyond `HOST_IMPORT_ALLOWLIST_BASELINE_SIZE`.
 *
 * Modules besides `env`:
 * - `wasi_snapshot_preview1` — always allowed; this is the canonical
 *   WASI ABI, not a JS-host import.
 * - `wasm:js-string` — host string builtins from the proposed `wasm:js-string`
 *   import-namespace standard. Permitted only when the runtime is known to
 *   provide them (i.e. NOT in WASI / nativeStrings mode — strict mode flips
 *   nativeStrings ON automatically, so these should never be requested).
 * - `string_constants` — `wasm:js-string` constant pool; same constraint.
 *
 * Anything in the `env` module is, by definition, a JS-host import. The
 * allowlist below enumerates which ones we still tolerate during the
 * transition. Use `kind === "prefix"` for parameterised import names (e.g.
 * `Math_sin`, `console_log_number`, extern-class methods).
 */

/** Modules other than `env` whose imports are not JS-host bindings and are always allowed. */
export const ALWAYS_ALLOWED_IMPORT_MODULES: ReadonlySet<string> = new Set(["wasi_snapshot_preview1"]);

export interface HostImportAllowlistEntry {
  /** Match kind. `exact` matches the import name literally; `prefix` matches a name beginning with the pattern. */
  kind: "exact" | "prefix";
  /** Import name (exact) or prefix (when kind === "prefix"). */
  name: string;
  /** Wasm signature description for documentation (e.g. "(externref) -> i32"). Optional. */
  signature?: string;
  /** Tracking issue that owns the Wasm-native replacement. 0 = no specific issue yet. */
  trackingIssue: number;
  /** One-line rationale for keeping this host import during the transition. */
  reason: string;
}

/**
 * Baseline host-import allowlist for `env` module imports under strict mode.
 *
 * Grouped by the tracking issue that will retire them. Order is informational
 * — `HOST_IMPORT_ALLOWLIST_BASELINE_SIZE` below is the budget the CI gate
 * compares against.
 */
export const HOST_IMPORT_ALLOWLIST: readonly HostImportAllowlistEntry[] = [
  // ---- #1105 String method host imports (retired by Wasm-native String ops) ----
  {
    kind: "prefix",
    name: "string_",
    trackingIssue: 1105,
    reason:
      "JS-host String.prototype methods (split, replace, match, includes, indexOf, ...) — Wasm-native fallbacks land with #1105.",
  },
  {
    kind: "exact",
    name: "String_fromCharCode",
    signature: "(f64) -> externref",
    trackingIssue: 1105,
    reason: "String.fromCharCode host fallback; native path in #1105.",
  },
  {
    kind: "exact",
    name: "String_fromCodePoint",
    signature: "(f64) -> externref",
    trackingIssue: 1105,
    reason: "String.fromCodePoint host fallback; native path in #1105.",
  },
  {
    kind: "exact",
    name: "string_compare",
    signature: "(externref, externref) -> i32",
    trackingIssue: 1105,
    reason: "Lexicographic string compare; native path in #1105.",
  },

  // ---- #1335 Number formatting (retired by pure-Wasm number→string) ----
  {
    kind: "exact",
    name: "number_toString",
    signature: "(f64) -> externref",
    trackingIssue: 1335,
    reason: "Number#toString; native path in #1335.",
  },
  {
    kind: "exact",
    name: "number_toString_radix",
    signature: "(f64, i32) -> externref",
    trackingIssue: 1335,
    reason: "Number#toString(radix); native path in #1335.",
  },
  {
    kind: "exact",
    name: "bigint_toString",
    signature: "(i64) -> externref",
    trackingIssue: 1644,
    reason: "BigInt#toString default radix 10 (Slice D).",
  },
  {
    kind: "exact",
    name: "bigint_toString_radix",
    signature: "(i64, i32) -> externref",
    trackingIssue: 1644,
    reason: "BigInt#toString(radix) base 2-36 (Slice D).",
  },
  {
    kind: "exact",
    name: "number_toFixed",
    signature: "(f64, i32) -> externref",
    trackingIssue: 1335,
    reason: "Number#toFixed; native path in #1335.",
  },
  {
    kind: "exact",
    name: "number_toPrecision",
    signature: "(f64, i32) -> externref",
    trackingIssue: 1335,
    reason: "Number#toPrecision; native path in #1335.",
  },
  {
    kind: "exact",
    name: "number_toExponential",
    signature: "(f64, i32) -> externref",
    trackingIssue: 1335,
    reason: "Number#toExponential; native path in #1335.",
  },

  // ---- #1471 String/number parsers (retired by Wasm-native parser table) ----
  {
    kind: "exact",
    name: "parseInt",
    signature: "(externref, f64) -> f64",
    trackingIssue: 1471,
    reason: "parseInt host fallback; native path in #1471.",
  },
  {
    kind: "exact",
    name: "parseFloat",
    signature: "(externref) -> f64",
    trackingIssue: 1471,
    reason: "parseFloat host fallback; native path in #1471.",
  },

  // ---- #1103 Collection constructors (retired by Wasm-native Map/Set/WeakMap) ----
  // These are emitted via `${info.importPrefix}_new`, `_get`, `_set`, etc. for
  // declared extern-class entries. We allow the well-known builtin collection
  // names as exact entries; user-declared extern classes are NOT auto-allowed.
  {
    kind: "prefix",
    name: "Map_",
    trackingIssue: 1103,
    reason: "Map constructor + methods; native path in #1103.",
  },
  {
    kind: "prefix",
    name: "Set_",
    trackingIssue: 1103,
    reason: "Set constructor + methods; native path in #1103.",
  },
  {
    kind: "prefix",
    name: "WeakMap_",
    trackingIssue: 1103,
    reason: "WeakMap constructor + methods; native path in #1103.",
  },
  {
    kind: "prefix",
    name: "WeakSet_",
    trackingIssue: 1103,
    reason: "WeakSet constructor + methods; native path in #1103.",
  },

  // ---- #1474 RegExp engine (retired by Wasm-native regex) ----
  {
    kind: "prefix",
    name: "RegExp_",
    trackingIssue: 1474,
    reason: "RegExp constructor + prototype methods; native path in #1474.",
  },

  // ---- #1470 Boxing helpers (retired when type-coercion drops externref roundtrip) ----
  {
    kind: "prefix",
    name: "__box_",
    trackingIssue: 1470,
    reason: "Boxing helpers for f64/i32/bool → externref; native path in #1470.",
  },
  {
    kind: "prefix",
    name: "__unbox_",
    trackingIssue: 1470,
    reason: "Unboxing helpers for externref → f64/i32/bool; native path in #1470.",
  },
  {
    kind: "prefix",
    name: "__typeof",
    trackingIssue: 1470,
    reason: "typeof / __typeof_<kind> guards on externref; native path in #1470.",
  },
  {
    kind: "exact",
    name: "__is_truthy",
    trackingIssue: 1470,
    reason: "Truthiness check on externref; native path in #1470.",
  },

  // ---- #1472 Object / extern access helpers (retired by Wasm-native object ops) ----
  {
    kind: "prefix",
    name: "__extern_",
    trackingIssue: 1472,
    reason: "Generic externref property get/set/length/slice/rest; native path in #1472.",
  },
  {
    kind: "prefix",
    name: "__for_in_",
    trackingIssue: 1472,
    reason: "for-in key enumeration on externref objects; native path in #1472.",
  },
  {
    kind: "prefix",
    name: "__iterator",
    trackingIssue: 1472,
    reason: "Iterator protocol on externref values; native path in #1472.",
  },
  {
    kind: "prefix",
    name: "__array_",
    trackingIssue: 1472,
    reason: "Array iteration helpers (entries/keys/values) on externref arrays; native path in #1472.",
  },
  {
    kind: "exact",
    name: "__async_iterator",
    trackingIssue: 1472,
    reason: "Async iterator protocol on externref; native path in #1472.",
  },
  {
    kind: "exact",
    name: "__get_globalThis",
    trackingIssue: 1472,
    reason: "globalThis lookup via host; native path in #1472.",
  },
  {
    kind: "prefix",
    name: "__register_",
    trackingIssue: 1472,
    reason: "Prototype / class-object host-side registry; retires with #1472 object-ops.",
  },

  // ---- #1473 Error / exception helpers ----
  {
    kind: "exact",
    name: "__get_caught_exception",
    trackingIssue: 1473,
    reason: "Catch-clause exception read; native path in #1473.",
  },

  // ---- #1470 Callback bridge (retired with closure work) ----
  {
    kind: "prefix",
    name: "__make_",
    trackingIssue: 1470,
    reason: "Callback / getter-callback factory for closures crossing the host boundary; #1470.",
  },
  {
    kind: "prefix",
    name: "__call_",
    trackingIssue: 1470,
    reason: "Host trampolines for invoking JS callbacks (__call_1_i32, __call_2_f64, ...); #1470.",
  },

  // ---- #1376 Generator helpers (retired as part of IR fallback budget) ----
  {
    kind: "prefix",
    name: "__gen_",
    trackingIssue: 1376,
    reason: "Generator scheduler primitives implemented JS-side; native path tracked in #1376.",
  },
  {
    kind: "prefix",
    name: "__create_generator",
    trackingIssue: 1376,
    reason: "Sync generator constructor host-side; #1376.",
  },
  {
    kind: "prefix",
    name: "__create_async_generator",
    trackingIssue: 1376,
    reason: "Async generator constructor host-side; #1376.",
  },

  // ---- #1632a Function.prototype.bind / .apply / .call (host-delegated) ----
  {
    kind: "exact",
    name: "__bind_function",
    signature: "(externref, externref, externref, externref, i32) -> externref",
    trackingIssue: 1632,
    reason:
      "Function.prototype.bind delegates to host Function.prototype.bind for spec-correct bound-function exotic. Standalone mode falls back to identity-bind (documented gap).",
  },

  // ---- Async / Promise / JSON / dynamic-import (no native path yet) ----
  {
    kind: "exact",
    name: "Promise_new",
    trackingIssue: 1470,
    reason: "Promise constructor host-side; #1470.",
  },
  {
    kind: "exact",
    name: "JSON_stringify",
    trackingIssue: 1470,
    reason: "JSON.stringify host fallback; #1470.",
  },
  {
    kind: "exact",
    name: "JSON_parse",
    trackingIssue: 1470,
    reason: "JSON.parse host fallback; #1470.",
  },
  {
    kind: "exact",
    name: "__dynamic_import",
    trackingIssue: 1472,
    reason:
      "Dynamic `import()` is wont-fix in standalone mode (see test262 skip filters in CLAUDE.md). Kept on the allowlist for build-tool flows.",
  },
  {
    kind: "exact",
    name: "__extern_eval",
    trackingIssue: 1472,
    reason:
      "`eval` is wont-fix in standalone mode. Kept on the allowlist; future work flips to a compile error under strict mode.",
  },

  // ---- Math methods that don't yet have inline implementations ----
  // emitInlineMathFunctions covers most of Math.* with pure Wasm; remaining
  // methods (e.g. Math.atan2) fall back to a host import named `Math_<name>`.
  {
    kind: "prefix",
    name: "Math_",
    trackingIssue: 1474,
    reason:
      "Math methods without inline Wasm implementations (Math.atan2, Math.cbrt, ...). Most Math.* is already inline (see emitInlineMathFunctions in src/codegen/index.ts). Remaining methods migrate with #1474.",
  },

  // ---- Console (WASI mode uses fd_write directly; this entry exists for non-WASI strict-mode debugging) ----
  {
    kind: "prefix",
    name: "console_",
    trackingIssue: 0,
    reason:
      "console.* host imports. Under `--target wasi` these are replaced with fd_write at registration time; they should never appear in WASI strict builds. Allowed for non-WASI `--no-host-imports` debugging only.",
  },
];

/**
 * Baseline size — the number of entries above. The CI budget gate fails if
 * `HOST_IMPORT_ALLOWLIST.length` grows beyond this without explicit sign-off
 * (PR description marker `[allowlist-grow]` or CODEOWNERS review on this file).
 *
 * Update this number ONLY in commits that intentionally widen the allowlist;
 * removal of entries is encouraged and does NOT require updating this number
 * (the budget gate is a one-way ratchet on growth).
 */
export const HOST_IMPORT_ALLOWLIST_BASELINE_SIZE = HOST_IMPORT_ALLOWLIST.length;

/**
 * Returns the matching allowlist entry for `name` in the `env` module, or
 * `undefined` if no entry matches. Used by `addImport` (#1524) to decide
 * whether a host import is tolerated under strict mode.
 */
export function lookupAllowlistEntry(name: string): HostImportAllowlistEntry | undefined {
  for (const entry of HOST_IMPORT_ALLOWLIST) {
    if (entry.kind === "exact") {
      if (entry.name === name) return entry;
    } else {
      if (name.startsWith(entry.name)) return entry;
    }
  }
  return undefined;
}

/**
 * Decide whether an import to `module.name` is allowed under strict
 * `--no-host-imports` mode.
 *
 * Non-`env` modules are subject to the always-allowed list; only
 * `wasi_snapshot_preview1` is currently on it. (`wasm:js-string` and
 * `string_constants` are JS-host imports too, but they are gated by
 * `nativeStrings` mode which strict mode auto-enables; they should not
 * appear when strict mode is on.)
 */
export function isHostImportAllowed(
  module: string,
  name: string,
):
  | { allowed: true }
  | { allowed: false; reason: "non-env-host-module" }
  | {
      allowed: false;
      reason: "env-not-on-allowlist";
    } {
  if (module === "env") {
    const entry = lookupAllowlistEntry(name);
    if (entry) return { allowed: true };
    return { allowed: false, reason: "env-not-on-allowlist" };
  }
  if (ALWAYS_ALLOWED_IMPORT_MODULES.has(module)) {
    return { allowed: true };
  }
  // Any other module (wasm:js-string, string_constants, ...) is host-only.
  return { allowed: false, reason: "non-env-host-module" };
}

/**
 * Build the user-facing error message thrown when strict mode rejects a host
 * import. Includes the tracking issue when one is known.
 */
export function buildStrictHostImportError(module: string, name: string): string {
  const decision = isHostImportAllowed(module, name);
  if (decision.allowed) {
    throw new Error(
      `buildStrictHostImportError called for an allowed import (${module}.${name}); this is a programming error.`,
    );
  }
  if (decision.reason === "non-env-host-module") {
    return (
      `Host import "${module}.${name}" requested under --no-host-imports / WASI strict mode. ` +
      `The "${module}" namespace is a JS-host binding and is not available in standalone mode. ` +
      `If this is a string-table import, ensure nativeStrings mode is enabled (it auto-enables under strict mode).`
    );
  }
  return (
    `Host import "${module}.${name}" requested under --no-host-imports / WASI strict mode, ` +
    `but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.ts). ` +
    `Either add a Wasm-native fallback for this feature or, if you need a transitional host import, ` +
    `add an entry to HOST_IMPORT_ALLOWLIST citing the tracking issue and include "[allowlist-grow]" in your PR description.`
  );
}
