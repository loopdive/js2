# js2wasm Benchmark Results

Date: 2026-08-09
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.044ms | 0.044ms | 0.050ms | FAILED | host-call |
| string/concat-long | 0.004ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.018ms | 0.059ms | 0.014ms | FAILED | gc-native |
| string/includes | 0.018ms | 0.127ms | 0.014ms | FAILED | gc-native |
| string/split | 0.399ms | 4.99ms | 0.420ms | FAILED | js |
| string/replace | 0.104ms | 0.266ms | 0.069ms | FAILED | gc-native |
| string/case-convert | 0.055ms | 0.297ms | 0.083ms | FAILED | js |
| string/substring | 0.100ms | 0.042ms | 0.036ms | FAILED | gc-native |
| string/trim | 0.161ms | 0.871ms | 0.230ms | FAILED | js |
| string/startsWith-endsWith | 0.430ms | 2.89ms | 0.272ms | FAILED | gc-native |
| array/push-pop | 1.50ms | 0.488ms | 0.490ms | FAILED | host-call |
| array/sort-i32 | 0.715ms | 0.307ms | 0.303ms | FAILED | gc-native |
| array/map-filter | 0.143ms | 0.138ms | 0.138ms | FAILED | gc-native |
| array/reduce | 1.27ms | 0.486ms | 0.487ms | FAILED | host-call |
| array/indexOf | 4.83ms | 3.95ms | 3.95ms | FAILED | gc-native |
| array/slice | 0.036ms | 0.033ms | 0.033ms | FAILED | host-call |
| array/reverse | 7.25ms | 3.66ms | 3.65ms | FAILED | gc-native |
| array/forEach | 0.076ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.264ms | 0.018ms | 0.018ms | 0.986ms | host-call |
| dom/create-elements | 0.055ms | 0.183ms | — | — | js |
| dom/set-attributes | 0.124ms | 0.522ms | — | — | js |
| dom/read-attributes | 0.065ms | 0.142ms | — | — | js |
| dom/modify-text | 0.049ms | 0.129ms | — | — | js |
| mixed/csv-parse | 0.459ms | 6.93ms | 0.684ms | FAILED | js |
| mixed/text-search | 0.391ms | 2.45ms | 0.340ms | FAILED | gc-native |
| mixed/fibonacci | 0.144ms | 0.129ms | 0.129ms | 0.039ms | linear-memory |
| mixed/matrix-multiply | 0.203ms | 0.191ms | 0.191ms | 0.770ms | host-call |
| mixed/sieve | 1.48ms | 1.49ms | 1.52ms | FAILED | js |

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
| string/concat-short | 10000 | 4.43 | 4.42 | 4.98 | — |
| string/concat-long | 1000 | 4.07 | 4.52 | 5.67 | — |
| string/indexOf | 1000 | 17.89 | 59.36 | 13.73 | — |
| string/includes | 1000 | 17.88 | 126.59 | 13.75 | — |
| string/split | 10000 | 39.94 | 498.92 | 41.95 | — |
| string/replace | 1000 | 103.83 | 265.91 | 69.19 | — |
| string/case-convert | 2000 | 27.70 | 148.55 | 41.64 | — |
| string/substring | 10000 | 10.03 | 4.20 | 3.59 | — |
| string/trim | 10000 | 16.12 | 87.14 | 23.03 | — |
| string/startsWith-endsWith | 20000 | 21.49 | 144.52 | 13.58 | — |
| array/map-filter | 30000 | 4.77 | 4.60 | 4.58 | — |
| array/indexOf | 1000 | 4825.28 | 3950.70 | 3950.05 | — |
| dom/create-elements | 2000 | 27.62 | 91.53 | — | — |
| dom/set-attributes | 6000 | 20.60 | 86.94 | — | — |
| dom/read-attributes | 3000 | 21.64 | 47.49 | — | — |
| dom/modify-text | 2000 | 24.69 | 64.60 | — | — |
| mixed/csv-parse | 11000 | 41.72 | 629.90 | 62.20 | — |
| mixed/text-search | 40000 | 9.78 | 61.36 | 8.49 | — |
| mixed/fibonacci | 10000 | 14.40 | 12.88 | 12.88 | 3.91 |
| mixed/matrix-multiply | 125000 | 1.62 | 1.53 | 1.53 | 6.16 |
| mixed/sieve | 200000 | 7.38 | 7.46 | 7.58 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.00x faster | 1.13x slower | — |
| string/concat-long | 1.11x slower | 1.39x slower | — |
| string/indexOf | 3.32x slower | 1.30x faster | — |
| string/includes | 7.08x slower | 1.30x faster | — |
| string/split | 12.49x slower | 1.05x slower | — |
| string/replace | 2.56x slower | 1.50x faster | — |
| string/case-convert | 5.36x slower | 1.50x slower | — |
| string/substring | 2.39x faster | 2.80x faster | — |
| string/trim | 5.41x slower | 1.43x slower | — |
| string/startsWith-endsWith | 6.73x slower | 1.58x faster | — |
| array/push-pop | 3.07x faster | 3.06x faster | — |
| array/sort-i32 | 2.33x faster | 2.36x faster | — |
| array/map-filter | 1.04x faster | 1.04x faster | — |
| array/reduce | 2.62x faster | 2.61x faster | — |
| array/indexOf | 1.22x faster | 1.22x faster | — |
| array/slice | 1.10x faster | 1.09x faster | — |
| array/reverse | 1.98x faster | 1.99x faster | — |
| array/forEach | 2.69x faster | 2.71x faster | — |
| array/find | 14.97x faster | 14.95x faster | 3.73x slower |
| dom/create-elements | 3.31x slower | — | — |
| dom/set-attributes | 4.22x slower | — | — |
| dom/read-attributes | 2.19x slower | — | — |
| dom/modify-text | 2.62x slower | — | — |
| mixed/csv-parse | 15.10x slower | 1.49x slower | — |
| mixed/text-search | 6.27x slower | 1.15x faster | — |
| mixed/fibonacci | 1.12x faster | 1.12x faster | 3.68x faster |
| mixed/matrix-multiply | 1.06x faster | 1.06x faster | 3.80x slower |
| mixed/sieve | 1.01x slower | 1.03x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.13x slower |
| string/concat-long | 1.25x slower |
| string/indexOf | 4.32x faster |
| string/includes | 9.21x faster |
| string/split | 11.89x faster |
| string/replace | 3.84x faster |
| string/case-convert | 3.57x faster |
| string/substring | 1.17x faster |
| string/trim | 3.78x faster |
| string/startsWith-endsWith | 10.64x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 10.13x faster |
| mixed/text-search | 7.23x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.02x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 427B | 1.1KB | — |
| string/includes | 414B | 1.1KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 3.9KB | — |
| string/case-convert | 1.6KB | 13.0KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.1KB | 1.4KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 230B | — | — |
| dom/set-attributes | 497B | — | — |
| dom/read-attributes | 362B | — | — |
| dom/modify-text | 237B | — | — |
| mixed/csv-parse | 2.2KB | 4.6KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 263B | 263B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1148.2ms | 1078.9ms | — |
| string/concat-long | 589.6ms | 929.0ms | — |
| string/indexOf | 741.2ms | 972.5ms | — |
| string/includes | 758.9ms | 968.3ms | — |
| string/split | 724.2ms | 961.6ms | — |
| string/replace | 785.1ms | 1044.2ms | — |
| string/case-convert | 760.0ms | 1086.8ms | — |
| string/substring | 608.5ms | 734.2ms | — |
| string/trim | 730.2ms | 999.2ms | — |
| string/startsWith-endsWith | 730.0ms | 970.2ms | — |
| array/push-pop | 752.4ms | 834.4ms | — |
| array/sort-i32 | 926.8ms | 970.8ms | — |
| array/map-filter | 873.8ms | 1013.2ms | — |
| array/reduce | 820.9ms | 862.8ms | — |
| array/indexOf | 789.6ms | 902.1ms | — |
| array/slice | 738.8ms | 801.5ms | — |
| array/reverse | 731.9ms | 781.2ms | — |
| array/forEach | 830.2ms | 950.1ms | — |
| array/find | 744.6ms | 797.5ms | 790.8ms |
| dom/create-elements | 580.8ms | — | — |
| dom/set-attributes | 670.8ms | — | — |
| dom/read-attributes | 644.0ms | — | — |
| dom/modify-text | 628.3ms | — | — |
| mixed/csv-parse | 744.9ms | 961.7ms | — |
| mixed/text-search | 714.7ms | 984.7ms | — |
| mixed/fibonacci | 752.9ms | 813.0ms | 710.1ms |
| mixed/matrix-multiply | 798.2ms | 879.3ms | 747.7ms |
| mixed/sieve | 782.0ms | 847.7ms | — |
