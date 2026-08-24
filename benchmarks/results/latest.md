# js2wasm Benchmark Results

Date: 2026-08-24
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.046ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.130ms | 0.015ms | 0.019ms | gc-native |
| string/split | 0.425ms | 4.91ms | 0.450ms | FAILED | js |
| string/replace | 0.105ms | 0.307ms | 0.058ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.236ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.912ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.400ms | 0.357ms | 0.296ms | 0.560ms | gc-native |
| array/push-pop | 1.41ms | 0.508ms | 0.512ms | FAILED | host-call |
| array/sort-i32 | 0.793ms | 0.327ms | 0.292ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.070ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.17ms | 0.510ms | 0.506ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.63ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.036ms | FAILED | — | — | js |
| dom/set-attributes | 0.104ms | FAILED | — | — | js |
| dom/read-attributes | 0.055ms | FAILED | — | — | js |
| dom/modify-text | 0.030ms | FAILED | — | — | js |
| mixed/csv-parse | 0.494ms | 7.68ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 1.52ms | 0.266ms | 1.13ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.292ms | 0.292ms | 0.287ms | js |
| mixed/matrix-multiply | 0.162ms | 0.212ms | 0.212ms | 0.719ms | js |
| mixed/sieve | 1.53ms | 1.40ms | 1.41ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.53 | 4.62 | 3.83 | — |
| string/concat-long | 1000 | 3.77 | 4.56 | 3.53 | — |
| string/indexOf | 1000 | 19.16 | 62.92 | 12.04 | 15.41 |
| string/includes | 1000 | 19.20 | 129.55 | 14.64 | 19.48 |
| string/split | 10000 | 42.49 | 491.28 | 44.98 | — |
| string/replace | 1000 | 104.70 | 307.03 | 58.16 | — |
| string/case-convert | 2000 | 27.85 | 117.86 | 2.51 | — |
| string/substring | 10000 | 9.88 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.05 | 91.23 | 18.63 | — |
| string/startsWith-endsWith | 20000 | 20.02 | 17.87 | 14.78 | 28.00 |
| array/map-filter | 30000 | 4.27 | 2.34 | 2.33 | — |
| array/indexOf | 1000 | 3952.12 | 2636.25 | 2634.34 | — |
| dom/create-elements | 2000 | 17.93 | — | — | — |
| dom/set-attributes | 6000 | 17.36 | — | — | — |
| dom/read-attributes | 3000 | 18.30 | — | — | — |
| dom/modify-text | 2000 | 14.91 | — | — | — |
| mixed/csv-parse | 11000 | 44.91 | 697.94 | 28.75 | — |
| mixed/text-search | 40000 | 9.72 | 37.99 | 6.65 | 28.34 |
| mixed/fibonacci | 10000 | 12.03 | 29.20 | 29.21 | 28.69 |
| mixed/matrix-multiply | 125000 | 1.30 | 1.70 | 1.70 | 5.75 |
| mixed/sieve | 200000 | 7.67 | 6.98 | 7.07 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.31x slower | 1.08x slower | — |
| string/concat-long | 1.21x slower | 1.07x faster | — |
| string/indexOf | 3.28x slower | 1.59x faster | 1.24x faster |
| string/includes | 6.75x slower | 1.31x faster | 1.01x slower |
| string/split | 11.56x slower | 1.06x slower | — |
| string/replace | 2.93x slower | 1.80x faster | — |
| string/case-convert | 4.23x slower | 11.09x faster | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 5.35x slower | 1.09x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.35x faster | 1.40x slower |
| array/push-pop | 2.78x faster | 2.75x faster | — |
| array/sort-i32 | 2.42x faster | 2.71x faster | — |
| array/map-filter | 1.82x faster | 1.83x faster | — |
| array/reduce | 4.26x faster | 4.29x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.06x slower | 1.05x slower | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.77x faster | 1.75x faster | — |
| array/find | 16.11x faster | 16.08x faster | 4.26x slower |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 15.54x slower | 1.56x faster | — |
| mixed/text-search | 3.91x slower | 1.46x faster | 2.91x slower |
| mixed/fibonacci | 2.43x slower | 2.43x slower | 2.39x slower |
| mixed/matrix-multiply | 1.31x slower | 1.31x slower | 4.43x slower |
| mixed/sieve | 1.10x faster | 1.08x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.21x faster |
| string/concat-long | 1.29x faster |
| string/indexOf | 5.22x faster |
| string/includes | 8.85x faster |
| string/split | 10.92x faster |
| string/replace | 5.28x faster |
| string/case-convert | 46.91x faster |
| string/substring | 1.22x faster |
| string/trim | 4.90x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.12x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 24.28x faster |
| mixed/text-search | 5.72x faster |
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
| string/concat-short | 1361.6ms | 1128.9ms | — |
| string/concat-long | 685.6ms | 992.3ms | — |
| string/indexOf | 695.7ms | 998.3ms | 866.5ms |
| string/includes | 690.3ms | 994.7ms | 869.1ms |
| string/split | 788.7ms | 976.8ms | — |
| string/replace | 780.8ms | 1085.5ms | — |
| string/case-convert | 778.8ms | 873.4ms | — |
| string/substring | 650.5ms | 757.6ms | — |
| string/trim | 768.8ms | 974.3ms | — |
| string/startsWith-endsWith | 776.2ms | 1011.0ms | 941.3ms |
| array/push-pop | 806.7ms | 896.8ms | — |
| array/sort-i32 | 933.3ms | 1018.4ms | — |
| array/map-filter | 959.3ms | 1061.3ms | — |
| array/reduce | 833.9ms | 943.1ms | — |
| array/indexOf | 842.7ms | 944.8ms | — |
| array/slice | 801.0ms | 889.8ms | — |
| array/reverse | 790.6ms | 856.1ms | — |
| array/forEach | 940.8ms | 994.5ms | — |
| array/find | 750.2ms | 871.2ms | 856.1ms |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 823.3ms | 943.9ms | — |
| mixed/text-search | 789.3ms | 1018.6ms | 951.3ms |
| mixed/fibonacci | 797.7ms | 834.0ms | 849.7ms |
| mixed/matrix-multiply | 883.0ms | 965.8ms | 833.6ms |
| mixed/sieve | 890.9ms | 946.0ms | — |
