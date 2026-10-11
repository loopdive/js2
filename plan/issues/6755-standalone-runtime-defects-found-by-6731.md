---
id: 6755
title: "Standalone runtime defects found while writing #6731's fixtures: inlined `x.length` on an untyped string param, recursive `matchAll`, object-literal method returning nested-ternary arrays"
status: ready
sprint: current
created: 2026-09-29
updated: 2026-09-29
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone-mode
---

## Context

Found 2026-09-29 while reducing tailwindcss generators for
[#6731](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6731-native-generator-residual-shapes).
Each reproduces WITHOUT a generator on main `c8b4f0ef36`, `--target standalone`,
JS source (`allowJs`, untyped).

## Repros

1. **An inlined helper reading `.length` of an untyped string argument answers
   wrong.**
   ```js
   function ye(x){return x.length>0}
   function f(e){let h=e;return ye(h)?1:0}
   export function test(){return f("[a")}   // node 1, standalone 0
   ```
   The inlined body reads `h.length` through the generic externref property
   path and the comparison is false. `function f(e){let h=e;return h.length}`
   (not inlined) answers 2 correctly. The same shape hashing a string through
   `function h(s){…s.length…s.charCodeAt(q)…}` returns 0.
2. **Recursive `matchAll` throws.**
   ```js
   function Ii(i,d,out){out.push(1);if(d>1)return;for(let s of i.matchAll(/(\d+)/g))Ii(s[0],d+1,out)}
   export function test(){const o=[];Ii("1 2",0,o);return o.length}   // node 5, standalone throws
   ```
   Calling it twice sequentially (no recursion) works.
3. **An object-literal method returning nested-ternary arrays of objects throws
   when iterated.**
   ```js
   function G(e,i){const out=[];for(let r of e.params.split(/\s+/g))for(let t of i.parseCandidate(r))switch(t.kind){case"arbitrary":break;case"static":case"functional":out.push(t.root);break;default:}return out}
   export function test(){const ds={parseCandidate(r){return r==="x"?[{kind:"arbitrary",root:"A"}]:r==="y"?[{kind:"static",root:"Y"},{kind:"functional",root:"F"},{kind:"other",root:"O"}]:[{kind:"functional",root:r}]}};let s="";for(const x of G({params:"x  y z"},ds))s+=x+";";return s==="Y;F;z;"?1:0}
   ```
   node 1, standalone throws a `WebAssembly.Exception`.

## Acceptance

Each repro fixed (or split) with a regression test failing on its parent.
