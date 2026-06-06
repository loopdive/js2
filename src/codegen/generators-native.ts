// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Wasm-native generator lowering (#680).
 *
 * This is the Phase 1 state-machine path for no-JS-host targets. It handles
 * simple, top-level sequential `function*` declarations with numeric yields and
 * an optional numeric `return`. More complex generator shapes keep using the
 * legacy JS-host buffer path when a JS host is available.
 */
import { ts } from "../ts-api.js";
import { isBooleanType, isNumberType } from "../checker/type-mapper.js";
import type { FieldDef, Instr, ValType, WasmFunction } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import { popBody, pushBody } from "./context/bodies.js";
import type { CodegenContext, FunctionContext, NativeGeneratorInfo } from "./context/types.js";
import { reportError } from "./context/errors.js";
import { addFuncType } from "./registry/types.js";
import { coerceType, compileExpression, compileStatement, valTypesMatch } from "./shared.js";

const STATE_FIELD = 0;
const SENT_FIELD = 1;
const MODE_FIELD = 2;
const ABRUPT_FIELD = 3;
const RESULT_VALUE_FIELD = 0;
const RESULT_DONE_FIELD = 1;
const PARAM_FIELD_OFFSET = 4;
const MAX_NATIVE_GENERATOR_STATES = 256;

interface NativeGeneratorSegment {
  resumeBindings: string[];
  abruptResume?: {
    finalizers: readonly ts.Statement[][];
  };
  statements: ts.Statement[];
  yieldExpr?: ts.YieldExpression;
  returnStmt?: ts.ReturnStatement;
}

interface NativeGeneratorPlan {
  segments: NativeGeneratorSegment[];
  spills: string[];
}

function noJsHostTarget(ctx: CodegenContext): boolean {
  return ctx.standalone || ctx.wasi;
}

function sanitizeTypeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, "_");
}

function isNumericExpression(ctx: CodegenContext, expr: ts.Expression | undefined): boolean {
  if (!expr) return true;
  const t = ctx.checker.getTypeAtLocation(expr);
  return isNumberType(t) || isBooleanType(t);
}

function statementContainsYield(stmt: ts.Statement): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isYieldExpression(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(stmt, visit);
  return found;
}

