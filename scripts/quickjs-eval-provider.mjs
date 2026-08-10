// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4238 — the QuickJS eval ENGINE behind the frozen `js2wasm:runtime-eval` seam.
//
// Module graph (all wasm-to-wasm at runtime; JS appears only in the
// instantiation harness, exactly like the sanctioned WASI stub):
//
//   user module ──js2wasm:runtime-eval (4 imports, externref ABI — FROZEN)──▶
//     GC adapter (js2wasm-compiled TS)
//   GC adapter ──js2wasm:qjs (i32/f64 handle ABI) + imported memory──▶
//     libquickjs.wasm (WASI reactor)
//   libquickjs.wasm ──wasi_snapshot_preview1 (5 fns)──▶ WASI stub / runtime
//
// This module is imported LAZILY by scripts/runtime-eval-provider.mjs, and ONLY
// inside its `engine === "quickjs"` branch: with the flag unset nothing here is
// loaded, no quickjs cache path is stat'ed, and `build.sh` is never reached.
//
// SLICE 2 SCOPE (see plan/issues/4238-…): the full MVP value bridge in BOTH
// directions (number / string / boolean / null / undefined, QuickJS functions →
// the structurally canonical callable marker, other QuickJS objects → an opaque
// handle box, compiled GC objects crossing inward → a typed TypeError), real
// `__runtime_new_function` and `__runtime_apply_interpreted` (through the
// artifact's `qjs_call`), error mapping with the real `name`/`message`, and the
// globals push/pull mirror.
//
// SLICE 3 SCOPE: DIRECT eval. The caller's live binding cells (three name/cell
// layers plus the 64-slot activation state pool) are snapshotted onto a fresh
// plain QuickJS object `S`; a sloppy caller evaluates `with (S) { … }` so
// QuickJS runs the scope walk natively, a strict caller gets a block-scoped
// `const` preamble instead (`with` is illegal there). After the evaluation the
// changed PRIMITIVES are written straight back into the live cells, new sloppy
// `var`s are mirrored into the activation state pool with the interpreter's own
// vacancy discipline, and the global-lexical-cell carrier is mirrored the same
// way. The primitive-only filter on every write-back path is load-bearing — see
// the note above `qjsPullGlobals`.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The ONLY JavaScript permitted behind the seam (the artifact imports exactly
// five wasi_snapshot_preview1 functions and nothing else). Statically imported
// so `instantiateQuickjsEvalNamespace` stays SYNCHRONOUS — every existing
// caller of `instantiateRuntimeEvalNamespace` is synchronous, and this module
// must stay free of top-level `await` because it is loaded through
// `createRequire` (see the lazy load in runtime-eval-provider.mjs).
import { makeWasiStub } from "./quickjs-artifact/wasi-stub.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/** Where the QuickJS artifact's build recipe lives. */
export const QUICKJS_ARTIFACT_DIR = join(HERE, "quickjs-artifact");
export const QUICKJS_BUILD_SCRIPT = join(QUICKJS_ARTIFACT_DIR, "build.sh");
export const QUICKJS_SHIM_SOURCE = join(QUICKJS_ARTIFACT_DIR, "qjs_shim.c");

/**
 * Provider namespace for the ADAPTER→QuickJS edge. Deliberately NOT `env`: it
 * is satisfied by another wasm instance (see
 * `ALWAYS_ALLOWED_IMPORT_MODULES` in src/codegen/host-import-allowlist.ts), so
 * it is not a JS-host import and does not trip the #2961 leak scan.
 */
export const QUICKJS_IMPORT_MODULE = "js2wasm:qjs";

/**
 * Adapter compile options — the sibling of
 * `RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS`. `target: "standalone"` keeps the
 * adapter structurally canonical with the user modules it serves (same
 * rec-groups for the `[ok, value]` envelope vec and the callable carrier); the
 * three #4238 enablers are what let its `qjs_*` externs bind DIRECTLY to
 * `libquickjs.wasm`'s i32 exports with no JS wrapper closure in between.
 */
export const QUICKJS_ADAPTER_COMPILE_OPTIONS = Object.freeze({
  experimentalIR: false,
  fileName: "quickjs-eval-adapter.ts",
  skipSemanticDiagnostics: true,
  target: "standalone",
  externNativeTypes: true,
  externImportModule: QUICKJS_IMPORT_MODULE,
  importMemory: Object.freeze({ module: QUICKJS_IMPORT_MODULE, min: 256 }),
});

/** Every `qjs_*` export the adapter is allowed to import. */
export const QUICKJS_ADAPTER_EXTERNS = Object.freeze([
  "qjs_new_runtime",
  "qjs_new_context",
  "qjs_malloc_raw",
  "qjs_free_raw",
  "qjs_eval",
  "qjs_call",
  "qjs_free_value",
  "qjs_dup",
  "qjs_tag",
  "qjs_to_f64",
  "qjs_new_f64",
  "qjs_new_bool",
  "qjs_new_null",
  "qjs_new_undefined",
  "qjs_new_string_len",
  "qjs_to_cstring_len",
  "qjs_is_function",
  "qjs_is_equal",
  "qjs_is_exception",
  "qjs_take_exception",
  "qjs_global_object",
  "qjs_get_prop_str",
  "qjs_set_prop_str",
]);

/** In-band engine identity — readable from evaluated code (acceptance box 5). */
export const QUICKJS_ENGINE_IDENTITY_GLOBAL = "__js2wasm_eval_engine";

/**
 * Adapter-owned names on the QuickJS realm. Every one of them starts with the
 * shared prefix so the new-binding diff (`__js2wasm_eval_newnames__`) can
 * exclude the adapter's own bookkeeping without a second list to keep in sync.
 */
export const QUICKJS_ADAPTER_GLOBAL_PREFIX = "__js2wasm_eval_";
/** The direct-eval caller-scope snapshot object (`with (S) { … }`'s S). */
export const QUICKJS_SCOPE_GLOBAL = "__js2wasm_eval_scope__";

/**
 * Private global-object slot carrying `[name, EvalBindingCell, …]` for the
 * declarative half of the caller's GlobalEnvironmentRecord. Data, not a
 * function ABI — keep byte-for-byte aligned with
 * `RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY` in
 * src/codegen/expressions/runtime-eval-provider.ts and src/interp/types.ts.
 */
export const RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY = "__js2wasm_runtime_eval_global_lexical_cells__";

/**
 * The remaining typed refusals. Slice 2 retired the slice-1 value-bridge
 * refusals (non-ASCII source, non-number completion value, generic throw) and
 * slice 3 retired the direct-eval one; what is left is the two MVP boundaries
 * that are deliberate, documented residuals rather than unfinished work.
 */
/** A compiled GC object/function cannot cross INTO QuickJS in the MVP. */
export const QUICKJS_FOREIGN_VALUE_REFUSAL =
  "the quickjs eval engine (MVP) cannot pass compiled objects into evaluated " + "code (#4238)";
/** A QuickJS value whose tag has no MVP GC counterpart (Symbol, BigInt, …). */
export const QUICKJS_UNSUPPORTED_TAG_REFUSAL =
  "the quickjs eval engine (MVP) cannot represent this evaluated value in the " +
  "compiled heap (symbols and bigints are out of scope for #4238)";
export const QUICKJS_APPLY_FOREIGN_REFUSAL =
  "this callable was not produced by the quickjs eval engine, so it cannot be " + "applied through it (#4238)";
export const QUICKJS_INIT_REFUSAL = "the quickjs eval engine could not create a runtime/context (#4238)";

// ---------------------------------------------------------------- artifact --

/**
 * The artifact's content key. Same discipline as the #4013 provider job and the
 * `quickjs-wasi-artifact.yml` "Compute content hash" step: everything that can
 * change the bytes of `libquickjs.wasm` goes in, so a re-pin or a shim edit is
 * a different cache directory rather than a stale hit.
 */
export function quickjsArtifactCacheKey() {
  const buildScript = readFileSync(QUICKJS_BUILD_SCRIPT, "utf8");
  const shim = readFileSync(QUICKJS_SHIM_SOURCE, "utf8");
  const pin = (name, fallback) => {
    // build.sh spells its pins `NAME="${NAME:-value}"` — read the DEFAULT, then
    // let a live env override win (the build honours the same precedence).
    const m = buildScript.match(new RegExp(`^${name}="\\$\\{${name}:-([^}]*)\\}"`, "m"));
    return process.env[name] ?? m?.[1] ?? fallback;
  };
  return createHash("sha256")
    .update(pin("QUICKJS_NG_REF", ""))
    .update(" ")
    .update(pin("WASI_LIBC_REF", ""))
    .update(" ")
    .update(pin("BUILTINS_URL", ""))
    .update(" ")
    .update(process.env.OPT ?? "-O2")
    .update(" ")
    .update(createHash("sha256").update(shim).digest("hex"))
    .update(" ")
    .update(createHash("sha256").update(buildScript).digest("hex"))
    .digest("hex")
    .slice(0, 16);
}

/** Keyed artifact directory inside the shared provider cache dir. */
export function quickjsArtifactCacheDir(cacheDir, akey) {
  return join(cacheDir, `quickjs-artifact-${akey}`);
}

/** Cache path for the compiled GC adapter (distinct prefix, per #2928 E7). */
export function quickjsAdapterCachePath(cacheDir, key) {
  return join(cacheDir, `quickjs-eval-adapter-${key}.wasm`);
}

/**
 * Read a built artifact directory (`libquickjs.wasm` + `qjs-abi.json`), or null
 * when either file is absent.
 */
export function readQuickjsArtifact(dir) {
  const wasmPath = join(dir, "libquickjs.wasm");
  const abiPath = join(dir, "qjs-abi.json");
  if (!existsSync(wasmPath) || !existsSync(abiPath)) return null;
  const binary = readFileSync(wasmPath);
  const abi = JSON.parse(readFileSync(abiPath, "utf8"));
  return {
    dir,
    binary,
    abi,
    sha256: createHash("sha256").update(binary).digest("hex"),
  };
}

