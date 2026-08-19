// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4542 — the ownership table for the PINNED artifact's shim.
//
// The issue asks for the pass to be "driven by the ABI table from #4539 rather
// than by a hand-maintained list". This is that table for the one ABI that
// exists today: `scripts/quickjs-artifact/qjs_shim.c`. It is checked against
// that C source by {@link checkShimOwnershipDrift}, so it cannot silently rot
// when a wrapper is added or a signature changes.
//
// ── The shim's contract, restated because it decides every row ──────────
//
// From the shim's own header (§2, "BORROW SEMANTICS, NOT MOVE SEMANTICS"):
//
//     every handle a wrapper RETURNS must be released exactly once with
//     qjs_free_value(); handles you PASS IN are never consumed.
//
// So every row is `args: "borrows"` and every handle result is `"owned"`.
// There is no `consumes` row. That is not a simplification on our side — the
// shim exists to remove per-callsite refcount knowledge, and #4236's spike is
// the record of what happens without it (its R3 probe only worked because a
// `DupValue` was hand-inserted).
//
// ── Two facts about this ABI that are easy to get backwards ─────────────
//
// 1. NOTHING HERE UNWINDS (`throws: false` on every row). A QuickJS error comes
//    back as a `JS_EXCEPTION` sentinel HANDLE, not as a trap — which is why the
//    shim's error-returning wrappers still return a handle you must free. The
//    unwind edge is raised by OUR generated code, after it checks
//    `qjs_is_exception`. Exceptional-path coverage therefore still happens, and
//    still happens where it should: the pass opens a cleanup region because of
//    the explicit `throw` the exception check emits, and the sentinel handle
//    itself is released by that region like any other acquisition.
//
// 2. A HANDLE PASSED THROUGH MEMORY IS INVISIBLE TO THE PASS. `qjs_call` takes
//    `const qjs_handle *argv` — an array in linear memory, not a parameter.
//    The pass cannot see those handles and does not try to; under this ABI it
//    does not need to, because the callee borrows them and the caller's own
//    scope keeps every one of them alive across the call. If a future wrapper
//    ever CONSUMED a handle reached through memory, this table could not
//    express it and the pass would be wrong — so that wrapper must not be
//    added without extending the annotation first.
//
// ── `releasesContainerSlots` ────────────────────────────────────────────
//
// `true` wherever the wrapper can run arbitrary JS — a getter, a `valueOf`, a
// `toString`, an eval, a call. That includes `qjs_to_f64` and `qjs_to_cstring`,
// which are easy to read as pure conversions and are not. Only the elision
// follow-up consumes this axis; a `true` there is always the safe answer.

import type { ExternCImportSpec, ExternCValType } from "../c-abi.js";
import type { ImportOwnership } from "./ownership.js";

const CTX: ExternCValType = { address: "ptr" };
const PTR: ExternCValType = { address: "ptr" };
const SIZE: ExternCValType = { address: "size" };
const HANDLE: ExternCValType = { address: "handle" };
const I32: ExternCValType = { kind: "i32" };
const I64: ExternCValType = { kind: "i64" };
const F64: ExternCValType = { kind: "f64" };

/** Every wrapper borrows its handle arguments; a handle result is owned. */
const OWNED: ImportOwnership = {
  args: "borrows",
  result: "owned",
  throws: false,
  releasesContainerSlots: false,
};
const OWNED_REENTRANT: ImportOwnership = {
  args: "borrows",
  result: "owned",
  throws: false,
  releasesContainerSlots: true,
};
const PURE: ImportOwnership = {
  args: "borrows",
  result: "none",
  throws: false,
  releasesContainerSlots: false,
};
const REENTRANT: ImportOwnership = {
  args: "borrows",
  result: "none",
  throws: false,
  releasesContainerSlots: true,
};

/**
 * The shim's destructor and retain primitives. The pass calls these DIRECTLY
 * (they are the `free` and `dup` it emits), so they are deliberately not
 * ordinary rows in the callee table — routing a `free` through the same
 * machinery that decides where to put frees would be circular.
 */
export const SHIM_REFCOUNT_PRIMITIVES = ["qjs_free_value", "qjs_dup"] as const;