function buildNativeGeneratorPlan(ctx: CodegenContext, decl: ts.FunctionDeclaration): NativeGeneratorPlan | null {
  if (!decl.body) return null;
  const segments: NativeGeneratorSegment[] = [];
  const spills: string[] = [];
  const spillSet = new Set<string>();
  let current: ts.Statement[] = [];
  let pendingResumeBindings: string[] = [];
  let pendingAbruptResume: NativeGeneratorSegment["abruptResume"] | undefined;

  const addSpill = (name: string): void => {
    if (spillSet.has(name)) return;
    spillSet.add(name);
    spills.push(name);
  };

  const pushSegment = (yieldExpr: ts.YieldExpression | undefined, returnStmt: ts.ReturnStatement | undefined): void => {
    segments.push({
      resumeBindings: pendingResumeBindings,
      abruptResume: pendingAbruptResume,
      statements: current,
      yieldExpr,
      returnStmt,
    });
    pendingResumeBindings = [];
    pendingAbruptResume = undefined;
    current = [];
  };

  const emitYieldSegment = (
    yieldExpr: ts.YieldExpression,
    bindSentTo: string | undefined,
    activeFinalizers: readonly ts.Statement[][],
  ): boolean => {
    if (yieldExpr.asteriskToken || !isNumericExpression(ctx, yieldExpr.expression)) return false;
    pushSegment(yieldExpr, undefined);
    pendingAbruptResume = {
      // GeneratorResumeAbrupt resumes at the suspended yield with a return
      // completion. Any enclosing finally blocks run nearest-first.
      finalizers: [...activeFinalizers].reverse(),
    };
    if (bindSentTo) {
      addSpill(bindSentTo);
      pendingResumeBindings = [bindSentTo];
    }
    return true;
  };

  const tryYieldDeclaration = (stmt: ts.Statement): { name: string; yieldExpr: ts.YieldExpression } | null => {
    if (!ts.isVariableStatement(stmt)) return null;
    if (stmt.declarationList.declarations.length !== 1) return null;
    const declStmt = stmt.declarationList.declarations[0]!;
    if (!ts.isIdentifier(declStmt.name)) return null;
    if (!declStmt.initializer || !ts.isYieldExpression(declStmt.initializer)) return null;
    return { name: declStmt.name.text, yieldExpr: declStmt.initializer };
  };

  const statementsAreYieldFree = (statements: readonly ts.Statement[]): boolean =>
    statements.every((stmt) => !statementContainsYield(stmt));

  const visitStatements = (
    statements: readonly ts.Statement[],
    activeFinalizers: readonly ts.Statement[][],
  ): boolean => {
    for (const stmt of statements) {
      if (stmt.kind === ts.SyntaxKind.EmptyStatement) continue;

      if (ts.isExpressionStatement(stmt) && ts.isYieldExpression(stmt.expression)) {
        if (!emitYieldSegment(stmt.expression, undefined, activeFinalizers)) return false;
        continue;
      }

      const yieldedDeclaration = tryYieldDeclaration(stmt);
      if (yieldedDeclaration) {
        if (!emitYieldSegment(yieldedDeclaration.yieldExpr, yieldedDeclaration.name, activeFinalizers)) return false;
        continue;
      }

      if (ts.isTryStatement(stmt)) {
        if (stmt.catchClause || !stmt.finallyBlock) return false;
        if (!statementsAreYieldFree(stmt.finallyBlock.statements)) return false;
        if (!visitStatements(stmt.tryBlock.statements, [...activeFinalizers, [...stmt.finallyBlock.statements]])) {
          return false;
        }
        current.push(...stmt.finallyBlock.statements);
        continue;
      }

      if (ts.isReturnStatement(stmt)) {
        if (statementContainsYield(stmt) || !isNumericExpression(ctx, stmt.expression)) return false;
        pushSegment(undefined, stmt);
        current = [];
        break;
      }

      // Phase 1 allows ordinary expression statements in a segment so side
      // effects before a yield stay lazy. Declarations/control flow need spill
      // analysis and are left to follow-up phases.
      if (ts.isExpressionStatement(stmt) && !statementContainsYield(stmt)) {
        current.push(stmt);
        continue;
      }

      return false;
    }
    return true;
  };

  if (!visitStatements(decl.body.statements, [])) return null;

  if (
    current.length > 0 ||
    pendingResumeBindings.length > 0 ||
    pendingAbruptResume !== undefined ||
    segments.length === 0 ||
    segments.at(-1)?.returnStmt === undefined
  ) {
    pushSegment(undefined, undefined);
  }

  const yieldCount = segments.filter((s) => s.yieldExpr !== undefined).length;
  if (yieldCount > MAX_NATIVE_GENERATOR_STATES) return null;
  return { segments, spills };
}

export function isNativeGeneratorCandidate(ctx: CodegenContext, decl: ts.FunctionDeclaration): boolean {
  if (!noJsHostTarget(ctx)) return false;
  if (!decl.name || !decl.body || !decl.asteriskToken) return false;
  const modifiers = ts.canHaveModifiers(decl) ? ts.getModifiers(decl) : undefined;
  if (modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword || m.kind === ts.SyntaxKind.DeclareKeyword)) {
    return false;
  }
  for (const param of decl.parameters) {
    if (param.dotDotDotToken || !ts.isIdentifier(param.name)) return false;
  }
  const plan = buildNativeGeneratorPlan(ctx, decl);
  return plan !== null && plan.segments.some((s) => s.yieldExpr !== undefined);
}

export function sourceNeedsGeneratorHostImports(ctx: CodegenContext, sourceFile: ts.SourceFile): boolean {
  let found = false;
  let needsHost = false;

  function visit(node: ts.Node): void {
    if (needsHost) return;
    if (ts.isFunctionDeclaration(node) && node.asteriskToken && node.body) {
      found = true;
      if (!isNativeGeneratorCandidate(ctx, node)) needsHost = true;
      return;
    }
    if (ts.isFunctionExpression(node) && node.asteriskToken) {
      found = true;
      needsHost = true;
      return;
    }
    if (ts.isMethodDeclaration(node) && node.asteriskToken && node.body) {
      found = true;
      needsHost = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return found && needsHost;
}

export function ensureNativeGeneratorResultType(ctx: CodegenContext): number {
  if (ctx.nativeGeneratorResultTypeIdx >= 0) return ctx.nativeGeneratorResultTypeIdx;
  const existing = ctx.structMap.get("__NativeGeneratorResult_f64");
  if (existing !== undefined) {
    ctx.nativeGeneratorResultTypeIdx = existing;
    return existing;
  }

  const fields: FieldDef[] = [
    { name: "value", type: { kind: "f64" }, mutable: false },
    { name: "done", type: { kind: "i32" }, mutable: false },
  ];
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: "__NativeGeneratorResult_f64", fields });
  ctx.structMap.set("__NativeGeneratorResult_f64", typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, "__NativeGeneratorResult_f64");
  ctx.structFields.set("__NativeGeneratorResult_f64", fields);
  ctx.nativeGeneratorResultTypeIdx = typeIdx;
  return typeIdx;
}

