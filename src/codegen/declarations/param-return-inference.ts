// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1121 parameter/return numeric-type inference. Pure AST + checker analyses
 * that return a ValType/Map and mutate nothing on ctx. Extracted verbatim from
 * codegen/declarations.ts (#3268).
 */
import type { DtsSeedAtom } from "../../checker/dts-entrypoint-seeds.js";
import { isVoidType, unwrapPromiseType } from "../../checker/type-mapper.js";
import { isSyntacticallyBooleanExpr } from "../../checker/oracle.js";
import { fnctorCtorParamTypesFlagEnabled, numericReturnsFlagEnabled } from "../../derivation-flags.js";
import { forEachChild, ts } from "../../ts-api.js";
import { numericAdmissionEnabled } from "../analysis/mixed-assignment-carrier.js";
import { isStandalonePromiseActive } from "../async-scheduler.js";
import { hasAsyncModifier, resolveWasmType } from "../index.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

export function resolveGenericCallSiteTypes(
  ctx: CodegenContext,
  funcName: string,
  implementation: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  resolveMissingParam: (parameter: ts.ParameterDeclaration, index: number) => ValType,
): { params: ValType[]; results: ValType[] } | null {
  let found: { params: ValType[]; results: ValType[] } | null = null;
  const implementationArity = implementation.parameters.length;

  function visit(node: ts.Node) {
    if (found && found.params.length >= implementationArity) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === funcName) {
      const sig = ctx.checker.getResolvedSignature(node);
      if (sig) {
        const params: ValType[] = [];
        const sigParams = sig.getParameters();
        for (let i = 0; i < sigParams.length; i++) {
          const paramType = ctx.checker.getTypeOfSymbol(sigParams[i]!);
          params.push(resolveWasmType(ctx, paramType));
        }
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        // (#2905) Carrier own-return guard. resolveWasmType(Promise<T>) lowers to
        // externref under the native $Promise carrier (index.ts), but an async
        // callee's OWN wasm result is the unwrapped T — its body returns raw T;
        // wrapAsyncReturn boxes to $Promise only at the *call* site. So for an
        // async callee under the carrier, pre-unwrap to keep this inferred
        // signature matching the actually-compiled fn (else externref-result vs
        // f64-body = invalid Wasm). Gated on the carrier so off-carrier bytes are
        // identical (effRet === retType). Non-async fns returning Promise<T> keep
        // retType → resolveWasmType → externref, which is correct (body returns a
        // real promise). Mirrors the main async-return sites (e.g. :2930).
        const callDecl = sig.getDeclaration();
        const calleeIsAsync = callDecl ? hasAsyncModifier(callDecl) : false;
        const effRetType =
          isStandalonePromiseActive(ctx) && calleeIsAsync ? unwrapPromiseType(retType, ctx.checker) : retType;
        const results: ValType[] = isVoidType(effRetType) ? [] : [resolveWasmType(ctx, effRetType)];
        if (!found) {
          found = { params, results };
        } else if (params.length > found.params.length) {
          // (#4268) Preserve the first call's established specialization and
          // result ABI, but append slots from a resolved wider overload. A
          // short overload cannot erase parameters owned by the implementation.
          found = { params: [...found.params, ...params.slice(found.params.length)], results: found.results };
        }
      }
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);
  // TypeScript does not model assignments made by the recursive visitor when
  // narrowing the captured variable after forEachChild returns.
  const resolved = found as { params: ValType[]; results: ValType[] } | null;
  if (!resolved || resolved.params.length >= implementationArity) return resolved;

  // No local call supplies every implementation parameter. Keep the omitted
  // optional slots with conservative declaration-derived carriers so body
  // locals and call-site padding still share a complete ABI.
  const params = [...resolved.params];
  for (let i = params.length; i < implementationArity; i++) {
    params.push(resolveMissingParam(implementation.parameters[i]!, i));
  }
  return { params, results: resolved.results };
}

// ---------------------------------------------------------------------------
// (#743) `.d.ts` entrypoint seeds — legacy-lane consumers.
//
// The seed map on `ctx.dtsEntrypointSeeds` is the SAME object the IR fixpoint
// seeds from (`applyDtsEntrypointSeeds` in src/ir/propagate.ts); consuming it
// here keeps the two lanes' seed facts identical, which is what prevents
// "function typeIdx parity mismatch" demotions. Two consumers:
//
//  1. The seeded entrypoint's OWN param (`inferImplicitAnyParamType`,
//     `sawCallSite === false` arm only, #3471): the claim applies exactly when
//     there is no internal evidence at all.
//  2. ONE-HOP forwarding (`dtsSeedValTypeForArgIdentifier`): a call/new ARG
//     that is literally a seeded entrypoint's parameter identifier types as
//     the seed — mirroring the fixpoint's first propagation hop. Without this
//     the fixpoint types a downstream callee's param while this single-hop
//     scan cannot, and the IR claim demotes on ABI parity. Gated on the same
//     condition under which the entrypoint's own signature takes the seed
//     (no internal call sites — evidence always beats the claim).
// ---------------------------------------------------------------------------

const internalCallSiteMemo = new WeakMap<ts.SourceFile, Map<string, boolean>>();

/** Does ANY internal `f(…)` / `new f(…)` identifier site exist? (name walk only — no typing, no recursion) */
function hasInternalCallSites(funcName: string, sourceFile: ts.SourceFile): boolean {
  let memo = internalCallSiteMemo.get(sourceFile);
  if (!memo) {
    memo = new Map();
    internalCallSiteMemo.set(sourceFile, memo);
  }
  const cached = memo.get(funcName);
  if (cached !== undefined) return cached;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === funcName
    ) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  memo.set(funcName, found);
  return found;
}

/**
 * Lower a seed atom to this compile's ABI. `string` narrows only in
 * native-string lanes where the ref-typed export boundary traps a violating
 * external call; in externref-string lanes it is a deliberate no-op (the param
 * stays externref — identical to unseeded), so the claim can never be read
 * blindly. `f64` is guarded by the JS API's ToNumber boundary coercion.
 */
function dtsSeedAtomToValType(ctx: CodegenContext, atom: DtsSeedAtom): ValType | null {
  if (atom === "f64") return { kind: "f64" };
  if (atom === "string" && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  }
  return null;
}

/** Seed atom for a parameter of `decl` when it is a seeded top-level entrypoint. */
function dtsSeedForParam(ctx: CodegenContext, decl: ts.Node | undefined, paramIndex: number): DtsSeedAtom | null {
  const seeds = ctx.dtsEntrypointSeeds;
  if (!seeds || !decl || !ts.isFunctionDeclaration(decl) || !decl.name || !ts.isSourceFile(decl.parent)) return null;
  return seeds.get(decl.name.text)?.[paramIndex] ?? null;
}

/** One-hop seed forwarding for a call-site arg identifier (see block comment above). */
function dtsSeedValTypeForArgIdentifier(ctx: CodegenContext, arg: ts.Identifier): ValType | null {
  if (!ctx.dtsEntrypointSeeds) return null;
  const decl = ctx.oracle.valueDeclarationOf(arg);
  if (!decl || !ts.isParameter(decl) || decl.dotDotDotToken || decl.initializer) return null;
  const fn = decl.parent;
  if (!ts.isFunctionDeclaration(fn) || !fn.name || !ts.isSourceFile(fn.parent)) return null;
  const atom = dtsSeedForParam(ctx, fn, fn.parameters.indexOf(decl));
  if (atom === null) return null;
  // The seed governs the entrypoint's param ONLY when the entrypoint has zero
  // internal call sites (otherwise evidence decides its type, not the claim).
  if (hasInternalCallSites(fn.name.text, fn.getSourceFile())) return null;
  return dtsSeedAtomToValType(ctx, atom);
}

