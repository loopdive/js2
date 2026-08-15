// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4437) A per-function metadata CARRIER on a user closure instance — the
 * runtime substrate for `name` and for an exact §15.1.5 `length`.
 *
 * ## The two residuals this exists for (#4436 R1/R2)
 * #4436 made `length` a genuine own property of a user function instance by
 * answering every reflective surface from the `$arity` header slot. That left
 * two measured gaps, both recorded on its issue as ONE slice:
 *
 * | read on `function f(a,b){}` / `function g(x=42,y){}` | #4436 | spec |
 * | ---------------------------------------------------- | ----- | ---- |
 * | `f["name"]`, `hasOwnProperty("name")`, `gOPD`, `gOPN` | absent | `"f"` |
 * | `g["length"]` (reflective)                            | 2     | 0    |
 *
 * `$arity` cannot be re-pointed at the spec value to close the second one:
 * `closure-exports.ts` widens an under-applied dispatch to `max(n, $arity)`, so
 * lowering it to 0 for `g` would stop padding the omitted `y`. The two answers
 * are genuinely different numbers with different jobs, and `name` has no runtime
 * carrier at all — hence a second slot.
 *
 * ## Mechanism — one nominal metadata struct, referenced from a `$fnmeta` slot
 *
 * ```
 *   $__fn_instance_meta { name externref;  length i32 }        (this module)
 *   <closure struct>     [ func, $arity, $bag, …own…, $fnmeta ] <- (ref null $__fn_instance_meta)
 * ```
 *
 * The metadata is per-DECLARATION and constant, so each entry is materialized
 * ONCE into a lazily-filled module global (the `pushBuiltinFnSingletonValueInstrs`
 * pattern) and every instance of that declaration stores the same reference.
 * Closure creation therefore costs one extra `global.get`-guarded push, not an
 * allocation per closure.
 *
 * ### Why the slot holds a REF to a nominal struct, not two plain fields
 * WasmGC canonicalizes structurally: a type's identity is (fields, supertype,
 * finality) — field NAMES are ours alone and are not in the binary. So
 * `ref.test` against a family type also matches any UNRELATED struct that
 * happens to share the shape. Two tempting cheaper layouts are both unsafe:
 *
 * - a bare trailing `i32` id collides with the constructible wrapper's
 *   `__constructible` field (same supertype, same shape) — a `function f(){}`
 *   value would read `1` as a metadata id and answer another function's `name`;
 * - `[externref, i32]` appended directly collides with a closure that captures
 *   one reference and one `i32` (`function outer(o, n) { return function () {
 *   return o; }; }` shapes exactly that way).
 *
 * A `(ref null $__fn_instance_meta)` cannot collide with anything: the type is
 * never produced by user source, so no capture can ever hold it. That makes the
 * family `ref.test` a sound discriminator by construction rather than by a
 * probabilistic argument about field layouts.
 *
 * ### Why `name` is an `externref`, not a `(ref $anystr)`
 * Type-section rec groups are computed from forward references
 * (`computeRecGroups` in emit/binary.ts): a type that references a
 * HIGHER-indexed type drags every type in between into one rec group, which
 * would perturb the canonical runtime rec-group boundary (#2514). This struct
 * therefore references NO other type, so it is always a singleton group
 * wherever it is minted. `externref` is also exactly what
 * `__builtinfn_get_meta` returns, so the reflective read is a bare
 * `struct.get` with no conversion.
 *
 * ## Scope
 * Standalone only. In gc/host mode the `env::__extern_*` imports own the
 * reflective property path, so the extra field would be pure cost; every entry
 * point here is a no-op unless `ctx.standalone`.
 */
import type { FieldDef, Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ts } from "../ts-api.js";
import { expectedArgumentCountOfParams } from "./function-expected-argument-count.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import { EVAL_SOURCE_FILENAME } from "./expressions/eval-source.js";

/** The closure-struct slot name. `$`-prefixed to stay out of name enumeration. */
export const FN_META_FIELD = "$fnmeta";

/** Field 0 of `$__fn_instance_meta` — §10.2.9 `name`, already an `externref`. */
export const FN_META_NAME_FIELD_IDX = 0;
/** Field 1 of `$__fn_instance_meta` — §15.1.5 ExpectedArgumentCount. */
export const FN_META_LENGTH_FIELD_IDX = 1;

/** §10.2.9 `name` + §15.1.5 `length` for one function DECLARATION. */
export interface FnInstanceMeta {
  readonly name: string;
  readonly length: number;
}

/**
 * Mint (idempotently) `$__fn_instance_meta`. Referenced by every `$fnmeta`
 * slot, so it must exist BEFORE the first closure struct that carries one —
 * which it does by construction: the only callers are the slot factories below,
 * and they run while the closure struct's field list is still being built.
 */
export function ensureFnInstanceMetaStructType(ctx: CodegenContext): number {
  const existing = ctx.fnInstanceMetaStructTypeIdx;
  if (existing !== undefined) return existing;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__fn_instance_meta_struct",
    fields: [
      // §10.2.9 `name`, already in the representation `__builtinfn_get_meta`
      // hands back — no conversion at the read.
      { name: "name", type: { kind: "externref" }, mutable: false },
      // §15.1.5 ExpectedArgumentCount. Deliberately NOT `$arity`: that slot is
      // the dispatch arity `closure-exports.ts` pads under-applied calls to.
      { name: "length", type: { kind: "i32" }, mutable: false },
    ],
  });
  ctx.fnInstanceMetaStructTypeIdx = typeIdx;
  return typeIdx;
}

