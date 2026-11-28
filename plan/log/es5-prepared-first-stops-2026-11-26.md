# ES5 Prepared path: first stops by owner (2026-11-26)

Where each of the 9,174 ES5 files stops on the Prepared whole-program path (`TEST262_COMPILER_PATH=ir`,
standalone, real harness), grouped into families. Each family is mapped to the lane or issue that owns it.
Purpose: show where the next lanes should go.

- **Tree:** main `c3b7be66` (merge of PR #7347, 2026-11-26 06:53 UTC).
- **Method:**
  - The census is `scripts/ir-census/prepared-census.mts --harness real` over
    `scripts/ir-census/es5-files.mts`.
  - Each `fail` row also gets its trap frame and the abort-body refusal behind it, the same join as open PR #7436.
    A trap counts under the refusal of the abort body it ran into.
  - Details are normalised: function names and slice numbers are dropped, then rows are grouped by family.
- **Totals:** pass 1,346; compile error 6,587; fail (trap) 777; timeout 5; crash 2; negative tests skipped 457.
  That leaves **7,371 files that do not pass.**
- Every non-passing file is counted once, by its first stop. A file behind two walls appears only under the first
  one, so a family's count is an upper bound on what fixing that family alone would gain.

## Families of 20 or more files

| family (first stop) | files | owner |
|---|---:|---|
| `String` / `Number` / `Boolean` as values and `new` | 1,103 | #7350 B3a (PR #7433) |
| `Array` as a value (830 of them `propertyHelper.js`'s `Array.isArray`) | 1,003 | Session B |
| `globalThis`, top-level and function `this`, receiver-less direct calls | 545 | Session B |
| `Object` as a value, class or call | 498 | Session B (Object statics) / #7350 |
| `eval`: statement, direct call, identifier | 474 | #7363 (PR #7432) |
| RegExp: literal, class, value | 467 | #7369 |
| array literals: element types, empty-array escape, elision, vec registration | 418 | Session B |
| nested `var` in module-init (for-in heads, `with` bodies) | 404 | Session B |
| **`Function`: `Function(…)`, `new Function`, `Function` as a value** | **288** | **unowned** |
| Annex B block functions (`f` not in scope, a FunctionDeclaration in a block) | 266 | S19 (#7372 slice 2) |
| undeclared names: reads, writes, compound writes | 166 | S10 (#7372 slice 3) |
| **string methods on a native string (`.trim` 56, `.indexOf` 11, …)** | **136** | **unowned** |
| **dynamic `+` with a string operand** | **133** | **unowned** |
| function members `.call` / `.apply` / `.bind` / `.caller` | 133 | S20 |
| **`Date` as a value or class** | **118** | **unowned** (built-in globals, #7350 family) |
| `delete` | 114 | S10 (#7372 slice 4) |
| compound assignment: right-hand-side carrier | 88 | #7375 (PR #7427) |
| nested function without annotations, closures | 74 | S21 (#7492, PR #7484) |
| **`JSON` as a value** | **70** | **unowned** (built-in globals, #7350 family) |
| `Math` as a value | 69 | Session B |
| **run-time kind abort `js.value.unsupported`** | **61** | **unowned** (proposal in `es5-prepared-census-2026-11-26.md`) |
| `arguments` | 54 | Session B |
| **`==` / `!=` / `&&` on operands of different types** | **43** | **unowned** |
| **relational operators on dynamic values (`__ir_dyn_le/lt/gt`, string compare)** | **42** | **unowned** |
| **prefix/postfix update in value position** | **33** | **unowned** |
| empty statement at a module-init closure's tail | 31 | S21 (#7492) |
| **`new` of a non-identifier constructor ("only direct constructor names")** | **31** | **unowned** |
| **bare `null` in a number or i32 context** | **30** | **unowned** |
| computed-key member read on a dynamic value | 26 | S3 (slice O) |
| **compound assignment to a property of a dynamic value** | **24** | **unowned** |
| **host/async demand outside the numeric presentation** (`Math` harness rows) | **20** | **unowned** |
| `with` | 16 | Session B |

About 400 more files fall into families of fewer than 20 each.

## Unowned, largest first

1. **`Function` (288):**
   - `Function(…)` / `new Function(…)`: 154 + 26, CreateDynamicFunction, so it needs the eval provider's parser
     (#7363);
   - `Function` read as a value: 79 + 15 trapping.
   - The value half belongs with #7350's built-in globals. The call half belongs with #7363.
2. **String methods on a native string (136):** "method call .trim(...) on string not in slice N" and its siblings.
   Native-string method calls that the Prepared path does not lower.
3. **Dynamic `+` with a string operand (133):** "'+' operands not provably both-number or string-concatenable".
   The safe dynamic `+` (`emitAnyAdd`) has no Prepared intrinsic.
4. **`Date` (118) and `JSON` (70):** built-in globals that #7350's slices have not reached yet.
5. **Operators on dynamic or mixed operands (115 in total):**
   - `==` / `!=` / `&&` across types: 43;
   - relational operators on dynamic values: 42;
   - `null` in a number context: 30.
   These are candidates for one "dynamic operators" slice.
6. **Run-time kind abort (61):** see the proposal in the census log of the same day.
7. **Smaller groups:** update expressions in value position (33), `new` of a non-identifier constructor (31), a
   compound write to a dynamic property (24).

## Reproduce

```bash
npx tsx scripts/ir-census/es5-files.mts --out .tmp/es5-files.txt
npx tsx scripts/ir-census/prepared-census.mts --files .tmp/es5-files.txt --out .tmp/prepared.jsonl --harness real
```

The trap-frame and abort-row join is in open PR #7436. The family regexes and the owner map are not checked in.
They are the table above.