export function registerNativeGenerator(
  ctx: CodegenContext,
  decl: ts.FunctionDeclaration,
  functionName: string,
  paramTypes: ValType[],
): NativeGeneratorInfo | null {
  const existing = ctx.nativeGenerators.get(functionName);
  if (existing) return existing;
  if (!isNativeGeneratorCandidate(ctx, decl)) return null;

  const plan = buildNativeGeneratorPlan(ctx, decl);
  if (!plan) return null;

  const resultTypeIdx = ensureNativeGeneratorResultType(ctx);
  const paramNames = decl.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ""));
  const stateFields: FieldDef[] = [
    { name: "state", type: { kind: "i32" }, mutable: true },
    { name: "sent", type: { kind: "f64" }, mutable: true },
    { name: "mode", type: { kind: "i32" }, mutable: true },
    { name: "abrupt", type: { kind: "f64" }, mutable: true },
  ];
  for (let i = 0; i < paramTypes.length; i++) {
    stateFields.push({
      name: `param_${paramNames[i] ?? i}`,
      type: paramTypes[i]!,
      mutable: false,
    });
  }
  const spillFieldOffset = PARAM_FIELD_OFFSET + paramTypes.length;
  for (const spill of plan.spills) {
    stateFields.push({
      name: `spill_${spill}`,
      type: { kind: "f64" },
      mutable: true,
    });
  }

  const stateName = `__GenState_${sanitizeTypeName(functionName)}`;
  const stateTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: stateName, fields: stateFields });
  ctx.structMap.set(stateName, stateTypeIdx);
  ctx.typeIdxToStructName.set(stateTypeIdx, stateName);
  ctx.structFields.set(stateName, stateFields);

  const yieldCount = plan.segments.filter((s) => s.yieldExpr !== undefined).length;
  const info: NativeGeneratorInfo = {
    functionName,
    decl,
    stateTypeIdx,
    resultTypeIdx,
    paramNames,
    paramTypes,
    paramFieldOffset: PARAM_FIELD_OFFSET,
    sentFieldIdx: SENT_FIELD,
    modeFieldIdx: MODE_FIELD,
    abruptFieldIdx: ABRUPT_FIELD,
    spillNames: plan.spills,
    spillFieldOffset,
    yieldCount,
    doneState: yieldCount + 1,
  };
  ctx.nativeGenerators.set(functionName, info);
  return info;
}

function emptyResult(info: NativeGeneratorInfo): Instr[] {
  return emptyResultForType(info.resultTypeIdx);
}

function emptyResultForType(resultTypeIdx: number): Instr[] {
  return [
    { op: "f64.const", value: 0 },
    { op: "i32.const", value: 1 },
    { op: "struct.new", typeIdx: resultTypeIdx },
  ];
}

function setState(info: NativeGeneratorInfo, state: number): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "i32.const", value: state },
    { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
  ];
}

function setMode(info: NativeGeneratorInfo, mode: number): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "i32.const", value: mode },
    { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
  ];
}

function setStateFieldFromLocal(
  info: NativeGeneratorInfo,
  selfLocal: number,
  fieldIdx: number,
  valueLocal: number,
): Instr[] {
  return [
    { op: "local.get", index: selfLocal },
    { op: "local.get", index: valueLocal },
    { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx },
  ];
}

function setStateI32FromConst(info: NativeGeneratorInfo, selfLocal: number, fieldIdx: number, value: number): Instr[] {
  return [
    { op: "local.get", index: selfLocal },
    { op: "i32.const", value },
    { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx },
  ];
}

function nativeReturnResultFromLocal(info: NativeGeneratorInfo, valueLocal: number): Instr[] {
  return [
    { op: "local.get", index: valueLocal },
    { op: "i32.const", value: 1 },
    { op: "struct.new", typeIdx: info.resultTypeIdx },
  ];
}

function storeSpills(info: NativeGeneratorInfo, fctx: FunctionContext): Instr[] {
  const body: Instr[] = [];
  for (let i = 0; i < info.spillNames.length; i++) {
    const localIdx = fctx.localMap.get(info.spillNames[i]!);
    if (localIdx === undefined) continue;
    body.push({ op: "local.get", index: 0 });
    body.push({ op: "local.get", index: localIdx });
    body.push({ op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.spillFieldOffset + i });
  }
  return body;
}

