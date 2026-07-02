#!/usr/bin/env bash
# Rebuild the Box3D WASM module (src/physics/box3d.mjs) from vendor/box3d + wasm/shim.c
# Requires emsdk (https://github.com/emscripten-core/emsdk) installed and activated.
set -euo pipefail

EMCC="${EMCC:-emcc}"
if ! command -v "$EMCC" >/dev/null 2>&1; then
  # fall back to the default Windows emsdk location
  EMCC="$HOME/emsdk/upstream/emscripten/emcc.exe"
fi

"$EMCC" wasm/shim.c vendor/box3d/src/*.c \
  -I vendor/box3d/include -I vendor/box3d/src \
  -O2 -msimd128 -msse2 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createBox3d \
  -sSINGLE_FILE=1 -sALLOW_MEMORY_GROWTH=1 -sENVIRONMENT=web \
  -sEXPORTED_RUNTIME_METHODS=HEAPF32 \
  -o src/physics/box3d.mjs

echo "OK -> src/physics/box3d.mjs"
