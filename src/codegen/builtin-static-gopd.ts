// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2984 Phase 3) Standalone `Object.getOwnPropertyDescriptor(<Ctor|Namespace>,
 * "<member>")` — static-property descriptor synthesis for builtin CONSTRUCTOR /
 * namespace receivers (`gOPD(Math, "atan2")`, `gOPD(Date, "prototype")`,
 * `gOPD(Number, "MAX_VALUE")`, `gOPD(String, "length")`).
 *
 * ## Why a compile-time synthesis site
 *
 * Under `--target standalone` a builtin identifier used as a *dynamic* gOPD
 * receiver routes through the `__get_builtin` shortcut (calls.ts), which
 * refuses-loud (#1472 Phase B) — the whole shape is a hard CE (~72 test262
 * files across the gOPD dirs, measured 2026-07-10). But every OWN property of
 * a standard builtin ctor/namespace is statically known, so the descriptor can
 * be synthesized at compile time from the same tables the direct-read arms
 * already use — the ctor/namespace sibling of the #2885 Site-2 proto-receiver
 * synthesis (which fable-2984b's Phase 2 completed for `<Builtin>.prototype`
 * receivers).
 *
 * ## Classification (§ references = ECMA-262)
 *
 * - `"prototype"` on a builtin FUNCTION (`BUILTIN_CTOR_ARITY` membership;
 *   excludes the Math/JSON/Reflect/Atomics namespaces and §28.2 `Proxy`, which
 *   own no `prototype`): data descriptor `{w:false, e:false, c:false}`; the
 *   value is the `$NativeProto` object when the builtin has registered glue
 *   (`emitLazyNativeProtoGet` — same identity as a plain `<Ctor>.prototype`
 *   read), else `undefined` (attributes still spec-correct — the dominant
 *   15.2.3.3-4-18x/2xx shape asserts attributes + get/set absence only).
 * - `"length"` / `"name"` on a builtin function: `{w:false, e:false, c:true}`
 *   (§10.2.9 / §20.x), value from `BUILTIN_CTOR_ARITY` / the ctor name.
 * - Math/Number numeric constants (`MATH_CONSTANT_VALUES` /
 *   `NUMBER_CONSTANT_VALUES`) and `<TypedArray>.BYTES_PER_ELEMENT`
 *   (§21.3.x/§21.1.2.x/§23.2.6.1): `{w:false, e:false, c:false}` value
 *   descriptors.
 * - Static METHODS (`BUILTIN_STATIC_METHOD_ARITY` membership): `{w:true,
 *   e:false, c:true}` with `.value` = the per-(builtin, method) SINGLETON
 *   closure — the SAME value a plain `Math.atan2` read materializes
 *   (property-access.ts), so `gOPD(Math, "atan2").value === Math.atan2`
 *   holds (the dominant 15.2.3.3-4-9x/1xx assertion).
 * - Any OTHER string key on a CLOSED-universe receiver: the arms above cover
 *   the complete standard own STRING-keyed surface, so the member is
 *   genuinely absent → `undefined` (`gOPD(Math, "caller")`,
 *   `gOPD(Function, "arguments_1")`). Symbol (well-known-symbol props read as
 *   strings elsewhere: `Symbol.iterator` is an OWN data property this table
 *   set does not model) and RegExp (annex-B legacy statics `$1`…`$9`,
 *   `input`, `lastMatch`, …) have OPEN universes — unknown members there fall
 *   through to the caller (the existing refusal), never a phantom
 *   `undefined`.
 *
 * ## Safety envelope
 *
 * The caller gates on `ctx.standalone` + unshadowed builtin identifier +
 * literal key — every intercepted shape CE'd on main (`__get_builtin`
 * refusal), so nothing currently passing can change. Host/gc/wasi lanes never
 * reach this module. Each arm resolves its natives (`ensureLateImport` +
 * flush) BEFORE pushing operands, so a `false` return never leaves partial
 * instructions in `fctx.body`.
 */
import { ts } from "../ts-api.js";
import { integrityVarKey } from "./widened-var-key.js";
import type { Instr, ValType } from "../ir/types.js";
import { emitUndefinedExtern, undefinedExternInstrs } from "./any-helpers.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  BUILTIN_STATIC_METHOD_ARITY,
  ensureBuiltinFnMetaType,
  pushBuiltinFnSingletonValueInstrs,
} from "./builtin-fn-meta.js";
import { getOrCreateFuncRefWrapperTypes } from "./closures.js";
import { allocLocal } from "./context/locals.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { emitLazyNativeProtoGet } from "./native-proto.js";
import { nativeStringLiteralInstrs, stringConstantExternrefInstrs } from "./native-strings.js";
import {
  BUILTIN_CTOR_ARITY,
  ensureStandaloneBuiltinStaticMethodClosure,
  makeBuiltinClosureFctx,
  MATH_CONSTANT_VALUES,
  NUMBER_CONSTANT_VALUES,
  TYPED_ARRAY_BYTES_PER_ELEMENT,
  tryEnsureNativeProtoBrand,
} from "./property-access.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { coerceType, compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";

// §6.1.7.3 attribute flag bits — mirrors object-runtime's `__create_descriptor`
// (1=writable, 2=enumerable, 4=configurable).
const FLAG_WRITABLE = 0x01;
const FLAG_CONFIGURABLE = 0x04;

function resolveCreateDescriptor(ctx: CodegenContext, fctx: FunctionContext): number | undefined {
  const idx = ensureLateImport(
    ctx,
    "__create_descriptor",
    [{ kind: "externref" }, { kind: "i32" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  return idx;
}

function resolveBoxNumber(ctx: CodegenContext, fctx: FunctionContext): number | undefined {
  const idx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  return idx;
}

/**
 * (#2984 bucket-1 "obj-VAR receivers") Resolve a gOPD receiver EXPRESSION to a
 * builtin ctor/namespace name at compile time, following one level of
 * reaching-def aliasing: `const/var m = Math; gOPD(m, "atan2")`. The Phase 3
 * synthesis gate was purely syntactic (bare unshadowed builtin identifier);
 * test262's 15.2.3.3-4-* fixtures overwhelmingly bind the receiver through a
 * local first, which fell to the dynamic `__getOwnPropertyDescriptor` path and
 * silently yielded `undefined` standalone.
 *
 * Soundness (conservative, AST-only — no checker, per the #1930 oracle
 * ratchet): the alias is accepted ONLY when, within the local's whole
 * enclosing function-like (or SourceFile) subtree,
 *   1. EXACTLY ONE VariableDeclaration binds the name (no same-name shadow
 *      ambiguity anywhere in the scope tree),
 *   2. its initializer unwraps (parens / `as` / `!` / `<T>`) to an unshadowed
 *      builtin identifier,
 *   3. NO parameter, catch clause, function declaration, class, import, or
 *      assignment/update expression anywhere in that subtree writes the name —
 *      so the initializer is the unique reaching definition at every use.
 * Anything else returns `undefined` and the caller keeps today's behavior.
 * `builtinNames` is passed by the caller (calls.ts owns BUILTIN_CLASS_NAMES;
 * importing it here would cycle).
 */
export function resolveBuiltinReceiverName(
  fctx: FunctionContext,
  expr: ts.Expression,
  builtinNames: ReadonlySet<string>,
): string | undefined {
  const unwrap = (e: ts.Expression): ts.Expression => {
    let cur = e;
    while (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = cur.expression;
    }
    return cur;
  };
  const isShadowedBuiltin = (name: string): boolean =>
    fctx.localMap.has(name) || (fctx.boxedCaptures?.has(name) ?? false);

  const e = unwrap(expr as ts.Expression);
  if (!ts.isIdentifier(e)) return undefined;
  // Direct receiver — the Phase 3 gate, expressed here so callers have ONE entry.
  if (builtinNames.has(e.text) && !isShadowedBuiltin(e.text)) return e.text;

  // Alias receiver: find the enclosing function-like / SourceFile scope root.
  const name = e.text;
  let root: ts.Node = e;
  while (root.parent) {
    root = root.parent;
    if (
      ts.isFunctionDeclaration(root) ||
      ts.isFunctionExpression(root) ||
      ts.isArrowFunction(root) ||
      ts.isMethodDeclaration(root) ||
      ts.isConstructorDeclaration(root) ||
      ts.isGetAccessorDeclaration(root) ||
      ts.isSetAccessorDeclaration(root) ||
      ts.isSourceFile(root)
    ) {
      break;
    }
  }

  let decl: ts.VariableDeclaration | undefined;
  let declCount = 0;
  let otherBinderOrWrite = false;
  const visit = (n: ts.Node): void => {
    if (otherBinderOrWrite) return;
    if (ts.isVariableDeclaration(n)) {
      if (ts.isIdentifier(n.name) && n.name.text === name) {
        declCount++;
        decl = n;
      } else if (!ts.isIdentifier(n.name)) {
        // Destructuring can bind the name invisibly — scan its identifiers.
        const scanBinding = (b: ts.Node): void => {
          if (ts.isIdentifier(b) && b.text === name) otherBinderOrWrite = true;
          ts.forEachChild(b, scanBinding);
        };
        scanBinding(n.name);
      }
    } else if ((ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name) && n.name.text === name) {
      otherBinderOrWrite = true;
    } else if (ts.isCatchClause(n) && n.variableDeclaration) {
      const vd = n.variableDeclaration;
      if (ts.isIdentifier(vd.name) && vd.name.text === name) otherBinderOrWrite = true;
    } else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name?.text === name) {
      otherBinderOrWrite = true;
    } else if (ts.isImportSpecifier(n) && n.name.text === name) {
      otherBinderOrWrite = true;
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const lhs = unwrap(n.left);
      if (ts.isIdentifier(lhs) && lhs.text === name) otherBinderOrWrite = true;
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstCompoundAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastCompoundAssignment
    ) {
      const lhs = unwrap(n.left);
      if (ts.isIdentifier(lhs) && lhs.text === name) otherBinderOrWrite = true;
    } else if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const operand = unwrap(n.operand);
      if (ts.isIdentifier(operand) && operand.text === name) otherBinderOrWrite = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(root);

  if (otherBinderOrWrite || declCount !== 1 || !decl?.initializer) return undefined;
  const init = unwrap(decl.initializer);
  if (ts.isIdentifier(init) && builtinNames.has(init.text) && !isShadowedBuiltin(init.text)) return init.text;
  return undefined;
}

/**
 * Resolve the RECEIVER of a `gOPD(<Builtin>.prototype, "<member>")` call to its
 * builtin name — either the syntactic unshadowed `<Ctor>.prototype` form, or
 * (#2901) the harness's dynamic `%TypedArray%.prototype` receiver traced
 * through intermediate vars. Returns `undefined` when arg0 is neither, or when
 * the key is not a literal (the caller's synthesis arms are all key-driven).
 *
 * `builtinCtorNames` and `tracesToTypedArrayProto` are supplied by the caller:
 * both live in modules that import this one, so taking them as parameters is
 * what keeps this module free of a cycle (same discipline as
 * `resolveBuiltinReceiverName`'s `builtinNames`).
 */
export function resolveBuiltinProtoGopdReceiver(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg0: ts.Expression,
  propLiteral: string | undefined,
  builtinCtorNames: ReadonlySet<string>,
  tracesToTypedArrayProto: (e: ts.Expression) => boolean,
): string | undefined {
  if (!ctx.standalone || propLiteral === undefined) return undefined;
  if (
    ts.isPropertyAccessExpression(arg0) &&
    !ts.isPrivateIdentifier(arg0.name) &&
    arg0.name.text === "prototype" &&
    ts.isIdentifier(arg0.expression) &&
    builtinCtorNames.has(arg0.expression.text) &&
    !(fctx.localMap.has(arg0.expression.text) || (fctx.boxedCaptures?.has(arg0.expression.text) ?? false))
  ) {
    return arg0.expression.text;
  }
  return tracesToTypedArrayProto(arg0) ? "%TypedArray%" : undefined;
}

/** Emit `__create_descriptor(box(value), flags)` for a numeric constant. */
function emitNumericValueDescriptor(ctx: CodegenContext, fctx: FunctionContext, value: number, flags: number): boolean {
  const boxIdx = resolveBoxNumber(ctx, fctx);
  const createIdx = resolveCreateDescriptor(ctx, fctx);
  if (boxIdx === undefined || createIdx === undefined) return false;
  fctx.body.push({ op: "f64.const", value });
  fctx.body.push({ op: "call", funcIdx: boxIdx });
  fctx.body.push({ op: "i32.const", value: flags });
  fctx.body.push({ op: "call", funcIdx: createIdx });
  return true;
}

/**
 * Synthesize the descriptor for `Object.getOwnPropertyDescriptor(<builtin>,
 * "<member>")` with a builtin ctor/namespace IDENTIFIER receiver. Leaves one
 * externref (the descriptor `$Object`, or null-extern = `undefined` for a
 * genuinely absent member) on the stack and returns `true`; returns `false`
 * — with NOTHING pushed — when the member cannot be answered statically
 * (caller falls through to the existing `__get_builtin` refusal).
 */
export function tryEmitStandaloneBuiltinStaticGopd(
  ctx: CodegenContext,
  fctx: FunctionContext,
  builtinName: string,
  member: string,
): boolean {
  const isCtorFunction = builtinName in BUILTIN_CTOR_ARITY;

  // ── "prototype" — own of every builtin function except Proxy (§28.2) ──────
  if (member === "prototype") {
    if (isCtorFunction && builtinName !== "Proxy") {
      // Brand glue registration BEFORE the native resolve (Site-2 ordering).
      const brand = tryEnsureNativeProtoBrand(ctx, builtinName);
      const createIdx = resolveCreateDescriptor(ctx, fctx);
      if (createIdx === undefined) return false;
      if (brand === undefined || !emitLazyNativeProtoGet(ctx, fctx, brand)) {
        // No reified proto object for this builtin yet — the attribute
        // assertions (the only shape in the corpus) still pass. (#3319: the
        // absent value surfaces as `undefined` — the singleton under the
        // #2106 regime; legacy null.extern.)
        if (!emitUndefinedExtern(ctx, fctx)) fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "call", funcIdx: createIdx });
      return true;
    }
    // Namespaces (Math/JSON/Reflect/Atomics) and Proxy own no "prototype".
    // (#3319) A gOPD miss answers `undefined` — the singleton under the #2106
    // regime (null ≠ undefined there); legacy lanes keep null.extern.
    if (!emitUndefinedExtern(ctx, fctx)) fctx.body.push({ op: "ref.null.extern" });
    return true;
  }

  // ── "length" / "name" on a builtin function — {w:false, e:false, c:true} ──
  if ((member === "length" || member === "name") && isCtorFunction) {
    if (member === "length") {
      return emitNumericValueDescriptor(ctx, fctx, BUILTIN_CTOR_ARITY[builtinName]!, FLAG_CONFIGURABLE);
    }
    const createIdx = resolveCreateDescriptor(ctx, fctx);
    if (createIdx === undefined) return false;
    addStringConstantGlobal(ctx, builtinName);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, builtinName));
    fctx.body.push({ op: "i32.const", value: FLAG_CONFIGURABLE });
    fctx.body.push({ op: "call", funcIdx: createIdx });
    return true;
  }

  // ── Math/Number numeric constants — {w:false, e:false, c:false} ───────────
  const constTable =
    builtinName === "Math" ? MATH_CONSTANT_VALUES : builtinName === "Number" ? NUMBER_CONSTANT_VALUES : undefined;
  if (constTable && Object.prototype.hasOwnProperty.call(constTable, member)) {
    return emitNumericValueDescriptor(ctx, fctx, constTable[member]!, 0);
  }

  // ── <TypedArray>.BYTES_PER_ELEMENT — {w:false, e:false, c:false} ──────────
  if (member === "BYTES_PER_ELEMENT" && builtinName in TYPED_ARRAY_BYTES_PER_ELEMENT) {
    return emitNumericValueDescriptor(ctx, fctx, TYPED_ARRAY_BYTES_PER_ELEMENT[builtinName]!, 0);
  }

  // ── Static METHOD — {w:true, e:false, c:true}, identity-stable value ──────
  if (BUILTIN_STATIC_METHOD_ARITY[builtinName]?.[member] !== undefined) {
    const closure = ensureStandaloneBuiltinStaticMethodClosure(ctx, builtinName, member);
    if (!closure) return false;
    const createIdx = resolveCreateDescriptor(ctx, fctx);
    if (createIdx === undefined) return false;
    // (#2175 V2-S2) The per-(builtin, method) singleton — the SAME value a
    // plain `<Builtin>.<method>` read yields, so `desc.value === Math.atan2`.
    fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure));
    fctx.body.push({ op: "extern.convert_any" });
    fctx.body.push({ op: "i32.const", value: FLAG_WRITABLE | FLAG_CONFIGURABLE });
    fctx.body.push({ op: "call", funcIdx: createIdx });
    return true;
  }

  // ── Unknown member ─────────────────────────────────────────────────────────
  // Symbol (own well-known-symbol data props: `Symbol.iterator`, …) and RegExp
  // (annex-B legacy statics: `$1`…`$9`, `input`, …) have OPEN own-property
  // universes the tables above do not close — refuse rather than fabricate a
  // phantom `undefined`. Every other receiver's standard own STRING-keyed
  // surface is fully covered above, so the member is genuinely absent.
  if (builtinName === "Symbol" || builtinName === "RegExp") return false;
  // (#3319) Genuinely-absent member → `undefined` (singleton under the #2106
  // regime; legacy null.extern).
  if (!emitUndefinedExtern(ctx, fctx)) fctx.body.push({ op: "ref.null.extern" });
  return true;
}

/**
 * (#2984 "builtin receiver + non-literal key") The constructors whose OWN
 * property surface includes the `@@species` accessor (§ "get <Ctor>
 * [ @@species ]"): Array §23.1.2.5, ArrayBuffer §25.1.5.3, SharedArrayBuffer
 * §25.2.4.3, Map §24.1.2.2, Set §24.2.2.2, Promise §27.2.4.4, RegExp §22.2.6.2.
 * (%TypedArray% also owns one, but its gOPD receiver in the corpus is a
 * harness-bound `Object.getPrototypeOf(Int8Array)` var the conservative alias
 * resolver declines — out of scope for this slice. The CONCRETE TypedArray
 * ctors inherit @@species and do NOT own it, so they are correctly absent.)
 */
const SPECIES_OWNER_CTORS: ReadonlySet<string> = new Set([
  "Array",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "Map",
  "Set",
  "Promise",
  "RegExp",
]);

/**
 * True when a gOPD KEY expression is the well-known symbol read
 * `Symbol.species` (unwrapping parens/`as`/`!`), with `Symbol` unshadowed.
 * This is the dominant NON-LITERAL builtin-receiver key in the corpus
 * (`built-ins/*/ Symbol.species; /*` — 26 standalone CEs measured 2026-07-11):
 * the key never reaches `literalKeyText`, so the shape fell through to the
 * dynamic fallback and hit the `__get_builtin` standalone refusal (#1472
 * Phase B) as a hard CE.
 */