/**
 * The artifact is only usable if it is genuinely standalone: `wasi-stub.mjs` is
 * the ONLY JavaScript allowed behind the seam, so any other import module would
 * silently reintroduce a host dependency.
 */
export function assertQuickjsArtifactStandalone(binary) {
  const module = new WebAssembly.Module(binary);
  const bad = WebAssembly.Module.imports(module)
    .filter((i) => i.module !== "wasi_snapshot_preview1")
    .map((i) => `${i.module}::${i.name}`);
  if (bad.length > 0) {
    throw new Error(`libquickjs.wasm must import ONLY wasi_snapshot_preview1, found: ${bad.join(", ")}`);
  }
  return module;
}

/**
 * The artifact must actually export every wrapper the adapter declares. A
 * missing export otherwise surfaces as a bare `LinkError` at instantiation
 * time, deep inside a canary, with no hint that the ARTIFACT (not the adapter)
 * is the stale side — exactly the class of misleading failure #4238's slice-2
 * brief called out for the compiler bundle.
 */
export function assertQuickjsArtifactExports(binary) {
  const module = binary instanceof WebAssembly.Module ? binary : new WebAssembly.Module(binary);
  const present = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
  const missing = QUICKJS_ADAPTER_EXTERNS.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `libquickjs.wasm is missing ${missing.length} wrapper export(s) the adapter needs: ${missing.join(", ")}. ` +
        `The cached artifact predates the current scripts/quickjs-artifact/qjs_shim.c — rebuild it ` +
        `(bash scripts/quickjs-artifact/build.sh) or point JS2WASM_QUICKJS_ARTIFACT_DIR at a current one.`,
    );
  }
  return module;
}

// ----------------------------------------------------------- adapter source --

/**
 * The GC adapter, as js2wasm-compilable TypeScript.
 *
 * Why js2wasm-compiled TS and not C: the seam's values are WasmGC — externref
 * args wrapping canonical `$Object`s and an `[ok, value]` envelope decoded by
 * `emitRuntimeEvalResultUnwrap` off a structurally canonical externref vec. A
 * linear-memory C module can neither mint nor trap on any of those (clang's
 * `__externref_t` cannot even be stored in linear memory). Compiling the
 * adapter with the SAME options as the user module gets that canonicalization
 * for free — the same economic argument that produced the existing provider.
 *
 * The QuickJS tag constants are BAKED IN from the artifact's own
 * `qjs-abi.json` (never hardcoded — QuickJS's encodings are explicitly not a
 * stable ABI). That also makes the adapter's cache key depend on the artifact:
 * re-pin the artifact ⇒ different json ⇒ different source ⇒ different key.
 */