/** Wrappers that carry no JSValue at all; no annotation is required or given. */
const HANDLE_FREE_EXPORTS: ExternCImportSpec[] = [
  { module: "", name: "qjs_new_runtime", params: [], results: [PTR] },
  { module: "", name: "qjs_free_runtime", params: [PTR], results: [] },
  { module: "", name: "qjs_new_context", params: [PTR], results: [PTR] },
  { module: "", name: "qjs_free_context", params: [CTX], results: [] },
  { module: "", name: "qjs_malloc_raw", params: [SIZE], results: [PTR] },
  { module: "", name: "qjs_free_raw", params: [PTR], results: [] },
  {
    module: "",
    name: "qjs_set_membrane_callbacks",
    params: [I32, I32, I32, I32, I32],
    results: [],
  },
  { module: "", name: "qjs_noop", params: [], results: [I32] },
  // #4557 — the peer allocator. `qjs_set_allocator` takes five
  // `__indirect_function_table` slot indices, positionally, in the order
  // malloc / calloc / free / realloc / usable_size; the rest report on the
  // installation. None of them touches a JSValue, so none carries ownership.
  {
    module: "",
    name: "qjs_set_allocator",
    params: [I32, I32, I32, I32, I32],
    results: [I32],
  },
  { module: "", name: "qjs_new_runtime2", params: [], results: [PTR] },
  { module: "", name: "qjs_libc_alloc_count", params: [], results: [I32] },
  // f64 because QuickJS's accounting is int64 and an i64 crossing this boundary
  // would be a BigInt at any JS edge; these are diagnostics, so the double's
  // 53-bit exact range is ample.
  { module: "", name: "qjs_malloc_size", params: [PTR], results: [F64] },
  { module: "", name: "qjs_malloc_count", params: [PTR], results: [F64] },
];

const HANDLE_EXPORTS: ExternCImportSpec[] = [
  {
    module: "",
    name: "qjs_handle_raw",
    params: [HANDLE],
    results: [I64],
    ownership: PURE,
  },
  {
    module: "",
    name: "qjs_tag",
    params: [HANDLE],
    results: [I32],
    ownership: PURE,
  },
  {
    module: "",
    name: "qjs_is_exception",
    params: [HANDLE],
    results: [I32],
    ownership: PURE,
  },
  // Runs `valueOf` — not the pure conversion its name suggests.
  {
    module: "",
    name: "qjs_to_f64",
    params: [CTX, HANDLE],
    results: [F64],
    ownership: REENTRANT,
  },
  {
    module: "",
    name: "qjs_new_f64",
    params: [CTX, F64],
    results: [HANDLE],
    ownership: OWNED,
  },
  {
    module: "",
    name: "qjs_new_undefined",
    params: [],
    results: [HANDLE],
    ownership: OWNED,
  },
  {
    module: "",
    name: "qjs_new_string_len",
    params: [CTX, PTR, SIZE],
    results: [HANDLE],
    ownership: OWNED,
  },
  {
    module: "",
    name: "qjs_new_null",
    params: [],
    results: [HANDLE],
    ownership: OWNED,
  },
  {
    module: "",
    name: "qjs_new_bool",
    params: [CTX, I32],
    results: [HANDLE],
    ownership: OWNED,
  },
  {
    module: "",
    name: "qjs_is_function",
    params: [CTX, HANDLE],
    results: [I32],
    ownership: PURE,
  },
  {
    module: "",
    name: "qjs_new_object",
    params: [CTX],
    results: [HANDLE],
    ownership: OWNED,
  },
  {
    module: "",
    name: "qjs_global_object",
    params: [CTX],
    results: [HANDLE],
    ownership: OWNED,
  },
  // A getter can run arbitrary JS, so this can drop a container slot.
  {
    module: "",
    name: "qjs_get_prop_str",
    params: [CTX, HANDLE, PTR],
    results: [HANDLE],
    ownership: OWNED_REENTRANT,
  },
  // NOTE: the raw `JS_SetPropertyStr` CONSUMES its value; the shim wrapper does
  // not. That difference is the whole point of the shim, and getting it
  // backwards here would double-free every stored value.
  {
    module: "",
    name: "qjs_set_prop_str",
    params: [CTX, HANDLE, PTR, HANDLE],
    results: [I32],
    ownership: REENTRANT,
  },
  {
    module: "",
    name: "qjs_is_equal",
    params: [CTX, HANDLE, HANDLE, I32],
    results: [I32],
    ownership: REENTRANT,
  },
  {
    module: "",
    name: "qjs_eval",
    params: [CTX, PTR, SIZE],
    results: [HANDLE],
    ownership: OWNED_REENTRANT,
  },
  // `argv` is a POINTER to a handle array — see note 2 in the header.
  {
    module: "",
    name: "qjs_call",
    params: [CTX, HANDLE, HANDLE, SIZE, PTR],
    results: [HANDLE],
    ownership: OWNED_REENTRANT,
  },
  {
    module: "",
    name: "qjs_take_exception",
    params: [CTX],
    results: [HANDLE],
    ownership: OWNED,
  },
  {
    module: "",
    name: "qjs_to_cstring",
    params: [CTX, HANDLE],
    results: [PTR],
    ownership: REENTRANT,
  },
  {
    module: "",
    name: "qjs_to_cstring_len",
    params: [CTX, HANDLE, PTR],
    results: [PTR],
    ownership: REENTRANT,
  },
  {
    module: "",
    name: "qjs_new_wrapper",
    params: [CTX, I32, I32],
    results: [HANDLE],
    ownership: OWNED,
  },
  {
    module: "",
    name: "qjs_wrapper_gc_handle",
    params: [HANDLE],
    results: [I32],
    ownership: PURE,
  },
];

