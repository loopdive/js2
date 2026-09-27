# Closed-field preservation and wrapper extraction checkpoint

Data-only recovery for PR #5883; not a request to land incomplete runtime work.
All original failures, fixtures, and expectations remain. Old compiler
retirement is blocked until the complete new IR path is implemented/equivalent.

## Active source

Owned successor /private/tmp/js2-5883-main-sync-20260927,
branch codex/5883-main-sync-20260927, HEAD
a3c3d9fb1c2b8edae526bf7e89081d5f62d6dc9a plus unfinished owned changes.
This HEAD contains main456771a7cd. PR6181 subsequently landed as main
b922bce55dbb59ffd3793adc55f9dfe1fc269205; compare API returned identical.
Do not claim this still-dirty successor includes that later merge commit.

## Measured repair

Curie object-field v3 and Mendel class-field v4 were read in full (successive
revisions compared), checked for applicability, then applied atomically.
Existing bigint-field-carrier.ts was retained rather than duplicated.
Standard Prettier formatting followed; no behavior adjustments after that.
Patches here reproduce pre-format source. Their tests remain complete.

- Source TypeScript 7: session68633 exit0.
- Checker-query ratchet: session18856 exit0, net queries -2/-2, no allowance.
- Baseline44: session85592, 29/44 pass; compile and zero imports44/44.
- Class baseline14: session65717, 2/14 pass.
- Candidate86246: 68 cases =58 runtime +10 pure helper tests.
  Runtime41/58 versus31/58 baseline, ten gains, zero pass losses.
  Helper tests10/10. Overall51/68; exit1 correctly preserves17 failures.
- Exact58 source hashes match. All58 compile and instantiate with zero imports.
- Gains: two raw wide-field observations, direct closed-field write,
  descriptor value, and all six initialized/uninitialized/inherited class
  field cases (O0/O2).
- Remaining17: nine wide valueOf/wrapper cases, two observable method routing
  cases, four parameter-property cases and two wide explicit-constructor-store
  cases. Each has the same actual result as baseline; none was excluded.

Full row records and log hashes are in closed-field-pair.json. Logs and WAT
remain in the active successor .tmp directory. Native TS execution transpiles
parameter-property syntax; the compiler input remains the original TS source.

## Exact wrapper extraction

Moved the existing Symbol/BigInt wrapper arms from proto-index-store into a
small read-only emitter. No type/provider registration, narrowing, or shared
instruction identities. Missing carriers still emit no arm.

Five exact-instruction tests plus typecheck20444 passed. Runtime47429 against
85592 preserved all44 source hashes/results/import lists,29pass15fail, and all
five raw-output binary hashes. See wrapper-extraction-pair.json.
The file-size gate72027 no longer lists proto-index-store. It still rejected
vec-overlay+30, assignment+12 and index+8 before the subsequent field patches.
Those later patches have not yet been budget-certified. No limits were raised.

## Queue and continuing work

PR6181 protected conformance36295793335 completedsuccess; its merge was verified
on main. PR6182 was green, with zero unresolved review threads, at queue2
behind6178. Confirmed live next group688eb4de4184a6f8db74ff1ed73ab9612289e99c
has conformance36296818870; watcher27414. Queued heads were not refreshed.

Huygens continues independent captured-drain/.from readiness implementation.
Hume specifies producer-preserved TypedArray identity closure.
Russell is fixing the isolated editor's construction-token ownership hole;
no staging production wiring is authorized by this checkpoint.
Curie and Mendel prepare remaining source/fixture closure, including explicit
native overrides and parameter-property versus callable-ABI boundaries.
Singer's tool-blocked diagnostic remains blocked; no alternate-route retry.

Next acceptance requires broader unchanged fixture coverage, explicit-native
and host controls, producer/default/spread closure, and all source-quality
gates. The runtime gains above are real but do not prove full IR equivalence.
