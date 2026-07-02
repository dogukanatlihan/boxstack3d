# BOXSTACK

A physics tower-stacking game built on **[Box3D](https://github.com/erincatto/box3d)** — Erin Catto's new 3D physics engine — compiled to WebAssembly, rendered with **three.js**.

A crate swings from a crane above the tower. Tap / press Space to drop it. Every landed crate raises the tower; near-center drops score **PERFECT** combos. Sloppy drops leave overhangs that Box3D happily topples — one lost crate ends the run.

## Controls

- **Space / tap / click** — drop the crate
- Perfect drops (< 0.32 m off-center) chain combos
- Best height is saved locally

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production bundle in dist/
```

The compiled physics module (`src/physics/box3d.mjs`, WASM embedded) is checked in, so plain `npm run dev` works with no toolchain.

## How it works

| Layer | File | Role |
| --- | --- | --- |
| Engine | `vendor/box3d/` | Box3D C17 source (upstream clone, not committed — see below) |
| Shim | `wasm/shim.c` | Tiny C API: world init, box bodies, step, batched state buffer, contact hit events |
| Binding | `src/physics.js` | JS wrapper reading body states straight out of WASM memory (`HEAPF32`) |
| Game | `src/main.js` | three.js scene, crane swing, drop/settle logic, camera, audio synth, juice |

Per frame the game calls `w3_Step()` once; the shim writes every body's position/quaternion/velocity into a flat `Float32Array` that JS reads directly — no per-body FFI calls. Box3D contact **hit events** drive impact thuds and camera shake.

## Rebuilding the WASM

Only needed if you change `wasm/shim.c` or update Box3D:

```bash
# one-time: fetch the engine source and emsdk
git clone --depth 1 https://github.com/erincatto/box3d vendor/box3d
# install + activate emsdk: https://github.com/emscripten-core/emsdk

./build-wasm.sh
```

## Notes on Box3D

Box3D (v0.1.0) is written in portable C17. This project uses:

- `b3CreateWorld` / `b3World_Step` with the default single-threaded scheduler
- `b3MakeBoxHull` + `b3CreateHullShape` for crate collision (convex hulls)
- `b3Body_GetTransform`, `b3Body_GetLinearVelocity`, `b3Body_IsAwake` for state sync
- `b3World_GetContactEvents` hit events (`approachSpeed`) for impact feedback

Upstream already carries an `EMSCRIPTEN` branch in its CMake, and the whole engine compiles clean with `emcc -msimd128 -msse2`.
