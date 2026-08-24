# js2wasm Benchmark Results

Date: 2026-08-24
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.053ms | 0.051ms | 0.050ms | FAILED | gc-native |
| string/concat-long | 0.004ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.018ms | 0.057ms | 0.013ms | 0.015ms | gc-native |
| string/includes | 0.018ms | 0.125ms | 0.014ms | 0.034ms | gc-native |
| string/split | 0.430ms | 4.93ms | 0.419ms | FAILED | gc-native |
| string/replace | 0.107ms | 0.276ms | 0.060ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.278ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.101ms | 0.042ms | 0.036ms | FAILED | gc-native |
| string/trim | 0.159ms | 0.911ms | 0.181ms | FAILED | js |
| string/startsWith-endsWith | 0.429ms | 0.305ms | 0.274ms | 0.580ms | gc-native |
| array/push-pop | 1.44ms | 0.503ms | 0.498ms | FAILED | gc-native |
| array/sort-i32 | 0.711ms | 0.311ms | 0.312ms | FAILED | host-call |
| array/map-filter | 0.148ms | 0.086ms | 0.085ms | FAILED | gc-native |
| array/reduce | 2.02ms | 0.499ms | 0.505ms | FAILED | host-call |
| array/indexOf | 4.83ms | 2.76ms | 2.75ms | FAILED | gc-native |
| array/slice | 0.041ms | 0.038ms | 0.040ms | FAILED | host-call |
| array/reverse | 7.27ms | 3.64ms | 3.65ms | FAILED | host-call |
| array/forEach | 0.104ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.266ms | 0.017ms | 0.017ms | 0.984ms | gc-native |
| dom/create-elements | 0.074ms | FAILED | — | — | js |
| dom/set-attributes | 0.137ms | FAILED | — | — | js |
| dom/read-attributes | 0.083ms | FAILED | — | — | js |
| dom/modify-text | 0.062ms | FAILED | — | — | js |
| mixed/csv-parse | 0.463ms | 7.02ms | 0.302ms | FAILED | gc-native |
| mixed/text-search | 0.392ms | 1.51ms | 0.267ms | 1.72ms | gc-native |
| mixed/fibonacci | 0.134ms | 0.300ms | 0.300ms | 0.299ms | js |
| mixed/matrix-multiply | 0.204ms | 0.204ms | 0.205ms | 0.774ms | js |
| mixed/sieve | 1.53ms | 1.51ms | 1.53ms | FAILED | host-call |

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
| string/concat-short | 10000 | 5.35 | 5.07 | 5.03 | — |
| string/concat-long | 1000 | 4.47 | 5.06 | 5.85 | — |
| string/indexOf | 1000 | 18.06 | 57.29 | 12.90 | 14.96 |
| string/includes | 1000 | 17.96 | 124.51 | 13.85 | 33.83 |
| string/split | 10000 | 43.01 | 493.17 | 41.93 | — |
| string/replace | 1000 | 106.99 | 275.83 | 59.71 | — |
| string/case-convert | 2000 | 28.03 | 138.86 | 2.66 | — |
| string/substring | 10000 | 10.05 | 4.19 | 3.59 | — |
| string/trim | 10000 | 15.93 | 91.07 | 18.11 | — |
| string/startsWith-endsWith | 20000 | 21.43 | 15.24 | 13.72 | 29.01 |
| array/map-filter | 30000 | 4.95 | 2.86 | 2.84 | — |
| array/indexOf | 1000 | 4829.65 | 2757.01 | 2752.86 | — |
| dom/create-elements | 2000 | 37.16 | — | — | — |
| dom/set-attributes | 6000 | 22.86 | — | — | — |
| dom/read-attributes | 3000 | 27.68 | — | — | — |
| dom/modify-text | 2000 | 30.88 | — | — | — |
| mixed/csv-parse | 11000 | 42.14 | 638.61 | 27.47 | — |
| mixed/text-search | 40000 | 9.79 | 37.76 | 6.67 | 43.08 |
| mixed/fibonacci | 10000 | 13.38 | 29.97 | 30.00 | 29.87 |
| mixed/matrix-multiply | 125000 | 1.63 | 1.64 | 1.64 | 6.19 |
| mixed/sieve | 200000 | 7.65 | 7.55 | 7.63 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.05x faster | 1.06x faster | — |
| string/concat-long | 1.13x slower | 1.31x slower | — |
| string/indexOf | 3.17x slower | 1.40x faster | 1.21x faster |
| string/includes | 6.93x slower | 1.30x faster | 1.88x slower |
| string/split | 11.47x slower | 1.03x faster | — |
| string/replace | 2.58x slower | 1.79x faster | — |
| string/case-convert | 4.95x slower | 10.54x faster | — |
| string/substring | 2.40x faster | 2.80x faster | — |
| string/trim | 5.72x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.41x faster | 1.56x faster | 1.35x slower |
| array/push-pop | 2.86x faster | 2.88x faster | — |
| array/sort-i32 | 2.28x faster | 2.28x faster | — |
| array/map-filter | 1.73x faster | 1.74x faster | — |
| array/reduce | 4.05x faster | 4.00x faster | — |
| array/indexOf | 1.75x faster | 1.75x faster | — |
| array/slice | 1.07x faster | 1.03x faster | — |
| array/reverse | 2.00x faster | 2.00x faster | — |
| array/forEach | 3.65x faster | 3.64x faster | — |
| array/find | 15.53x faster | 15.60x faster | 3.70x slower |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 15.16x slower | 1.53x faster | — |
| mixed/text-search | 3.86x slower | 1.47x faster | 4.40x slower |
| mixed/fibonacci | 2.24x slower | 2.24x slower | 2.23x slower |
| mixed/matrix-multiply | 1.00x slower | 1.00x slower | 3.79x slower |
| mixed/sieve | 1.01x faster | 1.00x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.01x faster |
| string/concat-long | 1.16x slower |
| string/indexOf | 4.44x faster |
| string/includes | 8.99x faster |
| string/split | 11.76x faster |
| string/replace | 4.62x faster |
| string/case-convert | 52.24x faster |
| string/substring | 1.17x faster |
| string/trim | 5.03x faster |
| string/startsWith-endsWith | 1.11x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.04x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 23.25x faster |
| mixed/text-search | 5.66x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1222.5ms | 1103.7ms | — |
| string/concat-long | 606.6ms | 933.3ms | — |
| string/indexOf | 638.9ms | 953.9ms | 818.7ms |
| string/includes | 629.0ms | 972.3ms | 849.5ms |
| string/split | 749.3ms | 997.3ms | — |
| string/replace | 764.2ms | 1048.7ms | — |
| string/case-convert | 802.7ms | 856.1ms | — |
| string/substring | 623.5ms | 721.9ms | — |
| string/trim | 736.1ms | 953.2ms | — |
| string/startsWith-endsWith | 773.2ms | 940.2ms | 862.0ms |
| array/push-pop | 755.7ms | 848.6ms | — |
| array/sort-i32 | 916.5ms | 1006.5ms | — |
| array/map-filter | 901.9ms | 992.9ms | — |
| array/reduce | 830.3ms | 952.4ms | — |
| array/indexOf | 816.8ms | 920.4ms | — |
| array/slice | 765.9ms | 905.9ms | — |
| array/reverse | 776.6ms | 831.6ms | — |
| array/forEach | 889.0ms | 991.4ms | — |
| array/find | 757.6ms | 844.9ms | 826.7ms |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 825.8ms | 956.4ms | — |
| mixed/text-search | 744.3ms | 996.5ms | 887.3ms |
| mixed/fibonacci | 768.1ms | 786.6ms | 819.7ms |
| mixed/matrix-multiply | 847.4ms | 961.9ms | 794.8ms |
| mixed/sieve | 878.1ms | 888.5ms | — |
