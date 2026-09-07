# js2wasm Benchmark Results

Date: 2026-09-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.029ms | 0.047ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.150ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.425ms | 8.17ms | 2.84ms | FAILED | js |
| string/replace | 0.104ms | 0.733ms | 0.327ms | FAILED | js |
| string/case-convert | 0.057ms | 0.571ms | 0.256ms | FAILED | js |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.90ms | 2.69ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.76ms | 2.84ms | 0.560ms | js |
| array/push-pop | 1.40ms | 0.500ms | 0.501ms | FAILED | host-call |
| array/sort-i32 | 0.790ms | 0.294ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.129ms | 0.070ms | 0.070ms | FAILED | host-call |
| array/reduce | 2.13ms | 0.500ms | 0.501ms | FAILED | host-call |
| array/indexOf | 3.96ms | 2.65ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.024ms | 0.026ms | 0.026ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.041ms | 0.164ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.548ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.122ms | — | — | js |
| dom/modify-text | 0.028ms | 0.107ms | — | — | js |
| mixed/csv-parse | 0.474ms | 8.48ms | 0.597ms | FAILED | js |
| mixed/text-search | 0.388ms | 4.91ms | 2.71ms | 1.10ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 1.32ms | js |
| mixed/matrix-multiply | 0.157ms | 72.92ms | 76.15ms | 0.716ms | js |
| mixed/sieve | 1.60ms | 2.11ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 2.85 | 4.67 | 4.32 | — |
| string/concat-long | 1000 | 3.51 | 4.42 | 3.57 | — |
| string/indexOf | 1000 | 19.35 | 66.02 | 12.39 | 15.15 |
| string/includes | 1000 | 19.17 | 149.95 | 14.70 | 15.95 |
| string/split | 10000 | 42.46 | 816.56 | 283.68 | — |
| string/replace | 1000 | 103.65 | 733.07 | 327.18 | — |
| string/case-convert | 2000 | 28.43 | 285.66 | 128.07 | — |
| string/substring | 10000 | 9.83 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.95 | 389.58 | 269.00 | — |
| string/startsWith-endsWith | 20000 | 20.06 | 137.98 | 142.17 | 28.02 |
| array/map-filter | 30000 | 4.29 | 2.32 | 2.34 | — |
| array/indexOf | 1000 | 3956.10 | 2645.15 | 2642.82 | — |
| dom/create-elements | 2000 | 20.75 | 82.24 | — | — |
| dom/set-attributes | 6000 | 17.31 | 91.25 | — | — |
| dom/read-attributes | 3000 | 18.27 | 40.60 | — | — |
| dom/modify-text | 2000 | 14.23 | 53.67 | — | — |
| mixed/csv-parse | 11000 | 43.12 | 770.77 | 54.30 | — |
| mixed/text-search | 40000 | 9.71 | 122.83 | 67.77 | 27.44 |
| mixed/fibonacci | 10000 | 12.18 | 28.31 | 28.32 | 132.40 |
| mixed/matrix-multiply | 125000 | 1.26 | 583.36 | 609.22 | 5.73 |
| mixed/sieve | 200000 | 8.01 | 10.57 | 10.54 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.64x slower | 1.51x slower | — |
| string/concat-long | 1.26x slower | 1.02x slower | — |
| string/indexOf | 3.41x slower | 1.56x faster | 1.28x faster |
| string/includes | 7.82x slower | 1.30x faster | 1.20x faster |
| string/split | 19.23x slower | 6.68x slower | — |
| string/replace | 7.07x slower | 3.16x slower | — |
| string/case-convert | 10.05x slower | 4.50x slower | — |
| string/substring | 2.63x faster | 3.20x faster | — |
| string/trim | 22.98x slower | 15.87x slower | — |
| string/startsWith-endsWith | 6.88x slower | 7.09x slower | 1.40x slower |
| array/push-pop | 2.79x faster | 2.79x faster | — |
| array/sort-i32 | 2.69x faster | 2.70x faster | — |
| array/map-filter | 1.85x faster | 1.84x faster | — |
| array/reduce | 4.25x faster | 4.25x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.71x faster | 1.73x faster | — |
| array/find | 15.88x faster | 16.16x faster | 4.22x slower |
| dom/create-elements | 3.96x slower | — | — |
| dom/set-attributes | 5.27x slower | — | — |
| dom/read-attributes | 2.22x slower | — | — |
| dom/modify-text | 3.77x slower | — | — |
| mixed/csv-parse | 17.87x slower | 1.26x slower | — |
| mixed/text-search | 12.65x slower | 6.98x slower | 2.83x slower |
| mixed/fibonacci | 2.32x slower | 2.33x slower | 10.87x slower |
| mixed/matrix-multiply | 463.61x slower | 484.16x slower | 4.55x slower |
| mixed/sieve | 1.32x slower | 1.32x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x faster |
| string/concat-long | 1.24x faster |
| string/indexOf | 5.33x faster |
| string/includes | 10.20x faster |
| string/split | 2.88x faster |
| string/replace | 2.24x faster |
| string/case-convert | 2.23x faster |
| string/substring | 1.22x faster |
| string/trim | 1.45x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.02x faster |
| mixed/csv-parse | 14.20x faster |
| mixed/text-search | 1.81x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.04x slower |
| mixed/sieve | 1.00x faster |

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
| array/sort-i32 | 2.7KB | 3.2KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 999B | 1.3KB | — |
| array/reverse | 977B | 1.3KB | — |
| array/forEach | 2.8KB | 3.3KB | — |
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
| string/concat-short | 1652.0ms | 1063.4ms | — |
| string/concat-long | 738.1ms | 976.6ms | — |
| string/indexOf | 688.0ms | 965.0ms | 870.6ms |
| string/includes | 669.6ms | 969.8ms | 832.3ms |
| string/split | 757.7ms | 951.7ms | — |
| string/replace | 798.9ms | 1036.4ms | — |
| string/case-convert | 793.0ms | 855.9ms | — |
| string/substring | 655.8ms | 795.1ms | — |
| string/trim | 752.1ms | 966.6ms | — |
| string/startsWith-endsWith | 761.8ms | 980.6ms | 901.5ms |
| array/push-pop | 772.2ms | 841.9ms | — |
| array/sort-i32 | 928.9ms | 986.7ms | — |
| array/map-filter | 939.4ms | 983.8ms | — |
| array/reduce | 874.6ms | 931.8ms | — |
| array/indexOf | 855.1ms | 956.4ms | — |
| array/slice | 793.9ms | 888.8ms | — |
| array/reverse | 782.4ms | 848.4ms | — |
| array/forEach | 936.3ms | 1020.7ms | — |
| array/find | 765.5ms | 870.9ms | 825.9ms |
| dom/create-elements | 690.1ms | — | — |
| dom/set-attributes | 704.3ms | — | — |
| dom/read-attributes | 690.0ms | — | — |
| dom/modify-text | 682.0ms | — | — |
| mixed/csv-parse | 808.5ms | 944.1ms | — |
| mixed/text-search | 772.4ms | 961.3ms | 890.1ms |
| mixed/fibonacci | 738.1ms | 774.2ms | 756.0ms |
| mixed/matrix-multiply | 932.0ms | 956.1ms | 807.7ms |
| mixed/sieve | 871.5ms | 949.5ms | — |