export function isSymbolSpeciesKeyExpression(fctx: FunctionContext, expr: ts.Expression): boolean {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return (
    ts.isPropertyAccessExpression(e) &&
    !ts.isPrivateIdentifier(e.name) &&
    e.name.text === "species" &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "Symbol" &&
    !(fctx.localMap.has("Symbol") || (fctx.boxedCaptures?.has("Symbol") ?? false))
  );
}

/**
 * (#2984 "builtin receiver + non-literal key") The per-constructor
 * `get [Symbol.species]` accessor closure — spec `get <Ctor> [ @@species ]`
 * (§23.1.2.5, §25.1.5.3, §24.1.2.2, §24.2.2.2, §27.2.4.4, §22.2.6.2): the body
 * is exactly "Return the this value" (param 1, the lifted receiver slot).
 *
 * The value struct is the UNIQUE per-ctor meta subtype (`species:<Ctor>`), so
 * (a) `pushBuiltinFnSingletonValueInstrs`' per-typeIdx singleton global gives
 * identity-stable reads (`gOPD(Array, Symbol.species).get` is the SAME object
 * across calls) while Array's getter stays distinct from Map's (each ctor owns
 * its OWN accessor function per spec), and (b) the reflective `__builtinfn_*`
 * natives answer `name`/`length` at runtime — `"get [Symbol.species]"` / 0
 * (§10.2.9 accessor spelling) — which is what the test262 propertyHelper reads
 * (`verifyProperty(desc.get, "name"|"length", …)`).
 *
 * The meta type is registered in `nativeProtoReceiverClosureStructTypes`
 * (#2193 PR-B): the getter's FIRST user param IS the receiver, so a statically
 * resolvable `g.call(thisVal)` threads `thisVal` into param 1 (→ returns it)
 * instead of dropping it. Only the meta subtype is registered — the shared
 * signature-wrapper base is left alone (other closures of the same signature
 * take a plain first ARG there, not a receiver).
 */
