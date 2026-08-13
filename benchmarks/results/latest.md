# js2wasm Benchmark Results

Date: 2026-08-13
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.045ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.063ms | 0.013ms | 0.022ms | gc-native |
| string/includes | 0.019ms | 0.134ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.412ms | 4.85ms | 0.454ms | FAILED | js |
| string/replace | 0.115ms | 0.305ms | 0.071ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.260ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.895ms | 0.188ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.359ms | 0.297ms | 0.559ms | gc-native |
| array/push-pop | 1.42ms | 0.511ms | 0.504ms | FAILED | gc-native |
| array/sort-i32 | 0.799ms | 0.298ms | 0.295ms | FAILED | gc-native |
| array/map-filter | 0.139ms | 0.072ms | 0.073ms | FAILED | host-call |
| array/reduce | 2.18ms | 0.509ms | 0.502ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.027ms | 0.029ms | 0.036ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.058ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.042ms | 0.168ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.551ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.127ms | — | — | js |
| dom/modify-text | 0.029ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.483ms | 7.20ms | 0.314ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 1.54ms | 0.264ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.285ms | js |
| mixed/matrix-multiply | 0.159ms | 0.211ms | 0.211ms | 0.715ms | js |
| mixed/sieve | 1.59ms | 1.38ms | 1.39ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.26 | 4.51 | 4.31 | — |
| string/concat-long | 1000 | 3.64 | 4.49 | 3.69 | — |
| string/indexOf | 1000 | 19.21 | 62.88 | 12.58 | 22.41 |
| string/includes | 1000 | 19.26 | 134.25 | 14.76 | 15.50 |
| string/split | 10000 | 41.25 | 485.36 | 45.36 | — |
| string/replace | 1000 | 115.31 | 305.03 | 71.39 | — |
| string/case-convert | 2000 | 28.19 | 129.79 | 2.50 | — |
| string/substring | 10000 | 9.92 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.02 | 89.45 | 18.78 | — |
| string/startsWith-endsWith | 20000 | 20.06 | 17.93 | 14.85 | 27.96 |
| array/map-filter | 30000 | 4.63 | 2.40 | 2.44 | — |
| array/indexOf | 1000 | 3950.79 | 2635.12 | 2639.77 | — |
| dom/create-elements | 2000 | 20.84 | 84.09 | — | — |
| dom/set-attributes | 6000 | 17.53 | 91.81 | — | — |
| dom/read-attributes | 3000 | 18.46 | 42.32 | — | — |
| dom/modify-text | 2000 | 14.73 | 54.26 | — | — |
| mixed/csv-parse | 11000 | 43.88 | 654.79 | 28.56 | — |
| mixed/text-search | 40000 | 9.74 | 38.49 | 6.60 | 26.98 |
| mixed/fibonacci | 10000 | 12.18 | 29.17 | 29.16 | 28.54 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.69 | 1.69 | 5.72 |
| mixed/sieve | 200000 | 7.93 | 6.91 | 6.96 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.39x slower | 1.32x slower | — |
| string/concat-long | 1.23x slower | 1.01x slower | — |
| string/indexOf | 3.27x slower | 1.53x faster | 1.17x slower |
| string/includes | 6.97x slower | 1.31x faster | 1.24x faster |
| string/split | 11.77x slower | 1.10x slower | — |
| string/replace | 2.65x slower | 1.62x faster | — |
| string/case-convert | 4.60x slower | 11.26x faster | — |
| string/substring | 2.65x faster | 3.23x faster | — |
| string/trim | 5.25x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.35x faster | 1.39x slower |
| array/push-pop | 2.79x faster | 2.82x faster | — |
| array/sort-i32 | 2.69x faster | 2.71x faster | — |
| array/map-filter | 1.93x faster | 1.90x faster | — |
| array/reduce | 4.28x faster | 4.34x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.05x slower | 1.30x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 2.05x faster | 2.04x faster | — |
| array/find | 15.62x faster | 15.66x faster | 4.23x slower |
| dom/create-elements | 4.03x slower | — | — |
| dom/set-attributes | 5.24x slower | — | — |
| dom/read-attributes | 2.29x slower | — | — |
| dom/modify-text | 3.68x slower | — | — |
| mixed/csv-parse | 14.92x slower | 1.54x faster | — |
| mixed/text-search | 3.95x slower | 1.48x faster | 2.77x slower |
| mixed/fibonacci | 2.40x slower | 2.39x slower | 2.34x slower |
| mixed/matrix-multiply | 1.33x slower | 1.33x slower | 4.50x slower |
| mixed/sieve | 1.15x faster | 1.14x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.05x faster |
| string/concat-long | 1.22x faster |
| string/indexOf | 5.00x faster |
| string/includes | 9.10x faster |
| string/split | 10.70x faster |
| string/replace | 4.27x faster |
| string/case-convert | 51.84x faster |
| string/substring | 1.22x faster |
| string/trim | 4.76x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.02x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.24x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 22.93x faster |
| mixed/text-search | 5.83x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1389.1ms | 1143.6ms | — |
| string/concat-long | 627.9ms | 1017.9ms | — |
| string/indexOf | 684.7ms | 1044.9ms | 882.6ms |
| string/includes | 677.9ms | 1011.3ms | 909.7ms |
| string/split | 795.7ms | 997.7ms | — |
| string/replace | 793.6ms | 1144.8ms | — |
| string/case-convert | 856.9ms | 876.8ms | — |
| string/substring | 666.6ms | 726.5ms | — |
| string/trim | 755.0ms | 1007.2ms | — |
| string/startsWith-endsWith | 767.4ms | 1038.2ms | 939.9ms |
| array/push-pop | 814.5ms | 891.6ms | — |
| array/sort-i32 | 935.3ms | 984.7ms | — |
| array/map-filter | 965.8ms | 1024.3ms | — |
| array/reduce | 833.5ms | 897.9ms | — |
| array/indexOf | 850.6ms | 891.2ms | — |
| array/slice | 790.6ms | 855.8ms | — |
| array/reverse | 762.9ms | 850.8ms | — |
| array/forEach | 915.3ms | 958.4ms | — |
| array/find | 767.2ms | 862.8ms | 835.6ms |
| dom/create-elements | 645.2ms | — | — |
| dom/set-attributes | 706.6ms | — | — |
| dom/read-attributes | 701.8ms | — | — |
| dom/modify-text | 601.6ms | — | — |
| mixed/csv-parse | 803.4ms | 998.7ms | — |
| mixed/text-search | 794.1ms | 1016.4ms | 940.0ms |
| mixed/fibonacci | 844.3ms | 894.4ms | 810.4ms |
| mixed/matrix-multiply | 861.7ms | 910.0ms | 795.9ms |
| mixed/sieve | 845.6ms | 895.1ms | — |
