// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2660 M3) The runtime edge from a FUNCTION VALUE to its prototype object,
 * under `--target standalone` / `--target wasi`.
 *
 * ## The gap this closes
 *
 * A user constructor's prototype object already exists in standalone, and the
 * `[[Prototype]]` link from its instances already points at it — probe-verified
 * on the base of this branch: `Object.getPrototypeOf(new F()) === F.prototype`
 * is **true**, and `new F().q` reads through it. What is missing is the edge in
 * the OTHER direction: from the function VALUE to that object.
 *
 * The reason is that the prototype object is keyed by a COMPILE-TIME name, in
 * two disjoint registries:
 *
 *  - user function constructors — `ctx.fnctorPrototypeObject`, a per-fnctor
 *    `mut externref` module global keyed by the fnctor's symbol name (#2660 S2,
 *    `expressions/fnctor-prototype.ts`);
 *  - classes — `ctx.protoGlobals`, keyed by class name (`class-proto-object.ts`).
 *
 * Both are reached only from a site where the compiler already knows WHICH
 * function it is looking at (`F.prototype`, `new F()`). A value that arrives at
 * runtime — an `any`-typed local, a parameter, a property read — carries no such
 * name, so every dynamic consumer answered `undefined`. Measured on the base of
 * this branch, `--target standalone`:
 *
 * | shape                                                     | before |
 * | --------------------------------------------------------- | ------ |
 * | `function F(){}; var K:any = F; typeof K["prototype"]`     | `"undefined"` |
 * | `function F(){}; F.prototype={q:7}; K["prototype"].q`      | `undefined` (the STATIC read answers 7 — split brain) |
 * | `var i = new F(); i instanceof K`                          | `false` (spec: `true`) |
 *
 * The third row is the one #2916 names as its single remaining dependency: the
 * §7.3.20 `OrdinaryHasInstance` arm in `native-dynamic-instanceof.ts` cannot
 * perform `Get(C, "prototype")` on a closure, so a closure RHS is answered with
 * the conservative `false`.
 *
 * ## What this module adds
 *
 * ONE native `__closure_proto_of(target: externref) -> externref`, keyed by the
 * VALUE's runtime IDENTITY rather than by a compile-time name. It answers the
 * externref held in the compile-time registry when `target` is `ref.eq` to the
 * canonical singleton for that function, and `null` otherwise.
 *
 * The identity handles already exist and are singletons by construction:
 *
 *  - `ctx.funcClosureGlobals` (#1340) — `__fn_closure_<name>`, the cached closure
 *    struct for a top-level function declaration read as a value. It exists
 *    precisely so `foo === foo` holds, which is what makes `ref.eq` a sound key.
 *  - `ctx.classObjectGlobals` (#1395) — `__class_<Name>`, the class-object
 *    singleton.
 *
 * ## Why this cannot answer a wrong `true`
 *
 * The lookup is an `ref.eq` IDENTITY match against a singleton the compiler
 * minted, and the value it returns is the SAME object the `[[Prototype]]`
 * seeding reads (`emitFnctorProtoGet` / `protoGlobals`). So a consumer either
 * gets the genuine `Get(C, "prototype")` or gets `null` and keeps its existing
 * conservative answer. There is no arm that infers membership from a type test,
 * a name match, or a shape — the two failure modes #2916 forbids (a wrong `true`
 * and a wrong throw) are structurally unreachable.
 *
 * Functions with no singleton global — a nested `function` memoized in a LOCAL
 * (`funcref-as-closure.ts`), an arrow, a `Function(…)` value built at runtime —
 * are simply absent from the table and answer `null`. That is a missed
 * conversion, never a wrong one. In particular an ARROW keeps answering
 * `undefined` for `.prototype`, which is what §15.3 requires and what this
 * module must not break: it is not in the table because it never gets a
 * per-fnctor prototype global, not because of an ad-hoc exclusion.
 *
 * ## Vivification, and why only on the fnctor arm
 *
 * A fnctor's prototype global is created lazily and starts `null`; `new F()` and
 * a static `F.prototype` read both vivify it through
 * `emitFnctorProtoGet` (`__new_plain_object` into the same global). This module
 * vivifies identically, so whichever site runs first, all three agree on ONE
 * object identity — the invariant the whole #2660 substrate rests on.
 *
 * The CLASS arm deliberately does NOT vivify. `ctx.protoGlobals` is populated by
 * `class-proto-object.ts` / `emitLazyProtoGet`, which build a specific
 * `$Object` with the class's methods installed at §17 attributes; minting an
 * empty object here would be a SECOND, wrong prototype identity. A null class
 * proto global answers `null` and the consumer keeps its conservative answer.
 *
 * ## Index-space discipline
 *
 * Reserve-then-fill, exactly like `closure-props.ts`: the helper is reserved at
 * `ensureObjectRuntime` time (so any consumer can bake a stable `call <idx>`)
 * with a `ref.null.extern` body, and filled at FINALIZE, once every fnctor
 * global, class global and closure singleton has been registered. Nothing is
 * MINTED at finalize (the #4221 hazard); the fill only swaps a body.
 *
 * Gated on `ctx.standalone || ctx.wasi`. In gc/host mode the host owns the
 * dynamic-property and `instanceof` paths, nothing here is reserved, and the
 * output is byte-identical.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ts } from "../ts-api.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";

/** WasmGC `eq` abstract heap type — the key domain for the identity match. */
const EQ_HEAP_TYPE = -19;

/** `__closure_proto_of(value) -> externref` — null when the value has no edge. */
export const CLOSURE_PROTO_OF = "__closure_proto_of";

/** Param / local slots of the helper body. */
const P_TARGET = 0;
const L_TARGET_EQ = 1;
const L_CAND = 2;

/**
 * One resolved edge: the module global holding the canonical function VALUE, and
 * the module global holding that function's prototype object.
 */
interface PrototypeEdge {
  /** `__fn_closure_<name>` / `__class_<Name>` — the identity key (externref). */
  valueGlobalIdx: number;
  /** `__fnctor_proto_<name>` / the class proto singleton (externref). */
  protoGlobalIdx: number;
  /** Vivify an empty `$Object` into the proto global when it is still null. */
  vivify: boolean;
  /** Diagnostic only — the compile-time name both registries agreed on. */
  name: string;
}

/**
 * The module global is a canonical function value only while its binding is
 * never replaced. Function-expression fnctors (`var F = function(){}`) do not
 * get a cached `__fn_closure_F` singleton, so the edge collector falls back to
 * their mutable module global; an assignment such as `F = G` would otherwise
 * make that global match the stale `F` prototype. Conservatively reject the
 * fallback for any source-level assignment to the same name. A shadowed local
 * assignment may cause a missed edge, never a wrong prototype identity.
 */
function hasModuleBindingAssignment(ctx: CodegenContext, name: string): boolean {
  const declaration = ctx.fnctorEscapeGate?.ctorDeclByName.get(name) ?? singletonFunctionDeclaration(ctx, name);
  const sourceFile = declaration?.getSourceFile();
  if (sourceFile === undefined) return ctx.liveFuncBindingGlobals?.has(name) === true;

  let reassigned = false;
  const visit = (node: ts.Node): void => {
    if (reassigned) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      reassigned = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name
    ) {
      reassigned = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return reassigned;
}

/**
 * (#6684) The source declaration behind a function DECLARATION's cached value
 * singleton (`__fn_closure_<name>`), when the escape gate did not record one.
 *
 * Under a runtime-eval consumer (any module containing `Function(…)`/`eval`,
 * e.g. lodash-es's `template`) every top-level function binding is a #2931 live
 * binding, so the bare `liveFuncBindingGlobals` fallback above rejected EVERY
 * edge: `F.prototype` read dynamically answered `undefined` (lodash-es:
 * `hasOwnProperty.call(lodash.prototype, name)` threw at module init). The
 * singleton is the function object's own identity — replacing the binding
 * later cannot make it name another function — so the source scan for a
 * source-level reassignment is the right test here too. Only the singleton arm
 * is widened; the mutable-module-global fallback keeps its conservative answer.
 */
function singletonFunctionDeclaration(ctx: CodegenContext, name: string): ts.FunctionDeclaration | undefined {
  if (!ctx.funcClosureGlobals.has(name)) return undefined;
  const handle = ctx.funcMap.get(name);
  return handle === undefined ? undefined : ctx.sourceFunctionDeclarationByHandle.get(handle);
}

/** Return the canonical function-value global for an approved fnctor name. */
function fnctorPrototypeValueGlobalIdx(ctx: CodegenContext, name: string): number | undefined {
  if (hasModuleBindingAssignment(ctx, name)) return undefined;
  return ctx.funcClosureGlobals.get(name) ?? ctx.moduleGlobals.get(name);
}

/**
 * The edges that exist in this module, in a deterministic order (fnctors by
 * registration order, then classes). Both halves of every pair must be present:
 * a function with a prototype global but no singleton VALUE global was never
 * read as a value, so no runtime consumer can hold it.
 */
function collectPrototypeEdges(ctx: CodegenContext): PrototypeEdge[] {
  const edges: PrototypeEdge[] = [];
  for (const [name, protoGlobalIdx] of ctx.fnctorPrototypeObject) {
    // Function declarations use the cached `__fn_closure_<name>` singleton,
    // while `var F = function(){}` publishes the same callable through its
    // module binding global. Both are canonical values for the fnctor edge;
    // the latter is the only value available for expression-backed fnctors.
    const valueGlobalIdx = fnctorPrototypeValueGlobalIdx(ctx, name);
    if (valueGlobalIdx === undefined) continue;
    edges.push({ valueGlobalIdx, protoGlobalIdx, vivify: true, name });
  }
  for (const [name, valueGlobalIdx] of ctx.classObjectGlobals) {
    const protoGlobalIdx = ctx.protoGlobals.get(name);
    if (protoGlobalIdx === undefined) continue;
    edges.push({ valueGlobalIdx, protoGlobalIdx, vivify: false, name });
  }
  return edges;
}

/**
 * True when at least one function value in this module has a reachable
 * prototype object. Consumers use it to keep their emission byte-identical for
 * every module that has none.
 */
export function hasClosurePrototypeEdges(ctx: CodegenContext): boolean {
  return collectPrototypeEdges(ctx).length > 0;
}

/**
 * Reserve `__closure_proto_of` with a `ref.null.extern` body. Called from
 * `ensureObjectRuntime` under `ctx.standalone || ctx.wasi`, BEFORE any consumer
 * bakes its `call <idx>`. Idempotent.
 *
 * The placeholder is a VALID body for the declared result type, not an
 * `unreachable` stub: a module whose fill finds no edges keeps this body, and
 * every consumer's `proto == null ⇒ decline` arm then reproduces its exact
 * previous answer.
 */
export function reserveClosurePrototypeEdge(ctx: CodegenContext): void {
  if (ctx.funcMap.get(CLOSURE_PROTO_OF) !== undefined) return;
  const externref: ValType = { kind: "externref" };
  const typeIdx = addFuncType(ctx, [externref], [externref], `$${CLOSURE_PROTO_OF}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  const placeholder: WasmFunction = {
    name: CLOSURE_PROTO_OF,
    typeIdx,
    locals: [],
    body: [{ op: "ref.null.extern" }],
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, placeholder);
  ctx.funcMap.set(CLOSURE_PROTO_OF, funcIdx);
}

/**
 * Fill the reserved body at FINALIZE, once every fnctor prototype global, class
 * prototype global and function-value singleton is registered. No-op when the
 * helper was never reserved (gc/host) or when the module has no edges — in the
 * latter case the `ref.null.extern` placeholder is already the right answer.
 */
export function fillClosurePrototypeEdge(ctx: CodegenContext): void {
  const funcIdx = ctx.funcMap.get(CLOSURE_PROTO_OF);
  if (funcIdx === undefined) return;
  const fn = definedFuncAt(ctx, funcIdx);
  if (!fn) return;
  const edges = collectPrototypeEdges(ctx);
  if (edges.length === 0) return;

  const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object");
  const defineValueIdx = ctx.funcMap.get("__defineProperty_value");

  /**
   * (#6771 S7) §10.2.5 MakeConstructor step 5: the vivified prototype owns
   * `constructor` = the function — the value this edge matched by identity.
   * `emitFnctorProtoGet` installs it when a STATIC site vivifies first; a
   * dynamic `Get(F, "prototype")` (`Array.from.call(C, …)`'s Construct) that
   * vivified first left it absent for good (`from/iter-cstm-ctor.js`).
   */
  const constructorInstall = (edge: PrototypeEdge): Instr[] =>
    defineValueIdx === undefined
      ? []
      : [
          { op: "global.get", index: edge.protoGlobalIdx },
          ...nativeStringLiteralInstrs(ctx, "constructor"),
          { op: "extern.convert_any" },
          { op: "global.get", index: edge.valueGlobalIdx },
          { op: "f64.const", value: 0x01 | 0x04 }, // {writable, !enumerable, configurable}
          { op: "call", funcIdx: defineValueIdx },
          { op: "drop" },
        ];

  /** Leave the edge's prototype object on the stack, vivifying if asked. */
  const loadProto = (edge: PrototypeEdge): Instr[] => {
    const out: Instr[] = [];
    if (edge.vivify && newPlainObjectIdx !== undefined) {
      out.push(
        { op: "global.get", index: edge.protoGlobalIdx },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "call", funcIdx: newPlainObjectIdx },
            { op: "global.set", index: edge.protoGlobalIdx },
            ...constructorInstall(edge),
          ],
        },
      );
    }
    out.push({ op: "global.get", index: edge.protoGlobalIdx });
    return out;
  };

  const body: Instr[] = [
    // A null value has no identity to match.
    { op: "local.get", index: P_TARGET },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },
    // `ref.eq` needs an `eqref`. `ref.test (ref eq)` answers 0 for a host
    // externref that is not a GC object, so the `ref.cast` below cannot trap.
    { op: "local.get", index: P_TARGET },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },
    { op: "local.get", index: P_TARGET },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
    { op: "local.set", index: L_TARGET_EQ },
  ];

  for (const edge of edges) {
    body.push(
      // A singleton global is `null` until the function is first read as a
      // value; skip those rather than comparing against null.
      { op: "global.get", index: edge.valueGlobalIdx },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "global.get", index: edge.valueGlobalIdx },
          { op: "any.convert_extern" },
          { op: "local.tee", index: L_CAND },
          { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: L_CAND },
              { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
              { op: "local.get", index: L_TARGET_EQ },
              { op: "ref.eq" },
              { op: "if", blockType: { kind: "empty" }, then: [...loadProto(edge), { op: "return" }] },
            ],
          },
        ],
      },
    );
  }

  body.push({ op: "ref.null.extern" });

  fn.locals = [
    { name: "__targetEq", type: { kind: "eqref" } },
    { name: "__cand", type: { kind: "anyref" } },
  ];
  fn.body = body;
}

/**
 * (#6651 SP1) `__defineProperty_value` flag word for §20.2.4.2's mandatory
 * `prototype` own property: `{writable: true, enumerable: false,
 * configurable: false}`, with the host encoding's "all three attributes and the
 * value are specified" mask. The SAME constant `closure-props.ts`'s
 * `buildFnctorPrototypeWriteArm` uses for `f.prototype = v`, so the descriptor a
 * lazy vivify installs and the one an explicit write installs cannot drift.
 */
const PROTOTYPE_OWN_FLAGS = 0xb9;

/**
 * (#6651 SP1) Build the lazy §10.2.5 MakeConstructor tail for the `prototype`
 * GET arm, or `undefined` when this module cannot host it.
 *
 * Returns a FACTORY for the same reason `consultEdge` is one: an `Instr` object
 * reached from two body positions is remapped twice by the finalize index walks.
 *
 * Declines — leaving the arm byte-identical to its pre-#6651 shape — when the
 * module has no constructible closure wrapper type (nothing to vivify for), or
 * when any of the three natives it needs is unregistered. `__closure_bag_ensure`
 * and `__new_plain_object` are the same two the bag machinery itself uses, and
 * `__defineProperty_value` is the descriptor-exact writer, so a vivified
 * `prototype` is indistinguishable from one the program wrote itself.
 */
function lazyMakeConstructorInstrs(
  ctx: CodegenContext,
  slots: { recvSlot: number; keySlot: number; bagSlot: number; protoSlot: number },
): (() => Instr[]) | undefined {
  const constructibleTypeIdxs = [...ctx.constructibleClosureTypeIdxs].sort((a, b) => a - b);
  if (constructibleTypeIdxs.length === 0) return undefined;
  const bagEnsureIdx = ctx.funcMap.get("__closure_bag_ensure");
  const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object");
  const defineValueIdx = ctx.funcMap.get("__defineProperty_value");
  if (bagEnsureIdx === undefined || newPlainObjectIdx === undefined || defineValueIdx === undefined) return undefined;

  const { recvSlot, keySlot, bagSlot, protoSlot } = slots;
  return () => {
    // `ref.test`-or chain over the exact [[Construct]]-implementing wrapper
    // identities. An arrow / concise method / bound function is not in the set,
    // so it never reaches the vivify and keeps answering `undefined`.
    const isConstructible: Instr[] = [];
    for (const typeIdx of constructibleTypeIdxs) {
      isConstructible.push(
        { op: "local.get", index: recvSlot },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx },
      );
      if (isConstructible.length > 3) isConstructible.push({ op: "i32.or" });
    }
    return [
      ...isConstructible,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: recvSlot },
          { op: "call", funcIdx: bagEnsureIdx },
          { op: "local.set", index: bagSlot },
          { op: "call", funcIdx: newPlainObjectIdx },
          { op: "local.set", index: protoSlot },
          { op: "local.get", index: bagSlot },
          { op: "local.get", index: keySlot }, // proven `ref.eq` to "prototype" above
          { op: "local.get", index: protoSlot },
          { op: "f64.const", value: PROTOTYPE_OWN_FLAGS },
          { op: "call", funcIdx: defineValueIdx },
          { op: "drop" }, // the helper returns its target
          // (#6771 S7) §10.2.5 step 5: `prototype.constructor = F`
          // {writable, !enumerable, configurable} — F is the receiver itself.
          { op: "local.get", index: protoSlot },
          ...nativeStringLiteralInstrs(ctx, "constructor"),
          { op: "extern.convert_any" },
          { op: "local.get", index: recvSlot },
          { op: "f64.const", value: 0x01 | 0x04 },
          { op: "call", funcIdx: defineValueIdx },
          { op: "drop" },
          { op: "local.get", index: protoSlot },
          { op: "return" },
        ],
      },
    ];
  };
}

/**
 * (#2660 M3, half b) The `prototype` arm for `__closure_prop_get` — the dynamic
 * MOP read of `f["prototype"]` / `f.prototype` on a FUNCTION VALUE.
 *
 * Returns an EMPTY array — and therefore leaves `__closure_prop_get`
 * byte-identical, local list included — unless the module actually has an edge
 * and every native this needs is registered.
 *
 * ## Precedence: an own bag entry always wins
 *
 * `f.prototype = v` lands in the closure's own-property bag (#3468), and that is
 * the program's explicit state — including `f.prototype = undefined`, which
 * §7.3.20 step 5 requires to be observable as a non-object (a TypeError for
 * `instanceof`). Consulting the edge FIRST would silently replace it with the
 * compile-time prototype object, i.e. would make a wrong answer out of a right
 * one. So the arm asks `__hasOwnProperty` on the bag first and declines on a
 * hit. That is also why the check is not "did the bag read return undefined":
 * an own `prototype` explicitly set to `undefined` is indistinguishable from an
 * absent one by value, and the two must behave oppositely.
 *
 * ## Cost
 *
 * Everything is behind an interned-literal `ref.eq` on the KEY, so a read of any
 * other property pays one `ref.test` + `ref.cast` + `ref.eq`. A key that is not
 * the interned literal (a rope, a runtime-built string) misses and keeps the
 * pre-existing answer — the same deliberate limitation `fillClosureMethodCall`
 * documents for its method-name matching.
 *
 * ## (#6651 SP1) The LAZY §10.2.5 half — a function with no compile-time edge
 *
 * The edge above is keyed by a compile-time NAME (`ctx.fnctorPrototypeObject` /
 * `ctx.protoGlobals`), so it answers only for a function the compiler could name.
 * An ANONYMOUS function expression written straight into a property —
 *
 *     sample.constructor[Symbol.species] = function (count) { … };
 *
 * — never gets a fnctor prototype global, so `Get(S, "prototype")` answered
 * `undefined` and everything downstream of §10.2.5 MakeConstructor failed:
 * `__native_construct_<N>` (#3981) opens with
 * `if (proto == null) proto = __extern_get(callee, "prototype")` and then
 * `__object_create(proto)`, so the constructed `this` came back with NO
 * `[[Prototype]]` link, and `ctorThis instanceof S` was false. That is the whole
 * of the `TypedArray/prototype/{filter,map,slice,subarray}/
 * speciesctor-get-species-custom-ctor-invocation.js` family.
 *
 * So on a miss, MakeConstructor is performed LAZILY: mint one fresh `$Object`
 * and define it as the closure's own `prototype` (writable, non-enumerable,
 * non-configurable — §10.2.5 step 5 via §20.2.4.2). Storing it in the bag is what
 * makes the operation idempotent: every later read hits the `hasOwn` guard above
 * and answers the SAME object, which is the identity `instanceof`,
 * `Object.getPrototypeOf(new S())` and `__native_construct_<N>` must agree on.
 *
 * Three properties keep this from answering a wrong `prototype`:
 *
 *  - It runs only after BOTH the own-bag check and the compile-time edge have
 *    declined, so it can never displace an explicit `f.prototype = …` (including
 *    `= undefined`) nor a named fnctor's / class's real prototype object.
 *  - It is gated on a `ref.test` against `ctx.constructibleClosureTypeIdxs`
 *    (#3371) — the exact wrapper identities that implement [[Construct]]. An
 *    ARROW, a concise method and a bound function are absent from that set, so
 *    §15.3's "an arrow has no `prototype`" keeps answering `undefined` by
 *    construction rather than by an ad-hoc exclusion.
 *  - It mints no string constant and no function at fill time (the #4221
 *    hazard): the key it defines under is the receiver's own `keySlot`, already
 *    proven `ref.eq` to the interned `"prototype"` literal by the guard above.
 *
 * The `constructor` back-ref (§10.2.5 step 4) is deliberately NOT installed here:
 * it would need a second interned literal minted at FILL time. `S.prototype.
 * constructor` therefore stays absent for an anonymous property-held function —
 * the same answer as before this arm, so no behaviour regresses, and the
 * named-fnctor spelling still gets it from `fnctor-prototype.ts`.
 */
export function closurePrototypeEdgeGetArm(
  ctx: CodegenContext,
  slots: { recvSlot: number; keySlot: number; bagSlot: number; protoSlot: number },
): Instr[] {
  const bagLookupIdx = ctx.funcMap.get("__closure_bag_lookup");
  const hasOwnIdx = ctx.funcMap.get("__hasOwnProperty");
  const nativeStrTypeIdx = ctx.nativeStrTypeIdx;
  if (bagLookupIdx === undefined || hasOwnIdx === undefined) return [];
  if (!ctx.nativeStrings || nativeStrTypeIdx < 0) return [];

  const { recvSlot, keySlot, bagSlot, protoSlot } = slots;
  const hasEdges = hasClosurePrototypeEdges(ctx);
  const protoOfIdx = hasEdges ? ctx.funcMap.get(CLOSURE_PROTO_OF) : undefined;
  const vivify = lazyMakeConstructorInstrs(ctx, slots);
  if (protoOfIdx === undefined && vivify === undefined) return [];

  // A FACTORY, not a shared array: the same `Instr` object appearing at two
  // points in one body is double-remapped by the finalize index walks
  // (`reference_shared_instr_object_dce_double_remap`), which is how a correct
  // instruction sequence turns into a call to the wrong function.
  /**
   * The edge consult itself — reached only when the bag holds no own entry.
   * On a miss it falls through to the lazy §10.2.5 vivify (#6651 SP1), which
   * returns when (and only when) the receiver is a constructible closure.
   */
  const consultEdge = (): Instr[] => [
    ...(protoOfIdx === undefined
      ? []
      : ([
          { op: "local.get", index: recvSlot },
          { op: "call", funcIdx: protoOfIdx },
          { op: "local.tee", index: protoSlot },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: protoSlot }, { op: "return" }],
          },
        ] satisfies Instr[])),
    ...(vivify?.() ?? []),
  ];

  /** `bag == null || !__hasOwnProperty(bag, "prototype")` ⇒ consult the edge. */
  const whenNoOwnEntry: Instr[] = [
    { op: "local.get", index: recvSlot },
    { op: "call", funcIdx: bagLookupIdx },
    { op: "local.tee", index: bagSlot },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: consultEdge(),
      else: [
        { op: "local.get", index: bagSlot },
        { op: "local.get", index: keySlot },
        { op: "call", funcIdx: hasOwnIdx },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: consultEdge() },
      ],
    },
  ];

  return [
    { op: "local.get", index: keySlot },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: nativeStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: keySlot },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: nativeStrTypeIdx },
        ...nativeStringLiteralInstrs(ctx, "prototype"),
        { op: "ref.eq" },
        { op: "if", blockType: { kind: "empty" }, then: whenNoOwnEntry },
      ],
    },
  ];
}

/**
 * (#4637 A4) The same edge, on the OWN-PROPERTY VISIBILITY surface —
 * `f.hasOwnProperty("prototype")` / `Object.hasOwn(f, "prototype")`.
 *
 * §20.2.4.2: an ordinary function's `prototype` is an OWN property of the
 * function. The edge already answers the VALUE read (`closurePrototypeEdgeGetArm`
 * above), so before this arm the two surfaces contradicted each other. Measured
 * on this branch's base (`.tmp/p13.js`, `--target standalone`):
 *
 *     function f(){}
 *     typeof f.prototype            // "object"   — the edge answers
 *     f.hasOwnProperty("prototype") // false      — nothing answers
 *
 * — `built-ins/Function/prototype/S15.3.5.2_A1_T1`.
 *
 * ## Why this cannot answer a wrong `true`
 *
 * `__closure_proto_of` is an `ref.eq` identity match against the singletons the
 * compiler minted for functions that HAVE a prototype object (`collectPrototypeEdges`
 * pairs a `__fn_closure_<name>` / `__class_<Name>` value global with a prototype
 * global). A value with no edge — an arrow, a bound function, a `Function(src)`
 * product, a plain `$Object`, a host externref — answers `null` here exactly as
 * it does for the value read, and this arm falls through to the receiver's
 * existing answer. §15.3 requires an arrow to have NO `prototype`, and it keeps
 * that answer because it never gets an edge, not because of an ad-hoc exclusion.
 *
 * Unlike the GET arm this does NOT consult the bag first, and the asymmetry is
 * deliberate: an own bag entry `f.prototype = v` must WIN on the value read, but
 * on the visibility question both the bag entry and the edge answer the same
 * `true`, so the precedence question does not arise. The bag arm runs first in
 * the spliced body anyway (this arm is a prologue that only fires on a miss for
 * the interned `"prototype"` key).
 *
 * Splices into the FRONT of the named natives' bodies and adds NO locals, so no
 * local index in those bodies moves. Returns an empty array — leaving every
 * consumer byte-identical — unless the module has an edge and both the helper
 * and the interned key literal are available.
 */
export function closurePrototypeEdgeHasOwnArm(
  ctx: CodegenContext,
  recvSlot: number,
  keySlot: number,
  answer = 1,
): Instr[] {
  const constructibleDeleteTypes = answer === 0 ? [...ctx.constructibleClosureTypeIdxs] : [];
  if (!hasClosurePrototypeEdges(ctx) && constructibleDeleteTypes.length === 0) return [];
  const protoOfIdx = ctx.funcMap.get(CLOSURE_PROTO_OF);
  const nativeStrTypeIdx = ctx.nativeStrTypeIdx;
  if (protoOfIdx === undefined && constructibleDeleteTypes.length === 0) return [];
  if (!ctx.nativeStrings || nativeStrTypeIdx < 0) return [];
  return [
    { op: "local.get", index: keySlot },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: nativeStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: keySlot },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: nativeStrTypeIdx },
        ...nativeStringLiteralInstrs(ctx, "prototype"),
        { op: "ref.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...constructibleDeleteTypes.flatMap((typeIdx): Instr[] => [
              { op: "local.get", index: recvSlot },
              { op: "any.convert_extern" },
              { op: "ref.test", typeIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: answer }, { op: "return" }],
              },
            ]),
            ...(protoOfIdx === undefined
              ? []
              : ([
                  { op: "local.get", index: recvSlot },
                  { op: "call", funcIdx: protoOfIdx },
                  { op: "ref.is_null" },
                  { op: "i32.eqz" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "i32.const", value: answer }, { op: "return" }],
                  },
                ] satisfies Instr[])),
          ],
        },
      ],
    },
  ];
}

/**
 * (#4637 A4) Splice {@link closurePrototypeEdgeHasOwnArm} into the own-property
 * visibility natives at FINALIZE, after `fillClosurePrototypeEdge` has given
 * `__closure_proto_of` its real body.
 *
 * Only the OWN-property pair is targeted. `__extern_has` (§7.3.12 HasProperty)
 * is deliberately left alone: it already reaches the value through
 * `__closure_prop_get`'s edge arm, and splicing a second answer in would give
 * one question two independent sources.
 */
export function spliceClosurePrototypeEdgeHasOwn(ctx: CodegenContext): void {
  const arm = closurePrototypeEdgeHasOwnArm(ctx, 0, 1);
  if (arm.length === 0) return;
  // The same identity edge also proves that `prototype` is the mandatory
  // non-configurable own property, so OrdinaryDelete must return false even
  // before a side-bag entry has materialized it.
  for (const [name, answer] of [
    ["__hasOwnProperty", 1],
    ["__object_hasOwn", 1],
    ["__delete_property", 0],
  ] as const) {
    const fn = ctx.mod.functions.find((candidate) => candidate.name === name);
    if (!fn) continue;
    // A FACTORY per target: one shared `Instr` object reachable from two bodies
    // is double-remapped by the finalize index walks
    // (`reference_shared_instr_object_dce_double_remap`).
    fn.body.unshift(...closurePrototypeEdgeHasOwnArm(ctx, 0, 1, answer));
  }
}
