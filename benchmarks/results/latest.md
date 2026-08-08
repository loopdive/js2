# js2wasm Benchmark Results

Date: 2026-08-08
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.044ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.156ms | 0.023ms | FAILED | js |
| string/split | 0.424ms | 5.44ms | 0.449ms | FAILED | js |
| string/replace | 0.116ms | 0.321ms | 0.082ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.253ms | 0.111ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.901ms | 0.248ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.81ms | 0.292ms | FAILED | gc-native |
| array/push-pop | 1.47ms | 0.503ms | 0.510ms | FAILED | host-call |
| array/sort-i32 | 0.786ms | 0.302ms | 0.300ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.063ms | 0.063ms | FAILED | gc-native |
| array/reduce | 2.15ms | 0.508ms | 0.502ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 3.55ms | 3.55ms | FAILED | gc-native |
| array/slice | 0.027ms | 0.027ms | 0.028ms | FAILED | host-call |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.246ms | 0.017ms | 0.017ms | 1.07ms | gc-native |
| dom/create-elements | 0.040ms | 0.178ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.487ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.139ms | — | — | js |
| dom/modify-text | 0.047ms | 0.121ms | — | — | js |
| mixed/csv-parse | 0.483ms | 8.18ms | 0.603ms | FAILED | js |
| mixed/text-search | 0.390ms | 2.66ms | 0.328ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.118ms | 0.120ms | 0.044ms | linear-memory |
| mixed/matrix-multiply | 0.157ms | 0.192ms | 0.192ms | 0.718ms | js |
| mixed/sieve | 1.55ms | 1.40ms | 1.39ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.11 | 4.44 | 3.84 | — |
| string/concat-long | 1000 | 3.60 | 4.49 | 4.51 | — |
| string/indexOf | 1000 | 19.16 | 66.18 | 23.85 | — |
| string/includes | 1000 | 19.21 | 155.86 | 23.45 | — |
| string/split | 10000 | 42.44 | 544.47 | 44.93 | — |
| string/replace | 1000 | 116.19 | 320.66 | 81.68 | — |
| string/case-convert | 2000 | 28.10 | 126.51 | 55.26 | — |
| string/substring | 10000 | 9.87 | 3.74 | 3.14 | — |
| string/trim | 10000 | 16.99 | 90.07 | 24.85 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 140.67 | 14.60 | — |
| array/map-filter | 30000 | 4.28 | 2.11 | 2.11 | — |
| array/indexOf | 1000 | 3950.57 | 3552.91 | 3552.01 | — |
| dom/create-elements | 2000 | 20.21 | 89.23 | — | — |
| dom/set-attributes | 6000 | 17.27 | 81.10 | — | — |
| dom/read-attributes | 3000 | 18.41 | 46.26 | — | — |
| dom/modify-text | 2000 | 23.60 | 60.69 | — | — |
| mixed/csv-parse | 11000 | 43.93 | 744.07 | 54.83 | — |
| mixed/text-search | 40000 | 9.74 | 66.38 | 8.20 | — |
| mixed/fibonacci | 10000 | 12.18 | 11.82 | 12.03 | 4.37 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.53 | 1.53 | 5.74 |
| mixed/sieve | 200000 | 7.76 | 7.00 | 6.95 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.43x slower | 1.23x slower | — |
| string/concat-long | 1.25x slower | 1.25x slower | — |
| string/indexOf | 3.45x slower | 1.24x slower | — |
| string/includes | 8.11x slower | 1.22x slower | — |
| string/split | 12.83x slower | 1.06x slower | — |
| string/replace | 2.76x slower | 1.42x faster | — |
| string/case-convert | 4.50x slower | 1.97x slower | — |
| string/substring | 2.64x faster | 3.14x faster | — |
| string/trim | 5.30x slower | 1.46x slower | — |
| string/startsWith-endsWith | 7.02x slower | 1.37x faster | — |
| array/push-pop | 2.93x faster | 2.88x faster | — |
| array/sort-i32 | 2.60x faster | 2.62x faster | — |
| array/map-filter | 2.02x faster | 2.03x faster | — |
| array/reduce | 4.23x faster | 4.28x faster | — |
| array/indexOf | 1.11x faster | 1.11x faster | — |
| array/slice | 1.01x faster | 1.03x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.72x faster | 1.72x faster | — |
| array/find | 14.58x faster | 14.75x faster | 4.38x slower |
| dom/create-elements | 4.42x slower | — | — |
| dom/set-attributes | 4.70x slower | — | — |
| dom/read-attributes | 2.51x slower | — | — |
| dom/modify-text | 2.57x slower | — | — |
| mixed/csv-parse | 16.94x slower | 1.25x slower | — |
| mixed/text-search | 6.81x slower | 1.19x faster | — |
| mixed/fibonacci | 1.03x faster | 1.01x faster | 2.79x faster |
| mixed/matrix-multiply | 1.22x slower | 1.22x slower | 4.56x slower |
| mixed/sieve | 1.11x faster | 1.12x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.16x faster |
| string/concat-long | 1.01x slower |
| string/indexOf | 2.77x faster |
| string/includes | 6.65x faster |
| string/split | 12.12x faster |
| string/replace | 3.93x faster |
| string/case-convert | 2.29x faster |
| string/substring | 1.19x faster |
| string/trim | 3.63x faster |
| string/startsWith-endsWith | 9.63x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 13.57x faster |
| mixed/text-search | 8.10x faster |
| mixed/fibonacci | 1.02x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 427B | 1.3KB | — |
| string/includes | 414B | 1.3KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 4.1KB | — |
| string/case-convert | 1.6KB | 13.2KB | — |
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
| dom/read-attributes | 347B | — | — |
| dom/modify-text | 237B | — | — |
| mixed/csv-parse | 2.2KB | 4.6KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 263B | 263B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1301.0ms | 1155.0ms | — |
| string/concat-long | 637.6ms | 961.2ms | — |
| string/indexOf | 793.0ms | 996.4ms | — |
| string/includes | 772.0ms | 999.7ms | — |
| string/split | 756.4ms | 951.7ms | — |
| string/replace | 816.2ms | 1090.7ms | — |
| string/case-convert | 792.3ms | 1155.3ms | — |
| string/substring | 645.6ms | 708.8ms | — |
| string/trim | 729.1ms | 1014.5ms | — |
| string/startsWith-endsWith | 749.2ms | 1024.9ms | — |
| array/push-pop | 799.1ms | 843.5ms | — |
| array/sort-i32 | 981.7ms | 1049.1ms | — |
| array/map-filter | 898.4ms | 1016.1ms | — |
| array/reduce | 841.8ms | 919.8ms | — |
| array/indexOf | 839.7ms | 922.5ms | — |
| array/slice | 773.6ms | 843.6ms | — |
| array/reverse | 756.6ms | 801.4ms | — |
| array/forEach | 832.4ms | 912.9ms | — |
| array/find | 728.6ms | 801.2ms | 810.1ms |
| dom/create-elements | 619.4ms | — | — |
| dom/set-attributes | 694.0ms | — | — |
| dom/read-attributes | 698.2ms | — | — |
| dom/modify-text | 685.6ms | — | — |
| mixed/csv-parse | 780.7ms | 959.9ms | — |
| mixed/text-search | 740.6ms | 1018.7ms | — |
| mixed/fibonacci | 789.7ms | 815.5ms | 728.1ms |
| mixed/matrix-multiply | 822.8ms | 863.1ms | 809.1ms |
| mixed/sieve | 794.5ms | 920.4ms | — |