/** The `$fnmeta` field definition. Nullable so a fill failure degrades to "no metadata". */
export function fnMetaField(ctx: CodegenContext): FieldDef {
  return {
    name: FN_META_FIELD,
    type: {
      kind: "ref_null",
      typeIdx: ensureFnInstanceMetaStructType(ctx),
    } as ValType,
    mutable: false,
  };
}

/**
 * The lazily-initialized module global holding the ONE metadata instance for
 * `meta`, and the instruction sequence that yields it.
 *
 * The null-guard lives in a FUNCTION BODY rather than the global's initializer
 * for the reason `pushBuiltinFnSingletonValueInstrs` documents: a native string
 * literal materializes as `global.get <interned>` today but as `call <helper>`
 * once it exceeds `array.new_fixed`'s limit, and the late-import shifters walk
 * function bodies, never `ctx.mod.globals[].init`. Keeping the sequence in a
 * shift-covered array makes the choice of materialization irrelevant here.
 */
function pushFnInstanceMetaValueInstrs(ctx: CodegenContext, meta: FnInstanceMeta): Instr[] {
  const structTypeIdx = ensureFnInstanceMetaStructType(ctx);
  // `<length>:<name>` — unambiguous for ANY name, because `length` is
  // digits-only, so the first `:` is always the separator even when the name
  // itself contains one (a computed key like `{ "a:b": function () {} }`).
  const key = `${meta.length}:${meta.name}`;
  const cache = (ctx.fnInstanceMetaGlobalByKey ??= new Map<string, number>());
  let globalIdx = cache.get(key);
  if (globalIdx === undefined) {
    globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: `__fn_instance_meta_${cache.size}`,
      type: { kind: "ref_null", typeIdx: structTypeIdx },
      mutable: true,
      init: [{ op: "ref.null", typeIdx: structTypeIdx }],
    });
    cache.set(key, globalIdx);
  }
  return [
    { op: "global.get", index: globalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...nativeStringLiteralInstrs(ctx, meta.name),
        { op: "extern.convert_any" },
        { op: "i32.const", value: meta.length },
        { op: "struct.new", typeIdx: structTypeIdx },
        { op: "global.set", index: globalIdx },
      ],
    },
    { op: "global.get", index: globalIdx },
  ];
}

/**
 * Register `typeIdx` as a metadata FAMILY: a closure struct type whose field
 * `fieldIdx` is a `$fnmeta` slot. `fillFunctionInstanceProps` emits one
 * `ref.test` arm per registered family, so every family must be registered
 * before finalize (they all are — minting happens during expression codegen).
 */
export function registerFnMetaFamily(ctx: CodegenContext, typeIdx: number, fieldIdx: number): void {
  (ctx.fnInstanceMetaFamilies ??= new Map<number, number>()).set(typeIdx, fieldIdx);
}

