// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6713) `[[Call]]` / `[[Construct]]` of the `RegExp` and Error-family
 * constructor CARRIERS when they are held in a variable (`--target standalone`).
 *
 * ## The gap
 * lodash's `runInContext` aliases the realm constructors it uses:
 *
 *     var RegExp = context.RegExp, Error = context.Error, TypeError = context.TypeError;
 *     var reIsNative = RegExp('^' + … + '$');
 *
 * Standalone reifies those constructors as identity-stable `$Object` carriers
 * (`__builtin_ctor_RegExp`, #3006; the Error-family namespace carriers, #2907),
 * and #6711 seeds them on the realm object. Every SYNTACTIC `RegExp(…)` /
 * `new TypeError(…)` is intercepted by name before identifier resolution, but a
 * carrier reached through a VALUE matched nothing: the dynamic-call bridge
 * (`__apply_closure`) has no arm for it and answered undefined (so
 * `reIsNative.test` threw "Cannot read properties of undefined" at module
 * init), and the dynamic `new` chain's TypedArray / bound / runtime-eval arms
 * all declined, leaving `new RegExp(p)` / `new TypeError(m)` null.
 *
 * ## The lowering
 * One small helper per constructor, minted mid-compile when a call or `new`
 * site's callee TRACES to that constructor's name
 * ({@link tracedBuiltinCtorValueName}):
 *
 *   __builtin_ctor_value_RegExp(pattern, flags, isCall) — §22.2.4.1, the same
 *     sequence the static `RegExp(obj)` lane emits (regexp-ctor-regexp-like.ts),
 *     with step 2's call-spelling identity shortcut gated on the runtime bit.
 *   __builtin_ctor_value_<Error>(message) — §20.5.1.1: ToString(message) unless
 *     undefined, then the native `__new_<Error>` `$Error_struct` ctor. Calling
 *     and constructing an Error are the same operation (step 1).
 *
 * The runtime DECISION is reference identity against the carrier global, never
 * the name: a traced name only decides whether the helper is minted (a cost
 * question — the RegExp helper pulls in the runtime pattern compiler), so a
 * wrong trace can cost bytes but can never construct the wrong thing. The arms
 * live in the shared bridges (`__apply_closure`'s front guard for `[[Call]]`,
 * a retry-on-null after the dynamic `new` chain for `[[Construct]]`), and a
 * module with no traced site mints nothing and is byte-identical.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { ensureSpecExternrefToStringProvider } from "./coercion-engine.js";
import {
  reserveBuiltinConstructorIdentityGlobal,
  reserveBuiltinNamespaceObjectGlobal,
} from "./builtin-static-globals.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { noJsHost } from "./js-errors.js";
import { resolvesToAmbientGlobal } from "./expressions/non-constructable.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { isSingleAssignmentBinding } from "./proxy-value-provenance.js";
import {
  regExpCtorOperationInstrs,
  registerRegExpCtorRuntime,
  resolveRegExpCtorOps,
} from "./regexp-ctor-regexp-like.js";
import { hasStandaloneRegExpEngine } from "./regexp-standalone.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addFuncType } from "./registry/types.js";
import { coerceType, compileExpression } from "./shared.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
/** WasmGC abstract `eq` heap type (reference identity needs both sides `eq`). */
const EQ_HEAP_TYPE = -19;
const TRACE_DEPTH_LIMIT = 8;

const ERROR_CTOR_NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
] as const;
type InvokeCtorName = "RegExp" | (typeof ERROR_CTOR_NAMES)[number];
const INVOKE_CTOR_NAMES: readonly InvokeCtorName[] = ["RegExp", ...ERROR_CTOR_NAMES];

function isInvokeCtorName(name: string): name is InvokeCtorName {
  return (INVOKE_CTOR_NAMES as readonly string[]).includes(name);
}

function helperName(name: InvokeCtorName): string {
  return `__builtin_ctor_value_${name}`;
}

