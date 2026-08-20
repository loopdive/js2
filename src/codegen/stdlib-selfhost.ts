// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3141 — self-hosted stdlib driver (pilot: Math helpers).
 *
 * Compiles a builtin written as ORDINARY TypeScript source (see
 * `src/stdlib/math.ts`) through the compiler's OWN pipeline —
 * `lowerFunctionAstToIr` (front-end) → IR hygiene passes →
 * `lowerIrFunctionToWasm` (BackendEmitter) — and registers the result as
 * a defined function, exactly where the hand-emitted `Instr[]` bodies
 * used to be pushed. This is the porffor model: builtins are source the
 * compiler precompiles, not hand-assembly.
 *
 * Two-stage split (why it's cheap):
 *   1. `buildBuiltinIr` — parse + from-ast + verify + passes. The
 *      resulting `IrFunction` is CONTEXT-INDEPENDENT (all cross-function
 *      references are symbolic `IrFuncRef`s by name — spec #1131 §1.2),
 *      so it is memoized once per process and shared across compilations.
 *      The IR is never mutated after the pass pipeline (lowering only
 *      reads it), which is what makes the memoization sound.
 *   2. `emitSelfHostedMathFunc` — per compilation, lower the memoized IR
 *      against the LIVE CodegenContext. Symbol resolution happens here:
 *      `IrFuncRef("Math_exp")` → `ctx.funcMap` (the sibling helper
 *      registered moments earlier by `emitInlineMathFunctions`), and the
 *      function's own type is interned through the shared `addFuncType`
 *      registry. The produced body is plain `Instr[]` with absolute call
 *      indices — the same shape the hand-written bodies had, so every
 *      downstream pass (late-import index fixups, DCE, binary emit)
 *      treats it identically.
 *
 * Scope guard: the pilot's builtins are pure-f64 leaf math. Their IR
 * must never reference globals, objects, closures, or vecs — the resolver
 * below throws on all of those, which turns any accidental dialect growth
 * in `src/stdlib/math.ts` into a loud compile error instead of a miscompile.
 * (#3256 widened the STRING arms — resolveString + the emitString* hooks +
 * makeResolver's name-fallback in resolveFunc — for the Tier-1 string
 * family; they are native-strings-mode-only and fail loudly elsewhere.)
 *
 * #3161 — generalized typed path (`SelfHostedFuncDef` / `emitSelfHostedFunc`):
 * the scale-up families (array-methods #3159, object-runtime #3160) need
 * builtins whose params/returns/callees are NOT unary f64: externref
 * params, void kernels, i32 results, and ctx-bound `ref_null { typeIdx }`
 * raw-array params. The generalized path carries explicit positional
 * param types + a typed callee map, flowing through from-ast's existing
 * `paramTypeOverrides` / `returnTypeOverride`. It is deliberately NOT
 * process-memoized: a `typeIdx` inside a def's types is only meaningful
 * in the CodegenContext that registered it, so the IR must be rebuilt
 * per emission. That costs little — `emitSelfHostedFunc` early-returns
 * via `ctx.funcMap` (once per compilation, the same lifecycle the hand
 * `Instr[]` bodies had). The global/named-type scope guard stays: raw
 * ValType refs (`ref_null`) are `val`-kind and never hit `resolveType`,
 * while any accidental use of module globals or symbolic named types in
 * stdlib source remains a loud compile error.
 *
 * Caller-side dialect rule: from-ast validates direct-call args by EXACT
 * IrType equality (`irTypeArgAssignable`) — declare numeric index params
 * as `f64` in callee sigs (kernels trunc internally); there is no
 * implicit f64→i32 argument coercion. Params whose type isn't spellable
 * as a TS primitive should be annotated `unknown` in the source (a
 * non-primitive annotation defers to the positional override). Void
 * builtins must end with an explicit `return;` — a loop is not a valid
 * tail statement in the IR subset (`lowerTail`).
 */

import { ts } from "../ts-api.js";
import { lowerFunctionAstToIr, type IrFromAstResolver } from "../ir/from-ast.js";
import { collectIrDirectCallLoweringPlans, type IrDirectCallTarget } from "../ir/ast-lowering-plans.js";
import { irIntrinsicFuncRef, irRuntimeFuncRef } from "../ir/callable-bindings.js";
import { irVal, type IrFunction, type IrType } from "../ir/nodes.js";
import { IR_VEC_ELEM_SET_PREFIX, parseIrVectorRuntimeElement } from "../ir/vector-runtime.js";
import { prepareIrRuntimeManifest } from "../ir/intrinsic-support.js";
import { isIntrinsicId } from "../ir/intrinsics.js";
import { createDerivedIrUnitId, createIrSourceId, type IrSyntheticUnitRole, type IrUnitId } from "../ir/identity.js";
import type { Instr, ValType } from "../ir/types.js";
import { ensureNativeCharCodeAtHelper, NATIVE_CHARCODEAT_FN } from "./char-code-at-helpers.js";
import { ensureVecElemSet, ensureVecElemSetForElement, VEC_ELEM_SET_PREFIX } from "./vec-elem-set.js";
import { constantFold } from "../ir/passes/constant-fold.js";
import { deadCode } from "../ir/passes/dead-code.js";
import { simplifyCFG } from "../ir/passes/simplify-cfg.js";
import { verifyIrFunction } from "../ir/verify.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../ir/lower.js";
import type { StdlibMathBuiltin } from "../stdlib/math.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, nativeStrHelperHandle, pushDefinedFunc } from "./func-space.js";
import { ensureExnTag } from "./registry/imports.js";

const F64: IrType = irVal({ kind: "f64" });

function selfHostedCalleeRef(name: string) {
  return name.startsWith(IR_VEC_ELEM_SET_PREFIX) ||
    name.startsWith(VEC_ELEM_SET_PREFIX) ||
    name === NATIVE_CHARCODEAT_FN
    ? irIntrinsicFuncRef(name)
    : irRuntimeFuncRef(name);
}

/**
 * #3161 — a self-hosted builtin with an explicit typed signature. The
 * generalized shape behind the `StdlibMathBuiltin` pilot descriptor:
 * positional param types + a typed callee map instead of the pilot's
 * implicit "everything is unary f64".
 *
 * `paramTypes` is positional and override-authoritative: a param whose
 * type has no TS-primitive spelling (externref, `ref_null { typeIdx }`)
 * should be annotated `unknown` in `source` — from-ast's `resolveIrType`
 * defers non-primitive annotations to the override, and REJECTS a
 * primitive annotation that disagrees with it (typo guard).
 * `returnType: null` means void (zero Wasm results; bare `return;` /
 * fall-through tails, statement-position calls only — #1228 / #2856 C4).
 */
export interface SelfHostedFuncDef {
  /** funcMap registration name — also the function's name in `source`. */
  readonly name: string;
  /** Ordinary TS source, IR-claimable subset. */
  readonly source: string;
  /** Positional param IrTypes (may carry ctx-bound typeIdx refs). */
  readonly paramTypes: readonly IrType[];
  /** Return IrType; null == void. */
  readonly returnType: IrType | null;
  /** Typed signatures for every direct callee in `source`. */
  readonly calleeTypes: ReadonlyMap<string, { params: readonly IrType[]; returnType: IrType | null }>;
  /**
   * Optional process-lifetime memo key. Set ONLY for a CONTEXT-FREE def —
   * one whose `paramTypes` / `returnType` / callee sigs carry no ctx-bound
   * `{ typeIdx }` ref (all abstract scalars / string / externref). The
   * memoized `IrFunction` is shared across every compilation, so a def with
   * a ctx-relative type must NOT set this (its typeIdx would leak across
   * contexts). The math family (all `(f64) -> f64`) sets it (keyed by
   * builtin name); the generalized families (raw-array/typeIdx params)
   * leave it unset and rebuild per emission — bounded to once per
   * compilation by `emitSelfHostedFunc`'s funcMap early-return.
   */
  readonly memoKey?: string;
  /**
   * (#3256 Tier-1) Opt-in from-ast dialect for the STRING family: installs a
   * context-free native-strings `stringMethodPlan` resolver at BUILD time so
   * the source may use string method syntax (`s.charCodeAt(i)`,
   * `s.substring(a, b)`) and string-typed params/locals. When emitted through
   * `emitSelfHostedFunc`, the build resolver ALSO carries the live ctx's
   * `resolveString()` (mutated string `let`s bind as slots whose Wasm-local
   * type is the ctx-bound `(ref $AnyString)`), so dialect defs must NOT set
   * `memoKey` — the baked slot typeIdx is only meaningful in the registering
   * CodegenContext. Families that don't set this build exactly as before (no
   * resolver — any accidental string-method use remains a loud error), which
   * keeps the math/timsort/object defs byte-inert by construction.
   */
  readonly dialect?: "native-strings";
}

/**
 * (#3256) The native-mode string-method decision table the stdlib string
 * sources are allowed to use. Deliberately a SUBSET of integration.ts's
 * `stringMethodPlan` (only the methods the family's sources need), and
 * context-free: every entry bakes only symbolic func names + index reps.
 * Unknown methods return null, which from-ast surfaces as a loud build
 * error — the same scope-guard discipline as the pilot's throwing resolver.
 */
const NATIVE_STRING_METHOD_PLANS: ReadonlyMap<
  string,
  {
    funcName: string;
    indexArgRep: "f64" | "i32";
    padOmitted: "host" | "native-slice-len" | "native-substring" | "charcode-zero";
  }
> = new Map([
  // (#3156) guarded `(recv, i32) -> f64` helper, materialized on demand by
  // the driver's resolveFunc (ensureNativeCharCodeAtHelper).
  ["charCodeAt", { funcName: NATIVE_CHARCODEAT_FN, indexArgRep: "i32", padOmitted: "charcode-zero" as const }],
  // (#3156) `__str_substring` clamps both i32 indices to [0, len].
  ["substring", { funcName: "__str_substring", indexArgRep: "i32", padOmitted: "native-substring" as const }],
]);

const NATIVE_STRINGS_FROMAST_RESOLVER: IrFromAstResolver = {
  // (#2955 slices 3/4) The de-polymorphed from-ast arms consult these
  // resolver-owned predicates instead of `nativeStrings()`. This build
  // resolver MUST implement them explicitly: the from-ast reads preserve
  // their legacy resolver-ABSENT defaults, and for `stringIsExternref` that
  // default (host-shaped → pass-through) is the OPPOSITE of what a
  // native-strings build wants — omitting it would let a `(ref $AnyString)`
  // silently flow into an externref-expected position instead of surfacing
  // the loud demote-throw this resolver's scope-guard discipline relies on.
  stringIsExternref(): boolean {
    return false;
  },
  // Native-strings builds own no JS-host imports: no f64⇄externref box pair,
  // no `number_toString`. (The absent-defaults already demote for these —
  // implemented explicitly so the capability surface is total, not luck.)
  hasHostNumberBox(): boolean {
    return false;
  },
  hasHostBooleanBox(): boolean {
    return false;
  },
  hasHostNumberToString(): boolean {
    return false;
  },
  // (#2955 slice 5) Native-strings builds iterate strings via the
  // `__str_charAt` counter loop — the plan-absent default is iter-host
  // (`__iterator` host import), which a host-free build must never emit.
  stringForOfPlan(): "char-loop" | "iter-host" {
    return "char-loop";
  },
  stringMethodPlan(method: string) {
    return NATIVE_STRING_METHOD_PLANS.get(method) ?? null;
  },
};

/**
 * (#3256) Build-time from-ast resolver for `dialect: "native-strings"` defs,
 * bound to the live ctx: the plan table + `resolveString()` (needed by
 * from-ast's string-SLOT binding for mutated string `let`s — it bakes the
 * slot's `(ref $AnyString)` Wasm-local type into the IR, which is exactly why
 * dialect defs carry no `memoKey`).
 */
function makeNativeStringsBuildResolver(ctx: CodegenContext): IrFromAstResolver {
  return {
    ...NATIVE_STRINGS_FROMAST_RESOLVER,
    resolveString(): ValType {
      if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
        return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
      }
      return { kind: "externref" };
    },
  };
}

type SelfHostedIrTemplate = Omit<IrFunction, "unitId">;

interface SelfHostedIrCacheEntry {
  readonly fingerprint: string;
  readonly template: SelfHostedIrTemplate;
}

const SELF_HOSTED_SOURCE_ID = createIrSourceId({
  kind: "synthetic",
  order: 0,
  sourceKey: "@compiler/stdlib-selfhost",
});

/** Stable non-source artifact ID for one self-hosted runtime-support role. */
export function createSelfHostedIrUnitId(role: string): IrUnitId {
  if (role.length === 0) throw new Error("stdlib-selfhost: artifact role must not be empty");
  return createDerivedIrUnitId({
    parentId: SELF_HOSTED_SOURCE_ID,
    role: `stdlib-selfhost:${role}` as IrSyntheticUnitRole,
    ordinal: 0,
  });
}

function selfHostedTemplate(ir: IrFunction): SelfHostedIrTemplate {
  const { unitId: _unitId, ...template } = ir;
  return template;
}

function materializeSelfHostedIr(template: SelfHostedIrTemplate, unitId: IrUnitId): IrFunction {
  return { unitId, ...template };
}

function irTypeContainsContextIndex(type: IrType, seen = new Set<object>()): boolean {
  switch (type.kind) {
    case "val":
      return "typeIdx" in type.val;
    case "object":
      return type.shape.fields.some((field) => irTypeContainsContextIndex(field.type, seen));
    case "vec":
      return irTypeContainsContextIndex(type.elementType, seen);
    case "closure":
    case "callable":
      return (
        type.signature.params.some((param) => irTypeContainsContextIndex(param, seen)) ||
        (type.signature.returnType !== null && irTypeContainsContextIndex(type.signature.returnType, seen))
      );
    case "class": {
      if (seen.has(type.shape)) return false;
      seen.add(type.shape);
      return (
        type.shape.fields.some((field) => irTypeContainsContextIndex(field.type, seen)) ||
        type.shape.methods.some(
          (method) =>
            method.params.some((param) => irTypeContainsContextIndex(param, seen)) ||
            (method.returnType !== null && irTypeContainsContextIndex(method.returnType, seen)),
        ) ||
        type.shape.constructorParams.some((param) => irTypeContainsContextIndex(param, seen)) ||
        (type.shape.parent !== undefined &&
          irTypeContainsContextIndex({ kind: "class", shape: type.shape.parent }, seen))
      );
    }
    case "union":
      return type.members.some((member) => irTypeContainsContextIndex(member, seen));
    case "boxed":
      return irTypeContainsContextIndex(type.inner, seen);
    case "string":
    case "extern":
    case "dynamic":
      return false;
  }
}

function assertMemoEligible(def: SelfHostedFuncDef, fromAst: IrFromAstResolver | undefined): void {
  if (fromAst !== undefined || def.dialect !== undefined) {
    throw new Error(`stdlib-selfhost: ${def.name} sets memoKey but was built with a ctx-bound resolver`);
  }
  const signatures = [
    ...def.paramTypes,
    ...(def.returnType === null ? [] : [def.returnType]),
    ...[...def.calleeTypes.values()].flatMap((signature) => [
      ...signature.params,
      ...(signature.returnType === null ? [] : [signature.returnType]),
    ]),
  ];
  if (signatures.some((type) => irTypeContainsContextIndex(type))) {
    throw new Error(`stdlib-selfhost: ${def.name} sets memoKey but carries a context-relative type index`);
  }
}

function selfHostedFingerprint(def: SelfHostedFuncDef): string {
  return JSON.stringify({
    name: def.name,
    source: def.source,
    paramTypes: def.paramTypes,
    returnType: def.returnType,
    dialect: def.dialect ?? null,
    callees: [...def.calleeTypes.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, signature]) => ({ name, params: signature.params, returnType: signature.returnType })),
  });
}