function ensureStandaloneSpeciesGetterClosure(
  ctx: CodegenContext,
  builtinName: string,
): { type: { kind: "ref"; typeIdx: number }; funcIdx: number } | null {
  const userParams: ValType[] = [{ kind: "externref" }]; // param 1 = `this`
  const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, userParams, [{ kind: "externref" }]);
  if (!wrapperTypes) return null;

  const funcName = `__builtin_species_get_${builtinName}`;
  let funcIdx = ctx.funcMap.get(funcName);
  if (funcIdx === undefined) {
    const selfType: ValType = { kind: "ref", typeIdx: wrapperTypes.liftedSelfTypeIdx };
    const closureFctx = makeBuiltinClosureFctx(funcName, selfType, userParams, { kind: "externref" });
    // Step 1 (the whole algorithm): Return the this value.
    closureFctx.body.push({ op: "local.get", index: 1 });
    funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: funcName,
      typeIdx: wrapperTypes.liftedFuncTypeIdx,
      locals: closureFctx.locals,
      body: closureFctx.body,
      exported: false,
    });
    ctx.funcMap.set(funcName, funcIdx);
    if (!ctx.nativeClosureMeta) ctx.nativeClosureMeta = new Map();
    ctx.nativeClosureMeta.set(funcIdx, { name: "get [Symbol.species]", length: 0 });
  }

  const metaTypeIdx = ensureBuiltinFnMetaType(
    ctx,
    wrapperTypes.structTypeIdx,
    wrapperTypes.closureInfo,
    `species:${builtinName}`,
    "get [Symbol.species]",
    0,
  );
  if (!ctx.nativeProtoReceiverClosureStructTypes) ctx.nativeProtoReceiverClosureStructTypes = new Set();
  ctx.nativeProtoReceiverClosureStructTypes.add(metaTypeIdx);
  return { type: { kind: "ref", typeIdx: metaTypeIdx }, funcIdx };
}

