// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#4618 / #6608) The nominal `__tag` guard that makes a per-class dispatch arm
 * fire only for its OWN class.
 *
 * `ref.test $C` is a STRUCTURAL test. WasmGC canonicalizes struct types by
 * shape, so two unrelated classes with the same field layout — and field NAMES
 * do not exist in wasm, so `class A { x }` and `class B { y }` have the same
 * layout, as does every pair of state-in-a-WeakMap classes, which have no
 * fields at all beyond the compiler's own `__tag` — are literally the same
 * runtime type. Every arm in a per-name ladder then matches every instance and
 * the OUTERMOST arm wins, so a method call by name on a statically-unknown
 * receiver runs the LAST-declared class's body (measured: three classes each
 * declaring `toJSON`, `a.toJSON()` on an `A` ran `E`'s and threw that class's
 * brand error).
 *
 * `__tag` is the compiler's per-class discriminator (field 0 of every class
 * struct, `ctx.classTagMap`), so testing it turns the structural arm into a
 * nominal one. Own tag PLUS every descendant's tag: a parent's arm must keep
 * matching subclass instances so an inherited method still dispatches, and a
 * more-derived arm sits further out when the subclass overrides.
 *
 * Returns `undefined` — so the caller emits its pre-existing bare `ref.test`
 * and the module's bytes do not move — when the guard cannot or need not
 * apply: a struct with no `__tag` (object literals, synthetic carriers), a
 * class with no registered tag, or a layout no other emitted struct shares.
 * The last is what keeps single-declarer programs byte-identical: a ladder
 * whose classes all have distinct shapes needs no test beyond `ref.test`.
 */

import type { FieldDef, Instr, TypeDef, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ts } from "../ts-api.js";
import { integrityVarKey } from "./widened-var-key.js";
import { isLexicalBindingWrite } from "../shared/binding-writes.js";

/**
 * (#7199) Could the structs `a` and `b` be ONE canonical WasmGC type?
 *
 * The twin test used to compare field type INDICES, so `class A { a: P }` and
 * `class B { b: Q }` with `P`/`Q` themselves twins read as distinct although
 * the engine canonicalises both pairs to one type (same for `P[]` vs `Q[]`, a
 * self-referencing `class A { a: A | null }` beside `class B { b: B | null }`,
 * and mutually-referencing pairs whose rec groups are isomorphic).
 *
 * This is a deliberate OVER-approximation of isorecursive equality, never an
 * under-approximation: the answer may only be wrong towards "maybe twins",
 * which costs a redundant (still correct) `__tag` test and nothing else. So the
 * walk compares field kinds and referenced type SHAPES, coinductively — a pair
 * already on the stack is assumed equal, which accepts every cycle that iso-
 * recursive equality accepts — and ignores what only ever SEPARATES canonical
 * types: mutability, supertype/finality, and the emitter's later rec-group
 * split. An index it cannot resolve answers "maybe". Equal indices (the old
 * test) still answer "equal", so the guarded set only grows.
 */
function mayShareCanonicalLayout(ctx: CodegenContext, a: readonly FieldDef[], b: readonly FieldDef[]): boolean {
  const assumed = new Set<string>();
  const def = (idx: number): Exclude<TypeDef, { kind: "rec" | "sub" }> | undefined => {
    const t = ctx.mod.types[idx];
    return t?.kind === "sub" ? t.type : t?.kind === "rec" ? undefined : t;
  };
  const sameType = (x: number, y: number): boolean => {
    if (x === y) return true;
    const key = x < y ? `${x},${y}` : `${y},${x}`;
    if (assumed.has(key)) return true;
    const dx = def(x);
    const dy = def(y);
    if (!dx || !dy) return true;
    if (dx.kind !== dy.kind) return false;
    assumed.add(key);
    if (dx.kind === "struct") return sameFields(dx.fields, (dy as typeof dx).fields);
    if (dx.kind === "array") return sameVal(dx.element, (dy as typeof dx).element);
    const fy = dy as typeof dx;
    return sameVals(dx.params, fy.params) && sameVals(dx.results, fy.results);
  };
  const sameVal = (x: ValType, y: ValType): boolean => {
    if (x.kind !== y.kind) return false;
    const xi = (x as { typeIdx?: number }).typeIdx;
    const yi = (y as { typeIdx?: number }).typeIdx;
    return xi === undefined || yi === undefined ? xi === yi : sameType(xi, yi);
  };
  const sameVals = (x: readonly ValType[], y: readonly ValType[]): boolean =>
    x.length === y.length && x.every((v, i) => sameVal(v, y[i]!));
  const sameFields = (x: readonly FieldDef[], y: readonly FieldDef[]): boolean =>
    x.length === y.length && x.every((f, i) => sameVal(f.type, y[i]!.type));
  return sameFields(a, b);
}