/**
 * The pinned shim's imports, bound to a Wasm import module name.
 *
 * `module` is a parameter because the peer-module link topology (#4539) names
 * the namespace; the ownership facts do not depend on it.
 */
export function pinnedShimImports(module = "qjs"): ExternCImportSpec[] {
  return [
    ...HANDLE_FREE_EXPORTS.map((spec) => ({ ...spec, module })),
    // `engine: true` is what makes a missing annotation a DECLARATION-time
    // refusal in `declareExternCImports`, rather than a surprise in lowering.
    ...HANDLE_EXPORTS.map((spec) => ({ ...spec, module, engine: true })),
  ];
}

// ── Drift check against the C source ────────────────────────────────────

export interface ShimDrift {
  export: string;
  problem: string;
}

interface ParsedExport {
  name: string;
  returnsHandle: boolean;
  handleParams: number;
  /** A handle reached through a pointer — invisible to the pass. */
  handleArrayParams: number;
}

/** Parse `QJS_EXPORT(...)` declarations out of the shim's C source. */
export function parseShimExports(source: string): ParsedExport[] {
  const out: ParsedExport[] = [];
  const re = /([A-Za-z_][A-Za-z0-9_ *]*?)\s*QJS_EXPORT\((\w+)\)\s*\(([^)]*)\)/g;
  let m = re.exec(source);
  while (m !== null) {
    const [, ret, name, rawParams] = m;
    if (!name.startsWith("qjs_abi_")) {
      const params = rawParams
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && p !== "void");
      out.push({
        name,
        returnsHandle: /\bqjs_handle\b/.test(ret) && !ret.includes("*"),
        handleParams: params.filter((p) => /\bqjs_handle\b/.test(p) && !p.includes("*")).length,
        handleArrayParams: params.filter((p) => /\bqjs_handle\b/.test(p) && p.includes("*")).length,
      });
    }
    m = re.exec(source);
  }
  return out;
}

/**
 * Compare the committed table against the shim's C source.
 *
 * An empty result means the table still describes the artifact. This is the
 * check that keeps the "hand-written summary" honest: the summary is
 * unavoidable (the callee is foreign code), but its SHAPE is mechanically
 * derivable, and a shape mismatch is exactly how a wrong annotation gets in.
 */
export function checkShimOwnershipDrift(source: string, module = "qjs"): ShimDrift[] {
  const drift: ShimDrift[] = [];
  const table = new Map(pinnedShimImports(module).map((s) => [s.name, s]));
  const primitives = new Set<string>(SHIM_REFCOUNT_PRIMITIVES);

  for (const parsed of parseShimExports(source)) {
    if (primitives.has(parsed.name)) continue;
    const spec = table.get(parsed.name);
    if (spec === undefined) {
      drift.push({
        export: parsed.name,
        problem:
          "exported by the shim but missing from the ownership table. Every wrapper the peer module can " +
          "call needs a row, or the pass will refuse the call at lowering time.",
      });
      continue;
    }
    const declaredHandleParams = spec.params.filter((p) => "address" in p && p.address === "handle").length;
    if (declaredHandleParams !== parsed.handleParams) {
      drift.push({
        export: parsed.name,
        problem: `declares ${declaredHandleParams} handle parameter(s); the C source has ${parsed.handleParams}.`,
      });
    }
    const declaredHandleResult = spec.results.some((r) => "address" in r && r.address === "handle");
    if (declaredHandleResult !== parsed.returnsHandle) {
      drift.push({
        export: parsed.name,
        problem: `declares ${declaredHandleResult ? "a" : "no"} handle result; the C source returns ${
          parsed.returnsHandle ? "one" : "none"
        }.`,
      });
    }
    const ownership = spec.ownership;
    if (ownership !== undefined && typeof ownership !== "string") {
      if (ownership.args !== "borrows") {
        drift.push({
          export: parsed.name,
          problem:
            "annotated as consuming a handle. The shim's contract is that handles passed IN are never " +
            "consumed; a `consumes` row here would insert a dup the callee never takes.",
        });
      }
      if (parsed.returnsHandle && ownership.result !== "owned") {
        drift.push({
          export: parsed.name,
          problem: `returns a handle but is annotated result '${ownership.result}'. The shim returns owned handles.`,
        });
      }
      if (ownership.throws !== false) {
        drift.push({
          export: parsed.name,
          problem:
            "annotated as throwing. Under this ABI a QuickJS error is a JS_EXCEPTION sentinel handle, not a " +
            "trap; the unwind edge belongs to our own exception check.",
        });
      }
    }
  }
  return drift;
}
