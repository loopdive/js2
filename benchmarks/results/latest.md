# js2wasm Benchmark Results

Date: 2026-08-04
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.044ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.079ms | 0.021ms | FAILED | js |
| string/includes | 0.019ms | 0.161ms | 0.021ms | FAILED | js |
| string/split | 0.411ms | 5.69ms | 0.450ms | FAILED | js |
| string/replace | 0.107ms | 0.329ms | 0.082ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.260ms | 0.119ms | FAILED | js |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.930ms | 0.246ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.87ms | 0.286ms | FAILED | gc-native |
| array/push-pop | 1.45ms | 0.504ms | 0.502ms | FAILED | gc-native |
| array/sort-i32 | 0.790ms | 0.340ms | 0.333ms | FAILED | gc-native |
| array/map-filter | 0.131ms | 0.549ms | 0.548ms | FAILED | js |
| array/reduce | 2.14ms | 0.503ms | 0.501ms | FAILED | gc-native |
| array/indexOf | 3.94ms | 0.013ms | 0.013ms | FAILED | host-call |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.086ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.239ms | 0.017ms | 0.017ms | 1.08ms | host-call |
| dom/create-elements | 0.036ms | 0.278ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.396ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.170ms | — | — | js |
| dom/modify-text | 0.048ms | 0.160ms | — | — | js |
| mixed/csv-parse | 0.494ms | 8.75ms | 0.812ms | FAILED | js |
| mixed/text-search | 0.388ms | 2.51ms | 0.328ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.044ms | 0.044ms | 0.087ms | gc-native |
| mixed/matrix-multiply | 0.158ms | 0.193ms | 0.192ms | 0.718ms | js |
| mixed/sieve | 1.54ms | 1.39ms | 1.39ms | FAILED | gc-native |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/startsWith-endsWith | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 2.78 | 4.44 | 3.74 | — |
| string/concat-long | 1000 | 3.54 | 4.52 | 4.44 | — |
| string/indexOf | 1000 | 19.17 | 78.90 | 20.97 | — |
| string/includes | 1000 | 19.23 | 161.32 | 20.80 | — |
| string/split | 10000 | 41.11 | 568.58 | 44.98 | — |
| string/replace | 1000 | 106.76 | 328.62 | 82.48 | — |
| string/case-convert | 2000 | 29.00 | 130.16 | 59.73 | — |
| string/substring | 10000 | 9.86 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.00 | 92.97 | 24.64 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 143.60 | 14.32 | — |
| mixed/csv-parse | 11000 | 44.95 | 795.09 | 73.84 | — |
| mixed/text-search | 40000 | 9.70 | 62.71 | 8.20 | — |
| mixed/fibonacci | 10000 | 12.17 | 4.41 | 4.40 | 8.73 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.54 | 1.53 | 5.74 |
| mixed/sieve | 200000 | 7.72 | 6.94 | 6.93 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.60x slower | 1.34x slower | — |
| string/concat-long | 1.28x slower | 1.26x slower | — |
| string/indexOf | 4.12x slower | 1.09x slower | — |
| string/includes | 8.39x slower | 1.08x slower | — |
| string/split | 13.83x slower | 1.09x slower | — |
| string/replace | 3.08x slower | 1.29x faster | — |
| string/case-convert | 4.49x slower | 2.06x slower | — |
| string/substring | 2.62x faster | 3.21x faster | — |
| string/trim | 5.47x slower | 1.45x slower | — |
| string/startsWith-endsWith | 7.17x slower | 1.40x faster | — |
| array/push-pop | 2.87x faster | 2.89x faster | — |
| array/sort-i32 | 2.32x faster | 2.37x faster | — |
| array/map-filter | 4.20x slower | 4.20x slower | — |
| array/reduce | 4.25x faster | 4.26x faster | — |
| array/indexOf | 312.57x faster | 307.47x faster | — |
| array/slice | 1.08x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.08x faster | 3.09x faster | — |
| array/find | 14.07x faster | 14.02x faster | 4.51x slower |
| dom/create-elements | 7.82x slower | — | — |
| dom/set-attributes | 3.76x slower | — | — |
| dom/read-attributes | 3.15x slower | — | — |
| dom/modify-text | 3.35x slower | — | — |
| mixed/csv-parse | 17.69x slower | 1.64x slower | — |
| mixed/text-search | 6.46x slower | 1.18x faster | — |
| mixed/fibonacci | 2.76x faster | 2.77x faster | 1.39x faster |
| mixed/matrix-multiply | 1.22x slower | 1.21x slower | 4.54x slower |
| mixed/sieve | 1.11x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.19x faster |
| string/concat-long | 1.02x faster |
| string/indexOf | 3.76x faster |
| string/includes | 7.75x faster |
| string/split | 12.64x faster |
| string/replace | 3.98x faster |
| string/case-convert | 2.18x faster |
| string/substring | 1.23x faster |
| string/trim | 3.77x faster |
| string/startsWith-endsWith | 10.03x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.02x slower |
| array/slice | 1.02x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 10.77x faster |
| mixed/text-search | 7.65x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.00x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 401B | 1.3KB | — |
| string/includes | 388B | 1.3KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 4.0KB | — |
| string/case-convert | 1.6KB | 13.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.6KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 834B | 1.1KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 230B | — | — |
| dom/set-attributes | 497B | — | — |
| dom/read-attributes | 347B | — | — |
| dom/modify-text | 237B | — | — |
| mixed/csv-parse | 2.2KB | 4.8KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 235B | 235B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1319.6ms | 1124.0ms | — |
| string/concat-long | 632.1ms | 967.7ms | — |
| string/indexOf | 758.1ms | 984.0ms | — |
| string/includes | 751.6ms | 988.0ms | — |
| string/split | 761.4ms | 984.6ms | — |
| string/replace | 834.0ms | 1098.2ms | — |
| string/case-convert | 789.0ms | 1108.3ms | — |
| string/substring | 637.4ms | 755.0ms | — |
| string/trim | 728.5ms | 1044.7ms | — |
| string/startsWith-endsWith | 752.9ms | 976.6ms | — |
| array/push-pop | 773.4ms | 849.2ms | — |
| array/sort-i32 | 946.6ms | 992.6ms | — |
| array/map-filter | 896.4ms | 987.5ms | — |
| array/reduce | 802.7ms | 879.9ms | — |
| array/indexOf | 732.5ms | 795.8ms | — |
| array/slice | 753.9ms | 819.3ms | — |
| array/reverse | 752.4ms | 781.3ms | — |
| array/forEach | 832.1ms | 941.7ms | — |
| array/find | 736.0ms | 799.5ms | 832.8ms |
| dom/create-elements | 611.4ms | — | — |
| dom/set-attributes | 727.7ms | — | — |
| dom/read-attributes | 674.7ms | — | — |
| dom/modify-text | 740.1ms | — | — |
| mixed/csv-parse | 820.5ms | 1029.5ms | — |
| mixed/text-search | 732.6ms | 1038.6ms | — |
| mixed/fibonacci | 762.4ms | 811.4ms | 746.0ms |
| mixed/matrix-multiply | 846.3ms | 883.1ms | 779.1ms |
| mixed/sieve | 817.5ms | 873.8ms | — |
