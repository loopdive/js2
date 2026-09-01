# js2wasm Benchmark Results

Date: 2026-08-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.052ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.033ms | gc-native |
| string/includes | 0.019ms | 0.103ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.433ms | 7.55ms | 2.53ms | FAILED | js |
| string/replace | 0.093ms | 0.565ms | 0.272ms | FAILED | js |
| string/case-convert | 0.059ms | 0.513ms | 0.231ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.25ms | 2.32ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.41ms | 2.47ms | 0.566ms | js |
| array/push-pop | 1.67ms | 0.604ms | 0.599ms | FAILED | gc-native |
| array/sort-i32 | 0.851ms | 0.305ms | 0.295ms | FAILED | gc-native |
| array/map-filter | 0.135ms | 0.066ms | 0.066ms | FAILED | gc-native |
| array/reduce | 2.38ms | 0.604ms | 0.602ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.038ms | 0.018ms | 0.016ms | FAILED | gc-native |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.053ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.040ms | 0.155ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.515ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.136ms | — | — | js |
| dom/modify-text | 0.030ms | 0.115ms | — | — | js |
| mixed/csv-parse | 0.487ms | 8.16ms | 0.540ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.15ms | 2.38ms | 1.11ms | js |
| mixed/fibonacci | 0.125ms | 0.328ms | 0.328ms | 0.326ms | js |
| mixed/matrix-multiply | 0.185ms | 62.23ms | 64.52ms | 0.722ms | js |
| mixed/sieve | 1.80ms | 2.32ms | 2.28ms | FAILED | js |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | warmup | memory access out of bounds |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.37 | 5.17 | 4.48 | — |
| string/concat-long | 1000 | 4.22 | 5.37 | 3.32 | — |
| string/indexOf | 1000 | 18.95 | 60.43 | 12.24 | 33.03 |
| string/includes | 1000 | 18.67 | 102.78 | 13.85 | 16.89 |
| string/split | 10000 | 43.33 | 754.86 | 253.31 | — |
| string/replace | 1000 | 93.04 | 564.65 | 271.91 | — |
| string/case-convert | 2000 | 29.43 | 256.35 | 115.56 | — |
| string/substring | 10000 | 10.42 | 3.99 | 3.44 | — |
| string/trim | 10000 | 17.33 | 325.23 | 231.70 | — |
| string/startsWith-endsWith | 20000 | 20.65 | 120.65 | 123.41 | 28.31 |
| array/map-filter | 30000 | 4.51 | 2.19 | 2.19 | — |
| array/indexOf | 1000 | 4458.68 | 2863.05 | 2861.40 | — |
| dom/create-elements | 2000 | 19.76 | 77.40 | — | — |
| dom/set-attributes | 6000 | 18.04 | 85.83 | — | — |
| dom/read-attributes | 3000 | 19.54 | 45.24 | — | — |
| dom/modify-text | 2000 | 15.17 | 57.32 | — | — |
| mixed/csv-parse | 11000 | 44.28 | 741.91 | 49.07 | — |
| mixed/text-search | 40000 | 10.07 | 103.80 | 59.41 | 27.69 |
| mixed/fibonacci | 10000 | 12.54 | 32.76 | 32.77 | 32.61 |
| mixed/matrix-multiply | 125000 | 1.48 | 497.87 | 516.16 | 5.77 |
| mixed/sieve | 200000 | 9.00 | 11.59 | 11.42 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.53x slower | 1.33x slower | — |
| string/concat-long | 1.27x slower | 1.27x faster | — |
| string/indexOf | 3.19x slower | 1.55x faster | 1.74x slower |
| string/includes | 5.51x slower | 1.35x faster | 1.11x faster |
| string/split | 17.42x slower | 5.85x slower | — |
| string/replace | 6.07x slower | 2.92x slower | — |
| string/case-convert | 8.71x slower | 3.93x slower | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 18.76x slower | 13.37x slower | — |
| string/startsWith-endsWith | 5.84x slower | 5.98x slower | 1.37x slower |
| array/push-pop | 2.76x faster | 2.78x faster | — |
| array/sort-i32 | 2.79x faster | 2.88x faster | — |
| array/map-filter | 2.06x faster | 2.06x faster | — |
| array/reduce | 3.95x faster | 3.96x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.09x faster | 2.35x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.83x faster | 1.83x faster | — |
| array/find | 18.48x faster | 18.38x faster | 4.45x slower |
| dom/create-elements | 3.92x slower | — | — |
| dom/set-attributes | 4.76x slower | — | — |
| dom/read-attributes | 2.32x slower | — | — |
| dom/modify-text | 3.78x slower | — | — |
| mixed/csv-parse | 16.75x slower | 1.11x slower | — |
| mixed/text-search | 10.31x slower | 5.90x slower | 2.75x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 336.22x slower | 348.57x slower | 3.90x slower |
| mixed/sieve | 1.29x slower | 1.27x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 1.62x faster |
| string/indexOf | 4.94x faster |
| string/includes | 7.42x faster |
| string/split | 2.98x faster |
| string/replace | 2.08x faster |
| string/case-convert | 2.22x faster |
| string/substring | 1.16x faster |
| string/trim | 1.40x faster |
| string/startsWith-endsWith | 1.02x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.03x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.12x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 15.12x faster |
| mixed/text-search | 1.75x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.04x slower |
| mixed/sieve | 1.02x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.4KB | 3.0KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1716.8ms | 1075.4ms | — |
| string/concat-long | 763.3ms | 978.1ms | — |
| string/indexOf | 686.0ms | 973.5ms | 838.8ms |
| string/includes | 685.8ms | 989.5ms | 847.0ms |
| string/split | 767.8ms | 958.8ms | — |
| string/replace | 777.4ms | 1135.1ms | — |
| string/case-convert | 765.3ms | 875.5ms | — |
| string/substring | 674.0ms | 781.0ms | — |
| string/trim | 758.7ms | 973.0ms | — |
| string/startsWith-endsWith | 754.5ms | 963.5ms | 900.9ms |
| array/push-pop | 775.0ms | 859.3ms | — |
| array/sort-i32 | 941.9ms | 975.9ms | — |
| array/map-filter | 950.1ms | 1008.1ms | — |
| array/reduce | 851.3ms | 954.0ms | — |
| array/indexOf | 845.7ms | 962.9ms | — |
| array/slice | 802.3ms | 871.9ms | — |
| array/reverse | 774.8ms | 866.8ms | — |
| array/forEach | 867.0ms | 1004.3ms | — |
| array/find | 767.1ms | 844.4ms | 812.4ms |
| dom/create-elements | 690.9ms | — | — |
| dom/set-attributes | 715.2ms | — | — |
| dom/read-attributes | 703.2ms | — | — |
| dom/modify-text | 706.5ms | — | — |
| mixed/csv-parse | 829.2ms | 984.1ms | — |
| mixed/text-search | 787.7ms | 1002.8ms | 921.3ms |
| mixed/fibonacci | 717.9ms | 797.5ms | 762.4ms |
| mixed/matrix-multiply | 905.2ms | 967.3ms | 788.7ms |
| mixed/sieve | 854.4ms | 913.1ms | — |