export function buildQuickjsAdapterSource(abi) {
  const tags = abi?.tags ?? {};
  const need = ["INT", "FLOAT64", "BOOL", "NULL", "UNDEFINED", "STRING", "STRING_ROPE", "OBJECT", "SHORT_BIG_INT"];
  const absent = need.filter((name) => typeof tags[name] !== "number");
  if (absent.length > 0) {
    throw new Error(`qjs-abi.json is missing tags.{${absent.join(",")}} — the artifact ABI dump is unusable`);
  }
  const j = JSON.stringify;
  return `
import { load8, load32, store8, store32 } from "wasm:memory";

type i32 = number;

declare function qjs_new_runtime(): i32;
declare function qjs_new_context(rt: i32): i32;
declare function qjs_malloc_raw(n: i32): i32;
declare function qjs_free_raw(p: i32): void;
declare function qjs_eval(ctx: i32, src: i32, len: i32): i32;
declare function qjs_call(ctx: i32, fn: i32, thisVal: i32, argc: i32, argv: i32): i32;
declare function qjs_free_value(ctx: i32, h: i32): void;
declare function qjs_dup(ctx: i32, h: i32): i32;
declare function qjs_tag(h: i32): i32;
declare function qjs_to_f64(ctx: i32, h: i32): number;
declare function qjs_new_f64(ctx: i32, d: number): i32;
declare function qjs_new_bool(ctx: i32, b: i32): i32;
declare function qjs_new_null(): i32;
declare function qjs_new_undefined(): i32;
declare function qjs_new_string_len(ctx: i32, buf: i32, len: i32): i32;
declare function qjs_to_cstring_len(ctx: i32, h: i32, lenOut: i32): i32;
declare function qjs_is_function(ctx: i32, h: i32): i32;
declare function qjs_is_equal(ctx: i32, a: i32, b: i32, strict: i32): i32;
declare function qjs_is_exception(h: i32): i32;
declare function qjs_take_exception(ctx: i32): i32;
declare function qjs_global_object(ctx: i32): i32;
declare function qjs_get_prop_str(ctx: i32, obj: i32, name: i32): i32;
declare function qjs_set_prop_str(ctx: i32, obj: i32, name: i32, val: i32): i32;

// Baked from the artifact's own qjs-abi.json (build-time product, ABI note 3).
const QJS_TAG_INT: number = ${tags.INT};
const QJS_TAG_FLOAT64: number = ${tags.FLOAT64};
const QJS_TAG_BOOL: number = ${tags.BOOL};
const QJS_TAG_NULL: number = ${tags.NULL};
const QJS_TAG_UNDEFINED: number = ${tags.UNDEFINED};
const QJS_TAG_STRING: number = ${tags.STRING};
const QJS_TAG_STRING_ROPE: number = ${tags.STRING_ROPE};
const QJS_TAG_OBJECT: number = ${tags.OBJECT};
const QJS_TAG_SHORT_BIG_INT: number = ${tags.SHORT_BIG_INT};

/**
 * One mutable boxed binding shared by AOT code and this provider — the exact
 * shape src/interp/types.ts declares, so the one-field WasmGC struct Core Wasm
 * canonicalises across the module boundary is the SAME type on both sides.
 *
 * The annotation is load-bearing, not decoration: reading \`cell.value\` off an
 * \`any\` compiles to the generic object-property path, which answers
 * \`undefined\` for a ref cell (measured — every caller binding read as
 * undefined until the cast was added). Always go through \`as EvalBindingCell\`.
 */
interface EvalBindingCell {
  value: any;
}

// One QuickJS context per adapter INSTANCE. instantiateRuntimeEvalNamespace
// builds a fresh adapter+libquickjs pair per call, so this is per-test state.
var qjsContextHandle: number = 0;

// Direct eval's realm-side helpers are installed on first use, not at context
// init: a module that never takes the direct route should not pay an eval.
var qjsDirectHelpersReady: boolean = false;

// Every name a sloppy direct eval has ever created on the QuickJS realm. A
// \`var\` there is NON-CONFIGURABLE, so once mirrored into an activation's pool
// it is only blanked to \`undefined\`, not deleted — and then a LATER activation
// that redeclares it would not show up in the realm diff. Remembering the names
// keeps them mirrorable for the rest of the context's life.
var qjsCreatedNames: string[] = [];

// Byte length written by the last qjsPushUtf8 (a second return value without an
// allocation — the adapter runs on the hot path of every string crossing).
var qjsUtf8Len: number = 0;

// Set by qjsToQuickjs when a GC value has no QuickJS counterpart, and by
// qjsToGc when a QuickJS tag has no compiled-heap counterpart. Non-empty means
// "refuse with this message"; callers clear it before each conversion.
var qjsPushRefusal: string = "";
var qjsPullRefusal: string = "";

function runtimeEvalResult(ok: boolean, value: any): any {
  const result: any[] = [ok, __runtime_eval_wrap_result(value)];
  return result;
}

// -------------------------------------------------------------- UTF-8 ------
// Both directions live here because the seam's strings are GC strings and
// QuickJS's are UTF-8 bytes in the shared heap; there is no third party that
// could do the transcoding without reintroducing JS behind the seam.

/**
 * UTF-8 encode \`text\` into a fresh NUL-terminated buffer in the QuickJS heap.
 * Returns the pointer (release with qjs_free_raw) and leaves the BYTE length in
 * qjsUtf8Len; 0 on allocation failure. A lone surrogate encodes as U+FFFD
 * (documented residual — WTF-8 is not representable in a C string API).
 * Worst case is 3 bytes per code UNIT (a surrogate pair is 2 units → 4 bytes),
 * so \`len * 3 + 1\` is a sound bound.
 */
function qjsPushUtf8(text: string): number {
  const n: number = text.length;
  const ptr: number = qjs_malloc_raw(n * 3 + 1);
  qjsUtf8Len = 0;
  if (ptr === 0) return 0;
  let w: number = 0;
  let i: number = 0;
  while (i < n) {
    let code: number = text.charCodeAt(i) as number;
    i += 1;
    if (code >= 0xd800 && code <= 0xdbff && i < n) {
      const lo: number = text.charCodeAt(i) as number;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        code = 0x10000 + (code - 0xd800) * 0x400 + (lo - 0xdc00);
        i += 1;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) {
      store8(ptr + w, code);
      w += 1;
    } else if (code < 0x800) {
      store8(ptr + w, 0xc0 | (code >> 6));
      store8(ptr + w + 1, 0x80 | (code & 0x3f));
      w += 2;
    } else if (code < 0x10000) {
      store8(ptr + w, 0xe0 | (code >> 12));
      store8(ptr + w + 1, 0x80 | ((code >> 6) & 0x3f));
      store8(ptr + w + 2, 0x80 | (code & 0x3f));
      w += 3;
    } else {
      store8(ptr + w, 0xf0 | (code >> 18));
      store8(ptr + w + 1, 0x80 | ((code >> 12) & 0x3f));
      store8(ptr + w + 2, 0x80 | ((code >> 6) & 0x3f));
      store8(ptr + w + 3, 0x80 | (code & 0x3f));
      w += 4;
    }
  }
  store8(ptr + w, 0);
  qjsUtf8Len = w;
  return ptr;
}

/** Decode \`len\` UTF-8 bytes at \`ptr\` into a GC string (surrogate pairs for
 *  astral code points; QuickJS emits CESU-8 for lone surrogates, which the
 *  three-byte arm reproduces as the original code unit). */
function qjsReadUtf8(ptr: number, len: number): string {
  let out: string = "";
  let i: number = 0;
  while (i < len) {
    const b0: number = load8(ptr + i);
    let cp: number = 0;
    if (b0 < 0x80) {
      cp = b0;
      i += 1;
    } else if (b0 < 0xe0) {
      cp = ((b0 & 0x1f) << 6) | (load8(ptr + i + 1) & 0x3f);
      i += 2;
    } else if (b0 < 0xf0) {
      cp = ((b0 & 0x0f) << 12) | ((load8(ptr + i + 1) & 0x3f) << 6) | (load8(ptr + i + 2) & 0x3f);
      i += 3;
    } else {
      cp =
        ((b0 & 0x07) << 18) |
        ((load8(ptr + i + 1) & 0x3f) << 12) |
        ((load8(ptr + i + 2) & 0x3f) << 6) |
        (load8(ptr + i + 3) & 0x3f);
      i += 4;
    }
    if (cp > 0xffff) {
      const v: number = cp - 0x10000;
      out = out + String.fromCharCode(0xd800 + Math.floor(v / 1024));
      out = out + String.fromCharCode(0xdc00 + (v % 1024));
    } else {
      out = out + String.fromCharCode(cp);
    }
  }
  return out;
}

/** NUL-terminated UTF-8 copy of \`text\` in the QuickJS heap; 0 on failure. */
function qjsPushCString(text: string): number {
  return qjsPushUtf8(text);
}

/** Render a QuickJS value as a GC string (ToString semantics via the shim). */
function qjsReadString(c: number, h: number): string {
  const lenPtr: number = qjs_malloc_raw(4);
  if (lenPtr === 0) return "";
  store32(lenPtr, 0);
  const buf: number = qjs_to_cstring_len(c, h, lenPtr);
  if (buf === 0) {
    qjs_free_raw(lenPtr);
    return "";
  }
  const len: number = load32(lenPtr);
  const out: string = qjsReadUtf8(buf, len);
  qjs_free_raw(buf);
  qjs_free_raw(lenPtr);
  return out;
}

// ----------------------------------------------------- handle registry -----
// The i32→JSValue handle table IS the artifact's malloc'd cells; this registry
// only remembers which of them a compiled value stands for. Entries are
// RETAINED for the instance lifetime (the documented context-lifetime leak —
// cross-heap cycle collection is out of scope, #4245 replaces this with a real
// membrane). It is a linear scan on purpose: the population is the handful of
// QuickJS objects that actually cross out, and identity is decided by QuickJS's
// own strict equality, not by handle-cell address (qjs_dup mints a new cell for
// the same object).

var qjsBoxHandles: number[] = [];
var qjsBoxTargets: any[] = [];
var qjsBoxExposed: any[] = [];

function qjsFindBoxIndex(c: number, h: number): number {
  for (let i = 0; i < qjsBoxHandles.length; i += 1) {
    if (qjs_is_equal(c, qjsBoxHandles[i] as number, h, 1) !== 0) return i;
  }
  return -1;
}

/**
 * The retained handle a compiled value stands for, or 0 when it is not ours.
 * Both columns are scanned because a value re-enters the provider in either
 * form: \`__apply_closure\` hands \`__runtime_apply_interpreted\` the marker's
 * TARGET (the box), while an ARGUMENT arrives as whatever the caller is
 * holding — the marker for a callable, the box for a plain object. The marker
 * is peeled first for the case where a caller passes a callable straight back.
 */
function qjsHandleOf(value: any): number {
  const target: any = __runtime_eval_unwrap_interpreted_callback(value);
  for (let i = 0; i < qjsBoxTargets.length; i += 1) {
    if (qjsBoxTargets[i] === target) return qjsBoxHandles[i] as number;
    if (qjsBoxExposed[i] === target) return qjsBoxHandles[i] as number;
    if (qjsBoxTargets[i] === value) return qjsBoxHandles[i] as number;
    if (qjsBoxExposed[i] === value) return qjsBoxHandles[i] as number;
  }
  return 0;
}

// ------------------------------------------------------- value bridging -----

/**
 * GC → QuickJS. Returns an OWNED handle the caller frees exactly once, or 0
 * with qjsPushRefusal set. Compiled objects/functions are refused loudly:
 * silently passing \`undefined\` would make evaluated code quietly wrong.
 */
function qjsToQuickjs(c: number, value: any): number {
  // Dispatch on \`typeof\` BEFORE any identity comparison. \`value === undefined\`
  // is NOT a reliable classifier here: the value arrived from another module
  // through the result carrier, and a foreign \`$Object\` compares equal to this
  // module's \`undefined\` sentinel — which silently turned every compiled object
  // into \`undefined\` inside QuickJS instead of the typed refusal below.
  const t: string = typeof value;
  if (t === "undefined") return qjs_new_undefined();
  if (value === null) return qjs_new_null();
  if (t === "number") return qjs_new_f64(c, value as number);
  if (t === "boolean") return qjs_new_bool(c, (value as boolean) ? 1 : 0);
  if (t === "string") {
    const ptr: number = qjsPushUtf8(value as string);
    if (ptr === 0) {
      qjsPushRefusal = ${j(QUICKJS_INIT_REFUSAL)};
      return 0;
    }
    const h: number = qjs_new_string_len(c, ptr, qjsUtf8Len);
    qjs_free_raw(ptr);
    return h;
  }
  const retained: number = qjsHandleOf(value);
  // Round-tripping one of our own handles preserves identity inside QuickJS.
  if (retained !== 0) return qjs_dup(c, retained);
  qjsPushRefusal = ${j(QUICKJS_FOREIGN_VALUE_REFUSAL)};
  return 0;
}

/** Read a string-valued property off a QuickJS object ("" when absent). */
function qjsPropString(c: number, obj: number, name: string): string {
  const namePtr: number = qjsPushCString(name);
  if (namePtr === 0) return "";
  const v: number = qjs_get_prop_str(c, obj, namePtr);
  qjs_free_raw(namePtr);
  if (v === 0) return "";
  const tag: number = qjs_tag(v);
  let out: string = "";
  if (tag === QJS_TAG_STRING || tag === QJS_TAG_STRING_ROPE) out = qjsReadString(c, v);
  qjs_free_value(c, v);
  return out;
}

/** Read a number-valued property off a QuickJS object (0 when absent). */
function qjsPropNumber(c: number, obj: number, name: string): number {
  const namePtr: number = qjsPushCString(name);
  if (namePtr === 0) return 0;
  const v: number = qjs_get_prop_str(c, obj, namePtr);
  qjs_free_raw(namePtr);
  if (v === 0) return 0;
  const tag: number = qjs_tag(v);
  let out: number = 0;
  if (tag === QJS_TAG_INT || tag === QJS_TAG_FLOAT64) out = qjs_to_f64(c, v);
  qjs_free_value(c, v);
  return out;
}

/**
 * Retain \`h\` and publish the compiled-side stand-in for it. A callable becomes
 * the branded provider→AOT marker (so the caller's \`__apply_closure\` routes
 * invocations back through \`__runtime_apply_interpreted\`); anything else
 * becomes an opaque box, which AOT sees as a near-empty object (residual — no
 * membrane in this issue) but which unwraps to the SAME handle on the way back
 * in, so identity holds within the provider.
 */
function qjsPublish(c: number, h: number): any {
  const existing: number = qjsFindBoxIndex(c, h);
  if (existing >= 0) return qjsBoxExposed[existing];
  const retained: number = qjs_dup(c, h);
  const target: any = { __qjs_handle__: retained };
  let exposed: any = target;
  if (qjs_is_function(c, h) !== 0) {
    exposed = __runtime_eval_wrap_interpreted_callback(
      target,
      qjsPropString(c, h, "name"),
      qjsPropNumber(c, h, "length"),
      undefined
    );
  }
  qjsBoxHandles.push(retained);
  qjsBoxTargets.push(target);
  qjsBoxExposed.push(exposed);
  return exposed;
}

/**
 * QuickJS → GC, dispatching on the TAG first: qjs_to_f64's NaN is a legitimate
 * value for a numeric tag, never an error sentinel (#4238 implementation trap
 * (a)). \`h\` stays owned by the caller.
 */
function qjsToGc(c: number, h: number): any {
  const tag: number = qjs_tag(h);
  if (tag === QJS_TAG_INT || tag === QJS_TAG_FLOAT64 || tag === QJS_TAG_SHORT_BIG_INT) {
    return qjs_to_f64(c, h);
  }
  if (tag === QJS_TAG_BOOL) return qjs_to_f64(c, h) !== 0;
  if (tag === QJS_TAG_NULL) return null;
  if (tag === QJS_TAG_UNDEFINED) return undefined;
  if (tag === QJS_TAG_STRING || tag === QJS_TAG_STRING_ROPE) return qjsReadString(c, h);
  if (tag === QJS_TAG_OBJECT) return qjsPublish(c, h);
  qjsPullRefusal = ${j(QUICKJS_UNSUPPORTED_TAG_REFUSAL)};
  return undefined;
}

// -------------------------------------------------------- error mapping -----

/** Map a QuickJS exception VALUE onto the matching compiled error, preserving
 *  the real name and message. A thrown non-object crosses as its own value. */
function qjsErrorFromHandle(c: number, h: number): any {
  if (qjs_tag(h) !== QJS_TAG_OBJECT) {
    qjsPullRefusal = "";
    const thrown: any = qjsToGc(c, h);
    if (qjsPullRefusal !== "") return new TypeError(qjsPullRefusal);
    return thrown;
  }
  const name: string = qjsPropString(c, h, "name");
  const message: string = qjsPropString(c, h, "message");
  if (name === "SyntaxError") return new SyntaxError(message);
  if (name === "TypeError") return new TypeError(message);
  if (name === "ReferenceError") return new ReferenceError(message);
  if (name === "RangeError") return new RangeError(message);
  if (name === "EvalError") return new EvalError(message);
  if (name === "URIError") return new URIError(message);
  const generic: any = new Error(message);
  if (name !== "" && name !== "Error") generic.name = name;
  return generic;
}

/** Drain the pending exception into an \`[false, error]\` envelope. */
function qjsThrewResult(c: number): any {
  const pending: number = qjs_take_exception(c);
  const err: any = qjsErrorFromHandle(c, pending);
  qjs_free_value(c, pending);
  return runtimeEvalResult(false, err);
}

// ------------------------------------------------------------- realm --------

/** In-band engine identity: evaluated code can read ${QUICKJS_ENGINE_IDENTITY_GLOBAL}. */
function qjsInstallEngineIdentity(c: number): void {
  const namePtr: number = qjsPushCString(${j(QUICKJS_ENGINE_IDENTITY_GLOBAL)});
  if (namePtr === 0) return;
  const globalHandle: number = qjs_global_object(c);
  const valueHandle: number = qjsToQuickjs(c, "quickjs");
  qjs_set_prop_str(c, globalHandle, namePtr, valueHandle);
  // Borrow-in/own-out (ABI note 2): every handle a wrapper RETURNED is freed
  // here exactly once, on this path and on every early return above.
  qjs_free_value(c, valueHandle);
  qjs_free_value(c, globalHandle);
  qjs_free_raw(namePtr);
}

function qjsEnsureContext(): number {
  if (qjsContextHandle !== 0) return qjsContextHandle;
  const rt: number = qjs_new_runtime();
  if (rt === 0) return 0;
  const c: number = qjs_new_context(rt);
  if (c === 0) return 0;
  qjsContextHandle = c;
  qjsInstallEngineIdentity(c);
  return c;
}

/**
 * Mirror the caller's realm object onto QuickJS \`globalThis\` before evaluating.
 * Only PRIMITIVES cross (a compiled object has no MVP representation); a
 * skipped global simply reads as whatever QuickJS already has, which is
 * \`undefined\` for a name only the caller knows. Residual, documented.
 */
function qjsPushGlobals(c: number, globalObject: any): void {
  if (globalObject === undefined || globalObject === null) return;
  const g: number = qjs_global_object(c);
  const keys: any = Object.keys(globalObject);
  for (let i = 0; i < keys.length; i += 1) {
    const key: string = keys[i] as string;
    const value: any = __runtime_eval_unwrap_result(globalObject[key]);
    // Same filter as the pull side: only primitives are mirrorable. A compiled
    // object has no MVP representation, and the eval/Function markers must not
    // be shadowed on the QuickJS realm by an \`undefined\` stand-in.
    if (qjsIsMirrorablePrimitive(value)) {
      const namePtr: number = qjsPushCString(key);
      if (namePtr !== 0) {
        qjsPushRefusal = "";
        const h: number = qjsToQuickjs(c, value);
        if (qjsPushRefusal === "") qjs_set_prop_str(c, g, namePtr, h);
        qjs_free_value(c, h);
        qjs_free_raw(namePtr);
      }
    }
  }
  qjsPushRefusal = "";
  qjs_free_value(c, g);
}

/** True when a compiled value is one of the primitives the globals mirror
 *  carries. Everything else (compiled objects, the memoized eval/Function
 *  markers, our own handle boxes) is realm state the mirror must LEAVE ALONE. */
function qjsIsMirrorablePrimitive(value: any): boolean {
  if (value === null) return true;
  const t: string = typeof value;
  return t === "number" || t === "boolean" || t === "string" || t === "undefined";
}

/** The QuickJS-side half of the same filter, by TAG. Shared by every write-back
 *  path (realm object, global lexical cells, direct-eval caller cells and the
 *  activation state pool) so a foreign object can never reach a carrier the
 *  caller keeps across provider entries. */
function qjsIsMirrorableTag(tag: number): boolean {
  return (
    tag === QJS_TAG_INT ||
    tag === QJS_TAG_FLOAT64 ||
    tag === QJS_TAG_SHORT_BIG_INT ||
    tag === QJS_TAG_BOOL ||
    tag === QJS_TAG_NULL ||
    tag === QJS_TAG_UNDEFINED ||
    tag === QJS_TAG_STRING ||
    tag === QJS_TAG_STRING_ROPE
  );
}

/**
 * Mirror the caller's GLOBAL LEXICAL cells (\`let\`/\`const\` at module top
 * level) onto QuickJS \`globalThis\`. They live on a deliberately
 * non-enumerable carrier property, so \`Object.keys\` in qjsPushGlobals cannot
 * reach them; the interpreter reads the same alternating [name, cell, …] vector
 * (src/interp/eval-environment.ts createRuntimeEvalGlobalEnvironment).
 */
function qjsPushGlobalLexicalCells(c: number, globalObject: any): void {
  if (globalObject === undefined || globalObject === null) return;
  const carrier: any = globalObject[${j(RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY)}];
  if (carrier === undefined || carrier === null) return;
  const g: number = qjs_global_object(c);
  for (let i = 0; i + 1 < (carrier.length as number); i += 2) {
    const name: any = carrier[i];
    const cell: EvalBindingCell = carrier[i + 1] as EvalBindingCell;
    if (typeof name !== "string" || cell === undefined || cell === null) continue;
    const value: any = __runtime_eval_unwrap_result(cell.value);
    if (!qjsIsMirrorablePrimitive(value)) continue;
    const namePtr: number = qjsPushCString(name as string);
    if (namePtr === 0) continue;
    qjsPushRefusal = "";
    const h: number = qjsToQuickjs(c, value);
    if (qjsPushRefusal === "") qjs_set_prop_str(c, g, namePtr, h);
    qjs_free_value(c, h);
    qjs_free_raw(namePtr);
  }
  qjsPushRefusal = "";
  qjs_free_value(c, g);
}

/** Copy the global lexical cells back. PRIMITIVES ONLY, both sides — the same
 *  filter that keeps the realm object's intrinsic markers intact. */
function qjsPullGlobalLexicalCells(c: number, globalObject: any): void {
  if (globalObject === undefined || globalObject === null) return;
  const carrier: any = globalObject[${j(RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY)}];
  if (carrier === undefined || carrier === null) return;
  const g: number = qjs_global_object(c);
  for (let i = 0; i + 1 < (carrier.length as number); i += 2) {
    const name: any = carrier[i];
    const cell: EvalBindingCell = carrier[i + 1] as EvalBindingCell;
    if (typeof name !== "string" || cell === undefined || cell === null) continue;
    if (!qjsIsMirrorablePrimitive(__runtime_eval_unwrap_result(cell.value))) continue;
    const namePtr: number = qjsPushCString(name as string);
    if (namePtr === 0) continue;
    const h: number = qjs_get_prop_str(c, g, namePtr);
    qjs_free_raw(namePtr);
    if (h === 0) continue;
    if (qjsIsMirrorableTag(qjs_tag(h))) {
      qjsPullRefusal = "";
      const value: any = qjsToGc(c, h);
      if (qjsPullRefusal === "") cell.value = __runtime_eval_wrap_result(value);
    }
    qjs_free_value(c, h);
  }
  qjsPullRefusal = "";
  qjs_free_value(c, g);
}

/**
 * Copy the mirrored globals back after evaluating (the pull side is copy-back
 * by contract — see emitRuntimeEvalGlobalBindingPullBody). Names the evaluated
 * code CREATED are not pulled: the caller's realm object enumerates only the
 * bindings the compiled module already owns.
 *
 * BOTH filters below are load-bearing, and getting them wrong is not subtle —
 * it corrupts the caller's realm:
 *  - the caller-side filter skips any binding that is not a primitive, so the
 *    memoized \`eval\`/\`Function\` intrinsic markers survive. Without it the pull
 *    replaced \`globalObject.eval\` with a QuickJS function box on the FIRST
 *    eval, and every later \`(0, eval)\` in the same module went somewhere else
 *    entirely (measured: the second eval of the same source came back as an
 *    object, and direct eval stopped refusing).
 *  - the QuickJS-side tag filter keeps objects out for the same reason, and
 *    keeps a name QuickJS does not have from clobbering the caller's binding
 *    with \`undefined\`.
 */
function qjsPullGlobals(c: number, globalObject: any): void {
  if (globalObject === undefined || globalObject === null) return;
  const g: number = qjs_global_object(c);
  const keys: any = Object.keys(globalObject);
  for (let i = 0; i < keys.length; i += 1) {
    const key: string = keys[i] as string;
    const current: any = __runtime_eval_unwrap_result(globalObject[key]);
    if (qjsIsMirrorablePrimitive(current)) {
      const namePtr: number = qjsPushCString(key);
      if (namePtr !== 0) {
        const h: number = qjs_get_prop_str(c, g, namePtr);
        qjs_free_raw(namePtr);
        if (h !== 0) {
          if (qjsIsMirrorableTag(qjs_tag(h))) {
            qjsPullRefusal = "";
            const value: any = qjsToGc(c, h);
            if (qjsPullRefusal === "") globalObject[key] = __runtime_eval_wrap_result(value);
          }
          qjs_free_value(c, h);
        }
      }
    }
  }
  qjsPullRefusal = "";
  qjs_free_value(c, g);
}

// -------------------------------------------------------------- evaluate ----

/** Evaluate \`source\` at QuickJS global scope — correct for INDIRECT eval and
 *  for the \`new Function\` source form by spec. */
function qjsEvaluate(source: string, globalObject: any): any {
  const c: number = qjsEnsureContext();
  if (c === 0) return runtimeEvalResult(false, new TypeError(${j(QUICKJS_INIT_REFUSAL)}));
  const buf: number = qjsPushUtf8(source);
  if (buf === 0) return runtimeEvalResult(false, new TypeError(${j(QUICKJS_INIT_REFUSAL)}));
  const byteLen: number = qjsUtf8Len;
  qjsPushGlobals(c, globalObject);
  qjsPushGlobalLexicalCells(c, globalObject);
  const handle: number = qjs_eval(c, buf, byteLen);
  qjs_free_raw(buf);
  if (handle === 0) return runtimeEvalResult(false, new TypeError(${j(QUICKJS_INIT_REFUSAL)}));
  if (qjs_is_exception(handle) !== 0) {
    qjs_free_value(c, handle);
    qjsPullGlobalLexicalCells(c, globalObject);
    qjsPullGlobals(c, globalObject);
    return qjsThrewResult(c);
  }
  qjsPullRefusal = "";
  const value: any = qjsToGc(c, handle);
  qjs_free_value(c, handle);
  qjsPullGlobalLexicalCells(c, globalObject);
  qjsPullGlobals(c, globalObject);
  if (qjsPullRefusal !== "") {
    const refusal: string = qjsPullRefusal;
    qjsPullRefusal = "";
    return runtimeEvalResult(false, new TypeError(refusal));
  }
  return runtimeEvalResult(true, value);
}

// Intrinsic materialization follows the REFUSAL provider's precedent exactly
// (scripts/runtime-eval-provider.mjs): reading first-class \`eval\`/\`Function\`
// is not itself dynamic code execution, and the markers must be MEMOIZED so
// \`(0, eval)\` is identity-stable across reads. Minting a fresh QuickJS handle
// per read would break that identity — and, worse, hand compiled code a raw
// QuickJS object. Invoking a marker reaches __runtime_apply_interpreted, which
// recognizes these two TARGET objects by identity and re-enters the engine.
var qjsIntrinsicEval: any = undefined;
var qjsIntrinsicFunction: any = undefined;
var qjsIntrinsicRealm: any = undefined;
const qjsEvalTarget: any = { __qjs_intrinsic__: 1 };
const qjsFunctionTarget: any = { __qjs_intrinsic__: 2 };

function qjsIntrinsicEvalValue(globalObject: any): any {
  qjsIntrinsicRealm = globalObject;
  if (qjsIntrinsicFunction === undefined) {
    qjsIntrinsicFunction = __runtime_eval_wrap_intrinsic_function_callback(
      qjsFunctionTarget,
      "Function",
      1
    );
  }
  if (qjsIntrinsicEval === undefined) {
    qjsIntrinsicEval = __runtime_eval_wrap_intrinsic_callback(
      qjsEvalTarget,
      "eval",
      1,
      qjsIntrinsicFunction
    );
  }
  if (!("eval" in globalObject)) globalObject.eval = qjsIntrinsicEval;
  if (!("Function" in globalObject)) globalObject.Function = qjsIntrinsicFunction;
  return globalObject.eval;
}

export function __runtime_indirect_eval(source: any, globalObject: any): any {
  // PerformEval step 2: a non-string argument is returned unchanged.
  if (typeof source !== "string") return runtimeEvalResult(true, source);
  if (source === "eval") return runtimeEvalResult(true, qjsIntrinsicEvalValue(globalObject));
  if (source === "Function") {
    qjsIntrinsicEvalValue(globalObject);
    return runtimeEvalResult(true, globalObject.Function);
  }
  return qjsEvaluate(source as string, globalObject);
}

/** §20.2.1.1.1 CreateDynamicFunction's source form. QuickJS performs the early
 *  errors, so a bad parameter list surfaces as a real SyntaxError. */
export function __runtime_new_function(
  paramString: any,
  bodyString: any,
  globalObject: any
): any {
  const source: string =
    "(function anonymous(" + String(paramString) + "\\n) {\\n" + String(bodyString) + "\\n})";
  return qjsEvaluate(source, globalObject);
}

// ------------------------------------------------------- direct eval -------
// The caller hands 12 arguments; ten of them describe the scope it is standing
// in. Three name/cell layers (outer captures, the current activation, call-site
// lexical shadows) plus a 64-slot activation STATE POOL that persists
// eval-created sloppy vars across every direct eval in one AOT activation. The
// cells are LIVE: writing \`cell.value\` updates the binding the caller's own
// later reads dereference, with no copy-back shadow environment.
//
// QuickJS cannot be handed those cells, so the bridge is a snapshot object S:
//  - SLOPPY caller ⇒ \`with (S) { … }\`. QuickJS performs the scope walk itself,
//    including assignment-to-with-binding, which is what recovers the dominant
//    \`eval("x = x + 1")\` shape.
//  - STRICT caller ⇒ \`with\` is a SyntaxError, so S is read through a
//    block-scoped \`const\` preamble instead. Writes then throw (assignment to a
//    constant) rather than updating — the documented slice-3 residual.

/** Realm-side helpers for the direct route, installed once per context. Kept in
 *  QuickJS rather than in shim C so the artifact hash does not move. */
function qjsEnsureDirectHelpers(c: number): boolean {
  if (qjsDirectHelpersReady) return true;
  const installed: number = qjsEvalInternal(
    c,
    "globalThis.__js2wasm_eval_mkobj__ = function () { return {}; };" +
      "globalThis.__js2wasm_eval_prenames__ = function () {" +
      " return Object.getOwnPropertyNames(globalThis); };" +
      "globalThis.__js2wasm_eval_newnames__ = function (pre) {" +
      " var g = Object.getOwnPropertyNames(globalThis), o = [], i, k, seen, n;" +
      " for (i = 0; i < g.length; i++) {" +
      "  n = g[i];" +
      "  if (n.slice(0, ${QUICKJS_ADAPTER_GLOBAL_PREFIX.length}) === '${QUICKJS_ADAPTER_GLOBAL_PREFIX}') continue;" +
      "  seen = false;" +
      "  for (k = 0; k < pre.length; k++) { if (pre[k] === n) { seen = true; break; } }" +
      "  if (!seen) o.push(n);" +
      " }" +
      " return o.join('\\\\u0001'); };" +
      // A \`var\` at QuickJS global scope creates a NON-CONFIGURABLE property, so
      // \`delete\` on it silently fails. Fall back to writing \`undefined\`, which
      // is what the caller's other scopes must observe for a binding that was
      // only ever function-scoped.
      "globalThis.__js2wasm_eval_del__ = function (n) {" +
      " delete globalThis[n];" +
      " if (Object.getOwnPropertyDescriptor(globalThis, n)) globalThis[n] = undefined; };" +
      "0"
  );
  if (installed === 0) return false;
  qjs_free_value(c, installed);
  qjsDirectHelpersReady = true;
  return true;
}

/** Evaluate adapter-owned bookkeeping source. Returns an OWNED handle, or 0
 *  when the evaluation failed — a pending exception is drained, never leaked
 *  into the user's next entry. */
function qjsEvalInternal(c: number, src: string): number {
  const buf: number = qjsPushUtf8(src);
  if (buf === 0) return 0;
  const byteLen: number = qjsUtf8Len;
  const h: number = qjs_eval(c, buf, byteLen);
  qjs_free_raw(buf);
  if (h === 0) return 0;
  if (qjs_is_exception(h) !== 0) {
    qjs_free_value(c, h);
    const pending: number = qjs_take_exception(c);
    qjs_free_value(c, pending);
    return 0;
  }
  return h;
}

/** Call one of the realm-side helpers with 0 or 1 borrowed argument handles.
 *  Returns an OWNED result handle, or 0 on failure (exception drained). */
function qjsCallGlobalHelper(c: number, name: string, argc: number, arg: number): number {
  const g: number = qjs_global_object(c);
  const namePtr: number = qjsPushCString(name);
  if (namePtr === 0) {
    qjs_free_value(c, g);
    return 0;
  }
  const fn: number = qjs_get_prop_str(c, g, namePtr);
  qjs_free_raw(namePtr);
  if (fn === 0) {
    qjs_free_value(c, g);
    return 0;
  }
  let argv: number = 0;
  if (argc > 0) {
    argv = qjs_malloc_raw(4);
    if (argv !== 0) store32(argv, arg);
  }
  const ret: number = argc > 0 && argv === 0 ? 0 : qjs_call(c, fn, g, argc, argv);
  if (argv !== 0) qjs_free_raw(argv);
  qjs_free_value(c, fn);
  qjs_free_value(c, g);
  if (ret === 0) return 0;
  if (qjs_is_exception(ret) !== 0) {
    qjs_free_value(c, ret);
    const pending: number = qjs_take_exception(c);
    qjs_free_value(c, pending);
    return 0;
  }
  return ret;
}

/** Record one caller binding. An INNER layer shadows an outer one of the same
 *  name, exactly as the interpreter's env-record chain does, so the write-back
 *  can only ever reach the binding the evaluated code actually saw. */
function qjsAppendBinding(names: string[], cells: any[], name: string, cell: any): void {
  for (let i = 0; i < names.length; i += 1) {
    if (names[i] === name) {
      cells[i] = cell;
      return;
    }
  }
  names.push(name);
  cells.push(cell);
}

/** Collect one parallel name/cell layer handed in by the caller. */
function qjsCollectLayer(nameVec: any, slotVec: any, names: string[], cells: any[]): void {
  if (nameVec === undefined || nameVec === null) return;
  if (slotVec === undefined || slotVec === null) return;
  for (let i = 0; i < (nameVec.length as number); i += 1) {
    const name: any = nameVec[i];
    const cell: any = slotVec[i];
    if (typeof name !== "string") continue;
    if (cell === undefined || cell === null) continue;
    qjsAppendBinding(names, cells, name as string, cell);
  }
}

/** Collect the persistent activation state pool: alternating [nameCell,
 *  valueCell]. An unclaimed pair carries \`undefined\` in its name cell — the
 *  same vacancy discipline preparePersistentEvalBindings uses. */
function qjsCollectPool(pool: any, names: string[], cells: any[]): void {
  if (pool === undefined || pool === null) return;
  for (let i = 0; i + 1 < (pool.length as number); i += 2) {
    const nameCell: EvalBindingCell = pool[i] as EvalBindingCell;
    if (nameCell === undefined || nameCell === null) continue;
    const name: any = __runtime_eval_unwrap_result(nameCell.value);
    if (typeof name !== "string") continue;
    qjsAppendBinding(names, cells, name as string, pool[i + 1]);
  }
}

function qjsIsIdentChar(ch: number): boolean {
  if (ch >= 97 && ch <= 122) return true;
  if (ch >= 65 && ch <= 90) return true;
  if (ch >= 48 && ch <= 57) return true;
  return ch === 95 || ch === 36;
}

/** Reserved words plus the two names a strict \`const\` may not bind. */
const QJS_RESERVED_NAMES: string[] = [
  "arguments", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "eval", "export",
  "extends", "false", "finally", "for", "function", "if", "implements",
  "import", "in", "instanceof", "interface", "let", "new", "null", "package",
  "private", "protected", "public", "return", "static", "super", "switch",
  "this", "throw", "true", "try", "typeof", "var", "void", "while", "with",
  "yield",
];

/** Can \`name\` legally appear as \`const <name> = …\` in strict code? */
function qjsIsSafeConstName(name: string): boolean {
  const n: number = name.length;
  if (n === 0) return false;
  const first: number = name.charCodeAt(0) as number;
  if (first >= 48 && first <= 57) return false;
  if (!qjsIsIdentChar(first)) return false;
  for (let i = 1; i < n; i += 1) {
    if (!qjsIsIdentChar(name.charCodeAt(i) as number)) return false;
  }
  for (let i = 0; i < QJS_RESERVED_NAMES.length; i += 1) {
    if (QJS_RESERVED_NAMES[i] === name) return false;
  }
  return true;
}

/** Does \`source\` contain \`name\` as a whole identifier token? A conservative
 *  scan (it also matches inside strings and comments), used only to keep the
 *  strict preamble to the names the code could possibly reference — every
 *  \`const\` it emits is one more chance to collide with a \`let\`/\`const\` the
 *  evaluated code declares itself. */
function qjsSourceMentions(source: string, name: string): boolean {
  const sn: number = source.length;
  const nn: number = name.length;
  if (nn === 0 || nn > sn) return false;
  const first: number = name.charCodeAt(0) as number;
  for (let i = 0; i + nn <= sn; i += 1) {
    if ((source.charCodeAt(i) as number) !== first) continue;
    let match: boolean = true;
    for (let k = 1; k < nn; k += 1) {
      if ((source.charCodeAt(i + k) as number) !== (name.charCodeAt(k) as number)) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    if (i > 0 && qjsIsIdentChar(source.charCodeAt(i - 1) as number)) continue;
    if (i + nn < sn && qjsIsIdentChar(source.charCodeAt(i + nn) as number)) continue;
    return true;
  }
  return false;
}

/** Split the helper's \\u0001-joined new-binding list. */
function qjsSplitJoined(text: string, into: string[]): void {
  let current: string = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch: number = text.charCodeAt(i) as number;
    if (ch === 1) {
      if (current.length > 0) into.push(current);
      current = "";
    } else {
      current = current + String.fromCharCode(ch);
    }
  }
  if (current.length > 0) into.push(current);
}

/**
 * Wrap the user's source so the snapshot object is in scope.
 *
 * The \`undefined;\` in the strict form is NOT decoration. A Script's completion
 * value is the last NON-EMPTY statement value (UpdateEmpty), so a bare
 * \`"use strict";\` prologue in front of a block whose body completes empty
 * (\`eval("var x = 1")\`) would surface the STRING "use strict" as the eval's
 * result. Seeding V with \`undefined\` first restores the correct answer. The
 * sloppy form needs no such guard: WithStatement is specified to
 * UpdateEmpty(C, undefined) on its own.
 */
function qjsWrapDirectEvalSource(source: string, preamble: string, callerStrict: boolean): string {
  if (callerStrict) {
    return '"use strict";\\nundefined;\\n{\\n' + preamble + source + "\\n}";
  }
  return "with (" + ${j(QUICKJS_SCOPE_GLOBAL)} + ") {\\n" + source + "\\n}";
}

export function __runtime_direct_eval(
  source: any,
  globalObject: any,
  thisArg: any,
  activationState: any,
  activationSeedNames: any,
  activationSeedSlots: any,
  lexicalNames: any,
  lexicalSlots: any,
  outerNames: any,
  outerSlots: any,
  callerStrict: boolean,
  mappedParamNames: any
): any {
  // PerformEval step 2: a non-string argument is returned unchanged.
  if (typeof source !== "string") return runtimeEvalResult(true, source);
  const c: number = qjsEnsureContext();
  if (c === 0) return runtimeEvalResult(false, new TypeError(${j(QUICKJS_INIT_REFUSAL)}));
  if (!qjsEnsureDirectHelpers(c)) {
    return runtimeEvalResult(false, new TypeError(${j(QUICKJS_INIT_REFUSAL)}));
  }

  // Outermost first: a later qjsAppendBinding for the same name replaces the
  // cell, so the innermost layer wins — the env-record chain, flattened.
  const names: string[] = [];
  const cells: any[] = [];
  qjsCollectLayer(outerNames, outerSlots, names, cells);
  qjsCollectLayer(activationSeedNames, activationSeedSlots, names, cells);
  qjsCollectPool(activationState, names, cells);
  qjsCollectLayer(lexicalNames, lexicalSlots, names, cells);

  qjsPushGlobals(c, globalObject);
  qjsPushGlobalLexicalCells(c, globalObject);

  const scope: number = qjsCallGlobalHelper(c, "__js2wasm_eval_mkobj__", 0, 0);
  if (scope === 0) return runtimeEvalResult(false, new TypeError(${j(QUICKJS_INIT_REFUSAL)}));

  // Snapshot. A non-primitive binding is still DEFINED on S, as \`undefined\`:
  // shadowing the caller's name is closer to its real scope shape than letting
  // the lookup fall through to a same-named realm global. It is not written
  // back — residual bucket 5, re-derived cheaply at write-back time from the
  // cell's still-unchanged value rather than carried in a parallel array.
  let preamble: string = "";
  for (let i = 0; i < names.length; i += 1) {
    const name: string = names[i] as string;
    const cell: EvalBindingCell = cells[i] as EvalBindingCell;
    const value: any = __runtime_eval_unwrap_result(cell.value);
    const primitive: boolean = qjsIsMirrorablePrimitive(value);
    const namePtr: number = qjsPushCString(name);
    if (namePtr !== 0) {
      qjsPushRefusal = "";
      const h: number = primitive ? qjsToQuickjs(c, value) : qjs_new_undefined();
      if (qjsPushRefusal === "") qjs_set_prop_str(c, scope, namePtr, h);
      qjs_free_value(c, h);
      qjs_free_raw(namePtr);
    }
    if (callerStrict && qjsIsSafeConstName(name) && qjsSourceMentions(source as string, name)) {
      preamble = preamble + "const " + name + " = " + ${j(QUICKJS_SCOPE_GLOBAL)} + "." + name + ";\\n";
    }
  }
  qjsPushRefusal = "";

  const g0: number = qjs_global_object(c);
  const scopeNamePtr: number = qjsPushCString(${j(QUICKJS_SCOPE_GLOBAL)});
  if (scopeNamePtr !== 0) {
    qjs_set_prop_str(c, g0, scopeNamePtr, scope);
    qjs_free_raw(scopeNamePtr);
  }
  qjs_free_value(c, g0);

  // A sloppy eval may create vars; capture the realm's binding set first so the
  // diff afterwards names exactly what it added.
  let preNames: number = 0;
  if (!callerStrict) preNames = qjsCallGlobalHelper(c, "__js2wasm_eval_prenames__", 0, 0);

  const wrapped: string = qjsWrapDirectEvalSource(source as string, preamble, callerStrict);
  const buf: number = qjsPushUtf8(wrapped);
  let result: any = undefined;
  if (buf === 0) {
    result = runtimeEvalResult(false, new TypeError(${j(QUICKJS_INIT_REFUSAL)}));
  } else {
    const byteLen: number = qjsUtf8Len;
    const handle: number = qjs_eval(c, buf, byteLen);
    qjs_free_raw(buf);
    if (handle === 0) {
      result = runtimeEvalResult(false, new TypeError(${j(QUICKJS_INIT_REFUSAL)}));
    } else if (qjs_is_exception(handle) !== 0) {
      qjs_free_value(c, handle);
      result = qjsThrewResult(c);
    } else {
      qjsPullRefusal = "";
      const value: any = qjsToGc(c, handle);
      qjs_free_value(c, handle);
      if (qjsPullRefusal !== "") {
        const refusal: string = qjsPullRefusal;
        qjsPullRefusal = "";
        result = runtimeEvalResult(false, new TypeError(refusal));
      } else {
        result = runtimeEvalResult(true, value);
      }
    }
  }

  // Write-back runs on the THROW path too: a partially executed eval may have
  // already updated caller bindings, and the interpreter exposes them likewise.
  if (!callerStrict) {
    qjsWriteBackCallerCells(c, scope, names, cells);
    qjsMirrorNewBindings(c, activationState, names, preNames);
  }
  if (preNames !== 0) qjs_free_value(c, preNames);
  qjs_free_value(c, scope);
  qjsPullGlobalLexicalCells(c, globalObject);
  qjsPullGlobals(c, globalObject);
  return result;
}

/**
 * Copy the snapshotted primitives out of S and into the LIVE caller cells.
 *
 * Both filters — \`qjsIsMirrorablePrimitive\` on the compiled side, the tag test
 * on the QuickJS side — are the same primitives-only discipline qjsPullGlobals
 * needs: a foreign object written into a shared carrier does not break the
 * current entry, it breaks a LATER one, which reads as a flake rather than a
 * bug. A binding whose PRE-eval value was not a primitive was never snapshotted
 * (S holds \`undefined\` for it), so it is skipped; nothing has touched the cell
 * yet, which is why re-deriving the test here is equivalent to remembering it.
 */
function qjsWriteBackCallerCells(c: number, scope: number, names: string[], cells: any[]): void {
  for (let i = 0; i < names.length; i += 1) {
    const cell: EvalBindingCell = cells[i] as EvalBindingCell;
    if (!qjsIsMirrorablePrimitive(__runtime_eval_unwrap_result(cell.value))) continue;
    const namePtr: number = qjsPushCString(names[i] as string);
    if (namePtr === 0) continue;
    const h: number = qjs_get_prop_str(c, scope, namePtr);
    qjs_free_raw(namePtr);
    if (h === 0) continue;
    if (qjsIsMirrorableTag(qjs_tag(h))) {
      qjsPullRefusal = "";
      const value: any = qjsToGc(c, h);
      if (qjsPullRefusal === "") cell.value = __runtime_eval_wrap_result(value);
    }
    qjs_free_value(c, h);
  }
  qjsPullRefusal = "";
}

/**
 * Mirror the bindings a sloppy eval CREATED into the activation state pool.
 *
 * \`with (S) { var n = 1 }\` hoists \`n\` onto the QuickJS realm (the with-object
 * only intercepts the assignment), so the realm diff is what names them. A
 * primitive is moved into a pool vacancy — nameCell/valueCell, the interpreter's
 * own slot discipline — and then DELETED from the realm, because it is a
 * function-scoped binding that must not survive as a global for the next eval.
 * A non-primitive (an eval-declared function, typically) has no pool
 * representation and is left on the realm, where evaluated code can still reach
 * it; that is residual bucket 2.
 */
function qjsMirrorNewBindings(c: number, pool: any, callerNames: string[], preNames: number): void {
  if (preNames === 0 || pool === undefined || pool === null) return;
  const listHandle: number = qjsCallGlobalHelper(c, "__js2wasm_eval_newnames__", 1, preNames);
  if (listHandle === 0) return;
  const joined: string = qjsReadString(c, listHandle);
  qjs_free_value(c, listHandle);
  const fresh: string[] = [];
  qjsSplitJoined(joined, fresh);
  const freshCount: number = fresh.length;
  // Names an EARLIER activation created are candidates again: their realm
  // property survived (non-configurable), so a redeclaration here is invisible
  // to the diff. Only a non-undefined realm value claims a slot, so a name this
  // activation never mentioned costs nothing.
  for (let i = 0; i < qjsCreatedNames.length; i += 1) {
    let known: boolean = false;
    for (let k = 0; k < fresh.length; k += 1) {
      if (fresh[k] === qjsCreatedNames[i]) {
        known = true;
        break;
      }
    }
    if (!known) fresh.push(qjsCreatedNames[i] as string);
  }
  const g: number = qjs_global_object(c);
  for (let i = 0; i < fresh.length; i += 1) {
    const name: string = fresh[i] as string;
    const isFresh: boolean = i < freshCount;
    // A name the caller already binds is NOT new: \`var x\` under \`with (S)\`
    // hoists a same-named realm global whose value the with-object shadowed.
    // Mirroring it would shadow the real binding on the next entry.
    let shadowsCaller: boolean = false;
    for (let k = 0; k < callerNames.length; k += 1) {
      if (callerNames[k] === name) {
        shadowsCaller = true;
        break;
      }
    }
    const namePtr: number = qjsPushCString(name);
    if (namePtr === 0) continue;
    let claimed: boolean = false;
    if (!shadowsCaller) {
      const h: number = qjs_get_prop_str(c, g, namePtr);
      if (h !== 0) {
        const tag: number = qjs_tag(h);
        const worthClaiming: boolean = isFresh || tag !== QJS_TAG_UNDEFINED;
        if (worthClaiming && qjsIsMirrorableTag(tag)) {
          qjsPullRefusal = "";
          const value: any = qjsToGc(c, h);
          if (qjsPullRefusal === "") claimed = qjsClaimPoolSlot(pool, name, value);
        }
        qjs_free_value(c, h);
      }
    }
    qjs_free_raw(namePtr);
    if (claimed) qjsRememberCreatedName(name);
    if (claimed || shadowsCaller) {
      qjsPushRefusal = "";
      const arg: number = qjsToQuickjs(c, name);
      if (qjsPushRefusal === "") {
        const dropped: number = qjsCallGlobalHelper(c, "__js2wasm_eval_del__", 1, arg);
        if (dropped !== 0) qjs_free_value(c, dropped);
      }
      qjs_free_value(c, arg);
    }
  }
  qjsPushRefusal = "";
  qjsPullRefusal = "";
  qjs_free_value(c, g);
}

function qjsRememberCreatedName(name: string): void {
  for (let i = 0; i < qjsCreatedNames.length; i += 1) {
    if (qjsCreatedNames[i] === name) return;
  }
  qjsCreatedNames.push(name);
}

/** Take (or update) the pool pair for \`name\`. False when the pool is full —
 *  the binding is then simply not persisted, never silently mis-slotted. */
function qjsClaimPoolSlot(pool: any, name: string, value: any): boolean {
  let vacancy: number = -1;
  for (let i = 0; i + 1 < (pool.length as number); i += 2) {
    const nameCell: EvalBindingCell = pool[i] as EvalBindingCell;
    if (nameCell === undefined || nameCell === null) continue;
    const held: any = __runtime_eval_unwrap_result(nameCell.value);
    if (held === name) {
      const valueCell: EvalBindingCell = pool[i + 1] as EvalBindingCell;
      valueCell.value = __runtime_eval_wrap_result(value);
      return true;
    }
    if (vacancy < 0 && (held === undefined || held === null)) vacancy = i;
  }
  if (vacancy < 0) return false;
  const nameCell: EvalBindingCell = pool[vacancy] as EvalBindingCell;
  const valueCell: EvalBindingCell = pool[vacancy + 1] as EvalBindingCell;
  nameCell.value = __runtime_eval_wrap_result(name);
  valueCell.value = __runtime_eval_wrap_result(value);
  return true;
}

export function __runtime_apply_interpreted(
  callable: any,
  receiver: any,
  argc: number,
  a0: any,
  a1: any,
  a2: any,
  a3: any,
  a4: any,
  a5: any,
  a6: any,
  a7: any
): any {
  const args: any[] = [];
  if (argc > 0) args.push(__runtime_eval_unwrap_result(a0));
  if (argc > 1) args.push(__runtime_eval_unwrap_result(a1));
  if (argc > 2) args.push(__runtime_eval_unwrap_result(a2));
  if (argc > 3) args.push(__runtime_eval_unwrap_result(a3));
  if (argc > 4) args.push(__runtime_eval_unwrap_result(a4));
  if (argc > 5) args.push(__runtime_eval_unwrap_result(a5));
  if (argc > 6) args.push(__runtime_eval_unwrap_result(a6));
  if (argc > 7) args.push(__runtime_eval_unwrap_result(a7));

  const target: any = __runtime_eval_unwrap_interpreted_callback(callable);
  // The two memoized intrinsic markers re-enter the engine rather than calling
  // a QuickJS handle: they stand for %eval% / %Function% themselves.
  if (target === qjsEvalTarget) {
    return __runtime_indirect_eval(args.length > 0 ? args[0] : undefined, qjsIntrinsicRealm);
  }
  if (target === qjsFunctionTarget) {
    let params: string = "";
    for (let i = 0; i + 1 < args.length; i += 1) {
      if (i > 0) params = params + ",";
      params = params + String(args[i]);
    }
    const body: string = args.length > 0 ? String(args[args.length - 1]) : "";
    return __runtime_new_function(params, body, qjsIntrinsicRealm);
  }

  const c: number = qjsEnsureContext();
  if (c === 0) return runtimeEvalResult(false, new TypeError(${j(QUICKJS_INIT_REFUSAL)}));
  const fnHandle: number = qjsHandleOf(callable);
  if (fnHandle === 0) return runtimeEvalResult(false, new TypeError(${j(QUICKJS_APPLY_FOREIGN_REFUSAL)}));

  qjsPushRefusal = "";
  const thisHandle: number = qjsToQuickjs(c, __runtime_eval_unwrap_result(receiver));
  const argvPtr: number = args.length > 0 ? qjs_malloc_raw(args.length * 4) : 0;
  const argHandles: number[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const h: number = qjsToQuickjs(c, args[i]);
    argHandles.push(h);
    if (argvPtr !== 0) store32(argvPtr + i * 4, h);
  }
  let result: any = undefined;
  if (qjsPushRefusal !== "" || (args.length > 0 && argvPtr === 0)) {
    const refusal: string = qjsPushRefusal !== "" ? qjsPushRefusal : ${j(QUICKJS_INIT_REFUSAL)};
    result = runtimeEvalResult(false, new TypeError(refusal));
  } else {
    const ret: number = qjs_call(c, fnHandle, thisHandle, args.length, argvPtr);
    if (ret === 0) {
      result = runtimeEvalResult(false, new TypeError(${j(QUICKJS_INIT_REFUSAL)}));
    } else if (qjs_is_exception(ret) !== 0) {
      qjs_free_value(c, ret);
      result = qjsThrewResult(c);
    } else {
      qjsPullRefusal = "";
      const value: any = qjsToGc(c, ret);
      qjs_free_value(c, ret);
      if (qjsPullRefusal !== "") {
        const refusal: string = qjsPullRefusal;
        qjsPullRefusal = "";
        result = runtimeEvalResult(false, new TypeError(refusal));
      } else {
        result = runtimeEvalResult(true, value);
      }
    }
  }
  // Borrow-in/own-out: every handle minted above is released exactly once, on
  // the success path AND on every refusal path.
  for (let i = 0; i < argHandles.length; i += 1) qjs_free_value(c, argHandles[i] as number);
  if (argvPtr !== 0) qjs_free_raw(argvPtr);
  qjs_free_value(c, thisHandle);
  qjsPushRefusal = "";
  return result;
}
`;
}