/** Process-lifetime cache: memoKey → immutable, identity-free template. */
const irCache = new Map<string, SelfHostedIrCacheEntry>();

/**
 * #3161 — parse a typed self-hosted builtin's TS source and lower it to
 * a verified, optimized `IrFunction`.
 *
 * Memoized ONLY when `def.memoKey` is set (a context-free def — see the
 * field doc). A def carrying ctx-bound `{ typeIdx }` refs leaves memoKey
 * unset and is rebuilt per emission, because a memoized IR would leak a
 * typeIdx that is only meaningful in the registering CodegenContext;
 * `emitSelfHostedFunc`'s funcMap early-return bounds that rebuild to once
 * per compilation.
 *
 * Exported separately from the emit glue so the widened dialect shapes
 * are unit-testable without constructing a CodegenContext (the build
 * stage is a pure function of the def).
 */
export function buildSelfHostedIr(def: SelfHostedFuncDef, unitId: IrUnitId, fromAst?: IrFromAstResolver): IrFunction {
  let fingerprint: string | undefined;
  if (def.memoKey !== undefined) {
    assertMemoEligible(def, fromAst);
    fingerprint = selfHostedFingerprint(def);
    const cached = irCache.get(def.memoKey);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new Error(`stdlib-selfhost: memoKey ${JSON.stringify(def.memoKey)} was reused for a different template`);
      }
      return materializeSelfHostedIr(cached.template, unitId);
    }
  }
  const sourceFile = ts.createSourceFile(
    `stdlib/${def.name}.ts`,
    def.source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const fnDecl = sourceFile.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === def.name,
  );
  if (!fnDecl) {
    throw new Error(`stdlib-selfhost: source for ${def.name} has no matching function declaration`);
  }
  if (fnDecl.parameters.length !== def.paramTypes.length) {
    throw new Error(
      `stdlib-selfhost: ${def.name} declares ${fnDecl.parameters.length} params but paramTypes has ${def.paramTypes.length}`,
    );
  }

  const { main, lifted } = lowerFunctionAstToIr(fnDecl, {
    ownerUnitId: unitId,
    funcName: def.name,
    exported: false,
    calleeTypes: def.calleeTypes,
    directCalls: collectIrDirectCallLoweringPlans(
      fnDecl,
      unitId,
      new Map<string, IrDirectCallTarget>(
        [...def.calleeTypes].map(([name, signature]) => [
          name,
          {
            target: selfHostedCalleeRef(name),
            signature,
          },
        ]),
      ),
    ),
    paramTypeOverrides: def.paramTypes,
    returnTypeOverride: def.returnType,
    // (#3256) string-family dialect: the caller-supplied ctx-bound resolver
    // (emitSelfHostedFunc), or the context-free plan table for resolver-less
    // unit builds; absent for every other family (see the field doc).
    resolver: fromAst ?? (def.dialect === "native-strings" ? NATIVE_STRINGS_FROMAST_RESOLVER : undefined),
  });
  if (lifted.length > 0) {
    throw new Error(`stdlib-selfhost: ${def.name} unexpectedly produced ${lifted.length} lifted functions`);
  }

  const buildErrors = verifyIrFunction(main);
  if (buildErrors.length > 0) {
    throw new Error(`stdlib-selfhost: IR verify failed for ${def.name}: ${buildErrors[0]!.message}`);
  }

  // Same hygiene pipeline integration.ts runs (constantFold → deadCode →
  // simplifyCFG to fixpoint; each pass returns the same reference when it
  // makes no change).
  let ir = main;
  for (let iter = 0; iter < 10; iter++) {
    const next = simplifyCFG(deadCode(constantFold(ir)));
    if (next === ir) break;
    ir = next;
  }

  const postErrors = verifyIrFunction(ir);
  if (postErrors.length > 0) {
    throw new Error(`stdlib-selfhost: post-pass IR verify failed for ${def.name}: ${postErrors[0]!.message}`);
  }

  const template = selfHostedTemplate(ir);
  if (def.memoKey !== undefined) irCache.set(def.memoKey, { fingerprint: fingerprint!, template });
  return materializeSelfHostedIr(template, unitId);
}

