# js2wasm Benchmark Results

Date: 2026-09-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.052ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.006ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.013ms | 0.017ms | gc-native |
| string/includes | 0.019ms | 0.113ms | 0.014ms | 0.035ms | gc-native |
| string/split | 0.420ms | 7.51ms | 2.58ms | FAILED | js |
| string/replace | 0.097ms | 0.759ms | 0.273ms | FAILED | js |
| string/case-convert | 0.058ms | 0.517ms | 0.232ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.31ms | 2.33ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.52ms | 2.45ms | 0.560ms | js |
| array/push-pop | 1.63ms | 0.599ms | 0.590ms | FAILED | gc-native |
| array/sort-i32 | 0.848ms | 0.561ms | 0.308ms | FAILED | gc-native |
| array/map-filter | 0.080ms | 0.066ms | 0.065ms | FAILED | gc-native |
| array/reduce | 2.36ms | 0.592ms | 0.591ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.033ms | 0.016ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.052ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.270ms | 0.015ms | 0.015ms | 1.11ms | gc-native |
| dom/create-elements | 0.057ms | 0.171ms | — | — | js |
| dom/set-attributes | 0.112ms | 0.549ms | — | — | js |
| dom/read-attributes | 0.061ms | 0.140ms | — | — | js |
| dom/modify-text | 0.031ms | 0.115ms | — | — | js |
| mixed/csv-parse | 0.467ms | 8.29ms | 0.555ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.09ms | 2.40ms | 1.12ms | js |
| mixed/fibonacci | 0.125ms | 0.328ms | 0.327ms | 0.325ms | js |
| mixed/matrix-multiply | 0.184ms | 62.31ms | 62.90ms | 0.717ms | js |
| mixed/sieve | 1.77ms | 2.30ms | 2.32ms | FAILED | js |

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
| string/concat-short | 10000 | 3.31 | 5.16 | 4.52 | — |
| string/concat-long | 1000 | 4.32 | 5.58 | 3.51 | — |
| string/indexOf | 1000 | 18.97 | 59.82 | 12.54 | 17.30 |
| string/includes | 1000 | 18.71 | 113.29 | 13.88 | 35.21 |
| string/split | 10000 | 42.04 | 751.04 | 258.24 | — |
| string/replace | 1000 | 97.16 | 758.67 | 272.86 | — |
| string/case-convert | 2000 | 29.13 | 258.45 | 116.09 | — |
| string/substring | 10000 | 10.40 | 4.00 | 3.43 | — |
| string/trim | 10000 | 17.30 | 331.27 | 233.39 | — |
| string/startsWith-endsWith | 20000 | 20.65 | 125.82 | 122.60 | 28.00 |
| array/map-filter | 30000 | 2.68 | 2.20 | 2.16 | — |
| array/indexOf | 1000 | 4455.59 | 2862.46 | 2862.45 | — |
| dom/create-elements | 2000 | 28.51 | 85.56 | — | — |
| dom/set-attributes | 6000 | 18.62 | 91.44 | — | — |
| dom/read-attributes | 3000 | 20.23 | 46.75 | — | — |
| dom/modify-text | 2000 | 15.65 | 57.74 | — | — |
| mixed/csv-parse | 11000 | 42.43 | 753.56 | 50.47 | — |
| mixed/text-search | 40000 | 10.07 | 102.23 | 60.06 | 28.07 |
| mixed/fibonacci | 10000 | 12.53 | 32.77 | 32.75 | 32.50 |
| mixed/matrix-multiply | 125000 | 1.48 | 498.50 | 503.21 | 5.74 |
| mixed/sieve | 200000 | 8.87 | 11.52 | 11.60 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.56x slower | 1.37x slower | — |
| string/concat-long | 1.29x slower | 1.23x faster | — |
| string/indexOf | 3.15x slower | 1.51x faster | 1.10x faster |
| string/includes | 6.05x slower | 1.35x faster | 1.88x slower |
| string/split | 17.87x slower | 6.14x slower | — |
| string/replace | 7.81x slower | 2.81x slower | — |
| string/case-convert | 8.87x slower | 3.99x slower | — |
| string/substring | 2.60x faster | 3.03x faster | — |
| string/trim | 19.15x slower | 13.49x slower | — |
| string/startsWith-endsWith | 6.09x slower | 5.94x slower | 1.36x slower |
| array/push-pop | 2.73x faster | 2.77x faster | — |
| array/sort-i32 | 1.51x faster | 2.75x faster | — |
| array/map-filter | 1.21x faster | 1.24x faster | — |
| array/reduce | 3.98x faster | 3.99x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.10x faster | 2.01x faster | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.81x faster | 1.81x faster | — |
| array/find | 18.34x faster | 18.54x faster | 4.12x slower |
| dom/create-elements | 3.00x slower | — | — |
| dom/set-attributes | 4.91x slower | — | — |
| dom/read-attributes | 2.31x slower | — | — |
| dom/modify-text | 3.69x slower | — | — |
| mixed/csv-parse | 17.76x slower | 1.19x slower | — |
| mixed/text-search | 10.15x slower | 5.96x slower | 2.79x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 337.81x slower | 341.00x slower | 3.89x slower |
| mixed/sieve | 1.30x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.59x faster |
| string/indexOf | 4.77x faster |
| string/includes | 8.16x faster |
| string/split | 2.91x faster |
| string/replace | 2.78x faster |
| string/case-convert | 2.23x faster |
| string/substring | 1.17x faster |
| string/trim | 1.42x faster |
| string/startsWith-endsWith | 1.03x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.82x faster |
| array/map-filter | 1.02x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.04x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 14.93x faster |
| mixed/text-search | 1.70x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.01x slower |

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
| array/indexOf | 1.8KB | 2.1KB | — |
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
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1574.4ms | 1019.5ms | — |
| string/concat-long | 736.8ms | 908.0ms | — |
| string/indexOf | 657.9ms | 922.2ms | 842.4ms |
| string/includes | 637.6ms | 934.7ms | 818.2ms |
| string/split | 728.7ms | 926.7ms | — |
| string/replace | 767.1ms | 1026.1ms | — |
| string/case-convert | 781.0ms | 889.3ms | — |
| string/substring | 668.5ms | 783.5ms | — |
| string/trim | 765.4ms | 945.0ms | — |
| string/startsWith-endsWith | 736.4ms | 956.4ms | 886.4ms |
| array/push-pop | 757.5ms | 814.3ms | — |
| array/sort-i32 | 925.5ms | 968.0ms | — |
| array/map-filter | 919.0ms | 993.5ms | — |
| array/reduce | 861.7ms | 947.5ms | — |
| array/indexOf | 854.8ms | 943.5ms | — |
| array/slice | 767.5ms | 858.9ms | — |
| array/reverse | 748.6ms | 876.9ms | — |
| array/forEach | 851.7ms | 937.2ms | — |
| array/find | 757.5ms | 848.9ms | 808.4ms |
| dom/create-elements | 726.0ms | — | — |
| dom/set-attributes | 706.3ms | — | — |
| dom/read-attributes | 702.6ms | — | — |
| dom/modify-text | 674.7ms | — | — |
| mixed/csv-parse | 797.6ms | 945.4ms | — |
| mixed/text-search | 771.5ms | 953.0ms | 869.9ms |
| mixed/fibonacci | 731.9ms | 774.4ms | 728.0ms |
| mixed/matrix-multiply | 865.8ms | 943.5ms | 782.5ms |
| mixed/sieve | 843.8ms | 898.8ms | — |