/** (#7158 / #7199) Does any OTHER emitted struct possibly share `structName`'s canonical type? */
function hasLayoutTwin(ctx: CodegenContext, structName: string): boolean {
  const own = ctx.structFields.get(structName);
  if (!own) return false;
  for (const [name, fields] of ctx.structFields) {
    if (name !== structName && mayShareCanonicalLayout(ctx, own, fields)) return true;
  }
  return false;
}

/**
 * The `__tag` values `receiver.__tag ∈ {own} ∪ {descendants}` accepts for
 * `structName`'s arm, or `undefined` when no guard is needed (see the module
 * comment).
 *
 * (#7200) Also the guard set for the closed-struct OWN-PROPERTY arms
 * (`fillClosedStructHasOwnArms`): a field declared on `structName` is an own
 * property of every instance of it or a subclass, and of nothing else.
 */
export function classArmTags(ctx: CodegenContext, structName: string): number[] | undefined {
  const fields = ctx.structFields.get(structName);
  if (!fields || fields.length === 0 || fields[0]!.name !== "__tag") return undefined;
  // Compare against every emitted struct, not only the ones that also declare
  // this member. A same-layout sibling that does NOT declare the key is the
  // important negative case: without a tag guard its instance passes this
  // arm's structural `ref.test` and appears to inherit an unrelated
  // sibling-only method (React's repeated `class Foo` tests observed
  // UNSAFE_componentWillMount from a later sibling).
  if (!hasLayoutTwin(ctx, structName)) return undefined;
  const ownTag = ctx.classTagMap.get(structName);
  if (ownTag === undefined) return undefined;
  const tags = [ownTag];
  const isDescendantOf = (n: string): boolean => {
    let cur: string | undefined = ctx.classParentMap.get(n);
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur)) {
      if (cur === structName) return true;
      seen.add(cur);
      cur = ctx.classParentMap.get(cur);
    }
    return false;
  };
  for (const [childName, tag] of ctx.classTagMap) {
    if (childName !== structName && isDescendantOf(childName) && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/**
 * The i32 condition `receiver.__tag ∈ {own} ∪ {descendants}`, or `undefined`
 * when no guard is needed (see the module comment).
 *
 * `receiverLocal` must hold the receiver as an `anyref` — the condition casts
 * it to `typeIdx`, so it is only valid inside the arm's own `ref.test` `then`.
 */
export function classArmTagCondition(
  ctx: CodegenContext,
  structName: string,
  typeIdx: number,
  receiverLocal: number,
): Instr[] | undefined {
  const tags = classArmTags(ctx, structName);
  if (tags === undefined) return undefined;
  const readTag: Instr[] = [
    { op: "local.get", index: receiverLocal },
    { op: "ref.cast", typeIdx },
    { op: "struct.get", typeIdx, fieldIdx: 0 },
  ];
  const cond: Instr[] = [...readTag, { op: "i32.const", value: tags[0]! }, { op: "i32.eq" }];
  for (const t of tags.slice(1)) {
    cond.push(...readTag, { op: "i32.const", value: t }, { op: "i32.eq" }, { op: "i32.or" });
  }
  return cond;
}

/**
 * Wrap an arm's bare `ref.test` claim in the nominal guard: the emitted i32 is
 * `ref.test $C && receiver.__tag ∈ tags`. With no guard needed this is exactly
 * the caller's previous two instructions, so the bytes do not move.
 */
export function classArmClaimInstrs(
  ctx: CodegenContext,
  structName: string,
  typeIdx: number,
  receiverLocal: number,
): Instr[] {
  const tagCond = classArmTagCondition(ctx, structName, typeIdx, receiverLocal);
  return [
    { op: "local.get", index: receiverLocal },
    { op: "ref.test", typeIdx },
    ...(tagCond === undefined
      ? []
      : ([
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: tagCond,
            else: [{ op: "i32.const", value: 0 }],
          },
        ] satisfies Instr[])),
  ];
}

/**
 * (#7158) The `__tag` values a closed-struct ENUMERATION arm for `structName`
 * must accept, or `undefined` when its bare `ref.test` is already exact.
 *
 * Enumeration arms (`__object_keys`, for…in, `getOwnPropertyNames`, and the
 * JSON/assign/spread consumers built on them) answer a NAME LIST, so an arm may
 * only fire for instances whose own layout it describes. `ref.test` alone is
 * too wide twice over: a same-layout twin (`class A { a = 1 }` /
 * `class B { b = 1 }`, or a private-only `class C { #x = 1 }` beside
 * `class D { y = 2 }`) is the same canonical type, and a subclass struct is a
 * subtype, so `ref.test $Base` also accepts an instance that has its own,
 * longer arm. The accepted set is every class whose NEAREST arm-owning
 * ancestor-or-self is `structName` — a subclass without its own arm still
 * reads its parent's names, exactly as the structural test answered before.
 *
 * `armStructNames` is the set of struct names that own an arm. Untagged
 * structs, unregistered classes, and arms with neither a layout twin nor an
 * arm-owning descendant get `undefined`, so their bytes do not move.
 */
function enumerationArmTags(
  ctx: CodegenContext,
  structName: string,
  armStructNames: ReadonlySet<string>,
): number[] | undefined {
  const fields = ctx.structFields.get(structName);
  if (!fields || fields[0]?.name !== "__tag" || ctx.classTagMap.get(structName) === undefined) return undefined;
  const nearestArm = (cls: string): string | undefined => {
    const seen = new Set<string>();
    let cur: string | undefined = cls;
    while (cur !== undefined && !armStructNames.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = ctx.classParentMap.get(cur);
    }
    return cur !== undefined && armStructNames.has(cur) ? cur : undefined;
  };
  const twin = hasLayoutTwin(ctx, structName);
  const armDescendant = [...armStructNames].some(
    (n) => n !== structName && nearestArm(ctx.classParentMap.get(n) ?? "") === structName,
  );
  if (!twin && !armDescendant) return undefined;
  const tags: number[] = [];
  for (const [cls, tag] of ctx.classTagMap) if (nearestArm(cls) === structName && !tags.includes(tag)) tags.push(tag);
  return tags;
}

/**
 * (#7158) Set `classTags` on every enumeration entry that needs the nominal
 * guard (`structName` names each entry's class struct).
 */
export function assignEnumerationArmTags(
  ctx: CodegenContext,
  entries: { structName?: string; classTags?: number[] }[],
): void {
  const armStructNames = new Set(entries.map((entry) => entry.structName!));
  for (const entry of entries) {
    const classTags = enumerationArmTags(ctx, entry.structName!, armStructNames);
    if (classTags) entry.classTags = classTags;
  }
}

/**
 * (#7158) Appended after an enumeration arm's `ref.test` on the externref
 * receiver in local 0: the i32 becomes `ref.test ∧ __tag ∈ classTags`. Empty
 * (bytes unchanged) when the arm needs no guard.
 */
export function enumerationArmTagGuard(typeIdx: number, classTags: number[] | undefined): Instr[] {
  if (classTags === undefined) return [];
  const cond: Instr[] = [];
  for (const [i, tag] of classTags.entries()) {
    cond.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx },
      { op: "struct.get", typeIdx, fieldIdx: 0 },
      { op: "i32.const", value: tag },
      { op: "i32.eq" },
      ...(i > 0 ? [{ op: "i32.or" } as Instr] : []),
    );
  }
  if (cond.length === 0) cond.push({ op: "i32.const", value: 0 });
  return [
    { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: cond, else: [{ op: "i32.const", value: 0 }] },
  ];
}

