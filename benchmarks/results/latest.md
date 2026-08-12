# js2wasm Benchmark Results

Date: 2026-08-11
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.044ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.047ms | 0.014ms | 0.015ms | gc-native |
| string/split | 0.430ms | 4.94ms | 0.449ms | FAILED | js |
| string/replace | 0.104ms | 0.311ms | 0.070ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.229ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.896ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.358ms | 0.287ms | 0.562ms | gc-native |
| array/push-pop | 1.39ms | 0.500ms | 0.509ms | FAILED | host-call |
| array/sort-i32 | 0.795ms | 0.298ms | 0.299ms | FAILED | host-call |
| array/map-filter | 0.137ms | 0.068ms | 0.067ms | FAILED | gc-native |
| array/reduce | 2.15ms | 0.512ms | 0.505ms | FAILED | gc-native |
| array/indexOf | 3.96ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.088ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.260ms | 0.016ms | 0.015ms | 1.08ms | gc-native |
| dom/create-elements | 0.035ms | 0.152ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.514ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.125ms | — | — | js |
| dom/modify-text | 0.029ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.483ms | 7.25ms | 0.314ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 1.62ms | 0.265ms | 1.10ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.235ms | 0.235ms | 0.243ms | js |
| mixed/matrix-multiply | 0.158ms | 0.209ms | 0.210ms | 0.719ms | js |
| mixed/sieve | 1.55ms | 1.38ms | 1.39ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.35 | 4.39 | 3.82 | — |
| string/concat-long | 1000 | 3.58 | 4.49 | 3.59 | — |
| string/indexOf | 1000 | 19.17 | 64.23 | 12.27 | 14.64 |
| string/includes | 1000 | 19.19 | 47.42 | 14.48 | 15.43 |
| string/split | 10000 | 43.02 | 494.03 | 44.88 | — |
| string/replace | 1000 | 104.19 | 311.14 | 70.09 | — |
| string/case-convert | 2000 | 27.85 | 114.40 | 2.50 | — |
| string/substring | 10000 | 9.88 | 3.76 | 3.08 | — |
| string/trim | 10000 | 17.01 | 89.56 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.06 | 17.90 | 14.33 | 28.11 |
| array/map-filter | 30000 | 4.55 | 2.26 | 2.23 | — |
| array/indexOf | 1000 | 3956.12 | 2639.80 | 2638.08 | — |
| dom/create-elements | 2000 | 17.57 | 75.89 | — | — |
| dom/set-attributes | 6000 | 17.14 | 85.70 | — | — |
| dom/read-attributes | 3000 | 18.18 | 41.70 | — | — |
| dom/modify-text | 2000 | 14.38 | 52.94 | — | — |
| mixed/csv-parse | 11000 | 43.87 | 659.50 | 28.53 | — |
| mixed/text-search | 40000 | 9.74 | 40.45 | 6.64 | 27.47 |
| mixed/fibonacci | 10000 | 12.03 | 23.50 | 23.50 | 24.35 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.68 | 1.68 | 5.75 |
| mixed/sieve | 200000 | 7.73 | 6.92 | 6.94 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.31x slower | 1.14x slower | — |
| string/concat-long | 1.25x slower | 1.00x slower | — |
| string/indexOf | 3.35x slower | 1.56x faster | 1.31x faster |
| string/includes | 2.47x slower | 1.33x faster | 1.24x faster |
| string/split | 11.48x slower | 1.04x slower | — |
| string/replace | 2.99x slower | 1.49x faster | — |
| string/case-convert | 4.11x slower | 11.12x faster | — |
| string/substring | 2.63x faster | 3.21x faster | — |
| string/trim | 5.27x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.40x faster | 1.40x slower |
| array/push-pop | 2.78x faster | 2.73x faster | — |
| array/sort-i32 | 2.67x faster | 2.66x faster | — |
| array/map-filter | 2.02x faster | 2.04x faster | — |
| array/reduce | 4.20x faster | 4.26x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.11x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.19x faster | 3.20x faster | — |
| array/find | 16.39x faster | 16.82x faster | 4.15x slower |
| dom/create-elements | 4.32x slower | — | — |
| dom/set-attributes | 5.00x slower | — | — |
| dom/read-attributes | 2.29x slower | — | — |
| dom/modify-text | 3.68x slower | — | — |
| mixed/csv-parse | 15.03x slower | 1.54x faster | — |
| mixed/text-search | 4.15x slower | 1.47x faster | 2.82x slower |
| mixed/fibonacci | 1.95x slower | 1.95x slower | 2.02x slower |
| mixed/matrix-multiply | 1.33x slower | 1.33x slower | 4.55x slower |
| mixed/sieve | 1.12x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 1.25x faster |
| string/indexOf | 5.23x faster |
| string/includes | 3.28x faster |
| string/split | 11.01x faster |
| string/replace | 4.44x faster |
| string/case-convert | 45.69x faster |
| string/substring | 1.22x faster |
| string/trim | 4.80x faster |
| string/startsWith-endsWith | 1.25x faster |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.03x faster |
| mixed/csv-parse | 23.11x faster |
| mixed/text-search | 6.09x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 736B | — |
| string/concat-long | 223B | 940B | — |
| string/indexOf | 427B | 1.1KB | 10.4KB |
| string/includes | 414B | 1.1KB | 10.4KB |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 3.9KB | — |
| string/case-convert | 1.6KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.6KB | — |
| string/startsWith-endsWith | 1.7KB | 3.5KB | 1.7KB |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.0KB | — |
| mixed/text-search | 1.8KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 350B | 350B | 342B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1270.6ms | 1092.4ms | — |
| string/concat-long | 632.2ms | 977.0ms | — |
| string/indexOf | 771.5ms | 969.9ms | 853.9ms |
| string/includes | 771.9ms | 971.6ms | 857.7ms |
| string/split | 769.1ms | 955.3ms | — |
| string/replace | 878.8ms | 1063.3ms | — |
| string/case-convert | 790.4ms | 821.3ms | — |
| string/substring | 652.9ms | 747.7ms | — |
| string/trim | 727.9ms | 968.6ms | — |
| string/startsWith-endsWith | 740.5ms | 958.6ms | 894.8ms |
| array/push-pop | 765.0ms | 821.2ms | — |
| array/sort-i32 | 903.5ms | 979.4ms | — |
| array/map-filter | 888.2ms | 1019.4ms | — |
| array/reduce | 834.8ms | 879.7ms | — |
| array/indexOf | 897.7ms | 966.0ms | — |
| array/slice | 745.7ms | 835.4ms | — |
| array/reverse | 737.8ms | 820.6ms | — |
| array/forEach | 836.9ms | 917.4ms | — |
| array/find | 724.2ms | 845.8ms | 819.1ms |
| dom/create-elements | 627.5ms | — | — |
| dom/set-attributes | 696.4ms | — | — |
| dom/read-attributes | 668.5ms | — | — |
| dom/modify-text | 585.2ms | — | — |
| mixed/csv-parse | 793.0ms | 977.3ms | — |
| mixed/text-search | 771.3ms | 1007.2ms | 891.8ms |
| mixed/fibonacci | 810.0ms | 838.1ms | 798.2ms |
| mixed/matrix-multiply | 855.3ms | 924.1ms | 808.9ms |
| mixed/sieve | 830.3ms | 894.2ms | — |
