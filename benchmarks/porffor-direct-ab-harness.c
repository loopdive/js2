// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <time.h>

#ifndef JS2_AB_ITERATIONS
#define JS2_AB_ITERATIONS 200000
#endif

void js2_ab_init(int argc, char **argv, void *stack_top);
double js2_ab_kernel(double seed);

static uint64_t js2_ab_process_cpu_ns(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &value) != 0) return UINT64_MAX;
  return (uint64_t)value.tv_sec * 1000000000ull + (uint64_t)value.tv_nsec;
}

static uint64_t js2_ab_monotonic_ns(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return UINT64_MAX;
  return (uint64_t)value.tv_sec * 1000000000ull + (uint64_t)value.tv_nsec;
}

static uint64_t js2_ab_peak_rss_bytes(void) {
  struct rusage usage;
  if (getrusage(RUSAGE_SELF, &usage) != 0) return UINT64_MAX;
#if defined(__APPLE__)
  return (uint64_t)usage.ru_maxrss;
#else
  return (uint64_t)usage.ru_maxrss * 1024ull;
#endif
}

int main(int argc, char **argv) {
  volatile int stack_anchor = 0;

  // Native cold is init + first call, matching the fresh-context/store lanes.
  if (argc == 3 && strcmp(argv[1], "--landing-once") == 0) {
    const uint64_t wall_started = js2_ab_monotonic_ns();
    const uint64_t cpu_started = js2_ab_process_cpu_ns();
    js2_ab_init(argc, argv, (void *)&stack_anchor);
    const double input = strtod(argv[2], NULL);
    const double output = js2_ab_kernel(input);
    const uint64_t cpu_finished = js2_ab_process_cpu_ns();
    const uint64_t wall_finished = js2_ab_monotonic_ns();
    if (wall_started == UINT64_MAX || wall_finished == UINT64_MAX || cpu_started == UINT64_MAX ||
        cpu_finished == UINT64_MAX)
      return 4;
    printf(
        "{\"output\":%.17g,\"runtimeWallNs\":%llu,\"runtimeCpuNs\":%llu,\"peakRssBytes\":%llu}\n",
        output, (unsigned long long)(wall_finished - wall_started), (unsigned long long)(cpu_finished - cpu_started),
        (unsigned long long)js2_ab_peak_rss_bytes());
    return 0;
  }

  // Keep warm, correctness-probe, and default #3482 timing behavior unchanged.
  js2_ab_init(argc, argv, (void *)&stack_anchor);

  // Mirror the landing V8 child: six in-process warmups followed by nine
  // individually timed calls. Return the median as one outer raw sample.
  if (argc == 3 && strcmp(argv[1], "--landing-warm") == 0) {
    const double input = strtod(argv[2], NULL);
    for (int index = 0; index < 6; index++) (void)js2_ab_kernel(input);
    uint64_t wall_samples[9];
    uint64_t cpu_samples[9];
    volatile double output = 0.0;
    for (int index = 0; index < 9; index++) {
      const uint64_t wall_started = js2_ab_monotonic_ns();
      const uint64_t cpu_started = js2_ab_process_cpu_ns();
      output = js2_ab_kernel(input);
      const uint64_t cpu_finished = js2_ab_process_cpu_ns();
      const uint64_t wall_finished = js2_ab_monotonic_ns();
      if (wall_started == UINT64_MAX || wall_finished == UINT64_MAX || cpu_started == UINT64_MAX ||
          cpu_finished == UINT64_MAX)
        return 5;
      wall_samples[index] = wall_finished - wall_started;
      cpu_samples[index] = cpu_finished - cpu_started;
    }
    for (int left = 1; left < 9; left++) {
      uint64_t wall_value = wall_samples[left];
      uint64_t cpu_value = cpu_samples[left];
      int right = left - 1;
      while (right >= 0 && wall_samples[right] > wall_value) {
        wall_samples[right + 1] = wall_samples[right];
        right--;
      }
      wall_samples[right + 1] = wall_value;
      right = left - 1;
      while (right >= 0 && cpu_samples[right] > cpu_value) {
        cpu_samples[right + 1] = cpu_samples[right];
        right--;
      }
      cpu_samples[right + 1] = cpu_value;
    }
    printf(
        "{\"output\":%.17g,\"medianWallNs\":%llu,\"medianCpuNs\":%llu,\"peakRssBytes\":%llu}\n",
        output, (unsigned long long)wall_samples[4], (unsigned long long)cpu_samples[4],
        (unsigned long long)js2_ab_peak_rss_bytes());
    return 0;
  }

  // #3498 reuses the exact #3482 ABI/harness object for correctness probes.
  // Arguments select four deterministic oracle inputs; the no-argument path
  // below remains byte-for-byte equivalent in behavior for #3482.
  if (argc == 6 && strcmp(argv[1], "--landing-probe") == 0) {
    const double input0 = strtod(argv[2], NULL);
    const double input1 = strtod(argv[3], NULL);
    const double input2 = strtod(argv[4], NULL);
    const double input3 = strtod(argv[5], NULL);
    printf(
        "{\"fixedOutputs\":[%.17g,%.17g,%.17g,%.17g],\"peakRssBytes\":%llu}\n",
        js2_ab_kernel(input0), js2_ab_kernel(input1), js2_ab_kernel(input2), js2_ab_kernel(input3),
        (unsigned long long)js2_ab_peak_rss_bytes());
    return 0;
  }

  const double fixed0 = js2_ab_kernel(-7.0);
  const double fixed1 = js2_ab_kernel(0.0);
  const double fixed2 = js2_ab_kernel(4.0);
  const double fixed3 = js2_ab_kernel(31.0);

  volatile double checksum = 0.0;
  const uint64_t started = js2_ab_process_cpu_ns();
  if (started == UINT64_MAX) return 2;
  for (int index = 0; index < JS2_AB_ITERATIONS; index++) {
    const double seed = (double)((index * 17) % 257 - 128);
    checksum += js2_ab_kernel(seed);
  }
  const uint64_t finished = js2_ab_process_cpu_ns();
  const uint64_t peak_rss = js2_ab_peak_rss_bytes();
  if (finished == UINT64_MAX || peak_rss == UINT64_MAX) return 3;

  printf(
      "{\"iterations\":%d,\"runtimeCpuNs\":%llu,\"peakRssBytes\":%llu,"
      "\"fixedOutputs\":[%.17g,%.17g,%.17g,%.17g],\"checksumDecimal\":\"%.17g\"}\n",
      JS2_AB_ITERATIONS, (unsigned long long)(finished - started), (unsigned long long)peak_rss, fixed0, fixed1,
      fixed2, fixed3, checksum);
  return 0;
}