/**
 * (#7216) Own-key consumers on a receiver whose STATIC class has subclasses.
 *
 * `Object.keys`/`values`/`entries`, for…in, `hasOwnProperty` and `in` used to
 * fold from the static class's field list. A receiver typed `Animal` may at
 * runtime hold a `Dog` — a longer subtype struct — so the fold dropped every
 * subclass-only field:
 *
 * ```ts
 * class Animal { name = "a" }
 * class Dog extends Animal { breed = "b" }
 * const xs: Animal[] = [new Dog()];
 * Object.keys(xs[0]);   // node: ["name","breed"] — base: ["name"]
 * ```
 *
 * The runtime enumerators already answer by the receiver's own `__tag`
 * (#7158), which is why `JSON.stringify` / spread were right. These predicates
 * send such a receiver to them. Every other receiver keeps its compile-time
 * fold, so its bytes do not move: a class nothing extends, the constructor
 * itself (`typeof C` lowers to the same struct ref but its own keys are the
 * statics), `C.prototype`, and a receiver that is provably a `new` of the
 * static class.
 */

/** Does any emitted class extend `structName`? */
function classHasSubclass(ctx: CodegenContext, structName: string): boolean {
  for (const parent of ctx.classParentMap.values()) if (parent === structName) return true;
  return false;
}