/**
 * The `$fnmeta`-carrying SUBTYPE of a SHARED closure struct, minted once per
 * base and cached.
 *
 * Only needed where the base is shared across functions — the per-signature
 * funcref wrapper and its constructible variant. A capture subtype is already
 * per-function (`__fn_cap_<name>_<n>`), so it grows the slot in its own field
 * list instead and never comes here.
 *
 * The subtype redeclares the base's fields verbatim, so every existing
 * `struct.get` by index (captures, `__constructible`, the closure header) is
 * unchanged, and every `ref.cast` to the base still succeeds. `closureInfo` is
 * re-registered under the new index so the static closure-call path and
 * reflective `.call` recovery resolve it exactly like the base.
 */
export function ensureFnMetaSubtype(ctx: CodegenContext, baseTypeIdx: number): number | undefined {
  if (!ctx.standalone) return undefined;
  const cache = (ctx.fnInstanceMetaSubtypeByBase ??= new Map<number, number>());
  const existing = cache.get(baseTypeIdx);
  if (existing !== undefined) return existing;

  const base = ctx.mod.types[baseTypeIdx];
  if (base === undefined || base.kind !== "struct") return undefined;
  // Mint the metadata struct BEFORE the subtype so the `$fnmeta` field's type
  // index is a backward reference (see the module header on rec groups).
  const field = fnMetaField(ctx);
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `${base.name}__fnmeta`,
    fields: [...base.fields, field],
    superTypeIdx: baseTypeIdx,
  });

  const baseInfo = ctx.closureInfoByTypeIdx.get(baseTypeIdx);
  if (baseInfo)
    ctx.closureInfoByTypeIdx.set(typeIdx, {
      ...baseInfo,
      structTypeIdx: typeIdx,
    });
  // IsConstructor is a `ref.test` over the registered constructible types; the
  // subtype passes the base's test, but reflect-construct-native.ts enumerates
  // the set by index, so record it there too when the base is constructible.
  if (ctx.constructibleClosureTypeIdxs.has(baseTypeIdx)) ctx.constructibleClosureTypeIdxs.add(typeIdx);
  registerFnMetaFamily(ctx, typeIdx, base.fields.length);
  cache.set(baseTypeIdx, typeIdx);
  return typeIdx;
}

/**
 * Is `decl` the synthesized declaration `eval-inline.ts` parses for a
 * `new Function(…)` / `eval(…)` splice? Detected by the SOURCE FILE the node
 * came from rather than by its name text: the name is a generated
 * `__new_function_<n>`, and matching that string would couple this module to a
 * template literal in another file.
 */
function isSynthesizedEvalDeclaration(decl: ts.Node): boolean {
  const file = decl.getSourceFile?.();
  return file !== undefined && file.fileName === EVAL_SOURCE_FILENAME;
}

/**
 * §10.2.9 SetFunctionName for a function-like declaration, as far as it is
 * statically decidable at the closure's mint site.
 *
 * A named declaration/expression uses its own name. An ANONYMOUS function or
 * arrow inherits the binding it is being defined into (NamedEvaluation) — the
 * variable, property, binding element or simple assignment target. Anything
 * else answers `""`, which is also the spec answer for a genuinely anonymous
 * function value, so a miss here is a correct-but-imprecise `""` rather than a
 * wrong name.
 */
