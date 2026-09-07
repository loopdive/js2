# js2wasm Benchmark Results

Date: 2026-09-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.049ms | 0.046ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.065ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.150ms | 0.014ms | 0.072ms | gc-native |
| string/split | 0.415ms | 8.41ms | 2.83ms | FAILED | js |
| string/replace | 0.110ms | 0.695ms | 0.320ms | FAILED | js |
| string/case-convert | 0.056ms | 0.568ms | 0.257ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.84ms | 2.66ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.94ms | 3.04ms | 0.561ms | js |
| array/push-pop | 1.45ms | 0.511ms | 0.507ms | FAILED | gc-native |
| array/sort-i32 | 0.791ms | 0.288ms | 0.503ms | FAILED | host-call |
| array/map-filter | 0.129ms | 0.070ms | 0.070ms | FAILED | gc-native |
| array/reduce | 1.36ms | 0.501ms | 0.509ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.027ms | 0.029ms | 0.029ms | FAILED | js |
| array/reverse | 7.85ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.086ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.043ms | 0.166ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.549ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.124ms | — | — | js |
| dom/modify-text | 0.029ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.486ms | 8.71ms | 0.622ms | FAILED | js |
| mixed/text-search | 0.388ms | 5.17ms | 2.82ms | 1.09ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 72.17ms | 71.72ms | 0.721ms | js |
| mixed/sieve | 1.59ms | 2.14ms | 2.13ms | FAILED | js |

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
| string/concat-short | 10000 | 3.14 | 4.89 | 4.55 | — |
| string/concat-long | 1000 | 3.64 | 4.51 | 3.62 | — |
| string/indexOf | 1000 | 19.26 | 64.59 | 12.28 | 15.67 |
| string/includes | 1000 | 19.27 | 149.80 | 14.36 | 72.03 |
| string/split | 10000 | 41.45 | 841.46 | 283.02 | — |
| string/replace | 1000 | 109.90 | 694.72 | 319.88 | — |
| string/case-convert | 2000 | 27.90 | 284.07 | 128.28 | — |
| string/substring | 10000 | 9.90 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.02 | 384.46 | 265.64 | — |
| string/startsWith-endsWith | 20000 | 20.08 | 146.83 | 151.93 | 28.07 |
| array/map-filter | 30000 | 4.31 | 2.35 | 2.35 | — |
| array/indexOf | 1000 | 3950.77 | 2643.32 | 2641.18 | — |
| dom/create-elements | 2000 | 21.51 | 82.89 | — | — |
| dom/set-attributes | 6000 | 17.39 | 91.56 | — | — |
| dom/read-attributes | 3000 | 18.84 | 41.40 | — | — |
| dom/modify-text | 2000 | 14.63 | 54.37 | — | — |
| mixed/csv-parse | 11000 | 44.20 | 792.07 | 56.59 | — |
| mixed/text-search | 40000 | 9.70 | 129.23 | 70.53 | 27.14 |
| mixed/fibonacci | 10000 | 12.18 | 28.32 | 28.34 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.26 | 577.39 | 573.79 | 5.77 |
| mixed/sieve | 200000 | 7.97 | 10.68 | 10.63 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.56x slower | 1.45x slower | — |
| string/concat-long | 1.24x slower | 1.00x faster | — |
| string/indexOf | 3.35x slower | 1.57x faster | 1.23x faster |
| string/includes | 7.77x slower | 1.34x faster | 3.74x slower |
| string/split | 20.30x slower | 6.83x slower | — |
| string/replace | 6.32x slower | 2.91x slower | — |
| string/case-convert | 10.18x slower | 4.60x slower | — |
| string/substring | 2.65x faster | 3.22x faster | — |
| string/trim | 22.59x slower | 15.61x slower | — |
| string/startsWith-endsWith | 7.31x slower | 7.57x slower | 1.40x slower |
| array/push-pop | 2.84x faster | 2.86x faster | — |
| array/sort-i32 | 2.75x faster | 1.57x faster | — |
| array/map-filter | 1.84x faster | 1.84x faster | — |
| array/reduce | 2.71x faster | 2.67x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.06x slower | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.07x faster | 3.09x faster | — |
| array/find | 15.93x faster | 16.00x faster | 4.23x slower |
| dom/create-elements | 3.85x slower | — | — |
| dom/set-attributes | 5.27x slower | — | — |
| dom/read-attributes | 2.20x slower | — | — |
| dom/modify-text | 3.72x slower | — | — |
| mixed/csv-parse | 17.92x slower | 1.28x slower | — |
| mixed/text-search | 13.32x slower | 7.27x slower | 2.80x slower |
| mixed/fibonacci | 2.33x slower | 2.33x slower | 2.31x slower |
| mixed/matrix-multiply | 458.17x slower | 455.31x slower | 4.58x slower |
| mixed/sieve | 1.34x slower | 1.33x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.07x faster |
| string/concat-long | 1.25x faster |
| string/indexOf | 5.26x faster |
| string/includes | 10.43x faster |
| string/split | 2.97x faster |
| string/replace | 2.17x faster |
| string/case-convert | 2.21x faster |
| string/substring | 1.22x faster |
| string/trim | 1.45x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.75x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.02x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 14.00x faster |
| mixed/text-search | 1.83x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x faster |
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
| string/concat-short | 1722.8ms | 1108.5ms | — |
| string/concat-long | 787.8ms | 970.5ms | — |
| string/indexOf | 685.2ms | 1023.6ms | 864.3ms |
| string/includes | 690.6ms | 984.8ms | 857.3ms |
| string/split | 816.7ms | 989.4ms | — |
| string/replace | 798.7ms | 1044.3ms | — |
| string/case-convert | 830.1ms | 941.6ms | — |
| string/substring | 691.8ms | 794.6ms | — |
| string/trim | 770.5ms | 1026.0ms | — |
| string/startsWith-endsWith | 778.1ms | 978.5ms | 970.2ms |
| array/push-pop | 801.0ms | 910.8ms | — |
| array/sort-i32 | 958.4ms | 1047.9ms | — |
| array/map-filter | 982.8ms | 1072.6ms | — |
| array/reduce | 927.7ms | 892.4ms | — |
| array/indexOf | 896.1ms | 991.9ms | — |
| array/slice | 837.6ms | 900.4ms | — |
| array/reverse | 801.3ms | 923.4ms | — |
| array/forEach | 939.3ms | 1053.2ms | — |
| array/find | 810.9ms | 887.3ms | 868.0ms |
| dom/create-elements | 721.6ms | — | — |
| dom/set-attributes | 707.8ms | — | — |
| dom/read-attributes | 722.6ms | — | — |
| dom/modify-text | 701.3ms | — | — |
| mixed/csv-parse | 818.0ms | 984.1ms | — |
| mixed/text-search | 785.6ms | 993.6ms | 944.9ms |
| mixed/fibonacci | 811.1ms | 827.4ms | 812.0ms |
| mixed/matrix-multiply | 938.7ms | 1026.4ms | 830.3ms |
| mixed/sieve | 920.0ms | 982.5ms | — |