function returnAbruptResult(info: NativeGeneratorInfo): Instr[] {
  return [
    ...setState(info, info.doneState),
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.abruptFieldIdx },
    { op: "i32.const", value: 1 },
    { op: "struct.new", typeIdx: info.resultTypeIdx },
  ];
}

function emitExpressionAsF64(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression | undefined): number {
  if (!expr) {
    const tmp = allocLocal(fctx, `__gen_value_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "f64.const", value: NaN });
    fctx.body.push({ op: "local.set", index: tmp });
    return tmp;
  }

  const resultType = compileExpression(ctx, fctx, expr, { kind: "f64" });
  if (resultType === null) {
    fctx.body.push({ op: "f64.const", value: NaN });
  } else if (resultType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else if (!valTypesMatch(resultType, { kind: "f64" })) {
    coerceType(ctx, fctx, resultType, { kind: "f64" });
  }
  const tmp = allocLocal(fctx, `__gen_value_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: tmp });
  return tmp;
}

function compileSegment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: NativeGeneratorInfo,
  segment: NativeGeneratorSegment,
  yieldIndex: number,
): Instr[] {
  const saved = fctx.body;
  const body: Instr[] = [];
  fctx.body = body;

  if (segment.abruptResume) {
    const abruptBody: Instr[] = [];
    const savedAbruptBody = fctx.body;
    fctx.body = abruptBody;
    for (const finalizer of segment.abruptResume.finalizers) {
      for (const stmt of finalizer) {
        compileStatement(ctx, fctx, stmt);
      }
    }
    abruptBody.push(...storeSpills(info, fctx));
    abruptBody.push(...returnAbruptResult(info));
    abruptBody.push({ op: "return" });
    fctx.body = savedAbruptBody;

    body.push({ op: "local.get", index: 0 });
    body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx });
    body.push({ op: "i32.const", value: 1 });
    body.push({ op: "i32.eq" });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: abruptBody,
      else: [],
    });
  }

  for (const name of segment.resumeBindings) {
    const localIdx = fctx.localMap.get(name);
    const spillIdx = info.spillNames.indexOf(name);
    if (localIdx === undefined || spillIdx < 0) continue;
    body.push({ op: "local.get", index: 0 });
    body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.sentFieldIdx });
    body.push({ op: "local.set", index: localIdx });
    body.push({ op: "local.get", index: 0 });
    body.push({ op: "local.get", index: localIdx });
    body.push({ op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.spillFieldOffset + spillIdx });
  }

  for (const stmt of segment.statements) {
    compileStatement(ctx, fctx, stmt);
  }

  if (segment.yieldExpr) {
    const tmp = emitExpressionAsF64(ctx, fctx, segment.yieldExpr.expression);
    body.push(...storeSpills(info, fctx));
    body.push(...setState(info, yieldIndex + 1));
    body.push(...setMode(info, 0));
    body.push({ op: "local.get", index: tmp });
    body.push({ op: "i32.const", value: 0 });
    body.push({ op: "struct.new", typeIdx: info.resultTypeIdx });
  } else if (segment.returnStmt) {
    const tmp = emitExpressionAsF64(ctx, fctx, segment.returnStmt.expression);
    body.push(...storeSpills(info, fctx));
    body.push(...setState(info, info.doneState));
    body.push(...setMode(info, 0));
    body.push({ op: "local.get", index: tmp });
    body.push({ op: "i32.const", value: 1 });
    body.push({ op: "struct.new", typeIdx: info.resultTypeIdx });
  } else {
    body.push(...storeSpills(info, fctx));
    body.push(...setState(info, info.doneState));
    body.push(...setMode(info, 0));
    body.push(...emptyResult(info));
  }

  fctx.body = saved;
  return body;
}

function buildDispatch(info: NativeGeneratorInfo, cases: Instr[][], defaultBody: Instr[]): Instr[] {
  function caseAt(index: number): Instr[] {
    if (index >= cases.length) return defaultBody;
    const elseBody = caseAt(index + 1);
    return [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
      { op: "i32.const", value: index },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "ref", typeIdx: info.resultTypeIdx } },
        then: cases[index]!,
        else: elseBody,
      },
    ];
  }
  return caseAt(0);
}

