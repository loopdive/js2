// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#802) Dynamic prototype support for CLASS-INSTANCE receivers — Slices B+C.
 *
 * `Object.setPrototypeOf(obj, proto)` / `Reflect.setPrototypeOf` /
 * `o.__proto__ = v` mutate an object's [[Prototype]] at runtime. For `$Object`
 * (hash-map) receivers the native runtime already models this fully
 * (`$Object.$proto`, `__object_setPrototypeOf`, the `__extern_get` proto walk).
 * The remaining standalone gap is a CLOSED-shape class-instance receiver: the
 * `ref.test $Object` in the native helpers fails for a `$ClassName` struct, so
 * the proto link is silently dropped and inherited reads answer `undefined`.
 *
 * ## Design (see the full spec in plan/issues/802-*.md)
 *
 * - **Prescan** (`scanForDynamicProto`, mirrors `scanForNewTarget`): find every
 *   proto-mutation receiver, resolve it via `ctx.oracle` to a class, promote
 *   the mark to the class's hierarchy ROOT, and record the root name in
 *   `ctx.dynamicProtoClasses`. Object-literal receivers are recorded in
 *   `ctx.dynamicProtoLiteralNodes` (consumed by Slice A's `$Object` promotion).
 *
 * - **Conditional appended field** (Slice B): ONLY marked root classes get one
 *   extra struct field, `(field $__proto__ (mut externref))`, appended LAST
 *   (class-bodies.ts). Appending last leaves every existing positional
 *   `fieldIdx` unchanged, and every class-struct `struct.new` site iterates the
 *   field list and defaults externref fields to `ref.null.extern` — so the
 *   operand count stays correct BY CONSTRUCTION (audited: the two ctor alloc
 *   loops, the lazy proto/class-object singleton inits, and the object-literal
 *   struct path all iterate `fields`). This is the structural #799a-regression
 *   avoidance: #799a appended unconditionally and at sites with hard-coded
 *   operand lists.
 *
 * - **Null sentinel**: `$__proto__ == null` means "never dynamically set"
 *   (fall back to the compile-time class prototype), NOT "prototype is null".
 *   `setPrototypeOf(o, null)` stores a dedicated sentinel `$Object` singleton
 *   (`ctx.dynProtoSentinelGlobalIdx`); readers map sentinel → JS `null`.
 *
 * - **Write path** (Slice B): all three mutation forms already route to the
 *   native `__object_setPrototypeOf` in standalone. `fillDynamicProtoHelpers`
 *   PREPENDS a per-marked-root `ref.test` arm that diverts a struct receiver to
 *   the finalize-minted `__struct_proto_set` (cycle-checked, §10.1.2.1 step 8;
 *   a refused set is a silent no-op, matching the `$Object` helper's posture).
 *
 * - **Read path** (Slice C): `__extern_get` gets a prepended marked-root arm
 *   diverting to `__struct_proto_get` (read `$__proto__`, delegate the lookup
 *   to `__extern_get` on the proto — mutual recursion walks mixed
 *   struct/`$Object` chains; termination is guaranteed because the set path
 *   refuses cycles among walkable nodes and non-walkable nodes end the chain).
 *   `__getPrototypeOf` gets an arm diverting to `__struct_proto_read`
 *   (per-class arms, most-derived first, with the class's compile-time proto
 *   singleton as the never-set fallback). The TYPED
 *   `Object.getPrototypeOf(instance)` site reads the field inline and uses
 *   `__dynproto_norm` (sentinel → null) — reserved mid-compile as an identity
 *   stub, filled at finalize.
 *
 * - **Gating / byte-inertness**: everything is gated on `ctx.standalone` and a
 *   non-empty `ctx.dynamicProtoClasses`. A module that never mutates a class
 *   instance's prototype (the overwhelmingly common case) emits byte-identical
 *   output. Kill switch: `JS2WASM_NO_DYNPROTO=1` disables the prescan marks,
 *   which disables ALL of Slice B/C wholesale (spec §8).
 *
 * ## Known limits (documented, deliberate — slice scope)
 * - gc/host mode is untouched (the `_wasmStructProto` WeakMap sidecar already
 *   models dynamic protos for opaque structs).
 * - Statically-typed method/field access on a class instance keeps compile-time
 *   dispatch; the dynamic-read paths honor the runtime chain.
 * - A computed-key read of an OWN declared field via bare `__extern_get` on a
 *   marked instance walks the proto instead of answering the own field (own
 *   fields were already invisible to `__extern_get` before this change; the
 *   syntactic `__get_member_<name>` dispatchers keep correct own-shadowing).
 * - A non-object, non-null proto value is stored as-is rather than refused
 *   (the `$Object` arm coerces such values to null; both are lenient
 *   non-throwing postures — the exactness lives in slice D).
 */
import { ts, forEachChild } from "../ts-api.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { nextModuleGlobalIdx } from "./registry/imports.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { INITIAL_CAP } from "./object-runtime.js";
import { resolveFnctorSymbol } from "./fnctor-escape-gate.js"; // (#4163) proto-SOURCE marks

const EXTERNREF: ValType = { kind: "externref" };

// ── Prescan ────────────────────────────────────────────────────────────────

/**
 * Pre-scan the source for proto-mutation receivers. Populates
 * `ctx.dynamicProtoClasses` (hierarchy-ROOT class names) and
 * `ctx.dynamicProtoLiteralNodes`; sets `ctx.usesDynamicProto`. Runs BEFORE
 * `collectDeclarations`, so class heritage is resolved from the AST here (the
 * ctx.classParentMap is not populated yet). Cheap structural walk.
 */
export function scanForDynamicProto(ctx: CodegenContext, root: ts.Node): void {
  // (#802 §8) one-line kill switch: no marks ⇒ no field append, no helper
  // emission, no prepended arms — Slice B/C disabled wholesale.
  if (process.env.JS2WASM_NO_DYNPROTO === "1") return;

  const classParents = new Map<string, string>(); // declared class → extends-identifier
  const declaredClasses = new Set<string>();
  const markedRaw = new Set<string>();

  const markReceiver = (recvRaw: ts.Expression): void => {
    ctx.usesDynamicProto = true;
    // Unwrap casts/parens: `(c as any).__proto__ = v` must resolve the INNER
    // `c` — the outer cast's `any` fact would silently drop the mark.
    let recv = recvRaw;
    while (
      ts.isAsExpression(recv) ||
      ts.isParenthesizedExpression(recv) ||
      ts.isNonNullExpression(recv) ||
      ts.isSatisfiesExpression(recv) ||
      ts.isTypeAssertionExpression(recv)
    ) {
      recv = recv.expression;
    }
    // Receiver resolution via the oracle (NOT the raw checker — oracle-ratchet).
    const fact = ctx.oracle.typeFactOf(recv);
    if (fact.kind === "class") {
      markedRaw.add(fact.name);
      return;
    }
    // Direct `new C()` receiver (`Object.setPrototypeOf(new C(), p)`).
    if (ts.isNewExpression(recv) && ts.isIdentifier(recv.expression)) {
      markedRaw.add(recv.expression.text);
      return;
    }
    // Slice A hooks: a direct object-literal receiver, or a `const` binding
    // whose initializer is an object literal.
    if (ts.isObjectLiteralExpression(recv)) {
      ctx.dynamicProtoLiteralNodes.add(recv);
      return;
    }
    if (ts.isIdentifier(recv)) {
      const init = ctx.oracle.constInitializerOf(recv);
      if (init) {
        if (ts.isObjectLiteralExpression(init)) {
          ctx.dynamicProtoLiteralNodes.add(init);
        } else if (ts.isNewExpression(init) && ts.isIdentifier(init.expression)) {
          // `const c: any = new C(); Object.setPrototypeOf(c, p)` — the `any`
          // annotation hides the class from the type fact, but the immutable
          // const initializer names it. Non-class names added here are benign:
          // they never match a declared class at the append site.
          markedRaw.add(init.expression.text);
        }
      }
    }
    // Unresolvable receivers (`any` params etc.) are $Object/any-backed at
    // runtime in the cases the compiler supports — those work natively. A
    // closed struct flowing in as `any` keeps today's behavior (spec §5).
  };

  // (#4163) Mark a PROTO-SOURCE expression: an object that will BECOME a
  // [[Prototype]] (the donor side — the receiver-side marks above are #802's).
  // In standalone the proto-position natives (`__object_create`'s `$proto`
  // seed, `__object_setPrototypeOf`, the #2660 S3a reconstruct seed) all
  // require the proto value to be an open `$Object`; a closed-struct literal
  // silently seeds `$proto = null` and the whole inherited-read chain is dead
  // (probe: `var proto = {foo:1}; F.prototype = proto; new F()` — `"foo" in
  // child` was false while `Object.getPrototypeOf(child) === proto` READ true,
  // the #4163 identity-without-liveness trap). Marking the literal initializer
  // into `ctx.dynamicProtoLiteralNodes` reuses the ENTIRE Slice-A promotion:
  // literals.ts builds it as `$Object`, and variables.ts / index.ts type the
  // binding slot externref in lockstep. Direct literal proto ARGS (e.g.
  // `Object.create({...})`) already build as `$Object` via compileProtoArg /
  // the S2 fnctor-prototype assign interception, so only the one-hop
  // identifier-binding case needs the mark.
  const markProtoSource = (srcRaw: ts.Expression): void => {
    let src = srcRaw;
    while (
      ts.isAsExpression(src) ||
      ts.isParenthesizedExpression(src) ||
      ts.isNonNullExpression(src) ||
      ts.isSatisfiesExpression(src) ||
      ts.isTypeAssertionExpression(src)
    ) {
      src = src.expression;
    }
    if (!ts.isIdentifier(src)) return;
    const init = ctx.oracle.variableInitializerOf(src);
    if (process.env.JS2WASM_LOG_PROTO_SOURCE === "1") {
      // eslint-disable-next-line no-console
      console.error(`[#4163 proto-source] id=${src.text} init=${init ? ts.SyntaxKind[init.kind] : "none"}`);
    }
    if (init && ts.isObjectLiteralExpression(init)) {
      ctx.dynamicProtoLiteralNodes.add(init);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      declaredClasses.add(node.name.text);
      const ext = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
      if (ext && ts.isIdentifier(ext.expression)) {
        classParents.set(node.name.text, ext.expression.text);
      }
    }
    // Object.setPrototypeOf(X, _) / Reflect.setPrototypeOf(X, _)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "Object" || node.expression.expression.text === "Reflect") &&
      node.expression.name.text === "setPrototypeOf" &&
      node.arguments.length >= 1
    ) {
      markReceiver(node.arguments[0]!);
      // (#4163) the PROTO argument is a proto-source.
      if (node.arguments.length >= 2) markProtoSource(node.arguments[1]!);
    }
    // (#4163) Object.create(X, …) — X is a proto-source.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.expression.name.text === "create" &&
      node.arguments.length >= 1
    ) {
      markProtoSource(node.arguments[0]!);
    }
    // X.__proto__ = _  (the §B.2.2.1 setter form; assignment.ts routes it to
    // the same helper)
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      !ts.isPrivateIdentifier(node.left.name) &&
      node.left.name.text === "__proto__"
    ) {
      markReceiver(node.left.expression);
      // (#4163) the assigned value is a proto-source.
      markProtoSource(node.right);
    }
    // (#4163) `F.prototype = X` for an APPROVED user fnctor (#2660 S2/S3a):
    // the assigned object becomes the live `[[Prototype]]` seed of every
    // reconstructed `new F()` instance, so a literal-initialized binding X
    // must build as an open `$Object` — `__object_create` seeds `$proto =
    // (proto is $Object ? proto : null)`, and a closed struct kills the chain.
    // Gated on the S1 escape gate's approvedNames (the same scope the S2
    // prototype interception and the S3a reconstruct use), so a keep-typed /
    // keep-static fnctor's prototype binding keeps its representation — the
    // #2660 S2 header records a measured −40 standalone-floor cost for an
    // UNSCOPED interception here.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      !ts.isPrivateIdentifier(node.left.name) &&
      node.left.name.text === "prototype"
    ) {
      const sym = resolveFnctorSymbol(ctx.checker, node.left.expression);
      if (sym && ctx.fnctorEscapeGate?.approvedNames.has(sym.name)) {
        markProtoSource(node.right);
      }
    }
    forEachChild(node, visit);
  };
  visit(root);

  // Promote each marked class to its hierarchy ROOT (the field must be
  // introduced on the root so every subclass layout inherits it as a shared
  // prefix — spec §1). Walk only through DECLARED classes: a builtin parent
  // ("extends Set") means the marked class is itself the struct root.
  for (const name of markedRaw) {
    let cur = name;
    const seen = new Set([name]);
    for (;;) {
      const p = classParents.get(cur);
      if (!p || !declaredClasses.has(p) || seen.has(p)) break;
      seen.add(p);
      cur = p;
    }
    ctx.dynamicProtoClasses.add(cur);
  }
}