/** The `builtinObjectGlobals` key of the constructor's carrier value. */
function carrierKey(name: InvokeCtorName): string {
  return name === "RegExp" ? "ctor:RegExp" : name;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

/**
 * The constructor name a callee traces to: `X.RegExp` / `X["TypeError"]` off
 * ANY receiver (lodash's `context.RegExp` — the receiver is a parameter), the
 * ambient global itself, or a single-assignment alias of either.
 */
export function tracedBuiltinCtorValueName(
  ctx: CodegenContext,
  expr: ts.Expression,
  depth = 0,
): InvokeCtorName | undefined {
  if (depth > TRACE_DEPTH_LIMIT) return undefined;
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) {
    const init = ctx.oracle.variableInitializerOf(e);
    if (init && init !== e) {
      if (!isSingleAssignmentBinding(ctx, e)) return undefined;
      return tracedBuiltinCtorValueName(ctx, init, depth + 1);
    }
    // Deno captures primordials with const { Error, TypeError: Alias } = bag.
    // This is only a candidate name: dispatch still compares the evaluated
    // constructor with the canonical carrier. Never infer intrinsic identity
    // from a property name (the bag may contain an arbitrary user function).
    const declarations = ctx.oracle.declarationsOf(e);
    if (declarations.length === 1) {
      const binding = declarations[0]!;
      if (
        ts.isBindingElement(binding) &&
        !binding.dotDotDotToken &&
        !binding.initializer &&
        ts.isObjectBindingPattern(binding.parent)
      ) {
        const declaration = binding.parent.parent;
        const property = binding.propertyName ?? binding.name;
        if (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          ts.isVariableDeclarationList(declaration.parent) &&
          (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
          (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) &&
          isInvokeCtorName(property.text)
        )
          return property.text;
      }
    }
    return isInvokeCtorName(e.text) && resolvesToAmbientGlobal(ctx, e) ? e.text : undefined;
  }
  if (ts.isPropertyAccessExpression(e)) return isInvokeCtorName(e.name.text) ? e.name.text : undefined;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    const key = e.argumentExpression.text;
    return isInvokeCtorName(key) ? key : undefined;
  }
  return undefined;
}

/**
 * A LOCAL binding that merely shares a builtin class's spelling — lodash's
 * `var RegExp = context.RegExp` — is not that extern class. In the host-free
 * lanes the name-keyed extern-class `new` path would request a `__new_RegExp`
 * import that cannot exist and construct null; the host lane keeps that path.
 */
export function shadowsExternClassName(ctx: CodegenContext, id: ts.Identifier): boolean {
  return noJsHost(ctx) && !resolvesToAmbientGlobal(ctx, id) && tracedBuiltinCtorValueName(ctx, id) !== undefined;
}

function mintHelper(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  build: (hfctx: FunctionContext) => void,
): void {
  const typeIdx = addFuncType(ctx, params, [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  const hfctx: FunctionContext = {
    name,
    params: params.map((type, i) => ({ name: `p${i}`, type })),
    locals: [],
    localMap: new Map(),
    returnType: EXTERNREF,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  build(hfctx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals: hfctx.locals, body: hfctx.body, exported: false });
}

/** `(pattern, flags, isCall: i32) -> externref` — §22.2.4.1 for both spellings. */
function prepareRegExpHelper(ctx: CodegenContext, fctx: FunctionContext): boolean {
  if (!hasStandaloneRegExpEngine(ctx)) return false;
  const registered = registerRegExpCtorRuntime(ctx, fctx, true);
  if (registered === undefined) return false;
  const ops = resolveRegExpCtorOps(ctx, registered.structTypeIdx);
  if (ops === undefined) return false;
  mintHelper(ctx, helperName("RegExp"), [EXTERNREF, EXTERNREF, I32], (hfctx) => {
    const locals = {
      pat: 0,
      flg: 1,
      isRe: allocLocal(hfctx, "isRe", I32),
      tmp: allocLocal(hfctx, "tmp", EXTERNREF),
      p: allocLocal(hfctx, "p", EXTERNREF),
      f: allocLocal(hfctx, "f", EXTERNREF),
    };
    hfctx.body.push(
      ...regExpCtorOperationInstrs(ctx, ops, locals, {
        ctorGlobal: registered.ctorGlobal,
        gate: [{ op: "local.get", index: 2 }],
      }),
    );
  });
  return true;
}

/** `(message) -> externref` — §20.5.1.1 steps 2-3 over the native ctor. */
function prepareErrorHelper(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: (typeof ERROR_CTOR_NAMES)[number],
): boolean {
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  emitWasiErrorConstructor(ctx, name, 1);
  flushLateImportShifts(ctx, fctx);
  // §7.1.17 ToString including its Symbol rule (a Symbol message throws).
  const toStr = ensureSpecExternrefToStringProvider(ctx, fctx);
  const isUndefinedFn = ctx.funcMap.get("__extern_is_undefined");
  const ctorIdx = ctx.funcMap.get(`__new_${name}`);
  if (toStr === undefined || isUndefinedFn === undefined || ctorIdx === undefined) return false;
  mintHelper(ctx, helperName(name), [EXTERNREF], (hfctx) => {
    hfctx.body.push(
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isUndefinedFn },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "val", type: EXTERNREF },
        // undefined message → no own `message` (renders the name alone).
        then: [{ op: "ref.null.extern" }],
        else: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: toStr },
        ],
      },
      { op: "call", funcIdx: ctorIdx },
    );
  });
  return true;
}