/** The class node a `new` target names, or `undefined` for a constructor-typed value. */
function newTargetClass(ctx: CodegenContext, target: ts.Expression): ts.ClassLikeDeclaration | undefined {
  const decl = ts.isIdentifier(target) ? ctx.oracle.valueDeclarationOf(target) : undefined;
  if (decl && (ts.isClassDeclaration(decl) || ts.isClassExpression(decl))) return decl;
  let init = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
  while (init && ts.isParenthesizedExpression(init)) init = init.expression;
  return init && ts.isClassExpression(init) ? init : undefined;
}

/** Names written anywhere in a file, computed once per (immutable) parsed file. */
const writtenNamesByFile = new WeakMap<ts.SourceFile, Set<string>>();

/** Is any binding named `name` written in `file`? Name-based, so it over-reports. */
function nameIsWritten(file: ts.SourceFile, name: string): boolean {
  let names = writtenNamesByFile.get(file);
  if (names === undefined) {
    const written = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && isLexicalBindingWrite(node)) written.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(file);
    writtenNamesByFile.set(file, (names = written));
  }
  return names.has(name);
}

/**
 * Is `expr` provably an instance built by `new X()` at a site the compiler
 * sees — directly, or through a `const` (or a `let`/`var` never written
 * again) — where `X` is the static class? A constructor-typed `X` also
 * counts: the compiler builds the static class there (a separate defect), so
 * the fold keeps base's answer. A `new` of a SUBCLASS (`const y: A = new B()`)
 * does not count.
 */
function isExactStaticNew(ctx: CodegenContext, expr: ts.Expression, staticType: ts.Type): boolean {
  let r: ts.Expression = expr;
  while (ts.isParenthesizedExpression(r)) r = r.expression;
  if (ts.isIdentifier(r)) {
    const decl = ctx.oracle.variableDeclarationOf(r);
    const isConst = decl !== undefined && (decl.parent.flags & ts.NodeFlags.Const) !== 0;
    const init = decl?.initializer;
    if (!init || (!isConst && nameIsWritten(r.getSourceFile(), r.text))) return false;
    r = init;
    while (ts.isParenthesizedExpression(r)) r = r.expression;
  }
  if (!ts.isNewExpression(r)) return false;
  const cls = newTargetClass(ctx, r.expression);
  return cls === undefined || (staticType.getSymbol()?.declarations?.includes(cls) ?? false);
}

