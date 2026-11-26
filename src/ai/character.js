(() => {
  'use strict';
  const DF = (window.DF = window.DF || {});

  // ---------------------------------------------------------------------------
  // DF.Character — AAA Articulated 3D Combat Operator Mesh Library & IK Animator
  // Coordinate system: Right-handed Y-up, 1 unit = 1 meter.
  // Soldier local space: Forward = -Z, Right = +X, Up = +Y.
  // Rotation sign convention for Euler YXZ (Ry * Rx * Rz):
  //   Rx(+a) maps (0, +1, 0) -> (0, cos a, +sin a)  [+Y tilts backward +Z]
  //   Rx(+a) maps (0, -1, 0) -> (0, -cos a, -sin a) [-Y hanging limb swings FORWARD -Z]
  //   Rx(+a) maps (0, 0, -1) -> (0, +sin a, -cos a) [-Z forward vector pitches UP +Y]
  //   Therefore for hanging legs: thighX > 0 swings forward (-Z), calfX <= 0 bends knee BACKWARD (+Z).
  //   Arms use an exact analytical 2-bone IK solver locking both gloved hands cleanly
  //   onto the weapon pistol grip & handguard across every combat stance & aim pitch!
  // ---------------------------------------------------------------------------

  const L_THIGH = 0.44;
  const L_CALF = 0.46; // 0.44 + 0.46 = 0.90m exact standing hip height
  const L_UPPER_ARM = 0.30;
  const L_FOREARM = 0.28;

  // Pre-allocated zero-GC matrix ring pool (1024 matrices = 64 KB) so every
  // renderer.submitMesh() receives its own distinct Float32Array(16) reference.
  const MAT_POOL_SIZE = 1024;
  const _matPool = new Array(MAT_POOL_SIZE);
  for (let i = 0; i < MAT_POOL_SIZE; i++) {
    _matPool[i] = new Float32Array(16);
  }
  let _matCursor = 0;
  function allocMat() {
    const m = _matPool[_matCursor];
    _matCursor = (_matCursor + 1) & (MAT_POOL_SIZE - 1);
    return m;
  }

  // Scratch matrices & vectors for intermediate composition (never submitted directly)
  const _mRoot = new Float32Array(16);
  const _mLocal = new Float32Array(16);
  const _mTmp = new Float32Array(16);
  const _mWpnTorso = new Float32Array(16);
  const _mSegL1 = new Float32Array(16);
  const _mSegL2 = new Float32Array(16);
  const _mSegR1 = new Float32Array(16);
  const _mSegR2 = new Float32Array(16);

  let _gl = null;
  let _initialized = false;
  let _meshes = null;

  function clamp(v, a, b) {
    return v < a ? a : (v > b ? b : v);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function matMul(out, a, b) {
    if (DF.Mat4 && DF.Mat4.multiply) {
      return DF.Mat4.multiply(out, a, b);
    }
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    let b0, b1, b2, b3;
    b0 = b[0]; b1 = b[1]; b2 = b[2]; b3 = b[3];
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
  }

  // Column-major TRS with Euler YXZ: T * Ry * Rx * Rz * S
  function matFromTRS(out, px, py, pz, rx, ry, rz, sx, sy, sz) {
    const cx = Math.cos(rx), sxr = Math.sin(rx);
    const cy = Math.cos(ry), syr = Math.sin(ry);
    const cz = Math.cos(rz), szr = Math.sin(rz);

    const r00 = cy * cz + syr * sxr * szr;
    const r01 = cx * szr;
    const r02 = -syr * cz + cy * sxr * szr;

    const r10 = -cy * szr + syr * sxr * cz;
    const r11 = cx * cz;
    const r12 = syr * szr + cy * sxr * cz;

    const r20 = syr * cx;
    const r21 = -sxr;
    const r22 = cy * cx;

    out[0] = r00 * sx; out[1] = r01 * sx; out[2] = r02 * sx; out[3] = 0;
    out[4] = r10 * sy; out[5] = r11 * sy; out[6] = r12 * sy; out[7] = 0;
    out[8] = r20 * sz; out[9] = r21 * sz; out[10] = r22 * sz; out[11] = 0;
    out[12] = px;      out[13] = py;      out[14] = pz;      out[15] = 1;
    return out;
  }

  function makeChild(out, parent, px, py, pz, rx, ry, rz) {
    matFromTRS(_mLocal, px, py, pz, rx, ry, rz, 1, 1, 1);
    return matMul(out, parent, _mLocal);
  }

  function transformPt(m, x, y, z, out) {
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    return out;
  }

  // Build right-handed orthonormal segment matrix whose origin is A and local -Y points from A -> B.
  // Local +Z aligns toward hintZ (e.g. outward elbow pad / rear sleeve).
  function buildLimbMatrix(out, ax, ay, az, bx, by, bz, hintX, hintY, hintZ) {
    // yAxis = normalize(A - B) so (0, -L, 0) maps cleanly to B
    let yx = ax - bx, yy = ay - by, yz = az - bz;
    let yLen = Math.hypot(yx, yy, yz);
    if (yLen < 1e-5) { yx = 0; yy = 1; yz = 0; yLen = 1; }
    yx /= yLen; yy /= yLen; yz /= yLen;

    // xAxis = normalize(cross(yAxis, hint))
    let xx = yy * hintZ - yz * hintY;
    let xy = yz * hintX - yx * hintZ;
    let xz = yx * hintY - yy * hintX;
    let xLen = Math.hypot(xx, xy, xz);
    if (xLen < 1e-4) {
      // Fallback perpendicular if hint is collinear with limb
      const fx = Math.abs(yy) < 0.9 ? 0 : 1;
      const fy = Math.abs(yy) < 0.9 ? 1 : 0;
      const fz = 0;
      xx = yy * fz - yz * fy;
      xy = yz * fx - yx * fz;
      xz = yx * fy - yy * fx;
      xLen = Math.hypot(xx, xy, xz) || 1;
    }
    xx /= xLen; xy /= xLen; xz /= xLen;

    // zAxis = cross(xAxis, yAxis) -> strict right-handed determinant = +1
    const zx = xy * yz - xz * yy;
    const zy = xz * yx - xx * yz;
    const zz = xx * yy - xy * yx;

    out[0] = xx; out[1] = xy; out[2] = xz; out[3] = 0;
    out[4] = yx; out[5] = yy; out[6] = yz; out[7] = 0;
    out[8] = zx; out[9] = zy; out[10] = zz; out[11] = 0;
    out[12] = ax; out[13] = ay; out[14] = az; out[15] = 1;
    return out;
  }

  // Exact analytical 2-bone arm IK solver in torso local space!
  // Locks shoulder S -> elbow E -> hand H cleanly with zero gimbal lock or backward elbows.
  function solveTwoBoneArm(outUpperLocal, outForeLocal, sx, sy, sz, hx, hy, hz, poleX, poleY, poleZ, lenA, lenB) {
    let dx = hx - sx, dy = hy - sy, dz = hz - sz;
    let dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-4) { dx = 0; dy = -0.1; dz = -0.1; dist = Math.hypot(dx, dy, dz); }
    const maxReach = lenA + lenB - 0.005;
    const minReach = Math.abs(lenA - lenB) + 0.04;
    const clampedD = clamp(dist, minReach, maxReach);
    const ux = dx / dist, uy = dy / dist, uz = dz / dist;

    // Clamped reachable hand position
    const thx = sx + ux * clampedD;
    const thy = sy + uy * clampedD;
    const thz = sz + uz * clampedD;

    // Law of cosines at shoulder
    const cosA = clamp((lenA * lenA + clampedD * clampedD - lenB * lenB) / (2 * lenA * clampedD), -1, 1);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));

    // Pole vector projected perpendicular to shoulder->hand axis u
    let pvx = poleX - sx, pvy = poleY - sy, pvz = poleZ - sz;
    const dotPU = pvx * ux + pvy * uy + pvz * uz;
    pvx -= ux * dotPU;
    pvy -= uy * dotPU;
    pvz -= uz * dotPU;
    let pvLen = Math.hypot(pvx, pvy, pvz);
    if (pvLen < 1e-4) { pvx = 0; pvy = -1; pvz = 0.2; pvLen = Math.hypot(pvx, pvy, pvz); }
    pvx /= pvLen; pvy /= pvLen; pvz /= pvLen;

    // Exact elbow joint E in torso local space
    const ex = sx + ux * (lenA * cosA) + pvx * (lenA * sinA);
    const ey = sy + uy * (lenA * cosA) + pvy * (lenA * sinA);
    const ez = sz + uz * (lenA * cosA) + pvz * (lenA * sinA);

    // Orient upper arm (S -> E) & forearm (E -> H) with +Z elbow pad facing pole direction
    buildLimbMatrix(outUpperLocal, sx, sy, sz, ex, ey, ez, pvx, pvy, pvz);
    buildLimbMatrix(outForeLocal, ex, ey, ez, thx, thy, thz, pvx, pvy, pvz);
  }

  function addBev(b, cx, cy, cz, sx, sy, sz, bevel, opts) {
    if (typeof b.addBeveledBox === 'function') {
      b.addBeveledBox(cx, cy, cz, sx, sy, sz, bevel, opts);
    } else {
      b.addBox(cx, cy, cz, sx, sy, sz, opts);
    }
  }

  function finalizeBuilder(b, gl) {
    if (typeof b.computeTangents === 'function') b.computeTangents();
    return b.build(gl);
  }

  // ---------------------------------------------------------------------------
  // Faction Palettes (High-Contrast Friend vs Foe Uniforms + Reflective Tactical ID Tape)
  // ---------------------------------------------------------------------------
  const PALETTES = {
    UA: {
      uniformTex: 'uniform_ua',
      armorTex: 'armor_ua',
      uniformTint: [1.18, 1.12, 0.96],       // Brighter warm desert-tan / light MM-14 multicam
      uniformDark: [0.98, 0.92, 0.78],
      vestTint: [0.86, 0.72, 0.50],          // Warm coyote-tan plate carrier
      pouchTint: [0.76, 0.63, 0.44],
      helmetTint: [0.84, 0.72, 0.52],        // Warm desert-tan Ops-Core FAST helmet
      packTint: [0.76, 0.64, 0.46],
      bootTint: [0.54, 0.43, 0.30],          // Coyote suede combat boots
      gloveTint: [0.28, 0.25, 0.21],
      balaclavaTint: [0.34, 0.34, 0.27],
      uniformMatColor: [1.12, 1.08, 0.98],
      armorMatColor: [1.10, 1.05, 0.96],
      idPrimary: [0.14, 0.60, 1.00],         // Bold Blue-Team Cobalt-Cyan tactical tape
      idSecondary: [0.92, 0.96, 1.00],       // Crisp White tactical contrast tape
      idPriMatColor: [0.18, 0.72, 1.42],     // Pure vibrant tactical blue over neutral plaster base
      idSecMatColor: [1.34, 1.38, 1.42],     // Pure crisp ice-white over neutral plaster base
      idPriEmissive: [0.04, 0.16, 0.32],     // Subtle reflective lift in deep building shadows
      idSecEmissive: [0.14, 0.18, 0.22],
      weaponBody: [0.19, 0.20, 0.22],
      weaponAccent: [0.54, 0.46, 0.34]       // FDE furniture accent
    },
    RU: {
      uniformTex: 'uniform_ru',
      armorTex: 'armor_ru',
      uniformTint: [0.46, 0.54, 0.44],       // Distinctly darker charcoal-forest EMR olive
      uniformDark: [0.35, 0.42, 0.34],
      vestTint: [0.22, 0.26, 0.20],          // Dark charcoal-green 6B45 armor vest
      pouchTint: [0.18, 0.22, 0.17],
      helmetTint: [0.20, 0.25, 0.19],        // Dark charcoal-green 6B47 Ratnik helmet
      packTint: [0.20, 0.24, 0.19],
      bootTint: [0.11, 0.11, 0.12],          // Deep black Ratnik combat boots
      gloveTint: [0.14, 0.15, 0.14],
      balaclavaTint: [0.14, 0.17, 0.14],
      uniformMatColor: [0.82, 0.86, 0.80],
      armorMatColor: [0.78, 0.82, 0.76],
      idPrimary: [0.94, 0.12, 0.12],         // High-contrast Crimson-Red assault tape
      idSecondary: [0.96, 0.96, 0.94],       // Crisp White tactical tape
      idPriMatColor: [1.36, 0.15, 0.15],     // Pure crimson red over neutral plaster base
      idSecMatColor: [1.36, 1.36, 1.33],     // Pure crisp white over neutral plaster base
      idPriEmissive: [0.24, 0.03, 0.03],     // Subtle reflective lift in deep building shadows
      idSecEmissive: [0.16, 0.16, 0.16],
      weaponBody: [0.15, 0.15, 0.17],
      weaponAccent: [0.36, 0.21, 0.15]       // Plum/bakelite/wood AK accent
    }
  };

  // Per-weapon exact left-hand forend grip anchor & muzzle tip (in weapon local space)
  // Weapon local space: right hand pistol grip sits at (0, 0, 0), barrel points along -Z, optic is +Y!
  const WEAPON_SPECS = [
    // 0: AR (M4A1 / AK-74M)
    { leftGrip: [-0.015, 0.045, -0.32], muzzleZ: -0.76, muzzleY: 0.068, shoulderOff: [0.120, 0.345, -0.175] },
    // 1: LMG (M249 / PKM)
    { leftGrip: [-0.025, 0.025, -0.34], muzzleZ: -0.90, muzzleY: 0.080, shoulderOff: [0.130, 0.325, -0.175] },
    // 2: Sniper (M24 / SVD)
    { leftGrip: [-0.015, 0.040, -0.34], muzzleZ: -1.04, muzzleY: 0.068, shoulderOff: [0.118, 0.348, -0.165] },
    // 3: Shotgun (M870 / Saiga-12K)
    { leftGrip: [-0.015, 0.038, -0.33], muzzleZ: -0.76, muzzleY: 0.072, shoulderOff: [0.120, 0.342, -0.175] },
    // 4: GL (M320 / GP-25)
    { leftGrip: [-0.015, 0.032, -0.25], muzzleZ: -0.50, muzzleY: 0.068, shoulderOff: [0.120, 0.335, -0.175] },
    // 5: RPG-7V2 (over right shoulder!)
    { leftGrip: [-0.010, 0.015, -0.24], muzzleZ: -0.88, muzzleY: 0.105, shoulderOff: [0.190, 0.368, -0.130] }
  ];

  // ---------------------------------------------------------------------------
  // AAA Sculpted Combat Operator Mesh Builders
  // ---------------------------------------------------------------------------
  function buildFactionMeshes(gl, faction) {
    const P = PALETTES[faction];
    const isUA = faction === 'UA';
    const B = DF.MeshGen.Builder;
    const m = {};

    // 1. Sculpted Pelvis, Tactical War Belt, Kydex Holster & Belt Pouches
    {
      const b = new B();
      // Fuller athletic pelvis & smooth hip transition into muscular thighs
      addBev(b, 0, 0.012, 0.0, 0.335, 0.168, 0.212, 0.040, { color: P.uniformTint, aoBottom: 0.82 });
      b.addSphere(-0.105, -0.032, 0.0, 0.098, 12, 8, { color: P.uniformDark, scale: [1.02, 1.0, 1.05] });
      b.addSphere(0.105, -0.032, 0.0, 0.098, 12, 8, { color: P.uniformDark, scale: [1.02, 1.0, 1.05] });
      // Contoured MOLLE padded battle belt
      addBev(b, 0, 0.064, 0.0, 0.352, 0.062, 0.228, 0.018, { color: P.vestTint });
      // Cobra quick-release metal belt buckle (-Z front)
      addBev(b, 0, 0.064, -0.118, 0.058, 0.044, 0.018, 0.004, { color: [0.15, 0.15, 0.16] });
      // Dual pistol mag pouches on left hip (-X)
      addBev(b, -0.178, 0.060, -0.045, 0.026, 0.082, 0.034, 0.005, { color: P.pouchTint });
      addBev(b, -0.178, 0.060, 0.005, 0.026, 0.082, 0.034, 0.005, { color: P.pouchTint });
      // Rear canvas dump pouch & IFAK trauma kit with red pull tab (+Z)
      addBev(b, -0.075, 0.010, 0.126, 0.102, 0.130, 0.052, 0.016, { color: P.pouchTint });
      addBev(b, 0.082, 0.045, 0.122, 0.088, 0.090, 0.046, 0.014, { color: P.pouchTint });
      addBev(b, 0.082, 0.084, 0.144, 0.026, 0.018, 0.010, 0.002, { color: [0.80, 0.14, 0.12] });
      // Right-hip drop Kydex holster + sidearm grip (+X)
      addBev(b, 0.178, -0.025, -0.015, 0.040, 0.122, 0.070, 0.010, { color: [0.19, 0.19, 0.18] });
      addBev(b, 0.182, 0.035, 0.026, 0.026, 0.062, 0.036, 0.006, { color: [0.14, 0.14, 0.15], rotX: 0.35 });
      if (!isUA) {
        // RU 6B45 tapered ballistic groin protector
        addBev(b, 0, -0.076, -0.108, 0.156, 0.128, 0.028, 0.010, { color: P.vestTint });
      }
      m.pelvis = finalizeBuilder(b, gl);
    }

    // 2. Sculpted Athletic Upper Torso + Angled SAPI Plate Carrier + MOLLE + Assault Pack
    {
      const b = new B();
      // Tapered athletic torso core: narrower waist (lower) expanding smoothly to broad chest & shoulders!
      addBev(b, 0, 0.115, 0.0, 0.295, 0.21, 0.185, 0.042, { color: P.uniformDark, aoBottom: 0.78 });
      addBev(b, 0, 0.295, 0.0, 0.355, 0.24, 0.205, 0.048, { color: P.uniformTint });
      // Sculpted trapezius / collarbone shoulder yoke
      addBev(b, 0, 0.425, 0.0, 0.385, 0.095, 0.185, 0.035, { color: P.uniformTint });
      b.addCylinder(0, 0.472, 0.0, 0.074, 0.088, 0.055, 14, { axis: 'y', color: P.uniformDark });

      // Multi-part Contoured Ballistic Plate Carrier (tapered upper SAPI cut — NOT a square box!)
      const vestW = isUA ? 0.285 : 0.320;
      const vestH = isUA ? 0.315 : 0.345;
      addBev(b, 0, 0.235, -0.108, vestW, vestH * 0.75, 0.044, 0.016, { color: P.vestTint });
      addBev(b, 0, 0.370, -0.102, vestW * 0.76, vestH * 0.30, 0.038, 0.014, { color: P.vestTint });
      addBev(b, 0, 0.245, 0.108, vestW, vestH * 0.80, 0.044, 0.016, { color: P.vestTint });
      addBev(b, 0, 0.375, 0.102, vestW * 0.76, vestH * 0.28, 0.038, 0.014, { color: P.vestTint });

      // Padded shoulder straps & side skeletal MOLLE cummerbund
      addBev(b, 0.112, 0.452, 0.0, 0.068, 0.038, 0.215, 0.012, { color: P.vestTint });
      addBev(b, -0.112, 0.452, 0.0, 0.068, 0.038, 0.215, 0.012, { color: P.vestTint });
      addBev(b, 0.172, 0.175, 0.0, 0.038, 0.145, 0.205, 0.012, { color: P.vestTint });
      addBev(b, -0.172, 0.175, 0.0, 0.038, 0.145, 0.205, 0.012, { color: P.vestTint });

      // Front rifle magazine pouches with protruding curved mags!
      const pouchCount = isUA ? 3 : 4;
      const spacing = isUA ? 0.084 : 0.068;
      const startX = -((pouchCount - 1) * spacing) * 0.5;
      for (let i = 0; i < pouchCount; i++) {
        const px = startX + i * spacing;
        addBev(b, px, 0.165, -0.144, 0.056, 0.125, 0.042, 0.009, { color: P.pouchTint });
        // Protruding magazine top inside pouch
        addBev(b, px, 0.238, -0.144, 0.040, 0.036, 0.026, 0.005, {
          color: isUA ? [0.22, 0.21, 0.19] : [0.44, 0.22, 0.15]
        });
      }
      // Admin chest pouch, tourniquet & PTT radio switch
      addBev(b, 0, 0.312, -0.138, 0.138, 0.068, 0.028, 0.008, { color: P.pouchTint });
      addBev(b, -0.128, 0.345, -0.125, 0.032, 0.055, 0.026, 0.005, { color: [0.15, 0.16, 0.17] });
      // Tactical comms radio on left rear-side + flexible whip antenna
      addBev(b, -0.162, 0.255, 0.085, 0.046, 0.125, 0.050, 0.008, { color: [0.16, 0.17, 0.18] });
      b.addCylinder(-0.162, 0.485, 0.095, 0.004, 0.006, 0.36, 6, { axis: 'y', rotX: 0.08, color: [0.12, 0.12, 0.13] });

      // Slim Zip-On Tactical Assault Pack (+Z back — ~30% slimmer profile hugging plate carrier)
      addBev(b, 0, 0.258, 0.156, 0.238, 0.32, 0.080, 0.024, { color: P.packTint });
      addBev(b, 0, 0.180, 0.198, 0.188, 0.140, 0.032, 0.012, { color: P.pouchTint });
      // Compression straps on pack
      addBev(b, -0.068, 0.258, 0.200, 0.016, 0.26, 0.008, 0.002, { color: [0.18, 0.18, 0.18] });
      addBev(b, 0.068, 0.258, 0.200, 0.016, 0.26, 0.008, 0.002, { color: [0.18, 0.18, 0.18] });
      if (!isUA) {
        // RU Ratnik compact rolled mat strapped under pack
        b.addCylinder(0, 0.078, 0.172, 0.036, 0.036, 0.255, 12, { axis: 'x', color: [0.24, 0.28, 0.21] });
      }

      m.torso = finalizeBuilder(b, gl);

      // Dedicated High-Vis Reflective Tactical ID Tape (Chest + Shoulder Straps + Rear Pack)
      const bIdPriT = new B();
      const bIdSecT = new B();
      // Bold chest upper ID bar + lower secondary stripe (front -Z, clear of admin pouch)
      addBev(bIdPriT, 0.0, 0.334, -0.157, 0.158, 0.036, 0.010, 0.002, { color: [1, 1, 1] });
      addBev(bIdSecT, 0.0, 0.296, -0.157, 0.148, 0.024, 0.010, 0.002, { color: [1, 1, 1] });
      // Shoulder strap high-vis front/top pips
      addBev(bIdPriT, 0.112, 0.472, -0.025, 0.064, 0.010, 0.068, 0.002, { color: [1, 1, 1] });
      addBev(bIdPriT, -0.112, 0.472, -0.025, 0.064, 0.010, 0.068, 0.002, { color: [1, 1, 1] });
      // Bold rear assault pack dual horizontal tactical bands (+Z back)
      addBev(bIdPriT, 0.0, 0.370, 0.203, 0.205, 0.044, 0.010, 0.002, { color: [1, 1, 1] });
      addBev(bIdSecT, 0.0, 0.326, 0.203, 0.205, 0.028, 0.010, 0.002, { color: [1, 1, 1] });
      m.idPriTorso = finalizeBuilder(bIdPriT, gl);
      m.idSecTorso = finalizeBuilder(bIdSecT, gl);
    }

    // 2b. Role Specialty Pack Add-ons (hug slimmed assault pack closely)
    {
      // Medic trauma pack with geometric red/white cross
      const bMed = new B();
      addBev(bMed, 0, 0.260, 0.214, 0.165, 0.180, 0.040, 0.012, { color: [0.88, 0.88, 0.85] });
      addBev(bMed, 0, 0.260, 0.236, 0.090, 0.026, 0.008, 0.002, { color: [0.84, 0.12, 0.12] });
      addBev(bMed, 0, 0.260, 0.236, 0.026, 0.090, 0.008, 0.002, { color: [0.84, 0.12, 0.12] });
      m.roleMedic = finalizeBuilder(bMed, gl);

      // AT spare PG-7V rocket strapped diagonally across assault pack
      const bAt = new B();
      bAt.addCylinder(0.05, 0.34, 0.195, 0.018, 0.018, 0.56, 10, { axis: 'y', rotZ: 0.34, color: [0.27, 0.32, 0.21] });
      bAt.addCylinder(-0.04, 0.53, 0.195, 0.012, 0.036, 0.14, 10, { axis: 'y', rotZ: 0.34, color: [0.30, 0.36, 0.22] });
      bAt.addCylinder(-0.07, 0.61, 0.195, 0.036, 0.009, 0.11, 10, { axis: 'y', rotZ: 0.34, color: [0.28, 0.34, 0.21] });
      m.roleAT = finalizeBuilder(bAt, gl);

      // Sniper draped shoulder scrim / hood
      const bSnip = new B();
      addBev(bSnip, 0, 0.445, 0.025, 0.42, 0.082, 0.23, 0.032, { color: isUA ? [0.46, 0.49, 0.34] : [0.26, 0.33, 0.23] });
      addBev(bSnip, 0, 0.375, 0.135, 0.33, 0.145, 0.052, 0.022, { color: isUA ? [0.43, 0.45, 0.31] : [0.24, 0.31, 0.21] });
      m.roleSniper = finalizeBuilder(bSnip, gl);
    }

    // 3. Anatomically Sculpted Head + Balaclava + Ballistic Eyewear & Detailed Helmet
    {
      const bHead = new B();
      // Neck
      bHead.addCylinder(0, 0.038, 0.005, 0.052, 0.060, 0.088, 12, { axis: 'y', color: [0.84, 0.67, 0.55] });
      // Anatomical ellipsoid cranium & contoured face/jaw
      bHead.addSphere(0, 0.148, -0.002, 0.098, 16, 12, { color: [0.85, 0.68, 0.56], scale: [0.88, 1.04, 0.98] });
      bHead.addSphere(0, 0.098, -0.036, 0.068, 12, 8, { color: [0.83, 0.65, 0.53], scale: [0.88, 0.92, 0.96] });
      // Subtle nose bridge & brow contour facing -Z
      addBev(bHead, 0, 0.134, -0.096, 0.022, 0.032, 0.024, 0.006, { color: [0.83, 0.65, 0.53] });
      // Tactical half-face balaclava / neck gaiter
      bHead.addCylinder(0, 0.080, -0.015, 0.076, 0.072, 0.092, 14, { axis: 'y', color: P.balaclavaTint });
      bHead.addSphere(0, 0.095, -0.044, 0.066, 12, 8, { color: P.balaclavaTint, scale: [0.96, 0.78, 0.92] });
      // Wrap-around dark ballistic shooting glasses / goggles (-Z)
      addBev(bHead, 0, 0.152, -0.089, 0.138, 0.040, 0.036, 0.010, { color: [0.09, 0.10, 0.13] });
      addBev(bHead, 0.068, 0.152, -0.052, 0.016, 0.020, 0.082, 0.004, { color: [0.16, 0.16, 0.17] });
      addBev(bHead, -0.068, 0.152, -0.052, 0.016, 0.020, 0.082, 0.004, { color: [0.16, 0.16, 0.17] });
      m.head = finalizeBuilder(bHead, gl);

      // Detailed Ballistic Helmet
      const bHelm = new B();
      if (isUA) {
        // Ops-Core FAST High-Cut Ballistic Dome
        bHelm.addSphere(0, 0.176, 0.006, 0.122, 18, 12, { hemi: 'top', color: P.helmetTint, scale: [0.95, 0.96, 1.04] });
        bHelm.addCylinder(0, 0.164, 0.012, 0.117, 0.123, 0.048, 16, { axis: 'y', color: P.helmetTint });
        // Rear nape ballistic drop + counterweight battery pack
        addBev(bHelm, 0, 0.136, 0.104, 0.145, 0.068, 0.052, 0.016, { color: P.helmetTint });
        addBev(bHelm, 0, 0.152, 0.132, 0.076, 0.046, 0.028, 0.006, { color: [0.22, 0.21, 0.19] });
        // Side ARC rails
        addBev(bHelm, 0.118, 0.156, -0.008, 0.016, 0.028, 0.125, 0.004, { color: [0.22, 0.21, 0.19] });
        addBev(bHelm, -0.118, 0.156, -0.008, 0.016, 0.028, 0.125, 0.004, { color: [0.22, 0.21, 0.19] });
        // Active Peltor ComTac ear-pro headset + boom microphone
        addBev(bHelm, 0.112, 0.122, 0.008, 0.036, 0.070, 0.058, 0.012, { color: [0.25, 0.24, 0.20] });
        addBev(bHelm, -0.112, 0.122, 0.008, 0.036, 0.070, 0.058, 0.012, { color: [0.25, 0.24, 0.20] });
        bHelm.addCylinder(-0.075, 0.095, -0.060, 0.005, 0.005, 0.095, 6, { axis: 'z', rotY: -0.62, color: [0.14, 0.14, 0.15] });
        // Wilcox front NVG shroud + folded dual-tube PVS-31 night vision mount
        addBev(bHelm, 0, 0.202, -0.120, 0.044, 0.048, 0.022, 0.005, { color: [0.15, 0.16, 0.17] });
        addBev(bHelm, 0, 0.232, -0.132, 0.078, 0.022, 0.026, 0.004, { color: [0.16, 0.17, 0.18] });
        bHelm.addCylinder(0.026, 0.236, -0.154, 0.014, 0.015, 0.068, 10, { axis: 'z', color: [0.13, 0.14, 0.16] });
        bHelm.addCylinder(-0.026, 0.236, -0.154, 0.014, 0.015, 0.068, 10, { axis: 'z', color: [0.13, 0.14, 0.16] });
        // IR Strobe on helmet crown
        addBev(bHelm, 0, 0.292, 0.018, 0.038, 0.018, 0.052, 0.004, { color: [0.20, 0.20, 0.19] });
      } else {
        // RU 6B47 Ratnik Helmet (deeper contoured ballistic rim + brow goggles)
        bHelm.addSphere(0, 0.174, 0.006, 0.124, 18, 12, { hemi: 'top', color: P.helmetTint, scale: [0.96, 0.96, 1.05] });
        bHelm.addCylinder(0, 0.148, 0.008, 0.121, 0.129, 0.078, 16, { axis: 'y', color: P.helmetTint });
        // Slight front brim visor
        addBev(bHelm, 0, 0.178, -0.122, 0.105, 0.018, 0.028, 0.006, { color: P.helmetTint });
        // 6B50 tactical goggles parked on helmet brow
        addBev(bHelm, 0, 0.214, -0.118, 0.132, 0.048, 0.038, 0.012, { color: [0.17, 0.19, 0.17] });
        addBev(bHelm, 0, 0.214, -0.136, 0.112, 0.034, 0.012, 0.004, { color: [0.10, 0.12, 0.14] });
      }
      m.helmet = finalizeBuilder(bHelm, gl);

      // Dedicated High-Vis Reflective Helmet Identification Bands (Full 360° Clearance + Side Patches)
      const bIdPriH = new B();
      const bIdSecH = new B();
      if (isUA) {
        // Bold UA Yellow upper band + Cobalt-Blue lower band cleanly clearing Ops-Core FAST ellipsoid dome
        bIdPriH.addCylinder(0, 0.196, 0.006, 0.128, 0.130, 0.036, 18, { axis: 'y', openEnded: true, color: [1, 1, 1] });
        bIdSecH.addCylinder(0, 0.167, 0.006, 0.130, 0.132, 0.022, 18, { axis: 'y', openEnded: true, color: [1, 1, 1] });
        addBev(bIdPriH, 0.0, 0.196, 0.134, 0.088, 0.036, 0.010, 0.002, { color: [1, 1, 1] });
      } else {
        // Bold RU Crimson-Red assault band + Crisp White lower band + side assault blocks cleanly clearing 6B47 dome
        bIdPriH.addCylinder(0, 0.184, 0.008, 0.133, 0.136, 0.036, 18, { axis: 'y', openEnded: true, color: [1, 1, 1] });
        bIdSecH.addCylinder(0, 0.155, 0.008, 0.135, 0.138, 0.024, 18, { axis: 'y', openEnded: true, color: [1, 1, 1] });
        addBev(bIdPriH, 0.134, 0.184, 0.004, 0.014, 0.044, 0.056, 0.003, { color: [1, 1, 1] });
        addBev(bIdPriH, -0.134, 0.184, 0.004, 0.014, 0.044, 0.056, 0.003, { color: [1, 1, 1] });
      }
      m.idPriHelmet = finalizeBuilder(bIdPriH, gl);
      m.idSecHelmet = finalizeBuilder(bIdSecH, gl);
    }

    // 4. Sculpted Upper Arms (Pivot at shoulder (0,0,0), extends along -Y to -L_UPPER_ARM = -0.30)
    {
      const buildUpperArm = () => {
        const b = new B();
        // Rounded deltoid cap
        b.addSphere(0, -0.015, 0, 0.070, 12, 10, { color: P.uniformTint, scale: [1.0, 1.08, 1.0] });
        // Fuller muscular BDU bicep sleeve
        b.addCylinder(0, -0.155, 0, 0.064, 0.052, L_UPPER_ARM - 0.01, 14, { axis: 'y', color: P.uniformTint });
        return finalizeBuilder(b, gl);
      };
      m.upperArmR = buildUpperArm();
      m.upperArmL = buildUpperArm();

      // Dedicated High-Vis Dual-Band Bicep Tape (mounted on BOTH left & right biceps!)
      const bIdPriA = new B();
      bIdPriA.addCylinder(0, -0.118, 0, 0.0655, 0.0620, 0.088, 16, { axis: 'y', openEnded: true, color: [1, 1, 1] });
      m.idPriArm = finalizeBuilder(bIdPriA, gl);

      const bIdSecA = new B();
      bIdSecA.addCylinder(0, -0.183, 0, 0.0618, 0.0600, 0.042, 16, { axis: 'y', openEnded: true, color: [1, 1, 1] });
      m.idSecArm = finalizeBuilder(bIdSecA, gl);
    }

    // 5. Sculpted Forearms + Elbow Pad + Anatomically Shaped Gloved Hands
    // Pivot at elbow (0,0,0), extends along -Y to -L_FOREARM = -0.28 (palm/grip center at Y = -0.272)
    {
      const buildForearm = (isLeft) => {
        const b = new B();
        // Elbow joint + curved protective tactical elbow pad on +Z back side
        b.addSphere(0, 0, 0, 0.052, 10, 8, { color: P.uniformDark });
        addBev(b, 0, -0.014, 0.042, 0.062, 0.074, 0.028, 0.010, { color: P.vestTint });
        // Tapered combat sleeve down to wrist
        b.addCylinder(0, -0.115, 0, 0.052, 0.040, 0.222, 12, { axis: 'y', color: P.uniformTint });
        // Wrist cuff + tactical GPS watch on left wrist
        b.addCylinder(0, -0.218, 0, 0.042, 0.039, 0.024, 12, { axis: 'y', color: P.gloveTint });
        if (isLeft) {
          addBev(b, -0.024, -0.205, 0.026, 0.028, 0.036, 0.014, 0.004, { color: [0.14, 0.16, 0.15] });
        }
        // Anatomically contoured gloved hand (palm + knuckle guard + curled grip fingers + thumb)
        addBev(b, 0, -0.256, -0.004, 0.048, 0.068, 0.056, 0.012, { color: P.gloveTint });
        addBev(b, 0, -0.276, -0.024, 0.044, 0.038, 0.034, 0.008, { color: [0.16, 0.16, 0.16] });
        addBev(b, isLeft ? 0.026 : -0.026, -0.252, -0.028, 0.020, 0.036, 0.024, 0.006, { color: P.gloveTint });
        return finalizeBuilder(b, gl);
      };
      m.forearmL = buildForearm(true);
      m.forearmR = buildForearm(false);
    }

    // 6. Sculpted Muscular Combat-Trouser Thighs (Pivot at hip (0,0,0), extends along -Y to -L_THIGH = -0.44)
    {
      const buildThigh = (isRight) => {
        const b = new B();
        b.addSphere(0, -0.018, 0, 0.098, 12, 10, { color: P.uniformTint });
        b.addCylinder(0, -0.220, 0, 0.098, 0.078, L_THIGH, 14, { axis: 'y', color: P.uniformTint, aoBottom: 0.86 });
        // Contoured BDU side cargo pocket
        addBev(b, isRight ? 0.078 : -0.078, -0.215, 0.005, 0.032, 0.148, 0.105, 0.012, { color: P.uniformDark });
        // Drop-leg holster strap on right thigh
        if (isRight) {
          b.addCylinder(0, -0.145, 0, 0.095, 0.093, 0.026, 12, { axis: 'y', color: [0.18, 0.18, 0.18] });
        }
        return finalizeBuilder(b, gl);
      };
      m.thighR = buildThigh(true);
      m.thighL = buildThigh(false);

      // Dedicated High-Vis Reflective Thigh Identification Wrap (below cargo pocket, zero z-fight!)
      const bIdPriLeg = new B();
      bIdPriLeg.addCylinder(0, -0.292, 0, 0.0915, 0.0880, 0.074, 16, { axis: 'y', openEnded: true, color: [1, 1, 1] });
      m.idPriThigh = finalizeBuilder(bIdPriLeg, gl);

      const bIdSecLeg = new B();
      bIdSecLeg.addCylinder(0, -0.347, 0, 0.0875, 0.0852, 0.036, 16, { axis: 'y', openEnded: true, color: [1, 1, 1] });
      m.idSecThigh = finalizeBuilder(bIdSecLeg, gl);
    }

    // 7. Sculpted Calves + Integrated Crye Knee Pads + Sleek Tapered Combat Boots
    // Pivot at knee (0,0,0), extends along -Y so boot outsole rests FLUSH at Y = -L_CALF = -0.460!
    {
      const b = new B();
      // Fuller knee joint & contoured forward-facing (-Z) ballistic knee pad
      b.addSphere(0, 0.0, 0, 0.074, 12, 8, { color: P.uniformDark });
      addBev(b, 0, -0.012, -0.064, 0.088, 0.106, 0.032, 0.014, { color: P.vestTint });
      // Muscular bloused combat trouser calf
      b.addCylinder(0, -0.142, 0, 0.076, 0.056, 0.268, 14, { axis: 'y', color: P.uniformTint, aoBottom: 0.85 });
      // Bloused trouser cuff above boot collar
      b.addCylinder(0, -0.266, 0, 0.064, 0.060, 0.044, 12, { axis: 'y', color: P.uniformDark });
      // Lace-up tactical boot shaft (Y: -0.275 to -0.395)
      b.addCylinder(0, -0.336, 0.0, 0.056, 0.051, 0.130, 12, { axis: 'y', color: P.bootTint });
      // Sleek contoured boot upper/vamp (compact 0.170m length, tapered forward — zero wooden-clog bulk!)
      addBev(b, 0, -0.412, -0.038, 0.086, 0.056, 0.168, 0.018, { color: P.bootTint });
      // Rounded tapered toe box & rubber bumper cap
      b.addSphere(0, -0.422, -0.118, 0.038, 10, 8, { color: [0.14, 0.14, 0.15], scale: [1.02, 0.72, 1.05] });
      // Low-profile lugged rubber sole resting FLUSH at Y = -0.460 (center -0.450, height 0.020 -> bottom -0.460!)
      addBev(b, 0, -0.450, -0.042, 0.090, 0.020, 0.194, 0.006, { color: [0.10, 0.10, 0.11] });
      m.calf = finalizeBuilder(b, gl);
    }

    // 8. Detailed 3D Held World Weapons (mounted at pistol grip (0,0,0), barrel along -Z, optic +Y)
    m.weapons = buildWorldWeapons(gl, faction, P);

    return m;
  }

  function buildWorldWeapons(gl, faction, P) {
    const B = DF.MeshGen.Builder;
    const isUA = faction === 'UA';
    const dark = P.weaponBody;
    const steel = [0.28, 0.29, 0.32];
    const acc = P.weaponAccent;
    const w = [];

    // Slot 0: Assault Rifle (UA M4A1/UAR-15 | RU AK-74M)
    {
      const b = new B();
      // Upper & lower receiver
      addBev(b, 0, 0.054, -0.115, 0.046, 0.076, 0.275, 0.008, { color: dark });
      // Pistol grip centered right at right-hand origin (0, 0, 0)
      addBev(b, 0, -0.022, 0.008, 0.032, 0.098, 0.044, 0.007, { color: acc, rotX: 0.24 });
      // Collapsible / polymer buttstock extending back (+Z) into shoulder pocket
      addBev(b, 0, 0.048, 0.165, 0.036, 0.095, 0.245, 0.009, { color: isUA ? acc : dark });
      addBev(b, 0, 0.044, 0.285, 0.040, 0.115, 0.022, 0.005, { color: [0.13, 0.13, 0.14] });
      // M-LOK / AK handguard (-Z)
      addBev(b, 0, 0.058, -0.355, 0.044, 0.056, 0.235, 0.009, { color: acc });
      // Barrel, gas block & flash hider
      b.addCylinder(0, 0.064, -0.575, 0.011, 0.013, 0.28, 10, { axis: 'z', color: steel });
      b.addCylinder(0, 0.064, -0.725, 0.015, 0.016, 0.052, 10, { axis: 'z', color: dark });
      // Curved magazine angled forward (-Z)
      addBev(b, 0, -0.058, -0.175, 0.030, 0.155, 0.060, 0.006, {
        color: isUA ? [0.22, 0.21, 0.19] : [0.46, 0.22, 0.15],
        rotX: -0.22
      });
      // Sleek holographic / OKP reflex optic on top rail (+Y)
      addBev(b, 0, 0.108, -0.105, 0.034, 0.042, 0.082, 0.006, { color: [0.14, 0.15, 0.16] });
      if (isUA) {
        // PEQ-15 laser box on front rail
        addBev(b, 0, 0.098, -0.395, 0.034, 0.024, 0.072, 0.004, { color: acc });
      }
      w[0] = { mesh: finalizeBuilder(b, gl), ...WEAPON_SPECS[0] };
    }

    // Slot 1: LMG (UA M249 SAW | RU PKM)
    {
      const b = new B();
      addBev(b, 0, 0.058, -0.155, 0.068, 0.096, 0.39, 0.010, { color: dark });
      addBev(b, 0, -0.022, 0.015, 0.034, 0.098, 0.046, 0.006, { color: acc, rotX: 0.22 });
      addBev(b, 0, 0.048, 0.195, 0.044, 0.108, 0.26, 0.010, { color: isUA ? dark : acc });
      b.addCylinder(0, 0.078, -0.615, 0.015, 0.019, 0.52, 10, { axis: 'z', color: steel });
      b.addCylinder(0, 0.038, -0.525, 0.012, 0.012, 0.34, 8, { axis: 'z', color: dark });
      // Green belt-fed ammo box underneath
      addBev(b, 0.012, -0.058, -0.20, 0.112, 0.135, 0.135, 0.012, { color: [0.24, 0.31, 0.20] });
      // Folded bipod legs
      b.addCylinder(0.032, 0.016, -0.56, 0.007, 0.007, 0.24, 6, { axis: 'z', color: steel });
      b.addCylinder(-0.032, 0.016, -0.56, 0.007, 0.007, 0.24, 6, { axis: 'z', color: steel });
      w[1] = { mesh: finalizeBuilder(b, gl), ...WEAPON_SPECS[1] };
    }

    // Slot 2: Sniper Rifle (UA M24 SWS | RU SVD Dragunov)
    {
      const b = new B();
      addBev(b, 0, 0.048, -0.125, 0.042, 0.068, 0.36, 0.009, { color: isUA ? [0.26, 0.28, 0.23] : acc });
      addBev(b, 0, 0.038, 0.205, 0.038, 0.108, 0.29, 0.010, { color: isUA ? [0.26, 0.28, 0.23] : acc });
      b.addCylinder(0, 0.066, -0.665, 0.012, 0.016, 0.72, 10, { axis: 'z', color: steel });
      // Prominent telescopic precision sniper scope
      b.addCylinder(0, 0.128, -0.155, 0.022, 0.018, 0.30, 12, { axis: 'z', color: [0.13, 0.14, 0.15] });
      addBev(b, 0, 0.098, -0.095, 0.022, 0.036, 0.020, 0.003, { color: dark });
      addBev(b, 0, 0.098, -0.215, 0.022, 0.036, 0.020, 0.003, { color: dark });
      addBev(b, 0, -0.028, -0.165, 0.028, 0.088, 0.072, 0.005, { color: dark });
      w[2] = { mesh: finalizeBuilder(b, gl), ...WEAPON_SPECS[2] };
    }

    // Slot 3: Combat Shotgun (UA M870 Tactical | RU Saiga-12K)
    {
      const b = new B();
      addBev(b, 0, 0.050, -0.12, 0.048, 0.076, 0.29, 0.008, { color: dark });
      addBev(b, 0, 0.038, 0.17, 0.038, 0.098, 0.25, 0.009, { color: dark });
      b.addCylinder(0, 0.072, -0.49, 0.015, 0.016, 0.48, 10, { axis: 'z', color: steel });
      b.addCylinder(0, 0.036, -0.44, 0.014, 0.014, 0.40, 10, { axis: 'z', color: dark });
      if (isUA) {
        addBev(b, 0, 0.036, -0.39, 0.048, 0.050, 0.185, 0.010, { color: [0.22, 0.22, 0.22] });
      } else {
        addBev(b, 0, -0.068, -0.175, 0.038, 0.165, 0.072, 0.006, { color: dark, rotX: -0.14 });
      }
      w[3] = { mesh: finalizeBuilder(b, gl), ...WEAPON_SPECS[3] };
    }

    // Slot 4: 40mm Grenade Launcher (UA M320 | RU GP-25)
    {
      const b = new B();
      addBev(b, 0, 0.048, -0.095, 0.058, 0.088, 0.21, 0.010, { color: dark });
      addBev(b, 0, -0.022, 0.005, 0.034, 0.095, 0.045, 0.006, { color: acc, rotX: 0.20 });
      addBev(b, 0, 0.042, 0.125, 0.038, 0.086, 0.175, 0.008, { color: dark });
      b.addCylinder(0, 0.066, -0.32, 0.028, 0.028, 0.30, 12, { axis: 'z', color: steel });
      addBev(b, 0.036, 0.102, -0.22, 0.010, 0.058, 0.036, 0.002, { color: acc });
      w[4] = { mesh: finalizeBuilder(b, gl), ...WEAPON_SPECS[4] };
    }

    // Slot 5: RPG-7V2 Anti-Tank Launcher (sleek over-shoulder profile + protruding PG-7VL warhead)
    {
      const b = new B();
      b.addCylinder(0, 0.105, -0.02, 0.023, 0.023, 0.94, 12, { axis: 'z', color: [0.22, 0.24, 0.21] });
      b.addCylinder(0, 0.105, 0.06, 0.030, 0.030, 0.32, 12, { axis: 'z', color: [0.46, 0.29, 0.16] });
      b.addCylinder(0, 0.105, 0.50, 0.044, 0.023, 0.17, 12, { axis: 'z', color: [0.20, 0.21, 0.20] });
      // Pistol grips at (0,0,0) and (0,0,-0.24)
      addBev(b, 0, 0.015, 0.0, 0.030, 0.11, 0.042, 0.006, { color: [0.38, 0.24, 0.14], rotX: 0.16 });
      addBev(b, 0, 0.018, -0.24, 0.028, 0.095, 0.038, 0.006, { color: [0.38, 0.24, 0.14] });
      // PGO-7V optical sight on left side (-X)
      addBev(b, -0.048, 0.138, -0.05, 0.028, 0.054, 0.105, 0.006, { color: [0.16, 0.18, 0.17] });
      // Protruding PG-7VL tandem HEAT warhead (-Z front)
      b.addCylinder(0, 0.105, -0.56, 0.042, 0.020, 0.14, 12, { axis: 'z', color: [0.28, 0.34, 0.22] });
      b.addCylinder(0, 0.105, -0.70, 0.011, 0.042, 0.15, 12, { axis: 'z', color: [0.30, 0.36, 0.23] });
      b.addCylinder(0, 0.105, -0.80, 0.009, 0.011, 0.075, 10, { axis: 'z', color: [0.58, 0.52, 0.34] });
      w[5] = { mesh: finalizeBuilder(b, gl), ...WEAPON_SPECS[5] };
    }

    return w;
  }

  // Sleek multi-petal tapered muzzle blast (no chunky yellow blocks!)
  function buildMuzzleFlashMesh(gl) {
    const b = new DF.MeshGen.Builder();
    // Tapered incandescent central cone extending forward (-Z)
    b.addCylinder(0, 0, -0.11, 0.004, 0.038, 0.22, 10, { axis: 'z', color: [1.0, 0.94, 0.72] });
    // 4 delicate side compensator gas petals (angled slightly outward)
    b.addCylinder(0.055, 0, -0.045, 0.003, 0.020, 0.11, 8, { axis: 'x', rotZ: 0.18, color: [1.0, 0.76, 0.32] });
    b.addCylinder(-0.055, 0, -0.045, 0.003, 0.020, 0.11, 8, { axis: 'x', rotZ: -0.18, color: [1.0, 0.76, 0.32] });
    b.addCylinder(0, 0.048, -0.045, 0.003, 0.018, 0.095, 8, { axis: 'y', rotX: 0.18, color: [1.0, 0.80, 0.38] });
    b.addCylinder(0, -0.042, -0.045, 0.003, 0.016, 0.085, 8, { axis: 'y', rotX: -0.18, color: [1.0, 0.74, 0.30] });
    return finalizeBuilder(b, gl);
  }

  // ---------------------------------------------------------------------------
  // Public API: init(gl)
  // ---------------------------------------------------------------------------
  function init(gl) {
    if (_initialized && _gl === gl) return;
    _gl = gl;
    if (!DF.MeshGen || !DF.MeshGen.Builder) return;

    _meshes = {
      UA: buildFactionMeshes(gl, 'UA'),
      RU: buildFactionMeshes(gl, 'RU'),
      muzzleFlash: buildMuzzleFlashMesh(gl)
    };
    _initialized = true;
  }

  function shouldRenderAgent(agent, opts) {
    if (!agent) return false;
    if (agent.inVehicleId) return false;
    if (agent.isPlayer) {
      if (opts && opts.forceRenderPlayer) return true;
      if (DF.Game) {
        if (DF.Game.phase === 'menu') return true;
        if (DF.Game.diagnosticView && DF.Game.diagnosticView !== 'gameplay') return true;
        if (DF.Game.customCameraOverride) return true;
        if (DF.Game.controlMode === 'drone' || DF.Game.controlMode === 'dog') return true;
      }
      if (DF.Unmanned && typeof DF.Unmanned.getControlledUnit === 'function' && DF.Unmanned.getControlledUnit()) {
        return true;
      }
      if (agent.showBodyIn3rdPerson) return true;
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Procedural Full-Body Combat Pose Solver (Exact Kinematics + 2-Bone Arm IK)
  // Computes all hierarchical part transforms for rendering AND automated testing!
  // ---------------------------------------------------------------------------
  function computeSoldierPose(agent, time) {
    const t = time || 0;
    const vx = agent.vel ? agent.vel[0] : 0;
    const vz = agent.vel ? agent.vel[2] : 0;
    const speed = Math.hypot(vx, vz);
    const phase = agent.animPhase || 0;
    const state = agent.state || 'alive';
    const isCrouch = !!agent.crouching || agent.stance === 'crouch';
    const isReviving = state === 'alive' && !!agent.reviveTargetId;
    const isReloading = state === 'alive' && !!agent.reloading;
    const wSlot = clamp(agent.weaponSlot || 0, 0, 5);
    const wSpec = WEAPON_SPECS[wSlot] || WEAPON_SPECS[0];
    const isRPG = wSlot === 5;
    const recoil = clamp(agent.recoil || 0, 0, 1.4);
    const flinch = clamp(agent.hitFlinch || 0, 0, 1.0);
    const lean = clamp(agent.lean || 0, -1, 1);
    const aimPitch = clamp(agent.pitch || 0, -0.36, 0.44);
    const yaw = agent.yaw || 0;

    // -------------------------------------------------------------------------
    // 1. Lower Body & Torso Angles (Corrected Right-Handed Signs!)
    //    thighX > 0: thigh swings FORWARD (-Z)
    //    calfX <= 0: knee bends naturally BACKWARD (+Z)
    //    torsoPitch < 0: torso leans FORWARD (-Z); torsoPitch > 0: leans BACK (+Z)
    // -------------------------------------------------------------------------
    let pelvisY = 0.90;
    let pelvisX = 0;
    let pelvisZ = 0;
    let pelvisPitch = 0;
    let pelvisRoll = 0;

    let torsoPitch = 0;
    let torsoYaw = 0;
    let torsoRoll = 0;
    let headPitch = 0;
    let headYaw = 0;

    let lThighX = 0, lThighZ = 0, lCalfX = 0;
    let rThighX = 0, rThighZ = 0, rCalfX = 0;

    // Weapon transform in TORSO space (right-hand grip = (0,0,0), barrel = -Z, optic = +Y)
    let wpnX = wSpec.shoulderOff[0];
    let wpnY = wSpec.shoulderOff[1];
    let wpnZ = wSpec.shoulderOff[2];
    let wpnRx = 0, wpnRy = 0, wpnRz = 0;

    // Optional overrides for left/right hand targets in TORSO space (null = grip weapon!)
    let customRightHand = null;
    let customLeftHand = null;
    let groundExactBoots = true;

    if (state === 'dead') {
      groundExactBoots = false;
      const dp = clamp((agent.deathTime || 0) / 0.55, 0, 1);
      const ease = 1 - (1 - dp) * (1 - dp);
      const idStr = String(agent.id || 'a');
      const hash = (idStr.charCodeAt(idStr.length - 1) || 1) % 3;
      const sideSign = hash === 0 ? 1 : -1;

      // Collapse smoothly backward onto back/side (Rx(+1.48) lays +Y torso flat along +Z, zero floor sink!)
      pelvisY = lerp(0.86, 0.13, ease);
      pelvisPitch = lerp(0, 1.48, ease);
      pelvisRoll = lerp(0, sideSign * 0.25, ease);
      pelvisZ = lerp(0, 0.25, ease);

      torsoPitch = lerp(0, -0.06, ease);
      torsoRoll = lerp(0, sideSign * 0.10, ease);
      headPitch = lerp(0, -0.18, ease);
      headYaw = lerp(0, sideSign * 0.42, ease);

      // Legs splayed slightly forward with natural backward knee flex
      lThighX = lerp(0, 0.16, ease);
      lThighZ = lerp(0, -0.18, ease);
      lCalfX = lerp(0, -0.28, ease);

      rThighX = lerp(0, 0.24, ease);
      rThighZ = lerp(0, 0.22, ease);
      rCalfX = lerp(0, -0.36, ease);

      // Arms relax out to sides on the ground
      customRightHand = [0.36, 0.12, -0.05];
      customLeftHand = [-0.38, 0.14, -0.04];
      wpnX = 0.34; wpnY = 0.12; wpnZ = -0.08;
      wpnRx = -0.25; wpnRy = -0.45; wpnRz = 1.1;

    } else if (state === 'downed') {
      groundExactBoots = false;
      const wave = Math.sin(t * 4.6 + (agent.pos ? agent.pos[0] : 0));
      const breathe = Math.sin(t * 3.0) * 0.03;

      // Propped seated on ground leaning slightly back (+0.38 tilts +Y back toward +Z)
      pelvisY = 0.16;
      pelvisPitch = 0.38;
      torsoPitch = 0.12 + breathe;
      headPitch = -0.36; // chin tucked looking forward toward allies
      headYaw = wave * 0.24;

      // Legs extended forward along ground with knees gently bent up & heels resting flush on floor (Y >= 0.00)
      lThighX = 1.56;
      lThighZ = -0.18;
      lCalfX = -0.52;

      rThighX = 1.48;
      rThighZ = 0.22;
      rCalfX = -0.44;

      // Left hand clutches chest wound; right arm raised forward-up waving for medic!
      customLeftHand = [-0.04, 0.24, -0.18];
      customRightHand = [0.22 + wave * 0.09, 0.56 + Math.abs(wave) * 0.06, -0.24];

      // Weapon rests down beside right thigh
      wpnX = 0.24; wpnY = 0.02; wpnZ = -0.16;
      wpnRx = -0.45; wpnRy = -0.25; wpnRz = 0.35;

    } else if (isReviving) {
      // Tactical combat kneeling aid: right knee down, left boot planted flat ahead (exact Y = 0.000)!
      const aid = Math.sin(t * 6.8);
      pelvisPitch = 0.0;
      torsoPitch = -0.42; // lean forward over wounded teammate
      headPitch = -0.25;

      // Left leg forward lunge: thigh +1.28 forward, calf -1.28 straight down to flat boot!
      lThighX = 1.28;
      lCalfX = -1.28;
      // Right leg kneeling: thigh vertical down, shin folded back along floor!
      rThighX = 0.10;
      rCalfX = -1.52;
      groundExactBoots = true;

      // Both hands bandaging wounded teammate ahead (-Z)
      customRightHand = [0.10 + aid * 0.04, 0.14 - aid * 0.02, -0.38];
      customLeftHand = [-0.10 - aid * 0.04, 0.13 + aid * 0.02, -0.36];

      // Weapon slung cleanly flat diagonally across soldier's BACK (never pokes head or stabs knees/floor!)
      // In torso space: wpnFwd = (-0.50, +0.866, -0.035) -> lies flat across back from right hip up to left shoulder!
      wpnX = 0.06; wpnY = 0.20; wpnZ = 0.215;
      wpnRx = 1.05; wpnRy = 1.50; wpnRz = 0.0;

    } else {
      // ALIVE COMBAT STANCES: Idle, Walk, Jog, Sprint, Crouch, Aiming, Reload, Throw
      const isMoving = speed > 0.22;
      const isSprinting = speed > 4.2 && !isCrouch && !isReloading;
      const moveBlend = clamp(speed / 4.8, 0, 1);
      const stride = Math.sin(phase);
      const strideCos = Math.cos(phase);
      const breathe = Math.sin(t * 2.1 + (agent.pos ? agent.pos[0] : 0) * 0.5) * 0.015;

      if (isCrouch) {
        // Balanced athletic combat half-crouch: sturdy staggered base, smooth natural knee flex
        const cw = isMoving ? 0.22 * moveBlend : 0;
        lThighX = 0.72 + stride * cw;
        lCalfX = -(0.82 + Math.max(0, -strideCos) * cw * 0.45);
        rThighX = 0.24 - stride * cw;
        rCalfX = -(0.84 + Math.max(0, strideCos) * cw * 0.45);

        torsoPitch = -0.15 + aimPitch * 0.40 + flinch * 0.14;
        // Authentic right-handed rifle stance blade (-0.30 rad): left shoulder forward, right stock pocket back!
        torsoYaw = -0.30;
      } else if (isMoving) {
        // Athletic tactical walk / combat jog / energetic AAA Modern Warfare sprint cycle
        const swingAmp = isSprinting ? 0.74 : lerp(0.28, 0.52, moveBlend);
        const kneeFlexAmp = isSprinting ? 1.14 : lerp(0.28, 0.72, moveBlend);

        // Forward leg swings POSITIVE (+Z->-Z); knee ALWAYS flexes NEGATIVE (backward!)
        lThighX = stride * swingAmp + (isSprinting ? 0.14 : 0.06);
        rThighX = -stride * swingAmp + (isSprinting ? 0.14 : 0.06);

        // Trailing/lifting leg bends knee naturally backward (calfX <= -0.08)
        lCalfX = -(0.08 + Math.max(0, -strideCos * kneeFlexAmp + (stride < 0 ? 0.18 : 0.28 * moveBlend)));
        rCalfX = -(0.08 + Math.max(0, strideCos * kneeFlexAmp + (stride > 0 ? 0.18 : 0.28 * moveBlend)));

        torsoPitch = (isSprinting ? -0.27 : -0.10 * moveBlend) + (isSprinting ? 0 : aimPitch * 0.42) + flinch * 0.18;
        // Opposite athletic torso counter-twist during sprint for visceral weight & momentum!
        torsoYaw = isSprinting ? (-0.16 - stride * 0.17) : (-stride * 0.05 - 0.28);
      } else {
        // Alert athletic standing combat stance (left foot slightly forward, knees softly unlocked!)
        lThighX = 0.14;
        lCalfX = -0.16;
        rThighX = -0.12;
        rCalfX = -0.12;
        torsoPitch = -0.06 + aimPitch * 0.42 + breathe + flinch * 0.18;
        torsoYaw = -0.30; // authentic right-handed firing blade (left shoulder forward toward handguard!)
      }

      // Cover peeking lateral lean (+lean leans right +X -> Rz < 0)
      torsoRoll = -lean * 0.30;
      pelvisX = lean * 0.14;

      // Head tracks target pitch & counter-rotates torso blading so eyes lock down sights!
      headPitch = aimPitch * 0.58 - torsoPitch * 0.55;
      headYaw = -torsoYaw * 0.88;

      // Upper body weapon pose & special actions
      if ((agent.throwTimer || 0) > 0) {
        // Overhead grenade throw windup & release
        const tp = clamp(1 - agent.throwTimer / 0.55, 0, 1);
        const arc = tp < 0.45 ? lerp(0, 1, tp / 0.45) : lerp(1, -1, (tp - 0.45) / 0.55);
        torsoYaw = -arc * 0.45;
        customRightHand = [0.24, 0.54 + Math.max(0, arc) * 0.12, -0.05 + arc * 0.26];
        customLeftHand = [-0.12, 0.34, -0.34];
        // Rifle held steady low in left hand
        wpnX = -0.06; wpnY = 0.24; wpnZ = -0.22;
        wpnRx = -0.35; wpnRy = 0.40; wpnRz = 0.15;

      } else if (isReloading) {
        // Visible 3-stage tactical reload choreography!
        const dur = Math.max(0.5, agent.reloadDuration || 2.1);
        const rp = clamp(1 - (agent.reloadTimer || 0) / dur, 0, 1);
        wpnX = 0.10;
        wpnY = 0.30;
        wpnZ = -0.23;
        wpnRx = 0.12 - torsoPitch;
        wpnRy = 0.28 - torsoYaw;
        wpnRz = 0.42; // receiver canted cleanly so magwell is exposed

        if (rp < 0.28) {
          // Left hand moves from handguard to magazine well
          const u = rp / 0.28;
          customLeftHand = [lerp(0.02, 0.04, u), lerp(0.32, 0.21, u), lerp(-0.46, -0.36, u)];
        } else if (rp < 0.65) {
          // Left hand drops to belt pouch & brings fresh mag cleanly up into magwell
          const u = (rp - 0.28) / 0.37;
          const dip = Math.sin(u * Math.PI);
          customLeftHand = [0.02 - dip * 0.12, 0.21 - dip * 0.22, -0.36 + dip * 0.18];
        } else {
          // Left hand racks charging handle & returns to handguard
          const u = (rp - 0.65) / 0.35;
          const rack = Math.sin(u * Math.PI);
          wpnRz = lerp(0.42, 0.0, u);
          customLeftHand = [lerp(0.03, 0.02, u), lerp(0.32, 0.34, u), lerp(-0.32 + rack * 0.08, -0.48, u)];
        }

      } else if (isSprinting) {
        // Visceral AAA Modern Warfare / Battlefield High-Ready Diagonal Tactical Sprint!
        const bobX = stride * 0.036;
        const bobY = Math.abs(strideCos) * 0.028;
        if (isRPG) {
          // RPG-7 carried cleanly angled right-up over shoulder while sprinting (zero torso clip & exact 2-hand grip!)
          wpnX = 0.172 + bobX * 0.45;
          wpnY = 0.368 + bobY;
          wpnZ = -0.125;
          wpnRx = 0.24 + strideCos * 0.05;
          wpnRy = -0.04 - stride * 0.04;
          wpnRz = -0.06;
        } else {
          // Rifles/LMG/Shotgun carried high-ready diagonally up-left across chest with rhythmic stride pump!
          wpnX = 0.075 + bobX;
          wpnY = 0.300 + bobY;
          wpnZ = -0.225;
          wpnRx = 0.26 + strideCos * 0.07;
          wpnRy = 0.74 - stride * 0.09;
          wpnRz = 0.30 + stride * 0.05;
        }

      } else {
        // Shouldered Combat Aiming (ADS / Ready Fire)
        // Cancel torsoPitch & torsoYaw so barrel points DEAD-STRAIGHT along soldier (yaw, aimPitch)
        // with optic strictly UP (+Y)!
        const kickBack = recoil * 0.048;
        const kickPitch = recoil * 0.14;
        const bobY = isMoving ? Math.sin(phase * 2) * 0.016 * moveBlend : 0;

        wpnX = wSpec.shoulderOff[0];
        wpnY = wSpec.shoulderOff[1] + bobY + (isCrouch ? -0.01 : 0);
        wpnZ = wSpec.shoulderOff[2] + kickBack;

        // Exact world-aim alignment: counter torso blading & lean, track aimPitch + recoil!
        wpnRx = (aimPitch - torsoPitch) + kickPitch;
        wpnRy = -torsoYaw;
        wpnRz = -torsoRoll * 0.5;
      }
    }

    // -------------------------------------------------------------------------
    // 2. Exact Ground-Contact Pelvis Elevation (Sub-Millimeter Boot Contact!)
    //    Evaluates exact lowest boot heel/toe Y of BOTH legs in root space!
    // -------------------------------------------------------------------------
    if (groundExactBoots) {
      // Quick closed-form boot heel/toe vertical drop in pelvis-neutral frame
      const calcLegMinY = (tx, cx) => {
        const kneeY = -L_THIGH * Math.cos(tx);
        const tot = tx + cx;
        const cosT = Math.cos(tot);
        const sinT = Math.sin(tot);
        // Sleek boot heel at calf-local (0, -L_CALF, +0.055), boot toe at (0, -L_CALF, -0.139)
        const heelY = kneeY + (-L_CALF) * cosT - (0.055) * sinT;
        const toeY = kneeY + (-L_CALF) * cosT - (-0.139) * sinT;
        return Math.min(heelY, toeY);
      };
      const minY = Math.min(calcLegMinY(lThighX, lCalfX), calcLegMinY(rThighX, rCalfX));
      pelvisY = clamp(-minY, 0.56, 0.92);
    }

    // -------------------------------------------------------------------------
    // 3. Compose Hierarchical World Transforms
    // -------------------------------------------------------------------------
    const px = agent.pos ? (agent.pos[0] || 0) : 0;
    const py = agent.pos ? (agent.pos[1] || 0) : 0;
    const pz = agent.pos ? (agent.pos[2] || 0) : 0;

    const mPelvis = allocMat();
    const mTorso = allocMat();
    const mHead = allocMat();
    const mLegLU = allocMat();
    const mLegLF = allocMat();
    const mLegRU = allocMat();
    const mLegRF = allocMat();
    const mWeapon = allocMat();
    const mArmLU = allocMat();
    const mArmLF = allocMat();
    const mArmRU = allocMat();
    const mArmRF = allocMat();

    // Root anchored strictly at ground contact (px, py, pz) rotated by yaw
    matFromTRS(_mRoot, px, py, pz, 0, yaw, 0, 1, 1, 1);

    // Pelvis & Legs (natural athletic hip width ±0.106m matching thickened combat thighs)
    makeChild(mPelvis, _mRoot, pelvisX, pelvisY, pelvisZ, pelvisPitch, 0, pelvisRoll);
    makeChild(mLegLU, mPelvis, -0.106, 0, 0, lThighX, 0, lThighZ);
    makeChild(mLegLF, mLegLU, 0, -L_THIGH, 0, lCalfX, 0, 0);
    makeChild(mLegRU, mPelvis, 0.106, 0, 0, rThighX, 0, rThighZ);
    makeChild(mLegRF, mLegRU, 0, -L_THIGH, 0, rCalfX, 0, 0);

    // Torso & Head
    makeChild(mTorso, mPelvis, 0, 0.08, 0, torsoPitch, torsoYaw, torsoRoll);
    makeChild(mHead, mTorso, 0, 0.47, 0, headPitch, headYaw, 0);

    // Weapon in Torso local space -> World space
    matFromTRS(_mWpnTorso, wpnX, wpnY, wpnZ, wpnRx, wpnRy, wpnRz, 1, 1, 1);
    matMul(mWeapon, mTorso, _mWpnTorso);

    // Exact 2-Bone Analytical Arm IK in Torso Space!
    const rHand = [0, 0, 0];
    const lHand = [0, 0, 0];

    if (customRightHand) {
      rHand[0] = customRightHand[0]; rHand[1] = customRightHand[1]; rHand[2] = customRightHand[2];
    } else {
      // Right hand locks cleanly onto weapon pistol grip (0, -0.015, +0.01)
      transformPt(_mWpnTorso, 0.0, -0.015, 0.012, rHand);
    }

    if (customLeftHand) {
      lHand[0] = customLeftHand[0]; lHand[1] = customLeftHand[1]; lHand[2] = customLeftHand[2];
    } else {
      // Left hand locks cleanly onto weapon handguard/forend grip!
      const lg = wSpec.leftGrip;
      transformPt(_mWpnTorso, lg[0], lg[1], lg[2], lHand);
    }

    // Shoulders at (±0.21, +0.405, 0.0); natural downward-outward elbow pole hints
    const rPoleX = isRPG ? 0.42 : 0.38;
    const rPoleY = isRPG ? 0.22 : 0.14;
    solveTwoBoneArm(_mSegR1, _mSegR2, 0.210, 0.405, 0.0, rHand[0], rHand[1], rHand[2], rPoleX, rPoleY, 0.14, L_UPPER_ARM, L_FOREARM);
    solveTwoBoneArm(_mSegL1, _mSegL2, -0.210, 0.405, 0.0, lHand[0], lHand[1], lHand[2], -0.34, 0.12, 0.10, L_UPPER_ARM, L_FOREARM);

    matMul(mArmRU, mTorso, _mSegR1);
    matMul(mArmRF, mTorso, _mSegR2);
    matMul(mArmLU, mTorso, _mSegL1);
    matMul(mArmLF, mTorso, _mSegL2);

    return {
      mPelvis, mTorso, mHead,
      mLegLU, mLegLF, mLegRU, mLegRF,
      mArmLU, mArmLF, mArmRU, mArmRF,
      mWeapon, wSlot
    };
  }

  // ---------------------------------------------------------------------------
  // Render Articulated Operator
  // ---------------------------------------------------------------------------
  function renderSoldier(renderer, agent, time, opts) {
    if (!renderer || !agent) return;
    if (!_initialized) {
      if (renderer.gl) init(renderer.gl);
      else return;
    }
    if (!_meshes || !shouldRenderAgent(agent, opts)) return;

    const faction = agent.faction === 'RU' ? 'RU' : 'UA';
    const set = _meshes[faction];
    const P = PALETTES[faction];
    const state = agent.state || 'alive';

    const pose = computeSoldierPose(agent, time);

    // Authentic PBR roughness/metalness + FLIR thermal heat signature
    const lifeHeat = state === 'dead' ? clamp(0.88 - (agent.deathTime || 0) * 0.025, 0.28, 0.88) : 1.0;

    const matUniform = {
      texKey: P.uniformTex,
      color: P.uniformMatColor,
      roughness: 0.90,
      metalness: 0.02,
      thermalHeat: 0.92 * lifeHeat
    };
    const matArmor = {
      texKey: P.armorTex,
      color: P.armorMatColor,
      roughness: 0.80,
      metalness: 0.08,
      thermalHeat: 0.82 * lifeHeat
    };
    const matSkin = {
      texKey: 'skin',
      color: [1, 1, 1],
      roughness: 0.72,
      metalness: 0.02,
      thermalHeat: 0.96 * lifeHeat
    };
    // Reflective tactical ID tape materials (pure high-contrast color + subtle shadow-piercing emissive lift)
    const emScale = state === 'dead' ? 0.45 : 1.0;
    const matIdPri = {
      texKey: 'plaster',
      color: P.idPriMatColor,
      roughness: 0.42,
      metalness: 0.04,
      emissive: [P.idPriEmissive[0] * emScale, P.idPriEmissive[1] * emScale, P.idPriEmissive[2] * emScale],
      thermalHeat: 0.72 * lifeHeat
    };
    const matIdSec = {
      texKey: 'plaster',
      color: P.idSecMatColor,
      roughness: 0.44,
      metalness: 0.04,
      emissive: [P.idSecEmissive[0] * emScale, P.idSecEmissive[1] * emScale, P.idSecEmissive[2] * emScale],
      thermalHeat: 0.72 * lifeHeat
    };
    const matWeapon = {
      texKey: 'gunmetal',
      color: [1, 1, 1],
      roughness: 0.34,
      metalness: 0.80,
      thermalHeat: clamp(0.32 + (agent.recoil || 0) * 0.45, 0.32, 0.85)
    };
    const flags = { castShadow: true, receiveShadow: true, viewmodel: false, unlit: false };
    const tapeFlags = { castShadow: false, receiveShadow: true, viewmodel: false, unlit: false };

    renderer.submitMesh(set.pelvis, pose.mPelvis, matUniform, flags);
    renderer.submitMesh(set.torso, pose.mTorso, matArmor, flags);
    if (set.idPriTorso) renderer.submitMesh(set.idPriTorso, pose.mTorso, matIdPri, tapeFlags);
    if (set.idSecTorso) renderer.submitMesh(set.idSecTorso, pose.mTorso, matIdSec, tapeFlags);

    if (agent.role === 'medic' && set.roleMedic) {
      renderer.submitMesh(set.roleMedic, pose.mTorso, matArmor, flags);
    } else if (agent.role === 'at' && set.roleAT) {
      renderer.submitMesh(set.roleAT, pose.mTorso, matArmor, flags);
    } else if (agent.role === 'sniper' && set.roleSniper) {
      renderer.submitMesh(set.roleSniper, pose.mTorso, matUniform, flags);
    }

    renderer.submitMesh(set.head, pose.mHead, matSkin, flags);
    renderer.submitMesh(set.helmet, pose.mHead, matArmor, flags);
    if (set.idPriHelmet) renderer.submitMesh(set.idPriHelmet, pose.mHead, matIdPri, tapeFlags);
    if (set.idSecHelmet) renderer.submitMesh(set.idSecHelmet, pose.mHead, matIdSec, tapeFlags);

    renderer.submitMesh(set.upperArmL, pose.mArmLU, matUniform, flags);
    if (set.idPriArm) renderer.submitMesh(set.idPriArm, pose.mArmLU, matIdPri, tapeFlags);
    if (set.idSecArm) renderer.submitMesh(set.idSecArm, pose.mArmLU, matIdSec, tapeFlags);
    renderer.submitMesh(set.forearmL, pose.mArmLF, matUniform, flags);

    renderer.submitMesh(set.upperArmR, pose.mArmRU, matUniform, flags);
    if (set.idPriArm) renderer.submitMesh(set.idPriArm, pose.mArmRU, matIdPri, tapeFlags);
    if (set.idSecArm) renderer.submitMesh(set.idSecArm, pose.mArmRU, matIdSec, tapeFlags);
    renderer.submitMesh(set.forearmR, pose.mArmRF, matUniform, flags);

    renderer.submitMesh(set.thighL, pose.mLegLU, matUniform, flags);
    if (set.idPriThigh) renderer.submitMesh(set.idPriThigh, pose.mLegLU, matIdPri, tapeFlags);
    renderer.submitMesh(set.calf, pose.mLegLF, matUniform, flags);
    renderer.submitMesh(set.thighR, pose.mLegRU, matUniform, flags);
    if (set.idPriThigh) renderer.submitMesh(set.idPriThigh, pose.mLegRU, matIdPri, tapeFlags);
    if (set.idSecThigh) renderer.submitMesh(set.idSecThigh, pose.mLegRU, matIdSec, tapeFlags);
    renderer.submitMesh(set.calf, pose.mLegRF, matUniform, flags);

    // Held world weapon
    const wEntry = set.weapons[pose.wSlot] || set.weapons[0];
    if (wEntry && wEntry.mesh) {
      renderer.submitMesh(wEntry.mesh, pose.mWeapon, matWeapon, flags);

      // Tapered multi-petal muzzle flash + dynamic flash light on shot
      if ((agent.muzzleFlashTimer || 0) > 0 && _meshes.muzzleFlash) {
        const mMuzzle = allocMat();
        const sc = 0.72 + Math.random() * 0.48;
        const rot = Math.random() * Math.PI * 2;
        matFromTRS(_mTmp, 0, wEntry.muzzleY, wEntry.muzzleZ, 0, 0, rot, sc, sc, sc * 1.15);
        matMul(mMuzzle, pose.mWeapon, _mTmp);
        renderer.submitMesh(
          _meshes.muzzleFlash,
          mMuzzle,
          {
            texKey: 'gunmetal',
            color: [1.0, 0.86, 0.42],
            roughness: 0.18,
            metalness: 0.0,
            alpha: 0.82,
            emissive: [4.2, 2.5, 0.75],
            thermalHeat: 1.0
          },
          { castShadow: false, receiveShadow: false, viewmodel: false, unlit: true }
        );
        if (typeof renderer.addDynamicLight === 'function') {
          renderer.addDynamicLight(
            [mMuzzle[12], mMuzzle[13], mMuzzle[14]],
            [1.0, 0.72, 0.34],
            4.8,
            9.0
          );
        }
      }
    }
  }

  // Computes exact world-space muzzle tip position aligned with shouldered world weapon
  function getMuzzleWorldPos(agent, out) {
    const res = out || [0, 0, 0];
    if (!agent || !agent.pos) return res;
    const yaw = agent.yaw || 0;
    const pitch = agent.pitch || 0;
    const eyeH = agent.crouching ? 1.08 : 1.44;
    const fx = -Math.sin(yaw) * Math.cos(pitch);
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * Math.cos(pitch);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const leanOff = (agent.lean || 0) * 0.24;
    res[0] = agent.pos[0] + fx * 0.82 + rx * (0.14 + leanOff);
    res[1] = agent.pos[1] + eyeH + fy * 0.82;
    res[2] = agent.pos[2] + fz * 0.82 + rz * (0.14 + leanOff);
    return res;
  }

  DF.Character = {
    init,
    renderSoldier,
    computeSoldierPose,
    getMuzzleWorldPos
  };
})();
