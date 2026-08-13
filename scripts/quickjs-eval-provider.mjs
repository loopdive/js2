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
  // (#4308 slice B) The EDI declared-names probe runs in a THROWAWAY context so
  // the sentinel-abort hoist cannot pollute the caller's realm. Freeing it is
  // what keeps that per-eval context from being a leak; the shim has always
  // exported this, so listing it moves no artifact bytes.
  "qjs_free_context",
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
  // #4245 slice 1 — inward membrane. `qjs_set_membrane_callbacks` is called by
  // the LINK step (below), not imported by the adapter; it is listed here so
  // `assertQuickjsArtifactExports` fails loudly on a stale artifact instead of
  // surfacing as a bare `undefined is not a function` at link time.
  "qjs_new_wrapper",
  "qjs_wrapper_gc_handle",
  "qjs_set_membrane_callbacks",
]);

/**
 * Adapter exports wired into the artifact's `__indirect_function_table` at link
 * time, IN THIS ORDER (the order is the ABI — `qjs_set_membrane_callbacks`
 * takes the slot indices positionally). All-i32 signatures; see the membrane
 * section of qjs_shim.c for the per-callback contract.
 */
export const QUICKJS_MEMBRANE_CALLBACKS = Object.freeze([
  "__membrane_get",
  "__membrane_set",
  "__membrane_has",
  "__membrane_delete",
  "__membrane_call",
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
 * (#4308 slices C/D) The user's source is HANDED to the realm's own `eval`
 * through this slot instead of being spliced into the wrapper text. That one
 * change is what makes the engine — not the wrapper — decide EDI: a top-level
 * function declaration stays top-level (a `{ … }` wrapper demotes it to an
 * annex-B BLOCK declaration), lexical declarations get eval's own fresh
 * declarative environment instead of leaking into the realm, and a `"use
 * strict"` directive in the source is a real directive again.
 */
export const QUICKJS_SOURCE_GLOBAL = "__js2wasm_eval_src__";
/** A private handle to the realm's own %eval%, captured once per context so a
 *  mirrored compiled global can never redirect the indirect route. */
export const QUICKJS_INDIRECT_EVAL_GLOBAL = "__js2wasm_eval_indirect__";
/**
 * (#4308 slice C) Routing sentinel emitted by the caller as one extra
 * activation-seed entry at every FUNCTION-scoped direct-eval call site.
 * Without it a declaration-free ARROW caller is indistinguishable from global
 * code at the seam (probe P4: arrows have no `arguments`, so all three binding
 * layers are empty for them too) and its eval-created `var`s would be created
 * on the GLOBAL object instead of the arrow's own varEnv. It is a signal, not
 * a binding: `qjsAppendBinding` drops it. Keep byte-for-byte aligned with
 * `RUNTIME_EVAL_NON_GLOBAL_SENTINEL` in
 * src/codegen/expressions/runtime-eval-provider.ts.
 */
export const RUNTIME_EVAL_NON_GLOBAL_SENTINEL = "__js2wasm_eval_nonglobal__";

/**
 * Opaque companion name carried beside every deletable eval-created binding
 * in the caller-owned activation state pool. One source-visible entry and its
 * adjacent marker consume four pool cells total:
 *   [visibleNameCell, visibleValueCell, markerNameCell, markerValueCell]
 *
 * The marker is metadata, never a binding. Keep this exact (including the
 * leading NUL) with DELETABLE_EVAL_BINDINGS_MARKER in
 * src/interp/eval-environment.ts. The provider cannot import that module: this
 * value is baked into the separately compiled adapter source.
 */
const RUNTIME_EVAL_DELETABLE_BINDING_MARKER = "\0js2wasm:deletable-eval-binding";

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
  // The membrane's trap edge needs the artifact's own function table exported
  // and growable (#4245); an artifact built before that link-flag change has
  // every qjs_* wrapper and still cannot carry a single trap.
  const missing = [...QUICKJS_ADAPTER_EXTERNS, "__indirect_function_table"].filter((name) => !present.has(name));
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
declare function qjs_free_context(ctx: i32): void;
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
declare function qjs_new_wrapper(ctx: i32, gcId: i32, callable: i32): i32;
declare function qjs_wrapper_gc_handle(h: i32): i32;

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

// (#4308 slice B) The RUNTIME behind that context, kept so the EDI probe can
// mint a scratch context in the same runtime (\`qjs_new_context(rt)\`) and free
// it again. Nothing else may use it.
var qjsRuntimeHandle: number = 0;

// Direct eval's realm-side helpers are installed on first use, not at context
// init: a module that never takes the direct route should not pay an eval.
var qjsDirectHelpersReady: boolean = false;

// Every name a sloppy direct eval has ever created on the QuickJS realm. A
// \`var\` there is NON-CONFIGURABLE, so once mirrored into an activation's pool
// it is only blanked to \`undefined\`, not deleted — and then a LATER activation
// that redeclares it would not show up in the realm diff. Remembering the names
// keeps them mirrorable for the rest of the context's life.
var qjsCreatedNames: string[] = [];

// (#4308 slice C) How many eval-created bindings the 64-slot activation pool
// had no room for. Republished into the realm on every drop so the accepted
// ceiling is diagnosable rather than silent.
var qjsPoolOverflowCount: number = 0;

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
//
// (#4308 slice A) The registry ALSO carries seven pre-seeded pairs that are not
// "published" values at all: the realm's intrinsic error constructors mapped
// onto the caller's compiled ones, installed by
// \`qjsSeedIntrinsicErrorIdentities\` on the first globals push (NOT at context
// creation — the caller's realm is not in hand until then). They ride here
// because the identity question is exactly the one this table answers, in both
// directions.

var qjsBoxHandles: number[] = [];
var qjsBoxTargets: any[] = [];
var qjsBoxExposed: any[] = [];

// (#4245 slice 2 — the OUTWARD live view) Three columns parallel to the three
// above, carried only by the entries this slice mirrors:
//
//   qjsBoxMirror[i]  1 = a mirrored data box (a plain QuickJS object crossing
//                    out), 0 = anything else — the two identity SEEDS (the realm
//                    carrier, the eight error constructors) and the callable
//                    boxes, none of which may be rewritten by the sync.
//   qjsBoxKeyList[i] the own STRING keys currently mirrored, in QuickJS order.
//   qjsBoxLast[i]    the value each of those keys last held on BOTH sides. It is
//                    what makes the sync bidirectional without an intercept:
//                    a compiled-side write is exactly \`box[k] !== last[k]\`.
var qjsBoxMirror: number[] = [];
var qjsBoxKeyList: any[] = [];
var qjsBoxLast: any[] = [];

/** Append one non-mirrored registry row (identity seeds, callable boxes). */
function qjsPushBoxRow(handle: number, target: any, exposed: any, mirror: number): void {
  qjsBoxHandles.push(handle);
  qjsBoxTargets.push(target);
  qjsBoxExposed.push(exposed);
  qjsBoxMirror.push(mirror);
  qjsBoxKeyList.push(undefined);
  qjsBoxLast.push(undefined);
}

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

// The two memoized intrinsic TARGETS (\`%eval%\` / \`%Function%\`). Declared here
// rather than next to their wrappers below because the membrane's
// wrappability test must exclude them, and a \`const\` cannot be read before its
// own initializer runs.
const qjsEvalTarget: any = { __qjs_intrinsic__: 1 };
const qjsFunctionTarget: any = { __qjs_intrinsic__: 2 };

// ------------------------------------------------ membrane, inward (#4245) --
// A compiled GC object/function crossing INTO evaluated code becomes a QuickJS
// exotic wrapper whose property traps call the five \`__membrane_*\` exports
// below. Slice 1 covers plain data properties (get/set/has/delete) plus CALLS;
// enumeration, the outward live view and the lifetime protocol are slices 2-3.
//
// The pin registry is a plain array + linear scan, deliberately: the population
// is the handful of realm bindings and seam arguments that actually cross, and
// identity is compiled-object reference identity, which \`===\` answers directly
// (the same reason the handle registry above scans). Entries are RETAINED for
// the instance lifetime — slice 3 replaces that with the finalizer-driven
// release protocol.

var gcRegistry: any[] = [];

/** Registry id for \`value\`, or -1 when it has never crossed. */
function qjsGcIdOf(value: any): number {
  for (let i = 0; i < gcRegistry.length; i += 1) {
    if (gcRegistry[i] === value) return i;
  }
  return -1;
}

/**
 * Pin \`value\` and return an OWNED handle to its QuickJS wrapper. The same
 * compiled object always yields the same wrapper within a context (the shim
 * dedups by registry id), which is what makes \`g === h\` hold across separate
 * evaluations when both names mirror one GC object.
 */
function qjsWrapOutbound(c: number, value: any): number {
  let id: number = qjsGcIdOf(value);
  if (id < 0) {
    id = gcRegistry.length;
    gcRegistry.push(value);
  }
  // The shared closure classifier includes the cross-module AOT callable
  // carrier, so a compiled function pushed through the seam answers "function"
  // here and gets the class whose \`call\` routes back into compiled code.
  const callable: number = typeof value === "function" ? 1 : 0;
  return qjs_new_wrapper(c, id, callable);
}

/**
 * Is \`value\` something the membrane may wrap? Objects and functions are, with
 * two exclusions that are load-bearing rather than defensive:
 *  - the memoized \`eval\`/\`Function\` intrinsic markers must stay QuickJS's own
 *    natives on the QuickJS realm. Mirroring them as wrappers would route
 *    evaluated code's \`eval(...)\` back out into the compiled marker and re-enter
 *    this provider mid-evaluation.
 *  - a value that is already one of OUR QuickJS boxes: \`qjsToQuickjs\` collapses
 *    it to the retained handle before it ever reaches the wrapper arm, so it
 *    must not be pinned as a fresh compiled object.
 */
function qjsIsMembraneWrappable(value: any): boolean {
  if (value === undefined || value === null) return false;
  const t: string = typeof value;
  if (t !== "object" && t !== "function") return false;
  const target: any = __runtime_eval_unwrap_interpreted_callback(value);
  if (target === qjsEvalTarget || target === qjsFunctionTarget) return false;
  return true;
}

/** Compiled object behind registry id \`gc\`, or undefined for a stale id. */
function qjsRegistryTarget(gc: number): any {
  if (gc < 0 || gc >= gcRegistry.length) return undefined;
  return gcRegistry[gc];
}

/**
 * Read \`target[key]\` and hand the value to QuickJS. Returns an OWNED handle;
 * 0 means "answer undefined" (absent, stale id, or an unrepresentable value).
 *
 * The refusal globals are saved/restored around every membrane entry: a trap
 * runs INSIDE \`qjs_eval\`/\`qjs_call\`, i.e. in the middle of a conversion the
 * outer entry point is still holding, and clobbering them there would surface
 * as a refusal on an unrelated value.
 */
export function __membrane_get(gc: i32, keyPtr: i32, keyLen: i32): i32 {
  const c: number = qjsContextHandle;
  const target: any = qjsRegistryTarget(gc);
  if (c === 0 || target === undefined || target === null) return 0;
  const key: string = qjsReadUtf8(keyPtr, keyLen);
  const value: any = target[key];
  const saved: string = qjsPushRefusal;
  qjsPushRefusal = "";
  const h: number = qjsToQuickjs(c, value);
  const refused: boolean = qjsPushRefusal !== "";
  qjsPushRefusal = saved;
  if (refused) {
    if (h !== 0) qjs_free_value(c, h);
    return 0;
  }
  return h;
}

/** Write \`h\` into \`target[key]\` through the compiled object's own dynamic
 *  setter path (so user accessors run). 1 ok, 0 refused. \`h\` is BORROWED. */
export function __membrane_set(gc: i32, keyPtr: i32, keyLen: i32, h: i32): i32 {
  const c: number = qjsContextHandle;
  const target: any = qjsRegistryTarget(gc);
  if (c === 0 || target === undefined || target === null) return 0;
  const key: string = qjsReadUtf8(keyPtr, keyLen);
  const saved: string = qjsPullRefusal;
  qjsPullRefusal = "";
  const value: any = qjsToGc(c, h);
  const refused: boolean = qjsPullRefusal !== "";
  qjsPullRefusal = saved;
  if (refused) return 0;
  target[key] = value;
  return 1;
}

/** \`key in target\` — own + prototype, resolved by the compiled object runtime. */
export function __membrane_has(gc: i32, keyPtr: i32, keyLen: i32): i32 {
  const target: any = qjsRegistryTarget(gc);
  if (target === undefined || target === null) return 0;
  const key: string = qjsReadUtf8(keyPtr, keyLen);
  return key in target ? 1 : 0;
}

/** \`delete target[key]\` — 1 deleted-or-absent, 0 refused. */
export function __membrane_delete(gc: i32, keyPtr: i32, keyLen: i32): i32 {
  const target: any = qjsRegistryTarget(gc);
  if (target === undefined || target === null) return 0;
  const key: string = qjsReadUtf8(keyPtr, keyLen);
  return delete target[key] ? 1 : 0;
}

/**
 * Invoke the compiled callable behind \`gc\`. \`argvPtr\` points at \`argc\`
 * consecutive i32 handles in the shared heap, all BORROWED (the shim minted
 * them and frees them). Returns an OWNED result handle; 0 makes the shim throw
 * a TypeError inside evaluated code.
 *
 * The invocation itself is \`__runtime_eval_apply_callable\`, the private
 * intrinsic the standalone compiler lowers straight to \`__apply_closure\`
 * (#2928) — whose cross-module AOT-callable-carrier arm is exactly how a
 * separately compiled provider calls back into caller code. This is the reason
 * test262's \`assert\` / \`fnGlobalObject\` become reachable from evaluated code.
 */
export function __membrane_call(gc: i32, thisH: i32, argc: i32, argvPtr: i32): i32 {
  const c: number = qjsContextHandle;
  const fn: any = qjsRegistryTarget(gc);
  if (c === 0 || fn === undefined || fn === null) return 0;
  const savedPull: string = qjsPullRefusal;
  qjsPullRefusal = "";
  const thisValue: any = thisH === 0 ? undefined : qjsToGc(c, thisH);
  const args: any[] = [];
  for (let i = 0; i < argc; i += 1) {
    args.push(qjsToGc(c, load32(argvPtr + i * 4)));
  }
  const pullRefused: boolean = qjsPullRefusal !== "";
  qjsPullRefusal = savedPull;
  if (pullRefused) return 0;
  const ret: any = __runtime_eval_apply_callable(fn, thisValue, args);
  const savedPush: string = qjsPushRefusal;
  qjsPushRefusal = "";
  const out: number = qjsToQuickjs(c, ret);
  const pushRefused: boolean = qjsPushRefusal !== "";
  qjsPushRefusal = savedPush;
  if (pushRefused) {
    if (out !== 0) qjs_free_value(c, out);
    return 0;
  }
  return out;
}

/**
 * NEVER REACHED. The standalone compiler recognises this exact call site by
 * name and lowers it to \`__apply_closure\` before the ordinary call path runs
 * (src/codegen/expressions/calls.ts \`tryRuntimeEvalApplyCallableIntrinsic\`) —
 * the same contract src/interp/loop.ts relies on. The body exists only so the
 * module compiles; the link-time membrane canary is what proves the lowering
 * actually fired, so a silent regression to this stub cannot ship.
 */
function __runtime_eval_apply_callable(callee: any, receiver: any, args: any[]): any {
  return undefined;
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
  // #4245 slice 1 — everything else that is an object or a function crosses as
  // a LIVE membrane wrapper instead of the slice-2 typed refusal.
  if (qjsIsMembraneWrappable(value)) return qjsWrapOutbound(c, value);
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
 * becomes the #4245 slice-2 MIRRORED BOX — a real compiled \`$Object\` carrying
 * the QuickJS object's own string-keyed properties, kept in step with it by the
 * sync below. Either way the value unwraps to the SAME handle on the way back
 * in, so identity holds within the provider.
 *
 * The registry hit below is ALSO the intrinsic-error substitution (#4308 slice
 * A): the seven realm error constructors are pre-seeded to the COMPILED ones,
 * so they cross out as the caller's own \`ReferenceError\`/… rather than a box.
 */
function qjsPublish(c: number, h: number): any {
  // (#4245 slice 2) COLLAPSE first. A compiled object that crossed INWARD as a
  // membrane wrapper must come back out as the ORIGINAL GC object, never as a
  // box wrapping a wrapper: \`qjs_wrapper_gc_handle\` has been exported and
  // declared since slice 1 but had no caller on this path, so evaluated code
  // handing a compiled object back to a compiled function (\`verifyProperty(o,
  // …)\`, a callback argument) lost its identity — \`===\` failed and property
  // work landed on a stand-in. This is the second half of the identity contract
  // whose inward half slice 1 already had.
  const wrapped: number = qjs_wrapper_gc_handle(h);
  if (wrapped >= 0 && wrapped < gcRegistry.length) return gcRegistry[wrapped];
  const existing: number = qjsFindBoxIndex(c, h);
  if (existing >= 0) return qjsBoxExposed[existing];
  const retained: number = qjs_dup(c, h);
  if (qjs_is_function(c, h) !== 0) {
    // Every ordinary function object inherits its constructor identity from
    // the realm's %Function%.  The callback carrier has an explicit field for
    // that identity because the caller cannot inspect QuickJS's nominal
    // function object.  Leaving it undefined is observably wrong for every
    // new Function(...).constructor === Function check.
    if (qjsIntrinsicFunction === undefined) {
      // Materialize only %Function% here. Calling qjsIntrinsicEvalValue would
      // also install eval/Function properties on the caller realm in the middle
      // of publishing a result; a later direct-eval activation would then see
      // those newly-enumerable seam markers as ordinary caller state.
      qjsIntrinsicFunction = __runtime_eval_wrap_intrinsic_function_callback(
        qjsFunctionTarget,
        "Function",
        1
      );
    }
    const carrierTarget: any = {};
    const exposed: any = __runtime_eval_wrap_interpreted_callback(
      carrierTarget,
      qjsPropString(c, h, "name"),
      qjsPropNumber(c, h, "length"),
      qjsIntrinsicFunction
    );
    qjsPushBoxRow(retained, carrierTarget, exposed, 0);
    return exposed;
  }
  // Register BEFORE mirroring: a self-referential object (\`o.self = o\`) walks
  // straight back into qjsPublish for the same handle, and without the row in
  // place that recursion never terminates.
  const box: any = {};
  qjsPushBoxRow(retained, box, box, 1);
  qjsPullBox(c, qjsBoxHandles.length - 1);
  return box;
}

// ---------------------------------------------- outward live view (#4245 S2) --
//
// A plain QuickJS object crossing OUT is a compiled \`$Object\` whose own string
// keys mirror the QuickJS object's, refreshed in BOTH directions at every seam
// crossing (\`qjsSyncBoxesPush\` before entering QuickJS, \`qjsSyncBoxesPull\` on
// the way back). The values are real own data properties rather than traps, and
// that shape is the whole point rather than an implementation convenience:
//
//   - \`Object.getOwnPropertyNames\` / \`Object.keys\` / \`for…in\` / \`in\` /
//     \`Object.prototype.hasOwnProperty\` / \`Object.getOwnPropertyDescriptor\` all
//     answer NATIVELY and correctly, because the box is an ordinary object.
//   - A \`Proxy\` box was built and measured first and is REJECTED: \`__extern_get\`,
//     \`__extern_set\`, \`__extern_has\` and \`__getOwnPropertyNames\` do carry the
//     \`$Proxy\` front-guard (so reads, writes and ownKeys work — verified), but
//     \`__hasOwnProperty\` / \`__object_hasOwn\` do NOT: they \`ref.test $Object\`,
//     miss, and answer FALSE. test262's \`verifyProperty\` gates every descriptor
//     check behind \`__hasOwnProperty(desc, field)\`, so a Proxy box makes the
//     whole helper a silent no-op — the 48 target files would go GREEN having
//     verified nothing. Adding a \`$Proxy\` arm to \`__hasOwnProperty\` is a \`src/\`
//     change and is reported as a follow-up, not taken here.
//   - Per-key ACCESSOR properties (the plan's own fallback) were measured and
//     are also rejected: the accessor arms dispatch through
//     \`__call_accessor_get\` → \`__call_fn_method_0\`, whose only cross-module
//     front-guard is the AOT-callable CARRIER (#4197). The provider→AOT
//     interpreted-callback marker is recognised by \`__apply_closure\` alone, and
//     a raw adapter closure only lands if the CALLER module happens to carry a
//     structurally identical arity-0 closure shape. Measured: the getter
//     installs (gOPD reports an accessor) and returns null on call.
//
// Residual, stated plainly: this is live AT SEAM GRANULARITY. A QuickJS getter
// with side effects runs at sync time, not at compiled-read time, and a
// mutation made and observed strictly between two crossings is invisible.

var qjsBoxHelpersReady: boolean = false;

/** Realm-side helpers for the outward box, installed once per context. Kept in
 *  QuickJS rather than in shim C so the artifact hash does not move. */
function qjsEnsureBoxHelpers(c: number): boolean {
  if (qjsBoxHelpersReady) return true;
  const installed: number = qjsEvalInternal(
    c,
    // Own STRING keys, each prefixed by its enumerability so the mirror can
    // reproduce it. Symbol keys are absent by construction (getOwnPropertyNames
    // never reports them) — the enumerated slice-1 residual, unchanged.
    "globalThis.__js2wasm_eval_boxkeys__ = function (o) {" +
      " if (o === null || (typeof o !== 'object' && typeof o !== 'function')) return '';" +
      " var n = Object.getOwnPropertyNames(o), out = [], i, d;" +
      " for (i = 0; i < n.length; i++) {" +
      "  try { d = Object.getOwnPropertyDescriptor(o, n[i]); } catch (e) { d = null; }" +
      "  out.push((d && d.enumerable ? 'e' : 'n') + n[i]);" +
      " }" +
      " return out.join('\\\\u0001'); };" +
      "globalThis.__js2wasm_eval_boxdel__ = function (o, k) { try { delete o[k]; } catch (e) {} };" +
      "0"
  );
  if (installed === 0) return false;
  qjs_free_value(c, installed);
  qjsBoxHelpersReady = true;
  return true;
}

/** \`__js2wasm_eval_boxkeys__(obj)\` — "" when the helper is unavailable. */
function qjsBoxKeySpec(c: number, h: number): string {
  if (!qjsEnsureBoxHelpers(c)) return "";
  const ret: number = qjsCallGlobalHelper(c, "__js2wasm_eval_boxkeys__", 1, h);
  if (ret === 0) return "";
  const spec: string = qjsReadString(c, ret);
  qjs_free_value(c, ret);
  return spec;
}

/** Read \`h[key]\` and convert it outward. Absent / unrepresentable ⇒ undefined. */
function qjsBoxReadValue(c: number, h: number, key: string): any {
  const namePtr: number = qjsPushCString(key);
  if (namePtr === 0) return undefined;
  const v: number = qjs_get_prop_str(c, h, namePtr);
  qjs_free_raw(namePtr);
  if (v === 0) return undefined;
  const saved: string = qjsPullRefusal;
  qjsPullRefusal = "";
  const out: any = qjsToGc(c, v);
  const refused: boolean = qjsPullRefusal !== "";
  qjsPullRefusal = saved;
  qjs_free_value(c, v);
  return refused ? undefined : out;
}

/** Write \`value\` into \`h[key]\`. Silently skipped when it cannot cross inward —
 *  a refusal here must never abort the sync of the other keys. */
function qjsBoxWriteValue(c: number, h: number, key: string, value: any): void {
  const namePtr: number = qjsPushCString(key);
  if (namePtr === 0) return;
  const saved: string = qjsPushRefusal;
  qjsPushRefusal = "";
  const vh: number = qjsToQuickjs(c, value);
  const refused: boolean = qjsPushRefusal !== "";
  qjsPushRefusal = saved;
  if (!refused && vh !== 0) qjs_set_prop_str(c, h, namePtr, vh);
  if (vh !== 0) qjs_free_value(c, vh);
  qjs_free_raw(namePtr);
}

/** Call a realm-side helper with exactly TWO borrowed argument handles. The
 *  one-argument sibling is \`qjsCallGlobalHelper\`; both free every handle they
 *  minted, on every path. Returns an OWNED result handle, or 0. */
function qjsCallGlobalHelper2(c: number, name: string, a0: number, a1: number): number {
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
  const argv: number = qjs_malloc_raw(8);
  let ret: number = 0;
  if (argv !== 0) {
    store32(argv, a0);
    store32(argv + 4, a1);
    ret = qjs_call(c, fn, g, 2, argv);
    qjs_free_raw(argv);
  }
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

/** \`delete h[key]\` through the realm helper (no shim export needed). */
function qjsBoxDeleteKey(c: number, h: number, key: string): void {
  if (!qjsEnsureBoxHelpers(c)) return;
  const kh: number = qjsToQuickjs(c, key);
  if (kh === 0) return;
  const ret: number = qjsCallGlobalHelper2(c, "__js2wasm_eval_boxdel__", h, kh);
  if (ret !== 0) qjs_free_value(c, ret);
  qjs_free_value(c, kh);
}

/** Does \`list\` (a string[]) contain \`name\`? */
function qjsKeyListHas(list: string[], name: string): boolean {
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === name) return true;
  }
  return false;
}

/**
 * PULL — QuickJS is the truth. Re-reads the object's own keys and values onto
 * the box, adds keys evaluated code created, drops keys it deleted, and records
 * the result in \`qjsBoxLast\` so the next PUSH can tell a compiled-side write
 * from an unchanged mirror.
 */
function qjsPullBox(c: number, idx: number): void {
  const h: number = qjsBoxHandles[idx] as number;
  const box: any = qjsBoxTargets[idx];
  if (box === undefined || box === null) return;
  const spec: string = qjsBoxKeySpec(c, h);
  const parts: string[] = [];
  qjsSplitJoined(spec, parts);
  const keys: string[] = [];
  const enumerables: number[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part: string = parts[i] as string;
    if (part.length === 0) continue;
    keys.push(part.substring(1));
    enumerables.push((part.charCodeAt(0) as number) === 101 ? 1 : 0);
  }
  const previous: any = qjsBoxKeyList[idx];
  if (previous !== undefined && previous !== null) {
    const old: string[] = previous as string[];
    for (let i = 0; i < old.length; i += 1) {
      const name: string = old[i] as string;
      if (!qjsKeyListHas(keys, name)) delete box[name];
    }
  }
  const values: any[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const key: string = keys[i] as string;
    const value: any = qjsBoxReadValue(c, h, key);
    values.push(value);
    if ((enumerables[i] as number) === 1) {
      box[key] = value;
    } else {
      // A non-enumerable own property (test262 leans on these through
      // \`verifyProperty\`) must not surface in \`Object.keys\` / \`for…in\`.
      Object.defineProperty(box, key, {
        value: value,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  }
  qjsBoxKeyList[idx] = keys;
  qjsBoxLast[idx] = values;
}

/**
 * PUSH — the compiled side is the truth for anything it changed since the last
 * sync. Writes back changed values, new keys, and deletions, then re-records the
 * baseline. Values it did NOT touch are left alone, so an evaluation's own
 * mutations are never clobbered by a stale mirror.
 */
function qjsPushBox(c: number, idx: number): void {
  const h: number = qjsBoxHandles[idx] as number;
  const box: any = qjsBoxTargets[idx];
  if (box === undefined || box === null) return;
  const previous: any = qjsBoxKeyList[idx];
  const keys: string[] = previous === undefined || previous === null ? [] : (previous as string[]);
  const lastRaw: any = qjsBoxLast[idx];
  const last: any[] = lastRaw === undefined || lastRaw === null ? [] : (lastRaw as any[]);
  const namesRaw: any = Object.getOwnPropertyNames(box);
  const names: string[] = [];
  for (let i = 0; i < (namesRaw.length as number); i += 1) names.push(String(namesRaw[i]));
  for (let i = 0; i < keys.length; i += 1) {
    const key: string = keys[i] as string;
    if (!qjsKeyListHas(names, key)) {
      qjsBoxDeleteKey(c, h, key);
      continue;
    }
    const current: any = box[key];
    if (current !== last[i]) {
      qjsBoxWriteValue(c, h, key, current);
      last[i] = current;
    }
  }
  for (let i = 0; i < names.length; i += 1) {
    const name: string = names[i] as string;
    if (qjsKeyListHas(keys, name)) continue;
    const current: any = box[name];
    qjsBoxWriteValue(c, h, name, current);
    keys.push(name);
    last.push(current);
  }
  qjsBoxKeyList[idx] = keys;
  qjsBoxLast[idx] = last;
}

/**
 * Sync every mirrored box. The loop re-reads \`qjsBoxMirror.length\` each turn on
 * purpose: pulling one box publishes its object-valued properties, which appends
 * NEW rows, and those have to be mirrored in the same pass or a nested object
 * would be one crossing stale.
 *
 * \`qjsBoxSyncing\` is the re-entrancy guard. \`qjsBoxReadValue\` reaches
 * \`qjsToGc\` → \`qjsPublish\`, which itself pulls the fresh row; without the guard
 * a cyclic graph would recurse. Rows created during a sync are still covered,
 * because \`qjsPublish\` pulls them once at creation.
 */
var qjsBoxSyncing: boolean = false;

function qjsSyncBoxes(c: number, push: boolean): void {
  if (qjsBoxSyncing) return;
  if (c === 0) return;
  qjsBoxSyncing = true;
  let i: number = 0;
  while (i < qjsBoxMirror.length) {
    if ((qjsBoxMirror[i] as number) === 1) {
      if (push) {
        qjsPushBox(c, i);
      } else {
        qjsPullBox(c, i);
      }
    }
    i += 1;
  }
  qjsBoxSyncing = false;
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

/**
 * (#4308 slice A) Make the realm's intrinsic ERROR CONSTRUCTORS and the
 * compiled ones the SAME object at the boundary, in both directions.
 *
 * The measured failure this fixes (64 \`annexB/…/eval-code/**\` files, the
 * largest single cluster in the post-membrane gap): inside an eval body
 * \`assert.throws(ReferenceError, function(){ f; })\` hands the compiled
 * \`assert.throws\` the QuickJS realm's \`ReferenceError\`, which used to cross out
 * as an opaque published function box; the callback's throw crosses out through
 * \`qjsErrorFromHandle\` as an adapter-realm \`new ReferenceError(msg)\`. The
 * harness then compares \`thrown.constructor !== expectedErrorConstructor\` — two
 * distinct objects with the same \`name\`, which is verbatim the
 * "different error constructor with the same name" message those files fail on.
 *
 * P1 measured which side is already right, and which source of the compiled
 * constructor actually works (see the issue's slice-A record):
 *  - \`thrown.constructor\` is ALREADY the user module's own \`ReferenceError\`,
 *    on both engines. Nothing on the throw path changes.
 *  - the INTERPRETER tier — which passes these files — hands \`assert.throws\`
 *    that same object. That is the known-good target.
 *  - the adapter's OWN \`ReferenceError\` is NOT it. Preference (c) of the plan's
 *    §1.7 was measured and REJECTED: seeding with the adapter's intrinsics fires
 *    (proved by poisoning the seed) and still compares unequal, because a
 *    standalone module's intrinsic constructor OBJECT is per-module — only the
 *    error instances' \`.constructor\`, which the READING module resolves, is
 *    canonical. So the constructors are taken from the CALLER'S REALM
 *    (preference (a), \`globalObject.ReferenceError\`), which is why this seeding
 *    is lazy: at context-creation time there is no realm to read them from.
 *
 * Mechanism: seed the handle registry with (realm constructor handle, caller's
 * compiled constructor) pairs. That is deliberately the SAME
 * \`qjs_is_equal\`-strict lookup the plan calls for, expressed through the
 * machinery that already exists, and it fixes BOTH crossings at once:
 *  - OUTWARD, \`qjsPublish\`'s \`qjsFindBoxIndex\` hit returns the compiled
 *    constructor instead of minting a box, so the harness comparison holds;
 *  - INWARD, \`qjsToQuickjs\`'s \`qjsHandleOf\` hit returns the realm's own
 *    constructor instead of a membrane wrapper, so the compiled
 *    \`ReferenceError\` crossing in cannot SHADOW the realm intrinsic and in-body
 *    \`e instanceof ReferenceError\` keeps answering true.
 *
 * We deliberately do NOT mirror the compiled constructors into the realm:
 * QuickJS builds engine-generated errors from its internal intrinsics whatever
 * the global binding says, so a mirror would break realm-side \`instanceof\`
 * without fixing the comparison.
 *
 * A name the caller's realm does not expose (or that the QuickJS realm does not
 * hold as a function) is left UNMAPPED — old box behaviour — rather than mapped
 * to something unverified. The realm handles are OWNED and retained for the
 * context lifetime, the same documented policy as every other registry entry.
 *
 * One realm per provider instance is assumed, exactly as \`qjsIntrinsicRealm\`
 * already assumes; the seed therefore runs once.
 */
var qjsIntrinsicErrorsSeeded: boolean = false;

/**
 * (#4308 slice B) The SAME identity trick, applied to the realm object itself.
 *
 * EvalDeclarationInstantiation at global scope needs one thing above all: the
 * caller's global object and the QuickJS realm's \`globalThis\` must be ONE
 * object at the boundary. Without it the two realms are simply disjoint, and
 * the annexB \`eval-global\` corpus measures exactly that gap:
 *
 *   test262's \`fnGlobalObject.js\` is \`Function("return this;")()\`. Under this
 *   engine that call lands in \`qjs_call\` with \`this === undefined\`, so a sloppy
 *   function returns the QUICKJS realm global, which used to cross out as an
 *   opaque published box. \`Object.defineProperty(fnGlobalObject(), 'f', …)\`
 *   therefore defined \`f\` on a one-property box — not on the caller's realm and
 *   not on QuickJS's — so the eval body's \`f\` read \`undefined\` ("binding is not
 *   reinitialized") and \`verifyProperty(global, "f", …)\` found no own property
 *   ("f should be an own property"). Both messages are verbatim in the failure
 *   census.
 *
 * Seeding the pair fixes both directions at once, exactly as slice A's error
 * constructors do: OUTWARD, the realm global publishes AS the caller's carrier,
 * so compiled property work lands on the real global; INWARD, the carrier
 * crosses back as QuickJS's own \`globalThis\` rather than a membrane wrapper, so
 * \`global === this\` and realm-side global writes stay coherent.
 *
 * The handle is OWNED and retained for the context lifetime — the same policy
 * every other registry entry carries.
 */
function qjsSeedRealmIdentity(c: number, realm: any): void {
  const gself: number = qjs_global_object(c);
  if (gself === 0) return;
  qjsPushBoxRow(gself, realm, realm, 0);
}

function qjsSeedIntrinsicErrorIdentities(c: number, realm: any): void {
  if (qjsIntrinsicErrorsSeeded) return;
  if (realm === undefined || realm === null) return;
  qjsIntrinsicErrorsSeeded = true;
  qjsSeedRealmIdentity(c, realm);
  const names: string[] = [
    "AggregateError",
    "Error",
    "EvalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError",
  ];
  const g: number = qjs_global_object(c);
  for (let i = 0; i < names.length; i += 1) {
    const name: string = names[i] as string;
    const ctor: any = __runtime_eval_unwrap_result(realm[name]);
    // NOT a \`typeof ctor === "function"\` test, and that is MEASURED, not
    // stylistic: the caller holds its intrinsic constructor as the cross-module
    // AOT callable carrier, and the ADAPTER's \`typeof\` answers "object" for it
    // while the CALLER's \`typeof\` answers "function" for the very same value.
    // A function-typed guard here compiles, links, runs, and silently seeds
    // nothing — the exact silent-no-op class this workstream keeps paying for.
    if (!qjsIsMembraneWrappable(ctor)) continue;
    const namePtr: number = qjsPushCString(name);
    if (namePtr === 0) continue;
    const h: number = qjs_get_prop_str(c, g, namePtr);
    qjs_free_raw(namePtr);
    if (h === 0) continue;
    // A realm whose intrinsic is missing or is not callable is not a realm we
    // can speak for: free the handle and leave that name unmapped rather than
    // asserting an identity we did not verify.
    if (qjs_is_function(c, h) === 0) {
      qjs_free_value(c, h);
      continue;
    }
    qjsPushBoxRow(h, ctor, ctor, 0);
  }
  qjs_free_value(c, g);
}

function qjsEnsureContext(): number {
  if (qjsContextHandle !== 0) return qjsContextHandle;
  const rt: number = qjs_new_runtime();
  if (rt === 0) return 0;
  const c: number = qjs_new_context(rt);
  if (c === 0) return 0;
  qjsRuntimeHandle = rt;
  qjsContextHandle = c;
  qjsInstallEngineIdentity(c);
  qjsCaptureIntrinsicEval(c);
  return c;
}

/**
 * Pin the realm's PRISTINE %eval% before anything can be mirrored over it.
 *
 * The timing is the whole point, and getting it wrong is not subtle — it was
 * measured as \`RuntimeError: memory access out of bounds\` on four
 * \`global-env-rec*\` files. Once a module reads \`eval\` FIRST-CLASS,
 * \`qjsIntrinsicEvalValue\` installs the memoized marker ON the caller's realm
 * carrier, and the next \`qjsPushGlobals\` mirrors that carrier. Capturing
 * \`eval\` any later than context creation therefore risks capturing a MEMBRANE
 * WRAPPER of the compiled marker, and calling it re-enters
 * \`__runtime_apply_interpreted\` → \`__runtime_indirect_eval\` → here → itself
 * until the stack is gone. Context creation is the one instant at which the
 * realm is provably untouched.
 */
function qjsCaptureIntrinsicEval(c: number): void {
  const installed: number = qjsEvalInternal(
    c,
    "globalThis.${QUICKJS_INDIRECT_EVAL_GLOBAL} = eval; 0"
  );
  if (installed !== 0) qjs_free_value(c, installed);
}

/** Is \`name\` one of the compiler's / this adapter's private carriers? Every
 *  one of them starts \`__js2wasm\` — the adapter's realm bookkeeping prefix and
 *  \`RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY\` alike — so one test covers both.
 *  Written on charCodeAt rather than \`slice\`/\`startsWith\` to stay inside the
 *  string surface the standalone target guarantees. */
function qjsIsAdapterPrivateName(name: string): boolean {
  const tag: string = "__js2wasm";
  if (name.length < tag.length) return false;
  for (let i = 0; i < tag.length; i += 1) {
    if ((name.charCodeAt(i) as number) !== (tag.charCodeAt(i) as number)) return false;
  }
  return true;
}

/** The caller and QuickJS realms already own the same three immutable ES5
 *  global value properties. Mirroring them is both redundant and unsafe:
 *  the pull side assigns through the caller carrier, which correctly throws
 *  for these non-writable properties once #4388 reifies their descriptors. */
function qjsIsImmutableGlobalValueName(name: string): boolean {
  return name === "NaN" || name === "Infinity" || name === "undefined";
}

/** Membership test over an \`any\`-typed name vector (Object.keys' result). */
function qjsAnyListHas(list: any, name: string): boolean {
  if (list === undefined || list === null) return false;
  for (let i = 0; i < (list.length as number); i += 1) {
    if (list[i] === name) return true;
  }
  return false;
}

function qjsNameListHas(list: string[], name: string): boolean {
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === name) return true;
  }
  return false;
}

/** Own-property test on the caller's realm carrier. \`in\` would walk the
 *  prototype chain, and EDI asks an OWN-property question. */
function qjsHasOwnName(target: any, name: string): boolean {
  return qjsAnyListHas(Object.getOwnPropertyNames(target), name);
}

/** The two memoized \`%eval%\` / \`%Function%\` markers. Writing over one of them
 *  is the measured realm-corruption defect the :1022-era comment records, so
 *  every write-back path tests this before touching a caller key. */
function qjsIsIntrinsicMarker(value: any): boolean {
  if (value === undefined || value === null) return false;
  const t: string = typeof value;
  if (t !== "object" && t !== "function") return false;
  const target: any = __runtime_eval_unwrap_interpreted_callback(value);
  return target === qjsEvalTarget || target === qjsFunctionTarget;
}

/** Is \`h\` one of OUR inward membrane wrappers (i.e. a compiled object wearing a
 *  QuickJS face)? \`qjs_wrapper_gc_handle\` answers 0xFFFFFFFF for anything else;
 *  the range test reads that correctly whether the i32 arrives as -1 or as the
 *  unsigned value. Used as a GUARD only: a wrapper crossing back out would today
 *  publish as an opaque box (outward identity is #4245 slice 2), so a write-back
 *  path must LEAVE the caller's own value in place instead. */
function qjsIsMembraneWrapperHandle(h: number): boolean {
  const id: number = qjs_wrapper_gc_handle(h);
  return id >= 0 && id < gcRegistry.length;
}

// (#4308 slice B) Names \`qjsPushGlobals\` actually mirrored on THIS entry, plus
// the names EvalDeclarationInstantiation created on the caller's realm. The
// pull walks exactly this union: a compiled global the push deliberately did
// NOT mirror (a non-enumerable OBJECT — see the P3 hazard below) still has a
// same-named QuickJS intrinsic in the realm, and pulling that would replace the
// caller's own value with a box. Deriving the pull set from the push is what
// makes the widened write-back below safe.
var qjsPushedNames: string[] = [];
var qjsEdiNames: string[] = [];

// (#4308 slice B) Non-zero while a QuickJS evaluation or call is on the stack.
// The globals mirror is a SNAPSHOT protocol, so re-running it re-entrantly —
// which is easy to do, because evaluated code calls compiled code through the
// membrane and compiled code calls back — would push the caller's pre-eval
// values over realm state the running evaluation just created. Every re-entrant
// sync is therefore skipped; the outermost entry still owns push and pull.
var qjsEvalDepth: number = 0;

/**
 * Mirror the caller's realm object onto QuickJS \`globalThis\` before evaluating.
 * Only PRIMITIVES cross (a compiled object has no MVP representation); a
 * skipped global simply reads as whatever QuickJS already has, which is
 * \`undefined\` for a name only the caller knows. Residual, documented.
 */
function qjsPushGlobals(c: number, globalObject: any): void {
  qjsPushedNames = [];
  if (globalObject === undefined || globalObject === null) return;
  // (#4308 slice A) The first point at which the CALLER'S REALM is in hand, and
  // it precedes every value crossing on both the direct and the indirect path
  // (\`qjsEvaluate\` and \`__runtime_direct_eval\` both call this before the eval).
  // \`__runtime_apply_interpreted\` needs no hook of its own: a realm callback
  // can only exist after an evaluation that already ran this.
  qjsSeedIntrinsicErrorIdentities(c, globalObject);
  // (#4308 slice B) Record the realm HERE, not only in \`qjsIntrinsicEvalValue\`.
  // That function runs when the module reads \`eval\`/\`Function\` FIRST-CLASS, so
  // a module whose only entry is a plain \`eval(source)\` call left
  // \`qjsIntrinsicRealm\` undefined — and every later consumer of it degraded to a
  // silent no-op. Measured: the call-time globals sync below gained exactly zero
  // files until this line existed.
  qjsIntrinsicRealm = globalObject;
  const g: number = qjs_global_object(c);
  const keys: any = Object.keys(globalObject);
  // (#4308 slice B, probe P3) \`Object.keys\` cannot see a \`defineProperty\`'d
  // NON-ENUMERABLE global, which is the whole
  // \`existing-non-enumerable-global-init\` cluster: the eval body asserts the
  // pre-existing value and reads \`undefined\` because the name never reached the
  // realm. P3 measured that \`Object.getOwnPropertyNames\` on this same carrier
  // DOES return it, with its value and its true descriptor.
  //
  // P3 also measured the hazard, so this is NOT a blanket swap: on a realistic
  // module the extra names are the compiler's private lexical-cells carrier and
  // the EIGHT compiled intrinsic error constructors. Mirroring those would push
  // compiled error constructors into the realm as membrane wrappers — precisely
  // what §1.7 forbids and what would fight slice A's identity seeding. The
  // widening is therefore restricted to non-enumerable PRIMITIVES (which is what
  // the cluster needs) plus the adapter-private name filter; a non-enumerable
  // OBJECT-valued global stays unmirrored, a declared residual.
  const all: any = Object.getOwnPropertyNames(globalObject);
  for (let i = 0; i < (all.length as number); i += 1) {
    const key: string = all[i] as string;
    if (qjsIsAdapterPrivateName(key) || qjsIsImmutableGlobalValueName(key)) continue;
    const value: any = __runtime_eval_unwrap_result(globalObject[key]);
    // Primitives cross by copy; objects and functions cross as LIVE membrane
    // wrappers (#4245 slice 1) — that is what makes the caller's own top-level
    // functions (test262's \`assert\`, \`fnGlobalObject\`, …) callable from
    // evaluated code instead of a ReferenceError. The eval/Function markers are
    // still excluded, by qjsIsMembraneWrappable: they must stay QuickJS's own
    // natives on the QuickJS realm.
    const primitive: boolean = qjsIsMirrorablePrimitive(value);
    if (!primitive && !qjsIsMembraneWrappable(value)) continue;
    if (!primitive && !qjsAnyListHas(keys, key)) continue;
    const namePtr: number = qjsPushCString(key);
    if (namePtr !== 0) {
      qjsPushRefusal = "";
      const h: number = qjsToQuickjs(c, value);
      if (qjsPushRefusal === "") {
        qjs_set_prop_str(c, g, namePtr, h);
        qjsPushedNames.push(key);
      }
      qjs_free_value(c, h);
      qjs_free_raw(namePtr);
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

/** Publish one own property that QuickJS created on its realm global back onto
 *  the caller's realm carrier.  Existing globals use the ordinary push/pull
 *  set; this helper is only for names that did not exist at entry (for example
 *  a sloppy dynamic function assigning through its this value). */
function qjsMirrorRealmProperty(c: number, globalObject: any, name: string): boolean {
  if (globalObject === undefined || globalObject === null) return false;
  if (qjsIsAdapterPrivateName(name)) return false;
  const g: number = qjs_global_object(c);
  const namePtr: number = qjsPushCString(name);
  if (namePtr === 0) {
    qjs_free_value(c, g);
    return false;
  }
  const h: number = qjs_get_prop_str(c, g, namePtr);
  qjs_free_raw(namePtr);
  qjs_free_value(c, g);
  if (h === 0) return false;
  const tag: number = qjs_tag(h);
  // New *property* reconciliation is intentionally primitive-only. Declared
  // functions/objects use the EDI and activation-pool paths, while publishing
  // an arbitrary new object global here would silently turn a live realm
  // property into a seam-snapshot box.
  const crossable: boolean = qjsIsMirrorableTag(tag);
  let mirrored: boolean = false;
  if (crossable) {
    qjsPullRefusal = "";
    const value: any = qjsToGc(c, h);
    if (qjsPullRefusal === "") {
      globalObject[name] = __runtime_eval_wrap_result(value);
      mirrored = true;
    }
  }
  qjs_free_value(c, h);
  qjsPullRefusal = "";
  return mirrored;
}

/** Diff the QuickJS realm's own names against an entry snapshot and publish
 *  every newly-created, representable global property to the caller realm. */
function qjsMirrorNewRealmGlobals(c: number, globalObject: any, before: string[]): void {
  const after: string[] = [];
  if (!qjsRealmOwnNames(c, after)) return;
  const fresh: string[] = [];
  qjsDiffNames(before, after, fresh);
  for (let i = 0; i < fresh.length; i += 1) {
    qjsMirrorRealmProperty(c, globalObject, fresh[i] as string);
  }
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
    if (!qjsIsMirrorablePrimitive(value) && !qjsIsMembraneWrappable(value)) continue;
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
  // The pull set is the PUSH set plus whatever EvalDeclarationInstantiation
  // created — never a fresh enumeration of the carrier. See qjsPushedNames.
  const names: string[] = [];
  for (let i = 0; i < qjsPushedNames.length; i += 1) names.push(qjsPushedNames[i] as string);
  for (let i = 0; i < qjsEdiNames.length; i += 1) {
    const extra: string = qjsEdiNames[i] as string;
    if (!qjsNameListHas(names, extra)) names.push(extra);
  }
  for (let i = 0; i < names.length; i += 1) {
    const key: string = names[i] as string;
    const current: any = __runtime_eval_unwrap_result(globalObject[key]);
    // Sub-rule (b) of the write-back contract: never write to a key whose
    // current compiled value is a memoized intrinsic marker.
    if (qjsIsIntrinsicMarker(current)) continue;
    const currentPrimitive: boolean = qjsIsMirrorablePrimitive(current);
    const namePtr: number = qjsPushCString(key);
    if (namePtr === 0) continue;
    const h: number = qjs_get_prop_str(c, g, namePtr);
    qjs_free_raw(namePtr);
    if (h === 0) continue;
    const tag: number = qjs_tag(h);
    if (qjsIsMirrorableTag(tag)) {
      // A primitive may only replace a primitive. Letting realm \`undefined\`
      // (a name QuickJS does not hold) overwrite a compiled object or function
      // is the clobber this filter has always existed to prevent.
      if (currentPrimitive) {
        qjsPullRefusal = "";
        const value: any = qjsToGc(c, h);
        if (qjsPullRefusal === "") globalObject[key] = __runtime_eval_wrap_result(value);
      }
    } else if (tag === QJS_TAG_OBJECT && !qjsIsMembraneWrapperHandle(h)) {
      // (#4245 slice 2) NON-CALLABLE objects cross back too, now that there is
      // something honest for them to cross back AS. This is not a widening for
      // its own sake — it is the second half of the \`existing-*-global-init\`
      // clusters, and the FIRST half (the descriptor box) is worth zero without
      // it. Those tests read \`var global = fnGlobalObject();\` INSIDE the eval and
      // then call \`verifyProperty(global, "f", …)\` from TOP-LEVEL compiled code
      // after it returns; with objects excluded from the pull the compiled
      // \`global\` stayed \`undefined\` and \`Object.getOwnPropertyDescriptor\` threw
      // "Cannot convert undefined or null to object" — measured, as the exact
      // error those 32 files moved to once the descriptor half landed.
      //
      // (#4308 slice B) FUNCTION values cross back. "Primitive-only" was always
      // about RAW handles, not about non-primitives: a published function box
      // is the sanctioned crossing — it is exactly what an eval COMPLETION
      // value already uses, and invoking it re-enters through
      // \`__runtime_apply_interpreted\`. This is what makes
      // \`eval('{ function f(){} }')\` leave a callable \`f\` behind
      // (\`existing-block-fn-update\`, \`block-scoping\`, \`existing-global-update\`).
      //
      // The wrapper guard is load-bearing: a compiled function the push mirrored
      // IN is a membrane wrapper realm-side, and republishing it would replace
      // the caller's own function with an opaque box — a silent downgrade on
      // every eval that merely READ the binding.
      qjsPullRefusal = "";
      const value: any = qjsToGc(c, h);
      if (qjsPullRefusal === "") globalObject[key] = __runtime_eval_wrap_result(value);
    }
    qjs_free_value(c, h);
  }
  qjsPullRefusal = "";
  qjs_free_value(c, g);
}

// ------------------------------- EvalDeclarationInstantiation (#4308 B) -----
//
// The adapter has no parser — but it has QuickJS, and every question EDI asks
// is answerable by PARSING, which executes nothing. Both probes below therefore
// run in a THROWAWAY context (\`qjs_new_context\` on the same runtime, freed on
// every path) so neither a hoisted \`var\` nor a pathological source that escapes
// a wrapper can touch the caller's realm.
//
// What this replaces: the plan's original §1.1 hand-rolled directive-prologue
// scanner, which probe Q5 measured WRONG on 5 of 18 prologue shapes
// (\`"use strict" + ""\`, \`"use strict"\\n["length"]\`, \`"use strict", 1\`, …) where
// the parse-only probe is wrong on 0.

/** Set by \`qjsPlanEdiNames\` when EDI step 5/6 must throw. */
var qjsEdiRedeclaration: string = "";

/** Cheap gate: a source that cannot possibly declare a var-scoped name needs no
 *  probe at all, which keeps the two scratch contexts off the hot path of the
 *  overwhelmingly common \`eval("x + 1")\` shape. Deliberately over-approximate —
 *  a false positive costs one throwaway context, a false negative would lose a
 *  binding. */
function qjsSourceCanDeclare(source: string): boolean {
  if (qjsSourceMentions(source, "var")) return true;
  return qjsSourceMentions(source, "function");
}

/** Does \`src\` PARSE in \`sc\`? (Evaluation of the wrapper forms below has no
 *  effect: they declare a function expression and never call it.) */
function qjsParsesIn(sc: number, src: string): boolean {
  const h: number = qjsEvalInternal(sc, src);
  if (h === 0) return false;
  qjs_free_value(sc, h);
  return true;
}

/**
 * §1.1′ — is the eval CODE strict, independent of the caller?
 *
 * A FunctionBody has the same DirectivePrologue rules as eval code, and \`with\`
 * is an EARLY (parse-time) SyntaxError in strict code. So:
 *   control parses + marker parses      ⇒ sloppy
 *   control parses + marker rejected    ⇒ strict
 *   control rejected                    ⇒ INCONCLUSIVE
 *
 * INCONCLUSIVE ⊆ {the source is a SyntaxError as eval code} (measured across 22
 * sources), where strictness is unobservable because the real evaluation throws
 * regardless — so answering "sloppy" there and letting the caller's own
 * strictness decide is sound.
 *
 * The PARENTHESISED FunctionExpression is load-bearing and not a style choice:
 * with the statement form \`function __p(){SRC}\` a source of
 * \`} ; globalThis.__BOOM__ = 1; function evil(){\` both parses AND RUNS
 * (measured). \`void function(){…};\` leaks the same way. Running in the scratch
 * context is the second line of defence behind that.
 */
function qjsSourceIsStrict(sc: number, source: string): boolean {
  if (!qjsParsesIn(sc, "(function(){" + source + "\\n})")) return false;
  return !qjsParsesIn(sc, "(function(){" + source + "\\n;with({}){}\\n})");
}

/** Own property names of \`c\`'s \`globalThis\`, appended to \`into\`. */
function qjsRealmOwnNames(c: number, into: string[]): boolean {
  const h: number = qjsEvalInternal(
    c,
    "Object.getOwnPropertyNames(globalThis).join(String.fromCharCode(1))"
  );
  if (h === 0) return false;
  const joined: string = qjsReadString(c, h);
  qjs_free_value(c, h);
  qjsSplitJoined(joined, into);
  return true;
}

/**
 * §1.2 — evaluate \`prologue + "throw 0;" + source\` as a Script.
 *
 * GlobalDeclarationInstantiation hoists every var-scoped name — including the
 * annex-B block-function survivors, using the ENGINE's own early-error
 * applicability test — BEFORE the first statement runs, so the sentinel aborts
 * after hoisting and before one user statement executes. Measured: a source of
 * \`var x = (globalThis.__boom__ = 1)\` adds only \`x\`; \`__boom__\` is never set.
 *
 * P2 also measured that the GDI and EDI declared-NAME sets are identical on
 * every cross-checked source (only the descriptors differ, and those are the
 * scratch realm's, not the caller's).
 *
 * Returns 0 = sentinel abort (the plan is readable), 1 = some other exception
 * (a SyntaxError — either in the source or, with a prologue, a redeclaration),
 * 2 = the probe itself could not run.
 */
function qjsSentinelProbe(sc: number, prologue: string, source: string): number {
  const src: string = prologue + "throw 0;\\n" + source;
  const buf: number = qjsPushUtf8(src);
  if (buf === 0) return 2;
  const byteLen: number = qjsUtf8Len;
  const h: number = qjs_eval(sc, buf, byteLen);
  qjs_free_raw(buf);
  if (h === 0) return 2;
  if (qjs_is_exception(h) === 0) {
    qjs_free_value(sc, h);
    return 1;
  }
  qjs_free_value(sc, h);
  const pending: number = qjs_take_exception(sc);
  const tag: number = qjs_tag(pending);
  let sentinel: boolean = false;
  if (tag === QJS_TAG_INT || tag === QJS_TAG_FLOAT64) sentinel = qjs_to_f64(sc, pending) === 0;
  qjs_free_value(sc, pending);
  return sentinel ? 0 : 1;
}

function qjsCopyNames(from: string[], into: string[]): void {
  for (let i = 0; i < from.length; i += 1) into.push(from[i] as string);
}

/** Names present in \`after\` but not \`before\`, minus this adapter's own. */
function qjsDiffNames(before: string[], after: string[], out: string[]): void {
  for (let i = 0; i < after.length; i += 1) {
    const name: string = after[i] as string;
    if (qjsIsAdapterPrivateName(name)) continue;
    if (qjsNameListHas(before, name)) continue;
    if (qjsNameListHas(out, name)) continue;
    out.push(name);
  }
}

/** The caller's GLOBAL LEXICAL names (module-level \`let\`/\`const\`) — the only
 *  bindings an EDI var name may legally collide with at global scope. */
function qjsCollectGlobalLexicalNames(globalObject: any, into: string[]): void {
  if (globalObject === undefined || globalObject === null) return;
  const carrier: any = globalObject[${j(RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY)}];
  if (carrier === undefined || carrier === null) return;
  for (let i = 0; i + 1 < (carrier.length as number); i += 2) {
    const name: any = carrier[i];
    if (typeof name === "string") into.push(name as string);
  }
}

/**
 * Compute the EDI declared-names plan for \`source\` into \`plan\`.
 * Returns FALSE when EDI must throw a SyntaxError (\`qjsEdiRedeclaration\` names
 * the offender) — before a single binding has been created, so there is no
 * partial leak.
 *
 * §1.3′: the var-vs-annexB distinction the spec needs here is NOT recoverable
 * from the probe (P2 correction 2 — after the abort, \`typeof\` separates
 * top-level function declarations from {var ∪ annexB} but not those two, and a
 * \`"use strict"\`-prefixed re-probe was tried and MEASURED to be nonsense). So
 * the distinction is never made: the caller's lexical names are seeded into a
 * second scratch realm as real \`let\` declarations and QuickJS applies its own
 * rules — throwing for a colliding \`var\` and silently skipping a colliding
 * annexB block function, which is exactly B.3.2.3. V8 in a fresh realm agrees
 * with QuickJS on both, so this inherits engine-consistent behaviour rather than
 * laundering a quirk.
 */
/**
 * The var-scoped names a SLOPPY eval of \`source\` would declare, appended to
 * \`out\`. False means the plan is not readable — a strict source (which creates
 * no caller bindings at all), an unparseable one, or no runtime — and every
 * caller treats that as "declare nothing", the conservative answer on both
 * paths that use it.
 */
function qjsProbeDeclaredNames(source: string, out: string[]): boolean {
  if (qjsRuntimeHandle === 0) return false;
  if (!qjsSourceCanDeclare(source)) return false;
  const sc: number = qjs_new_context(qjsRuntimeHandle);
  if (sc === 0) return false;
  // Strict eval code creates NO caller bindings, and the sentinel prefix
  // DESTROYS the directive prologue — so this gate is a correctness
  // precondition for the probe below, not an optimisation (P2 correction 1).
  const strict: boolean = qjsSourceIsStrict(sc, source);
  const before: string[] = [];
  const after: string[] = [];
  let ok: boolean = !strict;
  // The baseline is taken AFTER the parse probes: if a pathological source ever
  // did escape the wrapper, whatever it created is then part of the baseline
  // and cannot be mistaken for a declared name.
  if (ok) ok = qjsRealmOwnNames(sc, before);
  if (ok && qjsSentinelProbe(sc, "", source) !== 0) ok = false;
  if (ok) ok = qjsRealmOwnNames(sc, after);
  qjs_free_context(sc);
  if (!ok) return false;
  qjsDiffNames(before, after, out);
  return true;
}

function qjsPlanEdiNames(source: string, globalObject: any, plan: string[]): boolean {
  qjsEdiRedeclaration = "";
  const unseeded: string[] = [];
  if (!qjsProbeDeclaredNames(source, unseeded)) return true;
  if (unseeded.length === 0) return true;

  const lexical: string[] = [];
  qjsCollectGlobalLexicalNames(globalObject, lexical);
  const collide: string[] = [];
  for (let i = 0; i < unseeded.length; i += 1) {
    const name: string = unseeded[i] as string;
    // Only a name that can legally appear in the seeded \`let\` prologue may be
    // probed; anything else keeps the unseeded plan (documented residual).
    if (qjsNameListHas(lexical, name) && qjsIsSafeConstName(name)) collide.push(name);
  }
  if (collide.length === 0) {
    qjsCopyNames(unseeded, plan);
    return true;
  }

  const sc2: number = qjs_new_context(qjsRuntimeHandle);
  if (sc2 === 0) {
    qjsCopyNames(unseeded, plan);
    return true;
  }
  let prologue: string = "let ";
  for (let i = 0; i < collide.length; i += 1) {
    if (i > 0) prologue = prologue + ",";
    prologue = prologue + (collide[i] as string);
  }
  prologue = prologue + ";\\n";
  const before2: string[] = [];
  const after2: string[] = [];
  let ok2: boolean = qjsRealmOwnNames(sc2, before2);
  let verdict: number = 2;
  if (ok2) verdict = qjsSentinelProbe(sc2, prologue, source);
  if (verdict === 0) ok2 = qjsRealmOwnNames(sc2, after2);
  qjs_free_context(sc2);
  if (verdict === 1) {
    // The unseeded probe already parsed this source, so the ONLY new input is
    // the lexical seed: QuickJS is reporting EDI's redeclaration error.
    qjsEdiRedeclaration = collide[0] as string;
    return false;
  }
  if (verdict !== 0 || !ok2) {
    qjsCopyNames(unseeded, plan);
    return true;
  }
  // The seeded probe aborted on the sentinel: its diff is the plan with the
  // annexB collisions already removed, silently, exactly as B.3.2.3 requires.
  qjsDiffNames(before2, after2, plan);
  return true;
}

/**
 * EDI's creation step at global scope: \`CreateGlobalVarBinding\` /
 * \`CreateGlobalFunctionBinding(F, undefined, true)\`.
 *
 * A name that already exists is left completely alone — no value, no descriptor
 * (\`binding is not reinitialized\`). A NEW name is created by plain assignment,
 * which P3 measured produces \`{writable:true, enumerable:true,
 * configurable:true}\` on this carrier — exactly the attribute set B.3.3.3
 * prescribes and the one the annexB \`verifyProperty\` assertions check.
 */
function qjsCreateEdiBindings(globalObject: any, plan: string[]): void {
  if (globalObject === undefined || globalObject === null) return;
  for (let i = 0; i < plan.length; i += 1) {
    const name: string = plan[i] as string;
    qjsEdiNames.push(name);
    if (qjsHasOwnName(globalObject, name)) continue;
    globalObject[name] = __runtime_eval_wrap_result(undefined);
  }
}

// -------------------------------------------------------------- evaluate ----

/** Evaluate \`source\` at QuickJS global scope — correct for INDIRECT eval and
 *  for the \`new Function\` source form by spec.
 *
 *  \`edi\` runs EvalDeclarationInstantiation against the caller's realm: TRUE for
 *  indirect eval (whose varEnv IS the global environment) and for a direct eval
 *  from global code, FALSE for \`new Function\` (whose \`var\`s are function-scoped
 *  inside the synthesized function body). */
function qjsEvaluate(source: string, globalObject: any, edi: boolean): any {
  const c: number = qjsEnsureContext();
  if (c === 0) return runtimeEvalResult(false, new TypeError(${j(QUICKJS_INIT_REFUSAL)}));
  qjsPushGlobals(c, globalObject);
  qjsPushGlobalLexicalCells(c, globalObject);
  qjsEdiNames = [];
  if (edi) {
    const plan: string[] = [];
    if (!qjsPlanEdiNames(source, globalObject, plan)) {
      qjsPullGlobalLexicalCells(c, globalObject);
      qjsPullGlobals(c, globalObject);
      return runtimeEvalResult(
        false,
        new SyntaxError("redeclaration of '" + qjsEdiRedeclaration + "'")
      );
    }
    qjsCreateEdiBindings(globalObject, plan);
  }
  // (#4308 slice D) Evaluate THROUGH the realm's own %eval% rather than as a
  // fresh Script. A Script's top-level \`let\`/\`const\`/\`class\` create GLOBAL
  // LEXICAL bindings that outlive the evaluation, so a second eval of the same
  // source answered \`SyntaxError: redeclaration of 'outside'\` — measured, and
  // exactly what \`lex-env-distinct-cls\` asserts must NOT happen (eval code gets
  // a NewDeclarativeEnvironment for its lexical declarations). Indirect eval
  // keeps the global VariableEnvironment, so \`var\` hoisting, top-level function
  // declaration ORDER (slice B's gain) and completion values are all unchanged
  // — each re-measured before this landed.
  //
  // \`edi === false\` is \`new Function\`'s synthesized body, whose source is a
  // parenthesised function expression with no declarations to leak; it stays on
  // the direct route.
  let inRealm: boolean = false;
  if (edi && qjsEnsureDirectHelpers(c)) inRealm = qjsSetEvalSource(c, source);
  const script: string = inRealm
    ? ${j(QUICKJS_INDIRECT_EVAL_GLOBAL)} + "(" + ${j(QUICKJS_SOURCE_GLOBAL)} + ")"
    : source;
  const realmNamesBefore: string[] = [];
  qjsRealmOwnNames(c, realmNamesBefore);
  const buf: number = qjsPushUtf8(script);
  if (buf === 0) return runtimeEvalResult(false, new TypeError(${j(QUICKJS_INIT_REFUSAL)}));
  const byteLen: number = qjsUtf8Len;
  // (#4245 slice 2) The outward boxes are part of the caller's state the way its
  // globals are, so they ride the same push/pull discipline: anything the
  // compiled side wrote into a box since the last crossing goes IN before the
  // evaluation can read it, and whatever the evaluation changed comes back OUT
  // on every exit — including the throwing one, where the mutation is just as
  // real as on the success path.
  if (qjsEvalDepth === 0) qjsSyncBoxes(c, true);
  qjsEvalDepth = qjsEvalDepth + 1;
  const handle: number = qjs_eval(c, buf, byteLen);
  qjsEvalDepth = qjsEvalDepth - 1;
  qjs_free_raw(buf);
  if (handle === 0) return runtimeEvalResult(false, new TypeError(${j(QUICKJS_INIT_REFUSAL)}));
  if (qjs_is_exception(handle) !== 0) {
    qjs_free_value(c, handle);
    // Drain the pending QuickJS exception before running the name-diff helper:
    // qjsRealmOwnNames evaluates adapter-owned code in the same context, and
    // doing that while an exception is pending corrupts the exception channel.
    const thrown: any = qjsThrewResult(c);
    if (qjsEvalDepth === 0) qjsSyncBoxes(c, false);
    qjsMirrorNewRealmGlobals(c, globalObject, realmNamesBefore);
    qjsPullGlobalLexicalCells(c, globalObject);
    qjsPullGlobals(c, globalObject);
    return thrown;
  }
  qjsPullRefusal = "";
  const value: any = qjsToGc(c, handle);
  qjs_free_value(c, handle);
  if (qjsEvalDepth === 0) qjsSyncBoxes(c, false);
  qjsMirrorNewRealmGlobals(c, globalObject, realmNamesBefore);
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
// qjsEvalTarget / qjsFunctionTarget are declared with the membrane section.

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
  // Match the native interpreter's realm installation. These intrinsic data
  // properties exist for first-class reads and declaration-instantiation, but
  // they are not enumerable caller state. Plain assignment made them visible
  // to a later direct-eval activation snapshot and could corrupt that entry.
  if (!("eval" in globalObject)) {
    Object.defineProperty(globalObject, "eval", {
      value: qjsIntrinsicEval,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  if (!("Function" in globalObject)) {
    Object.defineProperty(globalObject, "Function", {
      value: qjsIntrinsicFunction,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
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
  // Indirect eval's VariableEnvironment IS the global environment record, so
  // EvalDeclarationInstantiation runs against the caller's realm.
  return qjsEvaluate(source as string, globalObject, true);
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
  // No EDI: the body's \`var\`s belong to the synthesized function's varEnv.
  return qjsEvaluate(source, globalObject, false);
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
      "globalThis.__js2wasm_eval_scopenames__ = function () {" +
      " return Object.getOwnPropertyNames(globalThis.${QUICKJS_SCOPE_GLOBAL}).join('\\\\u0001'); };" +
      "globalThis.__js2wasm_eval_globalnames__ = function () {" +
      " return Object.getOwnPropertyNames(globalThis).join('\\\\u0001'); };" +
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

/**
 * Publish the user's source into the realm so the wrapper can hand it to
 * \`eval\` as an ARGUMENT rather than splice it in as text.
 *
 * Re-entrancy is safe by construction: every wrapper reads this slot as the
 * first thing it does (the preamble that may precede it only reads plain data
 * properties off S), so a nested evaluation cannot overwrite a value an outer
 * wrapper has not yet consumed.
 */
function qjsSetEvalSource(c: number, source: string): boolean {
  const namePtr: number = qjsPushCString(${j(QUICKJS_SOURCE_GLOBAL)});
  if (namePtr === 0) return false;
  qjsPushRefusal = "";
  const h: number = qjsToQuickjs(c, source);
  const ok: boolean = qjsPushRefusal === "";
  if (ok) {
    const g: number = qjs_global_object(c);
    qjs_set_prop_str(c, g, namePtr, h);
    qjs_free_value(c, g);
  }
  qjs_free_value(c, h);
  qjs_free_raw(namePtr);
  qjsPushRefusal = "";
  return ok;
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
  // Neither metadata name is a binding: neither may reach the snapshot object,
  // the strict preamble, the QuickJS scope object, or either write-back path.
  // Keep the exact marker guard even though qjsCollectPool also advances by a
  // four-cell visible+marker group: parallel caller layers share this helper,
  // and metadata must fail closed if one is ever routed through them.
  if (
    name === ${j(RUNTIME_EVAL_NON_GLOBAL_SENTINEL)} ||
    name === ${j(RUNTIME_EVAL_DELETABLE_BINDING_MARKER)}
  ) return;
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

/** Collect the persistent activation state pool. Each source-visible binding
 * owns two adjacent logical entries (four cells): [name, value, marker,
 * markerValue]. Marker entries are deliberately skipped by structure, and the
 * central qjsAppendBinding guard independently rejects the exact marker. */
function qjsCollectPool(pool: any, names: string[], cells: any[]): void {
  if (pool === undefined || pool === null) return;
  for (let i = 0; i + 3 < (pool.length as number); i += 4) {
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
 * Wrap the caller's scope around the user's source.
 *
 * (#4308 slices C/D) \`inRealm\` selects the form that hands the source to the
 * realm's own \`eval\` — \`eval(SRC)\` under \`with (S)\`, which is a DIRECT eval
 * whose LexicalEnvironment is the with-object. Three measured consequences,
 * each of which the spliced form gets wrong:
 *
 *  1. A TOP-LEVEL function declaration in the source stays top-level. Splicing
 *     puts it inside a Block, which demotes it to an annex-B BLOCK declaration
 *     bound lexically in that block — so a later \`f\` in the source resolves to
 *     the block binding instead of the varEnv one the corpus is measuring
 *     (\`func:existing-fn-update\`: "outer declaration" where "inner" is right).
 *  2. An annex-B block function updates the CALLER's binding. EDI skips
 *     ObjectEnvironmentRecords when it looks for a conflicting binding, so the
 *     extension applies and the update lands on S (\`func:no-skip-param\`).
 *  3. A \`"use strict"\` directive in the SOURCE is a directive again, so a
 *     strict eval under a sloppy caller gets its own VariableEnvironment and
 *     stops writing the caller's \`var\` (\`var-env-var-strict-source\`).
 *
 * The strict form is \`let\` + \`try…finally\` rather than the old \`const\`
 * preamble: assignments update the \`let\`, and the \`finally\` lands them on S
 * even when the body throws — matching the sloppy arm, whose write-back has
 * always run on the throw path. The \`let\` cannot collide with a same-named
 * \`var\` in the source the way \`const\` did (measured:
 * \`invalid redefinition of lexical identifier\`), because the source is now a
 * strict eval with a variable environment of its own.
 *
 * The \`undefined;\` seeding guard stays. A Script's completion value is the
 * last NON-EMPTY statement value (UpdateEmpty), so a bare \`"use strict";\`
 * prologue in front of a block that completes empty would surface the STRING
 * "use strict" as the eval's result.
 */
function qjsWrapDirectEvalSource(
  source: string,
  preamble: string,
  copyOut: string,
  callerStrict: boolean,
  inRealm: boolean
): string {
  const body: string = inRealm
    ? "eval(" + ${j(QUICKJS_SOURCE_GLOBAL)} + ")"
    : source;
  if (callerStrict) {
    return (
      '"use strict";\\nundefined;\\n{\\n' +
      preamble +
      "try {\\n" +
      body +
      "\\n} finally {\\n" +
      copyOut +
      "}\\n}"
    );
  }
  return "with (" + ${j(QUICKJS_SCOPE_GLOBAL)} + ") {\\n" + body + "\\n}";
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

  // (#4308 slice B, probe P4) A direct eval from GLOBAL code arrives with all
  // three layers empty — measured in six shapes, including the ones most likely
  // to perturb it (\`let\` at top level, inside a block, inside a loop body) —
  // while every ordinary function caller carries at least \`arguments\`. For that
  // caller the VariableEnvironment IS the global environment record, so this
  // route is byte-for-byte indirect eval's: evaluate the source RAW at global
  // scope and run EDI against the caller's realm.
  //
  // Evaluating raw rather than through \`with (S) { … }\` is deliberate and not
  // just an optimisation for an empty S: wrapping the source in a Block demotes
  // its TOP-LEVEL function declarations to annex-B BLOCK-level ones, and it is
  // exactly those declarations the \`eval-global\` corpus is measuring.
  //
  // (#4308 slice C) The hole slice B booked as a residual is CLOSED. A
  // declaration-free ARROW caller used to be indistinguishable here — arrows
  // have no \`arguments\`, so all three layers are empty for them too (P4) — and
  // its eval-created \`var\` landed on the global object instead of the arrow's
  // varEnv, silently and with green tests. The caller now emits one extra
  // activation-seed entry, \`RUNTIME_EVAL_NON_GLOBAL_SENTINEL\`, at every
  // function-scoped call site; \`qjsAppendBinding\` drops it from the snapshot, so
  // it is a routing signal and never a binding.
  const nonGlobalCaller: boolean = qjsAnyListHas(
    activationSeedNames,
    ${j(RUNTIME_EVAL_NON_GLOBAL_SENTINEL)}
  );
  const globalCaller: boolean = !callerStrict && !nonGlobalCaller && names.length === 0;
  if (globalCaller) return qjsEvaluate(source as string, globalObject, true);

  qjsEdiNames = [];
  qjsPushGlobals(c, globalObject);
  qjsPushGlobalLexicalCells(c, globalObject);

  const scope: number = qjsCallGlobalHelper(c, "__js2wasm_eval_mkobj__", 0, 0);
  if (scope === 0) return runtimeEvalResult(false, new TypeError(${j(QUICKJS_INIT_REFUSAL)}));

  // (#4308 slice C) The EDI plan for a SLOPPY source, computed BEFORE the
  // snapshot because it decides WHERE each caller binding is presented.
  //
  // A name the eval DECLARES and the caller already binds is ONE binding in the
  // spec: EDI step 15.d.iii does \`SetMutableBinding(fn, fo)\` on the caller's
  // VariableEnvironment, and B.3.3.3 does the same for an annex-B block
  // function. In this bridge the eval's variable environment is the QuickJS
  // realm global, not S — so such a name sitting on S means the with-object
  // SHADOWS the binding EDI just updated, and the body reads its own stale
  // snapshot. Measured on \`var-env-func-init-local-update\`:
  // \`eval('initial = f; function f(){ return 33; }')\` under a caller \`var f = 88\`
  // read 88 where a function was due.
  //
  // So present those names as realm globals seeded with the caller's current
  // value instead. GlobalDeclarationInstantiation leaves an EXISTING property
  // alone (measured: a seeded 123 survives \`var f;\`), so the seed is what the
  // body observes, EDI's update lands on it, and it is copied into the caller's
  // live cell afterwards.
  const declared: string[] = [];
  const seeded: string[] = [];
  const carrier: any =
    globalObject === undefined || globalObject === null ? undefined : globalObject;
  if (!callerStrict) qjsProbeDeclaredNames(source as string, declared);

  // Snapshot. A non-primitive binding is still DEFINED on S, as \`undefined\`:
  // shadowing the caller's name is closer to its real scope shape than letting
  // the lookup fall through to a same-named realm global. It is not written
  // back — residual bucket 5, re-derived cheaply at write-back time from the
  // cell's still-unchanged value rather than carried in a parallel array.
  let preamble: string = "";
  let copyOut: string = "";
  const gSeed: number = qjs_global_object(c);
  for (let i = 0; i < names.length; i += 1) {
    const name: string = names[i] as string;
    const cell: EvalBindingCell = cells[i] as EvalBindingCell;
    const value: any = __runtime_eval_unwrap_result(cell.value);
    // #4245 slice 1: an object-valued caller binding is snapshotted as a LIVE
    // wrapper, not the \`undefined\` stand-in. Its write-back is still skipped
    // below (qjsWriteBackCallerCells is primitives-only) — correctly so: the
    // wrapper's traps already wrote through to the caller's own object.
    const primitive: boolean = qjsIsMirrorablePrimitive(value);
    const crossable: boolean = primitive || qjsIsMembraneWrappable(value);
    // …but NOT when the caller's realm already owns the same name. The realm
    // slot is then spoken for by the true GLOBAL, and seeding an ACTIVATION
    // binding over it makes that activation binding visible at global scope for
    // the duration of the evaluation. Measured on
    // \`indirect/global-env-rec-eval\`: an eval that declares \`var x\` and then
    // runs an INDIRECT eval reading \`x\` must see the global's value, not the
    // activation's. The cost is narrow and named — for a name that is both a
    // caller binding and a compiled global, EDI's update reaches S (the
    // with-object shadows the realm) but not the realm, which is the direction
    // that matters here.
    const preSeed: boolean =
      qjsNameListHas(declared, name) &&
      (carrier === undefined || !qjsHasOwnName(carrier, name));
    const namePtr: number = qjsPushCString(name);
    if (namePtr !== 0) {
      qjsPushRefusal = "";
      const h: number = crossable ? qjsToQuickjs(c, value) : qjs_new_undefined();
      if (qjsPushRefusal === "") {
        if (preSeed) {
          qjs_set_prop_str(c, gSeed, namePtr, h);
          seeded.push(name);
        } else {
          qjs_set_prop_str(c, scope, namePtr, h);
        }
      }
      qjs_free_value(c, h);
      qjs_free_raw(namePtr);
    }
    // (#4308 slice D) \`let\` + copy-out, not \`const\`. A strict caller's eval may
    // legitimately ASSIGN to an existing caller binding; \`const\` turned that
    // into a TypeError (the slice-3 residual) and collided outright with a
    // same-named \`var\` in the source.
    if (callerStrict && qjsIsSafeConstName(name) && qjsSourceMentions(source as string, name)) {
      preamble = preamble + "let " + name + " = " + ${j(QUICKJS_SCOPE_GLOBAL)} + "." + name + ";\\n";
      copyOut = copyOut + ${j(QUICKJS_SCOPE_GLOBAL)} + "." + name + " = " + name + ";\\n";
    }
  }
  qjs_free_value(c, gSeed);
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

  // (#4308 slices C/D) Route through the realm's own \`eval\` whenever we can.
  // The one case we cannot: a SLOPPY caller that binds the name \`eval\` itself,
  // where \`with (S)\` would resolve the callee to the caller's shadow and the
  // call would stop being an eval at all (measured: it returns the shadow's
  // result). The strict arm cannot hit this — \`eval\` is a reserved name there,
  // so it never reaches the preamble and S is not in scope.
  const evalShadowed: boolean = qjsNameListHas(names, "eval");
  const inRealm: boolean =
    (callerStrict || !evalShadowed) && qjsSetEvalSource(c, source as string);
  const wrapped: string = qjsWrapDirectEvalSource(
    source as string,
    preamble,
    copyOut,
    callerStrict,
    inRealm
  );
  const buf: number = qjsPushUtf8(wrapped);
  let result: any = undefined;
  if (buf === 0) {
    result = runtimeEvalResult(false, new TypeError(${j(QUICKJS_INIT_REFUSAL)}));
  } else {
    const byteLen: number = qjsUtf8Len;
    qjsEvalDepth = qjsEvalDepth + 1;
    const handle: number = qjs_eval(c, buf, byteLen);
    qjsEvalDepth = qjsEvalDepth - 1;
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
  // (#4308 slice D) The STRICT arm writes back as well now — its \`finally\`
  // copy-out has already landed the preamble's values on S, so this is the same
  // S→cell step the sloppy arm takes. A name with no preamble entry still holds
  // its own pre-eval snapshot in S, so copying it back is a no-op rather than a
  // leak. What stays strict-only is the ABSENCE of qjsMirrorNewBindings: strict
  // eval code creates no bindings in the caller's variable environment.
  // The pre-seeded names live on the realm, not on S — read them FIRST, before
  // anything on the cleanup path can delete or blank them.
  qjsPullSeededBindings(c, seeded, names, cells);
  qjsWriteBackCallerCells(c, scope, seeded, names, cells);
  if (!callerStrict) {
    qjsReconcileDeletedPoolBindings(c, activationState, seeded, names, cells);
    qjsMirrorNewBindings(c, activationState, names, preNames);
  }
  // …and only then hand the realm slot back to whatever the CALLER's realm says
  // it should hold. Without this the caller's local value would still be on the
  // realm global when \`qjsPullGlobals\` runs, and would be copied over the
  // compiled global of the same name.
  qjsRestoreSeededGlobals(c, globalObject, seeded);
  if (preNames !== 0) qjs_free_value(c, preNames);
  qjs_free_value(c, scope);
  qjsPullGlobalLexicalCells(c, globalObject);
  qjsPullGlobals(c, globalObject);
  return result;
}

/**
 * Copy what the evaluation left on S back into the LIVE caller cells.
 *
 * The compiled-side filter is the load-bearing one and it is unchanged: a
 * binding whose PRE-eval value was not a primitive was never snapshotted by
 * value (S holds a live membrane wrapper or \`undefined\` for it), so writing
 * anything back would replace the caller's own object with a stand-in. The
 * intrinsic markers are excluded by identity for the same reason
 * \`qjsPullGlobals\` excludes them.
 *
 * (#4308 slice C) The QuickJS-side filter is widened from primitives to the
 * published crossings, exactly as slice B widened the globals pull: an annex-B
 * block function inside a sloppy eval performs
 * \`SetMutableBinding(F, fobj)\` on the caller's VARIABLE environment, which for
 * a function caller is S — so with a primitives-only tag test the caller's
 * binding kept its stale value and \`func:no-skip-param\` measured a number
 * where a function was due. "Primitive-only" was always about RAW handles; a
 * published function box is the sanctioned representation, and the wrapper
 * guard keeps a compiled function that merely crossed IN from being downgraded
 * to a box on the way back.
 */
function qjsWriteBackCallerCells(
  c: number,
  scope: number,
  seeded: string[],
  names: string[],
  cells: any[]
): void {
  for (let i = 0; i < names.length; i += 1) {
    // A pre-seeded name has no property on S at all, and \`qjs_get_prop_str\`
    // answers \`undefined\` for an absent key — which would CLOBBER the cell.
    // qjsPullSeededBindings owns these.
    if (qjsNameListHas(seeded, names[i] as string)) continue;
    const cell: EvalBindingCell = cells[i] as EvalBindingCell;
    const current: any = __runtime_eval_unwrap_result(cell.value);
    if (!qjsIsMirrorablePrimitive(current)) continue;
    if (qjsIsIntrinsicMarker(current)) continue;
    const namePtr: number = qjsPushCString(names[i] as string);
    if (namePtr === 0) continue;
    const h: number = qjs_get_prop_str(c, scope, namePtr);
    qjs_free_raw(namePtr);
    if (h === 0) continue;
    const tag: number = qjs_tag(h);
    if (qjsIsMirrorableTag(tag) || (tag === QJS_TAG_OBJECT && !qjsIsMembraneWrapperHandle(h))) {
      qjsPullRefusal = "";
      const value: any = qjsToGc(c, h);
      if (qjsPullRefusal === "") cell.value = __runtime_eval_wrap_result(value);
    }
    qjs_free_value(c, h);
  }
  qjsPullRefusal = "";
}

/**
 * Reconcile deletions from the QuickJS scope object back into the caller-owned
 * activation pool. Only a visible entry whose adjacent name is the exact
 * deletability marker may be tombstoned; ordinary caller bindings merely use
 * the same snapshot object and must never become pool vacancies.
 *
 * The helper snapshots S's own names once. Eval-created identifiers cannot
 * contain U+0001, so the existing joined-name transport is lossless here.
 */
function qjsReconcileDeletedPoolBindings(
  c: number,
  pool: any,
  seeded: string[],
  names: string[],
  cells: any[]
): void {
  if (pool === undefined || pool === null) return;
  const listHandle: number = qjsCallGlobalHelper(c, "__js2wasm_eval_scopenames__", 0, 0);
  if (listHandle === 0) return;
  const joined: string = qjsReadString(c, listHandle);
  qjs_free_value(c, listHandle);
  const present: string[] = [];
  qjsSplitJoined(joined, present);
  // A persisted binding that the source REDECLARES is seeded on the realm
  // rather than S so EvalDeclarationInstantiation can update the existing
  // caller binding. Its absence from S is therefore expected, but its absence
  // from the realm means a source-level delete really succeeded. Snapshot the
  // realm names once and fail closed if that observation is unavailable.
  const realmPresent: string[] = [];
  let realmNamesKnown: boolean = seeded.length === 0;
  if (seeded.length > 0) {
    const realmListHandle: number = qjsCallGlobalHelper(
      c,
      "__js2wasm_eval_globalnames__",
      0,
      0
    );
    if (realmListHandle !== 0) {
      const realmJoined: string = qjsReadString(c, realmListHandle);
      qjs_free_value(c, realmListHandle);
      qjsSplitJoined(realmJoined, realmPresent);
      realmNamesKnown = true;
    }
  }
  for (let i = 0; i + 3 < (pool.length as number); i += 4) {
    const nameCell: EvalBindingCell = pool[i] as EvalBindingCell;
    const valueCell: EvalBindingCell = pool[i + 1] as EvalBindingCell;
    const markerCell: EvalBindingCell = pool[i + 2] as EvalBindingCell;
    const markerValueCell: EvalBindingCell = pool[i + 3] as EvalBindingCell;
    if (nameCell === undefined || nameCell === null) continue;
    if (valueCell === undefined || valueCell === null) continue;
    if (markerCell === undefined || markerCell === null) continue;
    if (markerValueCell === undefined || markerValueCell === null) continue;
    const name: any = __runtime_eval_unwrap_result(nameCell.value);
    const marker: any = __runtime_eval_unwrap_result(markerCell.value);
    if (typeof name !== "string") continue;
    if (marker !== ${j(RUNTIME_EVAL_DELETABLE_BINDING_MARKER)}) continue;
    // A same-named lexical/caller layer can shadow this pool entry in the
    // flattened snapshot. Only the pool cell that was actually presented may
    // authorize tombstoning its own marked group.
    let selected: boolean = false;
    for (let k = 0; k < names.length; k += 1) {
      if (names[k] === name && cells[k] === valueCell) {
        selected = true;
        break;
      }
    }
    if (!selected) continue;
    // EDI-declared existing bindings are intentionally presented on the realm,
    // not S. Keep one when its realm property survived; tombstone the exact
    // marked group when that property is absent because deletion succeeded.
    if (qjsNameListHas(seeded, name as string)) {
      if (!realmNamesKnown || qjsNameListHas(realmPresent, name as string)) continue;
    } else if (qjsNameListHas(present, name as string)) continue;
    nameCell.value = __runtime_eval_wrap_result(undefined);
    valueCell.value = __runtime_eval_wrap_result(undefined);
    markerCell.value = __runtime_eval_wrap_result(undefined);
    markerValueCell.value = __runtime_eval_wrap_result(undefined);
  }
}

/**
 * (#4308 slice C) Copy the PRE-SEEDED bindings off the realm and into the live
 * caller cells. Same filters as the S write-back above; the value is whatever
 * EvalDeclarationInstantiation (or the body) left on the realm global.
 */
function qjsPullSeededBindings(c: number, seeded: string[], names: string[], cells: any[]): void {
  if (seeded.length === 0) return;
  const g: number = qjs_global_object(c);
  for (let i = 0; i < names.length; i += 1) {
    const name: string = names[i] as string;
    if (!qjsNameListHas(seeded, name)) continue;
    const cell: EvalBindingCell = cells[i] as EvalBindingCell;
    const current: any = __runtime_eval_unwrap_result(cell.value);
    if (!qjsIsMirrorablePrimitive(current)) continue;
    if (qjsIsIntrinsicMarker(current)) continue;
    const namePtr: number = qjsPushCString(name);
    if (namePtr === 0) continue;
    const h: number = qjs_get_prop_str(c, g, namePtr);
    qjs_free_raw(namePtr);
    if (h === 0) continue;
    const tag: number = qjs_tag(h);
    if (qjsIsMirrorableTag(tag) || (tag === QJS_TAG_OBJECT && !qjsIsMembraneWrapperHandle(h))) {
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
 * (#4308 slice C) Undo the pre-seed. The realm slot goes back to the CALLER's
 * realm value, or is dropped when the caller's realm has no such name — the
 * seed was a view of an ACTIVATION binding, and leaving it behind would make
 * \`qjsPullGlobals\` copy a function-scoped value onto a same-named compiled
 * global.
 */
function qjsRestoreSeededGlobals(c: number, globalObject: any, seeded: string[]): void {
  if (seeded.length === 0) return;
  const g: number = qjs_global_object(c);
  for (let i = 0; i < seeded.length; i += 1) {
    const name: string = seeded[i] as string;
    const namePtr: number = qjsPushCString(name);
    if (namePtr === 0) continue;
    const carried: boolean =
      globalObject !== undefined && globalObject !== null && qjsHasOwnName(globalObject, name);
    if (carried) {
      const value: any = __runtime_eval_unwrap_result(globalObject[name]);
      const crossable: boolean = qjsIsMirrorablePrimitive(value) || qjsIsMembraneWrappable(value);
      qjsPushRefusal = "";
      const h: number = crossable ? qjsToQuickjs(c, value) : qjs_new_undefined();
      if (qjsPushRefusal === "") qjs_set_prop_str(c, g, namePtr, h);
      qjs_free_value(c, h);
    } else {
      qjsPushRefusal = "";
      const arg: number = qjsToQuickjs(c, name);
      if (qjsPushRefusal === "") {
        const dropped: number = qjsCallGlobalHelper(c, "__js2wasm_eval_del__", 1, arg);
        if (dropped !== 0) qjs_free_value(c, dropped);
      }
      qjs_free_value(c, arg);
    }
    qjs_free_raw(namePtr);
  }
  qjsPushRefusal = "";
  qjs_free_value(c, g);
}

/**
 * Mirror the bindings a sloppy eval CREATED into the activation state pool.
 *
 * \`with (S) { var n = 1 }\` hoists \`n\` onto the QuickJS realm (the with-object
 * only intercepts the assignment), so the realm diff is what names them. A
 * primitive is moved into a pool vacancy — nameCell/valueCell, the interpreter's
 * own slot discipline — and then DELETED from the realm, because it is a
 * function-scoped binding that must not survive as a global for the next eval.
 *
 * (#4308 slice C) A FUNCTION or plain object crosses into the pool too, through
 * the same published crossing the globals pull uses, so
 * \`eval("function f(){}")\` in a function caller leaves a callable \`f\` in the
 * caller's variable environment instead of the \`f is not defined\` that was
 * residual bucket 2. The published box holds its own retained handle, so
 * deleting the realm property afterwards does not invalidate it — and deleting
 * IS right: the binding is function-scoped, and the next direct eval from this
 * same activation re-presents it through S.
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
    let attempted: boolean = false;
    if (!shadowsCaller) {
      const h: number = qjs_get_prop_str(c, g, namePtr);
      if (h !== 0) {
        const tag: number = qjs_tag(h);
        const worthClaiming: boolean = isFresh || tag !== QJS_TAG_UNDEFINED;
        const crossable: boolean =
          qjsIsMirrorableTag(tag) || (tag === QJS_TAG_OBJECT && !qjsIsMembraneWrapperHandle(h));
        if (worthClaiming && crossable) {
          qjsPullRefusal = "";
          const value: any = qjsToGc(c, h);
          if (qjsPullRefusal === "") {
            attempted = true;
            claimed = qjsClaimPoolSlot(pool, name, value);
          }
        }
        qjs_free_value(c, h);
      }
    }
    qjs_free_raw(namePtr);
    if (claimed) qjsRememberCreatedName(name);
    // (#4308 slice C) The 64-slot ceiling is accepted, but it must not be
    // SILENT: a name that had a value and no vacancy is dropped, and the drop
    // is recorded in the realm where a probe can read it back. Never
    // mis-slotted, never a trap — just diagnosable.
    if (attempted && !claimed) qjsRecordPoolOverflow(c, name);
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

/**
 * (#4308 slice C) Publish a pool-exhaustion drop into the realm.
 *
 * The activation pool is 64 source-visible slots (128 logical entries / 256
 * cells: each visible name/value pair has an adjacent marker pair). A source
 * declaring more distinct var names than that in ONE activation loses the
 * tail — which is the accepted ceiling, not a bug to engineer around. What was
 * NOT acceptable is losing it silently: the counter and the last dropped name
 * are readable from evaluated code (\`__js2wasm_eval_pool_overflow_count__\`),
 * which is the only diagnostic channel the frozen seam leaves open. Both names
 * carry the adapter prefix, so the new-binding diff never sees them.
 */
function qjsRecordPoolOverflow(c: number, name: string): void {
  qjsPoolOverflowCount = qjsPoolOverflowCount + 1;
  const g: number = qjs_global_object(c);
  const countPtr: number = qjsPushCString("__js2wasm_eval_pool_overflow_count__");
  if (countPtr !== 0) {
    const countHandle: number = qjs_new_f64(c, qjsPoolOverflowCount);
    qjs_set_prop_str(c, g, countPtr, countHandle);
    qjs_free_value(c, countHandle);
    qjs_free_raw(countPtr);
  }
  const namePtr: number = qjsPushCString("__js2wasm_eval_pool_overflow_name__");
  if (namePtr !== 0) {
    qjsPushRefusal = "";
    const nameHandle: number = qjsToQuickjs(c, name);
    if (qjsPushRefusal === "") qjs_set_prop_str(c, g, namePtr, nameHandle);
    qjs_free_value(c, nameHandle);
    qjs_free_raw(namePtr);
    qjsPushRefusal = "";
  }
  qjs_free_value(c, g);
}

/** Take (or update) the visible+marker group for \`name\`. False when all 64
 * source-visible groups are full — marker entries never double the capacity. */
function qjsClaimPoolSlot(pool: any, name: string, value: any): boolean {
  let vacancy: number = -1;
  for (let i = 0; i + 3 < (pool.length as number); i += 4) {
    const nameCell: EvalBindingCell = pool[i] as EvalBindingCell;
    const markerCell: EvalBindingCell = pool[i + 2] as EvalBindingCell;
    if (nameCell === undefined || nameCell === null) continue;
    if (markerCell === undefined || markerCell === null) continue;
    const held: any = __runtime_eval_unwrap_result(nameCell.value);
    const marker: any = __runtime_eval_unwrap_result(markerCell.value);
    if (held === name) {
      const valueCell: EvalBindingCell = pool[i + 1] as EvalBindingCell;
      valueCell.value = __runtime_eval_wrap_result(value);
      markerCell.value = __runtime_eval_wrap_result(${j(RUNTIME_EVAL_DELETABLE_BINDING_MARKER)});
      return true;
    }
    if (
      vacancy < 0 &&
      (held === undefined || held === null) &&
      (marker === undefined || marker === null)
    ) vacancy = i;
  }
  if (vacancy < 0) return false;
  const nameCell: EvalBindingCell = pool[vacancy] as EvalBindingCell;
  const valueCell: EvalBindingCell = pool[vacancy + 1] as EvalBindingCell;
  const markerCell: EvalBindingCell = pool[vacancy + 2] as EvalBindingCell;
  const markerValueCell: EvalBindingCell = pool[vacancy + 3] as EvalBindingCell;
  nameCell.value = __runtime_eval_wrap_result(name);
  valueCell.value = __runtime_eval_wrap_result(value);
  markerCell.value = __runtime_eval_wrap_result(${j(RUNTIME_EVAL_DELETABLE_BINDING_MARKER)});
  markerValueCell.value = __runtime_eval_wrap_result(undefined);
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

  // (#4308 slice B) A function an eval CREATED shares the caller's global
  // environment, and it can be invoked long after the evaluation that produced
  // it returned — so the globals mirror has to run around the CALL too, not only
  // around the eval. Measured on the annexB \`block-scoping\` cluster:
  // \`eval('{ function f(){ initialBV = f; … } }')\` and then a compiled \`f()\`
  // assigns the caller's \`initialBV\` from inside QuickJS, and without this sync
  // that assignment lands on the realm and is never seen again.
  //
  // Only at depth 0: re-entering the snapshot protocol from inside a running
  // evaluation would push the caller's PRE-eval values over bindings that
  // evaluation just created.
  const syncGlobals: boolean = qjsEvalDepth === 0 && qjsIntrinsicRealm !== undefined && qjsIntrinsicRealm !== null;
  const callRealmNamesBefore: string[] = [];
  if (syncGlobals) {
    qjsEdiNames = [];
    qjsPushGlobals(c, qjsIntrinsicRealm);
    qjsPushGlobalLexicalCells(c, qjsIntrinsicRealm);
    qjsRealmOwnNames(c, callRealmNamesBefore);
  }
  // (#4245 slice 2) Same reasoning as the globals mirror one line up: invoking a
  // QuickJS callable is a seam crossing, so the outward boxes cross with it.
  const syncBoxes: boolean = qjsEvalDepth === 0;
  if (syncBoxes) qjsSyncBoxes(c, true);

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
    qjsEvalDepth = qjsEvalDepth + 1;
    const ret: number = qjs_call(c, fnHandle, thisHandle, args.length, argvPtr);
    qjsEvalDepth = qjsEvalDepth - 1;
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
  if (syncBoxes) qjsSyncBoxes(c, false);
  if (syncGlobals) {
    qjsMirrorNewRealmGlobals(c, qjsIntrinsicRealm, callRealmNamesBefore);
    qjsPullGlobalLexicalCells(c, qjsIntrinsicRealm);
    qjsPullGlobals(c, qjsIntrinsicRealm);
  }
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
      // #4245 slice 1 — the membrane, in ONE reading. This canary is the
      // build-time guard for a failure mode that is otherwise silent: the
      // adapter's \`__membrane_call\` invokes the compiled callable through
      // \`__runtime_eval_apply_callable\`, a private intrinsic the compiler
      // recognises by NAME at the call site. If that lowering ever stops
      // firing, the adapter falls back to the stub in its own source and every
      // call from evaluated code answers \`undefined\` — green tests, dead
      // membrane. Reading 4321 requires the call to have really run.
      var membrane = 0;
      var membraneObject: any = { n: 7 };
      var membraneAlias: any = membraneObject;
      try {
        // read a compiled object, write it back, observe the write here,
        // call a compiled function, and check wrapper identity across a
        // SECOND evaluation — 4 digits, one per property.
        var read: any = (0, eval)(joinSource(["membraneObject.n +", " 0"]));
        (0, eval)(joinSource(["membraneObject.n = ", "8"]));
        var called: any = (0, eval)(joinSource(["membraneAdd(20,", " 21)"]));
        var same: any = (0, eval)(joinSource(["membraneObject === ", "membraneAlias ? 1 : 0"]));
        membrane =
          ((read as number) === 7 ? 4000 : 0) +
          ((membraneObject.n as number) === 8 ? 300 : 0) +
          ((called as number) === 42 ? 20 : 0) +
          ((same as number) === 1 ? 1 : 0);
      } catch (err) {
        membrane = -1;
      }
      function membraneAdd(a: number, b: number): number { return a + b + 1; }

      // #4245 slice 2 — the OUTWARD half, as one 4-digit reading. Each digit is
      // a distinct way this can regress to a silently-passing no-op:
      //   6000 the box carries the QuickJS object's OWN KEYS (an opaque box, or
      //        a Proxy box whose __hasOwnProperty arm does not exist, reads 0
      //        here while every downstream test262 assertion still "passes")
      //    500 a value read off the box is the real one
      //     40 a mutation made by a LATER evaluation is visible
      //      3 a compiled-side write reaches the QuickJS object
      var outward = 0;
      try {
        var obox: any = (0, eval)(joinSource(["globalThis.canaryObj = { n: 4", "1 }"]));
        var okeys: any = Object.getOwnPropertyNames(obox);
        var ownSeen: number =
          ((okeys as any).length as number) === 1 && ((Object as any).hasOwn(obox, "n") ? 1 : 0) === 1 ? 6000 : 0;
        var valueSeen: number = ((obox as any).n as number) === 41 ? 500 : 0;
        (0, eval)(joinSource(["canaryOb", "j.n = 55"]));
        var liveSeen: number = ((obox as any).n as number) === 55 ? 40 : 0;
        (obox as any).n = 9;
        var backSeen: number = ((0, eval)(joinSource(["canaryOb", "j.n"])) as number) === 9 ? 3 : 0;
        outward = ownSeen + valueSeen + liveSeen + backSeen;
      } catch (err) {
        outward = -1;
      }

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
      export function membraneProbe(): number { return membrane; }
      export function outwardProbe(): number { return outward; }
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
  {
    probe: "membraneProbe",
    expected: 4321,
    why:
      "the #4245 inward membrane is not live: 4000 = evaluated code read a compiled object's property, " +
      "300 = its write was observed on the compiled side, 20 = it CALLED a compiled function " +
      "(this digit is the __runtime_eval_apply_callable lowering), 1 = one compiled object is one wrapper " +
      "across two separate evaluations",
  },
  {
    probe: "outwardProbe",
    expected: 6543,
    why:
      "the #4245 slice-2 outward live view is not live: 6000 = the box reports the QuickJS object's own " +
      "keys to getOwnPropertyNames/hasOwn (the digit that catches a box which passes every downstream " +
      "assertion by answering 'no own properties'), 500 = a value read off it is the real one, " +
      "40 = a LATER evaluation's mutation is visible, 3 = a compiled-side write reached QuickJS",
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

/**
 * Focused parity guards for the three QuickJS-only losses measured by #4242.
 * Keep these separate from the broad adapter canary: each module gets a fresh
 * realm, matching Test262 isolation and making a failure identify one bridge
 * rather than a later, unrelated evaluation in the omnibus source.
 */
export const QUICKJS_FUNCTION_PARITY_CANARY_SOURCE = `
      function joinSource(parts: string[]): string {
        var out = "";
        for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
        return out;
      }
      var constructorIdentity = 0;
      var appliedGlobal = 0;
      try {
        var made: any = new Function(joinSource(["this.quickjsParityGlobal = ", "1;"]));
        constructorIdentity = made.constructor === Function ? 1 : 0;
        made.apply(undefined, []);
        appliedGlobal = (globalThis as any).quickjsParityGlobal === 1 ? 1 : 0;
      } catch (err) {
        constructorIdentity = -1;
        appliedGlobal = -1;
      }
      export function functionParityProbe(): number {
        return constructorIdentity * 10 + appliedGlobal;
      }
    `;

export const QUICKJS_FUNCTION_PARITY_CANARY_EXPECTATIONS = Object.freeze([
  {
    probe: "functionParityProbe",
    expected: 11,
    why:
      "a QuickJS-created function lost %Function% constructor identity, or a primitive global written " +
      "through Function#apply did not reach the caller realm",
  },
]);

export const QUICKJS_STATE_PARITY_CANARY_SOURCE = `
      function joinSource(parts: string[]): string {
        var out = "";
        for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
        return out;
      }
      export function stateParityProbe(): number {
        try {
          eval(joinSource(["function quickjsParityFn(){ return ", "42; }"]));
          var seen: any = eval(joinSource(["typeof quickjs", "ParityFn"]));
          return (seen === "function" ? 10 : 0) + (quickjsParityFn() as number);
        } catch (err) {
          return -1;
        }
      }
    `;

export const QUICKJS_STATE_PARITY_CANARY_EXPECTATIONS = Object.freeze([
  {
    probe: "stateParityProbe",
    expected: 52,
    why: "a sloppy direct-eval function declaration did not persist in the caller activation or was not callable",
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
/**
 * #4245 slice 1 — wire the inward membrane's trap callbacks.
 *
 * ONE-TIME link plumbing, not a data path: the artifact's own
 * `__indirect_function_table` is grown once and the adapter's exported
 * `__membrane_*` functions are stored into the fresh slots, then the shim is
 * told their indices. Every subsequent trap is a wasm `call_indirect` from C
 * into the adapter — no JS closure is ever on the trap path, which is the
 * constraint the #4238 spec freezes. Funcref tables legally hold functions from
 * any instance, and each callee runs against its own instance's state.
 *
 * Both sides are all-i32, so the engine typechecks the edge at `call_indirect`.
 * A signature drift therefore surfaces as "indirect call type mismatch" on the
 * FIRST trap rather than as silent garbage.
 */
function bindQuickjsMembraneCallbacks(qjs, adapter) {
  const table = qjs.exports.__indirect_function_table;
  const install = qjs.exports.qjs_set_membrane_callbacks;
  if (!table || typeof install !== "function") {
    throw new Error(
      `libquickjs.wasm exports no ${!table ? "__indirect_function_table" : "qjs_set_membrane_callbacks"} — ` +
        `the artifact predates the #4245 membrane (rebuild: bash scripts/quickjs-artifact/build.sh)`,
    );
  }
  const missing = QUICKJS_MEMBRANE_CALLBACKS.filter((name) => typeof adapter.exports[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`quickjs adapter exports no ${missing.join(", ")} — the cached adapter predates #4245 slice 1`);
  }
  const base = table.grow(QUICKJS_MEMBRANE_CALLBACKS.length);
  QUICKJS_MEMBRANE_CALLBACKS.forEach((name, i) => table.set(base + i, adapter.exports[name]));
  install(...QUICKJS_MEMBRANE_CALLBACKS.map((_, i) => base + i));
}

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
  bindQuickjsMembraneCallbacks(qjs, adapter);
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
      `QUICKJS (artifact ${artifact.sha256.slice(0, 12)}, adapter key ${key}) — DEFAULT engine ` +
      `(#4242); JS2WASM_EVAL_ENGINE=interpreter selects the kept native bytecode engine; ` +
      `TEST262_FULL_RUNTIME_EVAL is ignored under this engine`,
  };
}
