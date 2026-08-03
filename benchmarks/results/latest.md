# js2wasm Benchmark Results

Date: 2026-08-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.047ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.081ms | 0.021ms | FAILED | js |
| string/includes | 0.019ms | 0.146ms | 0.021ms | FAILED | js |
| string/split | 0.425ms | 0.221ms | 0.226ms | FAILED | host-call |
| string/replace | 0.049ms | 0.013ms | 0.014ms | FAILED | host-call |
| string/case-convert | 0.062ms | 0.014ms | 0.015ms | FAILED | host-call |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.220ms | 0.227ms | FAILED | js |
| string/startsWith-endsWith | 0.391ms | 0.223ms | 0.228ms | FAILED | host-call |
| array/push-pop | 1.50ms | 0.521ms | 0.512ms | FAILED | gc-native |
| array/sort-i32 | 0.795ms | 0.343ms | 0.333ms | FAILED | gc-native |
| array/map-filter | 0.132ms | 0.546ms | 0.550ms | FAILED | js |
| array/reduce | 2.18ms | 0.510ms | 0.509ms | FAILED | gc-native |
| array/indexOf | 3.94ms | 0.013ms | 0.013ms | FAILED | gc-native |
| array/slice | 0.028ms | 0.029ms | 0.029ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.050ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.240ms | 0.017ms | 0.017ms | 0.999ms | host-call |
| dom/create-elements | 0.188ms | 0.292ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.364ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.174ms | — | — | js |
| dom/modify-text | 0.051ms | 0.166ms | — | — | js |
| mixed/csv-parse | 1.29ms | 0.518ms | 0.309ms | FAILED | gc-native |
| mixed/text-search | 0.415ms | 0.325ms | 0.313ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.044ms | 0.044ms | 0.044ms | linear-memory |
| mixed/matrix-multiply | 0.159ms | 0.449ms | 0.449ms | 0.719ms | js |
| mixed/sieve | 1.65ms | 1.41ms | 1.40ms | FAILED | gc-native |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | warmup | memory access out of bounds |
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
| string/concat-short | 10000 | 3.21 | 4.67 | 3.90 | — |
| string/concat-long | 1000 | 3.89 | 4.55 | 4.75 | — |
| string/indexOf | 1000 | 19.19 | 80.61 | 20.95 | — |
| string/includes | 1000 | 19.24 | 146.17 | 20.84 | — |
| string/split | 10000 | 42.45 | 22.05 | 22.65 | — |
| string/replace | 1000 | 48.67 | 13.48 | 14.29 | — |
| string/case-convert | 2000 | 30.91 | 6.84 | 7.32 | — |
| string/substring | 10000 | 9.91 | 3.74 | 3.14 | — |
| string/trim | 10000 | 16.98 | 22.01 | 22.75 | — |
| string/startsWith-endsWith | 20000 | 19.53 | 11.16 | 11.38 | — |
| mixed/csv-parse | 11000 | 116.88 | 47.13 | 28.06 | — |
| mixed/text-search | 40000 | 10.39 | 8.12 | 7.83 | — |
| mixed/fibonacci | 10000 | 12.18 | 4.40 | 4.40 | 4.37 |
| mixed/matrix-multiply | 125000 | 1.27 | 3.59 | 3.59 | 5.75 |
| mixed/sieve | 200000 | 8.26 | 7.04 | 6.99 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.45x slower | 1.21x slower | — |
| string/concat-long | 1.17x slower | 1.22x slower | — |
| string/indexOf | 4.20x slower | 1.09x slower | — |
| string/includes | 7.60x slower | 1.08x slower | — |
| string/split | 1.93x faster | 1.87x faster | — |
| string/replace | 3.61x faster | 3.41x faster | — |
| string/case-convert | 4.52x faster | 4.22x faster | — |
| string/substring | 2.65x faster | 3.16x faster | — |
| string/trim | 1.30x slower | 1.34x slower | — |
| string/startsWith-endsWith | 1.75x faster | 1.72x faster | — |
| array/push-pop | 2.87x faster | 2.93x faster | — |
| array/sort-i32 | 2.32x faster | 2.38x faster | — |
| array/map-filter | 4.14x slower | 4.17x slower | — |
| array/reduce | 4.27x faster | 4.28x faster | — |
| array/indexOf | 304.50x faster | 310.53x faster | — |
| array/slice | 1.04x slower | 1.03x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.78x faster | — |
| array/find | 14.23x faster | 14.10x faster | 4.17x slower |
| dom/create-elements | 1.56x slower | — | — |
| dom/set-attributes | 3.46x slower | — | — |
| dom/read-attributes | 3.15x slower | — | — |
| dom/modify-text | 3.24x slower | — | — |
| mixed/csv-parse | 2.48x faster | 4.16x faster | — |
| mixed/text-search | 1.28x faster | 1.33x faster | — |
| mixed/fibonacci | 2.77x faster | 2.77x faster | 2.79x faster |
| mixed/matrix-multiply | 2.82x slower | 2.82x slower | 4.52x slower |
| mixed/sieve | 1.17x faster | 1.18x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.20x faster |
| string/concat-long | 1.04x slower |
| string/indexOf | 3.85x faster |
| string/includes | 7.01x faster |
| string/split | 1.03x slower |
| string/replace | 1.06x slower |
| string/case-convert | 1.07x slower |
| string/substring | 1.19x faster |
| string/trim | 1.03x slower |
| string/startsWith-endsWith | 1.02x slower |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.03x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.02x faster |
| array/slice | 1.02x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 1.68x faster |
| mixed/text-search | 1.04x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 401B | 1.3KB | — |
| string/includes | 388B | 1.3KB | — |
| string/split | 1.6KB | 2.7KB | — |
| string/replace | 1.5KB | 2.5KB | — |
| string/case-convert | 1.4KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 1.9KB | — |
| string/startsWith-endsWith | 1.6KB | 2.8KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.6KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 834B | 1.1KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 230B | — | — |
| dom/set-attributes | 497B | — | — |
| dom/read-attributes | 347B | — | — |
| dom/modify-text | 237B | — | — |
| mixed/csv-parse | 1.9KB | 4.0KB | — |
| mixed/text-search | 1.7KB | 3.2KB | — |
| mixed/fibonacci | 235B | 235B | 251B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1350.3ms | 1111.7ms | — |
| string/concat-long | 647.7ms | 998.3ms | — |
| string/indexOf | 785.0ms | 1001.7ms | — |
| string/includes | 772.9ms | 1039.6ms | — |
| string/split | 822.5ms | 935.1ms | — |
| string/replace | 849.5ms | 954.4ms | — |
| string/case-convert | 839.4ms | 932.1ms | — |
| string/substring | 667.6ms | 733.4ms | — |
| string/trim | 837.0ms | 968.2ms | — |
| string/startsWith-endsWith | 850.8ms | 959.5ms | — |
| array/push-pop | 782.8ms | 875.4ms | — |
| array/sort-i32 | 948.3ms | 1015.7ms | — |
| array/map-filter | 950.2ms | 1065.8ms | — |
| array/reduce | 845.8ms | 901.8ms | — |
| array/indexOf | 767.2ms | 817.3ms | — |
| array/slice | 796.3ms | 860.8ms | — |
| array/reverse | 824.8ms | 865.4ms | — |
| array/forEach | 916.5ms | 1010.5ms | — |
| array/find | 781.2ms | 867.6ms | 852.5ms |
| dom/create-elements | 701.7ms | — | — |
| dom/set-attributes | 741.4ms | — | — |
| dom/read-attributes | 741.0ms | — | — |
| dom/modify-text | 749.3ms | — | — |
| mixed/csv-parse | 882.8ms | 1081.1ms | — |
| mixed/text-search | 868.1ms | 943.9ms | — |
| mixed/fibonacci | 778.5ms | 805.5ms | 777.9ms |
| mixed/matrix-multiply | 878.5ms | 941.6ms | 830.4ms |
| mixed/sieve | 859.2ms | 894.6ms | — |
