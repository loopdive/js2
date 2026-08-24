# js2wasm Benchmark Results

Date: 2026-08-24
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.045ms | 0.037ms | FAILED | js |
| string/concat-long | 0.003ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.062ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.130ms | 0.015ms | 0.019ms | gc-native |
| string/split | 0.415ms | 4.96ms | 0.450ms | FAILED | js |
| string/replace | 0.105ms | 0.297ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.241ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.904ms | 0.187ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.358ms | 0.295ms | 0.563ms | gc-native |
| array/push-pop | 1.37ms | 0.504ms | 0.503ms | FAILED | gc-native |
| array/sort-i32 | 0.789ms | 0.293ms | 0.350ms | FAILED | host-call |
| array/map-filter | 0.126ms | 0.070ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.15ms | 0.511ms | 0.508ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.63ms | 2.63ms | FAILED | host-call |
| array/slice | 0.025ms | 0.026ms | 0.026ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.53ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.035ms | FAILED | — | — | js |
| dom/set-attributes | 0.104ms | FAILED | — | — | js |
| dom/read-attributes | 0.058ms | FAILED | — | — | js |
| dom/modify-text | 0.029ms | FAILED | — | — | js |
| mixed/csv-parse | 0.485ms | 7.81ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.392ms | 1.71ms | 0.266ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.291ms | 0.292ms | 0.286ms | js |
| mixed/matrix-multiply | 0.157ms | 0.212ms | 0.212ms | 0.717ms | js |
| mixed/sieve | 1.57ms | 1.40ms | 1.43ms | FAILED | host-call |

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
| dom/create-elements | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/set-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/read-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/modify-text | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.11 | 4.55 | 3.69 | — |
| string/concat-long | 1000 | 3.49 | 4.50 | 3.59 | — |
| string/indexOf | 1000 | 19.16 | 62.49 | 12.26 | 14.67 |
| string/includes | 1000 | 19.21 | 129.56 | 14.73 | 19.37 |
| string/split | 10000 | 41.48 | 496.02 | 45.02 | — |
| string/replace | 1000 | 104.51 | 297.28 | 56.32 | — |
| string/case-convert | 2000 | 27.84 | 120.25 | 2.51 | — |
| string/substring | 10000 | 9.84 | 3.74 | 3.08 | — |
| string/trim | 10000 | 16.96 | 90.44 | 18.73 | — |
| string/startsWith-endsWith | 20000 | 20.06 | 17.89 | 14.77 | 28.14 |
| array/map-filter | 30000 | 4.21 | 2.35 | 2.32 | — |
| array/indexOf | 1000 | 3948.49 | 2632.96 | 2634.01 | — |
| dom/create-elements | 2000 | 17.45 | — | — | — |
| dom/set-attributes | 6000 | 17.32 | — | — | — |
| dom/read-attributes | 3000 | 19.21 | — | — | — |
| dom/modify-text | 2000 | 14.74 | — | — | — |
| mixed/csv-parse | 11000 | 44.11 | 709.91 | 28.62 | — |
| mixed/text-search | 40000 | 9.80 | 42.85 | 6.65 | 27.14 |
| mixed/fibonacci | 10000 | 12.17 | 29.15 | 29.17 | 28.63 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.70 | 1.70 | 5.74 |
| mixed/sieve | 200000 | 7.87 | 6.98 | 7.17 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.46x slower | 1.19x slower | — |
| string/concat-long | 1.29x slower | 1.03x slower | — |
| string/indexOf | 3.26x slower | 1.56x faster | 1.31x faster |
| string/includes | 6.74x slower | 1.30x faster | 1.01x slower |
| string/split | 11.96x slower | 1.09x slower | — |
| string/replace | 2.84x slower | 1.86x faster | — |
| string/case-convert | 4.32x slower | 11.11x faster | — |
| string/substring | 2.63x faster | 3.20x faster | — |
| string/trim | 5.33x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.40x slower |
| array/push-pop | 2.71x faster | 2.71x faster | — |
| array/sort-i32 | 2.69x faster | 2.25x faster | — |
| array/map-filter | 1.79x faster | 1.81x faster | — |
| array/reduce | 4.20x faster | 4.22x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.06x slower | 1.06x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.75x faster | 1.76x faster | — |
| array/find | 16.16x faster | 16.19x faster | 4.23x slower |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 16.10x slower | 1.54x faster | — |
| mixed/text-search | 4.37x slower | 1.47x faster | 2.77x slower |
| mixed/fibonacci | 2.39x slower | 2.40x slower | 2.35x slower |
| mixed/matrix-multiply | 1.35x slower | 1.35x slower | 4.56x slower |
| mixed/sieve | 1.13x faster | 1.10x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.23x faster |
| string/concat-long | 1.25x faster |
| string/indexOf | 5.10x faster |
| string/includes | 8.80x faster |
| string/split | 11.02x faster |
| string/replace | 5.28x faster |
| string/case-convert | 48.00x faster |
| string/substring | 1.21x faster |
| string/trim | 4.83x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.19x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 24.81x faster |
| mixed/text-search | 6.45x faster |
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
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.7KB | 2.1KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1393.1ms | 1084.3ms | — |
| string/concat-long | 640.6ms | 958.2ms | — |
| string/indexOf | 649.0ms | 973.5ms | 843.0ms |
| string/includes | 658.4ms | 958.7ms | 805.7ms |
| string/split | 760.9ms | 974.2ms | — |
| string/replace | 761.7ms | 1004.5ms | — |
| string/case-convert | 788.8ms | 833.3ms | — |
| string/substring | 626.5ms | 717.8ms | — |
| string/trim | 730.2ms | 916.8ms | — |
| string/startsWith-endsWith | 750.0ms | 983.8ms | 916.3ms |
| array/push-pop | 812.4ms | 838.9ms | — |
| array/sort-i32 | 940.2ms | 981.7ms | — |
| array/map-filter | 956.7ms | 1021.8ms | — |
| array/reduce | 841.4ms | 984.6ms | — |
| array/indexOf | 832.5ms | 906.3ms | — |
| array/slice | 752.1ms | 821.5ms | — |
| array/reverse | 739.8ms | 828.7ms | — |
| array/forEach | 883.6ms | 968.7ms | — |
| array/find | 736.5ms | 827.1ms | 830.0ms |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 781.9ms | 953.1ms | — |
| mixed/text-search | 758.5ms | 1016.1ms | 883.1ms |
| mixed/fibonacci | 744.0ms | 788.4ms | 799.6ms |
| mixed/matrix-multiply | 836.4ms | 942.7ms | 840.9ms |
| mixed/sieve | 863.4ms | 910.4ms | — |