/**
 * Build the generalized `SelfHostedFuncDef` for a math-pilot builtin.
 * Sibling math helpers are all unary `(f64) -> f64`; the f64 param/return
 * overrides agree with the sources' `: number` annotations (enforced by
 * from-ast's `resolveIrType`), so lowering through the generalized builder
 * yields IR identical to the pilot's un-overridden path. Context-free, so
 * `memoKey` is set to the builtin name.
 */
function mathBuiltinDef(builtin: StdlibMathBuiltin): SelfHostedFuncDef {
  const calleeTypes = new Map<string, { params: readonly IrType[]; returnType: IrType | null }>();
  for (const callee of builtin.callees) {
    calleeTypes.set(callee, { params: [F64], returnType: F64 });
  }
  // Arity 1 (default) or 2 (`atan2(y, x)`, `pow(base, exp)`) — every param is
  // f64 either way, matching the sources' `: number` annotations. Context-free,
  // so memoize.
  const paramTypes: IrType[] = builtin.arity === 2 ? [F64, F64] : [F64];
  return {
    name: builtin.name,
    source: builtin.source,
    paramTypes,
    returnType: F64,
    calleeTypes,
    memoKey: builtin.name,
  };
}

/**
 * #3161 — lower a typed self-hosted builtin against the live context and
 * register it as a defined function under `def.name`. Same registration
 * discipline as the math path (stable-regime mint + push, funcMap entry,
 * `exported: false`) so call sites cannot tell the difference from the
 * hand-emitted `Instr[]` body it replaces.
 *
 * Idempotent: early-returns the existing funcIdx when `def.name` is
 * already registered (mirrors the `ensure*` convention of the hand
 * emitters this replaces).
 *
 * Precondition: every callee in `def.calleeTypes` that the source
 * actually calls is already registered in `ctx.funcMap` (families
 * convert leaf-first; retained hand kernels are emitted before the
 * self-hosted bodies that call them).
 */
