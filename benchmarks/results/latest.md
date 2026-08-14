# js2wasm Benchmark Results

Date: 2026-08-14
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.047ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.028ms | gc-native |
| string/includes | 0.019ms | 0.130ms | 0.014ms | 0.015ms | gc-native |
| string/split | 0.424ms | 4.86ms | 0.449ms | FAILED | js |
| string/replace | 0.110ms | 0.303ms | 0.071ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.243ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 0.909ms | 0.187ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.359ms | 0.298ms | 0.560ms | gc-native |
| array/push-pop | 1.44ms | 0.509ms | 0.512ms | FAILED | host-call |
| array/sort-i32 | 0.789ms | 0.298ms | 0.294ms | FAILED | gc-native |
| array/map-filter | 0.130ms | 0.071ms | 0.071ms | FAILED | gc-native |
| array/reduce | 2.18ms | 0.511ms | 0.517ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.63ms | 2.64ms | FAILED | host-call |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.035ms | 0.149ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.599ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.120ms | — | — | js |
| dom/modify-text | 0.030ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.487ms | 7.32ms | 0.347ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 1.58ms | 0.263ms | 1.10ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.293ms | 0.287ms | js |
| mixed/matrix-multiply | 0.158ms | 0.210ms | 0.210ms | 0.719ms | js |
| mixed/sieve | 1.58ms | 1.40ms | 1.47ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.44 | 4.67 | 3.72 | — |
| string/concat-long | 1000 | 3.64 | 4.53 | 3.77 | — |
| string/indexOf | 1000 | 19.18 | 63.28 | 12.26 | 27.62 |
| string/includes | 1000 | 19.22 | 130.21 | 14.44 | 15.43 |
| string/split | 10000 | 42.36 | 485.60 | 44.88 | — |
| string/replace | 1000 | 110.19 | 302.59 | 71.39 | — |
| string/case-convert | 2000 | 27.98 | 121.70 | 2.51 | — |
| string/substring | 10000 | 9.86 | 3.74 | 3.14 | — |
| string/trim | 10000 | 17.13 | 90.91 | 18.74 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 17.96 | 14.89 | 28.01 |
| array/map-filter | 30000 | 4.33 | 2.37 | 2.35 | — |
| array/indexOf | 1000 | 3951.79 | 2633.80 | 2637.08 | — |
| dom/create-elements | 2000 | 17.70 | 74.31 | — | — |
| dom/set-attributes | 6000 | 17.36 | 99.85 | — | — |
| dom/read-attributes | 3000 | 18.58 | 40.13 | — | — |
| dom/modify-text | 2000 | 14.86 | 53.21 | — | — |
| mixed/csv-parse | 11000 | 44.25 | 665.91 | 31.59 | — |
| mixed/text-search | 40000 | 9.74 | 39.61 | 6.58 | 27.57 |
| mixed/fibonacci | 10000 | 12.17 | 29.24 | 29.25 | 28.67 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.68 | 1.68 | 5.75 |
| mixed/sieve | 200000 | 7.91 | 7.00 | 7.33 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.36x slower | 1.08x slower | — |
| string/concat-long | 1.24x slower | 1.04x slower | — |
| string/indexOf | 3.30x slower | 1.56x faster | 1.44x slower |
| string/includes | 6.77x slower | 1.33x faster | 1.25x faster |
| string/split | 11.46x slower | 1.06x slower | — |
| string/replace | 2.75x slower | 1.54x faster | — |
| string/case-convert | 4.35x slower | 11.13x faster | — |
| string/substring | 2.64x faster | 3.15x faster | — |
| string/trim | 5.31x slower | 1.09x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.35x faster | 1.40x slower |
| array/push-pop | 2.82x faster | 2.81x faster | — |
| array/sort-i32 | 2.65x faster | 2.68x faster | — |
| array/map-filter | 1.82x faster | 1.84x faster | — |
| array/reduce | 4.25x faster | 4.20x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.76x faster | 1.77x faster | — |
| array/find | 15.81x faster | 15.68x faster | 4.25x slower |
| dom/create-elements | 4.20x slower | — | — |
| dom/set-attributes | 5.75x slower | — | — |
| dom/read-attributes | 2.16x slower | — | — |
| dom/modify-text | 3.58x slower | — | — |
| mixed/csv-parse | 15.05x slower | 1.40x faster | — |
| mixed/text-search | 4.07x slower | 1.48x faster | 2.83x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.36x slower |
| mixed/matrix-multiply | 1.33x slower | 1.33x slower | 4.54x slower |
| mixed/sieve | 1.13x faster | 1.08x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.26x faster |
| string/concat-long | 1.20x faster |
| string/indexOf | 5.16x faster |
| string/includes | 9.02x faster |
| string/split | 10.82x faster |
| string/replace | 4.24x faster |
| string/case-convert | 48.41x faster |
| string/substring | 1.19x faster |
| string/trim | 4.85x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 21.08x faster |
| mixed/text-search | 6.02x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.05x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 736B | — |
| string/concat-long | 223B | 940B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.0KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.6KB | — |
| string/startsWith-endsWith | 1.7KB | 3.5KB | 1.7KB |
| array/push-pop | 914B | 1.2KB | — |
| array/sort-i32 | 2.5KB | 2.9KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.6KB | 2.0KB | — |
| array/slice | 994B | 1.3KB | — |
| array/reverse | 972B | 1.3KB | — |
| array/forEach | 2.5KB | 2.8KB | — |
| array/find | 920B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.0KB | — |
| mixed/text-search | 1.9KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 405B | 405B | 386B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1378.0ms | 1134.9ms | — |
| string/concat-long | 647.5ms | 1020.4ms | — |
| string/indexOf | 684.8ms | 1060.8ms | 892.9ms |
| string/includes | 685.4ms | 1012.9ms | 851.4ms |
| string/split | 788.5ms | 981.8ms | — |
| string/replace | 780.2ms | 1123.6ms | — |
| string/case-convert | 788.3ms | 870.5ms | — |
| string/substring | 657.7ms | 749.1ms | — |
| string/trim | 781.1ms | 1005.9ms | — |
| string/startsWith-endsWith | 789.9ms | 1021.3ms | 923.3ms |
| array/push-pop | 798.7ms | 864.7ms | — |
| array/sort-i32 | 926.9ms | 997.8ms | — |
| array/map-filter | 968.2ms | 1044.7ms | — |
| array/reduce | 818.3ms | 891.1ms | — |
| array/indexOf | 840.2ms | 906.3ms | — |
| array/slice | 747.1ms | 842.6ms | — |
| array/reverse | 751.1ms | 834.6ms | — |
| array/forEach | 858.9ms | 963.1ms | — |
| array/find | 741.9ms | 867.6ms | 860.2ms |
| dom/create-elements | 638.8ms | — | — |
| dom/set-attributes | 743.0ms | — | — |
| dom/read-attributes | 714.9ms | — | — |
| dom/modify-text | 637.1ms | — | — |
| mixed/csv-parse | 807.4ms | 1019.6ms | — |
| mixed/text-search | 775.8ms | 1039.8ms | 915.4ms |
| mixed/fibonacci | 832.1ms | 865.0ms | 840.5ms |
| mixed/matrix-multiply | 890.8ms | 927.0ms | 847.9ms |
| mixed/sieve | 844.2ms | 918.8ms | — |
