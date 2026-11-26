(() => {
  'use strict';

  const DF = (window.DF = window.DF || {});

  // ---------------------------------------------------------------------------
  // DF.Math — scalar math helpers & deterministic PRNG
  // ---------------------------------------------------------------------------
  const PI = Math.PI;
  const TAU = PI * 2;
  const HALF_PI = PI * 0.5;
  const DEG2RAD = PI / 180;
  const RAD2DEG = 180 / PI;

  function clamp(x, a, b) {
    return x < a ? a : (x > b ? b : x);
  }

  function saturate(x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function invLerp(a, b, v) {
    const d = b - a;
    return Math.abs(d) < 1e-8 ? 0 : clamp((v - a) / d, 0, 1);
  }

  function smoothstep(a, b, x) {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function damp(a, b, lambda, dt) {
    if (dt <= 0) return a;
    return lerp(a, b, 1 - Math.exp(-lambda * dt));
  }

  function rand(min = 0, max = 1) {
    return min + Math.random() * (max - min);
  }

  function randInt(min, max) {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    return Math.floor(Math.random() * (hi - lo + 1)) + lo;
  }

  function seededRandom(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return function next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function wrapAngle(a) {
    let r = (a + PI) % TAU;
    if (r < 0) r += TAU;
    return r - PI;
  }

  function angleDiff(a, b) {
    return wrapAngle(b - a);
  }

  function lerpAngle(a, b, t) {
    return a + angleDiff(a, b) * t;
  }

  DF.Math = {
    PI,
    TAU,
    HALF_PI,
    DEG2RAD,
    RAD2DEG,
    clamp,
    saturate,
    lerp,
    invLerp,
    smoothstep,
    damp,
    rand,
    randInt,
    seededRandom,
    wrapAngle,
    angleDiff,
    lerpAngle,
  };

  // ---------------------------------------------------------------------------
  // DF.RNG — seedable Mulberry32 generator (usable via `new DF.RNG(seed)` or static)
  // ---------------------------------------------------------------------------
  function RNG(seed = 1337) {
    if (!(this instanceof RNG)) return new RNG(seed);
    this._state = (seed >>> 0) || 0x9e3779b9;
  }

  RNG.prototype.seed = function (s) {
    this._state = (s >>> 0) || 0x9e3779b9;
    return this;
  };

  RNG.prototype.next = function () {
    let s = (this._state = (this._state + 0x6d2b79f5) >>> 0);
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  RNG.prototype.float = function (min = 0, max = 1) {
    return min + this.next() * (max - min);
  };

  RNG.prototype.range = RNG.prototype.float;

  RNG.prototype.int = function (min, max) {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    return Math.floor(this.next() * (hi - lo + 1)) + lo;
  };

  RNG.prototype.bool = function (p = 0.5) {
    return this.next() < p;
  };

  RNG.prototype.pick = function (arr) {
    if (!arr || arr.length === 0) return undefined;
    return arr[Math.floor(this.next() * arr.length)];
  };

  RNG.prototype.shuffle = function (arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  };

  RNG.prototype.gaussian = function (mean = 0, std = 1) {
    const u1 = Math.max(this.next(), 1e-7);
    const u2 = this.next();
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(TAU * u2);
    return mean + z0 * std;
  };

  const _defaultRng = new RNG(202604);
  RNG.create = (seed) => new RNG(seed);
  RNG.seed = (s) => _defaultRng.seed(s);
  RNG.next = () => _defaultRng.next();
  RNG.float = (a, b) => _defaultRng.float(a, b);
  RNG.range = (a, b) => _defaultRng.range(a, b);
  RNG.int = (a, b) => _defaultRng.int(a, b);
  RNG.bool = (p) => _defaultRng.bool(p);
  RNG.pick = (arr) => _defaultRng.pick(arr);

  DF.RNG = RNG;

  // ---------------------------------------------------------------------------
  // DF.Vec3 — fast Float32Array 3D vector math
  // ---------------------------------------------------------------------------
  const Vec3 = {
    create(x = 0, y = 0, z = 0) {
      const out = new Float32Array(3);
      out[0] = x;
      out[1] = y;
      out[2] = z;
      return out;
    },

    clone(v) {
      const out = new Float32Array(3);
      out[0] = v[0];
      out[1] = v[1];
      out[2] = v[2];
      return out;
    },

    copy(out, a) {
      out[0] = a[0];
      out[1] = a[1];
      out[2] = a[2];
      return out;
    },

    set(out, x, y, z) {
      out[0] = x;
      out[1] = y;
      out[2] = z;
      return out;
    },

    zero(out) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      return out;
    },

    add(out, a, b) {
      out[0] = a[0] + b[0];
      out[1] = a[1] + b[1];
      out[2] = a[2] + b[2];
      return out;
    },

    sub(out, a, b) {
      out[0] = a[0] - b[0];
      out[1] = a[1] - b[1];
      out[2] = a[2] - b[2];
      return out;
    },

    mul(out, a, b) {
      out[0] = a[0] * b[0];
      out[1] = a[1] * b[1];
      out[2] = a[2] * b[2];
      return out;
    },

    scale(out, a, s) {
      out[0] = a[0] * s;
      out[1] = a[1] * s;
      out[2] = a[2] * s;
      return out;
    },

    scaleAndAdd(out, a, b, s) {
      out[0] = a[0] + b[0] * s;
      out[1] = a[1] + b[1] * s;
      out[2] = a[2] + b[2] * s;
      return out;
    },

    dot(a, b) {
      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    },

    cross(out, a, b) {
      const ax = a[0], ay = a[1], az = a[2];
      const bx = b[0], by = b[1], bz = b[2];
      out[0] = ay * bz - az * by;
      out[1] = az * bx - ax * bz;
      out[2] = ax * by - ay * bx;
      return out;
    },

    lenSq(a) {
      return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
    },

    len(a) {
      return Math.hypot(a[0], a[1], a[2]);
    },

    distSq(a, b) {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const dz = a[2] - b[2];
      return dx * dx + dy * dy + dz * dz;
    },

    dist(a, b) {
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    },

    normalize(out, a) {
      const ax = a[0], ay = a[1], az = a[2];
      const lsq = ax * ax + ay * ay + az * az;
      if (lsq > 1e-12) {
        const inv = 1 / Math.sqrt(lsq);
        out[0] = ax * inv;
        out[1] = ay * inv;
        out[2] = az * inv;
      } else {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
      }
      return out;
    },

    lerp(out, a, b, t) {
      const ax = a[0], ay = a[1], az = a[2];
      out[0] = ax + (b[0] - ax) * t;
      out[1] = ay + (b[1] - ay) * t;
      out[2] = az + (b[2] - az) * t;
      return out;
    },

    negate(out, a) {
      out[0] = -a[0];
      out[1] = -a[1];
      out[2] = -a[2];
      return out;
    },

    min(out, a, b) {
      out[0] = a[0] < b[0] ? a[0] : b[0];
      out[1] = a[1] < b[1] ? a[1] : b[1];
      out[2] = a[2] < b[2] ? a[2] : b[2];
      return out;
    },

    max(out, a, b) {
      out[0] = a[0] > b[0] ? a[0] : b[0];
      out[1] = a[1] > b[1] ? a[1] : b[1];
      out[2] = a[2] > b[2] ? a[2] : b[2];
      return out;
    },

    equals(a, b, eps = 1e-5) {
      return (
        Math.abs(a[0] - b[0]) <= eps &&
        Math.abs(a[1] - b[1]) <= eps &&
        Math.abs(a[2] - b[2]) <= eps
      );
    },
  };

  Vec3.length = Vec3.len;
  Vec3.squaredLength = Vec3.lenSq;
  Vec3.distance = Vec3.dist;
  Vec3.squaredDistance = Vec3.distSq;

  DF.Vec3 = Vec3;

  // ---------------------------------------------------------------------------
  // DF.Quat — unit quaternion math (YXZ Euler convention matching Mat4.fromTRS)
  // ---------------------------------------------------------------------------
  const Quat = {
    create(x = 0, y = 0, z = 0, w = 1) {
      const out = new Float32Array(4);
      out[0] = x;
      out[1] = y;
      out[2] = z;
      out[3] = w;
      return out;
    },

    clone(q) {
      const out = new Float32Array(4);
      out[0] = q[0];
      out[1] = q[1];
      out[2] = q[2];
      out[3] = q[3];
      return out;
    },

    copy(out, q) {
      out[0] = q[0];
      out[1] = q[1];
      out[2] = q[2];
      out[3] = q[3];
      return out;
    },

    identity(out) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = 1;
      return out;
    },

    normalize(out, q) {
      const x = q[0], y = q[1], z = q[2], w = q[3];
      const lsq = x * x + y * y + z * z + w * w;
      if (lsq > 1e-12) {
        const inv = 1 / Math.sqrt(lsq);
        out[0] = x * inv;
        out[1] = y * inv;
        out[2] = z * inv;
        out[3] = w * inv;
      } else {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
        out[3] = 1;
      }
      return out;
    },

    invert(out, q) {
      const x = q[0], y = q[1], z = q[2], w = q[3];
      const dot = x * x + y * y + z * z + w * w;
      const inv = dot > 1e-12 ? 1 / dot : 0;
      out[0] = -x * inv;
      out[1] = -y * inv;
      out[2] = -z * inv;
      out[3] = w * inv;
      return out;
    },

    // YXZ intrinsic order: Ry(y) * Rx(x) * Rz(z)
    fromEuler(out, x, y, z) {
      const hx = x * 0.5;
      const hy = y * 0.5;
      const hz = z * 0.5;
      const sx = Math.sin(hx), cx = Math.cos(hx);
      const sy = Math.sin(hy), cy = Math.cos(hy);
      const sz = Math.sin(hz), cz = Math.cos(hz);

      out[0] = cy * sx * cz + sy * cx * sz;
      out[1] = sy * cx * cz - cy * sx * sz;
      out[2] = cy * cx * sz - sy * sx * cz;
      out[3] = cy * cx * cz + sy * sx * sz;
      return out;
    },

    fromAxisAngle(out, axis, rad) {
      const half = rad * 0.5;
      const s = Math.sin(half);
      const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
      out[0] = (axis[0] / len) * s;
      out[1] = (axis[1] / len) * s;
      out[2] = (axis[2] / len) * s;
      out[3] = Math.cos(half);
      return out;
    },

    multiply(out, a, b) {
      const ax = a[0], ay = a[1], az = a[2], aw = a[3];
      const bx = b[0], by = b[1], bz = b[2], bw = b[3];
      out[0] = ax * bw + aw * bx + ay * bz - az * by;
      out[1] = ay * bw + aw * by + az * bx - ax * bz;
      out[2] = az * bw + aw * bz + ax * by - ay * bx;
      out[3] = aw * bw - ax * bx - ay * by - az * bz;
      return out;
    },

    slerp(out, a, b, t) {
      const ax = a[0], ay = a[1], az = a[2], aw = a[3];
      let bx = b[0], by = b[1], bz = b[2], bw = b[3];
      let cosom = ax * bx + ay * by + az * bz + aw * bw;
      if (cosom < 0) {
        cosom = -cosom;
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
      }
      let scale0, scale1;
      if (1.0 - cosom > 1e-5) {
        const omega = Math.acos(clamp(cosom, -1, 1));
        const sinom = Math.sin(omega);
        scale0 = Math.sin((1.0 - t) * omega) / sinom;
        scale1 = Math.sin(t * omega) / sinom;
      } else {
        scale0 = 1.0 - t;
        scale1 = t;
      }
      out[0] = scale0 * ax + scale1 * bx;
      out[1] = scale0 * ay + scale1 * by;
      out[2] = scale0 * az + scale1 * bz;
      out[3] = scale0 * aw + scale1 * bw;
      return Quat.normalize(out, out);
    },

    rotateVec3(out, q, v) {
      const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
      const vx = v[0], vy = v[1], vz = v[2];
      const tx = 2 * (qy * vz - qz * vy);
      const ty = 2 * (qz * vx - qx * vz);
      const tz = 2 * (qx * vy - qy * vx);
      out[0] = vx + qw * tx + (qy * tz - qz * ty);
      out[1] = vy + qw * ty + (qz * tx - qx * tz);
      out[2] = vz + qw * tz + (qx * ty - qy * tx);
      return out;
    },
  };

  DF.Quat = Quat;

  // ---------------------------------------------------------------------------
  // DF.Mat4 — column-major Float32Array(16) matrix math
  // ---------------------------------------------------------------------------
  const Mat4 = {
    create() {
      const out = new Float32Array(16);
      out[0] = 1;
      out[5] = 1;
      out[10] = 1;
      out[15] = 1;
      return out;
    },

    clone(a) {
      return new Float32Array(a);
    },

    identity(out) {
      out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
      out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
      out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
      out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
      return out;
    },

    copy(out, a) {
      out.set(a);
      return out;
    },

    multiply(out, a, b) {
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

      let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
      out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

      b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
      out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

      b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
      out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

      b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
      out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      return out;
    },

    fromTranslation(out, v) {
      out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
      out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
      out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
      out[12] = v[0]; out[13] = v[1]; out[14] = v[2]; out[15] = 1;
      return out;
    },

    translate(out, a, v) {
      const x = v[0], y = v[1], z = v[2];
      if (a === out) {
        out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
        out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
        out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
        out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
      } else {
        const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
        const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
        const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
        out[0] = a00; out[1] = a01; out[2] = a02; out[3] = a03;
        out[4] = a10; out[5] = a11; out[6] = a12; out[7] = a13;
        out[8] = a20; out[9] = a21; out[10] = a22; out[11] = a23;
        out[12] = a00 * x + a10 * y + a20 * z + a[12];
        out[13] = a01 * x + a11 * y + a21 * z + a[13];
        out[14] = a02 * x + a12 * y + a22 * z + a[14];
        out[15] = a03 * x + a13 * y + a23 * z + a[15];
      }
      return out;
    },

    rotateX(out, a, rad) {
      const s = Math.sin(rad);
      const c = Math.cos(rad);
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      if (a !== out) {
        out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
        out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
      }
      out[4] = a10 * c + a20 * s;
      out[5] = a11 * c + a21 * s;
      out[6] = a12 * c + a22 * s;
      out[7] = a13 * c + a23 * s;
      out[8] = a20 * c - a10 * s;
      out[9] = a21 * c - a11 * s;
      out[10] = a22 * c - a12 * s;
      out[11] = a23 * c - a13 * s;
      return out;
    },

    rotateY(out, a, rad) {
      const s = Math.sin(rad);
      const c = Math.cos(rad);
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      if (a !== out) {
        out[4] = a[4]; out[5] = a[5]; out[6] = a[6]; out[7] = a[7];
        out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
      }
      out[0] = a00 * c - a20 * s;
      out[1] = a01 * c - a21 * s;
      out[2] = a02 * c - a22 * s;
      out[3] = a03 * c - a23 * s;
      out[8] = a00 * s + a20 * c;
      out[9] = a01 * s + a21 * c;
      out[10] = a02 * s + a22 * c;
      out[11] = a03 * s + a23 * c;
      return out;
    },

    rotateZ(out, a, rad) {
      const s = Math.sin(rad);
      const c = Math.cos(rad);
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      if (a !== out) {
        out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
        out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
      }
      out[0] = a00 * c + a10 * s;
      out[1] = a01 * c + a11 * s;
      out[2] = a02 * c + a12 * s;
      out[3] = a03 * c + a13 * s;
      out[4] = a10 * c - a00 * s;
      out[5] = a11 * c - a01 * s;
      out[6] = a12 * c - a02 * s;
      out[7] = a13 * c - a03 * s;
      return out;
    },

    rotate(out, a, rad, axis) {
      let x = axis[0], y = axis[1], z = axis[2];
      const len = Math.hypot(x, y, z);
      if (len < 1e-8) return a === out ? out : Mat4.copy(out, a);
      x /= len; y /= len; z /= len;
      const s = Math.sin(rad), c = Math.cos(rad), t = 1 - c;
      const b00 = x * x * t + c, b01 = y * x * t + z * s, b02 = z * x * t - y * s;
      const b10 = x * y * t - z * s, b11 = y * y * t + c, b12 = z * y * t + x * s;
      const b20 = x * z * t + y * s, b21 = y * z * t - x * s, b22 = z * z * t + c;
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      out[0] = a00 * b00 + a10 * b01 + a20 * b02;
      out[1] = a01 * b00 + a11 * b01 + a21 * b02;
      out[2] = a02 * b00 + a12 * b01 + a22 * b02;
      out[3] = a03 * b00 + a13 * b01 + a23 * b02;
      out[4] = a00 * b10 + a10 * b11 + a20 * b12;
      out[5] = a01 * b10 + a11 * b11 + a21 * b12;
      out[6] = a02 * b10 + a12 * b11 + a22 * b12;
      out[7] = a03 * b10 + a13 * b11 + a23 * b12;
      out[8] = a00 * b20 + a10 * b21 + a20 * b22;
      out[9] = a01 * b20 + a11 * b21 + a21 * b22;
      out[10] = a02 * b20 + a12 * b21 + a22 * b22;
      out[11] = a03 * b20 + a13 * b21 + a23 * b22;
      if (a !== out) {
        out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
      }
      return out;
    },

    scale(out, a, v) {
      const x = typeof v === 'number' ? v : v[0];
      const y = typeof v === 'number' ? v : v[1];
      const z = typeof v === 'number' ? v : v[2];
      out[0] = a[0] * x; out[1] = a[1] * x; out[2] = a[2] * x; out[3] = a[3] * x;
      out[4] = a[4] * y; out[5] = a[5] * y; out[6] = a[6] * y; out[7] = a[7] * y;
      out[8] = a[8] * z; out[9] = a[9] * z; out[10] = a[10] * z; out[11] = a[11] * z;
      if (a !== out) {
        out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
      }
      return out;
    },

    // Compose T * Ry(ry) * Rx(rx) * Rz(rz) * S
    fromTRS(out, pos, rotEulerYXZ, scale) {
      const px = pos ? pos[0] : 0;
      const py = pos ? pos[1] : 0;
      const pz = pos ? pos[2] : 0;

      const rx = rotEulerYXZ ? (rotEulerYXZ[0] || 0) : 0;
      const ry = rotEulerYXZ ? (rotEulerYXZ[1] || 0) : 0;
      const rz = rotEulerYXZ ? (rotEulerYXZ[2] || 0) : 0;

      let sx = 1, sy = 1, sz = 1;
      if (typeof scale === 'number') {
        sx = sy = sz = scale;
      } else if (scale) {
        sx = scale[0]; sy = scale[1]; sz = scale[2];
      }

      const cx = Math.cos(rx), sxr = Math.sin(rx);
      const cy = Math.cos(ry), syr = Math.sin(ry);
      const cz = Math.cos(rz), szr = Math.sin(rz);

      // Column 0
      out[0] = (cy * cz + syr * sxr * szr) * sx;
      out[1] = (cx * szr) * sx;
      out[2] = (-syr * cz + cy * sxr * szr) * sx;
      out[3] = 0;

      // Column 1
      out[4] = (-cy * szr + syr * sxr * cz) * sy;
      out[5] = (cx * cz) * sy;
      out[6] = (syr * szr + cy * sxr * cz) * sy;
      out[7] = 0;

      // Column 2
      out[8] = (syr * cx) * sz;
      out[9] = (-sxr) * sz;
      out[10] = (cy * cx) * sz;
      out[11] = 0;

      // Column 3
      out[12] = px;
      out[13] = py;
      out[14] = pz;
      out[15] = 1;
      return out;
    },

    fromQuatPosScale(out, q, pos, scale) {
      const x = q[0], y = q[1], z = q[2], w = q[3];
      const x2 = x + x, y2 = y + y, z2 = z + z;
      const xx = x * x2, xy = x * y2, xz = x * z2;
      const yy = y * y2, yz = y * z2, zz = z * z2;
      const wx = w * x2, wy = w * y2, wz = w * z2;

      let sx = 1, sy = 1, sz = 1;
      if (typeof scale === 'number') {
        sx = sy = sz = scale;
      } else if (scale) {
        sx = scale[0]; sy = scale[1]; sz = scale[2];
      }

      out[0] = (1 - (yy + zz)) * sx;
      out[1] = (xy + wz) * sx;
      out[2] = (xz - wy) * sx;
      out[3] = 0;

      out[4] = (xy - wz) * sy;
      out[5] = (1 - (xx + zz)) * sy;
      out[6] = (yz + wx) * sy;
      out[7] = 0;

      out[8] = (xz + wy) * sz;
      out[9] = (yz - wx) * sz;
      out[10] = (1 - (xx + yy)) * sz;
      out[11] = 0;

      out[12] = pos ? pos[0] : 0;
      out[13] = pos ? pos[1] : 0;
      out[14] = pos ? pos[2] : 0;
      out[15] = 1;
      return out;
    },

    perspective(out, fovy, aspect, near, far) {
      const f = 1.0 / Math.tan(fovy * 0.5);
      const nf = 1.0 / (near - far);
      out[0] = f / Math.max(aspect, 1e-4);
      out[1] = 0; out[2] = 0; out[3] = 0;
      out[4] = 0;
      out[5] = f;
      out[6] = 0; out[7] = 0;
      out[8] = 0; out[9] = 0;
      out[10] = (far + near) * nf;
      out[11] = -1;
      out[12] = 0; out[13] = 0;
      out[14] = 2 * far * near * nf;
      out[15] = 0;
      return out;
    },

    ortho(out, l, r, b, t, n, f) {
      const lr = 1 / (l - r);
      const bt = 1 / (b - t);
      const nf = 1 / (n - f);
      out[0] = -2 * lr; out[1] = 0; out[2] = 0; out[3] = 0;
      out[4] = 0; out[5] = -2 * bt; out[6] = 0; out[7] = 0;
      out[8] = 0; out[9] = 0; out[10] = 2 * nf; out[11] = 0;
      out[12] = (l + r) * lr;
      out[13] = (t + b) * bt;
      out[14] = (f + n) * nf;
      out[15] = 1;
      return out;
    },

    lookAt(out, eye, center, up) {
      const eyex = eye[0], eyey = eye[1], eyez = eye[2];
      const upx = up ? up[0] : 0, upy = up ? up[1] : 1, upz = up ? up[2] : 0;
      let z0 = eyex - center[0];
      let z1 = eyey - center[1];
      let z2 = eyez - center[2];
      let len = Math.hypot(z0, z1, z2);
      if (len < 1e-8) {
        return Mat4.identity(out);
      }
      z0 /= len; z1 /= len; z2 /= len;

      let x0 = upy * z2 - upz * z1;
      let x1 = upz * z0 - upx * z2;
      let x2 = upx * z1 - upy * z0;
      len = Math.hypot(x0, x1, x2);
      if (len < 1e-8) {
        // Fallback up vector if looking straight up/down
        x0 = z2; x1 = 0; x2 = -z0;
        len = Math.hypot(x0, x1, x2) || 1;
      }
      x0 /= len; x1 /= len; x2 /= len;

      let y0 = z1 * x2 - z2 * x1;
      let y1 = z2 * x0 - z0 * x2;
      let y2 = z0 * x1 - z1 * x0;
      len = Math.hypot(y0, y1, y2) || 1;
      y0 /= len; y1 /= len; y2 /= len;

      out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
      out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
      out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
      out[12] = -(x0 * eyex + x1 * eyey + x2 * eyez);
      out[13] = -(y0 * eyex + y1 * eyey + y2 * eyez);
      out[14] = -(z0 * eyex + z1 * eyey + z2 * eyez);
      out[15] = 1;
      return out;
    },

    invert(out, a) {
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

      const b00 = a00 * a11 - a01 * a10;
      const b01 = a00 * a12 - a02 * a10;
      const b02 = a00 * a13 - a03 * a10;
      const b03 = a01 * a12 - a02 * a11;
      const b04 = a01 * a13 - a03 * a11;
      const b05 = a02 * a13 - a03 * a12;
      const b06 = a20 * a31 - a21 * a30;
      const b07 = a20 * a32 - a22 * a30;
      const b08 = a20 * a33 - a23 * a30;
      const b09 = a21 * a32 - a22 * a31;
      const b10 = a21 * a33 - a23 * a31;
      const b11 = a22 * a33 - a23 * a32;

      let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      if (Math.abs(det) < 1e-12) {
        Mat4.identity(out);
        return null;
      }
      det = 1.0 / det;

      out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
      out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
      out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
      out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
      out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
      out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
      out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
      out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
      out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
      out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
      out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
      out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
      out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
      out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
      out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
      out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
      return out;
    },

    transpose(out, a) {
      if (out === a) {
        let t;
        t = a[1]; a[1] = a[4]; a[4] = t;
        t = a[2]; a[2] = a[8]; a[8] = t;
        t = a[3]; a[3] = a[12]; a[12] = t;
        t = a[6]; a[6] = a[9]; a[9] = t;
        t = a[7]; a[7] = a[13]; a[13] = t;
        t = a[11]; a[11] = a[14]; a[14] = t;
      } else {
        out[0] = a[0]; out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
        out[4] = a[1]; out[5] = a[5]; out[6] = a[9]; out[7] = a[13];
        out[8] = a[2]; out[9] = a[6]; out[10] = a[10]; out[11] = a[14];
        out[12] = a[3]; out[13] = a[7]; out[14] = a[11]; out[15] = a[15];
      }
      return out;
    },

    transformPoint(out, m, v) {
      const x = v[0], y = v[1], z = v[2];
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      const invW = Math.abs(w) > 1e-8 ? 1 / w : 1;
      out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * invW;
      out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * invW;
      out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * invW;
      return out;
    },

    transformDir(out, m, v) {
      const x = v[0], y = v[1], z = v[2];
      out[0] = m[0] * x + m[4] * y + m[8] * z;
      out[1] = m[1] * x + m[5] * y + m[9] * z;
      out[2] = m[2] * x + m[6] * y + m[10] * z;
      return out;
    },

    getTranslation(out, m) {
      out[0] = m[12];
      out[1] = m[13];
      out[2] = m[14];
      return out;
    },
  };

  DF.Mat4 = Mat4;

  // ---------------------------------------------------------------------------
  // DF.Events — lightweight synchronous event bus
  // ---------------------------------------------------------------------------
  const _listeners = Object.create(null);

  DF.Events = {
    on(evt, fn) {
      if (typeof fn !== 'function') return () => {};
      let list = _listeners[evt];
      if (!list) list = _listeners[evt] = [];
      if (list.indexOf(fn) === -1) list.push(fn);
      return () => DF.Events.off(evt, fn);
    },

    once(evt, fn) {
      if (typeof fn !== 'function') return () => {};
      const wrapper = (data) => {
        DF.Events.off(evt, wrapper);
        fn(data);
      };
      return DF.Events.on(evt, wrapper);
    },

    off(evt, fn) {
      const list = _listeners[evt];
      if (!list) return;
      if (!fn) {
        delete _listeners[evt];
        return;
      }
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) delete _listeners[evt];
    },

    emit(evt, data) {
      const list = _listeners[evt];
      if (!list || list.length === 0) return;
      const snap = list.slice();
      for (let i = 0; i < snap.length; i++) {
        snap[i](data);
      }
    },

    clear() {
      for (const k in _listeners) delete _listeners[k];
    },
  };
})();
