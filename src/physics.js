// Thin JS wrapper over the Box3D WASM shim (wasm/shim.c).
// State buffer layout per slot (12 floats):
// [0-2] position, [3-6] quaternion (x,y,z,w), [7] awake, [8] valid, [9-11] linear velocity

import createBox3d from './physics/box3d.mjs';

export const BODY_STATIC = 0;
export const BODY_KINEMATIC = 1;
export const BODY_DYNAMIC = 2;

export class Physics {
  static async create(gravityY = -10) {
    const mod = await createBox3d();
    return new Physics(mod, gravityY);
  }

  constructor(mod, gravityY) {
    this.mod = mod;
    this.gravityY = gravityY;
    this.stride = mod._w3_GetStateStride();
    this.reset();
  }

  reset() {
    this.mod._w3_Init(0, this.gravityY, 0);
    this.statesPtr = this.mod._w3_GetStatesPtr();
    this.hitsPtr = this.mod._w3_GetHitsPtr();
  }

  createBox({
    type = BODY_DYNAMIC,
    position = [0, 0, 0],
    rotation = [0, 0, 0, 1],
    halfExtents = [0.5, 0.5, 0.5],
    density = 1,
    friction = 0.6,
    restitution = 0.0,
    hitEvents = false,
  }) {
    return this.mod._w3_CreateBoxBody(
      type,
      position[0], position[1], position[2],
      rotation[0], rotation[1], rotation[2], rotation[3],
      halfExtents[0], halfExtents[1], halfExtents[2],
      density, friction, restitution,
      hitEvents ? 1 : 0,
    );
  }

  destroyBody(handle) {
    this.mod._w3_DestroyBody(handle);
  }

  setLinearVelocity(handle, x, y, z) {
    this.mod._w3_SetLinearVelocity(handle, x, y, z);
  }

  setAngularVelocity(handle, x, y, z) {
    this.mod._w3_SetAngularVelocity(handle, x, y, z);
  }

  applyImpulse(handle, x, y, z) {
    this.mod._w3_ApplyImpulse(handle, x, y, z);
  }

  step(dt, substeps = 4) {
    this.mod._w3_Step(dt, substeps);
  }

  /// Float32Array view over the shared state buffer. Re-created each call
  /// because memory growth can detach the underlying ArrayBuffer.
  states() {
    return new Float32Array(this.mod.HEAPF32.buffer, this.statesPtr, 1024 * this.stride);
  }

  /// Read one body's state into `out` object. Returns false if slot invalid.
  readBody(handle, out) {
    const s = this.states();
    const o = handle * this.stride;
    if (s[o + 8] === 0) return false;
    out.x = s[o];
    out.y = s[o + 1];
    out.z = s[o + 2];
    out.qx = s[o + 3];
    out.qy = s[o + 4];
    out.qz = s[o + 5];
    out.qw = s[o + 6];
    out.awake = s[o + 7] > 0.5;
    out.vx = s[o + 9];
    out.vy = s[o + 10];
    out.vz = s[o + 11];
    return true;
  }

  /// Hit events from the last step: array of {x, y, z, speed}
  hits() {
    const count = this.mod._w3_GetHitCount();
    if (count === 0) return [];
    const view = new Float32Array(this.mod.HEAPF32.buffer, this.hitsPtr, count * 4);
    const result = [];
    for (let i = 0; i < count; i++) {
      result.push({ x: view[i * 4], y: view[i * 4 + 1], z: view[i * 4 + 2], speed: view[i * 4 + 3] });
    }
    return result;
  }
}