/**
 * `C.prototype` is typed as an instance of `C` but holds the methods, not the
 * fields; the fold already answers it (and wasi's runtime arm inverts it).
 */
function isPrototypeObject(expr: ts.Expression): boolean {
  let r: ts.Expression = expr;
  while (ts.isParenthesizedExpression(r) || ts.isNonNullExpression(r)) r = r.expression;
  return ts.isPropertyAccessExpression(r) && r.name.text === "prototype";
}

/**
 * Must the own-key consumer over `expr` (static type `tsType`, lowered to the
 * closed struct `structName`) enumerate at runtime instead of folding?
 */
function subclassedInstance(
  ctx: CodegenContext,
  structName: string | undefined,
  tsType: ts.Type,
  expr: ts.Expression,
): boolean {
  if (structName === undefined || !classHasSubclass(ctx, structName)) return false;
  const t = tsType.getNonNullableType();
  return t.getConstructSignatures().length === 0 && !isPrototypeObject(expr) && !isExactStaticNew(ctx, expr, t);
}

/** `subclassedInstance` for a receiver's lowered wasm type (for…in, `hasOwnProperty`, `in`). */
export function subclassedInstanceReceiver(
  ctx: CodegenContext,
  recvWasm: ValType,
  tsType: ts.Type,
  expr: ts.Expression,
): boolean {
  const name =
    recvWasm.kind === "ref" || recvWasm.kind === "ref_null" ? ctx.typeIdxToStructName.get(recvWasm.typeIdx) : undefined;
  return subclassedInstance(ctx, name, tsType, expr);
}

/**
 * `subclassedInstanceReceiver` for `hasOwnProperty`/`propertyIsEnumerable`. A
 * literal key naming a field of the static class is own on every instance of
 * it or a subclass, so the fold already answers it, and it stays right for a
 * value that failed the struct cast (null at runtime, which base still
 * answered from the field list).
 */
export function introspectionSubclassRoute(
  ctx: CodegenContext,
  recvWasm: ValType,
  tsType: ts.Type,
  expr: ts.Expression,
  key: ts.Expression | undefined,
): boolean {
  if (key !== undefined && ts.isStringLiteral(key) && (recvWasm.kind === "ref" || recvWasm.kind === "ref_null")) {
    const fields = ctx.structFields.get(ctx.typeIdxToStructName.get(recvWasm.typeIdx) ?? "");
    if (fields?.some((f) => f.name === key.text && !f.name.startsWith("__"))) return false;
  }
  return subclassedInstanceReceiver(ctx, recvWasm, tsType, expr);
}

/** Has an `Object.defineProperty` re-flagged a property of the identifier `arg`? */
function hasDefinedPropertyFlags(ctx: CodegenContext, arg: ts.Expression): boolean {
  if (!ts.isIdentifier(arg)) return false;
  const prefix = `${integrityVarKey(ctx, arg)}:`;
  for (const key of ctx.definedPropertyFlags.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

/**
 * Should `Object.<method>(arg)` over the closed struct `structName` enumerate
 * at runtime instead of expanding the static field list?
 *
 * Besides the `subclassedInstance` exclusions, two receivers keep the fold.
 * One re-flagged by `Object.defineProperty`: only the compile-time enumerable
 * filter honours those flags (the runtime lists a hidden field). And wasi
 * `values`/`entries`: their natives have no closed-struct arm there
 * (`nonObjectEnumerableOwnInstrs` is standalone-only) and would answer `[]`.
 */
export function ownKeysSubclassRoute(
  ctx: CodegenContext,
  method: string,
  structName: string | undefined,
  argType: ts.Type,
  arg: ts.Expression,
): boolean {
  return (
    (method === "keys" || !ctx.wasi || ctx.standalone) &&
    subclassedInstance(ctx, structName, argType, arg) &&
    !hasDefinedPropertyFlags(ctx, arg)
  );
}