/**
 * Cross-module positive control (the refusal provider's discipline): a tiny
 * standalone USER module that takes the dynamic routes through the real seam
 * and reports what came back.
 *
 * Two anti-vacuity properties, both learned the hard way while writing this:
 *
 * 1. The eval SOURCE must be composed from a runtime binding. An all-literal
 *    argument is constant-folded and then handled by `tryStaticEvalInline` at
 *    COMPILE time — the module still carries the provider import, still links,
 *    still "passes", and never once calls QuickJS.
 * 2. The expected value must be one only QuickJS could produce. `40 + 2` is
 *    not: any evaluator answers 42. So the number probe evaluates a source
 *    whose result depends on the in-band engine-identity global this adapter
 *    installs on the QuickJS realm — 42 iff QuickJS really ran it.
 */
export const QUICKJS_ADAPTER_CANARY_SOURCE = `
      var identityName = ${JSON.stringify(QUICKJS_ENGINE_IDENTITY_GLOBAL)};
      // Anti-vacuity: an eval argument that is a compile-time constant is
      // constant-folded and then evaluated AT COMPILE TIME by
      // tryStaticEvalInline — the module still imports the provider, still
      // links, still "passes", and never calls QuickJS. Composing every source
      // through this runtime loop defeats the fold. Measured, not theoretical:
      // a literal 'ab' + 'cde' canary went on passing while the real dynamic
      // string path was broken.
      function joinSource(parts: string[]): string {
        var out = "";
        for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
        return out;
      }
      var evalNumber = 0;
      var engineIdentity = 0;
      var stringRoundTrip = 0;
      var newFunctionValue = 0;
      var errorFidelity = 0;
      try {
        evalNumber = (0, eval)(
          "typeof " + identityName + " === 'string' ? 40 + 2 : 0"
        ) as number;
      } catch (err) {
        evalNumber = -1;
      }
      try {
        engineIdentity = (0, eval)(
          identityName + ".length"
        ) as number;
      } catch (err) {
        engineIdentity = -1;
      }
      try {
        // A STRING completion value that has to be transcoded back out of the
        // QuickJS heap, then measured on the compiled side.
        var text = (0, eval)(joinSource(["'ab' + ", "'cde'"])) as string;
        stringRoundTrip = text.length * 10 + (text.charCodeAt(4) as number);
      } catch (err) {
        stringRoundTrip = -1;
      }
      try {
        var made: any = new Function("a", "b", joinSource(["return a + b", " + 1"]));
        newFunctionValue = made(20, 21) as number;
      } catch (err) {
        newFunctionValue = -1;
      }
      try {
        (0, eval)(joinSource(["throw new RangeError(", "'probe-msg')"]));
        errorFidelity = -2;
      } catch (err) {
        errorFidelity =
          (err instanceof RangeError ? 100 : 0) +
          ((err as any).message === "probe-msg" ? 10 : 0) +
          ((err as any).name === "RangeError" ? 1 : 0);
      }
      // Slice 3, STRICT arm: this module carries a top-level \`export\`, so it is
      // module code and every function in it is strict — the block-scoped
      // \`const\` preamble is what runs here. The sloppy \`with (S)\` arm needs a
      // second compile (QUICKJS_DIRECT_CANARY_SOURCE below).
      var strictDirect = 0;
      function strictDirectCaller(): number {
        var localX = 20;
        try {
          var sum: any = eval(joinSource(["localX + ", "22"]));
          // The second entry is the load-bearing one: a preamble emitted at
          // GLOBAL scope would make it a redeclaration SyntaxError.
          var again: any = eval(joinSource(["localX + ", "22"]));
          return (sum as number) === 42 && (again as number) === 42 ? 42 : -3;
        } catch (err) {
          return -2;
        }
      }
      strictDirect = strictDirectCaller();

      export function evalNumberProbe(): number { return evalNumber; }
      export function engineIdentityProbe(): number { return engineIdentity; }
      export function stringRoundTripProbe(): number { return stringRoundTrip; }
      export function newFunctionProbe(): number { return newFunctionValue; }
      export function errorFidelityProbe(): number { return errorFidelity; }
      export function strictDirectProbe(): number { return strictDirect; }
    `;

