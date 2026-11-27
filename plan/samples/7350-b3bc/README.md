# #7350 B3bc measurement inputs

Inputs of the B3bc yield measurement (`plan/issues/7350-ir-builtin-globals-foundation.md`, "Implementation Plan —
B3bc"). Paths are test262 paths under `test/`, without the `test/` prefix.

| file | rows | what |
| --- | ---: | --- |
| `carriers.txt` | 1,977 | every ES5 file whose source names `String`, `Number` or `Boolean` |
| `walls-728.txt` | 728 | the carriers whose first stop on B3a (`1770ed68f3`) is a B3bc wall |
| `l420.txt` | 420 | B3's sample: the first 420 files of `es5-files.mts` (seed 7106) |
| `../7354-o411.txt` | 411 | #7354's shared sample, from `b1a7c75a16` (`origin/claude/7354-o411-sample`); it has the `test/` prefix |
| `stub.patch` | | the stand-in for B3bc on B3a; never to merge |

## The stub

`stub.patch` applies to B3a `1770ed68f3` (`git apply`). Every hunk is marked `B3BC-STUB`. It:

- makes `new X(v)` convert its argument and answer either a fresh ordinary object (`B3BC_STUB=object`) or the
  converted primitive (`B3BC_STUB=primitive`, the default);
- stops `identityOnlyKeyRefusal` from refusing (hook `static-key:X.k`; the kernel's identity mark still traps);
- stops a primitive's read of a wrapper-owned key from refusing; its arm is the run-time abort (hook
  `prim-read:kind.k`, fired at compile time wherever the receiver may be such a primitive);
- stops a JavaScript expando statement from making a name non-lib-only (`module-bindings.ts`, hook `expando`);
- keeps refusing what B3bc will still refuse: `STUB-B3D method call .m` (a wrapper method without an algorithm, once
  a hook fired), `STUB-B3D static call X.m` (a static other than Object.prototype's methods), `STUB-G4 .call` /
  `.apply` / `.bind` read off a wrapper constructor or its prototype's method;
- adds a `hooks` array to every census row.

It is a reconstruction: the original scratch trees were lost. Re-run on `walls-728.txt`, it reproduces every
original verdict and detail in both builds (plan, "Measured").

## Commands

One tree per head, with the test262 checkout under `test262/` (a symlink, never committed):

```bash
git worktree add --detach /tmp/b3bc-<head> <sha>     # main c3b7be667a, B3a 1770ed68f3
cd /tmp/b3bc-<head> && ln -s <test262 checkout> test262
# stub trees only, on B3a:
git apply <this repo>/plan/samples/7350-b3bc/stub.patch
sed 's|^test/||' plan/samples/7354-o411.txt > /tmp/o411-files.txt
```

Per list (`carriers.txt`, `walls-728.txt`, `l420.txt`, `/tmp/o411-files.txt`) and head:

```bash
npx tsx scripts/ir-census/prepared-census.mts --files <list> --out <head>-<list>.jsonl --harness real --jobs 3
B3BC_STUB=primitive npx tsx scripts/ir-census/prepared-census.mts --files <list> --out stub-<list>.jsonl --harness real --jobs 3
B3BC_STUB=object    npx tsx scripts/ir-census/prepared-census.mts --files <list> --out obj-<list>.jsonl  --harness real --jobs 3
```

The census resumes into an existing `--out` file: delete it before a fresh run. It skips negative tests, so its pass
counts are not the runner's (`7354-o411`'s runner command is in `README-7354-o411.md` on the o411 branch).
