# js2wasm Benchmark Results

Date: 2026-08-16
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.045ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.127ms | 0.015ms | 0.024ms | gc-native |
| string/split | 0.426ms | 4.93ms | 0.448ms | FAILED | js |
| string/replace | 0.111ms | 0.307ms | 0.057ms | FAILED | gc-native |
| string/case-convert | 0.057ms | 0.234ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.908ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.358ms | 0.295ms | 0.560ms | gc-native |
| array/push-pop | 1.43ms | 0.502ms | 0.504ms | FAILED | host-call |
| array/sort-i32 | 0.790ms | 0.293ms | 0.294ms | FAILED | host-call |
| array/map-filter | 0.128ms | 0.069ms | 0.069ms | FAILED | gc-native |
| array/reduce | 2.12ms | 0.500ms | 0.499ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.030ms | 0.027ms | 0.034ms | FAILED | host-call |
| array/reverse | 8.04ms | 3.52ms | 3.54ms | FAILED | host-call |
| array/forEach | 0.054ms | 0.031ms | 0.030ms | FAILED | gc-native |
| array/find | 0.253ms | 0.017ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.040ms | 0.152ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.598ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.123ms | — | — | js |
| dom/modify-text | 0.029ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.480ms | 7.21ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.388ms | 1.65ms | 0.267ms | 1.10ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.292ms | 0.292ms | 1.18ms | js |
| mixed/matrix-multiply | 0.160ms | 0.209ms | 0.225ms | 0.713ms | js |
| mixed/sieve | 1.54ms | 1.40ms | 1.40ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.08 | 4.46 | 3.75 | — |
| string/concat-long | 1000 | 3.52 | 4.41 | 3.42 | — |
| string/indexOf | 1000 | 19.12 | 62.64 | 12.06 | 15.63 |
| string/includes | 1000 | 19.16 | 127.26 | 14.59 | 23.93 |
| string/split | 10000 | 42.58 | 492.98 | 44.83 | — |
| string/replace | 1000 | 110.98 | 306.82 | 57.22 | — |
| string/case-convert | 2000 | 28.32 | 117.18 | 2.52 | — |
| string/substring | 10000 | 9.83 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.04 | 90.79 | 18.62 | — |
| string/startsWith-endsWith | 20000 | 20.07 | 17.89 | 14.76 | 27.99 |
| array/map-filter | 30000 | 4.26 | 2.30 | 2.30 | — |
| array/indexOf | 1000 | 3946.70 | 2635.01 | 2636.63 | — |
| dom/create-elements | 2000 | 19.76 | 76.20 | — | — |
| dom/set-attributes | 6000 | 17.44 | 99.74 | — | — |
| dom/read-attributes | 3000 | 18.29 | 41.15 | — | — |
| dom/modify-text | 2000 | 14.68 | 53.04 | — | — |
| mixed/csv-parse | 11000 | 43.60 | 655.25 | 28.66 | — |
| mixed/text-search | 40000 | 9.71 | 41.36 | 6.66 | 27.50 |
| mixed/fibonacci | 10000 | 12.02 | 29.15 | 29.23 | 117.81 |
| mixed/matrix-multiply | 125000 | 1.28 | 1.68 | 1.80 | 5.70 |
| mixed/sieve | 200000 | 7.71 | 6.99 | 6.99 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.45x slower | 1.22x slower | — |
| string/concat-long | 1.26x slower | 1.03x faster | — |
| string/indexOf | 3.28x slower | 1.59x faster | 1.22x faster |
| string/includes | 6.64x slower | 1.31x faster | 1.25x slower |
| string/split | 11.58x slower | 1.05x slower | — |
| string/replace | 2.76x slower | 1.94x faster | — |
| string/case-convert | 4.14x slower | 11.26x faster | — |
| string/substring | 2.63x faster | 3.20x faster | — |
| string/trim | 5.33x slower | 1.09x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.39x slower |
| array/push-pop | 2.85x faster | 2.84x faster | — |
| array/sort-i32 | 2.70x faster | 2.69x faster | — |
| array/map-filter | 1.85x faster | 1.86x faster | — |
| array/reduce | 4.24x faster | 4.25x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.12x faster | 1.13x slower | — |
| array/reverse | 2.28x faster | 2.27x faster | — |
| array/forEach | 1.77x faster | 1.77x faster | — |
| array/find | 14.65x faster | 15.80x faster | 4.26x slower |
| dom/create-elements | 3.86x slower | — | — |
| dom/set-attributes | 5.72x slower | — | — |
| dom/read-attributes | 2.25x slower | — | — |
| dom/modify-text | 3.61x slower | — | — |
| mixed/csv-parse | 15.03x slower | 1.52x faster | — |
| mixed/text-search | 4.26x slower | 1.46x faster | 2.83x slower |
| mixed/fibonacci | 2.43x slower | 2.43x slower | 9.80x slower |
| mixed/matrix-multiply | 1.31x slower | 1.41x slower | 4.46x slower |
| mixed/sieve | 1.10x faster | 1.10x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.19x faster |
| string/concat-long | 1.29x faster |
| string/indexOf | 5.20x faster |
| string/includes | 8.72x faster |
| string/split | 11.00x faster |
| string/replace | 5.36x faster |
| string/case-convert | 46.57x faster |
| string/substring | 1.22x faster |
| string/trim | 4.88x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.26x slower |
| array/reverse | 1.01x slower |
| array/forEach | 1.00x faster |
| array/find | 1.08x faster |
| mixed/csv-parse | 22.86x faster |
| mixed/text-search | 6.21x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.08x slower |
| mixed/sieve | 1.00x slower |

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
| array/sort-i32 | 2.6KB | 2.9KB | — |
| array/map-filter | 3.3KB | 3.7KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 2.9KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.6KB | 2.0KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1318.3ms | 1055.0ms | — |
| string/concat-long | 627.5ms | 940.3ms | — |
| string/indexOf | 637.0ms | 953.1ms | 819.6ms |
| string/includes | 631.9ms | 957.2ms | 819.2ms |
| string/split | 743.6ms | 997.8ms | — |
| string/replace | 782.2ms | 1091.2ms | — |
| string/case-convert | 740.2ms | 818.2ms | — |
| string/substring | 623.6ms | 701.2ms | — |
| string/trim | 717.1ms | 924.1ms | — |
| string/startsWith-endsWith | 747.4ms | 991.2ms | 882.5ms |
| array/push-pop | 779.8ms | 849.6ms | — |
| array/sort-i32 | 865.0ms | 964.5ms | — |
| array/map-filter | 902.2ms | 978.3ms | — |
| array/reduce | 837.0ms | 892.8ms | — |
| array/indexOf | 814.0ms | 897.6ms | — |
| array/slice | 759.8ms | 829.1ms | — |
| array/reverse | 788.1ms | 829.5ms | — |
| array/forEach | 881.5ms | 992.8ms | — |
| array/find | 754.5ms | 845.1ms | 809.4ms |
| dom/create-elements | 622.3ms | — | — |
| dom/set-attributes | 692.4ms | — | — |
| dom/read-attributes | 660.9ms | — | — |
| dom/modify-text | 607.1ms | — | — |
| mixed/csv-parse | 809.9ms | 922.9ms | — |
| mixed/text-search | 772.1ms | 960.5ms | 883.6ms |
| mixed/fibonacci | 719.1ms | 777.1ms | 760.9ms |
| mixed/matrix-multiply | 841.8ms | 891.6ms | 799.2ms |
| mixed/sieve | 883.2ms | 875.3ms | — |