// ── Emission-time queries ──────────────────────────────────────────────────

/**
 * The marked hierarchy ROOT for `className`, or undefined when the class is
 * not part of a marked hierarchy. Uses ctx.classParentMap (populated by class
 * collection — callers run at body-compile/finalize time).
 */
export function dynamicProtoRootFor(ctx: CodegenContext, className: string): string | undefined {
  let cur = className;
  const seen = new Set([className]);
  for (;;) {
    if (ctx.dynamicProtoClasses.has(cur)) return cur;
    const p = ctx.classParentMap.get(cur);
    if (!p || seen.has(p) || !ctx.classSet.has(p)) break;
    seen.add(p);
    cur = p;
  }
  return undefined;
}

/** The `$__proto__` field index on a marked root's struct, or undefined. */
export function dynamicProtoFieldIdx(ctx: CodegenContext, rootClassName: string): number | undefined {
  const fields = ctx.structFields.get(rootClassName);
  if (!fields) return undefined;
  const idx = fields.findIndex((f) => f.name === "__proto__" && f.type.kind === "externref");
  return idx >= 0 ? idx : undefined;
}

/** Lazily reserve the "explicit null proto" sentinel global (mut externref,
 *  init null). The sentinel $Object itself is built lazily inside
 *  `__struct_proto_set` on the first `setPrototypeOf(o, null)`. */