/**
 * Result of scanning a function's call sites for a parameter's type.
 *  - `type`: the concrete wasm type all *conclusive* call sites agree on, or
 *    `null` when there are no conclusive call sites (none at all / all-`any`
 *    args / a type conflict between sites).
 *  - `sawCallSite`: whether *any* internal call to the function was found at
 *    all, regardless of the argument types. This distinguishes "no call sites"
 *    (an exported/host-only entrypoint — body inference is the only signal)
 *    from "called, but with polymorphic/`any` args" (the function is invoked
 *    internally with runtime values whose type we cannot pin — body inference
 *    would be UNSOUND, see `inferParamTypeFromBody`). (#3471)
 */
export interface CallSiteParamInference {
  type: ValType | null;
  sawCallSite: boolean;
  /**
   * (#2867 S2) Whether the function's name is also referenced as a **value**
   * somewhere in the file (`.then(h, h)`, `arr.map(h)`, `x = h`) rather than
   * only as the direct callee of `h(...)` / `new h(...)`. Such a reference
   * creates callers this scan cannot see, so a call-site-agreed GC-`ref`
   * narrowing has no proof behind it. See {@link functionNameEscapesAsValue}.
   */
  escapesAsValue: boolean;
  /**
   * (#4555) Whether some call site supplies FEWER arguments than this
   * parameter's index — i.e. the parameter is observably `undefined` at
   * runtime. Already used to withdraw a native-scalar narrowing; also the
   * proof the numeric-RETURN inference needs before it may promote a
   * `return <param>` to f64. See {@link parameterMayBeUndefined}.
   */
  sawUnderApplied: boolean;
}

/**
 * Infer a concrete type for an untyped function parameter by scanning call sites.
 * When a parameter has no type annotation (TS gives it `any`), we look at every
 * call to that function and collect the argument types at the given index.
 * If all call sites agree on a single concrete wasm type, we return it as `type`.
 * `type` is null if no call site found or types disagree; `sawCallSite` reports
 * whether the function is called internally at all (see #3471 and
 * {@link inferParamTypeFromBody}).
 */
/**
 * (#4416) Call sites bucketed by callee name, built ONCE per source file.
 *
 * `inferParamTypeFromCallSites` used to walk the entire source file looking for
 * calls to one function, and it is invoked once per (function, parameter). That
 * is O(functions x params x programSize) — measured quadratic:
 *
 *     units   calls   AST nodes visited
 *        32     128             184,448
 *       128     512           2,949,632
 *       512    2048          47,187,968     <- 4x input, 16x work
 *
 * 47 million node visits for a 61 KB input, and a CPU profile put this one
 * `visit` at **25.2% of a large compile** (with TypeScript's `forEachChild`
 * underneath it accounting for most of the rest). One walk per source file
 * turns it into O(programSize + functions x params).
 *
 * Keyed on the `SourceFile` object, so a new program (or a rewritten file, e.g.
 * cjs-rewrite) gets a fresh index automatically and nothing needs invalidating.
 * The index holds only nodes reachable from `forEachChild(sourceFile, ...)` —
 * exactly what the old walk saw — so coverage is unchanged, and buckets keep
 * document order so an order-dependent `agreed`/`conflict` accumulation
 * resolves identically.
 */
type CalleeSite = ts.CallExpression | ts.NewExpression;
const callSiteIndexBySourceFile = new WeakMap<ts.SourceFile, Map<string, CalleeSite[]>>();

function calleeNameIndex(sourceFile: ts.SourceFile): Map<string, CalleeSite[]> {
  const cached = callSiteIndexBySourceFile.get(sourceFile);
  if (cached) return cached;
  const index = new Map<string, CalleeSite[]>();
  const visit = (node: ts.Node): void => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      const bucket = index.get(name);
      if (bucket) bucket.push(node as CalleeSite);
      else index.set(name, [node as CalleeSite]);
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  callSiteIndexBySourceFile.set(sourceFile, index);
  return index;
}

/**
 * (#2867 S2) Names referenced as a VALUE, indexed once per source file.
 *
 * `calleeNameIndex` answers "where is `h` called?". It cannot answer "who else
 * can call `h`?" — and that is the question the parameter narrowing actually
 * depends on. A function passed as a first-class value (`p.then(h, h)`,
 * `arr.map(h)`, `cb = h`) acquires callers that are invisible to a call-site
 * scan, so "every call site I can see passes a string" is not evidence that the
 * parameter is a string at runtime.
 *
 * Measured consequence before this guard (standalone lane, 2026-08-15): the
 * test262 async harness's `$DONE(error)` is called directly with message
 * STRINGS (`$DONE('The promise should be rejected…')`) and simultaneously
 * installed as a reaction via `.then($DONE, $DONE)`. The scan agreed on
 * "string", so the parameter lowered to a non-nullable native-string `ref`, and
 * the native `.then` fulfil wrapper's `any.convert_extern` + `ref.cast`
 * (`pushExternrefLocalAsType`) trapped the moment the microtask drive delivered
 * anything else — surfacing as
 * `illegal cast [__then_fulfill_N ← __drain_microtasks]`, the single largest
 * built-ins/Promise failure bucket.
 *
 * Name-keyed and therefore deliberately CONSERVATIVE: a same-named local in
 * another scope also counts as an escape. Over-detecting only costs a
 * narrowing; under-detecting costs a runtime trap. Same one-walk-per-file
 * caching discipline as {@link calleeNameIndex} (#4416) so this stays
 * O(programSize), not O(functions x params x programSize).
 */
const valueRefNameIndexBySourceFile = new WeakMap<ts.SourceFile, Set<string>>();

function valueReferencedNames(sourceFile: ts.SourceFile): Set<string> {
  const cached = valueRefNameIndexBySourceFile.get(sourceFile);
  if (cached) return cached;
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isNonValueIdentifierPosition(node)) names.add(node.text);
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  valueRefNameIndexBySourceFile.set(sourceFile, names);
  return names;
}

/**
 * Identifier positions that are NOT a first-class read of the binding: the
 * direct callee of a call/new (that is the case the call-site scan already
 * models), declaration names, member/property names, and label-like slots.
 * Everything else is treated as a value read.
 */
function isNonValueIdentifierPosition(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) return true;
  // `h(...)` / `new h(...)` — the modelled call site.
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return true;
  // `obj.h` / `{ h: … }` / `h: …` — a property NAME, not this binding.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  // Declaration names — `function h(){}`, `var h = …`, `(h) => …`, `class h {}`.
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if (ts.isFunctionExpression(parent) && parent.name === node) return true;
  if (ts.isClassDeclaration(parent) && parent.name === node) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  if (ts.isBreakOrContinueStatement(parent) && parent.label === node) return true;
  return false;
}

/**
 * (#2867 S2) Does `funcName` appear anywhere in the file other than as the
 * direct callee of a call/new? See {@link valueReferencedNames}.
 */
export function functionNameEscapesAsValue(funcName: string, sourceFile: ts.SourceFile): boolean {
  return valueReferencedNames(sourceFile).has(funcName);
}

