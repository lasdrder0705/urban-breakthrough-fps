(() => {
  'use strict';

  const DF = (window.DF = window.DF || {});

  let glCtx = null;

  // Registered destructible pieces
  const pieceMap = new Map();
  const pieceList = [];

  // Grounded 3D rubble piles spawned upon collapse
  const rubblePiles = [];
  const MAX_RUBBLE_PILES = 72;

  // Dynamic 3D tumbling debris chunks
  const flyingDebris = [];
  const MAX_FLYING_DEBRIS = 110;

  // Short-lived destruction / detonation point lights
  const flashLights = [];

  // Staggered chain reaction blast queue
  const chainQueue = [];

  // Pre-built shared procedural meshes for rubble, debris, and fallback pieces
  const sharedMeshes = {
    unitBox: null,
    rubbleConcrete: null,
    rubbleBrick: null,
    rubbleWood: null,
    rubbleSandbag: null,
    carWreck: null,
    drumWreck: null,
    debrisChunkA: null,
    debrisChunkB: null,
    debrisPlank: null,
    rebarSpikes: null
  };

  // Column-major Float32Array(16) TRS builder (self-contained, exact OpenGL layout)
  function makeModelMatrix(px, py, pz, rx, ry, rz, sx, sy, sz, out) {
    const m = out || new Float32Array(16);
    const cx = Math.cos(rx), sinx = Math.sin(rx);
    const cy = Math.cos(ry), siny = Math.sin(ry);
    const cz = Math.cos(rz), sinz = Math.sin(rz);

    // Rotation order: Ry * Rx * Rz (matches standard Euler YXZ)
    const r00 = cy * cz + siny * sinx * sinz;
    const r01 = cz * siny * sinx - cy * sinz;
    const r02 = cx * siny;

    const r10 = cx * sinz;
    const r11 = cx * cz;
    const r12 = -sinx;

    const r20 = cy * sinx * sinz - cz * siny;
    const r21 = siny * sinz + cy * cz * sinx;
    const r22 = cx * cy;

    m[0] = r00 * sx;  m[1] = r10 * sx;  m[2] = r20 * sx;  m[3] = 0;
    m[4] = r01 * sy;  m[5] = r11 * sy;  m[6] = r21 * sy;  m[7] = 0;
    m[8] = r02 * sz;  m[9] = r12 * sz;  m[10] = r22 * sz; m[11] = 0;
    m[12] = px;       m[13] = py;       m[14] = pz;       m[15] = 1;
    return m;
  }

  function makeYawMatrix(px, py, pz, ry, sx, sy, sz, out) {
    const m = out || new Float32Array(16);
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    m[0] = c * sx;  m[1] = 0;  m[2] = -s * sx; m[3] = 0;
    m[4] = 0;       m[5] = sy; m[6] = 0;       m[7] = 0;
    m[8] = s * sz;  m[9] = 0;  m[10] = c * sz; m[11] = 0;
    m[12] = px;     m[13] = py; m[14] = pz;    m[15] = 1;
    return m;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function randRange(a, b) {
    return a + Math.random() * (b - a);
  }

  // Deterministic seeded PRNG for consistent procedural rubble silhouettes
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function safeAddWedge(b, cx, cy, cz, sx, sy, sz, opts) {
    if (typeof b.addWedge === 'function') {
      b.addWedge(cx, cy, cz, sx, sy, sz, opts);
    } else if (typeof b.addPrism === 'function') {
      b.addPrism(cx, cy, cz, sx, sy, sz, opts);
    } else {
      b.addBox(cx, cy, cz, sx, sy, sz, opts);
    }
  }

  function buildSharedMeshes(gl) {
    if (!gl || !DF.MeshGen || typeof DF.MeshGen.Builder !== 'function') return;
    const Builder = DF.MeshGen.Builder;

    // 1. Unit box centered on X/Z, resting cleanly from Y=0..1
    {
      const b = new Builder();
      b.addBox(0, 0.5, 0, 1, 1, 1, { color: [0.95, 0.95, 0.95] });
      if (typeof b.computeTangents === 'function') b.computeTangents();
      sharedMeshes.unitBox = b.build(gl);
    }

    // 2. Jagged grounded concrete rubble pile (matte dusty grey chunks, normalized ~1.8m wide x 0.44m tall, flush at Y=0)
    {
      const b = new Builder();
      const rng = mulberry32(1011);
      // Dusty concrete base mound
      b.addBox(0, 0.11, 0, 1.55, 0.22, 1.15, { color: [0.76, 0.74, 0.70], rotY: 0.12, uvScale: 0.5, aoBottom: 0.62 });
      safeAddWedge(b, -0.35, 0.22, 0.15, 0.72, 0.26, 0.65, { color: [0.80, 0.78, 0.74], rotY: 0.45, uvScale: 0.5 });
      safeAddWedge(b, 0.38, 0.20, -0.14, 0.68, 0.24, 0.58, { color: [0.72, 0.70, 0.67], rotY: -0.65, uvScale: 0.5 });
      // Broken slab chunks
      for (let i = 0; i < 10; i++) {
        const ang = rng() * Math.PI * 2;
        const rad = 0.15 + rng() * 0.64;
        const sx = 0.22 + rng() * 0.36;
        const sy = 0.12 + rng() * 0.20;
        const sz = 0.20 + rng() * 0.34;
        const shade = 0.68 + rng() * 0.20;
        b.addBox(
          Math.cos(ang) * rad,
          sy * 0.5 + rng() * 0.12,
          Math.sin(ang) * rad * 0.78,
          sx, sy, sz,
          { color: [shade, shade * 0.98, shade * 0.94], uvScale: 0.6, rotY: rng() * 3.14, rotX: (rng() - 0.5) * 0.45, rotZ: (rng() - 0.5) * 0.45 }
        );
      }
      // Bent rebar spikes poking from rubble
      for (let i = 0; i < 4; i++) {
        const rx = (rng() - 0.5) * 0.9;
        const rz = (rng() - 0.5) * 0.6;
        b.addCylinder(rx, 0.30, rz, 0.016, 0.016, 0.44, 5, {
          color: [0.42, 0.36, 0.32],
          rotX: (rng() - 0.5) * 0.85,
          rotZ: (rng() - 0.5) * 0.85
        });
      }
      if (typeof b.computeTangents === 'function') b.computeTangents();
      sharedMeshes.rubbleConcrete = b.build(gl);
    }

    // 3. Weathered dusty Donbas brick rubble pile
    {
      const b = new Builder();
      const rng = mulberry32(2022);
      b.addBox(0, 0.10, 0, 1.48, 0.20, 1.05, { color: [0.76, 0.66, 0.58], rotY: -0.18, uvScale: 0.6, aoBottom: 0.62 });
      for (let i = 0; i < 12; i++) {
        const ang = rng() * Math.PI * 2;
        const rad = 0.1 + rng() * 0.64;
        const sx = 0.18 + rng() * 0.28;
        const sy = 0.10 + rng() * 0.16;
        const sz = 0.16 + rng() * 0.24;
        const tint = 0.80 + rng() * 0.18;
        b.addBox(
          Math.cos(ang) * rad,
          sy * 0.5 + rng() * 0.14,
          Math.sin(ang) * rad * 0.75,
          sx, sy, sz,
          { color: [0.80 * tint, 0.66 * tint, 0.56 * tint], uvScale: 0.7, rotY: rng() * 3.14, rotX: (rng() - 0.5) * 0.55 }
        );
      }
      if (typeof b.computeTangents === 'function') b.computeTangents();
      sharedMeshes.rubbleBrick = b.build(gl);
    }

    // 4. Matte dusty splintered wood planks rubble
    {
      const b = new Builder();
      const rng = mulberry32(3033);
      for (let i = 0; i < 9; i++) {
        const len = 0.52 + rng() * 0.72;
        const shade = 0.74 + rng() * 0.20;
        b.addBox(
          (rng() - 0.5) * 0.88,
          0.04 + rng() * 0.11,
          (rng() - 0.5) * 0.76,
          len, 0.048, 0.12 + rng() * 0.07,
          { color: [0.78 * shade, 0.70 * shade, 0.58 * shade], uvScale: 0.8, rotY: rng() * 3.14, rotX: (rng() - 0.5) * 0.24, rotZ: (rng() - 0.5) * 0.24 }
        );
      }
      if (typeof b.computeTangents === 'function') b.computeTangents();
      sharedMeshes.rubbleWood = b.build(gl);
    }

    // 5. Torn sandbag earth spill
    {
      const b = new Builder();
      const rng = mulberry32(4044);
      b.addBox(0, 0.12, 0, 1.55, 0.24, 0.95, { color: [0.66, 0.60, 0.48] });
      for (let i = 0; i < 6; i++) {
        b.addBox(
          (rng() - 0.5) * 1.0,
          0.14 + rng() * 0.14,
          (rng() - 0.5) * 0.55,
          0.48, 0.16, 0.28,
          { color: [0.72, 0.66, 0.52], rotY: (rng() - 0.5) * 1.4, rotZ: (rng() - 0.5) * 0.3 }
        );
      }
      if (typeof b.computeTangents === 'function') b.computeTangents();
      sharedMeshes.rubbleSandbag = b.build(gl);
    }

    // 6. Photorealistic AAA charred burnt-out East-European sedan wreck (open gutted cabin, seats/dash/steering wheel, exposed engine block under warped hood, slatted grille, 5-spoke deep-dish charred black tires flush at Y=0!)
    {
      const b = new Builder();
      // Cool charred ash-steel palette (pairs cleanly with burnt_wreck material -> zero terracotta clay look!)
      const cSteel = [0.46, 0.48, 0.52];
      const cDarkSteel = [0.30, 0.32, 0.35];
      const cAsh = [0.56, 0.58, 0.60];
      const cChar = [0.16, 0.17, 0.19];
      const cTire = [0.10, 0.10, 0.11];
      const cRim = [0.28, 0.30, 0.33];

      // 1. Undercarriage floor pan & rocker sills (leaves real open cabin cavity between front/rear bulkheads!)
      b.addBeveledBox(0, 0.30, 0.0, 1.68, 0.16, 4.02, 0.02, { color: cChar, uvScale: 0.55, aoBottom: 0.42 });
      for (const sx of [-0.82, 0.82]) {
        // Side lower door shells (gutted open above beltline Y=0.76!)
        b.addBeveledBox(sx, 0.54, -0.04, 0.11, 0.42, 1.72, 0.018, { color: cSteel, uvScale: 0.55, aoBottom: 0.48 });
        // Front & rear sculpted wheel-arch quarter fenders
        b.addBeveledBox(sx, 0.60, 1.34, 0.16, 0.44, 1.24, 0.025, { color: cSteel, uvScale: 0.55, aoBottom: 0.50 });
        b.addBeveledBox(sx, 0.58, -1.36, 0.16, 0.42, 1.18, 0.025, { color: cSteel, uvScale: 0.55, aoBottom: 0.50 });
        // Raised fender wheel-well lip flares
        b.addBox(sx * 1.04, 0.54, 1.26, 0.06, 0.10, 0.66, { color: cDarkSteel });
        b.addBox(sx * 1.04, 0.54, -1.26, 0.06, 0.10, 0.66, { color: cDarkSteel });
      }
      // Front engine bay inner bulkhead + popped buckled hood revealing charred engine block!
      b.addBox(0, 0.56, 0.72, 1.60, 0.46, 0.12, { color: cChar });
      b.addBeveledBox(0, 0.52, 1.38, 0.78, 0.36, 0.76, 0.02, { color: cDarkSteel }); // Charred engine block
      b.addCylinder(0, 0.72, 1.36, 0.18, 0.18, 0.10, 10, { color: cAsh }); // Air cleaner housing
      b.addBeveledBox(0, 0.86, 1.34, 1.54, 0.07, 1.24, 0.02, { color: cAsh, rotX: 0.24, rotZ: -0.05, uvScale: 0.55 });
      // Rear trunk enclosure + twisted sunken trunk lid
      b.addBeveledBox(0, 0.58, -1.42, 1.56, 0.40, 1.08, 0.025, { color: cSteel, uvScale: 0.55, aoBottom: 0.48 });
      b.addBeveledBox(0, 0.80, -1.42, 1.48, 0.06, 1.02, 0.015, { color: cAsh, rotX: -0.09, rotZ: 0.03, uvScale: 0.55 });

      // 2. Front nose fascia with recessed slatted radiator grille, blown-out headlight sockets & twisted bumpers
      b.addBeveledBox(0, 0.52, 1.98, 1.66, 0.34, 0.12, 0.02, { color: cDarkSteel });
      b.addBox(0, 0.54, 2.04, 0.96, 0.20, 0.04, { color: cChar });
      for (let g = -1; g <= 1; g++) {
        b.addBox(0, 0.54 + g * 0.06, 2.06, 0.92, 0.02, 0.03, { color: cAsh });
      }
      for (const hx of [-0.62, 0.62]) {
        b.addCylinder(hx, 0.55, 2.04, 0.10, 0.10, 0.06, 10, { axis: 'z', color: cChar }); // Blown headlight socket
      }
      b.addBeveledBox(0, 0.34, 2.11, 1.76, 0.12, 0.14, 0.02, { color: cDarkSteel, rotZ: 0.04 });
      b.addBeveledBox(0, 0.33, -2.09, 1.76, 0.12, 0.14, 0.02, { color: cDarkSteel, rotZ: -0.03 });

      // 3. Visible gutted cabin interior (charred dashboard, steering column/wheel, burnt front & rear seat skeletons!)
      b.addBeveledBox(0, 0.72, 0.56, 1.52, 0.22, 0.32, 0.02, { color: cChar });
      b.addCylinder(-0.38, 0.82, 0.36, 0.15, 0.15, 0.04, 10, { axis: 'z', color: cDarkSteel, rotX: 0.32 });
      for (const sx of [-0.38, 0.38]) {
        b.addBox(sx, 0.44, 0.06, 0.44, 0.12, 0.44, { color: cChar });
        b.addBox(sx, 0.70, -0.14, 0.44, 0.46, 0.10, { color: cDarkSteel, rotX: -0.18 });
      }
      b.addBox(0, 0.44, -0.58, 1.38, 0.14, 0.46, { color: cChar });
      b.addBox(0, 0.70, -0.78, 1.38, 0.46, 0.12, { color: cDarkSteel, rotX: -0.14 });

      // 4. Sloped A-pillars, B-pillars, C-pillars & slightly buckled cambered sedan roof (clean silhouette, zero floating slabs!)
      for (const px of [-0.72, 0.72]) {
        b.addBox(px, 0.99, 0.54, 0.07, 0.54, 0.08, { color: cSteel, rotX: -0.44 }); // Sloped A-pillar
        b.addBox(px, 0.98, -0.08, 0.07, 0.50, 0.09, { color: cDarkSteel }); // Center B-pillar
        b.addBox(px, 0.99, -0.74, 0.08, 0.54, 0.14, { color: cSteel, rotX: 0.34 }); // Sloped C-pillar
      }
      b.addBeveledBox(0, 1.22, -0.12, 1.38, 0.07, 1.24, 0.025, { color: cAsh, rotZ: 0.04, rotX: -0.03, uvScale: 0.55 });
      b.addBeveledBox(0, 1.26, -0.12, 1.18, 0.05, 1.02, 0.02, { color: cSteel, rotZ: 0.04, rotX: -0.03, uvScale: 0.55 });

      // 5. Charred black 16-seg treaded tires + recessed 5-spoke dark steel rims flush at Y=0!
      const wx = [-0.82, 0.82];
      const wz = [1.26, -1.26];
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
          const outSign = i === 0 ? -1 : 1;
          b.addCylinder(wx[i], 0.28, wz[j], 0.28, 0.28, 0.23, 16, { axis: 'x', color: cTire });
          b.addCylinder(wx[i] + outSign * 0.09, 0.28, wz[j], 0.17, 0.17, 0.06, 12, { axis: 'x', color: cRim });
          b.addCylinder(wx[i] + outSign * 0.12, 0.28, wz[j], 0.06, 0.06, 0.04, 8, { axis: 'x', color: cChar });
        }
      }
      if (typeof b.computeTangents === 'function') b.computeTangents();
      sharedMeshes.carWreck = b.build(gl);
    }

    // 7. Ruptured blackened fuel drum base
    {
      const b = new Builder();
      b.addCylinder(0, 0.18, 0, 0.34, 0.30, 0.36, 10, { color: [0.18, 0.15, 0.14] });
      b.addBox(0.18, 0.14, 0.12, 0.35, 0.06, 0.32, { color: [0.22, 0.16, 0.15], rotZ: 0.55, rotY: 0.6 });
      if (typeof b.computeTangents === 'function') b.computeTangents();
      sharedMeshes.drumWreck = b.build(gl);
    }

    // 8. Flying 3D debris chunks
    {
      const bA = new Builder();
      bA.addBox(0, 0, 0, 0.32, 0.22, 0.26, { color: [0.85, 0.83, 0.80] });
      safeAddWedge(bA, 0.08, 0.06, 0.05, 0.22, 0.16, 0.18, { color: [0.76, 0.74, 0.72], rotY: 0.7 });
      if (typeof bA.computeTangents === 'function') bA.computeTangents();
      sharedMeshes.debrisChunkA = bA.build(gl);

      const bB = new Builder();
      bB.addBox(0, 0, 0, 0.24, 0.16, 0.34, { color: [0.88, 0.84, 0.80], rotZ: 0.35 });
      if (typeof bB.computeTangents === 'function') bB.computeTangents();
      sharedMeshes.debrisChunkB = bB.build(gl);

      const bP = new Builder();
      bP.addBox(0, 0, 0, 0.72, 0.06, 0.14, { color: [0.78, 0.62, 0.44] });
      if (typeof bP.computeTangents === 'function') bP.computeTangents();
      sharedMeshes.debrisPlank = bP.build(gl);
    }
  }

  function materialDamageFactor(material, isExplosive) {
    if (isExplosive) {
      if (material === 'glass') return 3.0;
      if (material === 'wood') return 2.2;
      if (material === 'sandbag') return 1.65;
      if (material === 'brick' || material === 'plaster') return 1.55;
      if (material === 'concrete') return 1.35;
      if (material === 'metal') return 1.45;
      return 1.4;
    }
    // Small arms bullet efficiency by material
    switch (material) {
      case 'glass': return 2.5;
      case 'wood': return 1.05;
      case 'metal': return 0.90;
      case 'sandbag': return 0.48;
      case 'plaster': return 0.34;
      case 'brick': return 0.22;
      case 'concrete': return 0.09;
      default: return 0.4;
    }
  }

  function defaultTexKey(material) {
    switch (material) {
      case 'brick': return 'brick';
      case 'plaster': return 'plaster';
      case 'wood': return 'wood';
      case 'sandbag': return 'sandbag';
      case 'glass': return 'glass';
      case 'metal': return 'metal_rust';
      default: return 'concrete';
    }
  }

  function debrisColorForMaterial(material) {
    switch (material) {
      case 'brick': return [0.68, 0.36, 0.26];
      case 'plaster': return [0.78, 0.75, 0.68];
      case 'wood': return [0.58, 0.42, 0.26];
      case 'sandbag': return [0.66, 0.59, 0.45];
      case 'glass': return [0.76, 0.88, 0.94];
      case 'metal': return [0.28, 0.26, 0.25];
      default: return [0.56, 0.55, 0.52];
    }
  }

  function spawnCollapseVFX(piece, hitPoint, hitDir, isExplosive) {
    const pos = piece.pos;
    const sz = piece.size;
    const center = [pos[0], pos[1] + sz[1] * 0.5, pos[2]];
    const dir = hitDir || [0, 0.4, 0];
    const col = debrisColorForMaterial(piece.material);
    const volScale = clamp(Math.cbrt(sz[0] * sz[1] * sz[2]) * 0.72, 0.6, 2.2);

    // 1. Soft dust / smoke / shard particles
    if (DF.Renderer && typeof DF.Renderer.spawnParticle === 'function') {
      const sp = DF.Renderer.spawnParticle.bind(DF.Renderer);

      if (piece.material === 'glass') {
        for (let i = 0; i < 16; i++) {
          sp({
            type: 'spark',
            pos: [
              center[0] + randRange(-sz[0] * 0.4, sz[0] * 0.4),
              center[1] + randRange(-sz[1] * 0.4, sz[1] * 0.4),
              center[2] + randRange(-sz[2] * 0.4, sz[2] * 0.4)
            ],
            vel: [
              dir[0] * randRange(2.5, 6.0) + randRange(-2.5, 2.5),
              randRange(0.5, 3.2),
              dir[2] * randRange(2.5, 6.0) + randRange(-2.5, 2.5)
            ],
            size: randRange(0.06, 0.14),
            sizeEnd: 0.04,
            life: randRange(0.4, 0.8),
            color: [0.82, 0.92, 0.98],
            alpha: 0.88,
            gravity: 12.5,
            drag: 0.4,
            additive: false
          });
        }
      } else {
        // Thick masonry / wood collapse dust cloud
        const dustCount = Math.round((isExplosive ? 16 : 10) * volScale);
        for (let i = 0; i < dustCount; i++) {
          const ang = Math.random() * Math.PI * 2;
          const spd = randRange(0.8, 3.6) * volScale;
          sp({
            type: 'dust',
            pos: [
              center[0] + randRange(-sz[0] * 0.45, sz[0] * 0.45),
              center[1] + randRange(-sz[1] * 0.35, sz[1] * 0.45),
              center[2] + randRange(-sz[2] * 0.45, sz[2] * 0.45)
            ],
            vel: [
              Math.cos(ang) * spd + dir[0] * 1.4,
              randRange(0.8, 3.4) * volScale,
              Math.sin(ang) * spd + dir[2] * 1.4
            ],
            size: randRange(0.7, 1.5) * volScale,
            sizeEnd: randRange(2.8, 5.2) * volScale,
            life: randRange(2.0, 4.2),
            color: [col[0] * 0.92, col[1] * 0.90, col[2] * 0.88],
            alpha: 0.72,
            gravity: -0.35,
            drag: 1.45,
            rotSpeed: randRange(-0.9, 0.9),
            additive: false
          });
        }

        // Flying particle debris chunks
        const sparkCount = Math.round(14 * volScale);
        for (let i = 0; i < sparkCount; i++) {
          const ang = Math.random() * Math.PI * 2;
          const spd = randRange(2.4, 8.5) * volScale;
          sp({
            type: 'debris',
            pos: [
              center[0] + randRange(-sz[0] * 0.35, sz[0] * 0.35),
              center[1] + randRange(-sz[1] * 0.25, sz[1] * 0.35),
              center[2] + randRange(-sz[2] * 0.35, sz[2] * 0.35)
            ],
            vel: [
              Math.cos(ang) * spd + dir[0] * 2.5,
              randRange(2.5, 7.8) * volScale,
              Math.sin(ang) * spd + dir[2] * 2.5
            ],
            size: randRange(0.11, 0.24),
            sizeEnd: 0.10,
            life: randRange(0.8, 1.65),
            color: col,
            alpha: 0.95,
            gravity: 14.5,
            drag: 0.4,
            rotSpeed: randRange(-6, 6),
            additive: false
          });
        }

        // Layered Battlefield-grade explosive detonation VFX (flash + turbulent shockwave + soot-backed fire + stretched sparks!)
        if (piece.explosive) {
          const bScale = piece.kind === 'car' ? 1.35 : 0.95;
          sp({
            type: 'flash',
            pos: [center[0], center[1] + 0.35, center[2]],
            vel: [0, 0.2, 0],
            size: 3.4 * bScale,
            sizeEnd: 6.2 * bScale,
            life: 0.14,
            color: [1.0, 0.88, 0.58],
            alpha: 0.95,
            gravity: 0,
            drag: 2.0,
            additive: true
          });
          sp({
            type: 'shockwave',
            pos: [center[0], center[1] + 0.25, center[2]],
            vel: [0, 0, 0],
            size: 1.6 * bScale,
            sizeEnd: 11.5 * bScale,
            life: 0.36,
            color: [0.88, 0.78, 0.64],
            alpha: 0.58,
            gravity: 0,
            drag: 0,
            additive: false
          });
          for (let f = 0; f < 10; f++) {
            const ang = (f / 10) * Math.PI * 2 + randRange(-0.25, 0.25);
            const spd = randRange(1.2, 4.2) * bScale;
            sp({
              type: 'fire',
              pos: [center[0] + randRange(-0.6, 0.6) * bScale, center[1] + randRange(0.0, 0.8), center[2] + randRange(-0.6, 0.6) * bScale],
              vel: [Math.cos(ang) * spd, randRange(2.4, 5.8) * bScale, Math.sin(ang) * spd],
              size: randRange(1.1, 1.9) * bScale,
              sizeEnd: randRange(2.8, 4.4) * bScale,
              life: randRange(0.45, 0.85),
              color: [1.0, 0.46, 0.08],
              alpha: 0.92,
              gravity: -1.4,
              drag: 1.5,
              rotSpeed: randRange(-1.8, 1.8),
              additive: false
            });
          }
          for (let k = 0; k < 22; k++) {
            const ang = Math.random() * Math.PI * 2;
            const spd = randRange(5.0, 15.0) * bScale;
            sp({
              type: 'spark',
              pos: [center[0] + randRange(-0.4, 0.4), center[1] + 0.4, center[2] + randRange(-0.4, 0.4)],
              vel: [Math.cos(ang) * spd, randRange(3.2, 11.0) * bScale, Math.sin(ang) * spd],
              size: randRange(0.10, 0.18),
              sizeEnd: 0.03,
              life: randRange(0.5, 1.35),
              color: [1.0, 0.68, 0.22],
              alpha: 1.0,
              gravity: 11.5,
              drag: 0.45,
              additive: true
            });
          }
        }
      }
    }

    // 2. Physical 3D tumbling debris meshes
    if (piece.material !== 'glass' && sharedMeshes.debrisChunkA) {
      const chunkCount = clamp(Math.round(5 * volScale), 3, 10);
      const isWood = piece.material === 'wood';
      const meshOptA = isWood ? sharedMeshes.debrisPlank : sharedMeshes.debrisChunkA;
      const meshOptB = isWood ? sharedMeshes.debrisPlank : sharedMeshes.debrisChunkB;
      const texKey = defaultTexKey(piece.material);

      for (let i = 0; i < chunkCount; i++) {
        if (flyingDebris.length >= MAX_FLYING_DEBRIS) flyingDebris.shift();
        const ang = Math.random() * Math.PI * 2;
        const spd = randRange(2.2, 7.6) * volScale;
        flyingDebris.push({
          pos: [
            center[0] + randRange(-sz[0] * 0.35, sz[0] * 0.35),
            center[1] + randRange(-sz[1] * 0.2, sz[1] * 0.35),
            center[2] + randRange(-sz[2] * 0.35, sz[2] * 0.35)
          ],
          vel: [
            Math.cos(ang) * spd + dir[0] * 2.2,
            randRange(2.8, 7.4) * volScale,
            Math.sin(ang) * spd + dir[2] * 2.2
          ],
          rot: [randRange(0, 6.28), randRange(0, 6.28), randRange(0, 6.28)],
          rotVel: [randRange(-9, 9), randRange(-9, 9), randRange(-9, 9)],
          scale: randRange(0.65, 1.35),
          mesh: i % 2 === 0 ? meshOptA : meshOptB,
          texKey,
          color: col,
          life: randRange(3.2, 5.5),
          maxLife: 5.5,
          bounces: 0,
          mat: new Float32Array(16)
        });
      }
    }

    // 3. Dynamic flash light for heavy/explosive collapse
    if (isExplosive || piece.explosive) {
      flashLights.push({
        pos: [center[0], center[1] + 0.5, center[2]],
        color: [1.0, 0.62, 0.24],
        intensity: piece.explosive ? 16.0 : 8.0,
        radius: piece.explosive ? 22.0 : 12.0,
        life: piece.explosive ? 0.55 : 0.24,
        maxLife: piece.explosive ? 0.55 : 0.24
      });
    }

    // 4. Audio feedback
    if (DF.Audio) {
      if (piece.explosive && typeof DF.Audio.playExplosion === 'function') {
        DF.Audio.playExplosion(center, (piece.blastRadius || 9) / 7.5);
      } else if (typeof DF.Audio.playImpact === 'function') {
        DF.Audio.playImpact(piece.material === 'glass' ? 'metal' : piece.material, center);
      }
    }
  }

  function spawnGroundedRubble(piece) {
    if (piece.spawnsRubble === false || piece.material === 'glass') return;

    const floorY = piece.floorY !== undefined
      ? piece.floorY
      : (DF.Physics ? DF.Physics.getGroundY(piece.pos[0], piece.pos[2], piece.pos[1] + 0.3) : piece.pos[1]);

    // Explosive vehicles/drums leave a blackened smoking wreck instead of masonry rubble
    if (piece.kind === 'car' || piece.kind === 'fuel_drum') {
      const isCar = piece.kind === 'car';
      const mesh = isCar ? sharedMeshes.carWreck : sharedMeshes.drumWreck;
      if (!mesh) return;
      if (rubblePiles.length >= MAX_RUBBLE_PILES) rubblePiles.shift();

      const pile = {
        pos: [piece.pos[0], floorY, piece.pos[2]],
        rotY: piece.rotY || 0,
        scale: isCar ? [1, 1, 1] : [1, 1, 1],
        mesh,
        texKey: 'burnt_wreck',
        color: isCar ? [0.50, 0.52, 0.56] : [0.46, 0.48, 0.52],
        roughness: 0.72,
        metalness: 0.52,
        thermalHeat: 0.72,
        smokeTimer: isCar ? 38.0 : 16.0,
        smokeAccum: 0,
        modelMat: makeYawMatrix(piece.pos[0], floorY, piece.pos[2], piece.rotY || 0, 1, 1, 1)
      };
      rubblePiles.push(pile);

      // Keep a lower burnt-husk cover collider for blown-up cars so players can still crouch behind the wreck
      if (isCar && DF.Physics && piece.colliderId) {
        const c = Math.abs(Math.cos(piece.rotY || 0));
        const s = Math.abs(Math.sin(piece.rotY || 0));
        const hw = (piece.size[0] * c + piece.size[2] * s) * 0.46;
        const hd = (piece.size[0] * s + piece.size[2] * c) * 0.46;
        DF.Physics.addCollider(
          piece.colliderId + '_wreck',
          [piece.pos[0] - hw, floorY, piece.pos[2] - hd],
          [piece.pos[0] + hw, floorY + 1.05, piece.pos[2] + hd],
          { type: 'cover', material: 'metal' }
        );
        piece.wreckColliderId = piece.colliderId + '_wreck';
      }
      return;
    }

    // Standard structural/barricade grounded 3D rubble pile (gritty muted matte masonry/wood, steppable height <= 0.46m!)
    let mesh = sharedMeshes.rubbleConcrete;
    let texKey = 'concrete_damaged';
    let color = [0.46, 0.44, 0.42];

    if (piece.material === 'brick') {
      mesh = sharedMeshes.rubbleBrick;
      texKey = 'brick';
      color = [0.54, 0.46, 0.40];
    } else if (piece.material === 'wood') {
      mesh = sharedMeshes.rubbleWood;
      texKey = 'wood';
      color = [0.48, 0.43, 0.36];
    } else if (piece.material === 'sandbag') {
      mesh = sharedMeshes.rubbleSandbag;
      texKey = 'sandbag';
      color = [0.50, 0.47, 0.41];
    } else if (piece.material === 'plaster') {
      mesh = sharedMeshes.rubbleConcrete;
      texKey = 'concrete_damaged';
      color = [0.48, 0.46, 0.44];
    }

    if (!mesh) return;
    if (rubblePiles.length >= MAX_RUBBLE_PILES) rubblePiles.shift();

    const sx = clamp(piece.size[0] * 0.58, 0.65, 2.4);
    const sz = clamp(Math.max(piece.size[2], 0.9) * 0.78, 0.7, 1.9);
    const sy = clamp(piece.size[1] * 0.35, 0.55, 1.05);

    rubblePiles.push({
      pos: [piece.pos[0], floorY, piece.pos[2]],
      rotY: piece.rotY || 0,
      scale: [sx, sy, sz],
      mesh,
      texKey,
      color,
      roughness: 0.98,
      metalness: 0.0,
      thermalHeat: 0.14,
      smokeTimer: 4.5,
      smokeAccum: 0,
      modelMat: makeYawMatrix(piece.pos[0], floorY, piece.pos[2], piece.rotY || 0, sx, sy, sz)
    });
  }

  function collapsePiece(piece, hitPoint, hitDir, isExplosive, attacker) {
    if (piece.collapsed) return;
    piece.collapsed = true;
    piece.state = 2;
    piece.hp = 0;
    piece.burning = false;

    // 1. Remove intact collider
    if (piece.colliderId && DF.Physics) {
      DF.Physics.removeCollider(piece.colliderId);
    }

    // 2. Spawn grounded 3D rubble pile or burnt vehicle wreck
    spawnGroundedRubble(piece);

    // 3. Rebuild navigation cells around the collapsed breach & invalidate destroyed cover
    if (DF.Physics) {
      const c = Math.abs(Math.cos(piece.rotY || 0));
      const s = Math.abs(Math.sin(piece.rotY || 0));
      const halfX = (piece.size[0] * c + piece.size[2] * s) * 0.5 + 1.0;
      const halfZ = (piece.size[0] * s + piece.size[2] * c) * 0.5 + 1.0;

      DF.Physics.rebuildNavCell(
        piece.pos[0] - halfX,
        piece.pos[2] - halfZ,
        piece.pos[0] + halfX,
        piece.pos[2] + halfZ
      );

      const coverRad = Math.max(halfX, halfZ) + 1.4;
      DF.Physics.invalidateCoverNear(piece.pos, coverRad, piece.id);
    }

    // 4. Visual debris burst + sound + flash light
    spawnCollapseVFX(piece, hitPoint, hitDir, isExplosive);

    // 5. Emit destruction event
    if (DF.Events && typeof DF.Events.emit === 'function') {
      DF.Events.emit('destruction:collapsed', {
        id: piece.id,
        pos: [piece.pos[0], piece.pos[1], piece.pos[2]],
        material: piece.material,
        floorLevel: piece.floorLevel,
        explosive: !!piece.explosive
      });
    }

    // 6. Explosive detonation & staggered chain reactions (cars & fuel drums)
    if (piece.explosive && !piece.detonated) {
      piece.detonated = true;
      const blastPos = [piece.pos[0], piece.pos[1] + Math.min(1.0, piece.size[1] * 0.5), piece.pos[2]];
      const bRad = piece.blastRadius || 9.5;
      const bDmg = piece.blastDamage || 180;

      if (DF.Game && typeof DF.Game.applyExplosion === 'function') {
        DF.Game.applyExplosion(blastPos, bRad, bDmg, attacker || null, piece.kind === 'car' ? 'VEHICLE_BLAST' : 'FUEL_DRUM');
      } else {
        // Queue local chain reaction if DF.Game is not bound yet (e.g. standalone test)
        chainQueue.push({ delay: 0.16, pos: blastPos, radius: bRad, damage: bDmg });
      }
    }
  }

  const Destruction = {
    init(gl) {
      glCtx = gl || null;
      pieceMap.clear();
      pieceList.length = 0;
      rubblePiles.length = 0;
      flyingDebris.length = 0;
      flashLights.length = 0;
      chainQueue.length = 0;
      buildSharedMeshes(glCtx);
    },

    registerPiece(cfg) {
      if (!cfg || !cfg.id) return null;
      const size = cfg.size || [2, 2, 0.3];
      const pos = [cfg.pos[0], cfg.pos[1], cfg.pos[2]];
      const rotY = cfg.rotY || 0;
      const maxHp = cfg.maxHp !== undefined ? cfg.maxHp : (cfg.hp !== undefined ? cfg.hp : 120);
      const hp = cfg.hp !== undefined ? cfg.hp : maxHp;
      const material = cfg.material || 'concrete';
      const floorY = cfg.floorY !== undefined ? cfg.floorY : pos[1];

      // Auto-register physics collider if colliderId provided and not already created
      let colliderId = cfg.colliderId || ('dest_col_' + cfg.id);
      let origColMin = null;
      let origColMax = null;
      let origColMeta = null;

      if (DF.Physics) {
        const existing = DF.Physics.getCollider(colliderId);
        if (existing) {
          origColMin = [existing.min[0], existing.min[1], existing.min[2]];
          origColMax = [existing.max[0], existing.max[1], existing.max[2]];
          origColMeta = Object.assign({}, existing.meta || {
            type: existing.type,
            material: existing.material,
            destructibleId: cfg.id,
            passableForBullets: existing.passableForBullets
          });
          existing.destructibleId = cfg.id;
          if (existing.meta) existing.meta.destructibleId = cfg.id;
        } else {
          const c = Math.abs(Math.cos(rotY));
          const s = Math.abs(Math.sin(rotY));
          const hw = (size[0] * c + size[2] * s) * 0.5;
          const hd = (size[0] * s + size[2] * c) * 0.5;
          origColMin = [pos[0] - hw, pos[1], pos[2] - hd];
          origColMax = [pos[0] + hw, pos[1] + size[1], pos[2] + hd];
          origColMeta = {
            type: cfg.colliderType || 'destructible',
            material,
            destructibleId: cfg.id,
            passableForBullets: !!cfg.passableForBullets
          };
          DF.Physics.addCollider(colliderId, origColMin, origColMax, origColMeta);
        }
      }

      const scale = cfg.useUnitBox
        ? [size[0], size[1], size[2]]
        : (cfg.scale || [1, 1, 1]);

      const piece = {
        id: cfg.id,
        kind: cfg.kind || 'wall', // 'wall'|'partition'|'parapet'|'window'|'door'|'sandbag'|'barrier'|'crate'|'car'|'fuel_drum'
        pos,
        size: [size[0], size[1], size[2]],
        rotY,
        scale,
        material,
        texKey: cfg.texKey || defaultTexKey(material),
        damagedTexKey: cfg.damagedTexKey || (material === 'concrete' ? 'concrete_damaged' : (cfg.texKey || defaultTexKey(material))),
        color: cfg.color ? [cfg.color[0], cfg.color[1], cfg.color[2]] : [0.92, 0.90, 0.88],
        roughness: cfg.roughness !== undefined ? cfg.roughness : (material === 'glass' ? 0.14 : material === 'metal' ? 0.48 : 0.86),
        metalness: cfg.metalness !== undefined ? cfg.metalness : (material === 'metal' ? 0.65 : 0.04),
        alpha: cfg.alpha !== undefined ? cfg.alpha : (material === 'glass' ? 0.42 : 1.0),
        doubleSided: !!cfg.doubleSided || material === 'glass',
        hp,
        maxHp,
        state: 0, // 0=intact, 1=damaged/cracked, 2=collapsed
        collapsed: false,
        explosive: !!cfg.explosive,
        blastRadius: cfg.blastRadius || (cfg.kind === 'car' ? 11.0 : 8.0),
        blastDamage: cfg.blastDamage || (cfg.kind === 'car' ? 210 : 165),
        burning: false,
        burnTimer: 0,
        burnFxAccum: 0,
        detonated: false,
        meshIntact: cfg.meshIntact || sharedMeshes.unitBox,
        meshDamaged: cfg.meshDamaged || cfg.meshIntact || sharedMeshes.unitBox,
        colliderId,
        wreckColliderId: null,
        origColMin,
        origColMax,
        origColMeta,
        floorLevel: cfg.floorLevel !== undefined ? cfg.floorLevel : (floorY > 5.8 ? 2 : floorY > 2.2 ? 1 : 0),
        floorY,
        spawnsRubble: cfg.spawnsRubble !== false,
        hitFlash: 0,
        modelMat: makeYawMatrix(pos[0], pos[1], pos[2], rotY, scale[0], scale[1], scale[2])
      };

      pieceMap.set(piece.id, piece);
      pieceList.push(piece);
      return piece;
    },

    damagePiece(id, dmg, hitPoint, hitDir, isExplosive, attacker) {
      const piece = pieceMap.get(id);
      if (!piece || piece.collapsed) return false;
      const mult = materialDamageFactor(piece.material, !!isExplosive);
      const effDmg = Math.max(0, (dmg || 0) * mult);
      if (effDmg <= 0.05) return false;

      piece.hp = Math.max(0, piece.hp - effDmg);
      piece.hitFlash = 0.18;

      const hpRatio = piece.hp / Math.max(1, piece.maxHp);

      // Transition intact -> damaged/cracked state
      if (piece.state === 0 && hpRatio <= 0.58 && piece.hp > 0) {
        piece.state = 1;
        // Emit crisp cracking dust puff
        if (DF.Renderer && typeof DF.Renderer.spawnParticle === 'function') {
          const p = hitPoint || [piece.pos[0], piece.pos[1] + piece.size[1] * 0.5, piece.pos[2]];
          const col = debrisColorForMaterial(piece.material);
          for (let i = 0; i < 6; i++) {
            DF.Renderer.spawnParticle({
              type: 'dust',
              pos: [p[0] + randRange(-0.3, 0.3), p[1] + randRange(-0.2, 0.3), p[2] + randRange(-0.3, 0.3)],
              vel: [randRange(-1.4, 1.4), randRange(0.4, 2.0), randRange(-1.4, 1.4)],
              size: 0.35,
              sizeEnd: 1.4,
              life: randRange(0.8, 1.5),
              color: col,
              alpha: 0.65,
              gravity: -0.25,
              drag: 1.8,
              additive: false
            });
          }
        }
      }

      // Explosive vehicles & red fuel drums catch fire below 40% HP before detonating
      if (piece.explosive && !piece.burning && piece.hp > 0 && hpRatio <= 0.42) {
        piece.burning = true;
        piece.burnTimer = piece.kind === 'car' ? 2.5 : 1.5;
        piece.state = 1;
      }

      if (piece.hp <= 0) {
        collapsePiece(piece, hitPoint, hitDir, !!isExplosive, attacker);
        return true;
      }
      return false;
    },

    applyBlast(pos, radius, damage, attacker) {
      if (!pos) return 0;
      const rad = Math.max(1.0, radius || 7.0);
      const dmg = damage !== undefined ? damage : 140;
      let collapsedCount = 0;

      for (let i = 0; i < pieceList.length; i++) {
        const p = pieceList[i];
        if (p.collapsed) continue;
        const cx = p.pos[0];
        const cy = p.pos[1] + p.size[1] * 0.5;
        const cz = p.pos[2];
        const dx = cx - pos[0];
        const dy = cy - pos[1];
        const dz = cz - pos[2];
        // Account for piece extent so wide wall panels near blast edge still take proper damage
        const halfDiag = Math.hypot(p.size[0], p.size[1], p.size[2]) * 0.42;
        const dist = Math.max(0, Math.hypot(dx, dy, dz) - halfDiag);
        if (dist > rad) continue;

        const falloff = 1.0 - dist / rad;
        const scaledDmg = dmg * (0.35 + 0.65 * falloff);
        const invL = 1.0 / (Math.hypot(dx, dy, dz) || 1);
        const dir = [dx * invL, Math.max(0.2, dy * invL), dz * invL];

        if (Destruction.damagePiece(p.id, scaledDmg, [cx, cy, cz], dir, true, attacker)) {
          collapsedCount++;
        }
      }
      return collapsedCount;
    },

    reset() {
      // Restore all registered pieces cleanly for match restart / faction switch
      rubblePiles.length = 0;
      flyingDebris.length = 0;
      flashLights.length = 0;
      chainQueue.length = 0;

      let minX = 999, minZ = 999, maxX = -999, maxZ = -999;
      let anyRestored = false;

      for (let i = 0; i < pieceList.length; i++) {
        const p = pieceList[i];
        const wasCollapsed = p.collapsed;
        p.hp = p.maxHp;
        p.state = 0;
        p.collapsed = false;
        p.burning = false;
        p.burnTimer = 0;
        p.detonated = false;
        p.hitFlash = 0;

        if (DF.Physics) {
          if (p.wreckColliderId) {
            DF.Physics.removeCollider(p.wreckColliderId);
            p.wreckColliderId = null;
          }
          if (wasCollapsed && p.colliderId && p.origColMin && p.origColMax) {
            DF.Physics.addCollider(p.colliderId, p.origColMin, p.origColMax, p.origColMeta);
            anyRestored = true;
            if (p.origColMin[0] < minX) minX = p.origColMin[0];
            if (p.origColMin[2] < minZ) minZ = p.origColMin[2];
            if (p.origColMax[0] > maxX) maxX = p.origColMax[0];
            if (p.origColMax[2] > maxZ) maxZ = p.origColMax[2];
          }
        }
      }

      if (DF.Physics) {
        if (typeof DF.Physics.restoreAllCover === 'function') {
          DF.Physics.restoreAllCover();
        }
        if (anyRestored) {
          DF.Physics.rebuildNavCell(minX - 2, minZ - 2, maxX + 2, maxZ + 2);
        }
      }
    },

    getPieces() {
      return pieceList;
    },

    getPiece(id) {
      return pieceMap.get(id) || null;
    },

    update(dt) {
      const safeDt = Math.min(Math.max(dt || 0, 0), 0.1);
      if (safeDt <= 0) return;

      // 1. Process staggered chain reaction blasts
      for (let i = chainQueue.length - 1; i >= 0; i--) {
        chainQueue[i].delay -= safeDt;
        if (chainQueue[i].delay <= 0) {
          const item = chainQueue.splice(i, 1)[0];
          Destruction.applyBlast(item.pos, item.radius, item.damage);
        }
      }

      // 2. Update burning explosive pieces (cars & fuel drums) and hit flashes
      const canEmit = DF.Renderer && typeof DF.Renderer.spawnParticle === 'function';
      for (let i = 0; i < pieceList.length; i++) {
        const p = pieceList[i];
        if (p.hitFlash > 0) p.hitFlash = Math.max(0, p.hitFlash - safeDt);
        if (!p.burning || p.collapsed) continue;

        p.burnTimer -= safeDt;
        p.hp = Math.max(1, p.hp - (p.maxHp * 0.16) * safeDt);
        p.burnFxAccum += safeDt;

        if (canEmit && p.burnFxAccum >= 0.065) {
          p.burnFxAccum = 0;
          const fxPos = [
            p.pos[0] + randRange(-p.size[0] * 0.25, p.size[0] * 0.25),
            p.pos[1] + p.size[1] * 0.72,
            p.pos[2] + randRange(-p.size[2] * 0.25, p.size[2] * 0.25)
          ];
          DF.Renderer.spawnParticle({
            type: 'fire',
            pos: fxPos,
            vel: [randRange(-0.4, 0.4), randRange(1.8, 3.6), randRange(-0.4, 0.4)],
            size: p.kind === 'car' ? 0.95 : 0.55,
            sizeEnd: p.kind === 'car' ? 1.85 : 1.05,
            life: randRange(0.32, 0.55),
            color: [1.0, 0.48, 0.10],
            alpha: 0.92,
            gravity: -1.8,
            drag: 1.5,
            additive: false
          });
          DF.Renderer.spawnParticle({
            type: 'smoke',
            pos: [fxPos[0], fxPos[1] + 0.35, fxPos[2]],
            vel: [randRange(-0.6, 0.6) + 0.9, randRange(2.4, 4.2), randRange(-0.5, 0.5)],
            size: p.kind === 'car' ? 1.35 : 0.75,
            sizeEnd: p.kind === 'car' ? 6.2 : 3.4,
            life: randRange(3.2, 5.2),
            color: [0.12, 0.12, 0.13],
            alpha: 0.76,
            gravity: -0.45,
            drag: 0.65,
            rotSpeed: randRange(-0.7, 0.7),
            additive: false
          });
          if (Math.random() < 0.6) {
            DF.Renderer.spawnParticle({
              type: 'spark',
              pos: [fxPos[0], fxPos[1] + 0.2, fxPos[2]],
              vel: [randRange(-1.2, 1.2) + 0.8, randRange(3.0, 5.4), randRange(-1.2, 1.2)],
              size: 0.11,
              sizeEnd: 0.03,
              life: randRange(1.2, 2.2),
              color: [1.0, 0.62, 0.16],
              alpha: 1.0,
              gravity: -0.8,
              drag: 0.35,
              additive: true
            });
          }
        }

        if (p.burnTimer <= 0) {
          collapsePiece(p, [p.pos[0], p.pos[1] + p.size[1] * 0.5, p.pos[2]], [0, 1, 0], true, null);
        }
      }

      // 3. Update smoldering smoke on fresh rubble & burnt car wrecks
      for (let i = 0; i < rubblePiles.length; i++) {
        const rp = rubblePiles[i];
        if (rp.smokeTimer <= 0) continue;
        rp.smokeTimer -= safeDt;
        rp.smokeAccum += safeDt;
        if (canEmit && rp.smokeAccum >= 0.24) {
          rp.smokeAccum = 0;
          const isWreck = rp.texKey === 'burnt_wreck';
          DF.Renderer.spawnParticle({
            type: 'smoke',
            pos: [rp.pos[0] + randRange(-0.5, 0.5), rp.pos[1] + (isWreck ? 0.95 : 0.35), rp.pos[2] + randRange(-0.5, 0.5)],
            vel: [0.65 + randRange(-0.3, 0.3), randRange(1.4, 2.5), randRange(-0.3, 0.3)],
            size: isWreck ? 0.9 : 0.65,
            sizeEnd: isWreck ? 3.6 : 2.1,
            life: isWreck ? 3.4 : 2.0,
            color: isWreck ? [0.14, 0.13, 0.13] : [0.46, 0.44, 0.42],
            alpha: isWreck ? 0.62 : 0.36,
            gravity: -0.45,
            drag: 0.7,
            rotSpeed: randRange(-0.5, 0.5),
            additive: false
          });
        }
      }

      // 4. Update 3D flying debris physics & floor bounces
      for (let i = flyingDebris.length - 1; i >= 0; i--) {
        const d = flyingDebris[i];
        d.life -= safeDt;
        if (d.life <= 0) {
          flyingDebris.splice(i, 1);
          continue;
        }
        d.vel[1] -= 16.5 * safeDt;
        d.pos[0] += d.vel[0] * safeDt;
        d.pos[1] += d.vel[1] * safeDt;
        d.pos[2] += d.vel[2] * safeDt;
        d.rot[0] += d.rotVel[0] * safeDt;
        d.rot[1] += d.rotVel[1] * safeDt;
        d.rot[2] += d.rotVel[2] * safeDt;

        const gy = DF.Physics ? DF.Physics.getGroundY(d.pos[0], d.pos[2], d.pos[1] + 0.3) : 0;
        if (d.pos[1] < gy + 0.08) {
          d.pos[1] = gy + 0.08;
          if (d.bounces < 2 && Math.abs(d.vel[1]) > 1.2) {
            d.vel[1] = -d.vel[1] * 0.35;
            d.vel[0] *= 0.55;
            d.vel[2] *= 0.55;
            d.rotVel[0] *= 0.45;
            d.rotVel[1] *= 0.45;
            d.rotVel[2] *= 0.45;
            d.bounces++;
          } else {
            d.vel[0] *= 0.8;
            d.vel[1] = 0;
            d.vel[2] *= 0.8;
            d.rotVel[0] = 0;
            d.rotVel[1] = 0;
            d.rotVel[2] = 0;
          }
        }
      }

      // 5. Update flash lights
      for (let i = flashLights.length - 1; i >= 0; i--) {
        flashLights[i].life -= safeDt;
        if (flashLights[i].life <= 0) flashLights.splice(i, 1);
      }
    },

    render(renderer, time) {
      if (!renderer || typeof renderer.submitMesh !== 'function') return;
      const t = time || 0;

      // 1. Render intact & damaged destructible pieces
      for (let i = 0; i < pieceList.length; i++) {
        const p = pieceList[i];
        if (p.collapsed) continue;
        const mesh = p.state === 1 ? p.meshDamaged : p.meshIntact;
        if (!mesh) continue;

        const isDamaged = p.state === 1;
        const scorch = p.burning ? 0.38 : (isDamaged ? 0.72 : 1.0);
        const flashBoost = p.hitFlash > 0 ? 0.10 : 0.0;
        const emissive = p.burning
          ? [0.05 + Math.sin(t * 18 + i) * 0.015, 0.012, 0.002]
          : [flashBoost, flashBoost * 0.7, flashBoost * 0.3];

        renderer.submitMesh(
          mesh,
          p.modelMat,
          {
            texKey: p.burning ? 'burnt_wreck' : (isDamaged ? p.damagedTexKey : p.texKey),
            color: [p.color[0] * scorch, p.color[1] * scorch, p.color[2] * scorch],
            roughness: p.burning ? 0.90 : (isDamaged ? Math.min(0.98, p.roughness + 0.12) : p.roughness),
            metalness: p.burning ? 0.28 : p.metalness,
            emissive,
            uvScale: [1, 1],
            alpha: p.alpha,
            thermalHeat: p.burning ? 0.96 : (p.kind === 'car' ? 0.22 : 0.12),
            doubleSided: p.doubleSided
          },
          {
            castShadow: p.material !== 'glass',
            receiveShadow: true,
            viewmodel: false,
            unlit: false
          }
        );

        // Strong warm flickering fire light on burning cars / fuel drums
        if (p.burning && typeof renderer.addDynamicLight === 'function') {
          const flick = 0.78 + 0.24 * Math.sin(t * 19.3 + i * 2.1) + 0.15 * Math.cos(t * 31.7 + i);
          renderer.addDynamicLight(
            [p.pos[0], p.pos[1] + p.size[1] + 0.65, p.pos[2]],
            [1.0, 0.44, 0.10],
            (p.kind === 'car' ? 16.5 : 11.5) * flick,
            p.kind === 'car' ? 21.0 : 15.0
          );
        }
      }

      // 2. Render grounded 3D rubble piles & burnt vehicle wrecks
      for (let i = 0; i < rubblePiles.length; i++) {
        const rp = rubblePiles[i];
        const stillHot = rp.texKey === 'burnt_wreck' && rp.smokeTimer > 0;
        renderer.submitMesh(
          rp.mesh,
          rp.modelMat,
          {
            texKey: rp.texKey,
            color: rp.color,
            roughness: rp.roughness,
            metalness: rp.metalness,
            emissive: stillHot ? [0.04, 0.01, 0.002] : [0, 0, 0],
            uvScale: [1, 1],
            alpha: 1.0,
            thermalHeat: stillHot ? rp.thermalHeat : 0.12,
            doubleSided: false
          },
          { castShadow: true, receiveShadow: true }
        );
        if (stillHot && typeof renderer.addDynamicLight === 'function') {
          const glow = 0.65 + 0.35 * Math.sin(t * 13.5 + i * 1.7);
          renderer.addDynamicLight(
            [rp.pos[0], rp.pos[1] + 1.15, rp.pos[2]],
            [1.0, 0.42, 0.10],
            3.2 * glow,
            9.5
          );
        }
      }

      // 3. Render 3D tumbling debris chunks
      for (let i = 0; i < flyingDebris.length; i++) {
        const d = flyingDebris[i];
        const fadeScale = d.life < 0.8 ? d.scale * (d.life / 0.8) : d.scale;
        makeModelMatrix(
          d.pos[0], d.pos[1], d.pos[2],
          d.rot[0], d.rot[1], d.rot[2],
          fadeScale, fadeScale, fadeScale,
          d.mat
        );
        renderer.submitMesh(
          d.mesh,
          d.mat,
          {
            texKey: d.texKey,
            color: d.color,
            roughness: 0.97,
            metalness: 0.0,
            emissive: [0, 0, 0],
            uvScale: [1, 1],
            alpha: 1.0,
            thermalHeat: 0.15,
            doubleSided: false
          },
          { castShadow: true, receiveShadow: true }
        );
      }

      // 4. Submit transient collapse/detonation flash lights
      if (typeof renderer.addDynamicLight === 'function') {
        for (let i = 0; i < flashLights.length; i++) {
          const fl = flashLights[i];
          const k = clamp(fl.life / Math.max(0.01, fl.maxLife), 0, 1);
          renderer.addDynamicLight(fl.pos, fl.color, fl.intensity * k * k, fl.radius * (0.5 + 0.5 * k));
        }
      }
    }
  };

  DF.Destruction = Destruction;
})();