export function ensureDynProtoSentinelGlobal(ctx: CodegenContext): number {
  if (ctx.dynProtoSentinelGlobalIdx !== undefined) return ctx.dynProtoSentinelGlobalIdx;
  const idx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__dynproto_null_sentinel",
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  ctx.dynProtoSentinelGlobalIdx = idx;
  return idx;
}

/**
 * Reserve `__dynproto_norm(externref) -> externref` mid-compile with an
 * IDENTITY stub body (safe pre-fill: before any sentinel exists, no value can
 * equal the sentinel, so identity IS the correct mapping). The finalize fill
 * replaces the body with the sentinel → null mapping. Used by the typed
 * `Object.getPrototypeOf(classInstance)` site.
 */
export function reserveDynprotoNorm(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__dynproto_norm");
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, [EXTERNREF], [EXTERNREF], "__dynproto_norm_type");
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__dynproto_norm", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__dynproto_norm",
    typeIdx,
    locals: [{ name: "__any", type: { kind: "anyref" } }],
    body: [{ op: "local.get", index: 0 }],
    exported: false,
  });
  return funcIdx;
}

// ── Finalize fill ──────────────────────────────────────────────────────────

interface MarkedRoot {
  structTypeIdx: number;
  fieldIdx: number;
}

/** Classes belonging to marked hierarchies, with inheritance depth (for
 *  most-derived-first `ref.test` ordering) and per-class proto singleton. */