export function emitSelfHostedFunc(ctx: CodegenContext, def: SelfHostedFuncDef): number {
  const existing = ctx.funcMap.get(def.name);
  if (existing !== undefined) return existing;

  // (#3256) native-strings defs build against the live ctx (string-slot
  // ValTypes need resolveString()); everything else stays resolver-less.
  const fromAst = def.dialect === "native-strings" ? makeNativeStringsBuildResolver(ctx) : undefined;
  const ir = buildSelfHostedIr(def, createSelfHostedIrUnitId(def.name), fromAst);
  const prepared = prepareIrRuntimeManifest({
    functions: [ir],
    sourceFile: `<stdlib:${def.name}>`,
    policy: {
      target: ctx.wasi ? "wasi" : ctx.standalone ? "standalone" : ctx.strictNoHostImports ? "strict-no-host" : "host",
      backend: "wasmgc",
    },
  });
  const funcIdx = lowerAndRegister(ctx, def.name, prepared?.functions[0] ?? ir);
  return funcIdx;
}

/**
 * (#3256 Tier-1) Resolve a native-string runtime helper's funcIdx.
 *
 * (#3909) Ordering matters, and it is the opposite of what the original
 * comment assumed. `ctx.nativeStrHelpers` entries are minted by
 * `mintDefinedFunc`, so since #1916 S3 they are **STABLE-regime handles**
 * (`>= STABLE_FUNC_BASE`): layout-independent ids that no shifter touches and
 * that `resolveLayout` maps to a concrete index once, at emit. A stable handle
 * is therefore the *authoritative* identity and can never go stale.
 *
 * The `ctx.numImportFuncs + i` name scan below yields a **LIVE-regime**
 * absolute index instead — a number that is only correct until the next import
 * lands, after which it depends on every shifter (`shiftLateImportIndices`,
 * `reconcileNativeStrFinalizeShift`, dead-elim's renumber) covering it. Running
 * that scan *first* silently downgraded an already-correct stable handle to a
 * fragile live index.
 *
 * That downgrade is #3909: in a module with enough import churn (JSON.stringify
 * + a regex + one more string feature is the minimal trigger — the regex adds
 * `RegExp_new`/`string_match`, JSON adds `JSON_stringify` and the
 * `__str_from_mem`/`__str_to_mem`/`__str_extern_len` bridge), the baked live
 * index for `__str_substring` ended up exactly one below the real slot. The
 * self-hosted `__str_trimStart` body then called `__str_compare` — arity 2, not
 * 3 — and the module failed validation with
 * "call[0] expected type (ref null 6), found i32.trunc_sat_f64_s of type i32".
 * Single-feature modules never reached the desync, which is why it looked like
 * a three-feature interaction.
 *
 * So: funcMap first (unchanged), then any STABLE handle, and only then the
 * live-regime name scan — which remains as the fallback for helpers registered
 * before stable minting (a live entry in `nativeStrHelpers` really can be
 * stale, which is the case the scan was written for). That ordering lives in
 * the shared `nativeStrHelperHandle` (src/codegen/func-space.ts), which every
 * helper-by-name resolver now goes through.
 */
