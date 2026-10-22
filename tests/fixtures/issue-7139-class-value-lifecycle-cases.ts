// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Native class-value semantic controls: source bindings are not fixed constructor singletons. */
export const classValueLifecycleCases = [
  {
    name: "getter",
    source: "class C{} export function read():any{return C;} export function run():number{return read()===C?1:0;}",
    expected: 1,
  },
  {
    name: "sameLayout",
    source:
      "class C{}class D{}export function readC():any{return C;}export function readD():any{return D;}export function run():number{return readC()===readD()?1:0;}",
    expected: 0,
  },
  { name: "alias", source: "class C{}export function run():number{const K:any=C;return K===C?1:0;}", expected: 1 },
  {
    name: "argument",
    source: "class C{}function same(K:any):boolean{return K===C;}export function run():number{return same(C)?1:0;}",
    expected: 1,
  },
  {
    name: "forwarding",
    source:
      "class C{}function read():any{return C;}function relay():any{return read();}export function run():number{return relay()===C?1:0;}",
    expected: 1,
  },
  {
    name: "inferred",
    source: "class C{}function read(){return C;}export function run():number{return read()===C?1:0;}",
    expected: 1,
  },
  {
    name: "effects",
    source:
      "class C{m():number{return 3;}}let count=0;function left():C{count=count*10+1;return new C();}function right(){count=count*10+2;return C;}export function run():number{return(left() instanceof right()?100:0)+count;}",
    expected: 112,
  },
  {
    name: "nestedFresh",
    source: "function make():any{class C{}return C;}export function run():number{return make()===make()?1:0;}",
    expected: 0,
  },
  {
    name: "capturedFresh",
    source:
      "function make(n:number):any{class C{m():number{return n;}}return C;}export function run():number{return make(1)===make(2)?1:0;}",
    expected: 0,
  },
  {
    name: "namedExpression",
    source: "class C{}const D=class C{};export function run():number{return C===D?1:0;}",
    expected: 0,
  },
  {
    name: "shadow",
    source: "class C{}export function read(C:any):any{return C;}export function run():number{return read(7)===7?1:0;}",
    expected: 1,
  },
  {
    name: "beforeDeclaration",
    source:
      "let result=0;try{read();result=10;}catch(e){result=e instanceof ReferenceError?1:2;}class C{}function read():any{return C;}export function run():number{return result;}",
    expected: 1,
  },
  {
    name: "afterDeclaration",
    source:
      "class C{}let result=0;try{result=read()===C?1:0;}catch(e){result=2;}function read():any{return C;}export function run():number{return result;}",
    expected: 1,
  },
  {
    name: "reassignment",
    source:
      "class C{}function read():any{return C;}export function run():number{const old=read();C=class D{};return read()===old?10:1;}",
    expected: 1,
  },
  {
    name: "nullAssignment",
    source:
      "class C{}function read():any{return C;}export function run():number{C=null as any;return read()===null?1:0;}",
    expected: 1,
  },
  {
    name: "prototypeIdentity",
    source:
      "class C{}function read():any{return C;}export function run():number{return read().prototype===C.prototype?1:0;}",
    expected: 1,
  },
] as const;