/**
 * Mint the helper for the constructor `callee` traces to (idempotent). Must run
 * mid-compile, before the caller captures any function index — it registers
 * natives. Returns the traced name when a helper exists afterwards.
 */
export function prepareBuiltinCtorValueInvoke(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callee: ts.Expression,
): InvokeCtorName | undefined {
  if (ctx.standalone !== true || ctx.wasi === true) return undefined;
  const name = tracedBuiltinCtorValueName(ctx, callee);
  if (name === undefined) return undefined;
  return prepareNamedBuiltinCtorValueInvoke(ctx, fctx, name);
}

function prepareNamedBuiltinCtorValueInvoke(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: InvokeCtorName,
): InvokeCtorName | undefined {
  if (ctx.funcMap.has(helperName(name))) return name;
  const ok = name === "RegExp" ? prepareRegExpHelper(ctx, fctx) : prepareErrorHelper(ctx, fctx, name);
  if (!ok) return undefined;
  // Reserve (not materialize) the carrier slot the arms compare against: the
  // read that fills it may be compiled after this site, and an unfilled slot
  // never compares equal.
  if (name === "RegExp") reserveBuiltinConstructorIdentityGlobal(ctx, "RegExp");
  else reserveBuiltinNamespaceObjectGlobal(ctx, name);
  return name;
}

