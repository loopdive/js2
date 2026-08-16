# js2wasm Benchmark Results

Date: 2026-08-16
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.046ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.020ms | gc-native |
| string/includes | 0.019ms | 0.131ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.412ms | 5.00ms | 0.450ms | FAILED | js |
| string/replace | 0.106ms | 0.316ms | 0.057ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.236ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.100ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.908ms | 0.187ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 0.359ms | 0.295ms | 0.560ms | gc-native |
| array/push-pop | 1.43ms | 0.508ms | 0.505ms | FAILED | gc-native |
| array/sort-i32 | 0.803ms | 0.300ms | 0.295ms | FAILED | gc-native |
| array/map-filter | 0.084ms | 0.071ms | 0.071ms | FAILED | gc-native |
| array/reduce | 2.16ms | 0.507ms | 0.509ms | FAILED | host-call |
| array/indexOf | 3.97ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.025ms | 0.027ms | 0.028ms | FAILED | js |
| array/reverse | 7.89ms | 3.54ms | 3.53ms | FAILED | gc-native |
| array/forEach | 0.057ms | 0.029ms | 0.028ms | FAILED | gc-native |
| array/find | 0.263ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.035ms | 0.157ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.587ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.121ms | — | — | js |
| dom/modify-text | 0.029ms | 0.107ms | — | — | js |
| mixed/csv-parse | 0.482ms | 7.28ms | 0.314ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 1.61ms | 0.266ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 1.18ms | js |
| mixed/matrix-multiply | 0.158ms | 0.217ms | 0.210ms | 0.718ms | js |
| mixed/sieve | 1.55ms | 1.40ms | 1.43ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.23 | 4.63 | 3.76 | — |
| string/concat-long | 1000 | 3.57 | 4.49 | 3.65 | — |
| string/indexOf | 1000 | 19.18 | 62.72 | 12.00 | 19.78 |
| string/includes | 1000 | 19.29 | 130.72 | 14.68 | 16.47 |
| string/split | 10000 | 41.23 | 500.21 | 45.04 | — |
| string/replace | 1000 | 105.83 | 315.85 | 56.75 | — |
| string/case-convert | 2000 | 27.91 | 117.92 | 2.50 | — |
| string/substring | 10000 | 9.96 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.01 | 90.81 | 18.67 | — |
| string/startsWith-endsWith | 20000 | 20.10 | 17.97 | 14.77 | 28.01 |
| array/map-filter | 30000 | 2.78 | 2.36 | 2.35 | — |
| array/indexOf | 1000 | 3971.13 | 2638.83 | 2642.89 | — |
| dom/create-elements | 2000 | 17.51 | 78.68 | — | — |
| dom/set-attributes | 6000 | 17.24 | 97.85 | — | — |
| dom/read-attributes | 3000 | 18.30 | 40.22 | — | — |
| dom/modify-text | 2000 | 14.61 | 53.47 | — | — |
| mixed/csv-parse | 11000 | 43.85 | 661.37 | 28.57 | — |
| mixed/text-search | 40000 | 9.75 | 40.22 | 6.64 | 27.10 |
| mixed/fibonacci | 10000 | 12.18 | 29.19 | 29.16 | 117.91 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.74 | 1.68 | 5.75 |
| mixed/sieve | 200000 | 7.77 | 7.02 | 7.14 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.43x slower | 1.17x slower | — |
| string/concat-long | 1.26x slower | 1.02x slower | — |
| string/indexOf | 3.27x slower | 1.60x faster | 1.03x slower |
| string/includes | 6.78x slower | 1.31x faster | 1.17x faster |
| string/split | 12.13x slower | 1.09x slower | — |
| string/replace | 2.98x slower | 1.86x faster | — |
| string/case-convert | 4.23x slower | 11.15x faster | — |
| string/substring | 2.66x faster | 3.25x faster | — |
| string/trim | 5.34x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.39x slower |
| array/push-pop | 2.81x faster | 2.83x faster | — |
| array/sort-i32 | 2.67x faster | 2.72x faster | — |
| array/map-filter | 1.18x faster | 1.18x faster | — |
| array/reduce | 4.27x faster | 4.25x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.06x slower | 1.08x slower | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 2.01x faster | 2.04x faster | — |
| array/find | 16.34x faster | 16.72x faster | 4.09x slower |
| dom/create-elements | 4.49x slower | — | — |
| dom/set-attributes | 5.68x slower | — | — |
| dom/read-attributes | 2.20x slower | — | — |
| dom/modify-text | 3.66x slower | — | — |
| mixed/csv-parse | 15.08x slower | 1.53x faster | — |
| mixed/text-search | 4.13x slower | 1.47x faster | 2.78x slower |
| mixed/fibonacci | 2.40x slower | 2.39x slower | 9.68x slower |
| mixed/matrix-multiply | 1.38x slower | 1.33x slower | 4.56x slower |
| mixed/sieve | 1.11x faster | 1.09x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.23x faster |
| string/concat-long | 1.23x faster |
| string/indexOf | 5.23x faster |
| string/includes | 8.90x faster |
| string/split | 11.11x faster |
| string/replace | 5.57x faster |
| string/case-convert | 47.11x faster |
| string/substring | 1.22x faster |
| string/trim | 4.86x faster |
| string/startsWith-endsWith | 1.22x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.02x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.02x faster |
| array/find | 1.02x faster |
| mixed/csv-parse | 23.15x faster |
| mixed/text-search | 6.06x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.03x faster |
| mixed/sieve | 1.02x slower |

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
| string/concat-short | 1355.7ms | 1077.8ms | — |
| string/concat-long | 648.5ms | 940.6ms | — |
| string/indexOf | 661.0ms | 970.8ms | 828.1ms |
| string/includes | 650.8ms | 1008.0ms | 837.2ms |
| string/split | 761.5ms | 984.7ms | — |
| string/replace | 769.0ms | 1013.2ms | — |
| string/case-convert | 817.4ms | 869.4ms | — |
| string/substring | 642.4ms | 743.7ms | — |
| string/trim | 727.1ms | 956.0ms | — |
| string/startsWith-endsWith | 753.4ms | 971.2ms | 904.0ms |
| array/push-pop | 810.7ms | 835.5ms | — |
| array/sort-i32 | 897.9ms | 988.7ms | — |
| array/map-filter | 941.1ms | 986.5ms | — |
| array/reduce | 856.1ms | 912.6ms | — |
| array/indexOf | 843.6ms | 981.6ms | — |
| array/slice | 763.6ms | 900.8ms | — |
| array/reverse | 765.2ms | 812.5ms | — |
| array/forEach | 859.0ms | 958.0ms | — |
| array/find | 777.9ms | 850.6ms | 820.5ms |
| dom/create-elements | 631.7ms | — | — |
| dom/set-attributes | 706.8ms | — | — |
| dom/read-attributes | 674.4ms | — | — |
| dom/modify-text | 598.0ms | — | — |
| mixed/csv-parse | 783.1ms | 944.1ms | — |
| mixed/text-search | 767.1ms | 995.9ms | 900.3ms |
| mixed/fibonacci | 755.6ms | 782.5ms | 784.8ms |
| mixed/matrix-multiply | 886.3ms | 907.9ms | 795.9ms |
| mixed/sieve | 886.9ms | 922.5ms | — |
