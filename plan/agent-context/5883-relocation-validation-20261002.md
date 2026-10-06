# PR5883 bounded flat-layout checkpoint

Base: published5b954c36e6c68ee5178a1d71780e8a836ce96746, including upstream
1a1608219cd357abe3df76da01fcc995274824de. Both remote tips reverified before
publication. Implementation plan:5883-flat-layout-repair-plan-20261002.md.

Parent authored plan/issue updates and ran acceptance. Sol-6.1 Medium agent D
implemented; two independent Sol-6.1 Medium agents reviewed production/import
preservation and the reciprocal source-reader receipt. No source-review blocker.

## Measured acceptance

- New controls:56/56, run57557 child30994, terminal0, unchanged pinned inputs.
- Existing runtime suites:104/104 across11 files, run61494 child31397,
  terminal0, unchanged pinned inputs. Same original programs/options/assertions.
- Historical readers:176/176 identities and statuses preserved,85pass91fail,
  before88642/26359 and after50180/31137. Both terminal1; failures not waived.
  Across84 changed stack strings, the only three distinct differences are
  promise-export-main-port coordinates96:13→95:13,124:22→123:22,
  133:39→132:39. First-error text and all other bytes match exactly.
- Gate batch24300 child31705: canonical typecheck, inventory-only, cycles,
  flat-directory, LOC, function-size, coercion and oracle all terminal0;
  pinned source/test/config inputs unchanged throughout.
- Flat directory829/829. Inventory1785: all original metadata unchanged;
  exactly3 path substitutions and3 move records. Complete-mode architecture
  check still exits1 and reports incomplete; inventory-only success is not
  retirement permission.
- Tracked-ignored gate passes after explicitly staging the evidence rename.
  Historical twelve-record archive retains all9516 bytes, SHA-256
  d9d792883c09853383845195ca9868ed97e506c6526b2434384c49a7f2d5f806.

The original three moved modules differ only in relative import specifiers;
five consumers and four original tests have import-only changes. No wrappers,
inventory promotion, baseline relaxation or fixture repinning. Existing LOC
grant follows the moved module; its allowance and rationale are unchanged.

Published-head downstream preflight retained every existing input;1396 new
dogfood package/report files are isolated generated artifacts. Five tsx IPC
permission failures are retained and exact reruns pass with the required
permission:IR fallbacks,hybrid IR-only,harness compile budget,stack balance,
codegen fallbacks. The tracked-ignored failure is repaired here by renaming,
not discarding, historical evidence. Those published-head runs do not certify
unexecuted downstream runtime/CI steps on this new checkpoint.

Exact compressed records accompany this file. Raw logs and before/after input
manifests remain in the owning worktree .tmp directories. No result here proves
full legacy/IR equivalence, resolves the91 historical failures, removes the hold,
or claims delivery to main. Protected-queue eligibility remains a separate check.
