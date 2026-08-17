# js2wasm Benchmark Results

Date: 2026-08-17
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.048ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.034ms | gc-native |
| string/includes | 0.019ms | 0.111ms | 0.014ms | 0.065ms | gc-native |
| string/split | 0.411ms | 4.46ms | 0.506ms | FAILED | js |
| string/replace | 0.091ms | 0.223ms | 0.059ms | FAILED | gc-native |
| string/case-convert | 0.059ms | 0.234ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.941ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.341ms | 0.309ms | 0.554ms | gc-native |
| array/push-pop | 1.64ms | 0.600ms | 0.599ms | FAILED | gc-native |
| array/sort-i32 | 0.840ms | 0.416ms | 0.298ms | FAILED | gc-native |
| array/map-filter | 0.133ms | 0.065ms | 0.065ms | FAILED | host-call |
| array/reduce | 2.39ms | 0.600ms | 0.600ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.033ms | 0.016ms | 0.016ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.052ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.270ms | 0.015ms | 0.015ms | 1.21ms | gc-native |
| dom/create-elements | 0.038ms | 0.158ms | — | — | js |
| dom/set-attributes | 0.109ms | 0.536ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.134ms | — | — | js |
| dom/modify-text | 0.029ms | 0.112ms | — | — | js |
| mixed/csv-parse | 0.469ms | 6.96ms | 0.306ms | FAILED | gc-native |
| mixed/text-search | 0.392ms | 1.32ms | 0.293ms | 1.13ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.315ms | 0.315ms | 0.314ms | js |
| mixed/matrix-multiply | 0.184ms | 0.210ms | 0.210ms | 0.718ms | js |
| mixed/sieve | 1.78ms | 1.49ms | 1.54ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.27 | 4.84 | 4.24 | — |
| string/concat-long | 1000 | 4.29 | 4.98 | 3.44 | — |
| string/indexOf | 1000 | 18.97 | 59.63 | 12.25 | 33.80 |
| string/includes | 1000 | 18.67 | 111.07 | 13.88 | 65.31 |
| string/split | 10000 | 41.15 | 446.31 | 50.57 | — |
| string/replace | 1000 | 90.53 | 222.86 | 59.49 | — |
| string/case-convert | 2000 | 29.27 | 117.13 | 2.61 | — |
| string/substring | 10000 | 10.40 | 3.99 | 3.44 | — |
| string/trim | 10000 | 17.27 | 94.12 | 19.69 | — |
| string/startsWith-endsWith | 20000 | 20.63 | 17.07 | 15.43 | 27.69 |
| array/map-filter | 30000 | 4.44 | 2.17 | 2.18 | — |
| array/indexOf | 1000 | 4458.14 | 2861.92 | 2860.93 | — |
| dom/create-elements | 2000 | 19.13 | 78.95 | — | — |
| dom/set-attributes | 6000 | 18.11 | 89.29 | — | — |
| dom/read-attributes | 3000 | 19.45 | 44.83 | — | — |
| dom/modify-text | 2000 | 14.58 | 56.18 | — | — |
| mixed/csv-parse | 11000 | 42.63 | 632.92 | 27.80 | — |
| mixed/text-search | 40000 | 9.80 | 32.98 | 7.31 | 28.19 |
| mixed/fibonacci | 10000 | 12.53 | 31.50 | 31.51 | 31.40 |
| mixed/matrix-multiply | 125000 | 1.47 | 1.68 | 1.68 | 5.74 |
| mixed/sieve | 200000 | 8.89 | 7.47 | 7.69 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.29x slower | — |
| string/concat-long | 1.16x slower | 1.25x faster | — |
| string/indexOf | 3.14x slower | 1.55x faster | 1.78x slower |
| string/includes | 5.95x slower | 1.35x faster | 3.50x slower |
| string/split | 10.85x slower | 1.23x slower | — |
| string/replace | 2.46x slower | 1.52x faster | — |
| string/case-convert | 4.00x slower | 11.20x faster | — |
| string/substring | 2.61x faster | 3.02x faster | — |
| string/trim | 5.45x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.21x faster | 1.34x faster | 1.34x slower |
| array/push-pop | 2.74x faster | 2.74x faster | — |
| array/sort-i32 | 2.02x faster | 2.81x faster | — |
| array/map-filter | 2.05x faster | 2.04x faster | — |
| array/reduce | 3.98x faster | 3.98x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.11x faster | 2.03x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.81x faster | 1.81x faster | — |
| array/find | 18.34x faster | 18.47x faster | 4.47x slower |
| dom/create-elements | 4.13x slower | — | — |
| dom/set-attributes | 4.93x slower | — | — |
| dom/read-attributes | 2.30x slower | — | — |
| dom/modify-text | 3.85x slower | — | — |
| mixed/csv-parse | 14.85x slower | 1.53x faster | — |
| mixed/text-search | 3.37x slower | 1.34x faster | 2.88x slower |
| mixed/fibonacci | 2.51x slower | 2.51x slower | 2.51x slower |
| mixed/matrix-multiply | 1.14x slower | 1.14x slower | 3.90x slower |
| mixed/sieve | 1.19x faster | 1.15x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.45x faster |
| string/indexOf | 4.87x faster |
| string/includes | 8.00x faster |
| string/split | 8.83x faster |
| string/replace | 3.75x faster |
| string/case-convert | 44.82x faster |
| string/substring | 1.16x faster |
| string/trim | 4.78x faster |
| string/startsWith-endsWith | 1.11x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.39x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.04x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 22.77x faster |
| mixed/text-search | 4.51x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.03x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.6KB | 2.9KB | — |
| array/map-filter | 3.3KB | 3.7KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 2.9KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.6KB | 2.0KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1212.1ms | 1027.9ms | — |
| string/concat-long | 592.4ms | 916.1ms | — |
| string/indexOf | 630.0ms | 914.8ms | 803.9ms |
| string/includes | 624.3ms | 917.5ms | 794.1ms |
| string/split | 764.4ms | 913.9ms | — |
| string/replace | 755.3ms | 975.6ms | — |
| string/case-convert | 744.7ms | 814.5ms | — |
| string/substring | 625.7ms | 764.6ms | — |
| string/trim | 720.3ms | 900.6ms | — |
| string/startsWith-endsWith | 732.0ms | 921.7ms | 885.1ms |
| array/push-pop | 745.7ms | 805.2ms | — |
| array/sort-i32 | 859.0ms | 964.2ms | — |
| array/map-filter | 906.4ms | 954.0ms | — |
| array/reduce | 847.2ms | 882.8ms | — |
| array/indexOf | 822.3ms | 881.9ms | — |
| array/slice | 735.5ms | 833.2ms | — |
| array/reverse | 760.6ms | 810.6ms | — |
| array/forEach | 814.4ms | 929.1ms | — |
| array/find | 739.5ms | 806.4ms | 800.2ms |
| dom/create-elements | 576.2ms | — | — |
| dom/set-attributes | 668.8ms | — | — |
| dom/read-attributes | 684.8ms | — | — |
| dom/modify-text | 566.5ms | — | — |
| mixed/csv-parse | 757.2ms | 879.8ms | — |
| mixed/text-search | 765.0ms | 958.9ms | 871.2ms |
| mixed/fibonacci | 723.4ms | 738.3ms | 761.9ms |
| mixed/matrix-multiply | 829.0ms | 898.3ms | 755.5ms |
| mixed/sieve | 852.6ms | 867.6ms | — |