/** `[] → [i32]`: `calleeExtern` is reference-identical to the carrier in `globalIdx`. */
function carrierIdentityTest(calleeExtern: () => Instr[], globalIdx: number): Instr[] {
  return [
    ...calleeExtern(),
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    { op: "global.get", index: globalIdx },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [
        ...calleeExtern(),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
        { op: "global.get", index: globalIdx },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
        { op: "ref.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}

/** The helper call for `name`, with `argOf(k)` pushing argument k (undefined when absent). */
function helperCallInstrs(
  ctx: CodegenContext,
  name: InvokeCtorName,
  argOf: (k: number) => Instr[],
  isCall: boolean,
): Instr[] | undefined {
  const idx = ctx.funcMap.get(helperName(name));
  if (idx === undefined) return undefined;
  if (name === "RegExp") {
    return [...argOf(0), ...argOf(1), { op: "i32.const", value: isCall ? 1 : 0 }, { op: "call", funcIdx: idx }];
  }
  return [...argOf(0), { op: "call", funcIdx: idx }];
}

/** Every minted helper whose carrier global exists, in a fixed order. */
function armedNames(ctx: CodegenContext): { name: InvokeCtorName; globalIdx: number }[] {
  const out: { name: InvokeCtorName; globalIdx: number }[] = [];
  for (const name of INVOKE_CTOR_NAMES) {
    if (!ctx.funcMap.has(helperName(name))) continue;
    const globalIdx = ctx.builtinObjectGlobals.get(carrierKey(name));
    if (globalIdx !== undefined) out.push({ name, globalIdx });
  }
  return out;
}

/**
 * `__apply_closure` front-guard arms (`[[Call]]`): param 0 is the callee.
 * Empty — byte-identical — unless a traced site minted a helper.
 */
export function builtinCtorValueCallArmInstrs(ctx: CodegenContext, argOf: (k: number) => Instr[]): Instr[] {
  if (ctx.standalone !== true) return [];
  const instrs: Instr[] = [];
  for (const { name, globalIdx } of armedNames(ctx)) {
    const call = helperCallInstrs(ctx, name, argOf, true);
    if (call === undefined) continue;
    instrs.push(...carrierIdentityTest(() => [{ op: "local.get", index: 0 }], globalIdx), {
      op: "if",
      blockType: { kind: "empty" },
      then: [...call, { op: "return" }],
    });
  }
  return instrs;
}

/**
 * `[[Construct]]` retry for a dynamic `new` whose chain left null on the stack
 * (`[externref] → [externref]`): when the callee traces to a carrier this
 * module owns a helper for, a null result is retried against that carrier.
 * `calleeAnyLocal` holds the evaluated callee (anyref), `argLocals` the
 * evaluated externref arguments. Emits nothing for any other callee.
 */
export function emitBuiltinCtorValueConstructOnNull(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callee: ts.Expression,
  calleeAnyLocal: number,
  argLocals: readonly number[],
): void {
  const name = prepareBuiltinCtorValueInvoke(ctx, fctx, callee);
  if (name === undefined) return;
  const globalIdx = ctx.builtinObjectGlobals.get(carrierKey(name));
  if (globalIdx === undefined) return;
  const missing = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
  const argOf = (k: number): Instr[] =>
    k < argLocals.length ? [{ op: "local.get", index: argLocals[k]! }] : missing();
  const call = helperCallInstrs(ctx, name, argOf, false);
  if (call === undefined) return;
  const priorLocal = allocLocal(fctx, `__bcv_prior_${fctx.locals.length}`, EXTERNREF);
  const calleeExtern = (): Instr[] => [{ op: "local.get", index: calleeAnyLocal }, { op: "extern.convert_any" }];
  fctx.body.push(
    { op: "local.tee", index: priorLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [
        ...carrierIdentityTest(calleeExtern, globalIdx),
        {
          op: "if",
          blockType: { kind: "val", type: EXTERNREF },
          then: call,
          else: [{ op: "local.get", index: priorLocal }],
        },
      ],
      else: [{ op: "local.get", index: priorLocal }],
    },
  );
}

/** A function/class/method body anywhere in `node` — compiling it twice would lift it twice. */
function containsFunctionLike(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isArrowFunction(n) ||
      ts.isFunctionExpression(n) ||
      ts.isClassExpression(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isAccessor(n)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

const aliasInvokeInFlight = new WeakSet<ts.Node>();

/**
 * A TYPED alias — `var R = globalThis.RegExp; R(p)` / `var E = globalThis.Error;
 * new E(m)`. The callee carries the lib constructor interface, so it takes the
 * typed closure-call / extern-class `new` lowerings, which cannot dispatch a
 * `$Object` carrier (a null-deref / illegal-cast trap, or `undefined`).
 *
 * Emits `callee === <carrier> ? helper(args) : <today's lowering>`. The else
 * arm is today's lowering VERBATIM (re-entered with this hook disabled for the
 * node), so every value that is not the carrier keeps its exact existing
 * behaviour. The callee is an identifier, whose read is side-effect free, so
 * evaluating it for the test and again inside the else arm is unobservable;
 * the arguments are evaluated once on either arm. Arguments containing a
 * function/class body decline (both arms would lift it).
 */
export function tryCompileBuiltinCtorAliasInvoke(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression | ts.NewExpression,
): ValType | undefined {
  if (ctx.standalone !== true || ctx.wasi === true || aliasInvokeInFlight.has(expr)) return undefined;
  if (ts.isCallExpression(expr) && expr.questionDotToken) return undefined;
  const callee = unwrap(expr.expression);
  if (!ts.isIdentifier(callee) || resolvesToAmbientGlobal(ctx, callee)) return undefined;
  const fact = ctx.oracle.typeFactOf(callee);
  const dynamic = fact.kind === "any" || fact.kind === "unknown";
  // Generic construction of an Error carrier through a parameter cannot rely
  // on name tracing. Guard canonical identities before the function-constructor
  // lane, which can otherwise manufacture a plain object for that carrier.
  if (dynamic && !ts.isNewExpression(expr)) return undefined;
  const args = expr.arguments ?? [];
  if (args.some((a) => ts.isSpreadElement(a) || containsFunctionLike(a))) return undefined;
  const traced = tracedBuiltinCtorValueName(ctx, callee);
  if (!dynamic && traced === undefined) return undefined;
  const names: readonly InvokeCtorName[] = traced === undefined ? ERROR_CTOR_NAMES : [traced];
  const candidates = names.flatMap((name) => {
    if (prepareNamedBuiltinCtorValueInvoke(ctx, fctx, name) === undefined) return [];
    const globalIdx = ctx.builtinObjectGlobals.get(carrierKey(name));
    return globalIdx === undefined ? [] : [{ name, globalIdx }];
  });
  if (candidates.length === 0) return undefined;

  const calleeLocal = allocLocal(fctx, `__bcv_callee_${fctx.locals.length}`, EXTERNREF);
  const calleeTy = compileExpression(ctx, fctx, callee);
  if (calleeTy === null) fctx.body.push({ op: "ref.null.extern" });
  else if (calleeTy.kind !== "externref") coerceType(ctx, fctx, calleeTy, EXTERNREF);
  fctx.body.push({ op: "local.set", index: calleeLocal });

  const outer = fctx.body;
  const thenBody: Instr[] = [];
  const elseBody: Instr[] = [];
  fctx.savedBodies.push(outer);
  try {
    fctx.body = thenBody;
    const argLocals: number[] = [];
    for (const arg of args) {
      const t = compileExpression(ctx, fctx, arg, EXTERNREF);
      if (t === null) fctx.body.push({ op: "ref.null.extern" });
      else if (t.kind !== "externref") coerceType(ctx, fctx, t, EXTERNREF);
      const local = allocLocal(fctx, `__bcv_arg_${fctx.locals.length}`, EXTERNREF);
      fctx.body.push({ op: "local.set", index: local });
      argLocals.push(local);
    }
    const missing = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
    const argOf = (k: number): Instr[] =>
      k < argLocals.length ? [{ op: "local.get", index: argLocals[k]! }] : missing();
    let dispatch: Instr[] = [{ op: "ref.null.extern" }];
    for (const { name, globalIdx } of candidates.slice().reverse()) {
      dispatch = [
        ...carrierIdentityTest(() => [{ op: "local.get", index: calleeLocal }], globalIdx),
        {
          op: "if",
          blockType: { kind: "val", type: EXTERNREF },
          then: helperCallInstrs(ctx, name, argOf, ts.isCallExpression(expr)) ?? [{ op: "ref.null.extern" }],
          else: dispatch,
        },
      ];
    }
    fctx.body.push(...dispatch);

    fctx.savedBodies.push(thenBody);
    fctx.body = elseBody;
    aliasInvokeInFlight.add(expr);
    let original: ValType | null;
    try {
      // Through the full expression dispatcher, so a lowering that refuses
      // (`reportError; return null`) is rolled back exactly as it is today.
      original = compileExpression(ctx, fctx, expr);
    } finally {
      aliasInvokeInFlight.delete(expr);
    }
    if (original === null) fctx.body.push({ op: "ref.null.extern" });
    else if (original.kind !== "externref") coerceType(ctx, fctx, original, EXTERNREF);
    fctx.savedBodies.pop(); // thenBody
  } finally {
    fctx.body = outer;
    fctx.savedBodies.pop(); // outer
  }
  const matches: Instr[] = [];
  for (const [index, { globalIdx }] of candidates.entries()) {
    matches.push(...carrierIdentityTest(() => [{ op: "local.get", index: calleeLocal }], globalIdx));
    if (index > 0) matches.push({ op: "i32.or" });
  }
  outer.push(...matches, {
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    then: thenBody,
    else: elseBody,
  });
  return EXTERNREF;
}