function resolveNativeStrHelper(ctx: CodegenContext, helperName: string): number | null {
  const idx = ctx.funcMap.get(helperName);
  if (idx !== undefined) return idx;
  return nativeStrHelperHandle(ctx, helperName) ?? null;
}

/** Shared lowering + registration glue for both driver paths. */
function lowerAndRegister(ctx: CodegenContext, name: string, ir: IrFunction): number {
  // (#3256) String-backend guard: the Tier-1 string hooks below serve the
  // native-strings families ONLY (they are emitted from inside
  // `ensureNativeStringHelpers`, which exists only in native mode). A string
  // op reaching lowering in host-strings mode means a def was emitted from
  // the wrong place — fail loudly rather than miscompile.
  const requireNativeStrings = (what: string): void => {
    if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) {
      throw new Error(
        `stdlib-selfhost: ${name} needs ${what} but the compilation is not in native-strings mode — ` +
          `string-family builtins must be emitted from ensureNativeStringHelpers`,
      );
    }
  };
  const resolver: IrLowerResolver = {
    resolveFunc(ref) {
      if (ref.binding.kind === "unit") {
        throw new Error(
          `stdlib-selfhost: ${name} cannot resolve source unit ${ref.binding.unitId} / ${ref.name} through the runtime provider`,
        );
      }
      // (#3257 Tier-2) `__vec_elem_set_<vecTypeIdx>` — element-store helper
      // with full legacy grow semantics, materialized on demand (mirrors
      // integration.ts's arm: append-only defined function, never an import,
      // idempotent via funcMap). NOTE for stdlib authors: the helper's real
      // ABI takes an i32 index — a TS-source caller must declare that exact
      // sig in calleeTypes and produce an i32 arg (e.g. a comparison result);
      // f64 index arithmetic needs an `__arri_*`-style f64-ABI wrapper.
      if (ref.binding.kind === "intrinsic" && ref.binding.symbol.startsWith(IR_VEC_ELEM_SET_PREFIX)) {
        const element = parseIrVectorRuntimeElement(ref.binding.symbol, IR_VEC_ELEM_SET_PREFIX);
        const helperIdx = element ? ensureVecElemSetForElement(ctx, element) : null;
        if (helperIdx === null) {
          throw new Error(`stdlib-selfhost: ${name} cannot materialize ${ref.name} (unsupported logical vec)`);
        }
        return helperIdx;
      }
      if (ref.binding.kind === "intrinsic" && ref.binding.symbol.startsWith(VEC_ELEM_SET_PREFIX)) {
        const vecTypeIdx = Number(ref.binding.symbol.slice(VEC_ELEM_SET_PREFIX.length));
        const helperIdx = Number.isInteger(vecTypeIdx) ? ensureVecElemSet(ctx, vecTypeIdx) : null;
        if (helperIdx === null) {
          throw new Error(`stdlib-selfhost: ${name} cannot materialize ${ref.name} (not a recognisable vec struct)`);
        }
        return helperIdx;
      }
      // (#3256) Guarded native charCodeAt — materialized on demand, same
      // append-only defined-function discipline as integration.ts's arm
      // (never an import, no existing funcIdx shifts; idempotent via funcMap).
      if (ref.binding.kind === "intrinsic" && ref.binding.symbol === NATIVE_CHARCODEAT_FN) {
        const helperIdx = ensureNativeCharCodeAtHelper(ctx);
        if (helperIdx === null) {
          throw new Error(
            `stdlib-selfhost: ${name} cannot materialize ${ref.name} (native-string helpers unavailable)`,
          );
        }
        return helperIdx;
      }
      if (ref.binding.kind === "intrinsic" && isIntrinsicId(ref.binding.symbol)) {
        const providerIdx = ctx.funcMap.get(ref.name);
        if (providerIdx !== undefined) return providerIdx;
        throw new Error(`stdlib-selfhost: ${name} cannot resolve prepared intrinsic provider ${ref.name}`);
      }
      const adapterName =
        ref.binding.kind === "runtime" || ref.binding.kind === "intrinsic"
          ? ref.binding.symbol
          : ref.binding.kind === "import"
            ? ref.binding.field
            : ref.name;
      const idx = ctx.funcMap.get(adapterName);
      if (idx !== undefined) return idx;
      // (#3256 Tier-1) makeResolver's name-fallback: native-string kernels
      // (`__str_flatten`, `__str_substring`, …) live in `ctx.nativeStrHelpers`,
      // not `ctx.funcMap`; re-resolve by name against the post-shift function
      // table first, helpers map last (see resolveNativeStrHelper).
      const helperIdx = resolveNativeStrHelper(ctx, adapterName);
      if (helperIdx !== null) return helperIdx;
      throw new Error(
        `stdlib-selfhost: ${name} calls "${ref.name}" but it is not registered yet — ` +
          `emit callees leaf-first (check the family's phase ordering)`,
      );
    },
    resolveGlobal(ref) {
      throw new Error(`stdlib-selfhost: ${name} must not reference globals (got "${ref.name}")`);
    },
    resolveType(ref) {
      // No current stdlib source emits an explicit symbolic type ref. The
      // string struct flows through resolveString as a ValType; future type
      // producers must attach a ProgramAbiSession locator before widening.
      throw new Error(
        `stdlib-selfhost: ${name} cannot resolve symbolic type binding ${ref.binding.bindingId} (${ref.name})`,
      );
    },
    internFuncType(type) {
      return addFuncType(ctx, type.params, type.results, type.name);
    },
    // -----------------------------------------------------------------
    // (#3256 Tier-1) String backend — native-strings mode only. Mirrors
    // the corresponding makeResolver arms (src/ir/integration.ts), resolving
    // helper indices by post-shift name scan at emission time; later import
    // shifts are repaired uniformly by reconcileNativeStrFinalizeShift,
    // exactly as for the hand-emitted sibling bodies.
    // -----------------------------------------------------------------
    nativeStrings(): boolean {
      return ctx.nativeStrings;
    },
    ensureExnTag(): number {
      return ensureExnTag(ctx);
    },
    standardizedExceptions(): boolean {
      return ctx.standalone || ctx.wasi;
    },
    resolveString(): ValType {
      if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
        return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
      }
      return { kind: "externref" };
    },
    emitStringConst(value: string): readonly Instr[] {
      requireNativeStrings("string.const");
      // Inline WTF-16 literal — same shape as makeResolver's native arm /
      // legacy compileNativeStringLiteral (i16 path; stdlib sources carry no
      // utf8-storage alloc annotations).
      const ops: Instr[] = [
        { op: "i32.const", value: value.length },
        { op: "i32.const", value: 0 },
      ];
      for (let i = 0; i < value.length; i++) {
        ops.push({ op: "i32.const", value: value.charCodeAt(i) });
      }
      ops.push({ op: "array.new_fixed", typeIdx: ctx.nativeStrDataTypeIdx, length: value.length });
      ops.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
      return ops;
    },
    emitStringConcat(): readonly Instr[] {
      requireNativeStrings("string.concat");
      const idx = resolveNativeStrHelper(ctx, "__str_concat");
      if (idx === null) throw new Error(`stdlib-selfhost: ${name} needs __str_concat but it is not registered`);
      return [{ op: "call", funcIdx: idx }];
    },
    emitStringEquals(): readonly Instr[] {
      requireNativeStrings("string.eq");
      const idx = resolveNativeStrHelper(ctx, "__str_equals");
      if (idx === null) throw new Error(`stdlib-selfhost: ${name} needs __str_equals but it is not registered`);
      return [{ op: "call", funcIdx: idx }];
    },
    emitStringLen(): readonly Instr[] {
      requireNativeStrings("string.len");
      // AnyString.length is field 0 (cons strings carry the total length,
      // so no flatten is needed — matches makeResolver's native arm).
      return [{ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 }];
    },
  };

  const { func } = lowerIrFunctionToWasm(ir, resolver);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx: func.typeIdx,
    locals: func.locals,
    body: func.body,
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

/**
 * Lower a self-hosted math builtin against the live context and register
 * it as a defined function under `builtin.name`. Mirrors the hand path's
 * `addMathFunc` registration discipline (stable-regime mint + push,
 * funcMap entry) so call sites cannot tell the difference.
 *
 * Precondition: every name in `builtin.callees` is already registered in
 * `ctx.funcMap` (emitInlineMathFunctions emits Phase-1 cores first).
 *
 * Thin adapter over the generalized `emitSelfHostedFunc` — the math pilot
 * and scale-up families share one emit path (the def carries a `memoKey`
 * so the context-free math IR is still process-cached).
 */
export function emitSelfHostedMathFunc(ctx: CodegenContext, builtin: StdlibMathBuiltin): number {
  return emitSelfHostedFunc(ctx, mathBuiltinDef(builtin));
}