export function ensureNativeGeneratorResumeFunction(ctx: CodegenContext, info: NativeGeneratorInfo): number {
  if (info.resumeFuncIdx !== undefined) return info.resumeFuncIdx;

  const fnName = `__gen_resume_${sanitizeTypeName(info.functionName)}`;
  const existing = ctx.funcMap.get(fnName);
  if (existing !== undefined) {
    info.resumeFuncIdx = existing;
    return existing;
  }

  const selfType: ValType = { kind: "ref", typeIdx: info.stateTypeIdx };
  const resultType: ValType = { kind: "ref", typeIdx: info.resultTypeIdx };
  const typeIdx = addFuncType(ctx, [selfType], [resultType], `${fnName}_type`);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  info.resumeFuncIdx = funcIdx;
  ctx.funcMap.set(fnName, funcIdx);

  const resumeFctx: FunctionContext = {
    name: fnName,
    params: [{ name: "__gen_self", type: selfType }],
    locals: [],
    localMap: new Map([["__gen_self", 0]]),
    returnType: resultType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  for (let i = 0; i < info.paramTypes.length; i++) {
    const localIdx = allocLocal(resumeFctx, info.paramNames[i]!, info.paramTypes[i]!);
    resumeFctx.body.push({ op: "local.get", index: 0 });
    resumeFctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.paramFieldOffset + i });
    resumeFctx.body.push({ op: "local.set", index: localIdx });
  }

  for (let i = 0; i < info.spillNames.length; i++) {
    const localIdx = allocLocal(resumeFctx, info.spillNames[i]!, { kind: "f64" });
    resumeFctx.body.push({ op: "local.get", index: 0 });
    resumeFctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.spillFieldOffset + i });
    resumeFctx.body.push({ op: "local.set", index: localIdx });
  }

  const plan = buildNativeGeneratorPlan(ctx, info.decl);
  if (!plan) {
    reportError(ctx, info.decl, "Internal error: native generator plan disappeared during emission");
    resumeFctx.body.push(...emptyResult(info));
  } else {
    const savedFunc = ctx.currentFunc;
    ctx.currentFunc = resumeFctx;
    try {
      let yieldIndex = 0;
      const cases = plan.segments.map((segment) => {
        const caseBody = compileSegment(ctx, resumeFctx, info, segment, yieldIndex);
        if (segment.yieldExpr) yieldIndex++;
        return caseBody;
      });
      const defaultBody = [...setState(info, info.doneState), ...emptyResult(info)];
      resumeFctx.body.push(...buildDispatch(info, cases, defaultBody));
    } finally {
      ctx.currentFunc = savedFunc;
    }
  }

  const fn: WasmFunction = {
    name: fnName,
    typeIdx,
    locals: resumeFctx.locals,
    body: resumeFctx.body,
    exported: false,
  };
  ctx.mod.functions.push(fn);
  return funcIdx;
}

export function compileNativeGeneratorFunction(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.FunctionDeclaration,
  info: NativeGeneratorInfo,
): void {
  ensureNativeGeneratorResumeFunction(ctx, info);
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "f64.const", value: NaN });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "f64.const", value: NaN });
  for (let i = 0; i < decl.parameters.length; i++) {
    fctx.body.push({ op: "local.get", index: i });
  }
  for (let i = 0; i < info.spillNames.length; i++) {
    fctx.body.push({ op: "f64.const", value: NaN });
  }
  fctx.body.push({ op: "struct.new", typeIdx: info.stateTypeIdx });
}

function nativeInfoForStateType(ctx: CodegenContext, typeIdx: number): NativeGeneratorInfo | undefined {
  for (const info of ctx.nativeGenerators.values()) {
    if (info.stateTypeIdx === typeIdx) return info;
  }
  return undefined;
}

function isNativeResultType(ctx: CodegenContext, type: ValType | null): boolean {
  return (
    !!type &&
    (type.kind === "ref" || type.kind === "ref_null") &&
    ctx.nativeGeneratorResultTypeIdx >= 0 &&
    type.typeIdx === ctx.nativeGeneratorResultTypeIdx
  );
}

function compileIgnoredArgs(ctx: CodegenContext, fctx: FunctionContext, args: readonly ts.Expression[]): void {
  for (const arg of args) {
    const argType = compileExpression(ctx, fctx, arg);
    if (argType !== null) fctx.body.push({ op: "drop" });
  }
}