export function inferParamTypeFromCallSites(
  ctx: CodegenContext,
  funcName: string,
  paramIndex: number,
  sourceFile: ts.SourceFile,
): CallSiteParamInference {
  let agreed: ValType | null = null;
  let conflict = false;
  let sawCallSite = false;
  let sawUnderApplied = false;
  // (#4491) A call site whose argument's TS type is exclusively `void` /
  // `undefined` — e.g. `verifyEqualTo(arr, "0", getFunc())` where `getFunc`
  // returns nothing. See the withdrawal rule below.
  let sawNullishArg = false;

  const isRecursiveCall = (call: ts.CallExpression | ts.NewExpression): boolean => {
    const target = ctx.oracle.valueDeclarationOf(call.expression);
    for (let owner: ts.Node | undefined = call.parent; owner; owner = owner.parent) {
      if (!ts.isFunctionLike(owner)) continue;
      return (
        owner === target || (target !== undefined && ts.isVariableDeclaration(target) && target.initializer === owner)
      );
    }
    return false;
  };

  function visit(node: CalleeSite) {
    // (#743) `new F(…)` is a call site for F's PARAMETERS exactly as `F(…)` is —
    // same arity rules, same argument-to-parameter mapping, same under-application
    // semantics. Until now only `isCallExpression` matched, so every
    // function-style constructor's parameters were invisible to this inference:
    // acorn's `new Parser(options, input, startPos)` contributed nothing, and its
    // ctor params stayed `any`, which is what seeds 43 of its 96 fnctor field
    // slots as `externref` (#4155 census). Widening the node test is the whole
    // change — the agreement, conflict, under-application (#3548) and recursion
    // (#3961) soundness rules below are shared verbatim.
    //
    // Gated with the field half (`fnctor-ctor-param-types.ts`) on the SAME
    // variable. That module imports this one, so the predicate cannot come from
    // it without a cycle; it comes from the leaf `src/derivation-flags.ts`,
    // which is exactly why that module exists (three readers, one spelling).
    // The two halves must not be separable: narrowing the parameter while the
    // slot stays `externref` re-boxes on every store and measured strictly
    // WORSE than doing nothing (+27 bytes on a one-field fixture).
    // **ON by default since 2026-08-08** — see that module for the acorn numbers.
    // The name and node-kind halves of this test are now the index's job; only
    // the ctor gate is left, because it is a runtime flag rather than a
    // property of the node.
    const ctorSitesEnabled = fnctorCtorParamTypesFlagEnabled();
    if (ts.isCallExpression(node) || (ctorSitesEnabled && ts.isNewExpression(node))) {
      // A matching call exists regardless of arg types — the function IS invoked
      // internally, so its params are determined by runtime call args, not the
      // body-usage fallback. Record this before any conflict short-circuit.
      sawCallSite = true;
      // (#3548) An UNDER-APPLIED call site (`d('m'); d();`) passes `undefined`
      // for this param — record it so a non-nullable ref inference is widened
      // to nullable below. Skipping absent args entirely made the inference
      // UNSOUND: the agreed type became a non-nullable `(ref N)` that the
      // zero-arg call site's pad could only satisfy with `ref.null` +
      // `ref.as_non_null` — an unconditional runtime trap on the (usually
      // passing) zero-arg path.
      // `new F` with no parens has NO argument list at all (`arguments` is
      // undefined, not empty) — that is an under-applied site for every
      // parameter, so treat a missing list as length 0 rather than skipping it.
      const callArgs = node.arguments;
      if ((callArgs?.length ?? 0) <= paramIndex) sawUnderApplied = true;
      if (!conflict) {
        const arg = callArgs?.[paramIndex];
        if (arg) {
          const argType = ctx.checker.getTypeAtLocation(arg);
          // Skip if the argument itself is also `any` — no useful info
          if (argType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
            // (#3780) The checker still reports an untyped JavaScript LOCAL as
            // `any` after the standalone numeric-flow analysis has proved that
            // every definition is numeric and codegen has selected an f64
            // slot. Reuse that stronger, symbol-scoped verdict here so passing
            // such a local to another untyped helper does not immediately box
            // it and lose the proof at the callee ABI.
            //
            // This is not body-use guessing: UsageInference only answers
            // "number" after the grounded definition fixpoint (or its older,
            // all-uses-apply-ToNumber proof), and the oracle's declaration
            // lookup keeps shadowed same-name locals distinct. Parameters and
            // other `any` expressions remain inconclusive exactly as before.
            if (ts.isIdentifier(arg)) {
              const declaration = ctx.oracle.variableDeclarationOf(arg);
              // (#743) One-hop `.d.ts` seed forwarding — a seeded entrypoint's
              // own parameter passed straight through participates with the
              // seed's type, mirroring the IR fixpoint's first hop. Null for
              // every arg outside that exact shape.
              const seededArg = dtsSeedValTypeForArgIdentifier(ctx, arg);
              // Linked standalone graphs also carry a scope-resolved verdict
              // that every definition reaching this binding is a string. This
              // is stronger than the JS checker's `any` and gives downstream
              // implicit-any helpers the native-string ABI without guessing
              // from body use. Under-applied/null/non-string sites contribute
              // opaque definitions to that verdict and therefore fail closed.
              const stringArg =
                ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && ctx.stringLocalVerdict?.(arg, arg.text) === true
                  ? ({ kind: "ref", typeIdx: ctx.anyStrTypeIdx } as ValType)
                  : null;
              if (declaration && ctx.usageInference.scalarForDecl(declaration) === "number") {
                const wasmType: ValType = { kind: "f64" };
                if (agreed === null) agreed = wasmType;
                else if (agreed.kind !== wasmType.kind) conflict = true;
              } else if (stringArg !== null) {
                if (agreed === null) agreed = stringArg;
                else if (
                  agreed.kind !== stringArg.kind ||
                  (agreed.kind === "ref" && stringArg.kind === "ref" && agreed.typeIdx !== stringArg.typeIdx)
                ) {
                  conflict = true;
                }
              } else if (seededArg !== null) {
                if (agreed === null) agreed = seededArg;
                else if (
                  agreed.kind !== seededArg.kind ||
                  (agreed.kind === "ref" &&
                    seededArg.kind === "ref" &&
                    (agreed as { typeIdx: number }).typeIdx !== (seededArg as { typeIdx: number }).typeIdx)
                ) {
                  conflict = true;
                }
              } else if (isRecursiveCall(node)) {
                // (#3961) A dynamic value forwarded recursively is part of the
                // callee's runtime domain. React's `mapIntoArray(children, …)`
                // also has a proven-array call; ignoring the recursive value
                // narrows `children` to a vec and destroys element arguments.
                conflict = true;
              }
            } else if (isRecursiveCall(node)) {
              conflict = true;
            }
          } else {
            // (#4491) `void` / `undefined` maps to i32 in the type mapper
            // ("void → no result, handled in codegen"), which is a lowering
            // convention for a RESULT, not a claim that this argument is the
            // number 0. Record the position; the withdrawal rule below keeps a
            // native scalar from being inferred out of it.
            if ((argType.flags & ~(ts.TypeFlags.Void | ts.TypeFlags.Undefined)) === 0) sawNullishArg = true;
            const wasmType = resolveWasmType(ctx, argType);
            if (agreed === null) {
              agreed = wasmType;
            } else if (agreed.kind !== wasmType.kind) {
              conflict = true;
            } else if (
              (agreed.kind === "ref" || agreed.kind === "ref_null") &&
              (wasmType.kind === "ref" || wasmType.kind === "ref_null") &&
              (agreed as { typeIdx: number }).typeIdx !== (wasmType as { typeIdx: number }).typeIdx
            ) {
              conflict = true;
            }
          }
        }
      }
    }
  }

  // Was `forEachChild(sourceFile, visit)` — a whole-program walk per call.
  for (const site of calleeNameIndex(sourceFile).get(funcName) ?? []) visit(site);
  // (TS control-flow can't see the closure mutation of `agreed` — assert its
  // declared type so the property narrowing below typechecks.)
  let type: ValType | null = conflict ? null : (agreed as ValType | null);
  // (#3548) Soundness: if ANY call site under-applies this param, the value can
  // be `undefined` at runtime, so a NON-NULLABLE ref inference has no valid
  // filler — widen to the nullable ref of the same type (NOT all the way to
  // externref: keeps the precise type and the fast paths; approved direction,
  // see plan/issues/3548). The zero-arg pad then emits a plain `ref.null`,
  // which the callee (whose body compiles against this same nullable
  // signature) handles as the absent/undefined case.
  if (type !== null && type.kind === "ref" && sawUnderApplied) {
    type = { kind: "ref_null", typeIdx: type.typeIdx };
  }
  // (#4555) The same under-application rule, applied to the NATIVE SCALAR
  // narrowings the #3548 rule left alone. A `ref` at least has `ref.null` as a
  // filler; `f64`/`i32`/`i64` have NO encoding of `undefined`, so the caller's
  // pad emits a zero (`pushDefaultValue`) and the missing argument silently
  // becomes `0` instead. That is observable ES semantics, not a representation
  // detail: `function f(a, b) { return b === undefined; } f(1, 2); f(1);`
  // returned `false` for the second call, because the `f(1, 2)` site narrowed
  // `b` to f64 and the `f(1)` site padded it with `f64.const 0`.
  // Withdrawing the narrowing leaves the parameter on its resolved `externref`,
  // which carries the real `undefined`. Only the under-applied POSITION is
  // withdrawn — a fully-applied parameter of the same function keeps its
  // native slot, so numeric kernels are untouched.
  if (type !== null && sawUnderApplied && (type.kind === "f64" || type.kind === "i32" || type.kind === "i64")) {
    type = null;
  }
  // (#4491) The same rule for an argument that IS `undefined` rather than
  // missing. A call site passing a void call's result (`h(getFunc())`) can only
  // ever deliver `undefined`, and `f64`/`i32`/`i64` have no encoding for it — the
  // argument silently becomes `0`, which is what made the harness's
  // `verifyEqualTo(arrObj, "0", getFunc())` report "Expected obj[0] to equal 0".
  // Withdrawing the narrowing leaves the parameter on its resolved `externref`,
  // whose default value IS the canonical `undefined` (`pushDefaultValue` →
  // `emitUndefinedValue` → the #2106 `$undefined` singleton in standalone).
  if (type !== null && sawNullishArg && (type.kind === "f64" || type.kind === "i32" || type.kind === "i64")) {
    type = null;
  }
  // (#2867 S2) Soundness, same shape as the #3548 under-application rule: if the
  // function ALSO escapes as a value, callers exist that this scan never saw, so
  // an agreed GC-`ref` narrowing is unproven. Withdraw it — a ref narrowing is
  // the only outcome whose ABI boundary TRAPS on a violating value
  // (`any.convert_extern` + `ref.cast`), which is why it is the one withdrawn.
  // f64 / i32 narrowings coerce instead of trapping and keep their existing
  // (already-accepted) risk profile, so the blast radius stays confined to the
  // trapping case.
  const escapesAsValue = functionNameEscapesAsValue(funcName, sourceFile);
  if (escapesAsValue && type !== null && (type.kind === "ref" || type.kind === "ref_null")) {
    type = null;
  }
  return { type, sawCallSite, escapesAsValue, sawUnderApplied };
}