interface HierarchyClass {
  structTypeIdx: number;
  rootTypeIdx: number;
  rootFieldIdx: number;
  depth: number;
  protoGlobalIdx: number | undefined;
}

/**
 * (#802 Slices B+C) Finalize fill. Mints the struct-proto natives and prepends
 * the marked-root dispatch arms into `__object_setPrototypeOf`,
 * `__getPrototypeOf` and `__extern_get`. Runs in the finalize sequence (after
 * every class struct + proto singleton global is registered, before
 * dead-elimination). Mints DEFINED functions only — no imports, so no funcIdx
 * shifts. No-op (byte-identical) unless standalone AND a marked class with an
 * appended `$__proto__` field exists AND the object runtime was emitted.
 */
export function fillDynamicProtoHelpers(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  if (ctx.dynamicProtoClasses.size === 0) return;
  if (ctx.funcMap.has("__struct_proto_set")) return; // idempotence
  const rt = ctx.objectRuntimeTypes;
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const spoFn = findDefined(ctx, "__object_setPrototypeOf");
  if (!rt || externGetIdx === undefined || !spoFn) return; // runtime never emitted

  // Marked roots with a real appended field.
  const roots: MarkedRoot[] = [];
  for (const name of ctx.dynamicProtoClasses) {
    const structTypeIdx = ctx.structMap.get(name);
    const fieldIdx = dynamicProtoFieldIdx(ctx, name);
    if (structTypeIdx === undefined || fieldIdx === undefined) continue;
    roots.push({ structTypeIdx, fieldIdx });
  }
  if (roots.length === 0) return;

  // All classes in marked hierarchies (per-class proto singleton for
  // `__struct_proto_read`), most-derived first so a subclass arm shadows its
  // root's arm under WasmGC subtyping.
  const classes: HierarchyClass[] = [];
  for (const cls of ctx.classSet) {
    const rootName = dynamicProtoRootFor(ctx, cls);
    if (!rootName) continue;
    const structTypeIdx = ctx.structMap.get(cls);
    const rootTypeIdx = ctx.structMap.get(rootName);
    const rootFieldIdx = dynamicProtoFieldIdx(ctx, rootName);
    if (structTypeIdx === undefined || rootTypeIdx === undefined || rootFieldIdx === undefined) continue;
    let depth = 0;
    for (let c = cls; ctx.classParentMap.has(c) && depth < 64; c = ctx.classParentMap.get(c)!) depth++;
    classes.push({ structTypeIdx, rootTypeIdx, rootFieldIdx, depth, protoGlobalIdx: ctx.protoGlobals.get(cls) });
  }
  classes.sort((a, b) => b.depth - a.depth);

  const objectTypeIdx = rt.objectTypeIdx;
  const sentIdx = ensureDynProtoSentinelGlobal(ctx);
  const missInstrs = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];

  const registerNative = (
    name: string,
    params: ValType[],
    results: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ): number => {
    const typeIdx = addFuncType(ctx, params, results, `${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.funcMap.set(name, funcIdx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false });
    return funcIdx;
  };

  // Sentinel compare: [top: (ref null $Object) candidate] → i32 (1 = is the
  // sentinel). The global may still be null — `ref.eq` with a null side is
  // simply false, which is correct (nothing equals a not-yet-built sentinel).
  const eqSentinel = (): Instr[] => [
    { op: "global.get", index: sentIdx },
    { op: "any.convert_extern" },
    { op: "ref.cast_null", typeIdx: objectTypeIdx },
    { op: "ref.eq" },
  ];

  // ── __dynproto_norm(externref) -> externref: sentinel → null, else identity.
  {
    const normIdx = reserveDynprotoNorm(ctx);
    const fn = definedFuncAt(ctx, normIdx);
    if (fn) {
      fn.locals = [{ name: "__any", type: { kind: "anyref" } }];
      fn.body = [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.tee", index: 1 },
        { op: "ref.test", typeIdx: objectTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "ref.cast", typeIdx: objectTypeIdx },
            ...eqSentinel(),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "ref.null.extern" }, { op: "return" }],
            },
          ],
        },
        { op: "local.get", index: 0 },
      ];
    }
  }
  const normIdx = ctx.funcMap.get("__dynproto_norm")!;

  // ── __struct_proto_set(obj, proto) -> externref (returns obj) ────────────
  //
  // §10.1.2.1 OrdinarySetPrototypeOf for a marked class-instance receiver:
  //   - proto null → store the sentinel (explicit null; distinguishes from the
  //     never-set field default).
  //   - cycle check (step 8): walk the CANDIDATE chain; a node identical to
  //     the receiver refuses the set (silent no-op — same lenient posture as
  //     the $Object helper; the #1473 error machinery is a separate layer).
  //     Only walkable nodes ($Object / marked structs) continue the chain; a
  //     non-walkable node genuinely ends the runtime chain, so a cycle through
  //     it is impossible and the walk is sound. Depth cap 128 as
  //     belt-and-suspenders (chains stay acyclic BECAUSE this check refuses).
  //   - store the RAW proto externref (any object value can serve as a proto;
  //     the read path classifies it).
  //   - Extensibility (step 3) is not modeled for structs (always extensible).
  //
  // params: 0=obj 1=proto
  // locals: 2=__any(anyref) 3=__oeq(eqref) 4=__cur(externref) 5=__cureq(eqref)
  //         6=__guard(i32) 7=__t(anyref)
  {
    const classifyCurInto5: Instr[] = [
      // __t = any.convert_extern(__cur); __cureq = walkable struct or null
      { op: "local.get", index: 4 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 7 },
      { op: "ref.null.eq" },
      { op: "local.set", index: 5 },
      { op: "local.get", index: 7 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 7 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
          { op: "local.set", index: 5 },
        ],
      },
      ...roots.flatMap((r): Instr[] => [
        { op: "local.get", index: 7 },
        { op: "ref.test", typeIdx: r.structTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 7 },
            { op: "ref.cast", typeIdx: r.structTypeIdx },
            { op: "local.set", index: 5 },
          ],
        },
      ]),
    ];
    const stepCurFrom5: Instr[] = [
      // __cur = [[Prototype]] slot of __cureq (exactly one arm matches)
      { op: "local.get", index: 5 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 5 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
          { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
          { op: "extern.convert_any" },
          { op: "local.set", index: 4 },
        ],
      },
      ...roots.flatMap((r): Instr[] => [
        { op: "local.get", index: 5 },
        { op: "ref.test", typeIdx: r.structTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 5 },
            { op: "ref.cast", typeIdx: r.structTypeIdx },
            { op: "struct.get", typeIdx: r.structTypeIdx, fieldIdx: r.fieldIdx },
            { op: "local.set", index: 4 },
          ],
        },
      ]),
    ];
    const buildSentinel: Instr[] = [
      // if the sentinel global is null, build the singleton $Object
      { op: "global.get", index: sentIdx },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "ref.null", typeIdx: objectTypeIdx }, // proto
          { op: "ref.null", typeIdx: rt.propEntryTypeIdx },
          { op: "i32.const", value: INITIAL_CAP },
          { op: "array.new", typeIdx: rt.propMapTypeIdx }, // props
          { op: "i32.const", value: 0 }, // count
          { op: "i32.const", value: 0 }, // tombstones
          { op: "i32.const", value: 0 }, // flags
          { op: "i32.const", value: 0 }, // nextSeq
          { op: "struct.new", typeIdx: objectTypeIdx },
          { op: "extern.convert_any" },
          { op: "global.set", index: sentIdx },
        ],
      },
    ];
    const armFor = (r: MarkedRoot): Instr[] => [
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: r.structTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // __oeq = receiver as eqref (for the identity compares below)
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx: r.structTypeIdx },
          { op: "local.set", index: 3 },
          // explicit null proto → store sentinel
          { op: "local.get", index: 1 },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...buildSentinel,
              { op: "local.get", index: 2 },
              { op: "ref.cast", typeIdx: r.structTypeIdx },
              { op: "global.get", index: sentIdx },
              { op: "struct.set", typeIdx: r.structTypeIdx, fieldIdx: r.fieldIdx },
              { op: "local.get", index: 0 },
              { op: "return" },
            ],
          },
          // cycle check over the candidate chain
          { op: "local.get", index: 1 },
          { op: "local.set", index: 4 },
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 6 },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  ...classifyCurInto5,
                  // non-walkable / end of chain → no cycle
                  { op: "local.get", index: 5 },
                  { op: "ref.is_null" },
                  { op: "br_if", depth: 1 },
                  // node === receiver → refuse (silent no-op)
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 3 },
                  { op: "ref.eq" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "local.get", index: 0 }, { op: "return" }],
                  },
                  // depth cap
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.tee", index: 6 },
                  { op: "i32.const", value: 128 },
                  { op: "i32.gt_s" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "local.get", index: 0 }, { op: "return" }],
                  },
                  ...stepCurFrom5,
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
          // no cycle → store the raw proto value
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx: r.structTypeIdx },
          { op: "local.get", index: 1 },
          { op: "struct.set", typeIdx: r.structTypeIdx, fieldIdx: r.fieldIdx },
          { op: "local.get", index: 0 },
          { op: "return" },
        ],
      },
    ];
    registerNative(
      "__struct_proto_set",
      [EXTERNREF, EXTERNREF],
      [EXTERNREF],
      [
        { name: "__any", type: { kind: "anyref" } },
        { name: "__oeq", type: { kind: "eqref" } },
        { name: "__cur", type: { kind: "externref" } },
        { name: "__cureq", type: { kind: "eqref" } },
        { name: "__guard", type: { kind: "i32" } },
        { name: "__t", type: { kind: "anyref" } },
      ],
      [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.set", index: 2 },
        ...roots.flatMap(armFor),
        { op: "local.get", index: 0 }, // unmarked receiver (guarded by callers)
      ],
    );
  }
  const structProtoSetIdx = ctx.funcMap.get("__struct_proto_set")!;

  // ── __struct_proto_get(recv, key) -> externref ───────────────────────────
  //
  // Inherited-property read for a marked struct receiver: read `$__proto__`;
  // never-set / explicit-null → the canonical miss value (undefined singleton
  // under the #2106 S1 regime, legacy null otherwise — the SAME encoding
  // `__extern_get`'s own miss uses); else delegate to `__extern_get(proto,
  // key)`, whose prepended marked arm recurses for struct-proto chains.
  //
  // params: 0=recv 1=key; locals: 2=__any(anyref) 3=__p(externref)
  {
    const armFor = (r: MarkedRoot): Instr[] => [
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: r.structTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx: r.structTypeIdx },
          { op: "struct.get", typeIdx: r.structTypeIdx, fieldIdx: r.fieldIdx },
          { op: "local.set", index: 3 },
          // never dynamically set → miss (own fields are answered by the
          // typed/dispatcher paths; the compile-time chain has no dynamic map)
          { op: "local.get", index: 3 },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...missInstrs(), { op: "return" }],
          },
          // explicit null (sentinel) → miss
          { op: "local.get", index: 3 },
          { op: "any.convert_extern" },
          { op: "local.set", index: 2 },
          { op: "local.get", index: 2 },
          { op: "ref.test", typeIdx: objectTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 2 },
              { op: "ref.cast", typeIdx: objectTypeIdx },
              ...eqSentinel(),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...missInstrs(), { op: "return" }],
              },
            ],
          },
          // delegate the lookup to the proto (recurses through marked chains)
          { op: "local.get", index: 3 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: externGetIdx },
          { op: "return" },
        ],
      },
    ];
    registerNative(
      "__struct_proto_get",
      [EXTERNREF, EXTERNREF],
      [EXTERNREF],
      [
        { name: "__any", type: { kind: "anyref" } },
        { name: "__p", type: { kind: "externref" } },
      ],
      [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.set", index: 2 },
        ...roots.flatMap(armFor),
        ...missInstrs(),
      ],
    );
  }
  const structProtoGetIdx = ctx.funcMap.get("__struct_proto_get")!;

  // ── __struct_proto_read(recv) -> externref ───────────────────────────────
  //
  // `Object.getPrototypeOf` for a marked struct receiver (generic/dynamic
  // path): field never-set → the class's compile-time prototype singleton
  // global (may still be null if never materialized — the TYPED site
  // lazy-inits it; here we can only read); sentinel → null; else the stored
  // value. Per-CLASS arms, most-derived first, so a subclass instance answers
  // its OWN class prototype.
  //
  // params: 0=recv; locals: 1=__any(anyref) 2=__p(externref)
  {
    const armFor = (c: HierarchyClass): Instr[] => [
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: c.structTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: c.rootTypeIdx },
          { op: "struct.get", typeIdx: c.rootTypeIdx, fieldIdx: c.rootFieldIdx },
          { op: "local.set", index: 2 },
          { op: "local.get", index: 2 },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...(c.protoGlobalIdx !== undefined
                ? ([{ op: "global.get", index: c.protoGlobalIdx }] satisfies Instr[])
                : ([{ op: "ref.null.extern" }] satisfies Instr[])),
              { op: "return" },
            ],
          },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: normIdx },
          { op: "return" },
        ],
      },
    ];
    registerNative(
      "__struct_proto_read",
      [EXTERNREF],
      [EXTERNREF],
      [
        { name: "__any", type: { kind: "anyref" } },
        { name: "__p", type: { kind: "externref" } },
      ],
      [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.set", index: 1 },
        ...classes.flatMap(armFor),
        { op: "ref.null.extern" },
      ],
    );
  }
  const structProtoReadIdx = ctx.funcMap.get("__struct_proto_read")!;

  // ── Prepend the marked-root dispatch arms ────────────────────────────────
  //
  // Marked struct receivers are DISJOINT from every receiver type the host
  // bodies (and the other finalize fills) test for, so prepending at body[0]
  // is order-independent and semantics-preserving for all other receivers.
  const prependArms = (fnName: string, callInstrs: (r: MarkedRoot) => Instr[]): void => {
    const fn = findDefined(ctx, fnName);
    if (!fn || !fn.body) return;
    const arms: Instr[] = roots.flatMap((r): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: r.structTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...callInstrs(r), { op: "return" }],
      },
    ]);
    fn.body.unshift(...arms);
  };

  prependArms("__object_setPrototypeOf", () => [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: structProtoSetIdx },
  ]);
  prependArms("__getPrototypeOf", () => [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: structProtoReadIdx },
  ]);
  prependArms("__extern_get", () => [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: structProtoGetIdx },
  ]);
  // `__isPrototypeOf` / `__extern_has` arms: slice D.
}

/** Find a defined function object by funcMap name. */
function findDefined(ctx: CodegenContext, name: string): WasmFunction | undefined {
  const idx = ctx.funcMap.get(name);
  if (idx === undefined) return undefined;
  return definedFuncAt(ctx, idx);
}