function compileDirectNativeGeneratorMethod(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: NativeGeneratorInfo,
  receiverType: ValType,
  methodName: string,
  args: readonly ts.Expression[],
): ValType | null | undefined {
  if (methodName === "throw") return undefined;

  if (receiverType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" });
  }
  const selfLocal = allocLocal(fctx, `__native_gen_self_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: info.stateTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: selfLocal });

  if (methodName === "next") {
    const sentTmp = emitExpressionAsF64(ctx, fctx, args[0]);
    compileIgnoredArgs(ctx, fctx, args.slice(1));
    fctx.body.push(...setStateFieldFromLocal(info, selfLocal, info.sentFieldIdx, sentTmp));
    fctx.body.push(...setStateI32FromConst(info, selfLocal, info.modeFieldIdx, 0));
    fctx.body.push({ op: "local.get", index: selfLocal });
    fctx.body.push({ op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) });
    return { kind: "ref", typeIdx: info.resultTypeIdx };
  }

  if (methodName === "return") {
    const valueTmp = emitExpressionAsF64(ctx, fctx, args[0]);
    compileIgnoredArgs(ctx, fctx, args.slice(1));
    fctx.body.push({ op: "local.get", index: selfLocal });
    fctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: info.resultTypeIdx } },
      then: [
        ...setStateI32FromConst(info, selfLocal, STATE_FIELD, info.doneState),
        ...setStateI32FromConst(info, selfLocal, info.modeFieldIdx, 0),
        ...nativeReturnResultFromLocal(info, valueTmp),
      ],
      else: [
        { op: "local.get", index: selfLocal },
        { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
        { op: "i32.const", value: info.doneState },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "ref", typeIdx: info.resultTypeIdx } },
          then: [
            ...setStateI32FromConst(info, selfLocal, info.modeFieldIdx, 0),
            ...nativeReturnResultFromLocal(info, valueTmp),
          ],
          else: [
            ...setStateFieldFromLocal(info, selfLocal, info.abruptFieldIdx, valueTmp),
            ...setStateI32FromConst(info, selfLocal, info.modeFieldIdx, 1),
            { op: "local.get", index: selfLocal },
            { op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) },
          ],
        },
      ],
    });
    return { kind: "ref", typeIdx: info.resultTypeIdx };
  }

  return undefined;
}

function buildNativeGeneratorDispatch(
  ctx: CodegenContext,
  anyLocal: number,
  methodName: string,
  valueLocal?: number,
): Instr[] {
  const infos = Array.from(ctx.nativeGenerators.values());
  const resultType: ValType = { kind: "ref", typeIdx: ensureNativeGeneratorResultType(ctx) };
  const fallback: Instr[] = [
    { op: "f64.const", value: 0 },
    { op: "i32.const", value: 1 },
    { op: "struct.new", typeIdx: ctx.nativeGeneratorResultTypeIdx },
  ];

  function branch(index: number): Instr[] {
    if (index >= infos.length) return fallback;
    const info = infos[index]!;
    let thenBody: Instr[];
    if (methodName === "next") {
      thenBody = [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: info.stateTypeIdx },
        { op: "local.get", index: valueLocal! },
        { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.sentFieldIdx },
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: info.stateTypeIdx },
        { op: "i32.const", value: 0 },
        { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: info.stateTypeIdx },
        { op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) },
      ];
    } else {
      thenBody = [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: info.stateTypeIdx },
        { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
        { op: "i32.const", value: 0 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: resultType },
          then: [
            { op: "local.get", index: anyLocal },
            { op: "ref.cast", typeIdx: info.stateTypeIdx },
            { op: "i32.const", value: info.doneState },
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
            { op: "local.get", index: anyLocal },
            { op: "ref.cast", typeIdx: info.stateTypeIdx },
            { op: "i32.const", value: 0 },
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
            { op: "local.get", index: valueLocal! },
            { op: "i32.const", value: 1 },
            { op: "struct.new", typeIdx: info.resultTypeIdx },
          ],
          else: [
            { op: "local.get", index: anyLocal },
            { op: "ref.cast", typeIdx: info.stateTypeIdx },
            { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
            { op: "i32.const", value: info.doneState },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: resultType },
              then: [
                { op: "local.get", index: anyLocal },
                { op: "ref.cast", typeIdx: info.stateTypeIdx },
                { op: "i32.const", value: 0 },
                { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
                { op: "local.get", index: valueLocal! },
                { op: "i32.const", value: 1 },
                { op: "struct.new", typeIdx: info.resultTypeIdx },
              ],
              else: [
                { op: "local.get", index: anyLocal },
                { op: "ref.cast", typeIdx: info.stateTypeIdx },
                { op: "local.get", index: valueLocal! },
                { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.abruptFieldIdx },
                { op: "local.get", index: anyLocal },
                { op: "ref.cast", typeIdx: info.stateTypeIdx },
                { op: "i32.const", value: 1 },
                { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
                { op: "local.get", index: anyLocal },
                { op: "ref.cast", typeIdx: info.stateTypeIdx },
                { op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) },
              ],
            },
          ],
        },
      ];
    }
    return [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: info.stateTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: resultType },
        then: thenBody,
        else: branch(index + 1),
      },
    ];
  }
  return branch(0);
}

export function tryCompileNativeGeneratorMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverExpr: ts.Expression,
  methodName: string,
  args: readonly ts.Expression[],
): ValType | null | undefined {
  if (methodName !== "next" && methodName !== "return") return undefined;
  if (ctx.nativeGenerators.size === 0) return undefined;

  const receiverType = compileExpression(ctx, fctx, receiverExpr);
  if (receiverType && (receiverType.kind === "ref" || receiverType.kind === "ref_null")) {
    const info = nativeInfoForStateType(ctx, receiverType.typeIdx);
    if (info) {
      return compileDirectNativeGeneratorMethod(ctx, fctx, info, receiverType, methodName, args);
    }
  }

  if (receiverType?.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  } else if (!receiverType || (receiverType.kind !== "anyref" && receiverType.kind !== "eqref")) {
    if (receiverType !== null) fctx.body.push({ op: "drop" });
    compileIgnoredArgs(ctx, fctx, args);
    fctx.body.push(...emptyResultForType(ensureNativeGeneratorResultType(ctx)));
    return { kind: "ref", typeIdx: ctx.nativeGeneratorResultTypeIdx };
  }

  const anyLocal = allocLocal(fctx, `__native_gen_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyLocal });

  let valueLocal: number | undefined;
  if (methodName === "return" || methodName === "next") {
    valueLocal = emitExpressionAsF64(ctx, fctx, args[0]);
    compileIgnoredArgs(ctx, fctx, args.slice(1));
  }

  fctx.body.push(...buildNativeGeneratorDispatch(ctx, anyLocal, methodName, valueLocal));
  return { kind: "ref", typeIdx: ctx.nativeGeneratorResultTypeIdx };
}