/**
 * #1121: Fallback param-type inference from body usage. Used ONLY when
 * `inferParamTypeFromCallSites` finds **zero** call sites (e.g. an exported
 * entrypoint that is only called from JS host) — the caller gates this on
 * `!sawCallSite` (#3471). It must NOT run when the function is called
 * internally with `any`/polymorphic args: seeing a single numeric use of the
 * param (`1 / a`) here is NOT proof the param is always a number at runtime.
 * A polymorphic helper (e.g. test262's `isSameValue(a, b)`, which does
 * `1 / a` but is also called with strings/objects) would be narrowed to f64,
 * coercing every non-number arg to `NaN` at the call boundary — silently
 * corrupting comparisons like `a !== a`. So this fallback is sound only for
 * the truly-uncalled case where the body is the sole signal.
 *
 * Recognises three numeric-flow patterns:
 *  1. `param` passed as an argument to a function whose return is in
 *     `ctx.numericReturnTypes` (the recursive numeric kernels detected
 *     by inferNumericReturnTypes).
 *  2. `param` used as an operand of a numeric binary operator
 *     (+, -, *, /, %, **, |, &, ^, <<, >>, >>>, ToInt32 coercion).
 *  3. `param` used as a numeric loop bound / comparison operand
 *     (<, <=, >, >=).
 *
 * Returns null if none of those patterns are found, leaving the param
 * unchanged. This is intentionally conservative — the call-site path
 * is still preferred when it has information.
 */