/** Expected canary readings — one per capability slices 2–3 add. */
export const QUICKJS_ADAPTER_CANARY_EXPECTATIONS = Object.freeze([
  { probe: "evalNumberProbe", expected: 42, why: "the number completion value did not round-trip through QuickJS" },
  { probe: "engineIdentityProbe", expected: 7, why: "evaluated code cannot see the in-band engine marker" },
  // 'abcde'.length * 10 + 'e'.charCodeAt(0) === 50 + 101.
  { probe: "stringRoundTripProbe", expected: 151, why: "a STRING completion value did not round-trip ('abcde')" },
  { probe: "newFunctionProbe", expected: 42, why: "new Function + apply through the seam did not produce 20+21+1" },
  { probe: "errorFidelityProbe", expected: 111, why: "a thrown error lost its constructor, message or name" },
  {
    probe: "strictDirectProbe",
    expected: 42,
    why: "a STRICT caller's direct eval did not read its live bindings twice (const-preamble arm)",
  },
]);

/**
 * The SLOPPY direct-eval arm (`with (S) { … }`), which needs a SECOND compile
 * with `inferModuleStrictArguments: false`.
 *
 * Without that option TypeScript flags any source carrying a top-level `export`
 * as a module, module code is strict, and the `with` arm is unreachable — the
 * canary would silently verify only half the tier. The test262 runner passes
 * the same option for script-goal tests, which is exactly where the sloppy arm
 * has to work.
 */