export function tryCompileNativeGeneratorResultProperty(
  ctx: CodegenContext,
  fctx: FunctionContext,
  resultExpr: ts.Expression,
  propName: string,
): ValType | null | undefined {
  if (propName !== "value" && propName !== "done") return undefined;
  if (ctx.nativeGeneratorResultTypeIdx < 0) return undefined;

  const resultType = compileExpression(ctx, fctx, resultExpr);
  if (isNativeResultType(ctx, resultType)) {
    if (resultType?.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({
      op: "struct.get",
      typeIdx: ctx.nativeGeneratorResultTypeIdx,
      fieldIdx: propName === "value" ? RESULT_VALUE_FIELD : RESULT_DONE_FIELD,
    });
    return propName === "value" ? { kind: "f64" } : { kind: "i32" };
  }

  if (resultType?.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  } else if (!resultType || (resultType.kind !== "anyref" && resultType.kind !== "eqref")) {
    if (resultType !== null) fctx.body.push({ op: "drop" });
    fctx.body.push(propName === "value" ? { op: "f64.const", value: 0 } : { op: "i32.const", value: 1 });
    return propName === "value" ? { kind: "f64" } : { kind: "i32" };
  }

  const anyLocal = allocLocal(fctx, `__native_gen_result_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyLocal });
  const fieldType: ValType = propName === "value" ? { kind: "f64" } : { kind: "i32" };
  fctx.body.push({ op: "local.get", index: anyLocal });
  fctx.body.push({ op: "ref.test", typeIdx: ctx.nativeGeneratorResultTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: fieldType },
    then: [
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx: ctx.nativeGeneratorResultTypeIdx },
      {
        op: "struct.get",
        typeIdx: ctx.nativeGeneratorResultTypeIdx,
        fieldIdx: propName === "value" ? RESULT_VALUE_FIELD : RESULT_DONE_FIELD,
      },
    ],
    else: [propName === "value" ? { op: "f64.const", value: 0 } : { op: "i32.const", value: 1 }],
  });
  return fieldType;
}

/**
 * Look up a native-generator info by the **TS type** of a for-of subject
 * expression, mapping the resolved wasm state struct typeIdx back to its
 * NativeGeneratorInfo. Returns undefined when the subject is not a native
 * generator value.
 */
export function nativeGeneratorInfoForForOfSubject(
  ctx: CodegenContext,
  subjectType: ValType,
): NativeGeneratorInfo | undefined {
  if (subjectType.kind !== "ref" && subjectType.kind !== "ref_null") return undefined;
  return nativeInfoForStateType(ctx, subjectType.typeIdx);
}

/**
 * #1665 — drive a `for (… of gen())` loop over a Wasm-native generator state
 * machine WITHOUT the JS-host iterator protocol. The generator state ref is
 * expected to already be on the stack (the caller compiled the iterable
 * expression); `subjectType` is its ValType.
 *
 * Emits, structurally identical to the host iterator loop but calling the
 * generator's resume function directly:
 *
 *   iter = <subject>
 *   block:
 *     loop:
 *       res = __gen_resume_<g>(iter)        ;; ref $result {value:f64, done:i32}
 *       if (res.done) br block
 *       elem = res.value                    ;; f64 (or coerced to elem decl type)
 *       <body>
 *       br loop
 *
 * Only numeric (f64) yields are supported by the existing native generator
 * (`isNativeGeneratorCandidate`), so the loop variable is f64. Returns true on
 * success; false (with the stack untouched-by-contract: caller resets) when the
 * shape is unsupported so the caller can fall back.
 */
export function tryCompileNativeGeneratorForOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  subjectType: ValType,
  info: NativeGeneratorInfo,
): boolean {
  // for-await-of over a sync generator is not supported here.
  if (stmt.awaitModifier) return false;
  // Only plain identifier / simple binding loop variables in this slice;
  // destructuring over a numeric generator value is meaningless (f64 isn't
  // destructurable) and array/object patterns fall back.
  let loopVarName: string | undefined;
  let isConst = false;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    if (!ts.isIdentifier(decl.name)) return false;
    loopVarName = decl.name.text;
    isConst = !!(stmt.initializer.flags & ts.NodeFlags.Const);
  } else if (ts.isIdentifier(stmt.initializer)) {
    loopVarName = stmt.initializer.text;
  } else {
    return false;
  }

  // The caller only reaches here when nativeGeneratorInfoForForOfSubject
  // matched, i.e. subjectType is a ref/ref_null to the generator state struct.
  if (subjectType.kind !== "ref" && subjectType.kind !== "ref_null") return false;
  const subjectTypeIdx = subjectType.typeIdx;

  const resumeIdx = ensureNativeGeneratorResumeFunction(ctx, info);
  const resultRef: ValType = { kind: "ref", typeIdx: info.resultTypeIdx };

  // Stash the generator state ref (currently on stack) into a local typed as
  // the exact state struct (it always is; the static type may be ref_null).
  const iterLocal = allocLocal(fctx, `__nativegen_iter_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: info.stateTypeIdx,
  } as ValType);
  if (subjectType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" });
  }
  if (subjectTypeIdx !== info.stateTypeIdx) {
    fctx.body.push({ op: "ref.cast", typeIdx: info.stateTypeIdx });
  }
  fctx.body.push({ op: "local.set", index: iterLocal });

  const resultLocal = allocLocal(fctx, `__nativegen_res_${fctx.locals.length}`, resultRef);

  // Loop variable: f64 (the native result value type). const-ness recorded so
  // shadowing/TDZ logic downstream stays consistent.
  const elemLocal = allocLocal(fctx, loopVarName, { kind: "f64" });
  if (isConst) {
    if (!fctx.constBindings) fctx.constBindings = new Set();
    fctx.constBindings.add(loopVarName);
  }

  // block { loop { … } } — break = depth 1 (exit block), continue = depth 0.
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue/return/rethrow depths: block + loop add 2.
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 2;

  fctx.breakStack.push(1);
  fctx.continueStack.push(0);

  // res = resume(iter)
  fctx.body.push({ op: "local.get", index: iterLocal });
  if (subjectType.typeIdx !== info.stateTypeIdx) {
    fctx.body.push({ op: "ref.cast", typeIdx: info.stateTypeIdx });
  }
  fctx.body.push({ op: "call", funcIdx: resumeIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // if (res.done) br block (depth 1: exit loop+block ⇒ depth to block is 1)
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "struct.get", typeIdx: info.resultTypeIdx, fieldIdx: RESULT_DONE_FIELD });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "br", depth: 2 } as Instr], // if + loop = depth 2 to exit block
    else: [],
  });

  // elem = res.value
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "struct.get", typeIdx: info.resultTypeIdx, fieldIdx: RESULT_VALUE_FIELD });
  fctx.body.push({ op: "local.set", index: elemLocal });

  // body
  if (ts.isBlock(stmt.statement)) {
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  fctx.body.push({ op: "br", depth: 0 }); // continue loop

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore depths.
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 2;

  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      } as Instr,
    ],
  });
  return true;
}