export function fnInstanceNameOf(decl: ts.Node): string {
  if (
    (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isClassDeclaration(decl)) &&
    decl.name !== undefined
  ) {
    // §20.2.1.1.1: a function built by `new Function(…)` is named `"anonymous"`.
    // `eval-inline.ts` splices one in as a real parsed declaration under a
    // SYNTHESIZED name (`__new_function_<n>`, unique per site), so reading
    // `decl.name.text` here would publish a compiler-internal identifier as an
    // observable property value — measured on `built-ins/Function/instance-name.js`,
    // which went from reporting `undefined` to reporting `__new_function_474`.
    if (isSynthesizedEvalDeclaration(decl)) return "anonymous";
    return decl.name.text;
  }
  if (ts.isClassExpression(decl) && decl.name !== undefined) return decl.name.text;

  // NamedEvaluation: the anonymous definition takes the name of what it is
  // being bound to. Only the syntactic forms that carry an identifier/literal
  // key are resolvable here; computed keys are runtime values.
  //
  // Parentheses are TRANSPARENT to NamedEvaluation — the CoverParenthesized
  // production keeps `var cover = (function () {});` anonymous, so the binding
  // name still applies (`language/*/fn-name-cover.js`). A COMMA expression is
  // not: `var xCover = (0, function () {});` is not an anonymous function
  // DEFINITION, and those files assert the name is NOT taken. Walking only
  // through `ParenthesizedExpression` keeps the two apart.
  let node: ts.Node = decl;
  while (node.parent !== undefined && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined) return "";
  if ((ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) && parent.initializer === node) {
    return ts.isIdentifier(parent.name) ? parent.name.text : "";
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    const key = parent.name;
    if (ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key)) return key.text;
    return "";
  }
  if (ts.isPropertyDeclaration(parent) && parent.initializer === node) {
    const key = parent.name;
    return ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : "";
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node &&
    ts.isIdentifier(parent.left)
  ) {
    return parent.left.text;
  }
  return "";
}

/**
 * The metadata a function-like declaration must reflect, or `undefined` when
 * this module has nothing to add (not standalone, or `decl` is not a function
 * with a parameter list).
 *
 * `length` comes from the SAME §15.1.5 walk the static `<fn>.length` fold uses
 * (#4436's `function-expected-argument-count.ts`) — one statement of one
 * observable value, so the fold and the descriptor cannot disagree.
 */
export function fnInstanceMetaOf(ctx: CodegenContext, decl: ts.Node | undefined): FnInstanceMeta | undefined {
  if (!ctx.standalone || decl === undefined) return undefined;
  if (!ts.isFunctionLike(decl)) return undefined;
  // A method/accessor's own `name` has spec subtleties (`get `/`set ` prefixes,
  // symbol keys) that this slice does not measure; declarations, function
  // expressions and arrows are the buckets #4436 left open.
  if (
    !ts.isFunctionDeclaration(decl) &&
    !ts.isFunctionExpression(decl) &&
    !ts.isArrowFunction(decl) &&
    !ts.isMethodDeclaration(decl)
  ) {
    return undefined;
  }
  return {
    name: fnInstanceNameOf(decl),
    length: expectedArgumentCountOfParams(decl.parameters),
  };
}

/**
 * The `$fnmeta` field + its `struct.new` operand for `decl`, or `undefined`
 * when the declaration carries no resolvable metadata.
 *
 * The two halves are returned TOGETHER on purpose: a field added without its
 * operand (or the reverse) is a `struct.new` arity mismatch, which the emitter
 * rejects loudly — but only if both live at one call site. Splitting them
 * across two helpers is how a missed allocation site becomes a silent
 * mis-typed push.
 */
export function fnMetaSlot(
  ctx: CodegenContext,
  decl: ts.Node | undefined,
): { field: FieldDef; init: Instr[]; meta: FnInstanceMeta } | undefined {
  const meta = fnInstanceMetaOf(ctx, decl);
  if (meta === undefined) return undefined;
  return fnMetaSlotOfMeta(ctx, meta);
}

/**
 * (#4440) The same pair for a metadata value the caller resolved itself.
 *
 * `fnMetaSlot` reads §10.2.9 off the declaration, which is the right answer for
 * a function declaration/expression/arrow but NOT for a method: a method's name
 * carries the `get `/`set ` prefix and comes from a property KEY, and the walk
 * that decides it lives in `function-instance-meta-methods.ts`. Exposing the
 * materialization half separately lets that module reuse the interning global
 * and the field definition verbatim instead of duplicating them — so a method's
 * `{name, length}` lands in the SAME per-`<length>:<name>` module global as an
 * identically-shaped function's, and the two can never disagree about layout.
 */
export function fnMetaSlotOfMeta(
  ctx: CodegenContext,
  meta: FnInstanceMeta,
): { field: FieldDef; init: Instr[]; meta: FnInstanceMeta } {
  return {
    field: fnMetaField(ctx),
    init: pushFnInstanceMetaValueInstrs(ctx, meta),
    meta,
  };
}