export const QUICKJS_DIRECT_CANARY_SOURCE = `
      function joinSource(parts: string[]): string {
        var out = "";
        for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
        return out;
      }
      // Read a caller local, WRITE it back through the live cell, and prove an
      // eval-created var persists into the next entry of the same activation.
      var sloppyDirect = 0;
      function sloppyDirectCaller(): number {
        var localX = 7;
        try {
          var read: any = eval(joinSource(["localX + ", "1"]));
          eval(joinSource(["localX = localX + ", "34"]));
          eval(joinSource(["var carried", "Var = 100;"]));
          var carried: any = eval(joinSource(["carriedVar + ", "1"]));
          if ((read as number) !== 8) return -3;
          if (localX !== 41) return -4;
          if ((carried as number) !== 101) return -5;
          return 42;
        } catch (err) {
          return -2;
        }
      }
      sloppyDirect = sloppyDirectCaller();
      export function sloppyDirectProbe(): number { return sloppyDirect; }
    `;

/** Expected readings for the sloppy-arm canary compile. */
export const QUICKJS_DIRECT_CANARY_EXPECTATIONS = Object.freeze([
  {
    probe: "sloppyDirectProbe",
    expected: 42,
    why:
      "a SLOPPY caller's direct eval did not read/write its live binding cells, or an eval-created " +
      "var did not persist in the activation state pool (with-arm)",
  },
]);

