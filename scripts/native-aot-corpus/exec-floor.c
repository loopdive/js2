/* #4544 Part A — the exec floor.
 *
 * The cheapest possible process: fork/exec, dynamic loader, libc start, exit.
 * Every lane in this benchmark pays this, plus the harness's own spawn cost,
 * so it is what `aboveFloorMs` subtracts.
 *
 * WHY NOT `/bin/true`: that was the first choice and it was wrong. GNU
 * coreutils binaries do real startup work — `set_program_name`, `setlocale`,
 * `bindtextdomain` — worth a consistent ~0.5 ms here. Using it as the floor
 * made the two genuinely-floor-speed lanes come out with NEGATIVE excess, which
 * is impossible and is the tell that the floor itself was too expensive.
 */
int main(void) { return 0; }