export function inferParamTypeFromBody(
  ctx: CodegenContext,
  decl: ts.FunctionLikeDeclaration,
  paramIndex: number,
): ValType | null {
  if (!decl.body) return null;
  const param = decl.parameters[paramIndex];
  if (!param || !ts.isIdentifier(param.name)) return null;

  const isReferenceTo = (expression: ts.Expression, parameter: ts.ParameterDeclaration): boolean =>
    ts.isIdentifier(expression) && ctx.oracle.valueDeclarationOf(expression) === parameter;

  const hasDirectNumericUse = (owner: ts.FunctionLikeDeclaration, parameterIndex: number): boolean => {
    const parameter = owner.parameters[parameterIndex];
    if (!owner.body || !parameter || !ts.isIdentifier(parameter.name)) return false;
    let numeric = false;
    const visitDirect = (node: ts.Node): void => {
      if (numeric) return;
      if (
        node !== owner &&
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isAccessor(node) ||
          ts.isConstructorDeclaration(node))
      ) {
        return;
      }
      if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        const numericOps = new Set<ts.SyntaxKind>([
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.MinusToken,
          ts.SyntaxKind.AsteriskToken,
          ts.SyntaxKind.AsteriskAsteriskToken,
          ts.SyntaxKind.SlashToken,
          ts.SyntaxKind.PercentToken,
          ts.SyntaxKind.AmpersandToken,
          ts.SyntaxKind.BarToken,
          ts.SyntaxKind.CaretToken,
          ts.SyntaxKind.LessThanLessThanToken,
          ts.SyntaxKind.GreaterThanGreaterThanToken,
          ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
          ts.SyntaxKind.LessThanToken,
          ts.SyntaxKind.LessThanEqualsToken,
          ts.SyntaxKind.GreaterThanToken,
          ts.SyntaxKind.GreaterThanEqualsToken,
        ]);
        if (numericOps.has(op)) {
          const left = isReferenceTo(node.left, parameter);
          const right = isReferenceTo(node.right, parameter);
          if (
            (op !== ts.SyntaxKind.PlusToken && (left || right)) ||
            (op === ts.SyntaxKind.PlusToken &&
              ((left && !ts.isStringLiteral(node.right)) || (right && !ts.isStringLiteral(node.left))))
          ) {
            numeric = true;
            return;
          }
        }
      }
      forEachChild(node, visitDirect);
    };
    forEachChild(owner.body, visitDirect);
    return numeric;
  };

  let foundNumericUse = false;
  let foundNullishSensitiveUse = false;
  function visit(node: ts.Node) {
    if (foundNumericUse && foundNullishSensitiveUse) return;
    // Don't descend into nested functions — the param doesn't propagate there
    // unless captured, and we don't track capture flow here.
    if (
      node !== decl &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isAccessor(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      return;
    }

    // (1) Param forwarded into a proven numeric FORMAL of a known numeric
    // function. A numeric RETURN alone says nothing about its inputs: UUID's
    // `v7()` forwarded its byte buffer to `v7Bytes()`, whose return happened to
    // be misclassified numeric, and the old rule narrowed that buffer to f64.
    // Require the corresponding callee parameter itself to have a direct
    // numeric use. This retains the `run(n) { return fib(n) }` fast path while
    // refusing unrelated object/vector parameters.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const calleeName = node.expression.text;
      if (ctx.numericReturnTypes?.has(calleeName)) {
        const target = ctx.oracle.valueDeclarationOf(node.expression);
        const callee = target && ts.isFunctionDeclaration(target) ? target : null;
        for (let argumentIndex = 0; argumentIndex < node.arguments.length; argumentIndex++) {
          const arg = node.arguments[argumentIndex]!;
          if (isReferenceTo(arg, param) && callee && hasDirectNumericUse(callee, argumentIndex)) {
            foundNumericUse = true;
            return;
          }
        }
      }
    }

    // (2) param used in a numeric binary expression
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken) &&
        isReferenceTo(node.left, param)
      ) {
        // f64 cannot preserve the distinction this operation observes:
        // unboxing `undefined` yields NaN, but `undefined ?? fallback` must
        // select the fallback while `NaN ?? fallback` must not. Keep this
        // parameter dynamic even when later arithmetic proves that every
        // present value is numeric.
        foundNullishSensitiveUse = true;
      }
      const numericOps = new Set<ts.SyntaxKind>([
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.AsteriskAsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.AmpersandToken,
        ts.SyntaxKind.BarToken,
        ts.SyntaxKind.CaretToken,
        ts.SyntaxKind.LessThanLessThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
        ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.GreaterThanEqualsToken,
      ]);
      if (numericOps.has(op)) {
        const isParamId = (e: ts.Expression): boolean => isReferenceTo(e, param);
        // Skip when the OTHER operand is a string literal — `+` could mean
        // string concatenation. The TS checker will already have given us
        // a string-typed param in that case, so this guard is defensive.
        if (op === ts.SyntaxKind.PlusToken) {
          if (
            (isParamId(node.left) && !ts.isStringLiteral(node.right)) ||
            (isParamId(node.right) && !ts.isStringLiteral(node.left))
          ) {
            foundNumericUse = true;
            return;
          }
        } else {
          if (isParamId(node.left) || isParamId(node.right)) {
            foundNumericUse = true;
            return;
          }
        }
      }
    }

    forEachChild(node, visit);
  }
  forEachChild(decl.body, visit);
  return foundNumericUse && !foundNullishSensitiveUse ? { kind: "f64" } : null;
}

/**
 * (#3471) Resolve a concrete wasm type for an implicit-`any` parameter, combining
 * both inference sources with the correct precedence and soundness gate:
 *  1. Call-site inference — if every conclusive call site agrees, use that type.
 *  2. Body-usage fallback — ONLY when the function has **zero** internal call
 *     sites (`!sawCallSite`), i.e. an exported/host-only entrypoint whose body is
 *     the sole signal. A function that IS called internally with `any`/
 *     polymorphic args (call-site inference inconclusive) is NOT body-narrowed:
 *     a single numeric use (`1 / a`) does not prove the param is always a number,
 *     and narrowing it to f64 would coerce non-number args to NaN at the call
 *     boundary — the isSameValue miscompile behind #3471.
 * Returns null to leave the param on its resolved (`externref`) type.
 */
export function inferImplicitAnyParamType(
  ctx: CodegenContext,
  funcName: string,
  paramIndex: number,
  sourceFile: ts.SourceFile,
  decl: ts.FunctionLikeDeclaration,
): ValType | null {
  const callSites = inferParamTypeFromCallSites(ctx, funcName, paramIndex, sourceFile);
  if (callSites.type) return callSites.type;
  const parameter = decl.parameters[paramIndex];
  if (
    parameter &&
    ts.isIdentifier(parameter.name) &&
    ctx.nativeStrings &&
    ctx.anyStrTypeIdx >= 0 &&
    // (#2867 S2) The scope-resolved string verdict reasons about the definitions
    // this file can see. An escaping function has callers it cannot see, so the
    // verdict is not a proof for the parameter's ABI — same withdrawal as the
    // call-site route above, applied at the second entry point into a native
    // string `ref`.
    !callSites.escapesAsValue &&
    ctx.stringLocalVerdict?.(parameter, parameter.name.text) === true
  ) {
    return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  }
  if (callSites.sawCallSite) return null;
  // (#743) Truly-uncalled exported entrypoint: the shipped `.d.ts` claim is the
  // only signal and its export boundary is guarded (ToNumber for f64; a typed
  // ref that traps a violating external call for native strings). Declared
  // types outrank the body-usage heuristic; body inference stays the fallback
  // for unseeded positions.
  const seedAtom = dtsSeedForParam(ctx, decl, paramIndex);
  if (seedAtom !== null) {
    const seeded = dtsSeedAtomToValType(ctx, seedAtom);
    if (seeded !== null) return seeded;
  }
  return inferParamTypeFromBody(ctx, decl, paramIndex);
}

/**
 * #1121: Infer numeric (f64) return types for functions whose body is a
 * purely-numeric kernel even when TypeScript reports the return as
 * `any`/`unknown` (e.g. unannotated recursive helpers like
 * `function fib(n) { ... }`).
 *
 * We do a fixpoint over the entire source file:
 *  1. Seed: every function declaration whose TS return type is implicit
 *     any/unknown becomes a candidate for f64 promotion (assuming numeric).
 *  2. Iterate: a candidate stays in the set only while every `return X`
 *     in its body produces a value whose type is structurally numeric
 *     under the assumption that all other candidates also return f64.
 *  3. The fixpoint converges in O(N * passes) where passes is bounded by
 *     the number of candidates.
 *
 * This intentionally does NOT consider parameter types — by the time we
 * are called, the param-inference pass has already retyped each
 * implicit-any parameter via `inferParamTypeFromCallSites`. We only need
 * to fix the return-type side, which is what TS gives up on for
 * recursive numeric kernels.
 */