// -------------------------------------------------------------- link/select --

/**
 * Link the 2-module bundle and return the `js2wasm:runtime-eval` namespace.
 *
 * The ONLY JavaScript here is the WASI stub (`wasi-stub.mjs`) and the plumbing
 * that hands one instance's exports to the other's imports — the adapter's
 * `qjs_*` imports are bound to `libquickjs.wasm`'s exported functions DIRECTLY
 * (the same function objects, no wrapper closures), which is what makes the
 * i32/f64 signature match load-bearing rather than cosmetic.
 *
 * Both modules are instantiated FRESH per call: a QuickJS context accumulates
 * global state, so the per-test isolation the interpreter tier needs applies
 * doubly here.
 */
export function instantiateQuickjsEvalNamespace(bundle) {
  let qjs;
  const stub = makeWasiStub(() => qjs.exports.memory);
  qjs = new WebAssembly.Instance(bundle.quickjsModule, {
    wasi_snapshot_preview1: stub.wasi_snapshot_preview1,
  });
  // Reactor model: no `_start`, one `_initialize` the peer/host calls once.
  qjs.exports._initialize?.();
  // `qjs.exports` carries BOTH the shared memory and every `qjs_*` function, so
  // it is exactly the `js2wasm:qjs` namespace the adapter declared.
  const adapter = new WebAssembly.Instance(bundle.adapterModule, {
    [QUICKJS_IMPORT_MODULE]: qjs.exports,
  });
  return {
    __runtime_new_function: adapter.exports.__runtime_new_function,
    __runtime_indirect_eval: adapter.exports.__runtime_indirect_eval,
    __runtime_direct_eval: adapter.exports.__runtime_direct_eval,
    __runtime_apply_interpreted: adapter.exports.__runtime_apply_interpreted,
  };
}

