(() => {
  'use strict';

  const DF = (window.DF = window.DF || {});

  // ---------------------------------------------------------------------------
  // Internal Right-Handed Y-Up Math Helpers (Zero-GC, Self-Contained)
  // Local convention: -Z forward, +X right, +Y up.
  // ---------------------------------------------------------------------------
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
  const rand = (min, max) => min + Math.random() * (max - min);

  function angleDiff(from, to) {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function yawPitchToDir(yaw, pitch, out) {
    const cp = Math.cos(pitch);
    out[0] = -Math.sin(yaw) * cp;
    out[1] = Math.sin(pitch);
    out[2] = -Math.cos(yaw) * cp;
    return out;
  }

  function dirToYaw(dx, dz) {
    return Math.atan2(-dx, -dz);
  }

  function mat4Create() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  }

  // Column-major T(pos) * Ry(yaw) * Rx(pitch) * Rz(roll) * S(sx,sy,sz)
  function mat4FromYXZ(out, px, py, pz, yaw, pitch, roll, sx, sy, sz) {
    const cy = Math.cos(yaw), syaw = Math.sin(yaw);
    const cx = Math.cos(pitch), sxp = Math.sin(pitch);
    const cz = Math.cos(roll), szr = Math.sin(roll);

    // Ry * Rx * Rz
    const r00 = cy * cz + syaw * sxp * szr;
    const r10 = cx * szr;
    const r20 = -syaw * cz + cy * sxp * szr;

    const r01 = -cy * szr + syaw * sxp * cz;
    const r11 = cx * cz;
    const r21 = syaw * szr + cy * sxp * cz;

    const r02 = syaw * cx;
    const r12 = -sxp;
    const r22 = cy * cx;

    out[0] = r00 * sx; out[1] = r10 * sx; out[2] = r20 * sx; out[3] = 0;
    out[4] = r01 * sy; out[5] = r11 * sy; out[6] = r21 * sy; out[7] = 0;
    out[8] = r02 * sz; out[9] = r12 * sz; out[10] = r22 * sz; out[11] = 0;
    out[12] = px;      out[13] = py;      out[14] = pz;      out[15] = 1;
    return out;
  }

  function mat4Mul(out, a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    for (let i = 0; i < 4; i++) {
      const bi = i * 4;
      const b0 = b[bi], b1 = b[bi + 1], b2 = b[bi + 2], b3 = b[bi + 3];
      out[bi]     = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
      out[bi + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
      out[bi + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
      out[bi + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
    }
    return out;
  }

  function mat4TransformPoint(out, m, x, y, z) {
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    return out;
  }

  function mat4TransformDir(out, m, x, y, z) {
    const rx = m[0] * x + m[4] * y + m[8] * z;
    const ry = m[1] * x + m[5] * y + m[9] * z;
    const rz = m[2] * x + m[6] * y + m[10] * z;
    const l = Math.hypot(rx, ry, rz) || 1;
    out[0] = rx / l;
    out[1] = ry / l;
    out[2] = rz / l;
    return out;
  }

  // Safe MeshGen Builder wrappers
  function addBevel(b, cx, cy, cz, sx, sy, sz, bevel, opts) {
    if (typeof b.addBeveledBox === 'function') {
      b.addBeveledBox(cx, cy, cz, sx, sy, sz, bevel, opts || {});
    } else {
      b.addBox(cx, cy, cz, sx, sy, sz, opts || {});
    }
  }

  function addCyl(b, cx, cy, cz, rTop, rBot, h, segs, opts) {
    b.addCylinder(cx, cy, cz, rTop, rBot, h, segs, opts || {});
  }

  function buildMesh(b, gl) {
    if (typeof b.computeTangents === 'function') b.computeTangents();
    return b.build(gl);
  }

  function getGroundY(x, z, refY) {
    if (DF.Physics && typeof DF.Physics.getGroundY === 'function') {
      const g = DF.Physics.getGroundY(x, z, refY);
      if (Number.isFinite(g)) return g;
    }
    return 0;
  }

  // Track contact height sampler: conforms ONLY to true terrain + structural floors/sidewalks/stairs,
  // ignoring loose rubble, debris, sandbags, barriers, or props so 42-ton tracks NEVER hover!
  function getTrackSurfaceY(x, z, refY, ignoreColliderId) {
    let terrY = 0;
    if (DF.Physics && typeof DF.Physics.getTerrainHeight === 'function') {
      const ty = DF.Physics.getTerrainHeight(x, z);
      if (Number.isFinite(ty)) terrY = ty;
    }
    const gY = getGroundY(x, z, refY);
    const delta = gY - terrY;
    if (delta <= 0.015) return terrY;
    // Verify via downward raycast that the supporting surface is a real floor/sidewalk/stair
    if (delta < 1.2 && DF.Physics && typeof DF.Physics.raycast === 'function') {
      const startY = gY + 0.25;
      const h = DF.Physics.raycast([x, startY, z], [0, -1, 0], delta + 0.45, {
        ignoreIds: ignoreColliderId ? [ignoreColliderId] : null,
        ignoreTypes: ['vehicle']
      });
      if (h && h.collider) {
        const ctype = h.collider.type || (h.collider.meta && h.collider.meta.type);
        if (ctype === 'floor' || ctype === 'stair' || ctype === 'ground') {
          return gY;
        }
      }
    }
    return terrY;
  }

  // Sample all 4 track contact corners (FL, FR, RL, RR) for exact planar Y, pitch, and roll!
  function sampleFourTrackGround(v, out) {
    const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
    const rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);
    const sampleL = v.halfL * 0.68;
    const sampleW = v.spec.trackX;
    const refY = v.pos[1] + 0.9;
    const ig = v.colliderId;

    const yFL = getTrackSurfaceY(v.pos[0] + fx * sampleL - rx * sampleW, v.pos[2] + fz * sampleL - rz * sampleW, refY, ig);
    const yFR = getTrackSurfaceY(v.pos[0] + fx * sampleL + rx * sampleW, v.pos[2] + fz * sampleL + rz * sampleW, refY, ig);
    const yRL = getTrackSurfaceY(v.pos[0] - fx * sampleL - rx * sampleW, v.pos[2] - fz * sampleL - rz * sampleW, refY, ig);
    const yRR = getTrackSurfaceY(v.pos[0] - fx * sampleL + rx * sampleW, v.pos[2] - fz * sampleL + rz * sampleW, refY, ig);

    const avgY = (yFL + yFR + yRL + yRR) * 0.25;
    const yFront = (yFL + yFR) * 0.5;
    const yRear  = (yRL + yRR) * 0.5;
    const yLeft  = (yFL + yRL) * 0.5;
    const yRight = (yFR + yRR) * 0.5;

    // Right-handed Y-up: +pitch lifts -Z (front) up; +roll lifts +X (right) up!
    const pitch = clamp(Math.atan2(yFront - yRear, sampleL * 2), -0.28, 0.28);
    const roll  = clamp(Math.atan2(yRight - yLeft, sampleW * 2), -0.24, 0.24);

    // Subtle 1.5cm heavy-armor ground contact sink + check worst corner so ZERO track floats!
    const sinP = Math.sin(pitch), sinR = Math.sin(roll);
    const eFL = (avgY + sampleL * sinP - sampleW * sinR) - yFL;
    const eFR = (avgY + sampleL * sinP + sampleW * sinR) - yFR;
    const eRL = (avgY - sampleL * sinP - sampleW * sinR) - yRL;
    const eRR = (avgY - sampleL * sinP + sampleW * sinR) - yRR;
    const maxAirGap = Math.max(0, eFL, eFR, eRL, eRR);

    out.y = avgY - maxAirGap * 0.5 - 0.015;
    out.pitch = pitch;
    out.roll = roll;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Vehicle Class & Variant Specifications
  // ---------------------------------------------------------------------------
  const SPECS = {
    t64bv: {
      variant: 't64bv',
      role: 'mbt',
      type: 'tank',
      faction: 'UA',
      name: 'T-64BV',
      displayName: 'T-64BV 主战坦克',
      texKey: 'armor_ua',
      hullColor: [1.06, 1.02, 0.84],
      maxHp: 1000,
      halfW: 1.72,
      halfL: 3.30,
      height: 2.38,
      radius: 2.20,
      maxSpeed: 12.2,
      maxReverse: 4.6,
      accel: 5.4,
      brake: 10.5,
      turnRate: 0.86,
      turretSlew: 1.28,
      pitchMin: -0.105, // -6 deg
      pitchMax: 0.314,  // +18 deg
      turretPivot: [0, 1.40, -0.14],
      gunPivot: [0, 0.36, -1.08], // local to turret
      barrelLen: 4.55,
      coaxOffset: [0.24, 0.34, -1.15],
      sightOffset: [-0.46, 0.62, -0.78],
      primary: {
        id: 'tank_125',
        projectileType: 'tank125',
        name: '125mm 2A46M-1',
        displayName: '125mm 高爆穿甲炮',
        caliber: '125mm HE-FRAG / APFSDS',
        reloadTime: 4.2,
        ammoMax: 28,
        muzzleVel: 195,
        gravity: 5.2,
        damage: 290,
        vehicleDamage: 340,
        armorPen: 0.96,
        explosiveRadius: 6.8,
        explosiveDamage: 245,
        suppressionPower: 0.9,
        recoilDist: 0.44,
        suspImpulse: 0.85,
        audioProfile: 'tank_125',
        isTankShell: true,
        spreadHip: 0.002,
        spreadAds: 0.001,
        spread: 0.002
      },
      secondary: {
        id: 'coax_762',
        projectileType: 'bullet',
        name: '7.62mm PKT',
        displayName: '7.62mm 并列机枪',
        caliber: '7.62x54R',
        rpm: 650,
        ammoMax: 600,
        muzzleVel: 280,
        gravity: 9.8,
        damage: 26,
        vehicleDamage: 6,
        headMult: 2.0,
        armorPen: 0.22,
        tracerInterval: 2,
        suppressionPower: 0.35,
        spreadHip: 0.014,
        spreadAds: 0.008,
        spread: 0.014,
        audioProfile: 'coax'
      },
      wheelCount: 6,
      wheelRadius: 0.30,
      wheelZStart: -2.18,
      wheelZEnd: 2.18,
      trackX: 1.38
    },

    t72b3: {
      variant: 't72b3',
      role: 'mbt',
      type: 'tank',
      faction: 'RU',
      name: 'T-72B3',
      displayName: 'T-72B3 主战坦克',
      texKey: 'armor_ru',
      hullColor: [0.54, 0.60, 0.52],
      maxHp: 1000,
      halfW: 1.78,
      halfL: 3.42,
      height: 2.42,
      radius: 2.25,
      maxSpeed: 12.6,
      maxReverse: 4.2,
      accel: 5.6,
      brake: 10.5,
      turnRate: 0.88,
      turretSlew: 1.24,
      pitchMin: -0.10,
      pitchMax: 0.295,
      turretPivot: [0, 1.42, -0.10],
      gunPivot: [0, 0.36, -1.12],
      barrelLen: 4.75,
      coaxOffset: [0.24, 0.34, -1.18],
      sightOffset: [-0.48, 0.65, -0.82],
      primary: {
        id: 'tank_125',
        projectileType: 'tank125',
        name: '125mm 2A46M-5',
        displayName: '125mm 滑膛主炮',
        caliber: '125mm HE-FRAG / APFSDS',
        reloadTime: 4.2,
        ammoMax: 28,
        muzzleVel: 195,
        gravity: 5.2,
        damage: 290,
        vehicleDamage: 340,
        armorPen: 0.96,
        explosiveRadius: 6.8,
        explosiveDamage: 245,
        suppressionPower: 0.9,
        recoilDist: 0.46,
        suspImpulse: 0.88,
        audioProfile: 'tank_125',
        isTankShell: true,
        spreadHip: 0.0022,
        spreadAds: 0.001,
        spread: 0.0022
      },
      secondary: {
        id: 'coax_762',
        projectileType: 'bullet',
        name: '7.62mm PKTM',
        displayName: '7.62mm 并列机枪',
        caliber: '7.62x54R',
        rpm: 650,
        ammoMax: 600,
        muzzleVel: 280,
        gravity: 9.8,
        damage: 26,
        vehicleDamage: 6,
        headMult: 2.0,
        armorPen: 0.22,
        tracerInterval: 2,
        suppressionPower: 0.35,
        spreadHip: 0.014,
        spreadAds: 0.008,
        spread: 0.014,
        audioProfile: 'coax'
      },
      wheelCount: 6,
      wheelRadius: 0.36,
      wheelZStart: -2.24,
      wheelZEnd: 2.24,
      trackX: 1.42
    },

    bradley: {
      variant: 'bradley',
      role: 'ifv',
      type: 'ifv',
      faction: 'UA',
      name: 'M2A2 Bradley',
      displayName: 'M2A2 布雷德利步战车',
      texKey: 'armor_ua',
      hullColor: [1.10, 1.04, 0.86],
      maxHp: 740,
      halfW: 1.62,
      halfL: 3.12,
      height: 2.86,
      radius: 2.02,
      maxSpeed: 15.8,
      maxReverse: 6.2,
      accel: 7.4,
      brake: 12.6,
      turnRate: 1.15,
      turretSlew: 1.95,
      pitchMin: -0.14,
      pitchMax: 0.62, // +35 deg anti-building/drone
      turretPivot: [0, 1.86, 0.14],
      gunPivot: [0, 0.40, -0.84],
      barrelLen: 2.45,
      coaxOffset: [-0.95, 0.56, -0.25], // TOW launcher pod left of turret
      sightOffset: [0.46, 0.64, -0.66],
      primary: {
        id: 'ifv_25mm',
        projectileType: 'autocannon',
        name: '25mm M242 Bushmaster',
        displayName: '25mm 大毒蛇链炮',
        caliber: '25mm HEI-T',
        rpm: 240,
        reloadTime: 0.25,
        ammoMax: 240,
        muzzleVel: 240,
        gravity: 4.5,
        damage: 74,
        vehicleDamage: 68,
        armorPen: 0.58,
        explosiveRadius: 2.3,
        explosiveDamage: 62,
        tracerInterval: 1,
        suppressionPower: 0.55,
        recoilDist: 0.11,
        suspImpulse: 0.14,
        audioProfile: 'autocannon',
        isAutocannon: true,
        spreadHip: 0.008,
        spreadAds: 0.004,
        spread: 0.008
      },
      secondary: {
        id: 'atgm_tow',
        projectileType: 'atgm',
        guided: true,
        name: 'BGM-71 TOW-2',
        displayName: 'TOW-2 反坦克导弹',
        caliber: '152mm ATGM',
        reloadTime: 8.0,
        ammoMax: 6,
        muzzleVel: 78,
        gravity: 0.25,
        damage: 255,
        vehicleDamage: 320,
        armorPen: 0.94,
        explosiveRadius: 5.2,
        explosiveDamage: 210,
        suppressionPower: 0.85,
        isATGM: true,
        spreadHip: 0.001,
        spreadAds: 0.001,
        audioProfile: 'rpg'
      },
      wheelCount: 6,
      wheelRadius: 0.32,
      wheelZStart: -2.08,
      wheelZEnd: 2.08,
      trackX: 1.32
    },

    bmp2: {
      variant: 'bmp2',
      role: 'ifv',
      type: 'ifv',
      faction: 'RU',
      name: 'BMP-2',
      displayName: 'BMP-2 步兵战车',
      texKey: 'armor_ru',
      hullColor: [0.54, 0.60, 0.52],
      maxHp: 560,
      halfW: 1.54,
      halfL: 3.28,
      height: 2.26,
      radius: 1.98,
      maxSpeed: 16.5,
      maxReverse: 6.0,
      accel: 7.8,
      brake: 12.8,
      turnRate: 1.18,
      turretSlew: 1.90,
      pitchMin: -0.105,
      pitchMax: 0.65, // 2A42 high elevation!
      turretPivot: [0, 1.36, 0.22],
      gunPivot: [0, 0.34, -0.82],
      barrelLen: 2.85,
      coaxOffset: [0.18, 0.90, -0.05], // roof Konkurs ATGM tube
      sightOffset: [-0.42, 0.56, -0.58],
      primary: {
        id: 'ifv_30mm',
        projectileType: 'autocannon',
        name: '30mm 2A42',
        displayName: '30mm 2A42 机关炮',
        caliber: '30x165mm HEI-T',
        rpm: 300,
        reloadTime: 0.20,
        ammoMax: 280,
        muzzleVel: 245,
        gravity: 4.5,
        damage: 70,
        vehicleDamage: 64,
        armorPen: 0.56,
        explosiveRadius: 2.4,
        explosiveDamage: 60,
        tracerInterval: 1,
        suppressionPower: 0.55,
        recoilDist: 0.12,
        suspImpulse: 0.15,
        audioProfile: 'autocannon',
        isAutocannon: true,
        spreadHip: 0.010,
        spreadAds: 0.005,
        spread: 0.010
      },
      secondary: {
        id: 'atgm_konkurs',
        projectileType: 'atgm',
        guided: true,
        name: '9M113 Konkurs',
        displayName: '9M113 竞赛反坦克导弹',
        caliber: '135mm ATGM',
        reloadTime: 8.0,
        ammoMax: 5,
        muzzleVel: 76,
        gravity: 0.25,
        damage: 245,
        vehicleDamage: 310,
        armorPen: 0.92,
        explosiveRadius: 5.0,
        explosiveDamage: 205,
        suppressionPower: 0.85,
        isATGM: true,
        spreadHip: 0.001,
        spreadAds: 0.001,
        audioProfile: 'rpg'
      },
      wheelCount: 6,
      wheelRadius: 0.30,
      wheelZStart: -2.14,
      wheelZEnd: 2.14,
      trackX: 1.24
    }
  };

  // ---------------------------------------------------------------------------
  // High-Poly Multi-Part Mesh Builders (Bottom of tracks strictly at Y = 0.0)
  // ---------------------------------------------------------------------------
  function buildTrackAssembly(spec, gl) {
    const bTracks = new DF.MeshGen.Builder();
    const bSprocket = new DF.MeshGen.Builder();
    const bWheelTire = new DF.MeshGen.Builder();
    const bWheelHub = new DF.MeshGen.Builder();

    const tx = spec.trackX;
    const tw = spec.role === 'mbt' ? 0.54 : 0.42;
    const wr = spec.wheelRadius;
    const z0 = spec.wheelZStart;
    const z1 = spec.wheelZEnd;
    const idlerZ = z0 - 0.66;
    const sprockZ = z1 + 0.66;
    const idlerR = wr * 0.84;
    const sprockR = wr * 0.88;
    const wheelCenterY = wr + 0.068;
    const idlerY = wheelCenterY + 0.24;
    const sprockY = wheelCenterY + 0.22;
    const topY = Math.max(idlerY + idlerR, sprockY + sprockR) + 0.04;
    const trackThick = 0.062;

    const steelLink = [0.27, 0.28, 0.27];
    const steelHighlight = [0.40, 0.41, 0.39];
    const sprocketCol = [0.46, 0.48, 0.45];
    const rubberCol = [0.16, 0.16, 0.17];
    const hubCol = spec.faction === 'UA' ? [0.64, 0.68, 0.56] : [0.50, 0.56, 0.46];
    const boltCol = [0.30, 0.32, 0.29];

    for (let side = -1; side <= 1; side += 2) {
      const sx = side * tx;

      // 1. Ground-contact lower track belt (bottom strictly flush at y = 0.0!)
      bTracks.addBox(sx, trackThick * 0.5, (z0 + z1) * 0.5, tw, trackThick, (z1 - z0) + 0.18, {
        color: steelLink, uvScale: 2.5
      });

      // 2. Upper tensioned track run
      bTracks.addBox(sx, topY, (idlerZ + sprockZ) * 0.5, tw, trackThick * 0.85, (sprockZ - idlerZ) + 0.04, {
        color: steelLink, uvScale: 2.5
      });

      // 3. Articulated lower track grouser pads & side end-connectors (visible along ground contact!)
      const padCount = 16;
      for (let c = 0; c < padCount; c++) {
        const cz = lerp(z0 - 0.06, z1 + 0.06, c / (padCount - 1));
        bTracks.addBox(sx, trackThick + 0.014, cz, tw + 0.03, 0.024, 0.11, { color: steelHighlight });
        bTracks.addBox(sx + side * (tw * 0.51), trackThick * 0.55, cz, 0.032, 0.055, 0.09, { color: steelHighlight });
      }

      // 4. Front sloped track ascent (front wheel bottom -> idler outer rim)
      const fStartZ = z0 - 0.06, fStartY = trackThick * 0.5;
      const fEndZ = idlerZ - idlerR * 0.68, fEndY = idlerY - idlerR * 0.45;
      const frontLen = Math.hypot(fEndZ - fStartZ, fEndY - fStartY);
      const frontAng = Math.atan2(fEndY - fStartY, fStartZ - fEndZ);
      bTracks.addBox(sx, (fStartY + fEndY) * 0.5, (fStartZ + fEndZ) * 0.5, tw, trackThick * 0.9, frontLen + 0.06, {
        color: steelLink, rotX: frontAng, uvScale: 2.0
      });
      // Smoothly tangent curved track shoes wrapping around the front idler arc (exact tangent rotX = -(ang + PI/2)!)
      for (let a = 0; a < 7; a++) {
        const ang = lerp(-2.75, -Math.PI * 0.52, a / 6);
        const cz = idlerZ + Math.cos(ang) * (idlerR + 0.025);
        const cy = idlerY + Math.sin(ang) * (idlerR + 0.025);
        bTracks.addBox(sx, cy, cz, tw + 0.015, 0.044, 0.14, { color: steelHighlight, rotX: -(ang + Math.PI * 0.5) });
      }

      // 5. Rear sloped track ascent (rear wheel bottom -> drive sprocket outer rim)
      const rStartZ = z1 + 0.06, rStartY = trackThick * 0.5;
      const rEndZ = sprockZ + sprockR * 0.68, rEndY = sprockY - sprockR * 0.45;
      const rearLen = Math.hypot(rEndZ - rStartZ, rEndY - rStartY);
      const rearAng = Math.atan2(rEndY - rStartY, rEndZ - rStartZ);
      bTracks.addBox(sx, (rStartY + rEndY) * 0.5, (rStartZ + rEndZ) * 0.5, tw, trackThick * 0.9, rearLen + 0.06, {
        color: steelLink, rotX: -rearAng, uvScale: 2.0
      });
      // Smoothly tangent curved track shoes wrapping around the toothed rear drive sprocket!
      for (let a = 0; a < 7; a++) {
        const ang = lerp(-0.62, Math.PI * 0.5, a / 6);
        const cz = sprockZ + Math.cos(ang) * (sprockR + 0.028);
        const cy = sprockY + Math.sin(ang) * (sprockR + 0.028);
        bTracks.addBox(sx, cy, cz, tw + 0.015, 0.044, 0.14, { color: steelHighlight, rotX: -(ang + Math.PI * 0.5) });
      }

      // 6. Front Idler Wheel (twin steel discs + center hub — NOT a solid black drum!)
      addCyl(bSprocket, sx + side * (tw * 0.24), idlerY, idlerZ, idlerR, idlerR, 0.075, 16, { axis: 'x', color: hubCol });
      addCyl(bSprocket, sx - side * (tw * 0.24), idlerY, idlerZ, idlerR, idlerR, 0.075, 16, { axis: 'x', color: hubCol });
      addCyl(bSprocket, sx, idlerY, idlerZ, idlerR * 0.42, idlerR * 0.42, tw * 0.88, 12, { axis: 'x', color: sprocketCol });
      addCyl(bSprocket, sx + side * (tw * 0.34), idlerY, idlerZ, idlerR * 0.26, idlerR * 0.26, 0.08, 10, { axis: 'x', color: boltCol });

      // 7. Rear Toothed Drive Sprocket (twin cog rings + 10 visible radial gear teeth + final drive hub!)
      addCyl(bSprocket, sx + side * (tw * 0.26), sprockY, sprockZ, sprockR * 0.92, sprockR * 0.92, 0.065, 16, { axis: 'x', color: sprocketCol });
      addCyl(bSprocket, sx - side * (tw * 0.26), sprockY, sprockZ, sprockR * 0.92, sprockR * 0.92, 0.065, 16, { axis: 'x', color: sprocketCol });
      addCyl(bSprocket, sx, sprockY, sprockZ, sprockR * 0.52, sprockR * 0.52, tw * 0.90, 14, { axis: 'x', color: hubCol });
      addCyl(bSprocket, sx + side * (tw * 0.38), sprockY, sprockZ, sprockR * 0.30, sprockR * 0.30, 0.09, 10, { axis: 'x', color: boltCol });
      for (let t = 0; t < 10; t++) {
        const ta = (t / 10) * Math.PI * 2;
        const ty = sprockY + Math.sin(ta) * (sprockR + 0.015);
        const tz = sprockZ + Math.cos(ta) * (sprockR + 0.015);
        bSprocket.addBox(sx + side * (tw * 0.26), ty, tz, 0.072, 0.055, 0.055, { color: steelHighlight, rotX: -ta });
        bSprocket.addBox(sx - side * (tw * 0.26), ty, tz, 0.072, 0.055, 0.055, { color: steelHighlight, rotX: -ta });
      }

      // 8. 3 Return Rollers + Suspension Torsion-Bar Swing Arms
      for (let r = 0; r < 3; r++) {
        const rz = lerp(z0 + 0.45, z1 - 0.45, r / 2);
        addCyl(bSprocket, sx, topY - 0.11, rz, 0.095, 0.095, tw * 0.62, 10, { axis: 'x', color: steelLink });
      }
      for (let i = 0; i < spec.wheelCount; i++) {
        const wz = lerp(z0, z1, i / (spec.wheelCount - 1));
        bSprocket.addBox(sx - side * (tw * 0.44), wheelCenterY + 0.06, wz + 0.12, 0.11, 0.10, 0.32, {
          color: boltCol, rotX: 0.28
        });
      }
    }

    // 9. Twin-Rim Roadwheel Mesh (split cleanly into dark rubber tires + painted olive steel hubs!)
    const rimSep = tw * 0.22;
    const tireW = tw * 0.28;
    for (let h = -1; h <= 1; h += 2) {
      // Outer rubber roadwheel tire
      addCyl(bWheelTire, h * rimSep, 0, 0, wr, wr, tireW, 18, { axis: 'x', color: rubberCol });
      // Stamped olive/steel dish rim (clearly visible against dark tire!)
      addCyl(bWheelHub, h * rimSep, 0, 0, wr * 0.76, wr * 0.76, tireW + 0.025, 16, { axis: 'x', color: hubCol });
      addCyl(bWheelHub, h * rimSep, 0, 0, wr * 0.56, wr * 0.56, tireW + 0.042, 14, { axis: 'x', color: [hubCol[0] * 0.84, hubCol[1] * 0.84, hubCol[2] * 0.84] });
    }
    // Central armored wheel hub cap + axle tube
    addCyl(bWheelHub, 0, 0, 0, wr * 0.32, wr * 0.32, tw * 0.84, 12, { axis: 'x', color: sprocketCol });
    addCyl(bWheelTire, 0, 0, 0, wr * 0.18, wr * 0.18, tw * 0.90, 10, { axis: 'x', color: boltCol });
    // 6 Radial reinforcement spokes & bolt studs so wheel rotation reads crisply!
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const by = Math.sin(a) * wr * 0.54;
      const bz = Math.cos(a) * wr * 0.54;
      bWheelHub.addBox(0, by, bz, tw * 0.80, 0.052, 0.052, { color: [hubCol[0] * 1.12, hubCol[1] * 1.12, hubCol[2] * 1.12], rotX: -a });
    }

    return {
      tracks: buildMesh(bTracks, gl),
      sprockets: buildMesh(bSprocket, gl),
      wheelTire: buildMesh(bWheelTire, gl),
      wheelHub: buildMesh(bWheelHub, gl)
    };
  }

  // Reusable detailed Soviet external cylindrical diesel fuel drum (ZERO pinched cap UVs!)
  function addFuelDrum(bDrum, bBracket, cx, cy, cz, len, r, colDrum, colBracket) {
    // Open-ended cylindrical shell -> clean seamless wrap UVs!
    addCyl(bDrum, cx, cy, cz, r, r, len, 18, { axis: 'x', openEnded: true, color: colDrum });
    // Stamped beveled flat end-cap plates (recessed inner disc + crisp outer flange rim, no radial pinch!)
    for (let s = -1; s <= 1; s += 2) {
      const ex = cx + s * (len * 0.5);
      addCyl(bDrum, ex, cy, cz, r * 1.03, r * 1.03, 0.032, 18, { axis: 'x', openEnded: true, color: [colDrum[0] * 0.85, colDrum[1] * 0.85, colDrum[2] * 0.85] });
      // Octagonal recessed steel drum head plate + circular stamped center hub (zero pinched UVs or boxy plugs!)
      bDrum.addBox(ex - s * 0.012, cy, cz, 0.022, r * 1.56, r * 1.56, { color: [colDrum[0] * 0.90, colDrum[1] * 0.90, colDrum[2] * 0.90] });
      bDrum.addBox(ex - s * 0.012, cy, cz, 0.022, r * 1.56, r * 1.56, { color: [colDrum[0] * 0.90, colDrum[1] * 0.90, colDrum[2] * 0.90], rotX: Math.PI * 0.25 });
      addCyl(bBracket, ex + s * 0.006, cy, cz, r * 0.25, r * 0.28, 0.026, 12, { axis: 'x', color: colBracket });
    }
    // 3 Raised circumferential rolling-hoop ribs around the barrel
    for (let k = -1; k <= 1; k++) {
      addCyl(bDrum, cx + k * (len * 0.28), cy, cz, r * 1.045, r * 1.045, 0.036, 18, { axis: 'x', openEnded: true, color: [colDrum[0] * 0.82, colDrum[1] * 0.82, colDrum[2] * 0.82] });
    }
    // Top filler bung cap + Twin heavy steel C-cradle mounting brackets & tension straps
    addCyl(bBracket, cx + len * 0.16, cy + r + 0.02, cz, 0.042, 0.046, 0.045, 10, { axis: 'y', color: colBracket });
    for (let s = -1; s <= 1; s += 2) {
      const bx = cx + s * (len * 0.30);
      addCyl(bBracket, bx, cy, cz, r * 1.055, r * 1.055, 0.045, 16, { axis: 'x', openEnded: true, color: colBracket });
      bBracket.addBox(bx, cy - r * 0.65, cz - r * 0.72, 0.06, r * 0.95, 0.34, { color: colBracket });
      bBracket.addBox(bx, cy - r * 1.06, cz - r * 0.15, 0.06, 0.06, r * 1.45, { color: colBracket });
    }
  }

  function buildT64BV(gl) {
    const spec = SPECS.t64bv;
    const gear = buildTrackAssembly(spec, gl);
    const bHull = new DF.MeshGen.Builder();
    const bMetal = new DF.MeshGen.Builder();
    const bDrums = new DF.MeshGen.Builder();
    const bMark = new DF.MeshGen.Builder();
    const bEngine = new DF.MeshGen.Builder();
    const bTurret = new DF.MeshGen.Builder();
    const bTurretMetal = new DF.MeshGen.Builder();
    const bTurretMark = new DF.MeshGen.Builder();
    const bGun = new DF.MeshGen.Builder();

    const baseCol = [0.92, 0.94, 0.88];
    const eraCol = [0.80, 0.84, 0.76];
    const darkMetal = [0.32, 0.34, 0.33];
    const gunCol = [0.40, 0.42, 0.40];
    const drumCol = [0.46, 0.52, 0.38];
    const uaBlue = [0.14, 0.58, 1.0];
    const uaYellow = [0.92, 0.96, 1.0];

    // Main lower + upper armored hull tub (baked vertex AO + crisp non-noisy camo UV scale)
    addBevel(bHull, 0, 0.92, 0.15, 2.24, 0.88, 5.45, 0.08, { color: baseCol, aoBottom: 0.64, aoTop: 1.0, uvScale: 0.42 });
    // Sloped front upper glacis plate
    bHull.addBox(0, 1.06, -2.56, 2.22, 0.22, 1.48, { color: baseCol, rotX: 0.42, uvScale: 0.42 });
    // Lower front glacis belly plate
    bHull.addBox(0, 0.58, -2.96, 2.20, 0.22, 0.82, { color: [0.72, 0.74, 0.68], rotX: -0.62, uvScale: 0.42 });
    // Track fenders + raised segmented tactical side skirts (exposing lower 70% of all 6 roadwheels!)
    for (let s = -1; s <= 1; s += 2) {
      bHull.addBox(s * 1.38, 1.12, -0.05, 0.64, 0.11, 6.08, { color: baseCol, uvScale: 0.42 });
      // 6 discrete hinged side skirt plates stopping cleanly at y = 0.68 so roadwheels & track links shine!
      for (let p = 0; p < 6; p++) {
        const pz = -2.35 + p * 0.90;
        addBevel(bHull, s * 1.68, 0.89, pz, 0.075, 0.40, 0.85, 0.015, { color: [0.76, 0.80, 0.74], aoBottom: 0.68, aoTop: 1.0, uvScale: 0.48 });
        // Hinged skirt mounting bolts along top seam
        bMetal.addBox(s * 1.71, 1.06, pz, 0.04, 0.045, 0.18, { color: darkMetal });
      }
      // Front skirt Kontakt-1 ERA panels (5 bricks per side)
      for (let i = 0; i < 5; i++) {
        addBevel(bHull, s * 1.75, 0.94, -2.35 + i * 0.54, 0.10, 0.30, 0.46, 0.02, { color: eraCol, aoBottom: 0.72, aoTop: 1.0, uvScale: 0.55 });
      }
      // Side stowage boxes on rear fenders
      addBevel(bHull, s * 1.44, 1.32, 1.55, 0.42, 0.30, 1.52, 0.03, { color: [0.78, 0.82, 0.74], aoBottom: 0.70, aoTop: 1.0, uvScale: 0.48 });
      // Front angled mudflap & tow shackle
      bMetal.addBox(s * 1.38, 0.96, -3.12, 0.58, 0.28, 0.05, { color: darkMetal, rotX: 0.30 });
      bMetal.addBox(s * 0.86, 0.76, -3.22, 0.14, 0.14, 0.24, { color: darkMetal });
      addCyl(bMetal, s * 1.15, 1.24, -2.92, 0.085, 0.085, 0.14, 10, { axis: 'z', color: [0.55, 0.55, 0.50] });
    }

    // Kontakt-1 ERA brick rows on front upper glacis (2 rows x 7 bricks!)
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 7; i++) {
        const ex = -0.96 + i * 0.32;
        const ez = -2.84 + row * 0.42;
        const ey = 0.96 + row * 0.18;
        addBevel(bHull, ex, ey, ez, 0.28, 0.13, 0.36, 0.015, { color: eraCol, rotX: 0.42 });
      }
    }

    // Driver periscope hood
    addBevel(bHull, 0, 1.40, -1.96, 0.52, 0.18, 0.42, 0.03, { color: [0.75, 0.78, 0.72] });
    bMetal.addBox(0, 1.44, -2.14, 0.32, 0.07, 0.06, { color: [0.16, 0.24, 0.28] });

    // Clean Matte Olive-Steel Rear Twin External Diesel Fuel Drums + Mounting Brackets (zero pinched UVs!)
    for (let s = -1; s <= 1; s += 2) {
      addFuelDrum(bDrums, bMetal, s * 0.62, 1.15, 3.14, 0.96, 0.26, drumCol, darkMetal);
    }

    // Flush recessed rear engine radiator louver deck (glows white-hot in FLIR!)
    addBevel(bMetal, 0, 1.37, 1.98, 1.82, 0.06, 1.54, 0.015, { color: [0.42, 0.45, 0.40] });
    bEngine.addBox(0, 1.39, 1.98, 1.66, 0.035, 1.38, { color: [0.22, 0.22, 0.21] });
    for (let r = 0; r < 9; r++) {
      bEngine.addBox(0, 1.412, 1.38 + r * 0.15, 1.58, 0.022, 0.055, { color: [0.34, 0.35, 0.33], rotX: 0.22 });
    }
    // Exhaust pipe outlet on rear plate
    bEngine.addBox(0, 0.92, 2.90, 1.15, 0.15, 0.12, { color: [0.25, 0.24, 0.23] });

    // Prominent UA Yellow/Blue tactical ID plates on side skirts, rear deck & front glacis
    for (let s = -1; s <= 1; s += 2) {
      bMark.addBox(s * 1.74, 0.99, 0.88, 0.03, 0.16, 1.06, { color: uaBlue });
      bMark.addBox(s * 1.74, 0.83, 0.88, 0.03, 0.16, 1.06, { color: uaYellow });
    }
    bMark.addBox(0, 1.39, 2.82, 1.12, 0.03, 0.15, { color: uaBlue });
    bMark.addBox(0, 1.39, 2.67, 1.12, 0.03, 0.15, { color: uaYellow });
    bMark.addBox(0.76, 1.24, -2.50, 0.46, 0.035, 0.18, { color: uaBlue, rotX: 0.42 });
    bMark.addBox(0.76, 1.17, -2.66, 0.46, 0.035, 0.18, { color: uaYellow, rotX: 0.42 });

    // --- T-64BV Cast Turret (local to turretPivot [0, 1.40, -0.14]) ---
    addCyl(bTurret, 0, 0.34, 0.0, 1.04, 1.24, 0.68, 16, { axis: 'y', color: baseCol, aoBottom: 0.72, aoTop: 1.0, uvScale: 0.40 });
    addBevel(bTurret, 0, 0.34, -0.45, 1.56, 0.62, 1.02, 0.12, { color: baseCol, aoBottom: 0.72, aoTop: 1.0, uvScale: 0.42 });
    addBevel(bTurret, 0, 0.34, 0.76, 1.44, 0.54, 0.78, 0.08, { color: [0.82, 0.86, 0.78], aoBottom: 0.72, aoTop: 1.0, uvScale: 0.42 });
    addCyl(bTurretMetal, 0, 0.56, 1.24, 0.10, 0.10, 1.36, 12, { axis: 'x', color: darkMetal });

    // Iconic Kontakt-1 ERA brick chevrons wrapping front turret cheeks!
    const cheekAngles = [-0.88, -0.58, -0.32, 0.32, 0.58, 0.88];
    for (let i = 0; i < cheekAngles.length; i++) {
      const a = cheekAngles[i];
      const rad = 1.24;
      const ex = Math.sin(a) * rad;
      const ez = -Math.cos(a) * rad - 0.06;
      addBevel(bTurret, ex, 0.36, ez, 0.32, 0.36, 0.16, 0.02, { color: eraCol, rotY: -a, rotX: 0.18, aoBottom: 0.74, aoTop: 1.0, uvScale: 0.55 });
      addBevel(bTurret, ex * 0.78, 0.66, ez * 0.78, 0.26, 0.10, 0.30, 0.015, { color: eraCol, rotY: -a, uvScale: 0.55 });
    }

    // Commander cupola (right) & Gunner hatch + 1G42 sight hood (left)
    addCyl(bTurret, 0.44, 0.74, 0.18, 0.34, 0.38, 0.22, 14, { axis: 'y', color: [0.80, 0.84, 0.76] });
    addCyl(bTurret, -0.44, 0.71, 0.10, 0.30, 0.33, 0.14, 14, { axis: 'y', color: [0.80, 0.84, 0.76] });
    addBevel(bTurretMetal, -0.46, 0.74, -0.62, 0.26, 0.24, 0.38, 0.02, { color: darkMetal });

    // Roof 12.7mm NSVT heavy machine gun on commander cupola
    bTurretMetal.addBox(0.46, 0.96, 0.02, 0.14, 0.18, 0.56, { color: gunCol });
    addCyl(bTurretMetal, 0.46, 0.98, -0.62, 0.026, 0.032, 0.88, 8, { axis: 'z', color: gunCol });
    bTurretMetal.addBox(0.62, 0.94, 0.06, 0.18, 0.16, 0.24, { color: [0.36, 0.40, 0.32] });

    // 8x 81mm Tucha smoke grenade launchers mounted on solid cheek brackets!
    for (let s = -1; s <= 1; s += 2) {
      bTurretMetal.addBox(s * 1.12, 0.46, 0.06, 0.14, 0.14, 0.66, { color: darkMetal, rotY: -s * 0.22 });
      for (let k = 0; k < 4; k++) {
        addCyl(bTurretMetal, s * (1.13 + k * 0.025), 0.52 + (k % 2) * 0.075, -0.16 + k * 0.15,
          0.038, 0.040, 0.30, 8, { axis: 'z', color: darkMetal, rotX: 0.48, rotY: s * 0.16 });
      }
    }
    addCyl(bTurretMetal, -0.58, 1.48, 0.76, 0.012, 0.022, 1.68, 6, { axis: 'y', color: darkMetal });

    for (let s = -1; s <= 1; s += 2) {
      bTurretMark.addBox(s * 0.90, 0.46, 0.72, 0.03, 0.16, 0.64, { color: uaBlue });
      bTurretMark.addBox(s * 0.90, 0.30, 0.72, 0.03, 0.16, 0.64, { color: uaYellow });
    }
    bTurretMark.addBox(0, 0.46, 1.16, 0.68, 0.14, 0.03, { color: uaBlue });
    bTurretMark.addBox(0, 0.32, 1.16, 0.68, 0.14, 0.03, { color: uaYellow });

    // --- 125mm 2A46M-1 Smoothbore Cannon ---
    addBevel(bGun, 0, 0, 0.05, 0.62, 0.42, 0.48, 0.05, { color: [0.46, 0.50, 0.44] });
    addCyl(bGun, 0, 0, -0.95, 0.095, 0.115, 1.85, 14, { axis: 'z', color: gunCol });
    addCyl(bGun, 0, 0, -2.18, 0.145, 0.145, 0.76, 16, { axis: 'z', color: [0.48, 0.52, 0.46] });
    addCyl(bGun, 0, 0, -1.78, 0.145, 0.105, 0.12, 14, { axis: 'z', color: gunCol });
    addCyl(bGun, 0, 0, -2.58, 0.100, 0.145, 0.12, 14, { axis: 'z', color: gunCol });
    addCyl(bGun, 0, 0, -3.56, 0.082, 0.095, 1.94, 14, { axis: 'z', color: gunCol });
    addCyl(bGun, 0, 0, -4.48, 0.094, 0.088, 0.16, 12, { axis: 'z', color: darkMetal });
    bGun.addBox(0, 0.12, -4.42, 0.04, 0.08, 0.08, { color: darkMetal });
    addCyl(bGun, 0.24, -0.02, -0.45, 0.022, 0.024, 0.76, 8, { axis: 'z', color: darkMetal });

    // Tactical headlights & rear blackout convoy tail lamps (subtle emissive glint in planar wet puddles!)
    const bLights = new DF.MeshGen.Builder();
    for (let s = -1; s <= 1; s += 2) {
      bLights.addSphere(s * 1.15, 1.24, -2.99, 0.068, 8, 6, { color: [1.0, 0.90, 0.68] });
      bLights.addBox(s * 1.38, 1.10, 3.04, 0.12, 0.055, 0.03, { color: [1.0, 0.16, 0.10] });
    }
    // Coated optical glass lens inside 1G42 gunner sight housing
    const bTurretOptic = new DF.MeshGen.Builder();
    bTurretOptic.addBox(-0.46, 0.74, -0.82, 0.18, 0.13, 0.025, { color: [0.16, 0.46, 0.54] });

    return {
      tracks: gear.tracks,
      sprockets: gear.sprockets,
      wheelTire: gear.wheelTire,
      wheelHub: gear.wheelHub,
      hull: buildMesh(bHull, gl),
      hullMetal: buildMesh(bMetal, gl),
      hullDrums: buildMesh(bDrums, gl),
      hullMark: buildMesh(bMark, gl),
      hullLights: buildMesh(bLights, gl),
      engine: buildMesh(bEngine, gl),
      turret: buildMesh(bTurret, gl),
      turretMetal: buildMesh(bTurretMetal, gl),
      turretMark: buildMesh(bTurretMark, gl),
      turretOptic: buildMesh(bTurretOptic, gl),
      gun: buildMesh(bGun, gl)
    };
  }

  function buildT72B3(gl) {
    const spec = SPECS.t72b3;
    const gear = buildTrackAssembly(spec, gl);
    const bHull = new DF.MeshGen.Builder();
    const bMetal = new DF.MeshGen.Builder();
    const bDrums = new DF.MeshGen.Builder();
    const bMark = new DF.MeshGen.Builder();
    const bEngine = new DF.MeshGen.Builder();
    const bTurret = new DF.MeshGen.Builder();
    const bTurretMetal = new DF.MeshGen.Builder();
    const bTurretMark = new DF.MeshGen.Builder();
    const bGun = new DF.MeshGen.Builder();

    const baseCol = [0.74, 0.80, 0.72];
    const eraCol = [0.64, 0.70, 0.62];
    const darkMetal = [0.28, 0.30, 0.29];
    const gunCol = [0.36, 0.38, 0.36];
    const drumCol = [0.38, 0.45, 0.35];
    const ruWhite = [0.96, 0.96, 0.94];
    const ruRed = [0.94, 0.14, 0.12];

    // Main hull (baked vertex AO + crisp non-noisy camo UV scale)
    addBevel(bHull, 0, 0.94, 0.16, 2.30, 0.90, 5.60, 0.08, { color: baseCol, aoBottom: 0.64, aoTop: 1.0, uvScale: 0.42 });
    bHull.addBox(0, 1.08, -2.66, 2.28, 0.24, 1.56, { color: baseCol, rotX: 0.40, uvScale: 0.42 });
    bHull.addBox(0, 0.60, -3.08, 2.24, 0.22, 0.84, { color: eraCol, rotX: -0.60, uvScale: 0.42 });

    // Heavy Kontakt-5 angled wedge ERA modules across upper glacis
    for (let i = 0; i < 4; i++) {
      const ex = -0.84 + i * 0.56;
      addBevel(bHull, ex, 1.12, -2.72, 0.52, 0.18, 0.88, 0.03, { color: eraCol, rotX: 0.40, uvScale: 0.48 });
    }

    // Fenders + raised segmented rubber/ERA skirts exposing the 6 large T-72 roadwheels!
    for (let s = -1; s <= 1; s += 2) {
      bHull.addBox(s * 1.42, 1.16, -0.04, 0.66, 0.11, 6.28, { color: baseCol, uvScale: 0.42 });
      // 6 discrete rubberized side skirt segments stopping at y = 0.72 so roadwheels & sprockets read cleanly!
      for (let p = 0; p < 6; p++) {
        const pz = -2.30 + p * 0.94;
        bMetal.addBox(s * 1.73, 0.93, pz, 0.065, 0.40, 0.88, { color: [0.22, 0.24, 0.22], aoBottom: 0.68, aoTop: 1.0 });
      }
      // Heavy front side Kontakt-5 ERA armor blocks (3 big plates per side)
      for (let i = 0; i < 3; i++) {
        addBevel(bHull, s * 1.80, 0.98, -2.28 + i * 0.88, 0.12, 0.36, 0.80, 0.025, { color: eraCol, aoBottom: 0.72, aoTop: 1.0, uvScale: 0.48 });
      }
      addBevel(bHull, s * 1.48, 1.36, 1.50, 0.46, 0.30, 1.85, 0.03, { color: eraCol, aoBottom: 0.70, aoTop: 1.0, uvScale: 0.48 });
      bMetal.addBox(s * 0.90, 0.78, -3.35, 0.14, 0.14, 0.24, { color: darkMetal });
      addCyl(bMetal, s * 1.18, 1.26, -3.05, 0.085, 0.085, 0.14, 10, { axis: 'z', color: [0.48, 0.48, 0.44] });
    }

    // Clean Matte Olive-Steel Rear Twin Fuel Drums + Iconic Wooden Unditching Log!
    for (let s = -1; s <= 1; s += 2) {
      addFuelDrum(bDrums, bMetal, s * 0.64, 1.19, 3.26, 0.96, 0.26, drumCol, darkMetal);
    }
    addCyl(bMetal, 0, 0.82, 3.22, 0.135, 0.135, 2.38, 12, { axis: 'x', color: [0.46, 0.36, 0.24] });

    // Flush recessed hot rear engine louvers (FLIR white-hot!)
    addBevel(bMetal, 0, 1.39, 2.04, 1.86, 0.06, 1.60, 0.015, { color: [0.36, 0.40, 0.35] });
    bEngine.addBox(0, 1.41, 2.04, 1.72, 0.035, 1.44, { color: [0.22, 0.22, 0.20] });
    for (let r = 0; r < 9; r++) {
      bEngine.addBox(0, 1.432, 1.42 + r * 0.155, 1.62, 0.022, 0.055, { color: [0.32, 0.33, 0.31], rotX: 0.22 });
    }
    bEngine.addBox(-1.12, 1.06, 2.52, 0.36, 0.18, 0.42, { color: [0.24, 0.24, 0.22] });

    // Prominent RU Crimson-Red & White tactical assault stripes on flanks, front glacis & rear deck
    for (let s = -1; s <= 1; s += 2) {
      bMark.addBox(s * 1.79, 1.03, 1.15, 0.03, 0.16, 1.18, { color: ruRed });
      bMark.addBox(s * 1.79, 0.87, 1.15, 0.03, 0.16, 1.18, { color: ruWhite });
    }
    bMark.addBox(0.75, 1.24, -2.54, 0.46, 0.035, 0.20, { color: ruRed, rotX: 0.40 });
    bMark.addBox(0.75, 1.16, -2.72, 0.46, 0.035, 0.20, { color: ruWhite, rotX: 0.40 });
    bMark.addBox(0, 1.41, 2.86, 1.10, 0.03, 0.15, { color: ruRed });
    bMark.addBox(0, 1.41, 2.71, 1.10, 0.03, 0.15, { color: ruWhite });

    // --- T-72B3 Cast Turret + Iconic Arrowhead Kontakt-5 ERA Wedges ---
    addCyl(bTurret, 0, 0.35, 0.0, 1.08, 1.28, 0.70, 16, { axis: 'y', color: baseCol });
    addBevel(bTurret, 0, 0.34, 0.78, 1.48, 0.56, 0.82, 0.08, { color: eraCol });

    for (let s = -1; s <= 1; s += 2) {
      addBevel(bTurret, s * 0.72, 0.38, -1.04, 0.72, 0.44, 0.52, 0.04, {
        color: eraCol, rotY: s * 0.42, rotX: 0.20
      });
      addBevel(bTurret, s * 1.20, 0.36, -0.52, 0.58, 0.44, 0.46, 0.04, {
        color: eraCol, rotY: s * 0.92, rotX: 0.16
      });
      addBevel(bTurret, s * 1.06, 0.42, 0.55, 0.26, 0.40, 0.84, 0.02, { color: baseCol });
    }

    addBevel(bTurretMetal, -0.48, 0.76, -0.64, 0.32, 0.28, 0.42, 0.02, { color: darkMetal });
    bTurretMetal.addBox(-0.48, 0.76, -0.86, 0.22, 0.16, 0.04, { color: [0.14, 0.22, 0.28] });

    addCyl(bTurret, 0.46, 0.74, 0.14, 0.34, 0.38, 0.22, 14, { axis: 'y', color: eraCol });
    bTurretMetal.addBox(0.48, 0.98, 0.00, 0.14, 0.18, 0.58, { color: gunCol });
    addCyl(bTurretMetal, 0.48, 1.00, -0.66, 0.026, 0.032, 0.92, 8, { axis: 'z', color: gunCol });

    for (let s = -1; s <= 1; s += 2) {
      bTurretMetal.addBox(s * 1.18, 0.46, 0.12, 0.14, 0.14, 0.66, { color: darkMetal, rotY: -s * 0.20 });
      for (let k = 0; k < 4; k++) {
        addCyl(bTurretMetal, s * (1.20 + k * 0.025), 0.50 + (k % 2) * 0.075, -0.08 + k * 0.15,
          0.038, 0.040, 0.30, 8, { axis: 'z', color: darkMetal, rotX: 0.48, rotY: s * 0.16 });
      }
      addCyl(bTurretMetal, s * 0.56, 1.50, 0.84, 0.012, 0.022, 1.72, 6, { axis: 'y', color: darkMetal });
    }

    for (let s = -1; s <= 1; s += 2) {
      bTurretMark.addBox(s * 1.21, 0.49, 0.56, 0.03, 0.15, 0.72, { color: ruRed });
      bTurretMark.addBox(s * 1.21, 0.34, 0.56, 0.03, 0.15, 0.72, { color: ruWhite });
    }
    bTurretMark.addBox(0, 0.48, 1.20, 0.72, 0.14, 0.03, { color: ruRed });
    bTurretMark.addBox(0, 0.34, 1.20, 0.72, 0.14, 0.03, { color: ruWhite });

    // --- 125mm 2A46M-5 Cannon ---
    addBevel(bGun, 0, 0, 0.04, 0.64, 0.44, 0.50, 0.05, { color: [0.40, 0.44, 0.38] });
    addCyl(bGun, 0, 0, -1.02, 0.096, 0.116, 1.96, 14, { axis: 'z', color: gunCol });
    addCyl(bGun, 0, 0, -2.30, 0.148, 0.148, 0.78, 16, { axis: 'z', color: [0.44, 0.48, 0.42] });
    addCyl(bGun, 0, 0, -3.72, 0.082, 0.096, 2.06, 14, { axis: 'z', color: gunCol });
    addCyl(bGun, 0, 0, -4.68, 0.094, 0.088, 0.16, 12, { axis: 'z', color: darkMetal });
    addCyl(bGun, 0.24, -0.02, -0.45, 0.022, 0.024, 0.76, 8, { axis: 'z', color: darkMetal });

    const bLights = new DF.MeshGen.Builder();
    for (let s = -1; s <= 1; s += 2) {
      bLights.addSphere(s * 1.18, 1.26, -3.12, 0.068, 8, 6, { color: [1.0, 0.88, 0.64] });
      bLights.addBox(s * 1.42, 1.12, 3.16, 0.12, 0.055, 0.03, { color: [1.0, 0.16, 0.10] });
    }
    const bTurretOptic = new DF.MeshGen.Builder();
    bTurretOptic.addBox(-0.48, 0.76, -0.88, 0.20, 0.14, 0.025, { color: [0.16, 0.50, 0.42] });

    return {
      tracks: gear.tracks,
      sprockets: gear.sprockets,
      wheelTire: gear.wheelTire,
      wheelHub: gear.wheelHub,
      hull: buildMesh(bHull, gl),
      hullMetal: buildMesh(bMetal, gl),
      hullDrums: buildMesh(bDrums, gl),
      hullMark: buildMesh(bMark, gl),
      hullLights: buildMesh(bLights, gl),
      engine: buildMesh(bEngine, gl),
      turret: buildMesh(bTurret, gl),
      turretMetal: buildMesh(bTurretMetal, gl),
      turretMark: buildMesh(bTurretMark, gl),
      turretOptic: buildMesh(bTurretOptic, gl),
      gun: buildMesh(bGun, gl)
    };
  }

  function buildBradley(gl) {
    const spec = SPECS.bradley;
    const gear = buildTrackAssembly(spec, gl);
    const bHull = new DF.MeshGen.Builder();
    const bMetal = new DF.MeshGen.Builder();
    const bMark = new DF.MeshGen.Builder();
    const bEngine = new DF.MeshGen.Builder();
    const bTurret = new DF.MeshGen.Builder();
    const bTurretMetal = new DF.MeshGen.Builder();
    const bTurretMark = new DF.MeshGen.Builder();
    const bGun = new DF.MeshGen.Builder();

    const baseCol = [0.90, 0.90, 0.82];
    const eraCol = [0.80, 0.82, 0.74];
    const darkMetal = [0.30, 0.32, 0.30];
    const gunCol = [0.36, 0.38, 0.36];
    const uaBlue = [0.14, 0.58, 1.0];
    const uaYellow = [0.92, 0.96, 1.0];

    // Tall boxy armored hull (baked vertex AO + crisp camo UV scale)
    addBevel(bHull, 0, 1.18, 0.32, 2.26, 1.32, 4.90, 0.08, { color: baseCol, aoBottom: 0.64, aoTop: 1.0, uvScale: 0.42 });
    // Steep angled upper & lower front glacis + bow trim vane
    bHull.addBox(0, 1.38, -2.42, 2.24, 0.24, 1.44, { color: baseCol, rotX: 0.56, uvScale: 0.42 });
    bHull.addBox(0, 0.72, -2.74, 2.20, 0.22, 0.92, { color: eraCol, rotX: -0.58, uvScale: 0.42 });
    addBevel(bMetal, 0, 1.05, -3.02, 2.16, 0.16, 0.08, 0.015, { color: darkMetal, rotX: 0.35 });
    // Driver hood & vision blocks on front-left roof
    addBevel(bHull, -0.68, 1.88, -1.52, 0.62, 0.24, 0.68, 0.04, { color: baseCol, aoBottom: 0.72, aoTop: 1.0, uvScale: 0.48 });
    for (let k = -1; k <= 1; k++) {
      bMetal.addBox(-0.68 + k * 0.16, 1.93, -1.86, 0.11, 0.075, 0.055, { color: [0.14, 0.22, 0.28] });
    }

    // Heavy segmented spaced-armor side skirts + BRAT-II ERA tiles + mudflaps & tow shackles!
    for (let s = -1; s <= 1; s += 2) {
      bHull.addBox(s * 1.40, 1.54, 0.06, 0.44, 0.12, 5.52, { color: baseCol, uvScale: 0.42 });
      // 6 discrete hinged side armor plates + mounting bolts + BRAT ERA armor modules
      for (let i = 0; i < 6; i++) {
        const pz = -2.05 + i * 0.80;
        addBevel(bHull, s * 1.56, 1.18, pz, 0.14, 0.58, 0.74, 0.02, { color: baseCol, aoBottom: 0.66, aoTop: 1.0, uvScale: 0.46 });
        addBevel(bHull, s * 1.66, 1.24, pz, 0.10, 0.46, 0.66, 0.02, { color: eraCol, aoBottom: 0.72, aoTop: 1.0, uvScale: 0.52 });
        bMetal.addBox(s * 1.63, 1.50, pz, 0.05, 0.05, 0.16, { color: darkMetal });
      }
      // Front angled mudflap, armored headlight brush-guard & tow shackle
      bMetal.addBox(s * 1.32, 0.96, -2.92, 0.46, 0.28, 0.05, { color: darkMetal, rotX: 0.26 });
      bMetal.addBox(s * 1.12, 1.24, -2.96, 0.26, 0.16, 0.16, { color: darkMetal });
      bMetal.addBox(s * 0.82, 0.74, -3.02, 0.14, 0.14, 0.24, { color: darkMetal });
      // Rear fender stowage basket
      addBevel(bHull, s * 1.38, 1.72, 1.95, 0.34, 0.26, 1.22, 0.025, { color: eraCol, aoBottom: 0.72, aoTop: 1.0, uvScale: 0.48 });
    }

    // Rear troop ramp with recessed hinges & troop door outline
    addBevel(bHull, 0, 1.16, 2.86, 1.86, 1.18, 0.18, 0.04, { color: eraCol, rotX: -0.10, aoBottom: 0.66, aoTop: 1.0, uvScale: 0.44 });
    bMetal.addBox(-0.34, 1.10, 2.96, 0.64, 0.92, 0.05, { color: darkMetal });
    for (let s = -1; s <= 1; s += 2) {
      bMetal.addBox(s * 0.76, 0.64, 2.94, 0.16, 0.16, 0.14, { color: darkMetal });
    }

    // Front-right engine grille (FLIR white-hot!)
    bEngine.addBox(0.58, 1.84, -1.48, 0.94, 0.08, 1.18, { color: [0.32, 0.32, 0.30] });
    for (let r = 0; r < 5; r++) {
      bEngine.addBox(0.58, 1.89, -1.92 + r * 0.22, 0.82, 0.04, 0.09, { color: [0.22, 0.22, 0.20] });
    }

    // Prominent UA Yellow/Blue tactical ID plates on hull flanks, glacis & rear ramp
    for (let s = -1; s <= 1; s += 2) {
      bMark.addBox(s * 1.74, 1.36, 2.05, 0.03, 0.18, 1.02, { color: uaBlue });
      bMark.addBox(s * 1.74, 1.18, 2.05, 0.03, 0.18, 1.02, { color: uaYellow });
    }
    bMark.addBox(0.45, 1.48, 2.97, 0.76, 0.16, 0.03, { color: uaBlue });
    bMark.addBox(0.45, 1.32, 2.97, 0.76, 0.16, 0.03, { color: uaYellow });
    bMark.addBox(0.56, 1.56, -2.26, 0.54, 0.035, 0.20, { color: uaBlue, rotX: 0.56 });
    bMark.addBox(0.56, 1.45, -2.42, 0.54, 0.035, 0.20, { color: uaYellow, rotX: 0.56 });

    // --- M2A2 Bradley Angular Turret (local to turretPivot [0, 1.86, 0.14]) ---
    addBevel(bTurret, 0, 0.38, 0.06, 1.62, 0.74, 1.72, 0.08, { color: baseCol, aoBottom: 0.70, aoTop: 1.0, uvScale: 0.42 });
    // Angled front turret cheeks
    addBevel(bTurret, 0, 0.36, -0.78, 1.36, 0.64, 0.58, 0.08, { color: eraCol, aoBottom: 0.72, aoTop: 1.0, uvScale: 0.44 });
    // Rear bustle rack
    addBevel(bTurretMetal, 0, 0.44, 1.10, 1.44, 0.46, 0.46, 0.03, { color: darkMetal });

    // Iconic Dual-Tube TOW ATGM Launcher Pod mounted on LEFT turret side!
    addBevel(bTurret, -1.04, 0.48, -0.02, 0.44, 0.44, 1.48, 0.04, { color: eraCol, aoBottom: 0.72, aoTop: 1.0, uvScale: 0.48 });
    addCyl(bTurretMetal, -1.12, 0.50, -0.76, 0.095, 0.095, 0.12, 10, { axis: 'z', color: [0.18, 0.18, 0.18] });
    addCyl(bTurretMetal, -0.94, 0.50, -0.76, 0.095, 0.095, 0.12, 10, { axis: 'z', color: [0.18, 0.18, 0.18] });
    bTurretMetal.addBox(-0.82, 0.44, -0.05, 0.14, 0.18, 0.42, { color: darkMetal }); // pivot arm

    // Commander Independent Thermal Viewer (CIV) & IBAS sight box
    addBevel(bTurretMetal, 0.46, 0.86, -0.44, 0.34, 0.32, 0.42, 0.03, { color: darkMetal });
    addCyl(bTurret, 0.36, 0.84, 0.34, 0.30, 0.34, 0.20, 10, { axis: 'y', color: baseCol });
    // 2x4 Smoke grenade dischargers on solid armored mounting plates
    for (let s = -1; s <= 1; s += 2) {
      bTurretMetal.addBox(s * 0.72, 0.52, -0.90, 0.28, 0.12, 0.10, { color: darkMetal, rotY: s * 0.15 });
      for (let k = 0; k < 4; k++) {
        addCyl(bTurretMetal, s * (0.64 + k * 0.06), 0.56, -0.96, 0.038, 0.038, 0.28, 8, {
          axis: 'z', color: darkMetal, rotX: 0.46, rotY: s * 0.15
        });
      }
    }
    // Dual whip antennas
    addCyl(bTurretMetal, -0.62, 1.56, 0.86, 0.012, 0.020, 1.72, 6, { axis: 'y', color: darkMetal });
    addCyl(bTurretMetal, 0.62, 1.56, 0.86, 0.012, 0.020, 1.72, 6, { axis: 'y', color: darkMetal });

    // Prominent UA Yellow/Blue stripes on turret sides & rear bustle
    bTurretMark.addBox(0.84, 0.50, 0.24, 0.03, 0.16, 0.74, { color: uaBlue });
    bTurretMark.addBox(0.84, 0.34, 0.24, 0.03, 0.16, 0.74, { color: uaYellow });
    bTurretMark.addBox(-1.27, 0.54, 0.10, 0.03, 0.14, 0.66, { color: uaBlue });
    bTurretMark.addBox(-1.27, 0.40, 0.10, 0.03, 0.14, 0.66, { color: uaYellow });
    bTurretMark.addBox(0, 0.52, 1.34, 0.76, 0.14, 0.03, { color: uaBlue });
    bTurretMark.addBox(0, 0.38, 1.34, 0.76, 0.14, 0.03, { color: uaYellow });

    // --- 25mm M242 Bushmaster Autocannon (local to gunPivot [0, 0.40, -0.84]) ---
    addBevel(bGun, 0, 0, 0.02, 0.46, 0.36, 0.44, 0.04, { color: [0.46, 0.48, 0.44] });
    addCyl(bGun, 0, 0, -0.58, 0.068, 0.078, 1.10, 12, { axis: 'z', color: gunCol });
    addCyl(bGun, 0, 0, -1.68, 0.042, 0.052, 1.32, 10, { axis: 'z', color: gunCol });
    // Perforated muzzle brake
    addBevel(bGun, 0, 0, -2.36, 0.10, 0.09, 0.22, 0.015, { color: darkMetal });
    // Coaxial M240C barrel
    addCyl(bGun, 0.18, -0.02, -0.40, 0.020, 0.022, 0.68, 8, { axis: 'z', color: darkMetal });

    // Tactical headlights & rear ramp blackout convoy tail lamps
    const bLights = new DF.MeshGen.Builder();
    for (let s = -1; s <= 1; s += 2) {
      bLights.addSphere(s * 1.12, 1.24, -3.05, 0.064, 8, 6, { color: [1.0, 0.90, 0.68] });
      bLights.addBox(s * 1.08, 1.38, 2.97, 0.12, 0.055, 0.03, { color: [1.0, 0.16, 0.10] });
    }
    // Coated optical glass lenses on CIV / IBAS gunner sight housing
    const bTurretOptic = new DF.MeshGen.Builder();
    bTurretOptic.addBox(0.46, 0.86, -0.66, 0.22, 0.16, 0.025, { color: [0.16, 0.48, 0.56] });

    return {
      tracks: gear.tracks,
      sprockets: gear.sprockets,
      wheelTire: gear.wheelTire,
      wheelHub: gear.wheelHub,
      hull: buildMesh(bHull, gl),
      hullMetal: buildMesh(bMetal, gl),
      hullDrums: null,
      hullMark: buildMesh(bMark, gl),
      hullLights: buildMesh(bLights, gl),
      engine: buildMesh(bEngine, gl),
      turret: buildMesh(bTurret, gl),
      turretMetal: buildMesh(bTurretMetal, gl),
      turretMark: buildMesh(bTurretMark, gl),
      turretOptic: buildMesh(bTurretOptic, gl),
      gun: buildMesh(bGun, gl)
    };
  }

  function buildBMP2(gl) {
    const spec = SPECS.bmp2;
    const gear = buildTrackAssembly(spec, gl);
    const bHull = new DF.MeshGen.Builder();
    const bMetal = new DF.MeshGen.Builder();
    const bMark = new DF.MeshGen.Builder();
    const bEngine = new DF.MeshGen.Builder();
    const bTurret = new DF.MeshGen.Builder();
    const bTurretMetal = new DF.MeshGen.Builder();
    const bTurretMark = new DF.MeshGen.Builder();
    const bGun = new DF.MeshGen.Builder();

    const baseCol = [0.74, 0.80, 0.72];
    const shadeCol = [0.64, 0.70, 0.62];
    const darkMetal = [0.28, 0.30, 0.28];
    const gunCol = [0.36, 0.38, 0.36];
    const ruWhite = [0.96, 0.96, 0.94];
    const ruRed = [0.94, 0.14, 0.12];

    // Low sleek amphibious hull body (baked vertex AO + crisp camo UV scale)
    addBevel(bHull, 0, 0.88, 0.44, 2.22, 0.92, 4.78, 0.06, { color: baseCol, aoBottom: 0.64, aoTop: 1.0, uvScale: 0.42 });
    // Sharp iconic wedge-shaped amphibious prow!
    bHull.addBox(0, 1.06, -2.42, 2.20, 0.18, 1.92, { color: baseCol, rotX: 0.28, uvScale: 0.42 });
    bHull.addBox(0, 0.56, -2.74, 2.18, 0.18, 1.24, { color: shadeCol, rotX: -0.44, uvScale: 0.42 });
    // Nose trim vane, hinged struts & tow shackles
    bMetal.addBox(0, 0.82, -3.32, 2.16, 0.12, 0.14, { color: darkMetal });
    for (let s = -1; s <= 1; s += 2) {
      bMetal.addBox(s * 0.82, 0.72, -3.36, 0.12, 0.12, 0.20, { color: darkMetal });
    }
    // Driver periscope hood on front-left prow
    addBevel(bHull, -0.56, 1.38, -1.62, 0.46, 0.16, 0.50, 0.025, { color: shadeCol, aoBottom: 0.72, aoTop: 1.0, uvScale: 0.48 });
    bMetal.addBox(-0.56, 1.42, -1.86, 0.30, 0.065, 0.05, { color: [0.14, 0.22, 0.26] });

    // Segmented hinged amphibious side armor skirts + firing port bulges (skirt bottom at y=0.68 exposes roadwheels!)
    for (let s = -1; s <= 1; s += 2) {
      bHull.addBox(s * 1.32, 1.04, 0.02, 0.48, 0.12, 6.12, { color: baseCol, uvScale: 0.42 });
      for (let p = 0; p < 6; p++) {
        const pz = -2.35 + p * 0.94;
        addBevel(bHull, s * 1.52, 0.87, pz, 0.075, 0.34, 0.88, 0.015, { color: shadeCol, aoBottom: 0.68, aoTop: 1.0, uvScale: 0.48 });
        bMetal.addBox(s * 1.55, 1.02, pz, 0.04, 0.04, 0.16, { color: darkMetal });
      }
      // Upper sloped side troop compartment walls + grab rail
      bHull.addBox(s * 1.18, 1.18, 0.86, 0.26, 0.46, 3.65, { color: baseCol, rotZ: s * 0.36, uvScale: 0.42 });
      addCyl(bMetal, s * 1.14, 1.40, 1.10, 0.018, 0.018, 2.40, 6, { axis: 'z', color: darkMetal });
      // Side firing ports
      for (let p = 0; p < 3; p++) {
        addCyl(bMetal, s * 1.26, 1.22, 0.50 + p * 0.72, 0.055, 0.065, 0.10, 8, { axis: 'x', color: darkMetal });
      }
      addCyl(bMetal, s * 1.04, 1.08, -2.92, 0.08, 0.08, 0.14, 8, { axis: 'z', color: [0.46, 0.46, 0.42] });
    }

    // Twin rear troop doors (fuel cell doors)
    for (let s = -1; s <= 1; s += 2) {
      addBevel(bHull, s * 0.48, 0.94, 2.86, 0.82, 0.78, 0.18, 0.03, { color: shadeCol, rotX: -0.14, aoBottom: 0.68, aoTop: 1.0, uvScale: 0.46 });
      bMetal.addBox(s * 0.48, 1.14, 2.96, 0.26, 0.10, 0.04, { color: darkMetal });
    }

    // Front-right ribbed engine louver deck (FLIR white-hot!)
    bEngine.addBox(0.46, 1.24, -1.78, 1.02, 0.08, 1.36, { color: [0.34, 0.34, 0.32], rotX: 0.26 });
    for (let r = 0; r < 6; r++) {
      bEngine.addBox(0.46, 1.20 + r * 0.04, -2.28 + r * 0.20, 0.90, 0.04, 0.08, { color: [0.22, 0.22, 0.20] });
    }

    // Prominent RU Crimson-Red & White tactical assault stripes on flanks, prow & rear doors
    for (let s = -1; s <= 1; s += 2) {
      bMark.addBox(s * 1.58, 0.96, 1.15, 0.03, 0.15, 1.18, { color: ruRed });
      bMark.addBox(s * 1.58, 0.81, 1.15, 0.03, 0.15, 1.18, { color: ruWhite });
    }
    bMark.addBox(-0.42, 1.14, -2.52, 0.48, 0.035, 0.20, { color: ruRed, rotX: 0.28 });
    bMark.addBox(-0.42, 1.09, -2.70, 0.48, 0.035, 0.20, { color: ruWhite, rotX: 0.28 });
    bMark.addBox(0.48, 0.96, 2.97, 0.52, 0.14, 0.03, { color: ruRed });
    bMark.addBox(0.48, 0.82, 2.97, 0.52, 0.14, 0.03, { color: ruWhite });

    // --- BMP-2 Low Sharp Hexagonal Turret (local to turretPivot [0, 1.36, 0.22]) ---
    addCyl(bTurret, 0, 0.32, 0.0, 0.78, 1.06, 0.62, 6, { axis: 'y', color: baseCol, aoBottom: 0.72, aoTop: 1.0, uvScale: 0.42 });
    addBevel(bTurret, 0, 0.30, -0.44, 1.12, 0.54, 0.76, 0.08, { color: shadeCol, aoBottom: 0.72, aoTop: 1.0, uvScale: 0.44 });

    // Roof 9P135M Konkurs ATGM launcher tube on pintle post!
    addCyl(bTurretMetal, 0.18, 0.74, -0.05, 0.045, 0.055, 0.28, 8, { axis: 'y', color: darkMetal });
    addCyl(bTurret, 0.18, 0.90, -0.08, 0.085, 0.085, 1.16, 10, { axis: 'z', color: [0.54, 0.60, 0.48] });
    addCyl(bTurretMetal, 0.18, 0.90, -0.68, 0.095, 0.085, 0.12, 10, { axis: 'z', color: darkMetal });

    // Gunner sight, commander cupola & periscopes, IR searchlight
    addBevel(bTurretMetal, -0.40, 0.66, -0.44, 0.24, 0.20, 0.30, 0.02, { color: darkMetal });
    addCyl(bTurret, 0.34, 0.66, 0.14, 0.24, 0.26, 0.12, 10, { axis: 'y', color: shadeCol });
    addCyl(bTurretMetal, 0.44, 0.66, -0.34, 0.11, 0.11, 0.16, 10, { axis: 'z', color: [0.22, 0.24, 0.28] });

    // 6x 81mm smoke launchers (3 per side) on solid armored cheek brackets + whip antenna
    for (let s = -1; s <= 1; s += 2) {
      bTurretMetal.addBox(s * 0.88, 0.40, 0.30, 0.12, 0.12, 0.44, { color: darkMetal, rotY: s * 0.22 });
      for (let k = 0; k < 3; k++) {
        addCyl(bTurretMetal, s * (0.86 + k * 0.05), 0.44, 0.16 + k * 0.16, 0.042, 0.042, 0.30, 8, {
          axis: 'z', color: darkMetal, rotX: 0.48, rotY: s * 0.22
        });
      }
    }
    addCyl(bTurretMetal, -0.52, 1.42, 0.62, 0.011, 0.020, 1.65, 6, { axis: 'y', color: darkMetal });

    for (let s = -1; s <= 1; s += 2) {
      bTurretMark.addBox(s * 0.88, 0.43, 0.42, 0.03, 0.14, 0.62, { color: ruRed });
      bTurretMark.addBox(s * 0.88, 0.29, 0.42, 0.03, 0.14, 0.62, { color: ruWhite });
    }
    bTurretMark.addBox(0, 0.42, 0.86, 0.58, 0.13, 0.03, { color: ruRed });
    bTurretMark.addBox(0, 0.29, 0.86, 0.58, 0.13, 0.03, { color: ruWhite });

    // --- Long Slender 30mm 2A42 Autocannon (local to gunPivot [0, 0.34, -0.82]) ---
    addBevel(bGun, 0, 0, 0.04, 0.42, 0.34, 0.40, 0.04, { color: shadeCol });
    addCyl(bGun, 0, 0, -0.68, 0.054, 0.066, 1.28, 12, { axis: 'z', color: gunCol });
    addCyl(bGun, 0, 0, -1.96, 0.034, 0.046, 1.56, 10, { axis: 'z', color: gunCol });
    // Dual-baffle 2A42 muzzle brake
    addBevel(bGun, 0, 0, -2.76, 0.11, 0.075, 0.24, 0.015, { color: darkMetal });
    addCyl(bGun, 0.16, -0.02, -0.40, 0.020, 0.022, 0.68, 8, { axis: 'z', color: darkMetal });

    // Tactical headlights & rear troop-door convoy tail lamps
    const bLights = new DF.MeshGen.Builder();
    for (let s = -1; s <= 1; s += 2) {
      bLights.addSphere(s * 1.04, 1.08, -2.99, 0.062, 8, 6, { color: [1.0, 0.88, 0.66] });
      bLights.addBox(s * 1.12, 1.06, 2.94, 0.11, 0.05, 0.03, { color: [1.0, 0.16, 0.10] });
    }
    // Coated optical glass lens on BMP-2 gunner sight & IR searchlight
    const bTurretOptic = new DF.MeshGen.Builder();
    bTurretOptic.addBox(-0.40, 0.66, -0.60, 0.16, 0.12, 0.025, { color: [0.16, 0.50, 0.44] });
    bTurretOptic.addSphere(0.44, 0.66, -0.42, 0.085, 8, 6, { color: [0.22, 0.14, 0.34] });

    return {
      tracks: gear.tracks,
      sprockets: gear.sprockets,
      wheelTire: gear.wheelTire,
      wheelHub: gear.wheelHub,
      hull: buildMesh(bHull, gl),
      hullMetal: buildMesh(bMetal, gl),
      hullDrums: null,
      hullMark: buildMesh(bMark, gl),
      hullLights: buildMesh(bLights, gl),
      engine: buildMesh(bEngine, gl),
      turret: buildMesh(bTurret, gl),
      turretMetal: buildMesh(bTurretMetal, gl),
      turretMark: buildMesh(bTurretMark, gl),
      turretOptic: buildMesh(bTurretOptic, gl),
      gun: buildMesh(bGun, gl)
    };
  }

  // ---------------------------------------------------------------------------
  // State & Active Effects
  // ---------------------------------------------------------------------------
  let _gl = null;
  let _meshes = null;
  let _vehicles = [];
  let _smokeCanisters = [];
  let _fallbackProjectiles = [];
  let _time = 0;

  // Initial battlefield spawns (strictly on clear flat asphalt avenue, zero curb/prop overlap)
  const INITIAL_SPAWNS = [
    { id: 'ua_mbt_1', variant: 't64bv',   pos: [ 28, 0,  -4.2], yaw:  Math.PI * 0.5 }, // UA MBT Sector B/C avenue
    { id: 'ua_ifv_1', variant: 'bradley', pos: [ 14, 0,   5.2], yaw:  Math.PI * 0.5 }, // UA IFV Sector B hull-down support
    { id: 'ru_mbt_1', variant: 't72b3',   pos: [-72, 0,  -3.5], yaw: -Math.PI * 0.5 }, // RU MBT West avenue assault
    { id: 'ru_ifv_1', variant: 'bmp2',    pos: [-60, 0,   5.2], yaw: -Math.PI * 0.5 }, // RU IFV Avenue support
    { id: 'ru_ifv_2', variant: 'bmp2',    pos: [-70, 0, -39.5], yaw: -Math.PI * 0.5 }  // RU IFV North flank alley
  ];

  function createVehicle(cfg) {
    const spec = SPECS[cfg.variant];
    // Initial spawn at terrain level before exact 4-track planar fit
    const gy = (DF.Physics && typeof DF.Physics.getTerrainHeight === 'function')
      ? DF.Physics.getTerrainHeight(cfg.pos[0], cfg.pos[2])
      : getGroundY(cfg.pos[0], cfg.pos[2], 6.0);
    const yaw = cfg.yaw;
    const fwd = [-Math.sin(yaw), 0, -Math.cos(yaw)];

    const wheelMatsL = [];
    const wheelMatsR = [];
    for (let i = 0; i < spec.wheelCount; i++) {
      wheelMatsL.push(mat4Create());
      wheelMatsR.push(mat4Create());
    }

    const v = {
      id: cfg.id,
      colliderId: 'veh_' + cfg.id,
      variant: cfg.variant,
      role: spec.role,
      type: spec.type,
      faction: spec.faction,
      name: spec.name,
      displayName: spec.displayName,
      spec,
      spawnPos: [cfg.pos[0], gy, cfg.pos[2]],
      spawnYaw: yaw,
      respawnTimer: 0,

      pos: new Float32Array([cfg.pos[0], gy, cfg.pos[2]]),
      vel: new Float32Array([0, 0, 0]),
      forward: new Float32Array(fwd),
      yaw,
      hullYaw: yaw,
      pitch: 0,
      roll: 0,
      speed: 0,
      yawVel: 0,
      width: spec.halfW * 2,
      length: spec.halfL * 2,

      // Suspension springs & terrain conformance
      terrainPitch: 0,
      terrainRoll: 0,
      suspPitch: 0,
      suspPitchVel: 0,
      suspRoll: 0,
      suspRollVel: 0,
      wheelAngleL: 0,
      wheelAngleR: 0,

      // Independent turret & gun
      turretYaw: yaw,
      targetTurretYaw: yaw,
      gunPitch: 0.02,
      targetGunPitch: 0.02,
      barrelRecoil: 0,

      // Health & state
      hp: spec.maxHp,
      maxHp: spec.maxHp,
      alive: true,
      destroyed: false,
      radius: spec.radius,
      halfW: spec.halfW,
      halfL: spec.halfL,
      height: spec.height,
      lastHitTime: -99,
      lastAttacker: null,
      spottedTimer: 0,
      smokeEmitTimer: 0,
      fireEmitTimer: 0,

      // Weapons & HUD telemetry fields
      primaryAmmo: spec.primary.ammoMax,
      mainAmmo: spec.primary.ammoMax,
      mainAmmoName: spec.primary.name,
      primaryReload: 0,
      mainCooldown: 0,
      primaryReloadTotal: spec.primary.reloadTime,
      mainReloadTime: spec.primary.reloadTime,
      reloadProgress: 1.0,
      secondaryAmmo: spec.secondary.ammoMax,
      coaxAmmo: spec.role === 'mbt' ? spec.secondary.ammoMax : null,
      atgmAmmo: spec.role === 'ifv' ? spec.secondary.ammoMax : null,
      secondaryReload: 0,
      secondaryReloadTotal: spec.secondary.reloadTime || (60 / (spec.secondary.rpm || 600)),
      smokeCharges: 3,
      smokeCooldown: 0,
      smokeReady: true,
      muzzleFlashTimer: 0,
      muzzleWorldPos: new Float32Array(3),
      muzzleWorldDir: new Float32Array(fwd),
      aiControl: null,

      // Occupant & camera
      driver: null,
      occupants: [],
      isPlayerControlled: false,
      camMode: 0, // 0: 3rd-person, 1: Gunner Optic, 2: FLIR Thermal
      thermalMode: false,
      camPosSmooth: new Float32Array([cfg.pos[0] - fwd[0] * 8.2, gy + 3.4, cfg.pos[2] - fwd[2] * 8.2]),
      camInit: false,

      // AI Crew control
      aiOrder: 'advance',
      aiOrderPos: null,
      aiPath: null,
      aiPathIdx: 0,
      aiPathTimer: rand(0.5, 1.5),
      aiTarget: null,
      aiTargetPos: null,
      aiScanTimer: rand(0.1, 0.4),
      aiThrottle: 0,
      aiSteer: 0,
      aiAutoActiveTimer: cfg.variant === 't72b3' || cfg.variant === 'bmp2' ? 5.0 : 7.5,
      aiStuckTimer: 0,
      aiReverseTimer: 0,
      range: 0,
      lrfTimer: 0,
      lastMoveCheckPos: new Float32Array([cfg.pos[0], gy, cfg.pos[2]]),

      // Cook-off popped turret physics
      turretPopped: false,
      popPos: new Float32Array(3),
      popVel: new Float32Array(3),
      popRot: new Float32Array(3),
      popRotVel: new Float32Array(3),
      popSettled: false,

      // Dedicated per-instance render matrices (prevents reference aliasing in draw queues)
      _matHull: mat4Create(),
      _matTurret: mat4Create(),
      _matTurretLocal: mat4Create(),
      _matGun: mat4Create(),
      _matGunLocal: mat4Create(),
      _matPopTurret: mat4Create(),
      _matWheelL: wheelMatsL,
      _matWheelR: wheelMatsR,
      _matTmp: mat4Create()
    };

    const groundFit = sampleFourTrackGround(v, { y: gy, pitch: 0, roll: 0 });
    v.pos[1] = groundFit.y;
    v.terrainPitch = groundFit.pitch;
    v.terrainRoll = groundFit.roll;

    registerCollider(v);
    updateVehicleTransforms(v);
    return v;
  }

  function computeVehicleAABB(v) {
    const c = Math.abs(Math.cos(v.yaw));
    const s = Math.abs(Math.sin(v.yaw));
    const ex = v.halfW * c + v.halfL * s;
    const ez = v.halfW * s + v.halfL * c;
    return {
      min: [v.pos[0] - ex, v.pos[1], v.pos[2] - ez],
      max: [v.pos[0] + ex, v.pos[1] + v.height, v.pos[2] + ez]
    };
  }

  function registerCollider(v) {
    if (!DF.Physics || typeof DF.Physics.addCollider !== 'function') return;
    const box = computeVehicleAABB(v);
    v.boundsMin = box.min;
    v.boundsMax = box.max;
    DF.Physics.addCollider(v.colliderId, box.min, box.max, {
      type: 'vehicle',
      material: 'metal',
      vehicleId: v.id,
      vehicleRef: v,
      vehicle: v
    });
  }

  function syncCollider(v) {
    const box = computeVehicleAABB(v);
    v.boundsMin = box.min;
    v.boundsMax = box.max;
    if (DF.Physics && typeof DF.Physics.updateCollider === 'function') {
      DF.Physics.updateCollider(v.colliderId, box.min, box.max);
    }
  }

  // ---------------------------------------------------------------------------
  // Transforms & Muzzle Pose
  // ---------------------------------------------------------------------------
  function updateVehicleTransforms(v) {
    const spec = v.spec;
    v.forward[0] = -Math.sin(v.yaw);
    v.forward[1] = 0;
    v.forward[2] = -Math.cos(v.yaw);

    const totalPitch = v.terrainPitch + v.suspPitch;
    const totalRoll = v.terrainRoll + v.suspRoll;
    v.pitch = totalPitch;
    v.roll = totalRoll;

    // Slight vertical compensation during heavy suspension rock so tracks never float
    const pivotLift = Math.max(0, Math.abs(v.suspPitch) * 0.25 + Math.abs(v.suspRoll) * 0.15);
    mat4FromYXZ(
      v._matHull,
      v.pos[0], v.pos[1] - pivotLift * 0.35, v.pos[2],
      v.yaw, totalPitch, totalRoll,
      1, 1, 1
    );

    // Roadwheel matrices (6 left, 6 right — seated flush on lower track belt!)
    const wr = spec.wheelRadius;
    const wy = wr + 0.068;
    for (let i = 0; i < spec.wheelCount; i++) {
      const wz = lerp(spec.wheelZStart, spec.wheelZEnd, i / (spec.wheelCount - 1));
      mat4FromYXZ(v._matTmp, -spec.trackX, wy, wz, 0, v.wheelAngleL, 0, 1, 1, 1);
      mat4Mul(v._matWheelL[i], v._matHull, v._matTmp);

      mat4FromYXZ(v._matTmp, spec.trackX, wy, wz, 0, v.wheelAngleR, 0, 1, 1, 1);
      mat4Mul(v._matWheelR[i], v._matHull, v._matTmp);
    }

    if (v.turretPopped) {
      mat4FromYXZ(
        v._matPopTurret,
        v.popPos[0], v.popPos[1], v.popPos[2],
        v.popRot[1], v.popRot[0], v.popRot[2],
        1, 1, 1
      );
      return;
    }

    // Turret matrix (relative yaw to hull so world turret stays stabilized!)
    const relTurretYaw = angleDiff(v.yaw, v.turretYaw);
    mat4FromYXZ(
      v._matTurretLocal,
      spec.turretPivot[0], spec.turretPivot[1], spec.turretPivot[2],
      relTurretYaw, 0, 0,
      1, 1, 1
    );
    mat4Mul(v._matTurret, v._matHull, v._matTurretLocal);

    // Gun barrel matrix (elevates + recoils along local +Z)
    const relGunPitch = clamp(v.gunPitch - totalPitch * Math.cos(relTurretYaw) - totalRoll * Math.sin(relTurretYaw), spec.pitchMin, spec.pitchMax);
    mat4FromYXZ(
      v._matGunLocal,
      spec.gunPivot[0], spec.gunPivot[1], spec.gunPivot[2] + v.barrelRecoil,
      0, relGunPitch, 0,
      1, 1, 1
    );
    mat4Mul(v._matGun, v._matTurret, v._matGunLocal);

    // World muzzle position & firing direction
    mat4TransformPoint(v.muzzleWorldPos, v._matGun, 0, 0, -spec.barrelLen);
    mat4TransformDir(v.muzzleWorldDir, v._matGun, 0, 0, -1);
  }

  // ---------------------------------------------------------------------------
  // Audio / VFX Helpers
  // ---------------------------------------------------------------------------
  function spawnParticle(cfg) {
    if (DF.Renderer && typeof DF.Renderer.spawnParticle === 'function') {
      DF.Renderer.spawnParticle(cfg);
    }
  }

  function addLight(pos, color, intensity, radius) {
    if (DF.Renderer && typeof DF.Renderer.addDynamicLight === 'function') {
      DF.Renderer.addDynamicLight(pos, color, intensity, radius);
    }
  }

  function playGunshot(profile, pos, isPlayer) {
    if (DF.Audio && typeof DF.Audio.playGunshot === 'function') {
      DF.Audio.playGunshot(profile, pos, isPlayer);
    }
  }

  function playImpact(mat, pos) {
    if (DF.Audio && typeof DF.Audio.playImpact === 'function') {
      DF.Audio.playImpact(mat, pos);
    }
  }

  function playExplosion(pos, scale) {
    if (DF.Audio && typeof DF.Audio.playExplosion === 'function') {
      DF.Audio.playExplosion(pos, scale);
    }
  }

  // ---------------------------------------------------------------------------
  // Weapons: Main Cannon / Autocannon / Coax / ATGM / 81mm Smoke Discharger
  // ---------------------------------------------------------------------------
  function fireProjectile(v, weaponSpec, origin, dir, isPlayer) {
    const baseDriver = v.driver;
    const shooter = {
      id: (baseDriver && baseDriver.id) || v.id,
      name: (baseDriver && baseDriver.name) || v.displayName,
      faction: v.faction,
      isPlayer: v.isPlayerControlled,
      inVehicleId: v.id,
      vehicleId: v.id,
      pos: v.pos,
      aimOrigin: v.muzzleWorldPos,
      aimDir: v.muzzleWorldDir
    };

    if (DF.Ballistics && typeof DF.Ballistics.fireWeapon === 'function') {
      DF.Ballistics.fireWeapon(
        shooter,
        weaponSpec,
        [origin[0], origin[1], origin[2]],
        [dir[0], dir[1], dir[2]],
        isPlayer,
        { spread: weaponSpec.spread || 0.002, isAds: v.camMode >= 1 }
      );
    } else {
      // Built-in lightweight physical ballistic fallback if Ballistics unavailable
      _fallbackProjectiles.push({
        pos: [origin[0], origin[1], origin[2]],
        vel: [dir[0] * weaponSpec.muzzleVel, dir[1] * weaponSpec.muzzleVel, dir[2] * weaponSpec.muzzleVel],
        spec: weaponSpec,
        shooter,
        vehicleId: v.id,
        life: 6.0
      });
    }
    playGunshot(weaponSpec.audioProfile, origin, isPlayer);
  }

  function firePrimary(v) {
    if (!v.alive || v.primaryReload > 0 || v.primaryAmmo <= 0) return false;
    const w = v.spec.primary;
    v.primaryAmmo--;
    v.primaryReload = w.reloadTime;
    v.barrelRecoil = w.recoilDist;
    v.muzzleFlashTimer = v.role === 'mbt' ? 0.16 : 0.08;

    const origin = [v.muzzleWorldPos[0], v.muzzleWorldPos[1], v.muzzleWorldPos[2]];
    const dir = [v.muzzleWorldDir[0], v.muzzleWorldDir[1], v.muzzleWorldDir[2]];

    // Slight realistic spread
    if (w.spread) {
      dir[0] += rand(-w.spread, w.spread);
      dir[1] += rand(-w.spread, w.spread);
      dir[2] += rand(-w.spread, w.spread);
      const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      dir[0] /= l; dir[1] /= l; dir[2] /= l;
    }

    // Suspension hull kick in opposite direction of turret firing!
    const relYaw = angleDiff(v.yaw, v.turretYaw);
    v.suspPitchVel += Math.cos(relYaw) * w.suspImpulse;
    v.suspRollVel  += Math.sin(relYaw) * w.suspImpulse * 0.9;

    // Dramatic muzzle VFX
    if (v.role === 'mbt') {
      // Huge 125mm muzzle blast flash + shockwave ring + incandescent propellant streaks + radial dust wave!
      spawnParticle({
        type: 'flash', pos: origin, vel: [dir[0] * 6, dir[1] * 6, dir[2] * 6],
        size: 1.9, sizeEnd: 3.4, life: 0.14, color: [1.0, 0.78, 0.36], alpha: 0.95, additive: true
      });
      spawnParticle({
        type: 'shockwave', pos: [origin[0] + dir[0] * 0.5, origin[1] + dir[1] * 0.5, origin[2] + dir[2] * 0.5],
        vel: [dir[0] * 2.5, 0.2, dir[2] * 2.5],
        size: 0.65, sizeEnd: 4.8, life: 0.26, color: [0.95, 0.88, 0.76], alpha: 0.55
      });
      for (let i = 0; i < 10; i++) {
        spawnParticle({
          type: 'spark', pos: origin,
          vel: [dir[0] * rand(14, 28) + rand(-4, 4), dir[1] * rand(10, 20) + rand(-2, 4), dir[2] * rand(14, 28) + rand(-4, 4)],
          size: 0.14, sizeEnd: 0.04, life: rand(0.18, 0.38),
          color: [1.0, 0.82, 0.42], alpha: 1.0, gravity: 9.0, stretch: 4.5, additive: true
        });
      }
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + rand(-0.2, 0.2);
        const spd = rand(4, 11);
        spawnParticle({
          type: 'dust',
          pos: [origin[0] + Math.cos(a) * 0.6, Math.max(v.pos[1] + 0.18, origin[1] - 1.2), origin[2] + Math.sin(a) * 0.6],
          vel: [Math.cos(a) * spd + dir[0] * 3, rand(0.6, 2.2), Math.sin(a) * spd + dir[2] * 3],
          size: 0.9, sizeEnd: 3.2, life: rand(0.9, 1.7),
          color: [0.58, 0.54, 0.48], alpha: 0.55, gravity: -0.3, drag: 2.2
        });
      }
      for (let i = 0; i < 6; i++) {
        spawnParticle({
          type: 'smoke',
          pos: [origin[0] + dir[0] * 0.6, origin[1] + dir[1] * 0.6, origin[2] + dir[2] * 0.6],
          vel: [dir[0] * rand(8, 18) + rand(-2, 2), rand(0.5, 2.5), dir[2] * rand(8, 18) + rand(-2, 2)],
          size: 0.7, sizeEnd: 2.8, life: rand(0.8, 1.5),
          color: [0.68, 0.66, 0.62], alpha: 0.50, gravity: -0.5, drag: 2.8
        });
      }
    } else {
      // Crisp 25mm/30mm autocannon muzzle bark
      spawnParticle({
        type: 'flash', pos: origin, vel: [dir[0] * 4, dir[1] * 4, dir[2] * 4],
        size: 0.85, sizeEnd: 1.5, life: 0.08, color: [1.0, 0.82, 0.40], alpha: 0.9, additive: true
      });
      spawnParticle({
        type: 'smoke', pos: origin,
        vel: [dir[0] * 7 + rand(-1, 1), rand(0.4, 1.4), dir[2] * 7 + rand(-1, 1)],
        size: 0.35, sizeEnd: 1.2, life: 0.55, color: [0.62, 0.60, 0.56], alpha: 0.38, drag: 2.5
      });
    }

    fireProjectile(v, w, origin, dir, v.isPlayerControlled);
    return true;
  }

  function fireSecondary(v) {
    if (!v.alive || v.secondaryReload > 0 || v.secondaryAmmo <= 0) return false;
    const w = v.spec.secondary;
    v.secondaryAmmo--;
    v.secondaryReload = w.reloadTime || (60 / (w.rpm || 600));

    const co = v.spec.coaxOffset;
    const origin = [0, 0, 0];
    mat4TransformPoint(origin, v._matTurret, co[0], co[1], co[2]);
    const dir = [v.muzzleWorldDir[0], v.muzzleWorldDir[1], v.muzzleWorldDir[2]];

    if (w.spread) {
      dir[0] += rand(-w.spread, w.spread);
      dir[1] += rand(-w.spread, w.spread);
      dir[2] += rand(-w.spread, w.spread);
      const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      dir[0] /= l; dir[1] /= l; dir[2] /= l;
    }

    if (w.isATGM) {
      // Backblast & missile ignition smoke
      for (let i = 0; i < 8; i++) {
        spawnParticle({
          type: 'smoke',
          pos: [origin[0] - dir[0] * 0.8, origin[1] - dir[1] * 0.8, origin[2] - dir[2] * 0.8],
          vel: [-dir[0] * rand(4, 10) + rand(-1.5, 1.5), rand(0.5, 2.0), -dir[2] * rand(4, 10) + rand(-1.5, 1.5)],
          size: 0.5, sizeEnd: 2.2, life: rand(0.9, 1.6),
          color: [0.76, 0.74, 0.70], alpha: 0.55, drag: 2.0
        });
      }
      spawnParticle({
        type: 'flash', pos: origin, vel: [0, 0, 0],
        size: 1.1, sizeEnd: 1.8, life: 0.12, color: [1.0, 0.65, 0.25], alpha: 0.95, additive: true
      });
    } else {
      spawnParticle({
        type: 'flash', pos: origin, vel: [0, 0, 0],
        size: 0.36, sizeEnd: 0.60, life: 0.05, color: [1.0, 0.85, 0.45], alpha: 0.85, additive: true
      });
    }

    fireProjectile(v, w, origin, dir, v.isPlayerControlled);
    return true;
  }

  function deploySmoke(v) {
    if (!v || !v.alive || v.smokeCharges <= 0 || v.smokeCooldown > 0) return false;
    v.smokeCharges--;
    v.smokeCooldown = 12.0;

    const angles = [-0.52, -0.18, 0.18, 0.52];
    const origin = [0, 0, 0];
    mat4TransformPoint(origin, v._matTurret, 0, 0.68, -0.30);

    playGunshot('gl', origin, v.isPlayerControlled);

    for (let i = 0; i < angles.length; i++) {
      const a = v.turretYaw + angles[i];
      const fx = -Math.sin(a);
      const fz = -Math.cos(a);
      const spd = rand(14, 18);
      _smokeCanisters.push({
        pos: [origin[0] + fx * 0.8, origin[1], origin[2] + fz * 0.8],
        vel: [fx * spd, rand(6.2, 8.2), fz * spd],
        fuse: rand(0.68, 0.85),
        active: true,
        emitTime: 0
      });
      spawnParticle({
        type: 'smoke', pos: origin, vel: [fx * 6, 3.5, fz * 6],
        size: 0.35, sizeEnd: 1.1, life: 0.55, color: [0.85, 0.85, 0.84], alpha: 0.6
      });
    }

    if (v.isPlayerControlled && DF.UI && typeof DF.UI.showNotification === 'function') {
      DF.UI.showNotification('81mm 热成像遮蔽烟幕已释放', 'info');
    }
    return true;
  }

  function updateSmokeCanisters(dt) {
    for (let i = _smokeCanisters.length - 1; i >= 0; i--) {
      const c = _smokeCanisters[i];
      c.fuse -= dt;
      if (c.active) {
        c.vel[1] -= 13.5 * dt;
        c.pos[0] += c.vel[0] * dt;
        c.pos[1] += c.vel[1] * dt;
        c.pos[2] += c.vel[2] * dt;
        const gy = getGroundY(c.pos[0], c.pos[2], c.pos[1] + 1.0);
        if (c.pos[1] < gy + 0.15) {
          c.pos[1] = gy + 0.15;
          c.vel[0] *= 0.35; c.vel[1] = 0; c.vel[2] *= 0.35;
        }
        spawnParticle({
          type: 'smoke', pos: [c.pos[0], c.pos[1], c.pos[2]],
          vel: [rand(-0.5, 0.5), rand(0.5, 1.2), rand(-0.5, 0.5)],
          size: 0.25, sizeEnd: 1.0, life: 0.6, color: [0.88, 0.88, 0.86], alpha: 0.5
        });

        if (c.fuse <= 0) {
          c.active = false;
          c.emitTime = 9.5;
          // Register true AI vision-blocking smoke volume!
          if (DF.Physics && typeof DF.Physics.addSmokeVolume === 'function') {
            DF.Physics.addSmokeVolume([c.pos[0], c.pos[1] + 2.0, c.pos[2]], 7.5, 16.0);
          }
          // Instant dense airburst cloud
          for (let k = 0; k < 10; k++) {
            spawnParticle({
              type: 'smoke',
              pos: [c.pos[0] + rand(-1.6, 1.6), c.pos[1] + rand(0.2, 2.2), c.pos[2] + rand(-1.6, 1.6)],
              vel: [rand(-1.8, 1.8), rand(0.8, 2.4), rand(-1.8, 1.8)],
              size: 1.8, sizeEnd: 5.8, life: rand(5.5, 8.5),
              color: [0.82, 0.83, 0.82], alpha: 0.82, gravity: -0.06, drag: 0.9
            });
          }
          playImpact('sandbag', c.pos);
        }
      } else {
        c.emitTime -= dt;
        if (Math.random() < dt * 4.5) {
          spawnParticle({
            type: 'smoke',
            pos: [c.pos[0] + rand(-1.8, 1.8), c.pos[1] + rand(0.2, 1.8), c.pos[2] + rand(-1.8, 1.8)],
            vel: [rand(-0.8, 0.8), rand(0.5, 1.4), rand(-0.8, 0.8)],
            size: 2.0, sizeEnd: 6.2, life: rand(4.5, 7.0),
            color: [0.78, 0.80, 0.79], alpha: 0.74, gravity: -0.05, drag: 0.8
          });
        }
        if (c.emitTime <= 0) {
          _smokeCanisters.splice(i, 1);
        }
      }
    }
  }

  function updateFallbackProjectiles(dt) {
    for (let i = _fallbackProjectiles.length - 1; i >= 0; i--) {
      const p = _fallbackProjectiles[i];
      p.life -= dt;
      if (p.life <= 0) {
        _fallbackProjectiles.splice(i, 1);
        continue;
      }
      const prev = [p.pos[0], p.pos[1], p.pos[2]];
      p.vel[1] -= (p.spec.gravity || 9.8) * dt;
      p.pos[0] += p.vel[0] * dt;
      p.pos[1] += p.vel[1] * dt;
      p.pos[2] += p.vel[2] * dt;

      const dx = p.pos[0] - prev[0], dy = p.pos[1] - prev[1], dz = p.pos[2] - prev[2];
      const dist = Math.hypot(dx, dy, dz);
      let hit = null;
      if (DF.Physics && typeof DF.Physics.raycast === 'function' && dist > 0.001) {
        hit = DF.Physics.raycast(prev, [dx / dist, dy / dist, dz / dist], dist, {
          ignoreIds: ['veh_' + p.vehicleId],
          checkEntities: true,
          checkVehicles: true
        });
      }
      if (!hit && p.pos[1] <= getGroundY(p.pos[0], p.pos[2], prev[1] + 0.5)) {
        hit = { point: [p.pos[0], getGroundY(p.pos[0], p.pos[2], prev[1] + 0.5), p.pos[2]], normal: [0, 1, 0], material: 'earth' };
      }

      if (hit) {
        if (p.spec.explosiveRadius > 0) {
          if (DF.Game && typeof DF.Game.applyExplosion === 'function') {
            DF.Game.applyExplosion(hit.point, p.spec.explosiveRadius, p.spec.explosiveDamage || p.spec.damage, p.shooter, p.spec.id);
          } else {
            playExplosion(hit.point, p.spec.explosiveRadius * 0.25);
          }
        } else if (DF.Game && typeof DF.Game.applyBulletHit === 'function') {
          DF.Game.applyBulletHit(hit, p.spec, p.shooter, [dx / (dist || 1), dy / (dist || 1), dz / (dist || 1)]);
        }
        _fallbackProjectiles.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Directional Armor Damage & Cook-Off Destruction
  // ---------------------------------------------------------------------------
  function resolveHitZone(v, hitZone, hitPoint, hitDir) {
    if (hitZone === 'front' || hitZone === 'side' || hitZone === 'rear' || hitZone === 'top') {
      return hitZone;
    }
    if (Array.isArray(hitDir) && hitDir.length >= 3 && hitDir[1] < -0.58) return 'top';
    if (hitPoint && hitPoint.length >= 3) {
      const rx = hitPoint[0] - v.pos[0];
      const ry = hitPoint[1] - v.pos[1];
      const rz = hitPoint[2] - v.pos[2];
      if (ry > v.height * 0.72) return 'top';
      const len = Math.hypot(rx, rz) || 1;
      const dotF = (rx * v.forward[0] + rz * v.forward[2]) / len;
      if (dotF > 0.52) return 'front';
      if (dotF < -0.52) return 'rear';
    }
    return 'side';
  }

  function damageVehicle(vehicleOrId, dmg, hitZone, attackerArg, hitPointArg, hitDirArg) {
    const v = typeof vehicleOrId === 'string'
      ? _vehicles.find(x => x.id === vehicleOrId || x.colliderId === vehicleOrId)
      : vehicleOrId;
    if (!v || !v.alive || dmg <= 0) return { applied: 0, zone: 'side', destroyed: false };

    // Handle optional (v, dmg, hitZone, armorPenNumber, shooter, weaponId) fallback signature
    let attacker = attackerArg;
    let hitPoint = hitPointArg;
    let hitDir = hitDirArg;
    if (typeof attackerArg === 'number') {
      attacker = hitPointArg;
      hitPoint = null;
      hitDir = null;
    }

    // Strict friendly-fire guard (blocks allied infantry, player splash & friendly drones from damaging own armor)
    const attFac = attacker && (attacker.faction || (attacker.owner && attacker.owner.faction) || (attacker.driver && attacker.driver.faction));
    if (attFac && attFac === v.faction) return { applied: 0, zone: 'side', destroyed: false };

    const zone = resolveHitZone(v, hitZone, hitPoint, hitDir);
    let mult = 1.0;
    if (zone === 'front') mult = 0.28;
    else if (zone === 'rear') mult = 1.8;
    else if (zone === 'top') mult = 2.0;

    // Small arms grazing heavy MBT front deflect with bright sparks!
    const effectiveDmg = Math.max(1, dmg * mult);
    v.hp = Math.max(0, v.hp - effectiveDmg);
    v.lastHitTime = _time;
    if (attacker) v.lastAttacker = attacker;

    const pt = hitPoint || [v.pos[0], v.pos[1] + 1.4, v.pos[2]];

    // Sparks & ricochet feedback on front armor deflection
    if (zone === 'front') {
      playImpact('metal', pt);
      for (let i = 0; i < 8; i++) {
        spawnParticle({
          type: 'spark',
          pos: [pt[0], pt[1], pt[2]],
          vel: [rand(-6, 6), rand(2, 7), rand(-6, 6)],
          size: 0.14, sizeEnd: 0.04, life: rand(0.25, 0.55),
          color: [1.0, 0.85, 0.45], alpha: 1.0, gravity: 12.0, additive: true
        });
      }
    } else if (zone === 'rear' || zone === 'top') {
      for (let i = 0; i < 6; i++) {
        spawnParticle({
          type: 'fire',
          pos: [pt[0], pt[1], pt[2]],
          vel: [rand(-3, 3), rand(1.5, 4.5), rand(-3, 3)],
          size: 0.45, sizeEnd: 1.2, life: rand(0.32, 0.62),
          color: [1.0, 0.55, 0.16], alpha: 0.88, additive: false
        });
      }
    }

    // Hull rock from heavy impact
    if (dmg >= 40) {
      v.suspPitchVel += rand(-0.35, 0.35);
      v.suspRollVel += rand(-0.45, 0.45);
    }

    // AI defensive smoke deployment when hit hard
    if (!v.isPlayerControlled && v.hp > 0 && v.hp < v.maxHp * 0.68 && v.smokeCharges > 0 && v.smokeCooldown <= 0) {
      deploySmoke(v);
    }

    if (v.hp <= 0) {
      destroyVehicle(v, attacker);
      return { applied: effectiveDmg, zone, destroyed: true };
    }

    return { applied: effectiveDmg, zone, destroyed: false };
  }

  function destroyVehicle(v, attacker) {
    if (!v.alive) return;
    v.alive = false;
    v.destroyed = true;
    v.hp = 0;
    v.speed = 0;

    // Eject occupants safely or apply blast damage (main.js handles player bailout damage when active)
    const occs = v.occupants.slice();
    const wasPlayer = v.isPlayerControlled;
    for (let i = 0; i < occs.length; i++) {
      const occ = occs[i];
      exitVehicle(v, occ);
      if (!occ.isPlayer && DF.AI && typeof DF.AI.damageSoldier === 'function') {
        DF.AI.damageSoldier(occ, 140, 'torso', attacker, 'vehicle_cookoff');
      }
    }
    v.driver = null;
    v.occupants = [];
    v.isPlayerControlled = false;

    // Launch catastrophic Turret-Pop!
    v.turretPopped = true;
    v.popSettled = false;
    mat4TransformPoint(v.popPos, v._matHull, v.spec.turretPivot[0], v.spec.turretPivot[1] + 0.35, v.spec.turretPivot[2]);
    v.popVel[0] = rand(-2.8, 2.8);
    v.popVel[1] = v.role === 'mbt' ? rand(8.5, 11.8) : rand(6.2, 8.8);
    v.popVel[2] = rand(-2.8, 2.8);
    v.popRot[0] = 0;
    v.popRot[1] = v.turretYaw;
    v.popRot[2] = 0;
    v.popRotVel[0] = rand(-3.5, 3.5);
    v.popRotVel[1] = rand(-2.8, 2.8);
    v.popRotVel[2] = rand(-3.5, 3.5);

    const blastCenter = [v.pos[0], v.pos[1] + 1.5, v.pos[2]];
    v.respawnTimer = 65.0; // Wreck burns for 65s before heavy reinforcement arrives (if tickets remain)
    playExplosion(blastCenter, 2.4);

    // Multi-layered Battlefield cook-off: core flash + shockwave + soot-backed turbulent fireball + oil smoke + 26 velocity-stretched sparks + debris + scorch decal!
    spawnParticle({
      type: 'flash', pos: blastCenter, vel: [0, 0.5, 0],
      size: 3.4, sizeEnd: 6.2, life: 0.22, color: [1.0, 0.86, 0.50], alpha: 0.98, additive: true
    });
    spawnParticle({
      type: 'shockwave', pos: [v.pos[0], v.pos[1] + 0.35, v.pos[2]], vel: [0, 0.2, 0],
      size: 1.2, sizeEnd: 11.5, life: 0.42, color: [1.0, 0.84, 0.62], alpha: 0.65
    });
    for (let i = 0; i < 20; i++) {
      spawnParticle({
        type: 'fire',
        pos: [blastCenter[0] + rand(-1.2, 1.2), blastCenter[1] + rand(-0.4, 1.2), blastCenter[2] + rand(-1.2, 1.2)],
        vel: [rand(-6, 6), rand(3, 12), rand(-6, 6)],
        size: rand(1.1, 2.2), sizeEnd: rand(3.2, 5.2), life: rand(0.55, 1.25),
        color: [1.0, rand(0.4, 0.72), 0.14], alpha: 0.92, gravity: -1.5, drag: 1.4, additive: false
      });
    }
    for (let i = 0; i < 26; i++) {
      spawnParticle({
        type: 'spark',
        pos: [blastCenter[0] + rand(-0.8, 0.8), blastCenter[1] + rand(0, 0.8), blastCenter[2] + rand(-0.8, 0.8)],
        vel: [rand(-14, 14), rand(6, 18), rand(-14, 14)],
        size: rand(0.14, 0.24), sizeEnd: 0.04, life: rand(0.45, 1.25),
        color: [1.0, rand(0.55, 0.85), 0.24], alpha: 1.0, gravity: 11.0, stretch: 4.2, additive: true
      });
    }
    for (let i = 0; i < 20; i++) {
      spawnParticle({
        type: 'smoke',
        pos: [blastCenter[0] + rand(-1.4, 1.4), blastCenter[1] + rand(0.2, 1.8), blastCenter[2] + rand(-1.4, 1.4)],
        vel: [rand(-3, 3), rand(2.5, 7.0), rand(-3, 3)],
        size: rand(1.5, 2.5), sizeEnd: rand(5.5, 8.5), life: rand(3.5, 6.5),
        color: [0.12, 0.12, 0.12], alpha: 0.86, gravity: -0.4, drag: 0.8
      });
    }
    for (let i = 0; i < 24; i++) {
      spawnParticle({
        type: 'debris',
        pos: [blastCenter[0], blastCenter[1] + 0.5, blastCenter[2]],
        vel: [rand(-11, 11), rand(5, 15), rand(-11, 11)],
        size: rand(0.18, 0.36), sizeEnd: 0.12, life: rand(1.2, 2.5),
        color: [0.22, 0.20, 0.18], alpha: 1.0, gravity: 14.0, drag: 0.3
      });
    }
    if (DF.Renderer && typeof DF.Renderer.spawnDecal === 'function') {
      DF.Renderer.spawnDecal([v.pos[0], v.pos[1] + 0.02, v.pos[2]], [0, 1, 0], 4.2, 'scorch');
    }

    // Secondary collateral damage around burning cook-off (without re-triggering self)
    if (DF.Destruction && typeof DF.Destruction.applyBlast === 'function') {
      DF.Destruction.applyBlast(blastCenter, 9.0, 260);
    }

    if (DF.Events && typeof DF.Events.emit === 'function') {
      DF.Events.emit('vehicle:destroyed', { vehicle: v, attacker, wasPlayer });
    }
    const attackerIsPlayer = !!(attacker && (attacker.isPlayer || attacker.controlledByPlayer));
    if (!attackerIsPlayer && DF.UI && typeof DF.UI.addKillfeed === 'function') {
      const killerName = (attacker && (attacker.name || attacker.displayName)) || '反装甲火力';
      const killerFac = (attacker && attacker.faction) || (v.faction === 'UA' ? 'RU' : 'UA');
      DF.UI.addKillfeed(killerName, '击毁载具', v.displayName, killerFac, v.faction);
    }
  }

  // ---------------------------------------------------------------------------
  // Enter / Exit / Interactable API
  // ---------------------------------------------------------------------------
  function enterVehicle(vehicle, occupant, isPlayer) {
    if (!vehicle || !vehicle.alive || !occupant) return false;
    // AI crew only enters own-faction vehicles; player can ALWAYS board any living friendly vehicle
    // (relieving any AI driver) or capture an enemy vehicle cleanly!
    if (!isPlayer && occupant.faction && occupant.faction !== vehicle.faction) return false;

    if (isPlayer) {
      // Leave any other vehicle the player currently occupies
      for (let i = 0; i < _vehicles.length; i++) {
        if (_vehicles[i].isPlayerControlled && _vehicles[i] !== vehicle) {
          exitVehicle(_vehicles[i], occupant);
        }
      }
      // Cleanly eject/relieve any existing AI driver or occupants so player takeover NEVER fails!
      const existingOccs = vehicle.occupants.slice();
      for (let i = 0; i < existingOccs.length; i++) {
        if (existingOccs[i] && existingOccs[i] !== occupant) {
          exitVehicle(vehicle, existingOccs[i]);
        }
      }
      vehicle.aiControl = null;
      if (occupant.faction && vehicle.faction !== occupant.faction) {
        vehicle.faction = occupant.faction; // Battlefield trophy capture
      }
      vehicle.isPlayerControlled = true;
      vehicle.driver = occupant;
      if (vehicle.occupants.indexOf(occupant) === -1) vehicle.occupants.push(occupant);
      vehicle.camInit = false;
      vehicle.camMode = 0;
      vehicle.thermalMode = false;
    } else {
      if (vehicle.isPlayerControlled || (vehicle.driver && vehicle.driver !== occupant)) return false;
      vehicle.driver = occupant;
      if (vehicle.occupants.indexOf(occupant) === -1) vehicle.occupants.push(occupant);
    }

    occupant.inVehicleId = vehicle.id;
    occupant.pos[0] = vehicle.pos[0];
    occupant.pos[1] = vehicle.pos[1] + 1.1;
    occupant.pos[2] = vehicle.pos[2];

    if (isPlayer && DF.UI && typeof DF.UI.showNotification === 'function') {
      DF.UI.showNotification(`已登车: ${vehicle.displayName}  [C]视野 [X]烟幕 [E]下车`, 'info');
    }
    return true;
  }

  function exitVehicle(vehicle, occupant) {
    if (!vehicle || !occupant) return false;
    const idx = vehicle.occupants.indexOf(occupant);
    if (idx !== -1) vehicle.occupants.splice(idx, 1);

    if (vehicle.driver === occupant) {
      vehicle.driver = vehicle.occupants.length > 0 ? vehicle.occupants[0] : null;
    }
    if (occupant.isPlayer) {
      vehicle.isPlayerControlled = false;
      vehicle.thermalMode = false;
      if (DF.Renderer && typeof DF.Renderer.setVisionMode === 'function') {
        DF.Renderer.setVisionMode('normal');
      }
    }

    // Find clear dismount spot (left, right, rear, front)
    const rx = Math.cos(vehicle.yaw), rz = -Math.sin(vehicle.yaw);
    const fx = vehicle.forward[0], fz = vehicle.forward[2];
    const candidates = [
      [vehicle.pos[0] - rx * (vehicle.halfW + 1.35), vehicle.pos[2] - rz * (vehicle.halfW + 1.35)],
      [vehicle.pos[0] + rx * (vehicle.halfW + 1.35), vehicle.pos[2] + rz * (vehicle.halfW + 1.35)],
      [vehicle.pos[0] - fx * (vehicle.halfL + 1.45), vehicle.pos[2] - fz * (vehicle.halfL + 1.45)],
      [vehicle.pos[0] + fx * (vehicle.halfL + 1.45), vehicle.pos[2] + fz * (vehicle.halfL + 1.45)]
    ];

    let chosen = candidates[0];
    for (let i = 0; i < candidates.length; i++) {
      const cx = clamp(candidates[i][0], -87, 87);
      const cz = clamp(candidates[i][1], -52, 52);
      const gy = getGroundY(cx, cz, vehicle.pos[1] + 1.2);
      let blocked = false;
      if (DF.Physics && typeof DF.Physics.raycast === 'function') {
        const dx = cx - vehicle.pos[0], dz = cz - vehicle.pos[2];
        const d = Math.hypot(dx, dz) || 1;
        const h = DF.Physics.raycast(
          [vehicle.pos[0], vehicle.pos[1] + 1.0, vehicle.pos[2]],
          [dx / d, 0, dz / d],
          d,
          { ignoreIds: [vehicle.colliderId] }
        );
        if (h && h.dist < d - 0.3) blocked = true;
      }
      if (!blocked) {
        chosen = [cx, cz, gy];
        break;
      }
    }

    const outX = clamp(chosen[0], -87, 87);
    const outZ = clamp(chosen[1], -52, 52);
    const outY = getGroundY(outX, outZ, vehicle.pos[1] + 1.5);
    occupant.pos[0] = outX;
    occupant.pos[1] = outY;
    occupant.pos[2] = outZ;
    if (occupant.vel) { occupant.vel[0] = 0; occupant.vel[1] = 0; occupant.vel[2] = 0; }
    occupant.inVehicleId = null;
    return true;
  }

  function getNearestInteractable(pos, faction, maxDist) {
    const limit = maxDist || 5.8;
    let best = null;
    let bestDist = limit;
    for (let i = 0; i < _vehicles.length; i++) {
      const v = _vehicles[i];
      if (!v.alive) continue;
      if (faction && v.faction !== faction) continue;
      const d = Math.hypot(v.pos[0] - pos[0], v.pos[2] - pos[2]);
      if (d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
    return best;
  }

  function getAvailableVehicle(faction, nearPos) {
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < _vehicles.length; i++) {
      const v = _vehicles[i];
      if (!v.alive || v.faction !== faction || v.isPlayerControlled || v.driver) continue;
      const d = nearPos ? Math.hypot(v.pos[0] - nearPos[0], v.pos[2] - nearPos[2]) : 0;
      if (d < bestScore) {
        bestScore = d;
        best = v;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Vehicle Locomotion, Track Steering, Grounding & Ramming Destruction
  // ---------------------------------------------------------------------------
  function stepVehiclePhysics(v, throttle, steerLeft, dt, brakePressed) {
    const spec = v.spec;
    const prevSpeed = v.speed;

    // Acceleration / braking / reverse
    if (brakePressed) {
      const decel = spec.brake * 1.45 * dt;
      if (Math.abs(v.speed) <= decel) v.speed = 0;
      else v.speed -= Math.sign(v.speed) * decel;
    } else if (throttle > 0.05) {
      if (v.speed < 0) v.speed = Math.min(0, v.speed + spec.brake * dt);
      else v.speed = Math.min(spec.maxSpeed, v.speed + spec.accel * throttle * dt);
    } else if (throttle < -0.05) {
      if (v.speed > 0) v.speed = Math.max(0, v.speed - spec.brake * dt);
      else v.speed = Math.max(-spec.maxReverse, v.speed + spec.accel * 0.72 * throttle * dt);
    } else {
      // Natural track rolling friction
      const decel = 5.2 * dt;
      if (Math.abs(v.speed) <= decel) v.speed = 0;
      else v.speed -= Math.sign(v.speed) * decel;
    }

    // Differential track steering: positive steerLeft (+1 = KeyA) turns LEFT (+yaw)!
    const dirSign = v.speed < -0.35 ? -1 : 1;
    const turnMult = Math.abs(v.speed) < 1.8 ? 1.15 : lerp(1.05, 0.72, Math.abs(v.speed) / spec.maxSpeed);
    const targetYawVel = steerLeft * dirSign * spec.turnRate * turnMult;
    v.yawVel = damp(v.yawVel, targetYawVel, 7.5, dt);
    v.yaw += v.yawVel * dt;
    v.hullYaw = v.yaw;

    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    v.forward[0] = fx;
    v.forward[1] = 0;
    v.forward[2] = fz;

    // Spin left & right roadwheels based on differential track velocities
    const vLeft = v.speed + v.yawVel * spec.trackX;
    const vRight = v.speed - v.yawVel * spec.trackX;
    v.wheelAngleL -= (vLeft / spec.wheelRadius) * dt;
    v.wheelAngleR -= (vRight / spec.wheelRadius) * dt;

    // Check forward obstacle smashing (barricades, fences, sandbags, wrecked cars)
    if (Math.abs(v.speed) > 2.2 && DF.Physics && typeof DF.Physics.raycast === 'function') {
      const moveSign = Math.sign(v.speed);
      const probeDir = [fx * moveSign, 0, fz * moveSign];
      const probeOrigin = [v.pos[0], v.pos[1] + 0.85, v.pos[2]];
      const hit = DF.Physics.raycast(probeOrigin, probeDir, v.halfL + 1.1, {
        ignoreIds: [v.colliderId]
      });
      if (hit && hit.collider) {
        const meta = hit.collider.meta || hit.collider;
        const destructId = meta.destructibleId || (meta.type === 'destructible' && hit.collider.id);
        if (destructId && DF.Destruction && typeof DF.Destruction.damagePiece === 'function') {
          DF.Destruction.damagePiece(destructId, 320, hit.point, probeDir, true);
          playImpact('metal', hit.point);
          v.speed *= 0.72;
          v.suspPitchVel -= moveSign * 0.45;
          for (let i = 0; i < 6; i++) {
            spawnParticle({
              type: 'debris', pos: hit.point,
              vel: [probeDir[0] * rand(2, 6) + rand(-3, 3), rand(2, 5), probeDir[2] * rand(2, 6) + rand(-3, 3)],
              size: 0.2, sizeEnd: 0.1, life: 0.9, color: [0.48, 0.44, 0.38], alpha: 1.0, gravity: 13.0
            });
          }
        } else if (meta.type === 'wall' || meta.type === 'vehicle') {
          // Hard collision stop
          v.speed *= -0.12;
          v.suspPitchVel -= moveSign * 0.35;
        }
      }
    }

    // Move hull cleanly using DF.Physics.moveCapsule (slides smoothly along walls & buildings)
    const desiredVx = fx * v.speed;
    const desiredVz = fz * v.speed;
    v.vel[0] = desiredVx;
    v.vel[2] = desiredVz;

    const oldX = v.pos[0], oldZ = v.pos[2];
    if (DF.Physics && typeof DF.Physics.moveCapsule === 'function') {
      const savedY = v.pos[1];
      v.vel[1] = 0;
      const res = DF.Physics.moveCapsule(v.pos, v.vel, v.radius, v.height, dt, {
        ignoreIds: [v.colliderId],
        isVehicle: true,
        noGravity: true,
        stepHeight: 0.22
      });
      // Vertical elevation is strictly governed by 4-track planar grounding below (never popped onto small rubble!)
      v.pos[1] = savedY;
      if (res && res.hitWall) {
        v.speed *= 0.55;
      }
    } else {
      v.pos[0] += desiredVx * dt;
      v.pos[2] += desiredVz * dt;
    }

    // Vehicle-to-vehicle soft separation so tanks never clip through each other
    for (let i = 0; i < _vehicles.length; i++) {
      const other = _vehicles[i];
      if (other === v) continue;
      const dx = v.pos[0] - other.pos[0];
      const dz = v.pos[2] - other.pos[2];
      const d = Math.hypot(dx, dz);
      const minDist = v.radius + other.radius + 0.35;
      if (d > 0.001 && d < minDist) {
        const push = (minDist - d) * 0.55;
        v.pos[0] += (dx / d) * push;
        v.pos[2] += (dz / d) * push;
        v.speed *= 0.65;
      }
    }

    // Map bounds clamp
    v.pos[0] = clamp(v.pos[0], -86.5, 86.5);
    v.pos[2] = clamp(v.pos[2], -51.5, 51.5);

    // Roadkill check against enemy soldiers when moving fast
    if (Math.abs(v.speed) > 3.6 && DF.AI && typeof DF.AI.getSoldiers === 'function') {
      const soldiers = DF.AI.getSoldiers();
      for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i];
        if (!s || s.state !== 'alive' || s.inVehicleId || s.faction === v.faction) continue;
        const d = Math.hypot(s.pos[0] - v.pos[0], s.pos[2] - v.pos[2]);
        if (d < v.radius + 0.5 && Math.abs(s.pos[1] - v.pos[1]) < 1.8) {
          if (typeof DF.AI.damageSoldier === 'function') {
            DF.AI.damageSoldier(s, 140, 'torso', v.driver || v, v.spec.name);
          }
        }
      }
    }

    // 4-track-corner planar grounding & slope pitch/roll conformance (ZERO floating tracks!)
    const rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);
    const fit = sampleFourTrackGround(v, v._groundFit || (v._groundFit = { y: 0, pitch: 0, roll: 0 }));
    v.pos[1] = damp(v.pos[1], fit.y, 18.0, dt);
    v.terrainPitch = damp(v.terrainPitch, fit.pitch, 12.0, dt);
    v.terrainRoll = damp(v.terrainRoll, fit.roll, 12.0, dt);

    // Torsion-bar suspension spring physics (accelerating pitches nose up, braking dips nose, turning rolls!)
    const actualAccel = (v.speed - prevSpeed) / Math.max(dt, 0.001);
    const targetSuspPitch = clamp(actualAccel * 0.0085, -0.065, 0.065);
    const targetSuspRoll = clamp(-v.speed * v.yawVel * 0.006, -0.06, 0.06);

    const springK = 42.0;
    const dampC = 7.2;
    v.suspPitchVel += ((targetSuspPitch - v.suspPitch) * springK - v.suspPitchVel * dampC) * dt;
    v.suspPitch = clamp(v.suspPitch + v.suspPitchVel * dt, -0.14, 0.14);

    v.suspRollVel += ((targetSuspRoll - v.suspRoll) * springK - v.suspRollVel * dampC) * dt;
    v.suspRoll = clamp(v.suspRoll + v.suspRollVel * dt, -0.12, 0.12);

    // Dust & diesel exhaust particles when moving
    const movedDist = Math.hypot(v.pos[0] - oldX, v.pos[2] - oldZ);
    if (movedDist > 0.02 && Math.random() < dt * Math.min(14, Math.abs(v.speed) * 1.4)) {
      const side = Math.random() < 0.5 ? -1 : 1;
      spawnParticle({
        type: 'dust',
        pos: [
          v.pos[0] + rx * side * spec.trackX - fx * (v.halfL * 0.85),
          v.pos[1] + 0.15,
          v.pos[2] + rz * side * spec.trackX - fz * (v.halfL * 0.85)
        ],
        vel: [-fx * Math.abs(v.speed) * 0.18 + rand(-0.6, 0.6), rand(0.4, 1.3), -fz * Math.abs(v.speed) * 0.18 + rand(-0.6, 0.6)],
        size: 0.45, sizeEnd: 1.75, life: rand(0.65, 1.15),
        color: [0.54, 0.50, 0.44], alpha: 0.34, gravity: -0.2, drag: 1.8
      });
    }
    // Realistic warm diesel exhaust puffs (idle thrum + heavier dark plume under acceleration!)
    const exhaustRate = Math.abs(throttle) > 0.25 ? 6.5 : 1.4;
    if (Math.random() < dt * exhaustRate) {
      const isRearExhaust = v.role === 'mbt';
      const exX = isRearExhaust
        ? v.pos[0] - fx * (v.halfL * 0.88) + (v.variant === 't72b3' ? -rx * 1.15 : 0)
        : v.pos[0] + fx * (v.halfL * 0.48) + rx * 0.55;
      const exY = v.pos[1] + (isRearExhaust ? 1.05 : 1.45);
      const exZ = isRearExhaust
        ? v.pos[2] - fz * (v.halfL * 0.88) + (v.variant === 't72b3' ? -rz * 1.15 : 0)
        : v.pos[2] + fz * (v.halfL * 0.48) + rz * 0.55;
      const revBoost = Math.abs(throttle) > 0.25 ? 1.0 : 0.45;
      spawnParticle({
        type: 'smoke',
        pos: [exX, exY, exZ],
        vel: [
          -fx * (1.2 + revBoost * 1.8) + rand(-0.35, 0.35),
          rand(0.8, 1.9),
          -fz * (1.2 + revBoost * 1.8) + rand(-0.35, 0.35)
        ],
        size: 0.32 + revBoost * 0.16,
        sizeEnd: 1.55 + revBoost * 0.85,
        life: rand(0.95, 1.75),
        color: revBoost > 0.7 ? [0.22, 0.23, 0.24] : [0.42, 0.44, 0.46],
        alpha: 0.26 + revBoost * 0.18,
        gravity: -0.35,
        drag: 1.4
      });
    }

    // Sync occupant positions to vehicle
    for (let i = 0; i < v.occupants.length; i++) {
      const occ = v.occupants[i];
      if (!occ) continue;
      occ.pos[0] = v.pos[0];
      occ.pos[1] = v.pos[1] + 1.1;
      occ.pos[2] = v.pos[2];
      occ.yaw = v.turretYaw;
    }

    syncCollider(v);
  }

  // ---------------------------------------------------------------------------
  // AI Crew Tactical Controller (Road Pathing, Front Armor Angling, Gunnery)
  // ---------------------------------------------------------------------------
  function getActiveCombatObjective(faction) {
    if (DF.Map && typeof DF.Map.getSectors === 'function') {
      const secs = DF.Map.getSectors() || [];
      const active = secs.find(s => s.active) || secs[0];
      if (active && active.pos) return active.pos;
    }
    return faction === 'RU' ? [4, 0, 0] : [-12, 0, 0];
  }

  function acquireVehicleTarget(v) {
    let bestTarget = null;
    let bestScore = -1e9;
    const eye = [v.pos[0], v.pos[1] + 1.9, v.pos[2]];

    // 1. Prioritize enemy armored vehicles!
    for (let i = 0; i < _vehicles.length; i++) {
      const other = _vehicles[i];
      if (!other.alive || other.faction === v.faction) continue;
      const dx = other.pos[0] - eye[0];
      const dy = (other.pos[1] + 1.2) - eye[1];
      const dz = other.pos[2] - eye[2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 115) continue;

      if (DF.Physics && typeof DF.Physics.lineBlockedBySmoke === 'function') {
        if (DF.Physics.lineBlockedBySmoke(eye, [other.pos[0], other.pos[1] + 1.2, other.pos[2]])) continue;
      }
      if (DF.Physics && typeof DF.Physics.raycast === 'function') {
        const hit = DF.Physics.raycast(eye, [dx / dist, dy / dist, dz / dist], dist - 1.5, {
          ignoreIds: [v.colliderId, other.colliderId]
        });
        if (hit && hit.dist < dist - 3.5) continue;
      }

      const score = 260 - dist + (other.role === 'mbt' ? 50 : 25);
      if (score > bestScore) {
        bestScore = score;
        bestTarget = { kind: 'vehicle', ref: other, pos: [other.pos[0], other.pos[1] + 1.15, other.pos[2]], dist };
      }
    }

    // 2. Enemy infantry (AT soldiers prioritized!)
    if (DF.AI && typeof DF.AI.getSoldiers === 'function') {
      const soldiers = DF.AI.getSoldiers();
      for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i];
        if (!s || s.state !== 'alive' || s.inVehicleId || s.faction === v.faction) continue;
        const tx = s.pos[0], ty = s.pos[1] + 1.1, tz = s.pos[2];
        const dx = tx - eye[0], dy = ty - eye[1], dz = tz - eye[2];
        const dist = Math.hypot(dx, dy, dz);
        if (dist > 88) continue;

        if (DF.Physics && typeof DF.Physics.lineBlockedBySmoke === 'function') {
          if (DF.Physics.lineBlockedBySmoke(eye, [tx, ty, tz])) continue;
        }
        if (DF.Physics && typeof DF.Physics.raycast === 'function') {
          const hit = DF.Physics.raycast(eye, [dx / dist, dy / dist, dz / dist], dist - 0.6, {
            ignoreIds: [v.colliderId]
          });
          if (hit && hit.dist < dist - 1.4) continue;
        }

        const score = 140 - dist + (s.role === 'at' ? 65 : 0) + (s.spottedTimer > 0 ? 30 : 0);
        if (score > bestScore) {
          bestScore = score;
          bestTarget = { kind: 'soldier', ref: s, pos: [tx, ty, tz], dist };
        }
      }
    }

    return bestTarget;
  }

  function updateAICrew(v, dt) {
    // Only operate automatically if an AI crewman boarded OR match is active and autoCrew timer elapsed
    const matchRunning = !DF.GameMode || typeof DF.GameMode.getState !== 'function'
      ? true
      : (DF.GameMode.getState().phase === 'playing' || DF.GameMode.getState().active !== false);

    if (!v.driver) {
      if (!matchRunning) return { throttle: 0, steer: 0 };
      v.aiAutoActiveTimer -= dt;
      if (v.aiAutoActiveTimer > 0) return { throttle: 0, steer: 0 };
    }

    // Periodic threat scanning
    v.aiScanTimer -= dt;
    if (v.aiScanTimer <= 0) {
      v.aiScanTimer = rand(0.32, 0.55);
      v.aiTarget = acquireVehicleTarget(v);
    }

    // Determine tactical movement goal
    const objective = v.aiOrderPos || getActiveCombatObjective(v.faction);
    let goalX = objective[0];
    let goalZ = objective[2];

    if (v.faction === 'RU') {
      // Attackers push East along main avenue or north flank, stopping at standoff range from objective
      goalX = clamp(objective[0] - (v.role === 'mbt' ? 24 : 18), -74, 46);
      if (v.id === 'ru_ifv_2') goalZ = clamp(objective[2] - 36, -42, -35);
      else goalZ = v.id === 'ru_ifv_1' ? 5.0 : -3.5;
    } else {
      // Defenders hold tactical road positions facing West
      if (v.aiOrderPos) {
        goalX = v.aiOrderPos[0];
        goalZ = v.aiOrderPos[2];
      } else {
        goalX = clamp(objective[0] + (v.role === 'mbt' ? 22 : 12), -24, 58);
        goalZ = v.role === 'mbt' ? -4.5 : 5.0;
      }
    }

    // Recompute nav path periodically
    v.aiPathTimer -= dt;
    if (v.aiPathTimer <= 0) {
      v.aiPathTimer = rand(2.5, 4.0);
      if (DF.Physics && typeof DF.Physics.findPath === 'function') {
        const path = DF.Physics.findPath(
          [v.pos[0], v.pos[1], v.pos[2]],
          [goalX, 0, goalZ],
          { isVehicle: true }
        );
        if (path && path.length > 0) {
          v.aiPath = path;
          v.aiPathIdx = 0;
        }
      }
    }

    let throttle = 0;
    let steer = 0;

    // Reverse recovery if stuck
    if (v.aiReverseTimer > 0) {
      v.aiReverseTimer -= dt;
      throttle = -0.65;
      steer = v.id.endsWith('2') ? -0.7 : 0.7;
    } else {
      // Determine current steering waypoint
      let wpX = goalX, wpZ = goalZ;
      if (v.aiPath && v.aiPathIdx < v.aiPath.length) {
        const wp = v.aiPath[v.aiPathIdx];
        wpX = wp[0]; wpZ = wp[2];
        if (Math.hypot(wpX - v.pos[0], wpZ - v.pos[2]) < 4.5) {
          v.aiPathIdx++;
        }
      }

      const distGoal = Math.hypot(goalX - v.pos[0], goalZ - v.pos[2]);
      const underHeavyFire = (_time - v.lastHitTime < 3.0 && v.hp < v.maxHp * 0.45);

      if (underHeavyFire) {
        // Tactical reverse behind smoke while keeping front armor facing threat!
        throttle = -0.7;
        if (v.aiTarget) {
          const wantYaw = dirToYaw(v.aiTarget.pos[0] - v.pos[0], v.aiTarget.pos[2] - v.pos[2]);
          steer = clamp(angleDiff(v.yaw, wantYaw) * 1.8, -1, 1);
        }
      } else if (distGoal > 7.5 && (!v.aiTarget || v.aiTarget.dist > 34)) {
        const dx = wpX - v.pos[0];
        const dz = wpZ - v.pos[2];
        const wantYaw = dirToYaw(dx, dz);
        const diff = angleDiff(v.yaw, wantYaw);
        steer = clamp(diff * 1.8, -1, 1);
        throttle = Math.abs(diff) < 0.75 ? 0.72 : 0.15;

        // Stuck detection
        v.aiStuckTimer += dt;
        if (v.aiStuckTimer > 2.4) {
          const prog = Math.hypot(v.pos[0] - v.lastMoveCheckPos[0], v.pos[2] - v.lastMoveCheckPos[2]);
          v.lastMoveCheckPos[0] = v.pos[0];
          v.lastMoveCheckPos[2] = v.pos[2];
          v.aiStuckTimer = 0;
          if (prog < 1.2) v.aiReverseTimer = 1.4;
        }
      } else if (v.aiTarget) {
        // Hold firing stance & angle thick front armor toward threat!
        const wantYaw = dirToYaw(v.aiTarget.pos[0] - v.pos[0], v.aiTarget.pos[2] - v.pos[2]);
        const diff = angleDiff(v.yaw, wantYaw);
        if (Math.abs(diff) > 0.14) {
          steer = clamp(diff * 1.5, -0.8, 0.8);
        }
        throttle = 0;
      }
    }

    // Turret aiming & firing at acquired target
    if (v.aiTarget) {
      const tgt = v.aiTarget;
      const tPos = tgt.ref && tgt.ref.pos
        ? [tgt.ref.pos[0], tgt.ref.pos[1] + (tgt.kind === 'vehicle' ? 1.15 : 1.05), tgt.ref.pos[2]]
        : tgt.pos;

      // Simple lead calculation
      const leadT = clamp(tgt.dist / (v.spec.primary.muzzleVel || 180), 0, 0.65);
      const vx = (tgt.ref && tgt.ref.vel) ? tgt.ref.vel[0] : 0;
      const vz = (tgt.ref && tgt.ref.vel) ? tgt.ref.vel[2] : 0;
      const aimX = tPos[0] + vx * leadT;
      const aimY = tPos[1];
      const aimZ = tPos[2] + vz * leadT;

      const gunOrigin = [v.pos[0], v.pos[1] + v.spec.turretPivot[1] + v.spec.gunPivot[1], v.pos[2]];
      const dx = aimX - gunOrigin[0];
      const dy = aimY - gunOrigin[1];
      const dz = aimZ - gunOrigin[2];
      const horiz = Math.hypot(dx, dz) || 1;
      const gravityDrop = 0.5 * (v.spec.primary.gravity || 5.0) * leadT * leadT;

      v.targetTurretYaw = dirToYaw(dx, dz);
      v.targetGunPitch = clamp(Math.atan2(dy + gravityDrop, horiz), v.spec.pitchMin, v.spec.pitchMax);

      const yawErr = Math.abs(angleDiff(v.turretYaw, v.targetTurretYaw));
      const pitchErr = Math.abs(v.gunPitch - v.targetGunPitch);

      if (yawErr < 0.085 && pitchErr < 0.085) {
        if (v.role === 'mbt') {
          if (tgt.kind === 'vehicle' || tgt.dist > 20) {
            firePrimary(v);
          }
          if (tgt.kind === 'soldier') {
            fireSecondary(v); // Coaxial 7.62mm bursts!
          }
        } else {
          // IFV: Autocannon shreds infantry & light armor; ATGM vs enemy armor!
          if (tgt.kind === 'vehicle' && v.secondaryReload <= 0 && v.secondaryAmmo > 0 && tgt.dist > 16) {
            fireSecondary(v);
          }
          firePrimary(v);
        }
      }
    } else {
      // Sweep turret along heading
      v.targetTurretYaw = v.yaw + Math.sin(_time * 0.45 + (v.pos[0] * 0.1)) * 0.25;
      v.targetGunPitch = 0.03;
    }

    return { throttle, steer };
  }

  // ---------------------------------------------------------------------------
  // Player Control Input Parsing
  // ---------------------------------------------------------------------------
  function readPlayerInput(inp) {
    if (!inp) return { throttle: 0, steerLeft: 0, brake: false, dx: 0, dy: 0, fire: false, altFire: false, smoke: false, camCycle: false, thermal: false, camMode: undefined };
    const throttle = inp.throttle !== undefined ? inp.throttle : (inp.forward !== undefined ? inp.forward : ((inp.w ? 1 : 0) - (inp.s ? 1 : 0)));
    // main.js sends steer = (A ? 1 : 0) - (D ? 1 : 0) (positive = left); fallback right = D - A (negate)
    const steerLeft = inp.steer !== undefined ? inp.steer : (inp.right !== undefined ? -inp.right : ((inp.a ? 1 : 0) - (inp.d ? 1 : 0)));
    const brake = !!inp.brake;
    const dx = inp.lookDeltaX !== undefined ? inp.lookDeltaX : (inp.mouseDX !== undefined ? inp.mouseDX : (inp.lookDX !== undefined ? inp.lookDX : (inp.dx || 0)));
    const dy = inp.lookDeltaY !== undefined ? inp.lookDeltaY : (inp.mouseDY !== undefined ? inp.mouseDY : (inp.lookDY !== undefined ? inp.lookDY : (inp.dy || 0)));
    const fire = !!(inp.firePrimary || inp.fire || inp.lmb || inp.primary);
    const altFire = !!(inp.fireSecondary || inp.altFire || inp.rmb || inp.secondary);
    const smoke = !!(inp.smoke || inp.smokePressed || inp.xPressed);
    const camCycle = !!(inp.camCycle || inp.cycleCam || inp.cPressed);
    const thermal = !!(inp.thermalToggle || inp.tPressed);
    return { throttle, steerLeft, brake, dx, dy, fire, altFire, smoke, camCycle, thermal, camMode: inp.camMode, absYaw: inp.aimYaw, absPitch: inp.aimPitch };
  }

  function cycleCameraMode(v) {
    if (!v) return 0;
    v.camMode = (v.camMode + 1) % 3;
    v.thermalMode = (v.camMode === 2);
    if (v.isPlayerControlled && DF.UI && typeof DF.UI.showNotification === 'function') {
      const labels = ['第三人称外部视角', '炮手光学瞄准镜', 'FLIR 白热成像瞄准镜'];
      DF.UI.showNotification(`观瞄模式: ${labels[v.camMode]}`, 'info');
    }
    return v.camMode;
  }

  function toggleThermal(v) {
    if (!v) return false;
    v.thermalMode = !v.thermalMode;
    v.camMode = v.thermalMode ? 2 : 1;
    return v.thermalMode;
  }

  // ---------------------------------------------------------------------------
  // Camera Transform API (0: 3rd-Person, 1: Gunner Optic, 2: FLIR Thermal)
  // ---------------------------------------------------------------------------
  function getCameraTransform(vehicle, camModeOverride) {
    const v = vehicle || _vehicles.find(x => x.isPlayerControlled);
    if (!v) return null;

    const mode = camModeOverride !== undefined ? camModeOverride : v.camMode;
    const visionMode = (mode === 2 || v.thermalMode) ? 'thermal_white' : (mode === 1 ? 'optic' : 'normal');

    const aimYaw = v.targetTurretYaw;
    const aimPitch = v.targetGunPitch;
    const lookDir = [0, 0, 0];
    yawPitchToDir(aimYaw, aimPitch, lookDir);

    if (mode === 0) {
      // 3rd-person chase camera behind turret aim with collision pullback
      const pivot = [v.pos[0], v.pos[1] + v.height + 0.85, v.pos[2]];
      let dist = v.role === 'mbt' ? 8.6 : 7.8;
      const backDir = [-lookDir[0], -lookDir[1] * 0.4 + 0.28, -lookDir[2]];
      const bl = Math.hypot(backDir[0], backDir[1], backDir[2]) || 1;
      backDir[0] /= bl; backDir[1] /= bl; backDir[2] /= bl;

      if (DF.Physics && typeof DF.Physics.raycast === 'function') {
        const h = DF.Physics.raycast(pivot, backDir, dist, { ignoreIds: [v.colliderId] });
        if (h && h.dist < dist) dist = Math.max(2.6, h.dist - 0.55);
      }

      const desiredX = pivot[0] + backDir[0] * dist;
      const desiredY = Math.max(getGroundY(pivot[0] + backDir[0] * dist, pivot[2] + backDir[2] * dist, pivot[1] + 2.0) + 0.65, pivot[1] + backDir[1] * dist);
      const desiredZ = pivot[2] + backDir[2] * dist;

      if (!v.camInit) {
        v.camPosSmooth[0] = desiredX;
        v.camPosSmooth[1] = desiredY;
        v.camPosSmooth[2] = desiredZ;
        v.camInit = true;
      } else {
        v.camPosSmooth[0] = lerp(v.camPosSmooth[0], desiredX, 0.24);
        v.camPosSmooth[1] = lerp(v.camPosSmooth[1], desiredY, 0.24);
        v.camPosSmooth[2] = lerp(v.camPosSmooth[2], desiredZ, 0.24);
      }

      const target = [
        v.pos[0] + lookDir[0] * 36,
        v.pos[1] + 1.8 + lookDir[1] * 36,
        v.pos[2] + lookDir[2] * 36
      ];
      const camDx = target[0] - v.camPosSmooth[0];
      const camDy = target[1] - v.camPosSmooth[1];
      const camDz = target[2] - v.camPosSmooth[2];
      const camHoriz = Math.hypot(camDx, camDz) || 1;

      return {
        pos: [v.camPosSmooth[0], v.camPosSmooth[1], v.camPosSmooth[2]],
        yaw: dirToYaw(camDx, camDz),
        pitch: Math.atan2(camDy, camHoriz),
        roll: 0,
        fov: 68,
        near: 0.25,
        far: 360,
        visionMode: 'normal',
        camMode: 0,
        target,
        lookAt: target,
        forward: lookDir,
        isZoomed: false
      };
    }

    // Gunner Optical Sight (1) & FLIR Thermal Sight (2) mounted on turret sight housing
    const so = v.spec.sightOffset;
    const eye = [0, 0, 0];
    mat4TransformPoint(eye, v._matTurret, so[0], so[1], so[2] - 0.35);

    const gunDir = [v.muzzleWorldDir[0], v.muzzleWorldDir[1], v.muzzleWorldDir[2]];
    const target = [eye[0] + gunDir[0] * 80, eye[1] + gunDir[1] * 80, eye[2] + gunDir[2] * 80];
    const gunHoriz = Math.hypot(gunDir[0], gunDir[2]) || 1;

    return {
      pos: eye,
      yaw: dirToYaw(gunDir[0], gunDir[2]),
      pitch: Math.atan2(gunDir[1], gunHoriz),
      roll: 0,
      fov: mode === 2 ? 28 : 26,
      near: 0.35,
      far: 380,
      visionMode,
      camMode: mode,
      target,
      lookAt: target,
      forward: gunDir,
      isZoomed: true
    };
  }

  function respawnVehicle(v) {
    if (!v || !v.spawnPos) return false;
    // Ensure spawn lane is clear of other active vehicles
    for (let i = 0; i < _vehicles.length; i++) {
      const o = _vehicles[i];
      if (o === v || !o.alive) continue;
      if (Math.hypot(o.pos[0] - v.spawnPos[0], o.pos[2] - v.spawnPos[2]) < 7.5) return false;
    }
    const spec = v.spec;
    v.alive = true;
    v.destroyed = false;
    v.turretPopped = false;
    v.popSettled = false;
    v.hp = spec.maxHp;
    v.pos[0] = v.spawnPos[0];
    v.pos[1] = v.spawnPos[1];
    v.pos[2] = v.spawnPos[2];
    v.vel[0] = 0; v.vel[1] = 0; v.vel[2] = 0;
    v.yaw = v.spawnYaw;
    v.hullYaw = v.spawnYaw;
    v.turretYaw = v.spawnYaw;
    v.targetTurretYaw = v.spawnYaw;
    v.gunPitch = 0.02;
    v.targetGunPitch = 0.02;
    v.pitch = 0; v.roll = 0; v.speed = 0; v.yawVel = 0;
    v.terrainPitch = 0; v.terrainRoll = 0;
    v.suspPitch = 0; v.suspPitchVel = 0; v.suspRoll = 0; v.suspRollVel = 0;
    v.barrelRecoil = 0;
    v.primaryAmmo = spec.primary.ammoMax;
    v.mainAmmo = spec.primary.ammoMax;
    v.primaryReload = 0;
    v.secondaryAmmo = spec.secondary.ammoMax;
    v.secondaryReload = 0;
    v.smokeCharges = 3;
    v.smokeCooldown = 0;
    v.smokeReady = true;
    v.driver = null;
    v.occupants = [];
    v.isPlayerControlled = false;
    v.aiPath = null;
    v.aiPathTimer = 0;
    v.respawnTimer = 0;

    const initFit = sampleFourTrackGround(v, v._groundFit || (v._groundFit = { y: v.spawnPos[1], pitch: 0, roll: 0 }));
    v.pos[1] = initFit.y;
    v.terrainPitch = initFit.pitch;
    v.terrainRoll = initFit.roll;
    v.pitch = initFit.pitch;
    v.roll = initFit.roll;
    updateVehicleTransforms(v);
    registerCollider(v);

    if (DF.UI && typeof DF.UI.showNotification === 'function') {
      const pFac = (DF.AI && typeof DF.AI.getPlayerSoldier === 'function' && DF.AI.getPlayerSoldier())
        ? DF.AI.getPlayerSoldier().faction
        : null;
      if (!pFac || pFac === v.faction) {
        DF.UI.showNotification(`增援装甲 ${v.displayName} 已抵达前线!`, 'info');
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Main Update Loop
  // ---------------------------------------------------------------------------
  function update(dt, playerInput) {
    if (!dt || dt <= 0) return;
    const clampedDt = Math.min(dt, 0.05);
    _time += clampedDt;

    const pIn = readPlayerInput(playerInput);

    for (let i = 0; i < _vehicles.length; i++) {
      const v = _vehicles[i];
      if (v.spottedTimer > 0) v.spottedTimer = Math.max(0, v.spottedTimer - clampedDt);
      if (v.muzzleFlashTimer > 0) v.muzzleFlashTimer = Math.max(0, v.muzzleFlashTimer - clampedDt);

      // Dead burning wreck & popped turret physics
      if (!v.alive) {
        if (v.turretPopped && !v.popSettled) {
          v.popVel[1] -= 16.5 * clampedDt;
          v.popPos[0] += v.popVel[0] * clampedDt;
          v.popPos[1] += v.popVel[1] * clampedDt;
          v.popPos[2] += v.popVel[2] * clampedDt;
          v.popRot[0] += v.popRotVel[0] * clampedDt;
          v.popRot[1] += v.popRotVel[1] * clampedDt;
          v.popRot[2] += v.popRotVel[2] * clampedDt;

          const gy = getGroundY(v.popPos[0], v.popPos[2], v.popPos[1] + 1.0);
          if (v.popPos[1] <= gy + 0.36) {
            v.popPos[1] = gy + 0.36;
            if (Math.abs(v.popVel[1]) > 2.2) {
              v.popVel[1] = -v.popVel[1] * 0.25;
              v.popVel[0] *= 0.45;
              v.popVel[2] *= 0.45;
              v.popRotVel[0] *= 0.4; v.popRotVel[1] *= 0.4; v.popRotVel[2] *= 0.4;
              playImpact('metal', v.popPos);
            } else {
              v.popSettled = true;
            }
          }
          updateVehicleTransforms(v);
        }

        // Persistent burning wreck dark smoke & flames
        v.fireEmitTimer -= clampedDt;
        if (v.fireEmitTimer <= 0) {
          v.fireEmitTimer = rand(0.14, 0.26);
          spawnParticle({
            type: 'smoke',
            pos: [v.pos[0] + rand(-0.7, 0.7), v.pos[1] + 1.35, v.pos[2] + rand(-0.7, 0.7)],
            vel: [rand(-0.5, 0.5), rand(2.2, 3.8), rand(-0.5, 0.5)],
            size: 1.0, sizeEnd: 3.6, life: rand(2.8, 4.4),
            color: [0.10, 0.10, 0.10], alpha: 0.72, gravity: -0.35, drag: 0.5
          });
          spawnParticle({
            type: 'fire',
            pos: [v.pos[0] + rand(-0.5, 0.5), v.pos[1] + 1.25, v.pos[2] + rand(-0.5, 0.5)],
            vel: [rand(-0.3, 0.3), rand(1.4, 2.8), rand(-0.3, 0.3)],
            size: 0.65, sizeEnd: 1.3, life: rand(0.38, 0.68),
            color: [1.0, rand(0.35, 0.62), 0.10], alpha: 0.86, additive: false
          });
        }

        // Heavy armor reinforcement arrival in extended Breakthrough battles
        if (v.respawnTimer > 0) {
          v.respawnTimer -= clampedDt;
          if (v.respawnTimer <= 0) {
            const gm = DF.GameMode && typeof DF.GameMode.getState === 'function' ? DF.GameMode.getState() : null;
            const hasTickets = !gm || !gm.tickets || (gm.tickets[v.faction] >= 8);
            if (hasTickets) {
              if (!respawnVehicle(v)) v.respawnTimer = 4.0;
            }
          }
        }
        continue;
      }

      // Cooldowns & barrel recoil recovery
      if (v.primaryReload > 0) v.primaryReload = Math.max(0, v.primaryReload - clampedDt);
      if (v.secondaryReload > 0) v.secondaryReload = Math.max(0, v.secondaryReload - clampedDt);
      if (v.smokeCooldown > 0) v.smokeCooldown = Math.max(0, v.smokeCooldown - clampedDt);
      v.barrelRecoil = damp(v.barrelRecoil, 0, 11.0, clampedDt);

      // Determine driver commands (Player vs DF.AI Crew vs Built-in Autonomous Crew)
      let throttle = 0;
      let steerLeft = 0;
      let brake = false;

      if (v.isPlayerControlled) {
        throttle = pIn.throttle;
        steerLeft = pIn.steerLeft;
        brake = pIn.brake;
        if (pIn.camMode !== undefined) {
          v.camMode = pIn.camMode;
          v.thermalMode = (v.camMode === 2);
        }

        // Turret mouse aiming (handles both scaled radian deltas from main.js and raw pixel deltas)
        const zoomScale = v.camMode === 0 ? 1.0 : 0.65;
        if (pIn.absYaw !== undefined && pIn.dx === 0 && pIn.dy === 0) {
          v.targetTurretYaw = pIn.absYaw;
          if (pIn.absPitch !== undefined) {
            v.targetGunPitch = clamp(pIn.absPitch, v.spec.pitchMin, v.spec.pitchMax);
          }
        } else {
          const sens = (Math.abs(pIn.dx) > 0.35 || Math.abs(pIn.dy) > 0.35) ? 0.0022 : 1.0;
          v.targetTurretYaw -= pIn.dx * sens * zoomScale;
          v.targetGunPitch = clamp(v.targetGunPitch - pIn.dy * sens * zoomScale, v.spec.pitchMin, v.spec.pitchMax);
        }

        if (pIn.camCycle) cycleCameraMode(v);
        if (pIn.thermal) toggleThermal(v);
        if (pIn.smoke) deploySmoke(v);
        if (pIn.fire) firePrimary(v);
        if (pIn.altFire) fireSecondary(v);
      } else if (v.aiControl && v.aiControl.active) {
        const ac = v.aiControl;
        throttle = ac.throttle || 0;
        steerLeft = ac.steer || 0;
        if (ac.aimYaw !== undefined) v.targetTurretYaw = ac.aimYaw;
        if (ac.aimPitch !== undefined) v.targetGunPitch = clamp(ac.aimPitch, v.spec.pitchMin, v.spec.pitchMax);
        if (ac.smoke) deploySmoke(v);
        if (ac.fireMain) firePrimary(v);
        if (ac.fireSecondary) fireSecondary(v);
        ac.active = false;
      } else {
        const aiCmd = updateAICrew(v, clampedDt);
        throttle = aiCmd.throttle;
        steerLeft = aiCmd.steer;
      }

      // Slew turret & gun barrel with authentic mechanical angular limits
      const yawDiff = angleDiff(v.turretYaw, v.targetTurretYaw);
      const maxYawStep = v.spec.turretSlew * clampedDt;
      if (Math.abs(yawDiff) <= maxYawStep) v.turretYaw = v.targetTurretYaw;
      else v.turretYaw += Math.sign(yawDiff) * maxYawStep;

      const pitchDiff = v.targetGunPitch - v.gunPitch;
      const maxPitchStep = 1.15 * clampedDt;
      if (Math.abs(pitchDiff) <= maxPitchStep) v.gunPitch = v.targetGunPitch;
      else v.gunPitch += Math.sign(pitchDiff) * maxPitchStep;

      stepVehiclePhysics(v, throttle, steerLeft, clampedDt, brake);
      updateVehicleTransforms(v);

      // Sync HUD telemetry fields + Live Laser Rangefinder (LRF)
      v.mainAmmo = v.primaryAmmo;
      v.mainCooldown = v.primaryReload;
      v.reloadProgress = v.primaryReloadTotal > 0 ? clamp(1 - v.primaryReload / v.primaryReloadTotal, 0, 1) : 1;
      if (v.role === 'mbt') v.coaxAmmo = v.secondaryAmmo;
      else v.atgmAmmo = v.secondaryAmmo;
      v.smokeReady = v.smokeCharges > 0 && v.smokeCooldown <= 0;

      if (v.isPlayerControlled) {
        v.lrfTimer -= clampedDt;
        if (v.lrfTimer <= 0) {
          v.lrfTimer = 0.12;
          if (DF.Physics && typeof DF.Physics.raycast === 'function') {
            const h = DF.Physics.raycast(v.muzzleWorldPos, v.muzzleWorldDir, 220, {
              ignoreIds: [v.colliderId, v.id],
              checkEntities: true,
              checkVehicles: true
            });
            v.range = h ? h.dist : 0;
          }
        }
      }

      // Below 30% HP: dark engine smoke & crackling fire!
      if (v.hp < v.maxHp * 0.30) {
        v.smokeEmitTimer -= clampedDt;
        if (v.smokeEmitTimer <= 0) {
          v.smokeEmitTimer = rand(0.10, 0.20);
          const engPos = [v.pos[0] - v.forward[0] * 1.9, v.pos[1] + 1.42, v.pos[2] - v.forward[2] * 1.9];
          spawnParticle({
            type: 'smoke', pos: engPos,
            vel: [rand(-0.6, 0.6), rand(1.8, 3.2), rand(-0.6, 0.6)],
            size: 0.65, sizeEnd: 2.6, life: rand(1.8, 3.0),
            color: [0.14, 0.14, 0.14], alpha: 0.72, gravity: -0.3
          });
          if (Math.random() < 0.55) {
            spawnParticle({
              type: 'fire', pos: engPos,
              vel: [rand(-0.4, 0.4), rand(1.0, 2.2), rand(-0.4, 0.4)],
              size: 0.42, sizeEnd: 0.9, life: 0.38,
              color: [1.0, 0.48, 0.12], alpha: 0.84, additive: false
            });
          }
        }
      }
    }

    updateSmokeCanisters(clampedDt);
    updateFallbackProjectiles(clampedDt);
  }

  // ---------------------------------------------------------------------------
  // Rendering (Multi-Part PBR + FLIR Thermal Signatures + Dynamic Fire/Muzzle Lights)
  // ---------------------------------------------------------------------------
  function render(renderer, time) {
    const r = renderer || DF.Renderer;
    if (!r || typeof r.submitMesh !== 'function' || !_meshes) return;
    const t = time !== undefined ? time : _time;
    const castFlags = { castShadow: true, receiveShadow: true };

    for (let i = 0; i < _vehicles.length; i++) {
      const v = _vehicles[i];
      const m = _meshes[v.variant];
      if (!m) continue;

      const isWreck = !v.alive;
      const armorTex = isWreck ? 'burnt_wreck' : v.spec.texKey;
      const baseColor = isWreck ? [0.22, 0.20, 0.19] : v.spec.hullColor;
      const hullRough = isWreck ? 0.92 : 0.68;
      const hullMetal = isWreck ? 0.18 : 0.36;
      const hullHeat = isWreck ? 0.78 : (v.hp < v.maxHp * 0.30 ? 0.62 : 0.36);

      // Hide interior-blocking turret when player is inside zoomed gunner sight
      const inFirstPersonSight = v.isPlayerControlled && v.camMode >= 1;

      const matHull = {
        texKey: armorTex, color: baseColor, roughness: isWreck ? 0.92 : 0.72, metalness: isWreck ? 0.18 : 0.34,
        uvScale: [0.68, 0.68], thermalHeat: hullHeat
      };
      const matMetal = {
        texKey: isWreck ? 'burnt_wreck' : 'gunmetal',
        color: isWreck ? [0.18, 0.17, 0.16] : [0.70, 0.72, 0.72],
        roughness: 0.48, metalness: 0.76, thermalHeat: isWreck ? 0.65 : 0.34
      };
      const matTrack = {
        texKey: isWreck ? 'burnt_wreck' : 'metal_dark',
        color: isWreck ? [0.16, 0.15, 0.14] : [0.50, 0.49, 0.46],
        roughness: 0.74, metalness: 0.54, thermalHeat: 0.44
      };
      const matTire = {
        texKey: isWreck ? 'burnt_wreck' : 'rubber',
        color: isWreck ? [0.14, 0.14, 0.14] : [0.36, 0.36, 0.37],
        roughness: 0.90, metalness: 0.05, thermalHeat: 0.42
      };
      const matHub = {
        texKey: isWreck ? 'burnt_wreck' : 'metal_dark',
        color: isWreck ? [0.22, 0.20, 0.18] : [0.88, 0.90, 0.82],
        roughness: 0.58, metalness: 0.54, thermalHeat: 0.38
      };
      const matDrums = {
        texKey: isWreck ? 'burnt_wreck' : 'metal_dark',
        color: isWreck ? [0.20, 0.18, 0.16] : [0.90, 0.90, 0.86],
        uvScale: [0.5, 0.5], roughness: 0.74, metalness: 0.36, thermalHeat: 0.42
      };
      const matMark = {
        texKey: 'concrete',
        color: isWreck ? [0.20, 0.19, 0.18] : [1.08, 1.08, 1.06],
        emissive: isWreck ? [0, 0, 0] : [0.06, 0.06, 0.06],
        roughness: 0.58, metalness: 0.02, thermalHeat: 0.26
      };
      const matEngine = {
        texKey: 'metal_dark',
        color: isWreck ? [0.25, 0.14, 0.08] : [0.52, 0.50, 0.48],
        emissive: isWreck ? [0.85, 0.28, 0.05] : [0, 0, 0],
        roughness: 0.65, metalness: 0.60,
        thermalHeat: 0.96 // Engine radiator shines white-hot in FLIR!
      };

      // Hull, tracks, toothed sprockets, matte fuel drums, rotating twin roadwheels, markings, hot engine deck
      r.submitMesh(m.hull, v._matHull, matHull, castFlags);
      r.submitMesh(m.hullMetal, v._matHull, matMetal, castFlags);
      r.submitMesh(m.tracks, v._matHull, matTrack, castFlags);
      if (m.sprockets) r.submitMesh(m.sprockets, v._matHull, matHub, castFlags);
      if (m.hullDrums) r.submitMesh(m.hullDrums, v._matHull, matDrums, castFlags);
      r.submitMesh(m.engine, v._matHull, matEngine, castFlags);
      if (!isWreck) {
        r.submitMesh(m.hullMark, v._matHull, matMark, castFlags);
        if (m.hullLights) {
          r.submitMesh(m.hullLights, v._matHull, {
            texKey: 'concrete', color: [1.85, 1.85, 1.85], emissive: [0, 0, 0],
            roughness: 0.12, metalness: 0.0, thermalHeat: 0.80
          }, { castShadow: false, receiveShadow: false, unlit: true });
        }
      }

      for (let w = 0; w < v.spec.wheelCount; w++) {
        r.submitMesh(m.wheelTire, v._matWheelL[w], matTire, castFlags);
        r.submitMesh(m.wheelHub, v._matWheelL[w], matHub, castFlags);
        r.submitMesh(m.wheelTire, v._matWheelR[w], matTire, castFlags);
        r.submitMesh(m.wheelHub, v._matWheelR[w], matHub, castFlags);
      }

      if (v.turretPopped) {
        r.submitMesh(m.turret, v._matPopTurret, matHull, castFlags);
        r.submitMesh(m.turretMetal, v._matPopTurret, matMetal, castFlags);
      } else if (!inFirstPersonSight) {
        r.submitMesh(m.turret, v._matTurret, matHull, castFlags);
        r.submitMesh(m.turretMetal, v._matTurret, matMetal, castFlags);
        if (!isWreck) {
          r.submitMesh(m.turretMark, v._matTurret, matMark, castFlags);
          if (m.turretOptic) {
            r.submitMesh(m.turretOptic, v._matTurret, {
              texKey: 'glass', color: [0.22, 0.65, 0.72], emissive: [0.06, 0.18, 0.22],
              roughness: 0.05, metalness: 0.25, thermalHeat: 0.55
            }, { castShadow: false, receiveShadow: true });
          }
        }
        const matGun = {
          texKey: isWreck ? 'burnt_wreck' : 'gunmetal',
          color: isWreck ? [0.20, 0.19, 0.18] : [0.84, 0.86, 0.84],
          roughness: 0.44, metalness: 0.82,
          thermalHeat: v.muzzleFlashTimer > 0 ? 1.0 : 0.55 // Hot gun barrel in FLIR!
        };
        r.submitMesh(m.gun, v._matGun, matGun, castFlags);
      }

      // Dynamic lights: muzzle blast flash or burning wreck firelight
      if (v.muzzleFlashTimer > 0) {
        const power = v.role === 'mbt' ? 9.5 : 4.2;
        addLight(v.muzzleWorldPos, [1.0, 0.72, 0.32], power * (v.muzzleFlashTimer / 0.16), v.role === 'mbt' ? 18.0 : 10.0);
      }
      if (isWreck || v.hp < v.maxHp * 0.30) {
        const flicker = 0.78 + 0.22 * Math.sin(t * 17.0 + i * 3.1);
        const firePos = [v.pos[0], v.pos[1] + 1.75, v.pos[2]];
        addLight(firePos, [1.0, 0.44, 0.10], (isWreck ? 15.0 : 6.0) * flicker, isWreck ? 22.0 : 12.0);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Init & Reset
  // ---------------------------------------------------------------------------
  function reset() {
    if (DF.Physics && typeof DF.Physics.removeCollider === 'function') {
      for (let i = 0; i < _vehicles.length; i++) {
        DF.Physics.removeCollider(_vehicles[i].colliderId);
      }
    }
    _vehicles = [];
    _smokeCanisters = [];
    _fallbackProjectiles = [];
    _time = 0;

    for (let i = 0; i < INITIAL_SPAWNS.length; i++) {
      _vehicles.push(createVehicle(INITIAL_SPAWNS[i]));
    }
  }

  function init(gl) {
    _gl = gl;
    if (gl && DF.MeshGen && DF.MeshGen.Builder) {
      _meshes = {
        t64bv: buildT64BV(gl),
        t72b3: buildT72B3(gl),
        bradley: buildBradley(gl),
        bmp2: buildBMP2(gl)
      };
    }
    reset();
  }

  // ---------------------------------------------------------------------------
  // Public DF.Armor Contract
  // ---------------------------------------------------------------------------
  DF.Armor = {
    init,
    reset,
    enterVehicle,
    exitVehicle,
    getNearestInteractable,
    getAvailableVehicle,
    damageVehicle,
    deploySmoke,
    cycleCameraMode,
    toggleThermal,
    setAIOrder(vehicle, order, targetPos) {
      if (!vehicle) return;
      vehicle.aiOrder = order || 'advance';
      vehicle.aiOrderPos = targetPos ? [targetPos[0], targetPos[1] || 0, targetPos[2]] : null;
      vehicle.aiPathTimer = 0;
    },
    getVehicles() {
      return _vehicles;
    },
    getVehicleById(id) {
      return _vehicles.find(v => v.id === id) || null;
    },
    getPlayerVehicle() {
      return _vehicles.find(v => v.isPlayerControlled && v.alive) || null;
    },
    getCameraTransform,
    update,
    render
  };
})();
