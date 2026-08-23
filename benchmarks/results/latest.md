# js2wasm Benchmark Results

Date: 2026-08-23
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.038ms | 0.048ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.123ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.424ms | 5.08ms | 0.450ms | FAILED | js |
| string/replace | 0.108ms | 0.312ms | 0.057ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.239ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.100ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.175ms | 0.911ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.400ms | 0.359ms | 0.295ms | 0.560ms | gc-native |
| array/push-pop | 1.46ms | 0.515ms | 0.524ms | FAILED | host-call |
| array/sort-i32 | 0.793ms | 0.295ms | 0.448ms | FAILED | host-call |
| array/map-filter | 0.131ms | 0.072ms | 0.071ms | FAILED | gc-native |
| array/reduce | 2.17ms | 0.511ms | 0.521ms | FAILED | host-call |
| array/indexOf | 3.96ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.037ms | 0.035ms | 0.032ms | FAILED | gc-native |
| array/reverse | 7.84ms | 3.53ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.088ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.255ms | 0.016ms | 0.017ms | 1.08ms | host-call |
| dom/create-elements | 0.043ms | FAILED | — | — | js |
| dom/set-attributes | 0.107ms | FAILED | — | — | js |
| dom/read-attributes | 0.058ms | FAILED | — | — | js |
| dom/modify-text | 0.034ms | FAILED | — | — | js |
| mixed/csv-parse | 0.486ms | 7.82ms | 0.318ms | FAILED | gc-native |
| mixed/text-search | 0.393ms | 1.69ms | 0.267ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.293ms | 0.292ms | 0.286ms | js |
| mixed/matrix-multiply | 0.159ms | 0.229ms | 0.229ms | 0.719ms | js |
| mixed/sieve | 1.59ms | 1.42ms | 1.43ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.80 | 4.82 | 4.32 | — |
| string/concat-long | 1000 | 3.85 | 4.59 | 4.10 | — |
| string/indexOf | 1000 | 19.22 | 62.71 | 12.46 | 15.69 |
| string/includes | 1000 | 19.24 | 123.17 | 14.95 | 15.39 |
| string/split | 10000 | 42.39 | 508.08 | 45.02 | — |
| string/replace | 1000 | 108.44 | 312.34 | 56.71 | — |
| string/case-convert | 2000 | 27.95 | 119.37 | 2.52 | — |
| string/substring | 10000 | 9.95 | 3.74 | 3.09 | — |
| string/trim | 10000 | 17.53 | 91.06 | 18.62 | — |
| string/startsWith-endsWith | 20000 | 20.00 | 17.93 | 14.76 | 28.02 |
| array/map-filter | 30000 | 4.36 | 2.38 | 2.38 | — |
| array/indexOf | 1000 | 3955.54 | 2638.35 | 2639.90 | — |
| dom/create-elements | 2000 | 21.26 | — | — | — |
| dom/set-attributes | 6000 | 17.76 | — | — | — |
| dom/read-attributes | 3000 | 19.26 | — | — | — |
| dom/modify-text | 2000 | 17.04 | — | — | — |
| mixed/csv-parse | 11000 | 44.16 | 711.24 | 28.92 | — |
| mixed/text-search | 40000 | 9.82 | 42.26 | 6.67 | 27.05 |
| mixed/fibonacci | 10000 | 12.18 | 29.30 | 29.17 | 28.63 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.83 | 1.83 | 5.75 |
| mixed/sieve | 200000 | 7.95 | 7.09 | 7.17 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.27x slower | 1.14x slower | — |
| string/concat-long | 1.19x slower | 1.07x slower | — |
| string/indexOf | 3.26x slower | 1.54x faster | 1.22x faster |
| string/includes | 6.40x slower | 1.29x faster | 1.25x faster |
| string/split | 11.99x slower | 1.06x slower | — |
| string/replace | 2.88x slower | 1.91x faster | — |
| string/case-convert | 4.27x slower | 11.07x faster | — |
| string/substring | 2.66x faster | 3.22x faster | — |
| string/trim | 5.19x slower | 1.06x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.35x faster | 1.40x slower |
| array/push-pop | 2.83x faster | 2.78x faster | — |
| array/sort-i32 | 2.69x faster | 1.77x faster | — |
| array/map-filter | 1.83x faster | 1.83x faster | — |
| array/reduce | 4.25x faster | 4.17x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.05x faster | 1.17x faster | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 3.10x faster | 3.10x faster | — |
| array/find | 15.56x faster | 15.42x faster | 4.22x slower |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 16.11x slower | 1.53x faster | — |
| mixed/text-search | 4.30x slower | 1.47x faster | 2.75x slower |
| mixed/fibonacci | 2.41x slower | 2.39x slower | 2.35x slower |
| mixed/matrix-multiply | 1.44x slower | 1.44x slower | 4.51x slower |
| mixed/sieve | 1.12x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.12x faster |
| string/concat-long | 1.12x faster |
| string/indexOf | 5.03x faster |
| string/includes | 8.24x faster |
| string/split | 11.29x faster |
| string/replace | 5.51x faster |
| string/case-convert | 47.30x faster |
| string/substring | 1.21x faster |
| string/trim | 4.89x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.52x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.02x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.12x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 24.59x faster |
| mixed/text-search | 6.34x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
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
| string/concat-short | 1398.3ms | 1159.5ms | — |
| string/concat-long | 688.4ms | 1018.8ms | — |
| string/indexOf | 705.6ms | 1062.4ms | 920.5ms |
| string/includes | 717.6ms | 1030.6ms | 943.3ms |
| string/split | 825.2ms | 1042.1ms | — |
| string/replace | 867.8ms | 1068.1ms | — |
| string/case-convert | 829.5ms | 953.9ms | — |
| string/substring | 717.9ms | 798.3ms | — |
| string/trim | 808.7ms | 1036.7ms | — |
| string/startsWith-endsWith | 807.9ms | 1052.0ms | 970.2ms |
| array/push-pop | 829.4ms | 897.8ms | — |
| array/sort-i32 | 959.4ms | 1071.7ms | — |
| array/map-filter | 994.8ms | 1088.9ms | — |
| array/reduce | 884.8ms | 976.4ms | — |
| array/indexOf | 903.6ms | 1018.6ms | — |
| array/slice | 833.2ms | 919.1ms | — |
| array/reverse | 827.0ms | 887.4ms | — |
| array/forEach | 961.3ms | 1005.4ms | — |
| array/find | 802.2ms | 883.0ms | 887.4ms |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 832.6ms | 972.3ms | — |
| mixed/text-search | 812.6ms | 1089.8ms | 993.5ms |
| mixed/fibonacci | 820.3ms | 881.4ms | 863.3ms |
| mixed/matrix-multiply | 902.9ms | 968.5ms | 857.5ms |
| mixed/sieve | 909.0ms | 960.7ms | — |
