# js2wasm Benchmark Results

Date: 2026-08-11
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.046ms | 0.051ms | 0.058ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.018ms | 0.060ms | 0.012ms | 0.063ms | gc-native |
| string/includes | 0.018ms | 0.040ms | 0.014ms | 0.015ms | gc-native |
| string/split | 0.410ms | 5.15ms | 0.419ms | FAILED | js |
| string/replace | 0.106ms | 0.270ms | 0.067ms | FAILED | gc-native |
| string/case-convert | 0.057ms | 0.307ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.100ms | 0.042ms | 0.036ms | FAILED | gc-native |
| string/trim | 0.158ms | 0.834ms | 0.181ms | FAILED | js |
| string/startsWith-endsWith | 0.431ms | 0.305ms | 0.271ms | 0.578ms | gc-native |
| array/push-pop | 1.49ms | 0.504ms | 0.502ms | FAILED | gc-native |
| array/sort-i32 | 0.714ms | 0.304ms | 0.658ms | FAILED | host-call |
| array/map-filter | 0.151ms | 0.141ms | 0.141ms | FAILED | gc-native |
| array/reduce | 1.34ms | 0.507ms | 0.510ms | FAILED | host-call |
| array/indexOf | 4.83ms | 2.76ms | 2.76ms | FAILED | gc-native |
| array/slice | 0.042ms | 0.037ms | 0.039ms | FAILED | host-call |
| array/reverse | 7.27ms | 3.64ms | 3.63ms | FAILED | gc-native |
| array/forEach | 0.080ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.267ms | 0.018ms | 0.018ms | 0.988ms | gc-native |
| dom/create-elements | 0.062ms | 0.185ms | — | — | js |
| dom/set-attributes | 0.130ms | 0.553ms | — | — | js |
| dom/read-attributes | 0.068ms | 0.131ms | — | — | js |
| dom/modify-text | 0.055ms | 0.118ms | — | — | js |
| mixed/csv-parse | 0.471ms | 6.88ms | 0.302ms | FAILED | gc-native |
| mixed/text-search | 0.395ms | 1.53ms | 0.280ms | 1.22ms | gc-native |
| mixed/fibonacci | 0.134ms | 0.187ms | 0.187ms | 0.201ms | js |
| mixed/matrix-multiply | 0.205ms | 0.202ms | 0.202ms | 0.774ms | host-call |
| mixed/sieve | 1.54ms | 1.54ms | 1.52ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 4.60 | 5.12 | 5.83 | — |
| string/concat-long | 1000 | 4.45 | 4.84 | 5.97 | — |
| string/indexOf | 1000 | 17.97 | 59.92 | 12.40 | 62.83 |
| string/includes | 1000 | 18.06 | 40.26 | 14.03 | 15.41 |
| string/split | 10000 | 41.03 | 514.73 | 41.95 | — |
| string/replace | 1000 | 105.55 | 270.21 | 67.27 | — |
| string/case-convert | 2000 | 28.67 | 153.26 | 2.62 | — |
| string/substring | 10000 | 9.99 | 4.19 | 3.59 | — |
| string/trim | 10000 | 15.84 | 83.44 | 18.11 | — |
| string/startsWith-endsWith | 20000 | 21.55 | 15.27 | 13.57 | 28.91 |
| array/map-filter | 30000 | 5.03 | 4.70 | 4.69 | — |
| array/indexOf | 1000 | 4829.19 | 2758.07 | 2755.85 | — |
| dom/create-elements | 2000 | 30.80 | 92.58 | — | — |
| dom/set-attributes | 6000 | 21.72 | 92.19 | — | — |
| dom/read-attributes | 3000 | 22.61 | 43.72 | — | — |
| dom/modify-text | 2000 | 27.31 | 59.20 | — | — |
| mixed/csv-parse | 11000 | 42.80 | 625.18 | 27.45 | — |
| mixed/text-search | 40000 | 9.87 | 38.16 | 7.00 | 30.49 |
| mixed/fibonacci | 10000 | 13.37 | 18.68 | 18.68 | 20.12 |
| mixed/matrix-multiply | 125000 | 1.64 | 1.62 | 1.62 | 6.19 |
| mixed/sieve | 200000 | 7.70 | 7.69 | 7.60 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.11x slower | 1.27x slower | — |
| string/concat-long | 1.09x slower | 1.34x slower | — |
| string/indexOf | 3.33x slower | 1.45x faster | 3.50x slower |
| string/includes | 2.23x slower | 1.29x faster | 1.17x faster |
| string/split | 12.55x slower | 1.02x slower | — |
| string/replace | 2.56x slower | 1.57x faster | — |
| string/case-convert | 5.35x slower | 10.96x faster | — |
| string/substring | 2.38x faster | 2.78x faster | — |
| string/trim | 5.27x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.41x faster | 1.59x faster | 1.34x slower |
| array/push-pop | 2.95x faster | 2.96x faster | — |
| array/sort-i32 | 2.35x faster | 1.08x faster | — |
| array/map-filter | 1.07x faster | 1.07x faster | — |
| array/reduce | 2.64x faster | 2.63x faster | — |
| array/indexOf | 1.75x faster | 1.75x faster | — |
| array/slice | 1.13x faster | 1.07x faster | — |
| array/reverse | 2.00x faster | 2.00x faster | — |
| array/forEach | 2.78x faster | 2.76x faster | — |
| array/find | 15.11x faster | 15.24x faster | 3.70x slower |
| dom/create-elements | 3.01x slower | — | — |
| dom/set-attributes | 4.25x slower | — | — |
| dom/read-attributes | 1.93x slower | — | — |
| dom/modify-text | 2.17x slower | — | — |
| mixed/csv-parse | 14.61x slower | 1.56x faster | — |
| mixed/text-search | 3.87x slower | 1.41x faster | 3.09x slower |
| mixed/fibonacci | 1.40x slower | 1.40x slower | 1.51x slower |
| mixed/matrix-multiply | 1.02x faster | 1.01x faster | 3.77x slower |
| mixed/sieve | 1.00x faster | 1.01x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x slower |
| string/concat-long | 1.23x slower |
| string/indexOf | 4.83x faster |
| string/includes | 2.87x faster |
| string/split | 12.27x faster |
| string/replace | 4.02x faster |
| string/case-convert | 58.57x faster |
| string/substring | 1.17x faster |
| string/trim | 4.61x faster |
| string/startsWith-endsWith | 1.13x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 2.16x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.06x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 22.78x faster |
| mixed/text-search | 5.45x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x faster |

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
| string/concat-short | 1224.1ms | 1111.6ms | — |
| string/concat-long | 628.9ms | 1003.3ms | — |
| string/indexOf | 791.2ms | 987.0ms | 880.0ms |
| string/includes | 814.2ms | 1032.0ms | 837.3ms |
| string/split | 803.5ms | 950.6ms | — |
| string/replace | 853.7ms | 1116.7ms | — |
| string/case-convert | 862.9ms | 869.2ms | — |
| string/substring | 659.4ms | 730.4ms | — |
| string/trim | 730.8ms | 998.3ms | — |
| string/startsWith-endsWith | 762.0ms | 1016.7ms | 889.9ms |
| array/push-pop | 762.6ms | 822.5ms | — |
| array/sort-i32 | 912.7ms | 989.8ms | — |
| array/map-filter | 915.1ms | 1045.9ms | — |
| array/reduce | 870.1ms | 893.7ms | — |
| array/indexOf | 919.2ms | 977.0ms | — |
| array/slice | 761.0ms | 847.5ms | — |
| array/reverse | 775.0ms | 826.0ms | — |
| array/forEach | 853.0ms | 926.0ms | — |
| array/find | 746.7ms | 852.1ms | 848.6ms |
| dom/create-elements | 594.4ms | — | — |
| dom/set-attributes | 720.3ms | — | — |
| dom/read-attributes | 691.0ms | — | — |
| dom/modify-text | 610.7ms | — | — |
| mixed/csv-parse | 791.6ms | 1005.0ms | — |
| mixed/text-search | 788.5ms | 1025.8ms | 975.4ms |
| mixed/fibonacci | 821.1ms | 909.1ms | 812.2ms |
| mixed/matrix-multiply | 843.9ms | 938.6ms | 801.8ms |
| mixed/sieve | 827.7ms | 875.3ms | — |