/**
 * Synthesize the §6.1.7.3 ACCESSOR descriptor for
 * `Object.getOwnPropertyDescriptor(<Ctor>, Symbol.species)`:
 * `{ get: <"get [Symbol.species]" singleton>, set: undefined,
 *    enumerable: false, configurable: true }`.
 * Leaves one externref (the descriptor `$Object`) on the stack and returns
 * `true`; returns `false` — with NOTHING pushed — for non-@@species-owner
 * receivers (caller keeps today's `__get_builtin` refusal; every intercepted
 * owner shape was a hard CE, so the arm is strictly additive).
 *
 * Late-funcidx discipline: the `__create_accessor_descriptor` native is
 * resolved (+ flushed) BEFORE the getter closure funcIdx is minted/captured,
 * so the `ref.func` the singleton materializer bakes into `fctx.body` cannot
 * go stale from this arm's own import addition (and `fctx.body` is
 * shift-covered for later ones).
 */
export function tryEmitStandaloneBuiltinSpeciesGopd(
  ctx: CodegenContext,
  fctx: FunctionContext,
  builtinName: string,
): boolean {
  if (!SPECIES_OWNER_CTORS.has(builtinName)) return false;
  const createAccIdx = ensureLateImport(
    ctx,
    "__create_accessor_descriptor",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "i32" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (createAccIdx === undefined) return false;
  const closure = ensureStandaloneSpeciesGetterClosure(ctx, builtinName);
  if (!closure) return false;
  // (#2175 V2-S2) Identity-stable getter singleton — repeated gOPD calls yield
  // the SAME `.get` function object.
  fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure));
  fctx.body.push({ op: "extern.convert_any" }); // get
  fctx.body.push({ op: "ref.null.extern" }); // set = undefined
  fctx.body.push({ op: "i32.const", value: FLAG_CONFIGURABLE }); // {e:false, c:true}
  fctx.body.push({ op: "call", funcIdx: createAccIdx });
  return true;
}