/**
 * Load the cached quickjs bundle. The selector NEVER builds (the worker-pool
 * 30s rule) and NEVER silently degrades to the interpreter: the flag is an
 * explicit opt-in, so a silent fallback would invalidate every measurement made
 * under it. A miss is a hard error naming the prebuild command.
 *
 * @param cacheDir shared provider cache dir (`.test262-cache`)
 * @param bundleHash compiler-bundle hash, folded into the adapter cache key
 */
export function selectQuickjsEvalProvider(cacheDir, bundleHash, cacheKeyOf) {
  const akey = quickjsArtifactCacheKey();
  const artifactDir = process.env.JS2WASM_QUICKJS_ARTIFACT_DIR
    ? resolve(REPO_ROOT, process.env.JS2WASM_QUICKJS_ARTIFACT_DIR)
    : quickjsArtifactCacheDir(cacheDir, akey);
  const artifact = readQuickjsArtifact(artifactDir);
  if (!artifact) {
    throw new Error(
      `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built ` +
        `(missing ${join(artifactDir, "libquickjs.wasm")}). Run: ` +
        `node scripts/build-quickjs-eval-provider.mjs ` +
        `(or set JS2WASM_QUICKJS_ARTIFACT_DIR to a prebuilt artifact dir)`,
    );
  }
  const adapterSource = buildQuickjsAdapterSource(artifact.abi);
  const key = cacheKeyOf(adapterSource, bundleHash);
  const adapterPath = quickjsAdapterCachePath(cacheDir, key);
  if (!existsSync(adapterPath)) {
    throw new Error(
      `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built ` +
        `(missing ${adapterPath}). Run: node scripts/build-quickjs-eval-provider.mjs ` +
        `(or set JS2WASM_QUICKJS_ARTIFACT_DIR to a prebuilt artifact dir)`,
    );
  }
  return {
    bundle: {
      engine: "quickjs",
      adapterModule: new WebAssembly.Module(readFileSync(adapterPath)),
      quickjsModule: assertQuickjsArtifactExports(artifact.binary),
      adapterKey: key,
      artifactKey: akey,
      artifactSha256: artifact.sha256,
      artifactDir: artifact.dir,
    },
    engine: "quickjs",
    message:
      `QUICKJS (artifact ${artifact.sha256.slice(0, 12)}, adapter key ${key}) — flag-gated engine ` +
      `(#4238), NOT CI-comparable with the interpreter tier; TEST262_FULL_RUNTIME_EVAL is ignored ` +
      `under this engine`,
  };
}
