# Native string type reservation checkpoint

Base: cf0026db2e926bf45c57204f6324fbae5fb168f7, scanner PR #5781.
Branch: codex/3518-native-string-types-split-20260909.
Verified upstream claim: 3518:native-string-types-split,
ttraenkler/codex-native-string-types-split.

## Implementation and purpose

Prepared-program emission must reserve typed imports before defined literal
globals and materializers. The split exposes an authenticated types-only pack
while retaining the old combined resource API and canonical allocation order.
One literal pack consumes a type pack, including empty requests. Dense input
validation precedes type allocation; complete canonical literal planning
precedes literal allocation. Failed supplied-pack preflight permits retry;
allocation failure does not promise rollback or another consumption.

Lookup, inventory, fill and completion authenticate the retained exact issued
type pack. The seven-line PhysicalModuleReservations.assertTypeReservation
addition is identical to sibling argument-vector commit
e3beb06321582908aba303fbcdf236d4c7a468c2 (PR #5776). Its #require call invokes
#verifyLayout; descriptor integrity is not delegated to a second authority.

The frozen inventory exposes exact ordered request bindings, all globals and
materializer functions, including private chunk globals and repeated chunk
references. Tokens are not cloned. Inventory is not a completion receipt.

## Validation and frozen revision

Initial core: TS7 exit 0; 41/41 focused controls passed. High then required
consume-once, full preflight, complete inventory and reauthentication controls.
Revised implementation: TS7 session 27896 exit 0; focused session 52306 exit 0,
54/54 tests across the split, existing string/Error resources and completion
suites. Runs were sequential, 2 GiB, one fork, no file parallelism.

Frozen SHA-256:

- native-string-literals.ts: 0150e77fca27c9503aa17ecf09d6e1596526d17b7dc59391cfcbfd16c1f45c49
- issue-3518-native-string-types-split.test.ts: 436f59d85c8a2a44f4d41f70780eff836a34697159a9a060d0a55dcc0387784a
- module-reservations.ts: 462143fec6e6b9c62bb86b869a6c806cf48768c05461fbb37e9056579746bbae

Final High and parent review found no blockers at these exact hashes. Existing
caller regressions passed 188/188 (61 flatten, 120 scanner, 7 value-chain),
session 51901 exit 0 in 55.79 seconds with one fork and a 2 GiB bound.
No external-root CLI was run for this split. Do not interpret these denominators as
coverage of actual prepared-consumer execution or public compilation cutover.

The first commit hook rejected the test's delete operator. Replacing it with
Reflect.deleteProperty preserves the actual array hole (now explicitly asserted).
The affected file passed 20/20 again, session 17996 exit 0; production and ledger
hashes remain unchanged. The test hash above is the corrected publication hash.

## Next production integration

Source admission and pure demand planning feed the same physical consumer,
with one reservation/freeze/fill transaction and one authoritative ABI map.
C and P explicitly released additive native integration in separate worktrees;
their paused async drafts remain preserved and excluded. Native execution
through the prepared consumer, public default cutover, complete native families,
strict closure and direct retirement remain required, unproven work.