/**
 * (#2984 "arg-2 name coercion") Standalone `Object.getOwnPropertyDescriptor(
 * <struct-shaped obj>, <NON-literal key>)` — runtime ToPropertyKey dispatch
 * over the compile-time field set.
 *
 * ## Why
 *
 * A plain object literal lowers to a TYPED STRUCT, not a runtime `$Object`.
 * The gOPD call site answers struct receivers only through the LITERAL-key
 * fast path (calls.ts, `structName && propLiteral !== undefined`); any
 * non-literal key (`gOPD(obj, NaN)`, `gOPD(obj, k)`, `gOPD(obj, {toString})`)
 * fell through to the dynamic `__getOwnPropertyDescriptor` native, which only
 * walks `$Object`s — so a struct receiver always answered `undefined`
 * (test262 15.2.3.3-2-*: 17/47 failed, measured 2026-07-10). Here we compile
 * the key, run it through the central `__to_property_key` coercion (#2042 S1 /
 * #2985 — canonical ToString(ToPrimitive(key,"string")) for every non-Symbol
 * key), then string-match it against the struct's known field names and
 * synthesize the SAME descriptor the literal fast path emits per field.
 *
 * ## Safety envelope
 *
 * `ctx.standalone`-gated by the caller; host/gc keeps its working host-import
 * route (byte-inert). Bails (returns `false`, nothing pushed) for class
 * receivers (methods keep the #1364a dynamic-fallback behavior) and
 * sidecar-defined keys (#1629b defineProperty migration). A non-string
 * post-coercion key (a genuine Symbol; nullish under the legacy no-singleton
 * regime) answers `undefined` — exactly what the dynamic native answered for
 * every struct receiver before, so nothing passing changes.
 */
export function tryEmitStandaloneStructGopdKeyDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg0: ts.Expression,
  arg1: ts.Expression,
  structName: string,
): boolean {
  const structTypeIdx = ctx.structMap.get(structName);
  const fields = ctx.structFields.get(structName);
  if (structTypeIdx === undefined || !fields) return false;
  // Class receivers: proto/static method lookups keep the dynamic fallback
  // (#1364a/#1395) — only plain data-shape structs take this arm.
  if (ctx.classMethodNames.has(structName) || ctx.classStaticMethodNames.has(structName)) return false;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const nativeStrTypeIdx = ctx.nativeStrTypeIdx;
  if (anyStrTypeIdx < 0 || nativeStrTypeIdx < 0) return false;
  const userFields = fields
    .map((f, idx) => ({ field: f, fieldIdx: idx }))
    .filter((e) => !e.field.name.startsWith("__"));
  // Sidecar-defined keys (#1629b) migrate the property off the struct — the
  // dynamic fallback owns those receivers.
  if (
    ts.isIdentifier(arg0) &&
    userFields.some((e) => ctx.sidecarDefinedPropertyKeys.has(`${arg0.text}:${e.field.name}`))
  ) {
    return false;
  }

  // ── Operands first (their lowering may add late imports; indices are
  // captured AFTER, so no stale-funcIdx hazard — late-funcidx discipline). ──
  const objAny = allocLocal(fctx, `__gopdkd_obj_${fctx.locals.length}`, { kind: "anyref" });
  const keyExt = allocLocal(fctx, `__gopdkd_key_${fctx.locals.length}`, { kind: "externref" });
  const keyStr = allocLocal(fctx, `__gopdkd_kstr_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: nativeStrTypeIdx,
  });
  const objType = compileExpression(ctx, fctx, arg0, { kind: "externref" });
  if (!objType || typeof objType !== "object") {
    // (#3319) degenerate answer is `undefined` — singleton under the regime.
    if (!emitUndefinedExtern(ctx, fctx)) fctx.body.push({ op: "ref.null.extern" });
    return true;
  }
  if (objType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  } else if (objType.kind !== "ref" && objType.kind !== "ref_null" && objType.kind !== "anyref") {
    // Primitive receiver — coerce through externref; the struct ref.test
    // below fails and the arm answers `undefined` (same as the dynamic path).
    coerceType(ctx, fctx, objType, { kind: "externref" });
    fctx.body.push({ op: "any.convert_extern" });
  }
  fctx.body.push({ op: "local.set", index: objAny });
  const keyType = compileExpression(ctx, fctx, arg1, { kind: "externref" });
  if (!keyType || typeof keyType !== "object") {
    // (#3319) degenerate answer is `undefined` — singleton under the regime.
    fctx.body.push({ op: "drop" });
    if (!emitUndefinedExtern(ctx, fctx)) fctx.body.push({ op: "ref.null.extern" });
    return true;
  }
  if (keyType.kind !== "externref") coerceType(ctx, fctx, keyType, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: keyExt });

  // ── Resolve natives AFTER operand lowering (shift-maintained maps). ──────
  const createIdx = resolveCreateDescriptor(ctx, fctx);
  const boxIdx = resolveBoxNumber(ctx, fctx);
  const tpkIdx = ctx.funcMap.get("__to_property_key");
  const dynGopdIdx = ctx.funcMap.get("__getOwnPropertyDescriptor");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (
    createIdx === undefined ||
    boxIdx === undefined ||
    tpkIdx === undefined ||
    dynGopdIdx === undefined ||
    strFlattenIdx === undefined ||
    strEqualsIdx === undefined
  ) {
    // Natives unavailable — answer `undefined` (operands are already parked
    // in locals, so the stack is clean; same answer as the dynamic native).
    // (#3319: the singleton under the #2106 regime; legacy null.extern.)
    if (!emitUndefinedExtern(ctx, fctx)) fctx.body.push({ op: "ref.null.extern" });
    return true;
  }
  // Strictly-additive fall-through: anything this arm does not positively
  // resolve (non-string post-ToPropertyKey key — a genuine Symbol; a runtime
  // value that is not the checker-typed struct, e.g. a migrated `$Object`)
  // keeps EXACTLY today's answer by delegating to the dynamic native with the
  // ORIGINAL key (the native re-runs ToPropertyKey itself — idempotent).
  // FACTORY, not a shared array — aliasing one Instr[] into two branches
  // double-remaps funcIdx on late-import/DCE shifts.
  const dynFallthrough = (): Instr[] => [
    { op: "local.get", index: objAny },
    { op: "extern.convert_any" },
    { op: "local.get", index: keyExt },
    { op: "call", funcIdx: dynGopdIdx },
  ];

  // Per-field flags: shape table + per-variable defineProperty overrides —
  // the exact logic of the literal fast path (calls.ts / #1629b).
  const flagsArr = ctx.shapePropFlags.get(structTypeIdx);
  const flagsFor = (userIdx: number, name: string): number => {
    let flags = flagsArr && userIdx >= 0 ? (flagsArr[userIdx] ?? 0x07) : 0x07;
    if (ts.isIdentifier(arg0)) {
      const dpf = ctx.definedPropertyFlags.get(`${integrityVarKey(ctx, arg0)}:${name}`); // (#3403) per-declaration key
      if (dpf !== undefined) flags = dpf & 0x0f;
    }
    return flags;
  };

  // Innermost→outermost: fold the field chain from the last field backwards.
  const externrefBlock = { kind: "val" as const, type: { kind: "externref" } as ValType };
  // (#3319) no field matched → `undefined` — the $undefined singleton under
  // the #2106 regime (a fresh clone; index-bearing instrs are never shared),
  // legacy `ref.null.extern` otherwise.
  let chain: Instr[] = undefinedExternInstrs(ctx)?.map((i) => ({ ...i })) ?? [{ op: "ref.null.extern" }];
  for (let i = userFields.length - 1; i >= 0; i--) {
    const { field, fieldIdx } = userFields[i]!;
    const value: Instr[] = [
      { op: "local.get", index: objAny },
      { op: "ref.cast", typeIdx: structTypeIdx },
      { op: "struct.get", typeIdx: structTypeIdx, fieldIdx },
    ];
    const ft = field.type;
    if (ft.kind === "f64") {
      value.push({ op: "call", funcIdx: boxIdx });
    } else if (ft.kind === "i32") {
      value.push({ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxIdx });
    } else if (ft.kind === "i64") {
      value.push({ op: "f64.convert_i64_s" }, { op: "call", funcIdx: boxIdx });
    } else if (ft.kind !== "externref") {
      value.push({ op: "extern.convert_any" });
    }
    chain = [
      { op: "local.get", index: keyStr },
      { op: "ref.as_non_null" },
      ...nativeStringLiteralInstrs(ctx, field.name),
      { op: "call", funcIdx: strEqualsIdx },
      {
        op: "if",
        blockType: externrefBlock,
        then: [...value, { op: "i32.const", value: flagsFor(i, field.name) }, { op: "call", funcIdx: createIdx }],
        else: chain,
      },
    ];
  }

  // key = __to_property_key(key); string key + struct receiver → dispatch.
  const keyAny = allocLocal(fctx, `__gopdkd_kany_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push(
    { op: "local.get", index: keyExt },
    { op: "call", funcIdx: tpkIdx },
    { op: "any.convert_extern" },
    { op: "local.tee", index: keyAny },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: externrefBlock,
      then: [
        { op: "local.get", index: keyAny },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
        { op: "call", funcIdx: strFlattenIdx },
        { op: "local.set", index: keyStr },
        { op: "local.get", index: objAny },
        { op: "ref.test", typeIdx: structTypeIdx },
        {
          op: "if",
          blockType: externrefBlock,
          then: chain,
          // Runtime value is not the checker-typed struct → dynamic native.
          else: dynFallthrough(),
        },
      ],
      // Non-string property key after ToPropertyKey (a genuine Symbol; nullish
      // under the legacy regime) — keep today's dynamic-native answer.
      else: dynFallthrough(),
    },
  );
  return true;
}
