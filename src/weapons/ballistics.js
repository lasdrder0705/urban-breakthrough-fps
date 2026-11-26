(() => {
  'use strict';
  const DF = (window.DF = window.DF || {});

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }

  function normalize3(out, v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    out[0] = v[0] / l;
    out[1] = v[1] / l;
    out[2] = v[2] / l;
    return out;
  }

  // Build world orientation matrix pointing -Z along dir
  function matFromPosDirScale(out, pos, dir, sx, sy, sz) {
    let fx = -dir[0], fy = -dir[1], fz = -dir[2];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;

    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(fy) > 0.98) { ux = 0; uy = 0; uz = 1; }

    let rx = uy * fz - uz * fy;
    let ry = uz * fx - ux * fz;
    let rz = ux * fy - uy * fx;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;

    ux = fy * rz - fz * ry;
    uy = fz * rx - fx * rz;
    uz = fx * ry - fy * rx;

    out[0] = rx * sx; out[1] = ry * sx; out[2] = rz * sx; out[3] = 0;
    out[4] = ux * sy; out[5] = uy * sy; out[6] = uz * sy; out[7] = 0;
    out[8] = fx * sz; out[9] = fy * sz; out[10] = fz * sz; out[11] = 0;
    out[12] = pos[0]; out[13] = pos[1]; out[14] = pos[2]; out[15] = 1;
    return out;
  }

  function pointSegmentClosest(outPt, p, a, b) {
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const lenSq = abx * abx + aby * aby + abz * abz;
    let t = 0;
    if (lenSq > 1e-8) {
      t = clamp(((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / lenSq, 0, 1);
    }
    outPt[0] = a[0] + abx * t;
    outPt[1] = a[1] + aby * t;
    outPt[2] = a[2] + abz * t;
    const dx = p[0] - outPt[0], dy = p[1] - outPt[1], dz = p[2] - outPt[2];
    return dx * dx + dy * dy + dz * dz;
  }

  // Material penetration resistance
  const PENETRATION_MAT = {
    glass: { cost: 0.02, dmgMult: 0.96, canPen: true },
    wood: { cost: 0.18, dmgMult: 0.72, canPen: true },
    plaster: { cost: 0.22, dmgMult: 0.70, canPen: true },
    sandbag: { cost: 0.42, dmgMult: 0.56, canPen: true },
    brick: { cost: 0.58, dmgMult: 0.48, canPen: true },
    concrete: { cost: 1.2, dmgMult: 0.35, canPen: false },
    metal: { cost: 1.5, dmgMult: 0.30, canPen: false },
    earth: { cost: 1.5, dmgMult: 0.30, canPen: false }
  };

  // ---------------------------------------------------------------------------
  // State & Pools
  // ---------------------------------------------------------------------------
  const MAX_CASINGS = 64;
  const MAX_PROJECTILES = 160;
  const MAX_GRENADES = 32;

  const state = {
    initialized: false,
    meshes: {},
    mats: {},
    projectiles: [],
    grenades: [],
    casings: [],
    casingCursor: 0,
    shotCounter: 0,
    camPos: [0, 1.7, 0],
    matPool: [],
    matPoolIdx: 0
  };

  function allocMat() {
    if (state.matPoolIdx >= state.matPool.length) {
      state.matPool.push(DF.Mat4.create());
    }
    return state.matPool[state.matPoolIdx++];
  }

  function makeMat(texKey, color, roughness, metalness, extra) {
    const m = {
      texKey: texKey || 'gunmetal',
      color: color || [1, 1, 1],
      roughness: roughness !== undefined ? roughness : 0.4,
      metalness: metalness !== undefined ? metalness : 0.8,
      emissive: [0, 0, 0],
      uvScale: [1, 1],
      alpha: 1.0,
      thermalHeat: 0.25,
      doubleSided: false
    };
    if (extra) for (const k in extra) m[k] = extra[k];
    return m;
  }

  function buildMeshes(gl) {
    const B = DF.MeshGen.Builder;
    const build = (fn) => {
      const b = new B();
      fn(b);
      if (typeof b.computeTangents === 'function') b.computeTangents();
      return b.build(gl);
    };

    // 1) Brass rifle shell casing (5.56/5.45/7.62)
    state.meshes.brass = build((b) => {
      b.addCylinder(0, 0, 0, 0.0055, 0.006, 0.044, 8, { axis: 'z', color: [0.95, 0.78, 0.34] });
      b.addCylinder(0, 0, -0.026, 0.0042, 0.0055, 0.012, 8, { axis: 'z', color: [0.92, 0.72, 0.28] });
    });

    // 2) 12ga red shotgun hull
    state.meshes.shell = build((b) => {
      b.addCylinder(0, 0, -0.006, 0.010, 0.010, 0.046, 10, { axis: 'z', color: [0.88, 0.14, 0.12] });
      b.addCylinder(0, 0, 0.022, 0.0106, 0.0106, 0.016, 10, { axis: 'z', color: [0.94, 0.78, 0.32] });
    });

    // 3) AAA Razor-Thin Tapered Aerodynamic Tracer Core + Soft Additive Glow Envelope
    // Note: MeshGen axis:'z' maps rBot -> -Z (forward nose) and rTop -> +Z (trailing tail)
    state.meshes.tracer = build((b) => {
      b.addCylinder(0, 0, 0, 0.0012, 0.0055, 1.0, 10, {
        axis: 'z',
        color: [1.0, 0.98, 0.92],
        aoBottom: 1.0,
        aoTop: 0.16
      });
    });
    state.meshes.tracerGlow = build((b) => {
      b.addCylinder(0, 0, 0.04, 0.0024, 0.0135, 1.12, 10, {
        axis: 'z',
        color: [1.0, 0.85, 0.55],
        aoBottom: 0.95,
        aoTop: 0.08
      });
    });

    // 4) RPG-7 PG-7VL flying rocket (nose -Z, booster +Z)
    state.meshes.rpg = build((b) => {
      b.addCylinder(0, 0, -0.22, 0.040, 0.018, 0.14, 12, { axis: 'z', color: [0.34, 0.42, 0.26] });
      b.addCylinder(0, 0, -0.09, 0.018, 0.040, 0.10, 12, { axis: 'z', color: [0.32, 0.38, 0.24] });
      b.addCylinder(0, 0, 0.14, 0.016, 0.016, 0.36, 10, { axis: 'z', color: [0.30, 0.34, 0.28] });
      b.addBox(0, 0, 0.31, 0.12, 0.005, 0.065, { color: [0.55, 0.56, 0.58] });
      b.addBox(0, 0, 0.31, 0.005, 0.12, 0.065, { color: [0.55, 0.56, 0.58] });
    });

    // 5) 40mm Grenade / VOG-17 finned bomb
    state.meshes.grenade40 = build((b) => {
      b.addCylinder(0, 0, 0.02, 0.022, 0.022, 0.065, 10, { axis: 'z', color: [0.36, 0.42, 0.28] });
      b.addSphere(0, 0, -0.02, 0.021, 10, 8, { color: [0.92, 0.74, 0.22] });
      b.addBox(0, 0, 0.065, 0.055, 0.005, 0.032, { color: [0.45, 0.48, 0.42] });
      b.addBox(0, 0, 0.065, 0.005, 0.055, 0.032, { color: [0.45, 0.48, 0.42] });
    });

    // 6) ATGM Missile
    state.meshes.atgm = build((b) => {
      b.addCylinder(0, 0, 0, 0.052, 0.052, 0.82, 12, { axis: 'z', color: [0.44, 0.48, 0.38] });
      b.addCylinder(0, 0, -0.47, 0.052, 0.012, 0.15, 12, { axis: 'z', color: [0.36, 0.38, 0.36] });
      b.addBox(0, 0, 0.34, 0.26, 0.009, 0.11, { color: [0.62, 0.64, 0.66] });
      b.addBox(0, 0, 0.34, 0.009, 0.26, 0.11, { color: [0.62, 0.64, 0.66] });
    });

    // 7) Hand Frag Grenade (M67/F-1)
    state.meshes.frag = build((b) => {
      b.addSphere(0, 0, 0, 0.044, 10, 8, { color: [0.32, 0.40, 0.24] });
      b.addCylinder(0, 0.048, 0, 0.016, 0.018, 0.026, 8, { axis: 'y', color: [0.76, 0.74, 0.56] });
      b.addBox(0.026, 0.022, 0, 0.010, 0.056, 0.016, { color: [0.65, 0.68, 0.55] });
    });

    // 8) Tactical Smoke Canister (M18/RDG-2)
    state.meshes.smoke = build((b) => {
      b.addCylinder(0, 0, 0, 0.034, 0.034, 0.135, 12, { axis: 'y', color: [0.46, 0.50, 0.46] });
      b.addCylinder(0, 0.02, 0, 0.0355, 0.0355, 0.024, 12, { axis: 'y', color: [0.85, 0.85, 0.85] });
      b.addCylinder(0, 0.075, 0, 0.015, 0.016, 0.022, 8, { axis: 'y', color: [0.72, 0.72, 0.70] });
    });

    state.mats.brass = makeMat('gunmetal', [1.75, 1.42, 0.52], 0.24, 0.94, { thermalHeat: 0.55 });
    state.mats.shell = makeMat('polymer', [1.35, 1.35, 1.35], 0.45, 0.25, { thermalHeat: 0.45 });
    state.mats.ordnance = makeMat('armor_ru', [1.0, 1.0, 1.0], 0.52, 0.45, { thermalHeat: 0.65 });
    // Ultra-crisp incandescent core + translucent aerodynamic outer halo (smooth gunmetal tex, zero cracked glass!)
    state.mats.tracerUA = makeMat('gunmetal', [1.0, 0.95, 0.80], 0.08, 0.0, { emissive: [7.8, 5.8, 2.6], thermalHeat: 1.0 });
    state.mats.tracerRU = makeMat('gunmetal', [0.76, 1.0, 0.78], 0.08, 0.0, { emissive: [2.4, 7.2, 2.8], thermalHeat: 1.0 });
    state.mats.tracerHeavy = makeMat('gunmetal', [1.0, 0.88, 0.64], 0.08, 0.0, { emissive: [9.0, 5.2, 1.8], thermalHeat: 1.0 });
    state.mats.tracerGlowUA = makeMat('gunmetal', [1.0, 0.68, 0.26], 0.1, 0.0, { emissive: [3.2, 1.5, 0.35], alpha: 0.30, thermalHeat: 1.0 });
    state.mats.tracerGlowRU = makeMat('gunmetal', [0.35, 1.0, 0.45], 0.1, 0.0, { emissive: [0.65, 3.0, 0.82], alpha: 0.28, thermalHeat: 1.0 });
    state.mats.tracerGlowHeavy = makeMat('gunmetal', [1.0, 0.55, 0.18], 0.1, 0.0, { emissive: [4.2, 1.7, 0.32], alpha: 0.36, thermalHeat: 1.0 });
  }

  function init(gl) {
    state.projectiles.length = 0;
    state.grenades.length = 0;
    state.casings.length = 0;
    state.matPool.length = 0;
    for (let i = 0; i < 128; i++) state.matPool.push(DF.Mat4.create());
    state.matPoolIdx = 0;
    state.casingCursor = 0;
    for (let i = 0; i < MAX_CASINGS; i++) {
      state.casings.push({
        active: false,
        type: 'brass',
        pos: [0, 0, 0],
        vel: [0, 0, 0],
        rot: [0, 0, 0],
        rotVel: [0, 0, 0],
        life: 0,
        bounces: 0,
        sleeping: false
      });
    }
    if (gl && DF.MeshGen && DF.MeshGen.Builder) {
      buildMeshes(gl);
    }
    state.initialized = true;
  }

  function clear() {
    state.projectiles.length = 0;
    state.grenades.length = 0;
    for (let i = 0; i < state.casings.length; i++) {
      state.casings[i].active = false;
    }
  }

  // ---------------------------------------------------------------------------
  // VFX & Audio Helpers
  // ---------------------------------------------------------------------------
  function spawnP(cfg) {
    if (DF.Renderer && typeof DF.Renderer.spawnParticle === 'function') {
      DF.Renderer.spawnParticle(cfg);
    }
  }

  function addLight(pos, color, intensity, radius) {
    if (DF.Renderer && typeof DF.Renderer.addDynamicLight === 'function') {
      DF.Renderer.addDynamicLight(pos, color, intensity, radius);
    }
  }

  function spawnDecal(pos, normal, size, type) {
    if (DF.Renderer && typeof DF.Renderer.spawnDecal === 'function') {
      DF.Renderer.spawnDecal(pos, normal || [0, 1, 0], size, type || 'bullet');
    }
  }

  function spawnBallisticImpactDetail(mat, pos, normal, dir, isHeavy, isArmorDeflect) {
    const n = normal || [0, 1, 0];
    const p = [pos[0] + n[0] * 0.04, pos[1] + n[1] * 0.04, pos[2] + n[2] * 0.04];

    // Persistent multi-material bullet-hole / gouge decal atlas ('bullet_concrete'|'bullet_metal'|'bullet_wood'|'bullet_glass')
    if (mat !== 'flesh' && mat !== 'vehicle') {
      let decalType = 'bullet_concrete';
      if (mat === 'metal') decalType = 'bullet_metal';
      else if (mat === 'wood') decalType = 'bullet_wood';
      else if (mat === 'glass') decalType = 'bullet_glass';
      const decalSize = isHeavy ? 0.34 : (mat === 'glass' ? 0.24 : (mat === 'wood' || mat === 'plaster' ? 0.17 : 0.14));
      spawnDecal(pos, n, decalSize, decalType);
    }

    if (isArmorDeflect || mat === 'metal' || mat === 'vehicle') {
      spawnArmorDeflectionSparks(pos, n, dir);
      // Organic contact impact starburst flash
      spawnP({
        type: 'flash',
        pos: p,
        vel: [n[0] * 0.5, n[1] * 0.5, n[2] * 0.5],
        size: isArmorDeflect ? 0.36 : 0.22,
        sizeEnd: isArmorDeflect ? 0.62 : 0.34,
        life: 0.07,
        color: [1.0, 0.82, 0.38],
        alpha: 0.92,
        gravity: 0,
        drag: 2.0,
        additive: true
      });
      // Spawn live glancing armor-ricochet tracer bolt flying off tank glacis!
      if (isArmorDeflect && state.projectiles.length < MAX_PROJECTILES) {
        const dn = dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2];
        const rDir = normalize3([0, 0, 0], [
          dir[0] - 2 * dn * n[0] + (Math.random() - 0.5) * 0.22,
          dir[1] - 2 * dn * n[1] + 0.12 + Math.random() * 0.18,
          dir[2] - 2 * dn * n[2] + (Math.random() - 0.5) * 0.22
        ]);
        const rSpd = 185 + Math.random() * 65;
        state.projectiles.push({
          type: 'ricochet',
          spec: null,
          shooter: null,
          shooterId: null,
          vehicleId: null,
          faction: 'UA',
          isPlayer: false,
          pos: [p[0], p[1], p[2]],
          prevPos: [p[0], p[1], p[2]],
          traveledDist: 0,
          vel: [rDir[0] * rSpd, rDir[1] * rSpd, rDir[2] * rSpd],
          dir: rDir,
          speed: rSpd,
          gravity: 14.0,
          drag: 0.002,
          damage: 0,
          armorPen: 0,
          penDepthLeft: 0,
          penetratedCount: 2,
          explosiveRadius: 0,
          explosiveDamage: 0,
          vehicleDamage: 0,
          suppressionPower: 0,
          guided: false,
          targetPos: null,
          isTracer: true,
          tracerColor: [1.0, 0.68, 0.24],
          age: 0,
          maxLife: 0.22,
          smokeAccum: 0,
          whizzed: true,
          alive: true
        });
      }
      return;
    }

    if (mat === 'glass') {
      spawnImpactVFX('glass', pos, n, dir, false, false);
      return;
    }

    if (mat === 'flesh') return;

    // Velocity-stretched ricochet spark needles + directional conical dust/debris jet on stone/brick/concrete/asphalt/wood
    const dn = dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2];
    const rx = dir[0] - 2 * dn * n[0];
    const ry = dir[1] - 2 * dn * n[1];
    const rz = dir[2] - 2 * dn * n[2];
    const sparkCount = mat === 'concrete' || mat === 'brick' ? (isHeavy ? 8 : 5) : (isHeavy ? 4 : 2);
    for (let i = 0; i < sparkCount; i++) {
      const sp = 6.5 + Math.random() * 9.5;
      spawnP({
        type: 'spark',
        pos: p,
        vel: [
          (rx * 0.55 + n[0] * 0.65) * sp + (Math.random() - 0.5) * 4.5,
          (ry * 0.55 + n[1] * 0.65) * sp + 1.2 + Math.random() * 3.0,
          (rz * 0.55 + n[2] * 0.65) * sp + (Math.random() - 0.5) * 4.5
        ],
        size: 0.055 + Math.random() * 0.035,
        sizeEnd: 0.015,
        life: 0.14 + Math.random() * 0.18,
        color: [1.0, 0.80 + Math.random() * 0.16, 0.32],
        alpha: 0.96,
        gravity: 11.0,
        drag: 1.4,
        additive: true
      });
    }
    // Crisp micro flash + tight directional plaster/masonry jet
    spawnP({
      type: 'flash',
      pos: p,
      vel: [n[0] * 0.6, n[1] * 0.6, n[2] * 0.6],
      size: isHeavy ? 0.24 : 0.14,
      sizeEnd: isHeavy ? 0.36 : 0.20,
      life: 0.048,
      color: [1.0, 0.84, 0.48],
      alpha: 0.76,
      gravity: 0,
      drag: 2.0,
      additive: true
    });
    const dustColor = mat === 'brick' ? [0.64, 0.40, 0.30]
      : (mat === 'wood' ? [0.60, 0.48, 0.32]
      : (mat === 'earth' || mat === 'sandbag' ? [0.48, 0.42, 0.32] : [0.62, 0.60, 0.56]));
    for (let i = 0; i < (isHeavy ? 4 : 2); i++) {
      const spd = 2.0 + Math.random() * 2.8;
      spawnP({
        type: 'dust',
        pos: p,
        vel: [
          n[0] * spd + (Math.random() - 0.5) * 1.4,
          n[1] * spd + 0.5 + Math.random() * 1.0,
          n[2] * spd + (Math.random() - 0.5) * 1.4
        ],
        size: isHeavy ? 0.36 : 0.18,
        sizeEnd: isHeavy ? 1.25 : 0.72,
        life: 0.48 + Math.random() * 0.38,
        color: dustColor,
        alpha: 0.44,
        gravity: 1.2,
        drag: 2.6
      });
    }
  }

  function spawnBackblast(origin, dir) {
    const bx = origin[0] - dir[0] * 0.72;
    const by = origin[1] - dir[1] * 0.72;
    const bz = origin[2] - dir[2] * 0.72;
    addLight([bx, by, bz], [1.0, 0.56, 0.18], 11.0, 9.5);

    // Organic feathered backblast ignition flash
    spawnP({
      type: 'flash',
      pos: [bx, by, bz],
      vel: [-dir[0] * 3.5, -dir[1] * 3.5, -dir[2] * 3.5],
      size: 0.45,
      sizeEnd: 1.15,
      life: 0.14,
      color: [1.0, 0.72, 0.26],
      alpha: 0.88,
      gravity: 0,
      drag: 3.0,
      additive: true
    });
    // Velocity-stretched glowing propellant sparks + soft swirling grey gas cloud
    for (let i = 0; i < 10; i++) {
      const sp = 9.0 + Math.random() * 11.0;
      spawnP({
        type: 'spark',
        pos: [bx, by, bz],
        vel: [
          -dir[0] * sp + (Math.random() - 0.5) * 4.5,
          -dir[1] * sp + (Math.random() - 0.35) * 3.2,
          -dir[2] * sp + (Math.random() - 0.5) * 4.5
        ],
        size: 0.055 + Math.random() * 0.03,
        sizeEnd: 0.015,
        life: 0.22 + Math.random() * 0.22,
        color: [1.0, 0.74 + Math.random() * 0.18, 0.24],
        alpha: 0.96,
        gravity: 9.0,
        drag: 1.8,
        additive: true
      });
    }
    for (let i = 0; i < 9; i++) {
      const sp = 5.0 + Math.random() * 8.0;
      spawnP({
        type: 'smoke',
        pos: [bx, by, bz],
        vel: [
          -dir[0] * sp + (Math.random() - 0.5) * 4.2,
          -dir[1] * sp + (Math.random() - 0.25) * 2.8,
          -dir[2] * sp + (Math.random() - 0.5) * 4.2
        ],
        size: 0.42,
        sizeEnd: 2.15,
        life: 1.35 + Math.random() * 0.45,
        color: [0.58, 0.56, 0.52],
        alpha: 0.40,
        gravity: -0.5,
        drag: 2.9
      });
    }
  }

  function spawnArmorDeflectionSparks(pos, normal, dir) {
    const n = normal || [0, 1, 0];
    const p = [pos[0] + n[0] * 0.05, pos[1] + n[1] * 0.05, pos[2] + n[2] * 0.05];
    const dn = dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2];
    const rx = dir[0] - 2 * dn * n[0];
    const ry = dir[1] - 2 * dn * n[1];
    const rz = dir[2] - 2 * dn * n[2];
    addLight(p, [1.0, 0.74, 0.30], 7.0, 5.5);

    for (let i = 0; i < 16; i++) {
      const sp = 7.5 + Math.random() * 8.5;
      spawnP({
        type: 'spark',
        pos: p,
        vel: [
          rx * sp + n[0] * 2.2 + (Math.random() - 0.5) * 4.2,
          ry * sp + n[1] * 2.2 + Math.random() * 3.8,
          rz * sp + n[2] * 2.2 + (Math.random() - 0.5) * 4.2
        ],
        size: 0.09 + Math.random() * 0.07,
        sizeEnd: 0.02,
        life: 0.24 + Math.random() * 0.28,
        color: [1.0, 0.80 + Math.random() * 0.18, 0.26],
        alpha: 1.0,
        gravity: 11.5,
        drag: 1.1,
        additive: true
      });
    }
  }

  function spawnImpactVFX(material, pos, normal, dir, isHeavy, playAudio) {
    const n = normal || [0, 1, 0];
    const p = [pos[0] + n[0] * 0.04, pos[1] + n[1] * 0.04, pos[2] + n[2] * 0.04];

    if (playAudio && DF.Audio && typeof DF.Audio.playImpact === 'function') {
      DF.Audio.playImpact(material || 'concrete', pos);
    }

    if (material === 'glass') {
      for (let i = 0; i < 10; i++) {
        spawnP({
          type: 'debris',
          pos: p,
          vel: [
            dir[0] * 3.0 + (Math.random() - 0.5) * 3.2,
            Math.random() * 2.2,
            dir[2] * 3.0 + (Math.random() - 0.5) * 3.2
          ],
          size: 0.07 + Math.random() * 0.05,
          sizeEnd: 0.03,
          life: 0.5 + Math.random() * 0.3,
          color: [0.78, 0.88, 0.94],
          alpha: 0.85,
          gravity: 11.0,
          drag: 0.6
        });
      }
      return;
    }

    if (material === 'flesh') {
      for (let i = 0; i < 6; i++) {
        spawnP({
          type: 'blood',
          pos: p,
          vel: [
            n[0] * (1.2 + Math.random() * 2.2) + (Math.random() - 0.5) * 1.8,
            n[1] * (1.0 + Math.random() * 1.8) + 0.6,
            n[2] * (1.2 + Math.random() * 2.2) + (Math.random() - 0.5) * 1.8
          ],
          size: 0.16 + Math.random() * 0.12,
          sizeEnd: 0.55,
          life: 0.35 + Math.random() * 0.2,
          color: [0.46, 0.04, 0.03],
          alpha: 0.78,
          gravity: 6.5,
          drag: 2.4
        });
      }
      return;
    }

    if (material === 'metal' || material === 'vehicle') {
      spawnArmorDeflectionSparks(pos, normal, dir);
      return;
    }

    let dustColor = [0.64, 0.62, 0.58];
    let chipColor = [0.46, 0.44, 0.42];
    if (material === 'brick') {
      dustColor = [0.66, 0.42, 0.32];
      chipColor = [0.54, 0.26, 0.18];
    } else if (material === 'wood') {
      dustColor = [0.64, 0.52, 0.36];
      chipColor = [0.52, 0.36, 0.20];
    } else if (material === 'earth' || material === 'sandbag') {
      dustColor = [0.52, 0.46, 0.36];
      chipColor = [0.36, 0.30, 0.22];
    }

    const dustN = isHeavy ? 6 : 3;
    for (let i = 0; i < dustN; i++) {
      spawnP({
        type: 'dust',
        pos: p,
        vel: [
          n[0] * (1.2 + Math.random() * 1.8) + (Math.random() - 0.5) * 1.4,
          n[1] * (1.2 + Math.random() * 1.8) + 0.8,
          n[2] * (1.2 + Math.random() * 1.8) + (Math.random() - 0.5) * 1.4
        ],
        size: isHeavy ? 0.45 : 0.24,
        sizeEnd: isHeavy ? 1.65 : 0.88,
        life: 0.55 + Math.random() * 0.45,
        color: dustColor,
        alpha: 0.62,
        gravity: 0.8,
        drag: 2.2
      });
    }
    for (let i = 0; i < (isHeavy ? 6 : 3); i++) {
      spawnP({
        type: 'debris',
        pos: p,
        vel: [
          n[0] * (2.5 + Math.random() * 4.0) + (Math.random() - 0.5) * 3.0,
          n[1] * (2.5 + Math.random() * 3.5) + 1.5,
          n[2] * (2.5 + Math.random() * 4.0) + (Math.random() - 0.5) * 3.0
        ],
        size: 0.06 + Math.random() * 0.06,
        sizeEnd: 0.04,
        life: 0.5 + Math.random() * 0.4,
        color: chipColor,
        alpha: 0.95,
        gravity: 13.5,
        drag: 0.5
      });
    }
  }

  function spawnExplosionVFX(pos, radius) {
    const scale = clamp(radius / 7.5, 0.5, 1.8);
    addLight([pos[0], pos[1] + 0.6, pos[2]], [1.0, 0.56, 0.18], 22.0 * scale, radius * 2.6);

    if (DF.Audio && typeof DF.Audio.playExplosion === 'function') {
      DF.Audio.playExplosion(pos, scale);
    }

    spawnP({
      type: 'shockwave',
      pos: [pos[0], pos[1] + 0.25, pos[2]],
      vel: [0, 0.1, 0],
      size: 0.6 * scale,
      sizeEnd: radius * 1.45,
      life: 0.34,
      color: [1.0, 0.85, 0.62],
      alpha: 0.72,
      gravity: 0,
      drag: 0,
      additive: true
    });

    const fireCount = Math.round(8 * scale);
    for (let i = 0; i < fireCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = (1.5 + Math.random() * 4.5) * scale;
      spawnP({
        type: 'fire',
        pos: [pos[0] + (Math.random() - 0.5) * 0.6, pos[1] + 0.3, pos[2] + (Math.random() - 0.5) * 0.6],
        vel: [Math.cos(a) * spd, (2.2 + Math.random() * 4.8) * scale, Math.sin(a) * spd],
        size: (0.72 + Math.random() * 0.5) * scale,
        sizeEnd: (2.0 + Math.random() * 0.9) * scale,
        life: 0.35 + Math.random() * 0.32,
        color: [1.0, 0.42 + Math.random() * 0.25, 0.08],
        alpha: 0.88,
        gravity: -2.0,
        drag: 2.3,
        additive: false
      });
    }

    const smokeCount = Math.round(10 * scale);
    for (let i = 0; i < smokeCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = (1.0 + Math.random() * 3.8) * scale;
      spawnP({
        type: 'smoke',
        pos: [pos[0] + (Math.random() - 0.5) * 1.2 * scale, pos[1] + 0.4, pos[2] + (Math.random() - 0.5) * 1.2 * scale],
        vel: [Math.cos(a) * spd, (2.8 + Math.random() * 4.2) * scale, Math.sin(a) * spd],
        size: (0.85 + Math.random() * 0.6) * scale,
        sizeEnd: (3.6 + Math.random() * 1.8) * scale,
        life: 2.2 + Math.random() * 1.8,
        color: [0.16, 0.15, 0.15],
        alpha: 0.44,
        gravity: -0.8,
        drag: 1.5
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Damage & Explosion Dispatchers (aligned 100% with DF.Game.applyBulletHit/applyExplosion)
  // ---------------------------------------------------------------------------
  function dispatchExplosion(pos, radius, damage, vehicleDamage, armorPen, shooter, weaponId, weaponName, isPlayer, hitNormal) {
    // Persistent dark blast scorch crater decal on walls / asphalt
    spawnDecal(pos, hitNormal || [0, 1, 0], clamp((radius || 6) * 0.52, 1.8, 4.8), 'scorch');

    // Rich Multi-Layered Battlefield Explosion VFX:
    // 1) Blinding brief incandescent core flash + dynamic firelight
    const scale = clamp((radius || 7) / 7.5, 0.55, 1.8);
    addLight([pos[0], pos[1] + 0.8, pos[2]], [1.0, 0.62, 0.22], 24.0 * scale, (radius || 7) * 2.8);
    spawnP({
      type: 'flash',
      pos: [pos[0], pos[1] + 0.45, pos[2]],
      vel: [0, 0.3, 0],
      size: 1.15 * scale,
      sizeEnd: 2.85 * scale,
      life: 0.14,
      color: [1.0, 0.88, 0.54],
      alpha: 0.95,
      gravity: 0,
      drag: 1.5,
      additive: true
    });

    // 2) Expanding pressure shockwave ring + 8 low ground-hugging radial dust jets
    spawnP({
      type: 'shockwave',
      pos: [pos[0], pos[1] + 0.22, pos[2]],
      vel: [0, 0.08, 0],
      size: 0.65 * scale,
      sizeEnd: (radius || 7) * 1.45,
      life: 0.32,
      color: [1.0, 0.86, 0.64],
      alpha: 0.62,
      gravity: 0,
      drag: 0,
      additive: true
    });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
      const spd = (6.5 + Math.random() * 6.5) * scale;
      spawnP({
        type: 'dust',
        pos: [pos[0] + Math.cos(a) * 0.6 * scale, pos[1] + 0.18, pos[2] + Math.sin(a) * 0.6 * scale],
        vel: [Math.cos(a) * spd, (0.5 + Math.random() * 1.2) * scale, Math.sin(a) * spd],
        size: 0.65 * scale,
        sizeEnd: 2.6 * scale,
        life: 1.1 + Math.random() * 0.7,
        color: [0.48, 0.44, 0.38],
        alpha: 0.42,
        gravity: 0.35,
        drag: 2.4
      });
    }

    // 3) Turbulent soot-backed rolling fireball lobes + dense ascending dark oily smoke plume
    for (let i = 0; i < Math.round(6 * scale); i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = (1.2 + Math.random() * 3.6) * scale;
      spawnP({
        type: 'fire',
        pos: [pos[0] + (Math.random() - 0.5) * 0.8 * scale, pos[1] + 0.35, pos[2] + (Math.random() - 0.5) * 0.8 * scale],
        vel: [Math.cos(a) * spd, (2.6 + Math.random() * 5.2) * scale, Math.sin(a) * spd],
        size: (0.72 + Math.random() * 0.45) * scale,
        sizeEnd: (1.95 + Math.random() * 0.85) * scale,
        life: 0.36 + Math.random() * 0.32,
        color: [1.0, 0.42 + Math.random() * 0.24, 0.08],
        alpha: 0.88,
        gravity: -2.0,
        drag: 2.3,
        additive: false
      });
    }
    for (let i = 0; i < Math.round(8 * scale); i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = (0.8 + Math.random() * 3.0) * scale;
      spawnP({
        type: 'smoke',
        pos: [pos[0] + (Math.random() - 0.5) * 1.1 * scale, pos[1] + 0.5, pos[2] + (Math.random() - 0.5) * 1.1 * scale],
        vel: [Math.cos(a) * spd + 0.4, (3.2 + Math.random() * 4.5) * scale, Math.sin(a) * spd],
        size: (0.85 + Math.random() * 0.55) * scale,
        sizeEnd: (3.8 + Math.random() * 1.8) * scale,
        life: 2.4 + Math.random() * 1.8,
        color: [0.16, 0.15, 0.15],
        alpha: 0.44,
        gravity: -0.75,
        drag: 1.5
      });
    }

    // 4) 28 velocity-stretched incandescent steel sparks/embers + 12 tumbling masonry debris chunks!
    const sparkN = Math.round(28 * clamp(scale, 0.75, 1.35));
    for (let i = 0; i < sparkN; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = (10.0 + Math.random() * 14.5) * scale;
      spawnP({
        type: 'spark',
        pos: [pos[0] + (Math.random() - 0.5) * 0.3, pos[1] + 0.35, pos[2] + (Math.random() - 0.5) * 0.3],
        vel: [Math.cos(a) * spd, (5.5 + Math.random() * 11.5) * scale, Math.sin(a) * spd],
        size: 0.055 + Math.random() * 0.04,
        sizeEnd: 0.015,
        life: 0.45 + Math.random() * 0.68,
        color: [1.0, 0.68 + Math.random() * 0.28, 0.18 + Math.random() * 0.12],
        alpha: 0.98,
        gravity: 13.5,
        drag: 0.85,
        additive: true
      });
    }
    const debrisN = Math.round(12 * clamp(scale, 0.75, 1.35));
    for (let i = 0; i < debrisN; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = (4.5 + Math.random() * 9.5) * scale;
      spawnP({
        type: 'debris',
        pos: [pos[0], pos[1] + 0.35, pos[2]],
        vel: [Math.cos(a) * spd, (5.0 + Math.random() * 9.5) * scale, Math.sin(a) * spd],
        size: 0.07 + Math.random() * 0.08,
        sizeEnd: 0.05,
        life: 0.75 + Math.random() * 0.65,
        color: [0.28, 0.25, 0.22],
        alpha: 0.94,
        gravity: 16.0,
        drag: 0.45
      });
    }

    if (DF.Game && typeof DF.Game.applyExplosion === 'function') {
      DF.Game.applyExplosion({
        pos: [pos[0], pos[1], pos[2]],
        radius,
        damage,
        vehicleDamage: vehicleDamage || damage,
        armorPen: armorPen !== undefined ? armorPen : 0.85,
        isAntiArmor: (armorPen || 0) >= 0.7,
        attacker: shooter || null,
        shooter: shooter || null,
        faction: shooter && shooter.faction ? shooter.faction : null,
        weaponId: weaponName || weaponId || 'EXPLOSIVE',
        weaponName: weaponName || weaponId || 'EXPLOSIVE',
        isPlayer: !!isPlayer,
        vfxSpawned: true,
        decalSpawned: true
      });
      return;
    }

    // Fallback when running standalone without DF.Game
    spawnExplosionVFX(pos, radius);
    if (DF.Destruction && typeof DF.Destruction.applyBlast === 'function') {
      DF.Destruction.applyBlast(pos, radius, damage * 1.4);
    }
    if (DF.AI && typeof DF.AI.getSoldiers === 'function' && typeof DF.AI.damageSoldier === 'function') {
      const soldiers = DF.AI.getSoldiers();
      for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i];
        if (!s || s.state === 'dead') continue;
        const d = Math.hypot(s.pos[0] - pos[0], s.pos[1] + 0.9 - pos[1], s.pos[2] - pos[2]);
        if (d < radius) {
          const falloff = 1 - (d / radius) * 0.85;
          DF.AI.damageSoldier(s, damage * falloff, 'torso', shooter, weaponId);
        }
      }
    }
    if (DF.Armor && typeof DF.Armor.getVehicles === 'function' && typeof DF.Armor.damageVehicle === 'function') {
      const vehs = DF.Armor.getVehicles();
      for (let i = 0; i < vehs.length; i++) {
        const v = vehs[i];
        if (!v || v.destroyed) continue;
        const d = Math.hypot(v.pos[0] - pos[0], v.pos[1] + 1.2 - pos[1], v.pos[2] - pos[2]);
        if (d < radius + 2.8) {
          const falloff = clamp(1 - Math.max(0, d - 1.5) / (radius + 2.0), 0.2, 1.0);
          const hitZone = pos[1] > v.pos[1] + 2.3 ? 'top' : 'side';
          DF.Armor.damageVehicle(v, (vehicleDamage || damage) * falloff, hitZone, shooter, pos, true);
        }
      }
    }
  }

  function dispatchBulletHit(p, hit, dmg) {
    if (DF.Game && typeof DF.Game.applyBulletHit === 'function') {
      DF.Game.applyBulletHit({
        attacker: p.shooter || null,
        shooter: p.shooter || null,
        faction: p.faction,
        hit,
        weaponSpec: p.spec,
        weaponId: p.spec ? (p.spec.displayName || p.spec.name || p.spec.id) : 'RIFLE',
        weaponName: p.spec ? (p.spec.displayName || p.spec.name) : 'Rifle',
        damage: dmg,
        vehicleDamage: p.spec ? (p.spec.vehicleDamage || dmg * 0.35) : dmg * 0.35,
        armorPen: p.armorPen,
        isExplosive: p.explosiveRadius > 0,
        dir: p.dir,
        point: hit.point,
        normal: hit.normal,
        material: hit.material,
        hitZone: hit.hitZone || 'torso',
        entity: hit.entity || null,
        vehicle: hit.vehicle || null,
        unmanned: hit.unmanned || null,
        collider: hit.collider || null,
        isPenetrated: p.penetratedCount > 0,
        isPlayer: p.isPlayer
      });
      return;
    }

    // Fallback when running without DF.Game
    const mat = hit.entity ? 'flesh' : (hit.vehicle || hit.unmanned ? 'metal' : (hit.material || 'concrete'));
    spawnImpactVFX(mat, hit.point, hit.normal, p.dir, p.explosiveRadius > 0, true);
    if (hit.entity && DF.AI && typeof DF.AI.damageSoldier === 'function') {
      const mult = hit.hitZone === 'head' ? (p.spec ? (p.spec.headMult || 2.2) : 2.2) : (hit.hitZone === 'limb' ? 0.75 : 1.0);
      DF.AI.damageSoldier(hit.entity, dmg * mult, hit.hitZone || 'torso', p.shooter, p.spec ? p.spec.id : 'bullet');
    }
    if (hit.vehicle && DF.Armor && typeof DF.Armor.damageVehicle === 'function') {
      const vDmg = p.spec ? (p.spec.vehicleDamage || dmg * 0.35) : dmg * 0.35;
      DF.Armor.damageVehicle(hit.vehicle, vDmg, hit.hitZone || 'side', p.shooter, hit.point, p.explosiveRadius > 0);
    }
    if (hit.unmanned && DF.Unmanned && typeof DF.Unmanned.damageUnit === 'function') {
      DF.Unmanned.damageUnit(hit.unmanned, dmg, p.shooter);
    }
    if (hit.collider && hit.collider.meta && hit.collider.meta.destructibleId && DF.Destruction && typeof DF.Destruction.damagePiece === 'function') {
      DF.Destruction.damagePiece(hit.collider.meta.destructibleId, dmg, hit.point, p.dir, false);
    }
  }

  // ---------------------------------------------------------------------------
  // Infer projectile type cleanly for both catalog specs & custom vehicle/drone specs
  // ---------------------------------------------------------------------------
  function inferProjectileType(spec) {
    if (spec.projectileType) return spec.projectileType;
    if (spec.isATGM || spec.guided) return 'atgm';
    const ap = String(spec.audioProfile || '').toLowerCase();
    const id = String(spec.id || spec.name || '').toLowerCase();
    if (ap === 'tank_125' || id.includes('125')) return 'tank125';
    if (ap === 'autocannon' || id.includes('25mm') || id.includes('30mm')) return 'autocannon';
    if (ap === 'rpg' || id.includes('rpg')) return 'rpg';
    if (id.includes('vog') && (spec.muzzleVel || 0) < 25) return 'vog_bomb';
    if (ap === 'gl' || id.includes('40mm') || id.includes('m320')) return 'grenade40';
    if ((spec.pelletCount || 1) > 1) return 'pellet';
    return 'bullet';
  }

  // ---------------------------------------------------------------------------
  // Public Fire / Throw / Casing APIs
  // ---------------------------------------------------------------------------
  function fireWeapon(shooter, weaponSpec, origin, dir, isPlayer, extraOpts) {
    const spec = (typeof weaponSpec === 'object' && weaponSpec)
      ? weaponSpec
      : (DF.WeaponCatalog ? DF.WeaponCatalog.get(weaponSpec, shooter && shooter.faction) : null);
    if (!spec || !origin || !dir) return;

    const baseDir = normalize3([0, 0, 0], dir);
    const faction = (shooter && shooter.faction) || spec.faction || 'UA';
    const pellets = Math.max(1, spec.pelletCount || 1);
    const pType = inferProjectileType(spec);

    // Armored vehicles & unmanned units rely on Ballistics.fireWeapon for gunshot audio
    const ap = String(spec.audioProfile || '').toLowerCase();
    const isVehicleOrUnmannedShot = !!(
      (shooter && shooter.vehicleId) ||
      spec.isATGM ||
      ap === 'tank_125' ||
      ap === 'autocannon' ||
      ap === 'coax' ||
      ap === 'dog_rws'
    );
    if (isVehicleOrUnmannedShot && DF.Audio && typeof DF.Audio.playGunshot === 'function') {
      DF.Audio.playGunshot(spec.audioProfile || 'coax', origin, !!isPlayer);
    }

    // Spread: single-bullet infantry shots already had spread applied by caller (main.js/tactics.js),
    // while multi-pellet shotguns always apply full buckshot cone spread here!
    const spread = extraOpts && typeof extraOpts.spread === 'number'
      ? extraOpts.spread
      : (pellets > 1 ? (spec.spreadHip || 0.068) : 0.0008);

    if (spec.backblast || pType === 'rpg') {
      spawnBackblast(origin, baseDir);
    }

    // Orthonormal basis for spread
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(baseDir[1]) > 0.96) { ux = 1; uy = 0; uz = 0; }
    let rx = uy * baseDir[2] - uz * baseDir[1];
    let ry = uz * baseDir[0] - ux * baseDir[2];
    let rz = ux * baseDir[1] - uy * baseDir[0];
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const tx = baseDir[1] * rz - baseDir[2] * ry;
    const ty = baseDir[2] * rx - baseDir[0] * rz;
    const tz = baseDir[0] * ry - baseDir[1] * rx;

    state.shotCounter++;
    const interval = spec.tracerInterval !== undefined ? spec.tracerInterval : 3;
    const isTracer = (interval > 0 && (state.shotCounter % interval === 0)) || pType !== 'bullet';

    for (let i = 0; i < pellets; i++) {
      const rRad = spread * Math.sqrt(Math.random());
      const theta = Math.random() * Math.PI * 2;
      const sx = Math.cos(theta) * rRad;
      const sy = Math.sin(theta) * rRad;
      const d = normalize3([0, 0, 0], [
        baseDir[0] + rx * sx + tx * sy,
        baseDir[1] + ry * sx + ty * sy,
        baseDir[2] + rz * sx + tz * sy
      ]);

      const speed = spec.muzzleVel || (pType === 'atgm' ? 92 : (pType === 'tank125' ? 280 : 750));
      const proj = {
        type: pType,
        spec,
        shooter: shooter || null,
        shooterId: shooter && shooter.id !== undefined ? shooter.id : null,
        vehicleId: shooter && (shooter.vehicleId || shooter.inVehicleId) ? (shooter.vehicleId || shooter.inVehicleId) : null,
        faction,
        isPlayer: !!isPlayer,
        pos: [origin[0], origin[1], origin[2]],
        prevPos: [origin[0], origin[1], origin[2]],
        traveledDist: 0,
        vel: [d[0] * speed, d[1] * speed, d[2] * speed],
        dir: [d[0], d[1], d[2]],
        speed,
        gravity: spec.gravity !== undefined ? spec.gravity : (pType === 'atgm' ? 0.0 : 9.8),
        drag: spec.drag !== undefined ? spec.drag : 0.0005,
        damage: spec.damage || 30,
        armorPen: spec.armorPen !== undefined ? spec.armorPen : (pType === 'atgm' || pType === 'tank125' ? 1.0 : 0.25),
        penDepthLeft: spec.penetrationDepth || 0,
        penetratedCount: 0,
        explosiveRadius: spec.explosiveRadius || (pType === 'atgm' ? 8.0 : (pType === 'tank125' ? 10.0 : 0)),
        explosiveDamage: spec.explosiveDamage || spec.damage || 120,
        vehicleDamage: spec.vehicleDamage || spec.damage || 30,
        suppressionPower: spec.suppressionPower || 0.2,
        guided: !!(spec.guided || spec.isATGM || pType === 'atgm'),
        targetPos: extraOpts && extraOpts.targetPos ? extraOpts.targetPos.slice() : null,
        isTracer,
        tracerColor: spec.tracerColor || (faction === 'RU' ? [0.46, 1.0, 0.42] : [1.0, 0.74, 0.34]),
        age: 0,
        maxLife: pType === 'pellet' ? 0.55 : (pType === 'rpg' || pType === 'atgm' ? 6.5 : 3.5),
        smokeAccum: 0,
        whizzed: false,
        alive: true
      };

      if (state.projectiles.length >= MAX_PROJECTILES) {
        state.projectiles.shift();
      }
      state.projectiles.push(proj);
    }
  }

  function throwGrenade(shooter, type, origin, dir) {
    if (!origin || !dir) return;
    const d = normalize3([0, 0, 0], dir);
    const speed = type === 'smoke' ? 18.5 : 21.0;
    const g = {
      type: type === 'smoke' ? 'smoke' : 'frag',
      shooter: shooter || null,
      faction: (shooter && shooter.faction) || 'UA',
      isPlayer: !!(shooter && shooter.isPlayer),
      pos: [origin[0] + d[0] * 0.45, origin[1] + d[1] * 0.45, origin[2] + d[2] * 0.45],
      vel: [d[0] * speed, d[1] * speed + 3.4, d[2] * speed],
      rot: [Math.random() * 6, Math.random() * 6, Math.random() * 6],
      rotVel: [8 + Math.random() * 6, 4 + Math.random() * 6, 7 + Math.random() * 6],
      fuse: type === 'smoke' ? 1.15 : 3.1,
      activeSmoke: false,
      smokeDuration: 15.0,
      smokeEmitAccum: 0,
      bounces: 0,
      alive: true
    };
    if (state.grenades.length >= MAX_GRENADES) {
      state.grenades.shift();
    }
    state.grenades.push(g);
  }

  function spawnCasing(pos, vel, rotVel, type) {
    if (!state.casings.length) return;
    const c = state.casings[state.casingCursor];
    state.casingCursor = (state.casingCursor + 1) % MAX_CASINGS;
    c.active = true;
    c.type = type === 'shell' ? 'shell' : 'brass';
    c.pos[0] = pos[0]; c.pos[1] = pos[1]; c.pos[2] = pos[2];
    c.vel[0] = vel[0]; c.vel[1] = vel[1]; c.vel[2] = vel[2];
    c.rot[0] = Math.random() * 6.28; c.rot[1] = Math.random() * 6.28; c.rot[2] = Math.random() * 6.28;
    c.rotVel[0] = rotVel ? rotVel[0] : 14;
    c.rotVel[1] = rotVel ? rotVel[1] : 10;
    c.rotVel[2] = rotVel ? rotVel[2] : 18;
    c.life = 5.5;
    c.bounces = 0;
    c.sleeping = false;
  }

  // ---------------------------------------------------------------------------
  // Simulation Loop: Projectiles, Unmanned Hit Check, Wall Penetration, ATGM, Grenades, Casings
  // ---------------------------------------------------------------------------
  const tmpClosePt = [0, 0, 0];

  function checkUnmannedHit(p, segEnd, maxDist) {
    if (!DF.Unmanned || typeof DF.Unmanned.getUnits !== 'function') return null;
    const units = DF.Unmanned.getUnits();
    if (!units || !units.length) return null;

    let best = null;
    let bestDist = maxDist;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u || u.destroyed || u.hp <= 0 || !u.pos) continue;
      if (u.id === p.shooterId) continue;
      if (p.age < 0.08 && u.faction === p.faction) continue;
      const rad = u.type === 'dog' ? 0.62 : 0.45;
      const center = [u.pos[0], u.pos[1] + (u.type === 'dog' ? 0.45 : 0.0), u.pos[2]];
      const dSq = pointSegmentClosest(tmpClosePt, center, p.pos, segEnd);
      if (dSq <= rad * rad) {
        const dist = Math.hypot(tmpClosePt[0] - p.pos[0], tmpClosePt[1] - p.pos[1], tmpClosePt[2] - p.pos[2]);
        if (dist < bestDist) {
          bestDist = dist;
          best = {
            dist,
            point: [tmpClosePt[0], tmpClosePt[1], tmpClosePt[2]],
            normal: [-p.dir[0], -p.dir[1], -p.dir[2]],
            material: 'metal',
            collider: null,
            entity: null,
            vehicle: null,
            unmanned: u,
            hitZone: 'torso'
          };
        }
      }
    }
    return best;
  }

  function checkNearMissSuppression(p) {
    if (!p.isPlayer && !p.whizzed && p.type === 'bullet') {
      const distSq = pointSegmentClosest(tmpClosePt, state.camPos, p.prevPos, p.pos);
      if (distSq < 16.0) {
        p.whizzed = true;
        if (DF.Audio && typeof DF.Audio.playBulletWhiz === 'function') {
          DF.Audio.playBulletWhiz(tmpClosePt);
        }
        if (DF.Events && typeof DF.Events.emit === 'function') {
          DF.Events.emit('combat:suppression', {
            amount: p.suppressionPower * (1 - Math.sqrt(distSq) / 4.2),
            pos: [tmpClosePt[0], tmpClosePt[1], tmpClosePt[2]],
            faction: p.faction
          });
        }
      }
    }

    if (DF.AI && typeof DF.AI.getSoldiers === 'function') {
      const soldiers = DF.AI.getSoldiers();
      for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i];
        if (!s || s.state !== 'alive' || s.faction === p.faction) continue;
        const dx = s.pos[0] - p.pos[0];
        const dz = s.pos[2] - p.pos[2];
        if (dx * dx + dz * dz > 36) continue;
        const head = [s.pos[0], s.pos[1] + 1.1, s.pos[2]];
        const dSq = pointSegmentClosest(tmpClosePt, head, p.prevPos, p.pos);
        if (dSq < 10.24) {
          s.suppression = clamp((s.suppression || 0) + p.suppressionPower * 0.45, 0, 1);
        }
      }
    }
  }

  function resolveATGMGuidanceTarget(p) {
    // Wire-guide toward launching vehicle's live turret sight ray!
    if (p.vehicleId && DF.Armor && typeof DF.Armor.getVehicles === 'function') {
      const vehs = DF.Armor.getVehicles();
      for (let i = 0; i < vehs.length; i++) {
        const v = vehs[i];
        if (v && v.id === p.vehicleId && v.alive && v.muzzleWorldDir && v.muzzleWorldPos) {
          return [
            v.muzzleWorldPos[0] + v.muzzleWorldDir[0] * 145,
            v.muzzleWorldPos[1] + v.muzzleWorldDir[1] * 145,
            v.muzzleWorldPos[2] + v.muzzleWorldDir[2] * 145
          ];
        }
      }
    }
    if (p.shooter && p.shooter.aimDir) {
      const ao = p.shooter.aimOrigin || p.shooter.pos || p.pos;
      return [ao[0] + p.shooter.aimDir[0] * 140, ao[1] + p.shooter.aimDir[1] * 140, ao[2] + p.shooter.aimDir[2] * 140];
    }
    return p.targetPos;
  }

  function updateProjectiles(dt) {
    const hasPhysics = DF.Physics && typeof DF.Physics.raycast === 'function';

    for (let i = state.projectiles.length - 1; i >= 0; i--) {
      const p = state.projectiles[i];
      p.age += dt;
      if (!p.alive || p.age >= p.maxLife) {
        state.projectiles.splice(i, 1);
        continue;
      }

      p.prevPos[0] = p.pos[0];
      p.prevPos[1] = p.pos[1];
      p.prevPos[2] = p.pos[2];

      if (p.type === 'rpg') {
        if (p.age < 0.35) {
          const boost = 145 * dt;
          p.vel[0] += p.dir[0] * boost;
          p.vel[1] += p.dir[1] * boost;
          p.vel[2] += p.dir[2] * boost;
        }
        addLight(p.pos, [1.0, 0.54, 0.16], 10.5, 13.0);
        p.smokeAccum += dt;
        while (p.smokeAccum >= 0.012) {
          p.smokeAccum -= 0.012;
          const tailPos = [p.pos[0] - p.dir[0] * 0.36, p.pos[1] - p.dir[1] * 0.36, p.pos[2] - p.dir[2] * 0.36];
          const spiral = p.age * 28.0;
          spawnP({
            type: 'smoke',
            pos: tailPos,
            vel: [Math.cos(spiral) * 0.75 + (Math.random() - 0.5) * 0.4, 0.45 + Math.sin(spiral) * 0.5, Math.sin(spiral) * 0.75],
            size: 0.18,
            sizeEnd: 1.35,
            life: 1.75,
            color: [0.74, 0.72, 0.68],
            alpha: 0.36,
            gravity: -0.30,
            drag: 1.4
          });
          spawnP({
            type: 'flash',
            pos: [p.pos[0] - p.dir[0] * 0.28, p.pos[1] - p.dir[1] * 0.28, p.pos[2] - p.dir[2] * 0.28],
            vel: [-p.dir[0] * 6.5, -p.dir[1] * 6.5, -p.dir[2] * 6.5],
            size: 0.28,
            sizeEnd: 0.06,
            life: 0.065,
            color: [1.0, 0.74, 0.26],
            alpha: 0.92,
            gravity: 0,
            drag: 1.5,
            additive: true
          });
          if (Math.random() < 0.45) {
            spawnP({
              type: 'spark',
              pos: tailPos,
              vel: [-p.dir[0] * 14 + (Math.random() - 0.5) * 3, -p.dir[1] * 14 + (Math.random() - 0.5) * 3, -p.dir[2] * 14 + (Math.random() - 0.5) * 3],
              size: 0.05,
              sizeEnd: 0.015,
              life: 0.16,
              color: [1.0, 0.76, 0.24],
              alpha: 0.95,
              gravity: 8.0,
              drag: 1.5,
              additive: true
            });
          }
        }
      } else if (p.type === 'atgm') {
        const tgt = resolveATGMGuidanceTarget(p);
        if (tgt) {
          const desiredDir = normalize3([0, 0, 0], [tgt[0] - p.pos[0], tgt[1] - p.pos[1], tgt[2] - p.pos[2]]);
          const turn = clamp(5.0 * dt, 0, 1);
          const spd = Math.hypot(p.vel[0], p.vel[1], p.vel[2]) || 92;
          normalize3(p.dir, [
            p.dir[0] + (desiredDir[0] - p.dir[0]) * turn,
            p.dir[1] + (desiredDir[1] - p.dir[1]) * turn,
            p.dir[2] + (desiredDir[2] - p.dir[2]) * turn
          ]);
          p.vel[0] = p.dir[0] * spd;
          p.vel[1] = p.dir[1] * spd;
          p.vel[2] = p.dir[2] * spd;
        }
        addLight(p.pos, [1.0, 0.62, 0.18], 11.0, 14.0);
        p.smokeAccum += dt;
        if (p.smokeAccum >= 0.014) {
          p.smokeAccum = 0;
          const spA = p.age * 24;
          spawnP({
            type: 'smoke',
            pos: [p.pos[0] - p.dir[0] * 0.42, p.pos[1] - p.dir[1] * 0.42, p.pos[2] - p.dir[2] * 0.42],
            vel: [Math.cos(spA) * 0.6, 0.35 + Math.sin(spA) * 0.4, Math.sin(spA) * 0.6],
            size: 0.22,
            sizeEnd: 1.45,
            life: 2.0,
            color: [0.78, 0.76, 0.72],
            alpha: 0.34,
            gravity: -0.25,
            drag: 1.2
          });
          spawnP({
            type: 'flash',
            pos: [p.pos[0] - p.dir[0] * 0.38, p.pos[1] - p.dir[1] * 0.38, p.pos[2] - p.dir[2] * 0.38],
            vel: [-p.dir[0] * 5, -p.dir[1] * 5, -p.dir[2] * 5],
            size: 0.34,
            sizeEnd: 0.08,
            life: 0.06,
            color: [1.0, 0.78, 0.32],
            alpha: 0.94,
            gravity: 0,
            drag: 1.2,
            additive: true
          });
        }
      } else if (p.type === 'grenade40' || p.type === 'vog_bomb') {
        p.smokeAccum += dt;
        if (p.smokeAccum >= 0.032) {
          p.smokeAccum = 0;
          spawnP({
            type: 'smoke',
            pos: [p.pos[0], p.pos[1], p.pos[2]],
            vel: [0, 0.35, 0],
            size: 0.11,
            sizeEnd: 0.48,
            life: 0.60,
            color: [0.68, 0.68, 0.66],
            alpha: 0.28,
            gravity: -0.2,
            drag: 1.5
          });
        }
      } else if (p.type === 'tank125' || p.type === 'autocannon') {
        addLight(p.pos, [1.0, 0.72, 0.28], p.type === 'tank125' ? 10.0 : 4.5, 10.0);
        p.smokeAccum += dt;
        if (p.smokeAccum >= 0.018) {
          p.smokeAccum = 0;
          spawnP({
            type: 'smoke',
            pos: [p.pos[0], p.pos[1], p.pos[2]],
            vel: [0, 0.2, 0],
            size: p.type === 'tank125' ? 0.14 : 0.07,
            sizeEnd: p.type === 'tank125' ? 0.55 : 0.26,
            life: 0.38,
            color: [0.76, 0.75, 0.73],
            alpha: 0.18,
            gravity: -0.1,
            drag: 2.0
          });
        }
      } else if (p.spec && (p.spec.class === 'sniper' || p.spec.class === 'lmg') && p.isTracer) {
        // Subtle supersonic vapor ribbon on sniper & heavy LMG rounds
        p.smokeAccum += dt;
        if (p.smokeAccum >= 0.022) {
          p.smokeAccum = 0;
          spawnP({
            type: 'smoke',
            pos: [p.pos[0], p.pos[1], p.pos[2]],
            vel: [0, 0.12, 0],
            size: 0.055,
            sizeEnd: 0.22,
            life: 0.30,
            color: [0.80, 0.82, 0.85],
            alpha: 0.13,
            gravity: -0.05,
            drag: 2.2
          });
        }
      }

      // Gravity & aerodynamic drag
      p.vel[1] -= p.gravity * dt;
      if (p.drag > 0) {
        const dampFactor = Math.max(0, 1 - p.drag * p.speed * dt);
        p.vel[0] *= dampFactor;
        p.vel[1] *= dampFactor;
        p.vel[2] *= dampFactor;
      }

      const stepX = p.vel[0] * dt;
      const stepY = p.vel[1] * dt;
      const stepZ = p.vel[2] * dt;
      const stepDist = Math.hypot(stepX, stepY, stepZ);
      if (stepDist > 1e-6) {
        p.dir[0] = stepX / stepDist;
        p.dir[1] = stepY / stepDist;
        p.dir[2] = stepZ / stepDist;
        p.speed = stepDist / dt;
      }

      const nextPos = [p.pos[0] + stepX, p.pos[1] + stepY, p.pos[2] + stepZ];

      // Cosmetic ricochet bolt skips collision/damage for clean visual streak
      if (p.type === 'ricochet') {
        p.pos[0] = nextPos[0]; p.pos[1] = nextPos[1]; p.pos[2] = nextPos[2];
        p.traveledDist = (p.traveledDist || 0) + stepDist;
        continue;
      }

      let hit = null;
      if (hasPhysics && stepDist > 1e-5) {
        const ignoreIds = [];
        if (p.shooterId !== null) ignoreIds.push(p.shooterId);
        if (p.vehicleId !== null) ignoreIds.push(p.vehicleId);
        hit = DF.Physics.raycast(p.pos, p.dir, stepDist + 0.02, {
          ignoreIds,
          ignoreEntityId: p.shooterId,
          ignoreFaction: p.age < 0.05 ? p.faction : null,
          checkEntities: true,
          checkVehicles: true,
          hitSmoke: false
        });
      }

      // Check hits against active unmanned drones & combat robot dogs
      const uHit = checkUnmannedHit(p, nextPos, hit ? hit.dist : stepDist + 0.02);
      if (uHit && (!hit || uHit.dist < hit.dist)) {
        hit = uHit;
      }

      if (!hit && nextPos[1] <= 0.0) {
        const tGround = clamp((0.0 - p.pos[1]) / (nextPos[1] - p.pos[1] || -1), 0, 1);
        hit = {
          dist: stepDist * tGround,
          point: [p.pos[0] + stepX * tGround, 0.01, p.pos[2] + stepZ * tGround],
          normal: [0, 1, 0],
          material: 'earth',
          collider: null,
          entity: null,
          vehicle: null
        };
      }

      if (hit) {
        p.pos[0] = hit.point[0];
        p.pos[1] = hit.point[1];
        p.pos[2] = hit.point[2];

        const isExplosive = p.explosiveRadius > 0;

        if (isExplosive) {
          if (hit.vehicle || hit.entity || hit.unmanned) {
            dispatchBulletHit(p, hit, p.damage * 0.45);
          }
          dispatchExplosion(
            hit.point,
            p.explosiveRadius,
            p.explosiveDamage,
            p.vehicleDamage,
            p.armorPen,
            p.shooter,
            p.spec ? p.spec.id : p.type,
            p.spec ? (p.spec.displayName || p.spec.name) : p.type.toUpperCase(),
            p.isPlayer,
            hit.normal
          );
          p.alive = false;
          state.projectiles.splice(i, 1);
          continue;
        }

        // AAA velocity-stretched ricochet sparks, directional material jets, contact flashes & persistent surface decals
        const isArmorDeflect = !!(hit.vehicle && hit.hitZone === 'front' && p.armorPen < 0.65);
        const isHeavyRound = p.damage >= 65 || p.type === 'tank125' || p.type === 'autocannon';
        const mat = hit.entity ? 'flesh' : (hit.vehicle ? 'vehicle' : (hit.material || 'concrete'));
        spawnBallisticImpactDetail(mat, hit.point, hit.normal, p.dir, isHeavyRound, isArmorDeflect);

        dispatchBulletHit(p, hit, p.damage);

        // Wall penetration for high-energy rounds through glass/wood/plaster/sandbag/thin brick
        const penInfo = PENETRATION_MAT[mat];
        if (!hit.entity && !hit.vehicle && !hit.unmanned && penInfo && penInfo.canPen && p.penDepthLeft > penInfo.cost && p.penetratedCount < 2) {
          const probeDist = mat === 'glass' ? 0.14 : Math.min(0.45, p.penDepthLeft);
          const exitPos = [
            hit.point[0] + p.dir[0] * probeDist,
            hit.point[1] + p.dir[1] * probeDist,
            hit.point[2] + p.dir[2] * probeDist
          ];
          let blockedDeep = false;
          if (hasPhysics && mat !== 'glass') {
            const checkHit = DF.Physics.raycast(exitPos, p.dir, 0.08, { checkEntities: false, checkVehicles: false });
            if (checkHit && checkHit.dist < 0.05 && checkHit.material === 'concrete') {
              blockedDeep = true;
            }
          }
          if (!blockedDeep) {
            p.penetratedCount++;
            p.penDepthLeft -= penInfo.cost;
            p.damage *= penInfo.dmgMult;
            p.pos[0] = exitPos[0];
            p.pos[1] = exitPos[1];
            p.pos[2] = exitPos[2];
            spawnImpactVFX(mat, exitPos, [-p.dir[0], -p.dir[1], -p.dir[2]], p.dir, false, false);
            p.vel[0] *= 0.82;
            p.vel[1] *= 0.82;
            p.vel[2] *= 0.82;
            continue;
          }
        }

        p.alive = false;
        state.projectiles.splice(i, 1);
        continue;
      }

      p.pos[0] = nextPos[0];
      p.pos[1] = nextPos[1];
      p.pos[2] = nextPos[2];
      p.traveledDist = (p.traveledDist || 0) + stepDist;

      checkNearMissSuppression(p);

      if (Math.abs(p.pos[0]) > 145 || Math.abs(p.pos[2]) > 110 || p.pos[1] > 140 || p.pos[1] < -10) {
        p.alive = false;
        state.projectiles.splice(i, 1);
      }
    }
  }

  function updateGrenades(dt) {
    const hasPhysics = DF.Physics && typeof DF.Physics.raycast === 'function';

    for (let i = state.grenades.length - 1; i >= 0; i--) {
      const g = state.grenades[i];
      if (!g.alive) {
        state.grenades.splice(i, 1);
        continue;
      }

      g.vel[1] -= 16.5 * dt;
      const dx = g.vel[0] * dt;
      const dy = g.vel[1] * dt;
      const dz = g.vel[2] * dt;
      const dist = Math.hypot(dx, dy, dz);

      if (hasPhysics && dist > 1e-4) {
        const dir = [dx / dist, dy / dist, dz / dist];
        const hit = DF.Physics.raycast(g.pos, dir, dist + 0.08, { checkEntities: false, checkVehicles: true });
        if (hit) {
          const n = hit.normal || [0, 1, 0];
          g.pos[0] = hit.point[0] + n[0] * 0.06;
          g.pos[1] = hit.point[1] + n[1] * 0.06;
          g.pos[2] = hit.point[2] + n[2] * 0.06;
          const vn = g.vel[0] * n[0] + g.vel[1] * n[1] + g.vel[2] * n[2];
          if (vn < 0) {
            const rest = 0.42;
            g.vel[0] = (g.vel[0] - (1 + rest) * vn * n[0]) * 0.82;
            g.vel[1] = (g.vel[1] - (1 + rest) * vn * n[1]) * 0.82;
            g.vel[2] = (g.vel[2] - (1 + rest) * vn * n[2]) * 0.82;
            g.rotVel[0] *= 0.65; g.rotVel[1] *= 0.65; g.rotVel[2] *= 0.65;
            if (g.bounces < 4 && Math.abs(vn) > 1.2 && DF.Audio && typeof DF.Audio.playImpact === 'function') {
              DF.Audio.playImpact('metal', g.pos);
            }
            g.bounces++;
          }
        } else {
          g.pos[0] += dx; g.pos[1] += dy; g.pos[2] += dz;
        }
      } else {
        g.pos[0] += dx; g.pos[1] += dy; g.pos[2] += dz;
      }

      const groundY = (DF.Physics && typeof DF.Physics.getGroundY === 'function')
        ? DF.Physics.getGroundY(g.pos[0], g.pos[2], g.pos[1] + 0.5)
        : 0.0;
      if (g.pos[1] < groundY + 0.05) {
        g.pos[1] = groundY + 0.05;
        if (g.vel[1] < -1.0) {
          g.vel[1] = -g.vel[1] * 0.36;
          g.vel[0] *= 0.72;
          g.vel[2] *= 0.72;
          if (g.bounces < 4 && DF.Audio && typeof DF.Audio.playImpact === 'function') {
            DF.Audio.playImpact('metal', g.pos);
          }
          g.bounces++;
        } else {
          g.vel[1] = 0;
          g.vel[0] *= Math.max(0, 1 - 4.5 * dt);
          g.vel[2] *= Math.max(0, 1 - 4.5 * dt);
          g.rotVel[0] *= Math.max(0, 1 - 5 * dt);
          g.rotVel[1] *= Math.max(0, 1 - 5 * dt);
          g.rotVel[2] *= Math.max(0, 1 - 5 * dt);
        }
      }

      g.rot[0] += g.rotVel[0] * dt;
      g.rot[1] += g.rotVel[1] * dt;
      g.rot[2] += g.rotVel[2] * dt;

      if (!g.activeSmoke) {
        g.fuse -= dt;
        if (g.fuse <= 0) {
          if (g.type === 'frag') {
            dispatchExplosion(
              g.pos,
              8.5,
              195,
              95,
              0.55,
              g.shooter,
              g.faction === 'RU' ? 'f1_frag' : 'm67_frag',
              g.faction === 'RU' ? 'F-1 Frag' : 'M67 Frag',
              g.isPlayer
            );
            g.alive = false;
            state.grenades.splice(i, 1);
            continue;
          } else {
            g.activeSmoke = true;
            if (DF.Physics && typeof DF.Physics.addSmokeVolume === 'function') {
              DF.Physics.addSmokeVolume([g.pos[0], g.pos[1] + 1.5, g.pos[2]], 7.8, g.smokeDuration + 2.5);
            }
            if (DF.Audio && typeof DF.Audio.playImpact === 'function') {
              DF.Audio.playImpact('sandbag', g.pos);
            }
          }
        }
      } else {
        g.smokeDuration -= dt;
        g.smokeEmitAccum += dt;
        while (g.smokeEmitAccum >= 0.14) {
          g.smokeEmitAccum -= 0.14;
          const a = Math.random() * Math.PI * 2;
          const rad = Math.random() * 2.2;
          spawnP({
            type: 'smoke',
            pos: [g.pos[0] + Math.cos(a) * rad * 0.4, g.pos[1] + 0.15, g.pos[2] + Math.sin(a) * rad * 0.4],
            vel: [Math.cos(a) * 1.4 + 0.55, 1.05 + Math.random() * 0.85, Math.sin(a) * 1.4],
            size: 1.05 + Math.random() * 0.40,
            sizeEnd: 4.5 + Math.random() * 1.6,
            life: 4.2 + Math.random() * 1.6,
            color: [0.76, 0.78, 0.80],
            alpha: 0.48,
            gravity: -0.22,
            drag: 0.72
          });
        }
        if (g.smokeDuration <= 0) {
          g.alive = false;
          state.grenades.splice(i, 1);
        }
      }
    }
  }

  function updateCasings(dt) {
    const getGnd = (DF.Physics && typeof DF.Physics.getGroundY === 'function')
      ? DF.Physics.getGroundY
      : null;

    for (let i = 0; i < state.casings.length; i++) {
      const c = state.casings[i];
      if (!c.active) continue;
      c.life -= dt;
      if (c.life <= 0) {
        c.active = false;
        continue;
      }
      if (c.sleeping) continue;

      c.vel[1] -= 14.5 * dt;
      c.pos[0] += c.vel[0] * dt;
      c.pos[1] += c.vel[1] * dt;
      c.pos[2] += c.vel[2] * dt;

      c.rot[0] += c.rotVel[0] * dt;
      c.rot[1] += c.rotVel[1] * dt;
      c.rot[2] += c.rotVel[2] * dt;

      const groundY = getGnd ? getGnd(c.pos[0], c.pos[2], c.pos[1] + 0.4) : 0.0;
      const minY = groundY + (c.type === 'shell' ? 0.011 : 0.007);
      if (c.pos[1] <= minY) {
        c.pos[1] = minY;
        if (c.bounces < 2 && Math.abs(c.vel[1]) > 0.75) {
          if (DF.Audio && typeof DF.Audio.playCasingPing === 'function') {
            DF.Audio.playCasingPing(c.pos);
          }
        }
        c.bounces++;
        c.vel[1] = -c.vel[1] * 0.38;
        c.vel[0] *= 0.58;
        c.vel[2] *= 0.58;
        c.rotVel[0] *= 0.45;
        c.rotVel[1] *= 0.45;
        c.rotVel[2] *= 0.45;

        if (c.bounces >= 3 || (Math.abs(c.vel[1]) < 0.25 && Math.hypot(c.vel[0], c.vel[2]) < 0.2)) {
          c.sleeping = true;
          c.rot[0] = 0;
          c.vel[0] = c.vel[1] = c.vel[2] = 0;
        }
      }
    }
  }

  function update(dt, camPos) {
    if (!state.initialized) return;
    const cdt = clamp(dt || 0.016, 0.001, 0.05);
    if (camPos && camPos.length >= 3) {
      state.camPos[0] = camPos[0];
      state.camPos[1] = camPos[1];
      state.camPos[2] = camPos[2];
    } else if (DF.Game && DF.Game.camera && DF.Game.camera.pos) {
      state.camPos[0] = DF.Game.camera.pos[0];
      state.camPos[1] = DF.Game.camera.pos[1];
      state.camPos[2] = DF.Game.camera.pos[2];
    } else if (DF.Viewmodel && typeof DF.Viewmodel.getState === 'function') {
      const vm = DF.Viewmodel.getState();
      if (vm && vm.muzzleWorld) {
        state.camPos[0] = vm.muzzleWorld[0];
        state.camPos[1] = vm.muzzleWorld[1];
        state.camPos[2] = vm.muzzleWorld[2];
      }
    }

    updateProjectiles(cdt);
    updateGrenades(cdt);
    updateCasings(cdt);
  }

  // ---------------------------------------------------------------------------
  // 3D Rendering: Tracers, Rockets, Grenades, Bombs, Physical 3D Shell Casings
  // ---------------------------------------------------------------------------
  function render(renderer) {
    if (!state.initialized || !renderer) return;
    const M = DF.Mat4;
    state.matPoolIdx = 0;
    const unlitFlags = { castShadow: false, receiveShadow: false, viewmodel: false, unlit: true };
    const solidFlags = { castShadow: true, receiveShadow: true, viewmodel: false, unlit: false };
    const casingFlags = { castShadow: false, receiveShadow: true, viewmodel: false, unlit: false };

    // 1) Active projectiles (3-layer velocity-aligned HDR tracers + 3D rockets/ordnance)
    const hasSubmitTracer = typeof renderer.submitTracer === 'function';
    for (let i = 0; i < state.projectiles.length; i++) {
      const p = state.projectiles[i];
      if (p.type === 'rpg' && state.meshes.rpg) {
        const m = allocMat();
        matFromPosDirScale(m, p.pos, p.dir, 1.0, 1.0, 1.0);
        renderer.submitMesh(state.meshes.rpg, m, state.mats.ordnance, solidFlags);
        if (hasSubmitTracer) {
          const ex = [p.pos[0] - p.dir[0] * 0.34, p.pos[1] - p.dir[1] * 0.34, p.pos[2] - p.dir[2] * 0.34];
          const tail = [ex[0] - p.dir[0] * 1.45, ex[1] - p.dir[1] * 1.45, ex[2] - p.dir[2] * 1.45];
          renderer.submitTracer(tail, ex, 0.048, [1.0, 0.62, 0.18]);
        }
      } else if (p.type === 'atgm' && state.meshes.atgm) {
        const m = allocMat();
        matFromPosDirScale(m, p.pos, p.dir, 1.0, 1.0, 1.0);
        renderer.submitMesh(state.meshes.atgm, m, state.mats.ordnance, solidFlags);
        if (hasSubmitTracer) {
          const ex = [p.pos[0] - p.dir[0] * 0.44, p.pos[1] - p.dir[1] * 0.44, p.pos[2] - p.dir[2] * 0.44];
          const tail = [ex[0] - p.dir[0] * 1.75, ex[1] - p.dir[1] * 1.75, ex[2] - p.dir[2] * 1.75];
          renderer.submitTracer(tail, ex, 0.056, [1.0, 0.68, 0.22]);
        }
      } else if ((p.type === 'grenade40' || p.type === 'vog_bomb') && state.meshes.grenade40) {
        const m = allocMat();
        matFromPosDirScale(m, p.pos, p.dir, 1.2, 1.2, 1.2);
        renderer.submitMesh(state.meshes.grenade40, m, state.mats.ordnance, solidFlags);
      } else if (p.isTracer) {
        const isHeavy = p.type === 'tank125' || p.type === 'autocannon';
        const isRic = p.type === 'ricochet';
        const desiredLen = isHeavy
          ? (p.type === 'tank125' ? 5.2 : 4.1)
          : (isRic ? 1.85 : clamp(p.speed * 0.0082, 1.35, 4.2));
        const len = Math.min(desiredLen, Math.max(0.28, (p.traveledDist || desiredLen)));

        if (hasSubmitTracer) {
          const width = isHeavy
            ? (p.type === 'tank125' ? 0.054 : 0.034)
            : (isRic ? 0.012 : (p.spec && p.spec.class === 'sniper' ? 0.022 : 0.015));
          const col = p.tracerColor || (isHeavy ? [1.0, 0.68, 0.24] : (p.faction === 'RU' ? [0.42, 1.0, 0.45] : [1.0, 0.78, 0.34]));
          const tail = [
            p.pos[0] - p.dir[0] * len,
            p.pos[1] - p.dir[1] * len,
            p.pos[2] - p.dir[2] * len
          ];
          renderer.submitTracer(tail, p.pos, width, col);
        } else if (state.meshes.tracer) {
          const rad = isHeavy ? 1.35 : (p.spec && p.spec.class === 'sniper' ? 0.82 : 0.62);
          const mid = [
            p.pos[0] - p.dir[0] * len * 0.5,
            p.pos[1] - p.dir[1] * len * 0.5,
            p.pos[2] - p.dir[2] * len * 0.5
          ];
          const mCore = allocMat();
          matFromPosDirScale(mCore, mid, p.dir, rad, rad, len);
          const tMat = isHeavy
            ? state.mats.tracerHeavy
            : (p.faction === 'RU' ? state.mats.tracerRU : state.mats.tracerUA);
          renderer.submitMesh(state.meshes.tracer, mCore, tMat, unlitFlags);

          if (state.meshes.tracerGlow) {
            const mGlow = allocMat();
            matFromPosDirScale(mGlow, mid, p.dir, rad, rad, len);
            const gMat = isHeavy
              ? state.mats.tracerGlowHeavy
              : (p.faction === 'RU' ? state.mats.tracerGlowRU : state.mats.tracerGlowUA);
            renderer.submitMesh(state.meshes.tracerGlow, mGlow, gMat, unlitFlags);
          }
        }
      }
    }

    // 2) Thrown Frag & Smoke Grenades
    for (let i = 0; i < state.grenades.length; i++) {
      const g = state.grenades[i];
      const mesh = g.type === 'smoke' ? state.meshes.smoke : state.meshes.frag;
      if (!mesh) continue;
      const m = allocMat();
      M.fromTRS(m, g.pos, g.rot, [1.25, 1.25, 1.25]);
      renderer.submitMesh(mesh, m, state.mats.ordnance, solidFlags);
    }

    // 3) Physical 3D Shell Casings & 12ga Shotgun Hulls
    for (let i = 0; i < state.casings.length; i++) {
      const c = state.casings[i];
      if (!c.active) continue;
      const mesh = c.type === 'shell' ? state.meshes.shell : state.meshes.brass;
      if (!mesh) continue;
      const m = allocMat();
      M.fromTRS(m, c.pos, c.rot, [1.0, 1.0, 1.0]);
      renderer.submitMesh(mesh, m, c.type === 'shell' ? state.mats.shell : state.mats.brass, casingFlags);
    }
  }

  function getStats() {
    let activeCasings = 0;
    for (let i = 0; i < state.casings.length; i++) {
      if (state.casings[i].active) activeCasings++;
    }
    return {
      projectiles: state.projectiles.length,
      grenades: state.grenades.length,
      casings: activeCasings
    };
  }

  DF.Ballistics = {
    init,
    clear,
    reset: clear,
    fireWeapon,
    throwGrenade,
    spawnCasing,
    update,
    render,
    getStats
  };
})();