export function inferNumericReturnTypes(ctx: CodegenContext, sourceFile: ts.SourceFile): Map<string, ValType> {
  // Collect all function declarations whose return type TS reports as any/unknown.
  // These are the only functions we may promote.
  const candidates = new Map<string, ts.FunctionDeclaration>();
  function collectFns(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      // Skip if explicit return type annotation is present
      if (node.type) {
        return; // explicit annotation — TS already told us the answer
      }
      // Skip generator/async functions — return type semantics differ
      if (node.asteriskToken || node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        return;
      }
      const sig = ctx.checker.getSignatureFromDeclaration(node);
      if (!sig) return;
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      const isImplicitAny = (retType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
      if (isImplicitAny) {
        candidates.set(node.name.text, node);
      }
    }
    forEachChild(node, collectFns);
  }
  forEachChild(sourceFile, collectFns);
  if (candidates.size === 0) return new Map();

  // Inference set: starts with all candidates, and shrinks as we eliminate
  // any whose body cannot uniformly return numeric.
  const numeric = new Set<string>(candidates.keys());

  /**
   * Returns true if `expr` produces a value that is structurally numeric
   * under the optimistic assumption that every name in `numeric` returns
   * f64.
   *
   * Conservative: any unrecognised construct returns false. A depth
   * guard (MAX_DEPTH = 64) bails out for pathological deeply-nested
   * source — the answer for those is conservatively `false`, leaving the
   * function on its TS-derived return type. This keeps the inference
   * runtime worst-case O(body_size) per call instead of growing with
   * unbounded source-AST depth.
   */
  const MAX_NUMERIC_DEPTH = 64;
  function isNumericExpr(expr: ts.Expression, paramNames: Set<string>, depth = 0): boolean {
    if (depth > MAX_NUMERIC_DEPTH) return false;
    if (ts.isParenthesizedExpression(expr)) {
      return isNumericExpr(expr.expression, paramNames, depth + 1);
    }
    if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) {
      return isNumericExpr(expr.expression, paramNames, depth + 1);
    }
    if (ts.isNumericLiteral(expr)) return true;
    if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (ts.isPrefixUnaryExpression(expr)) {
      const o = expr.operator;
      if (o === ts.SyntaxKind.PlusToken || o === ts.SyntaxKind.MinusToken || o === ts.SyntaxKind.TildeToken) {
        return isNumericExpr(expr.operand, paramNames, depth + 1);
      }
      if (o === ts.SyntaxKind.ExclamationToken) {
        return true; // !X is boolean → i32, treat as numeric
      }
      return false;
    }
    if (ts.isPostfixUnaryExpression(expr)) {
      // ++ / -- on a numeric local
      return isNumericExpr(expr.operand, paramNames, depth + 1);
    }
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      const numericOps = new Set<ts.SyntaxKind>([
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.AsteriskAsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.AmpersandToken,
        ts.SyntaxKind.BarToken,
        ts.SyntaxKind.CaretToken,
        ts.SyntaxKind.LessThanLessThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
      ]);
      const cmpOps = new Set<ts.SyntaxKind>([
        ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.GreaterThanEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ]);
      if (numericOps.has(op)) {
        return isNumericExpr(expr.left, paramNames, depth + 1) && isNumericExpr(expr.right, paramNames, depth + 1);
      }
      if (cmpOps.has(op)) {
        // Comparisons return boolean (i32), counted as numeric for our purposes.
        return isNumericExpr(expr.left, paramNames, depth + 1) && isNumericExpr(expr.right, paramNames, depth + 1);
      }
      // && / || / ?? return one of the operand types — accept only when both are numeric
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return isNumericExpr(expr.left, paramNames, depth + 1) && isNumericExpr(expr.right, paramNames, depth + 1);
      }
      return false;
    }
    if (ts.isConditionalExpression(expr)) {
      return (
        isNumericExpr(expr.whenTrue, paramNames, depth + 1) && isNumericExpr(expr.whenFalse, paramNames, depth + 1)
      );
    }
    if (ts.isIdentifier(expr)) {
      // Param of the function being checked → assumed numeric (we only run
      // this analysis when all params are already numeric).
      if (paramNames.has(expr.text)) return true;
      // Other identifiers: rely on the TS checker. This catches
      // numeric local variables, numeric module globals, etc. Implicit-any
      // identifiers fail this test (return false) — that is the safe answer.
      const t = ctx.checker.getTypeAtLocation(expr);
      if (
        (t.flags &
          (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral | ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !==
        0
      ) {
        return true;
      }
      return false;
    }
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
      const calleeName = expr.expression.text;
      // Self-recursion / mutual recursion within our candidate set → assumed numeric
      if (numeric.has(calleeName)) {
        // Also require all arguments to be numeric (body still needs to
        // produce numeric values for the call to be a numeric kernel call)
        return expr.arguments.every((a) => isNumericExpr(a as ts.Expression, paramNames, depth + 1));
      }
      // Any other call: trust TS's reported return type
      const t = ctx.checker.getTypeAtLocation(expr);
      if (
        (t.flags &
          (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral | ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !==
        0
      ) {
        return true;
      }
      return false;
    }
    return false;
  }

  // One-time scan: collect all return expressions inside each candidate's
  // body, plus the param-name set and a precomputed param-numericness
  // check. Caching these means the fixpoint loop below does NOT re-walk
  // the AST on each iteration — it only re-runs `isNumericExpr` against
  // the cached return expressions. This bounds total work to O(candidates
  // × cached returns × MAX_NUMERIC_DEPTH) instead of repeating an O(body
  // size) walk per candidate per iteration.
  type FnInfo = {
    paramNames: Set<string>;
    returns: ts.Expression[];
    sawBareReturn: boolean;
    paramsAllNumeric: boolean;
  };
  const fnInfo = new Map<string, FnInfo>();
  for (const [fnName, fnDecl] of candidates) {
    const paramNames = new Set<string>();
    let paramsAllNumeric = true;
    for (const p of fnDecl.parameters) {
      if (ts.isIdentifier(p.name)) paramNames.add(p.name.text);
      const pt = ctx.checker.getTypeAtLocation(p);
      const isNumericTs =
        (pt.flags &
          (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral | ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !==
        0;
      const isImplicitAny = !p.type && (pt.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
      if (!isNumericTs && !isImplicitAny) {
        paramsAllNumeric = false;
      }
    }
    const returns: ts.Expression[] = [];
    let sawBareReturn = false;
    if (fnDecl.body) {
      const visit = (node: ts.Node): void => {
        // Don't descend into nested function-likes — their returns belong to them
        if (
          node !== fnDecl &&
          (ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isAccessor(node) ||
            ts.isConstructorDeclaration(node))
        ) {
          return;
        }
        if (ts.isReturnStatement(node)) {
          if (node.expression) {
            returns.push(node.expression);
          } else {
            sawBareReturn = true;
          }
        }
        forEachChild(node, visit);
      };
      forEachChild(fnDecl.body, visit);
    }
    fnInfo.set(fnName, { paramNames, returns, sawBareReturn, paramsAllNumeric });
  }

  // Iterate to fixpoint: drop candidates that fail under the current set.
  // The set can only shrink, so the loop terminates in <= candidates.size
  // iterations. Each iteration is O(candidates × cached returns ×
  // MAX_NUMERIC_DEPTH) — no repeated AST walks of the function bodies.
  let changed = true;
  let safety = candidates.size + 1;
  while (changed && safety-- > 0) {
    changed = false;
    for (const fnName of candidates.keys()) {
      if (!numeric.has(fnName)) continue;
      const info = fnInfo.get(fnName)!;
      if (!info.paramsAllNumeric || info.sawBareReturn || info.returns.length === 0) {
        numeric.delete(fnName);
        changed = true;
        continue;
      }
      let allNumeric = true;
      for (const r of info.returns) {
        if (!isNumericExpr(r, info.paramNames)) {
          allNumeric = false;
          break;
        }
      }
      if (!allNumeric) {
        numeric.delete(fnName);
        changed = true;
      }
    }
  }

  // (#2795) Among the numeric kernels, identify the PURELY-BOOLEAN ones — every
  // `return` is a boolean-valued expression (literal `true`/`false`, a
  // comparison, `!x`, a boolean `&&`/`||`/`?:`, or a recursive call to another
  // boolean kernel). These promote to a boolean-BRANDED i32 instead of f64, so
  // when the result is later boxed into an `any`/externref slot (e.g. passed to
  // the host `console.log` of a mutually-recursive predicate) it crosses as the
  // JS boolean `true`/`false` rather than the number 1/0 (#2795 closures/10-mutual).
  // A boolean kernel's body still produces i32 0/1, so the brand is the only
  // change; arithmetic kernels keep f64.
  // (#1930 Slice 3) The boolean-producing SPINE is now defined once in the
  // oracle module (`isSyntacticallyBooleanExpr`, src/checker/oracle.ts —
  // Q-TAG's syntactic layer; see the issue's three-question doctrine). This
  // closure keeps ONLY what is local to the kernel fixpoint: live membership
  // of the evolving `boolean` candidate set, passed as the callable hook.
  // Accept-set is verbatim-identical to the pre-extraction matcher
  // (byte-diff-verified); MAX_NUMERIC_DEPTH (64) matches the spine's bound.
  const isBooleanExpr = (expr: ts.Expression, depth = 0): boolean =>
    isSyntacticallyBooleanExpr(expr, (name) => boolean.has(name) || name === "Boolean", depth);

  // Boolean kernels are a subset of the numeric kernels — seed with all of them
  // and shrink by the same fixpoint discipline (a candidate stays boolean only
  // while every return is boolean under the optimistic assumption that the other
  // candidates are boolean too).
  const boolean = new Set<string>(numeric);
  let bChanged = true;
  let bSafety = boolean.size + 1;
  while (bChanged && bSafety-- > 0) {
    bChanged = false;
    for (const fnName of [...boolean]) {
      const info = fnInfo.get(fnName)!;
      if (!info.returns.every((r) => isBooleanExpr(r))) {
        boolean.delete(fnName);
        bChanged = true;
      }
    }
  }

  const result = new Map<string, ValType>();
  for (const fnName of numeric) {
    result.set(fnName, boolean.has(fnName) ? { kind: "i32", boolean: true } : { kind: "f64" });
  }
  return result;
}

/**
 * Infer numeric standalone result carriers without requiring every parameter
 * to be numeric.
 *
 * The legacy #1121 analysis above intentionally assumes every implicit-any
 * parameter is numeric and its declaration consumer therefore requires an
 * all-numeric parameter ABI. That excludes helpers which merely *carry* a
 * string/object parameter while returning a separately-proven numeric local.
 * This companion analysis proves each returned binding through #4122's
 * grounded, scope-resolved local oracle instead. It is deliberately a least
 * fixpoint: only calls to an already-admitted callee are evidence, so a
 * return-only recursive cycle cannot type itself.
 */
/**
 * (#4555) Can `expr` — an identifier — be `undefined` at runtime because it
 * names a PARAMETER that some call site does not supply?
 *
 * The value side of this is already handled: an under-applied parameter no
 * longer narrows to a native scalar, so it carries the real `undefined`. The
 * RETURN side was not, and the two must agree — a function whose result type
 * is f64 coerces that `undefined` back to `NaN` on the way out:
 *
 *     function g(a, b) { return b; }
 *     g(1, 2);   //  2
 *     g(1);      //  was NaN, want undefined
 *
 * Answers `false` for a parameter with a default or a `?` marker (those have a
 * defined value at every call) and for anything that is not a parameter of a
 * named function declaration, so the numeric-kernel promotion is unchanged
 * everywhere it was already sound.
 */
function lastIndexOfParameterName(owner: ts.FunctionDeclaration, declaration: ts.ParameterDeclaration): number {
  // §10.2.1: with duplicate formal names the LAST one owns the binding, so it
  // is that position's supplied-ness that decides. The checker resolves a
  // reference to the FIRST declaration, which for `function f(x, a, b, x)`
  // called as `f(1, 2)` reported a supplied parameter for a binding that is
  // `undefined`. Non-duplicate names are unaffected (the two indices coincide).
  if (!ts.isIdentifier(declaration.name)) return owner.parameters.indexOf(declaration);
  const name = declaration.name.text;
  let last = -1;
  owner.parameters.forEach((parameter, index) => {
    if (ts.isIdentifier(parameter.name) && parameter.name.text === name) last = index;
  });
  return last;
}

function parameterMayBeUndefined(ctx: CodegenContext, expr: ts.Identifier): boolean {
  const declaration = ctx.oracle.valueDeclarationOf(expr);
  if (!declaration || !ts.isParameter(declaration)) return false;
  if (declaration.initializer !== undefined || declaration.questionToken !== undefined) return false;
  const owner = declaration.parent;
  if (!ts.isFunctionDeclaration(owner) || owner.name === undefined) return false;
  const index = lastIndexOfParameterName(owner, declaration);
  if (index < 0) return false;
  return inferParamTypeFromCallSites(ctx, owner.name.text, index, owner.getSourceFile()).sawUnderApplied;
}

/**
 * (#4121 slice 2) The route-2 CALL-DEFINITION arm: "is this direct call's
 * result a proven `f64` carrier?", as a predicate the whole-program numeric
 * fixpoint can consult.
 *
 * Route 2 (#3765) already has a call arm, but it reads `numericFunctions` —
 * a NAME-keyed set built from every function-like of that name in the program.
 * One same-named member of the population withdraws the name for all of them:
 *
 *     const o = { g: function () { return "s"; } };
 *     function g(x) { return x + 1; }
 *     var i = g(1);      // `g` withdrawn by `o.g`; `i` stays boxed
 *
 * {@link inferBindingAwareNumericReturnTypes} resolves the callee to its exact
 * DECLARATION, so it keeps the verdict the name-keyed set has to give up. This
 * predicate exposes that precision to the fixpoint.
 *
 * Two facts it deliberately does NOT launder:
 *  - **booleans.** A boolean-branded `i32` return is the `` `${b}` `` → `1`
 *    trap the issue's "must still decline" list names; only a plain `f64`
 *    carrier qualifies.
 *  - **cycles.** The return map is itself a grounded least fixpoint that
 *    declines ungrounded recursion, so nothing here can enter a cycle that the
 *    slot fixpoint's own groundedness pass would otherwise reject.
 *
 * Answers `undefined` — meaning "re-running the fixpoint would learn nothing" —
 * whenever the map is empty, either kill switch is off, or every proven name is
 * already in `priorNumericFunctions`. That is the gate that keeps the second
 * analysis pass off programs it cannot change.
 */
export function bindingAwareNumericCallEvidence(
  ctx: CodegenContext,
  priorNumericFunctions: ReadonlySet<string> | undefined,
): ((call: ts.CallExpression) => boolean) | undefined {
  if (!numericReturnsFlagEnabled() || !numericAdmissionEnabled()) return undefined;
  const carriers = ctx.bindingAwareNumericReturnTypes;
  if (!carriers || carriers.size === 0) return undefined;
  let adds = false;
  for (const [name, carrier] of carriers) {
    if (carrier.kind === "f64" && priorNumericFunctions?.has(name) !== true) {
      adds = true;
      break;
    }
  }
  if (!adds) return undefined;
  return (call) => {
    const callee = call.expression;
    if (!ts.isIdentifier(callee)) return false;
    if (carriers.get(callee.text)?.kind !== "f64") return false;
    const declaration = ctx.oracle.valueDeclarationOf(callee);
    return declaration !== undefined && ts.isFunctionDeclaration(declaration);
  };
}

export function inferBindingAwareNumericReturnTypes(
  ctx: CodegenContext,
  sourceFiles: readonly ts.SourceFile[],
): Map<string, ValType> {
  if (!ctx.standalone || !numericReturnsFlagEnabled() || !ctx.numericLocalVerdict) return new Map();

  const candidates = new Map<string, ts.FunctionDeclaration[]>();
  for (const sourceFile of sourceFiles) {
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body && !node.type && !node.asteriskToken) {
        const isAsync = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
        if (!isAsync) {
          const declarations = candidates.get(node.name.text);
          if (declarations) declarations.push(node);
          else candidates.set(node.name.text, [node]);
        }
      }
      forEachChild(node, collect);
    };
    forEachChild(sourceFile, collect);
  }
  if (candidates.size === 0) return new Map();

  type CandidateBody = { returns: ts.Expression[]; definitelyReturns: boolean };
  const bodies = new Map<ts.FunctionDeclaration, CandidateBody>();
  for (const declarations of candidates.values()) {
    for (const declaration of declarations) {
      const returns: ts.Expression[] = [];
      let sawBareReturn = false;
      const visit = (node: ts.Node): void => {
        if (
          node !== declaration &&
          (ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isAccessor(node) ||
            ts.isConstructorDeclaration(node))
        ) {
          return;
        }
        if (ts.isReturnStatement(node)) {
          if (node.expression) returns.push(node.expression);
          else sawBareReturn = true;
        }
        forEachChild(node, visit);
      };
      forEachChild(declaration.body!, visit);
      // This narrow syntactic gate is intentional. It admits straight-line
      // helpers and functions with earlier guarded returns, while refusing to
      // invent an f64/i32 value for an implicit-undefined fallthrough path.
      const last = declaration.body!.statements.at(-1);
      bodies.set(declaration, {
        returns,
        definitelyReturns: !sawBareReturn && !!last && ts.isReturnStatement(last) && !!last.expression,
      });
    }
  }

  const inferred = new Map<string, ValType>();
  const MAX_DEPTH = 64;
  const oracleSaysNumber = (expr: ts.Expression): boolean => ctx.oracle.staticJsTypeOf(expr) === "number";
  const inferredCallType = (call: ts.CallExpression): ValType | undefined => {
    if (!ts.isIdentifier(call.expression)) return undefined;
    const declaration = ctx.oracle.valueDeclarationOf(call.expression);
    if (!declaration || !ts.isFunctionDeclaration(declaration)) return undefined;
    if (!candidates.get(call.expression.text)?.includes(declaration)) return undefined;
    return inferred.get(call.expression.text);
  };
  const isNumericExpr = (expr: ts.Expression, depth = 0): boolean => {
    if (depth > MAX_DEPTH) return false;
    if (ts.isParenthesizedExpression(expr)) return isNumericExpr(expr.expression, depth + 1);
    if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) {
      return isNumericExpr(expr.expression, depth + 1);
    }
    if (ts.isNumericLiteral(expr)) return true;
    if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (ts.isIdentifier(expr)) {
      // (#4555) An under-applied parameter is `undefined` at some call, which
      // an f64 result would render as NaN. See `parameterMayBeUndefined`.
      if (parameterMayBeUndefined(ctx, expr)) return false;
      // The local oracle is a grounded NUMBER-carrier proof: its construction
      // explicitly rejects every booleanish definition and resolves the exact
      // lexical slot, so same-name/shadowed bindings cannot leak evidence.
      return oracleSaysNumber(expr) || ctx.numericLocalVerdict?.(expr, expr.text) === true;
    }
    if (ts.isPrefixUnaryExpression(expr)) {
      if (expr.operator === ts.SyntaxKind.ExclamationToken) return true;
      if (
        expr.operator === ts.SyntaxKind.PlusToken ||
        expr.operator === ts.SyntaxKind.MinusToken ||
        expr.operator === ts.SyntaxKind.TildeToken
      ) {
        return isNumericExpr(expr.operand, depth + 1);
      }
      return false;
    }
    if (ts.isPostfixUnaryExpression(expr)) return isNumericExpr(expr.operand, depth + 1);
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      if (
        op === ts.SyntaxKind.LessThanToken ||
        op === ts.SyntaxKind.LessThanEqualsToken ||
        op === ts.SyntaxKind.GreaterThanToken ||
        op === ts.SyntaxKind.GreaterThanEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.InstanceOfKeyword ||
        op === ts.SyntaxKind.InKeyword
      ) {
        return true;
      }
      if (
        op === ts.SyntaxKind.PlusToken ||
        op === ts.SyntaxKind.MinusToken ||
        op === ts.SyntaxKind.AsteriskToken ||
        op === ts.SyntaxKind.AsteriskAsteriskToken ||
        op === ts.SyntaxKind.SlashToken ||
        op === ts.SyntaxKind.PercentToken ||
        op === ts.SyntaxKind.AmpersandToken ||
        op === ts.SyntaxKind.BarToken ||
        op === ts.SyntaxKind.CaretToken ||
        op === ts.SyntaxKind.LessThanLessThanToken ||
        op === ts.SyntaxKind.GreaterThanGreaterThanToken ||
        op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return isNumericExpr(expr.left, depth + 1) && isNumericExpr(expr.right, depth + 1);
      }
      return false;
    }
    if (ts.isConditionalExpression(expr)) {
      return isNumericExpr(expr.whenTrue, depth + 1) && isNumericExpr(expr.whenFalse, depth + 1);
    }
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
      return inferredCallType(expr) !== undefined || oracleSaysNumber(expr);
    }
    return oracleSaysNumber(expr);
  };
  const isBooleanExpr = (expr: ts.Expression, depth = 0): boolean => {
    if (depth > MAX_DEPTH) return false;
    if (ts.isParenthesizedExpression(expr)) return isBooleanExpr(expr.expression, depth + 1);
    if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) {
      return isBooleanExpr(expr.expression, depth + 1);
    }
    if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (ts.isPrefixUnaryExpression(expr)) return expr.operator === ts.SyntaxKind.ExclamationToken;
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      if (
        op === ts.SyntaxKind.LessThanToken ||
        op === ts.SyntaxKind.LessThanEqualsToken ||
        op === ts.SyntaxKind.GreaterThanToken ||
        op === ts.SyntaxKind.GreaterThanEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.InstanceOfKeyword ||
        op === ts.SyntaxKind.InKeyword
      ) {
        return true;
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        return isBooleanExpr(expr.left, depth + 1) && isBooleanExpr(expr.right, depth + 1);
      }
      return false;
    }
    if (ts.isConditionalExpression(expr)) {
      return isBooleanExpr(expr.whenTrue, depth + 1) && isBooleanExpr(expr.whenFalse, depth + 1);
    }
    if (ts.isCallExpression(expr)) return inferredCallType(expr)?.kind === "i32";
    return false;
  };

  for (let pass = 0; pass <= candidates.size; pass++) {
    let added = false;
    for (const [name, declarations] of candidates) {
      if (inferred.has(name)) continue;
      let sawBoolean = false;
      let sawNumber = false;
      let valid = true;
      for (const declaration of declarations) {
        const body = bodies.get(declaration)!;
        if (!body.definitelyReturns || body.returns.length === 0) {
          valid = false;
          break;
        }
        for (const expression of body.returns) {
          if (!isNumericExpr(expression)) {
            valid = false;
            break;
          }
          if (isBooleanExpr(expression)) {
            sawBoolean = true;
          } else {
            sawNumber = true;
          }
        }
        if (!valid) break;
      }
      // A mixed boolean/number result needs the dynamic carrier to preserve JS
      // identity; neither an unbranded f64 nor a branded i32 can represent it.
      if (!valid || sawBoolean === sawNumber) continue;
      inferred.set(name, sawBoolean ? { kind: "i32", boolean: true } : { kind: "f64" });
      added = true;
    }
    if (!added) break;
  }
  return inferred;
}
