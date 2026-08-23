# js2wasm Benchmark Results

Date: 2026-08-23
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.046ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.065ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.129ms | 0.015ms | 0.019ms | gc-native |
| string/split | 3.20ms | 4.95ms | 0.448ms | FAILED | gc-native |
| string/replace | 0.114ms | 0.297ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.232ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.887ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 0.357ms | 0.295ms | 0.562ms | gc-native |
| array/push-pop | 1.41ms | 0.505ms | 0.504ms | FAILED | gc-native |
| array/sort-i32 | 0.789ms | 0.319ms | 0.292ms | FAILED | gc-native |
| array/map-filter | 0.127ms | 0.071ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.14ms | 0.501ms | 0.506ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.041ms | FAILED | — | — | js |
| dom/set-attributes | 0.103ms | FAILED | — | — | js |
| dom/read-attributes | 0.055ms | FAILED | — | — | js |
| dom/modify-text | 0.030ms | FAILED | — | — | js |
| mixed/csv-parse | 0.493ms | 7.74ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 1.62ms | 0.266ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.286ms | js |
| mixed/matrix-multiply | 0.158ms | 0.220ms | 0.218ms | 0.716ms | js |
| mixed/sieve | 1.57ms | 1.41ms | 1.39ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.43 | 4.57 | 3.76 | — |
| string/concat-long | 1000 | 3.57 | 4.52 | 3.77 | — |
| string/indexOf | 1000 | 19.22 | 65.47 | 12.17 | 15.12 |
| string/includes | 1000 | 19.26 | 129.38 | 14.57 | 19.10 |
| string/split | 10000 | 320.06 | 494.54 | 44.84 | — |
| string/replace | 1000 | 113.72 | 296.55 | 56.32 | — |
| string/case-convert | 2000 | 27.79 | 116.21 | 2.51 | — |
| string/substring | 10000 | 9.87 | 3.74 | 3.08 | — |
| string/trim | 10000 | 16.98 | 88.65 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.10 | 17.87 | 14.77 | 28.08 |
| array/map-filter | 30000 | 4.24 | 2.36 | 2.37 | — |
| array/indexOf | 1000 | 3950.59 | 2635.13 | 2636.48 | — |
| dom/create-elements | 2000 | 20.65 | — | — | — |
| dom/set-attributes | 6000 | 17.18 | — | — | — |
| dom/read-attributes | 3000 | 18.45 | — | — | — |
| dom/modify-text | 2000 | 14.80 | — | — | — |
| mixed/csv-parse | 11000 | 44.84 | 703.61 | 28.69 | — |
| mixed/text-search | 40000 | 9.73 | 40.44 | 6.65 | 27.13 |
| mixed/fibonacci | 10000 | 12.17 | 29.18 | 29.16 | 28.59 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.76 | 1.74 | 5.73 |
| mixed/sieve | 200000 | 7.84 | 7.04 | 6.96 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.34x slower | 1.10x slower | — |
| string/concat-long | 1.27x slower | 1.06x slower | — |
| string/indexOf | 3.41x slower | 1.58x faster | 1.27x faster |
| string/includes | 6.72x slower | 1.32x faster | 1.01x faster |
| string/split | 1.55x slower | 7.14x faster | — |
| string/replace | 2.61x slower | 2.02x faster | — |
| string/case-convert | 4.18x slower | 11.08x faster | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 5.22x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.40x slower |
| array/push-pop | 2.80x faster | 2.80x faster | — |
| array/sort-i32 | 2.48x faster | 2.70x faster | — |
| array/map-filter | 1.79x faster | 1.79x faster | — |
| array/reduce | 4.28x faster | 4.24x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.09x slower | 1.10x slower | — |
| array/reverse | 2.23x faster | 2.22x faster | — |
| array/forEach | 1.74x faster | 1.74x faster | — |
| array/find | 15.64x faster | 15.96x faster | 4.25x slower |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 15.69x slower | 1.56x faster | — |
| mixed/text-search | 4.16x slower | 1.46x faster | 2.79x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.35x slower |
| mixed/matrix-multiply | 1.39x slower | 1.38x slower | 4.54x slower |
| mixed/sieve | 1.11x faster | 1.13x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.22x faster |
| string/concat-long | 1.20x faster |
| string/indexOf | 5.38x faster |
| string/includes | 8.88x faster |
| string/split | 11.03x faster |
| string/replace | 5.27x faster |
| string/case-convert | 46.32x faster |
| string/substring | 1.22x faster |
| string/trim | 4.76x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.09x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.02x faster |
| mixed/csv-parse | 24.52x faster |
| mixed/text-search | 6.09x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.01x faster |

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
| string/concat-short | 1422.2ms | 1111.2ms | — |
| string/concat-long | 680.2ms | 979.2ms | — |
| string/indexOf | 692.6ms | 985.9ms | 870.4ms |
| string/includes | 664.3ms | 981.1ms | 859.1ms |
| string/split | 792.8ms | 981.5ms | — |
| string/replace | 803.3ms | 1046.1ms | — |
| string/case-convert | 779.5ms | 956.0ms | — |
| string/substring | 645.6ms | 744.9ms | — |
| string/trim | 761.1ms | 947.1ms | — |
| string/startsWith-endsWith | 745.5ms | 963.8ms | 894.2ms |
| array/push-pop | 799.5ms | 871.3ms | — |
| array/sort-i32 | 946.8ms | 1008.2ms | — |
| array/map-filter | 966.2ms | 1051.8ms | — |
| array/reduce | 885.3ms | 945.0ms | — |
| array/indexOf | 872.9ms | 954.2ms | — |
| array/slice | 795.7ms | 862.4ms | — |
| array/reverse | 772.5ms | 835.9ms | — |
| array/forEach | 897.3ms | 1021.7ms | — |
| array/find | 758.9ms | 873.7ms | 852.7ms |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 805.7ms | 929.9ms | — |
| mixed/text-search | 783.9ms | 967.3ms | 930.9ms |
| mixed/fibonacci | 747.2ms | 789.8ms | 801.9ms |
| mixed/matrix-multiply | 881.8ms | 952.4ms | 850.5ms |
| mixed/sieve | 892.5ms | 926.3ms | — |
