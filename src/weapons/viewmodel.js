(() => {
  'use strict';
  const DF = (window.DF = window.DF || {});

  // ---------------------------------------------------------------------------
  // Utility helpers for math & procedural mesh building
  // ---------------------------------------------------------------------------
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, x) {
    const t = clamp((x - a) / (b - a || 1), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function damp(a, b, lambda, dt) {
    return lerp(a, b, 1 - Math.exp(-lambda * dt));
  }
  function lerp3(out, a, b, t) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    return out;
  }

  function makeMat(texKey, color, roughness, metalness, extra) {
    const m = {
      texKey: texKey || 'gunmetal',
      color: color || [1, 1, 1],
      roughness: roughness !== undefined ? roughness : 0.42,
      metalness: metalness !== undefined ? metalness : 0.78,
      emissive: [0, 0, 0],
      uvScale: [1, 1],
      alpha: 1.0,
      thermalHeat: 0.14,
      doubleSided: false
    };
    if (extra) {
      for (const k in extra) m[k] = extra[k];
    }
    return m;
  }

  function newBuilder() {
    return new DF.MeshGen.Builder();
  }

  function safeFinish(builder, gl) {
    if (typeof builder.computeTangents === 'function') builder.computeTangents();
    return builder.build(gl);
  }

  function addPart(list, builder, gl, material) {
    const mesh = safeFinish(builder, gl);
    if (mesh && mesh.indexCount > 0) {
      list.push({ mesh, material });
    }
  }

  // Picatinny rail teeth strip along Z
  function addPicatinnyRail(b, x, y, zStart, zEnd, width, teethCount, color) {
    const len = Math.abs(zEnd - zStart);
    const zMid = (zStart + zEnd) * 0.5;
    b.addBox(x, y, zMid, width, 0.008, len, { color });
    const step = len / Math.max(1, teethCount);
    for (let i = 0; i < teethCount; i++) {
      const zt = Math.min(zStart, zEnd) + (i + 0.5) * step;
      b.addBox(x, y + 0.0055, zt, width * 1.06, 0.0045, step * 0.52, { color });
    }
  }

  // Ventilated barrel shroud / cooling slots
  function addVentRings(b, x, y, zStart, zEnd, r, count, color) {
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0.5;
      const z = lerp(zStart, zEnd, t);
      b.addCylinder(x, y, z, r, r, 0.007, 12, { axis: 'z', color });
    }
  }

  // ---------------------------------------------------------------------------
  // High-detail procedural builders for all 12 faction weapons
  // Returns rig: {
  //   body: [{mesh, material}],
  //   bolt: [{mesh, material}],
  //   mag:  [{mesh, material}],
  //   cover: [{mesh, material}],     // LMG top feed cover / M320 break barrel / RG6 drum
  //   shell: [{mesh, material}],     // M870 red shell / M320 40mm round
  //   warhead: [{mesh, material}],   // RPG-7 protruding PG-7VL warhead
  //   reticle: [{mesh, material}],   // Illuminated glowing dot / sight element
  //   pivots: { cover:[x,y,z], mag:[x,y,z], bolt:[x,y,z] }
  // }
  // Weapon local space: -Z forward (muzzle), +Y up, +X right.
  // ---------------------------------------------------------------------------
  function buildWeaponRig(gl, spec) {
    const style = spec.geometrySpec.style;
    const accent = spec.geometrySpec.accentColor || [0.3, 0.3, 0.3];
    const tape = spec.geometrySpec.tapeColor || [0.9, 0.8, 0.2];
    const retCol = spec.geometrySpec.reticleColor || [1.0, 0.2, 0.14];

    // Authentic military PBR material calibration (deep anodized gunmetal / phosphate steel / matte polymer / warm FDE / brass)
    const matMetal = makeMat('gunmetal', [0.46, 0.49, 0.54], 0.34, 0.85, { uvScale: [2.4, 2.4], thermalHeat: 0.24 });
    const matDarkSteel = makeMat('metal_dark', [0.30, 0.32, 0.36], 0.46, 0.72, { uvScale: [2.2, 2.2], thermalHeat: 0.20 });
    const matPolymer = makeMat('polymer', [0.52, 0.54, 0.58], 0.76, 0.05, { uvScale: [3.0, 3.0], thermalHeat: 0.14 });
    const matAccent = makeMat('polymer', [accent[0] * 1.15, accent[1] * 1.08, accent[2] * 0.98], 0.68, 0.08, { uvScale: [2.8, 2.8], thermalHeat: 0.14 });
    const matWood = makeMat('wood', [0.76, 0.52, 0.32], 0.64, 0.04, { uvScale: [2.0, 2.0], thermalHeat: 0.12 });
    const matBakelite = makeMat('bakelite', [0.88, 0.50, 0.30], 0.42, 0.08, { uvScale: [2.0, 2.0], thermalHeat: 0.12 });
    const matBrass = makeMat('gunmetal', [1.05, 0.84, 0.34], 0.24, 0.94, { uvScale: [2.0, 2.0], thermalHeat: 0.26 });
    const matTape = makeMat('polymer', [tape[0] * 1.15, tape[1] * 1.15, tape[2] * 1.12], 0.66, 0.04, { thermalHeat: 0.16 });
    const matLens = makeMat('gunmetal', [0.22, 0.54, 0.68], 0.05, 0.14, {
      alpha: 0.14,
      emissive: [0, 0, 0],
      doubleSided: true
    });
    const matReticle = makeMat('gunmetal', retCol, 0.08, 0.0, {
      emissive: [retCol[0] * 4.2, retCol[1] * 4.2, retCol[2] * 4.2],
      alpha: 0.98,
      doubleSided: true
    });

    const rig = {
      body: [],
      bolt: [],
      mag: [],
      cover: [],
      shell: [],
      warhead: [],
      reticle: [],
      pivots: {
        cover: [0, 0.075, -0.18],
        mag: [0, -0.05, -0.09],
        bolt: [0, 0.045, 0]
      }
    };

    const bMetal = newBuilder();
    const bDark = newBuilder();
    const bPoly = newBuilder();
    const bAcc = newBuilder();
    const bWood = newBuilder();
    const bTape = newBuilder();
    const bBrass = newBuilder();
    const bLens = newBuilder();
    const bRet = newBuilder();
    const bBolt = newBuilder();
    const bMag = newBuilder();
    const bMagAlt = newBuilder();
    const bCover = newBuilder();
    const bShell = newBuilder();
    const bWarhead = newBuilder();
    const bWarheadBrass = newBuilder();

    if (style === 'm4') {
      // --- UA M4A1 / UAR-15 (Two-Tone Anodized Gunmetal Receiver + FDE M-LOK Handguard & EXPS3 Holo) ---
      // Upper forged receiver (matte anodized dark steel) & contoured lower receiver + flared magwell
      bDark.addBeveledBox(0, 0.036, -0.01, 0.040, 0.048, 0.225, 0.005, { color: [0.68, 0.70, 0.74] });
      bDark.addBeveledBox(0, -0.002, -0.02, 0.039, 0.042, 0.185, 0.004, { color: [0.64, 0.66, 0.70] });
      bDark.addBeveledBox(0, -0.032, -0.078, 0.043, 0.044, 0.068, 0.004, { color: [0.66, 0.68, 0.72] }); // magwell
      // Left-side camera-facing receiver controls (selector switch, bolt catch paddle, takedown pins, rail bevels!)
      bMetal.addCylinder(-0.021, 0.004, 0.044, 0.006, 0.006, 0.006, 10, { axis: 'x', color: [0.74, 0.76, 0.80] }); // selector drum
      bMetal.addBox(-0.023, 0.004, 0.034, 0.004, 0.005, 0.018, { rotX: -0.35, color: [0.76, 0.78, 0.82] }); // selector lever
      bMetal.addBox(-0.022, 0.016, -0.038, 0.005, 0.024, 0.012, { color: [0.74, 0.76, 0.80] }); // ping-pong bolt catch
      bMetal.addCylinder(-0.021, 0.014, 0.078, 0.0045, 0.0045, 0.005, 8, { axis: 'x', color: [0.70, 0.72, 0.76] }); // rear takedown pin
      bMetal.addCylinder(-0.021, 0.014, -0.098, 0.0045, 0.0045, 0.005, 8, { axis: 'x', color: [0.70, 0.72, 0.76] }); // front pivot pin
      // Brass deflector & forward assist on right side
      bMetal.addWedge(0.025, 0.042, 0.032, 0.015, 0.022, 0.026, { color: [0.72, 0.74, 0.78] });
      bMetal.addCylinder(0.025, 0.030, 0.068, 0.0065, 0.0075, 0.026, 10, { axis: 'z', rotY: 0.25, color: [0.72, 0.74, 0.78] });
      bDark.addBox(0.023, 0.024, -0.025, 0.004, 0.015, 0.064, { rotZ: 0.25 });
      // Top continuous dark brushed-steel Picatinny rail + folded rear backup iron sight (BUIS)
      addPicatinnyRail(bMetal, 0, 0.062, -0.37, 0.095, 0.023, 24, [0.70, 0.72, 0.76]);
      bMetal.addBeveledBox(0, 0.073, 0.074, 0.026, 0.012, 0.030, 0.002, { color: [0.72, 0.74, 0.78] }); // folded rear BUIS
      // Free-float FDE Coyote Tan M-LOK Handguard (cleanly beveled octagon feel + recessed dark M-LOK slots!)
      bAcc.addBeveledBox(0, 0.034, -0.255, 0.045, 0.048, 0.265, 0.009, { color: [0.84, 0.76, 0.66] });
      // Recessed M-LOK ventilation windows on left & right sides (breaks up slab silhouette!)
      for (let m = 0; m < 4; m++) {
        const zm = -0.165 - m * 0.056;
        bDark.addBox(-0.0235, 0.034, zm, 0.003, 0.010, 0.036, { color: [0.35, 0.36, 0.38] });
        bDark.addBox(0.0235, 0.034, zm, 0.003, 0.010, 0.036, { color: [0.35, 0.36, 0.38] });
      }
      // Side M-LOK rail segment + compact Surefire tactical weapon light on right
      bMetal.addBox(0.026, 0.044, -0.33, 0.008, 0.014, 0.065, { color: [0.70, 0.72, 0.76] });
      bDark.addCylinder(0.034, 0.046, -0.35, 0.011, 0.011, 0.088, 12, { axis: 'z' });
      addPicatinnyRail(bDark, 0, 0.006, -0.36, -0.14, 0.020, 10, [0.58, 0.60, 0.64]);
      // Compact FDE PEQ-15 laser module on top front rail
      bAcc.addBeveledBox(0.010, 0.075, -0.31, 0.034, 0.018, 0.074, 0.003, { color: [0.82, 0.74, 0.64] });
      bMetal.addCylinder(0.020, 0.076, -0.35, 0.0045, 0.0045, 0.012, 10, { axis: 'z' });
      // Fluted dark gunmetal barrel, low-profile gas block, gas tube & 3-prong SOCOM flash hider
      bMetal.addCylinder(0, 0.038, -0.37, 0.0105, 0.0115, 0.42, 14, { axis: 'z', color: [0.68, 0.70, 0.74] });
      bMetal.addCylinder(0, 0.054, -0.24, 0.0032, 0.0032, 0.28, 8, { axis: 'z', color: [0.72, 0.74, 0.78] });
      bDark.addBox(0, 0.044, -0.40, 0.020, 0.026, 0.028);
      bMetal.addBox(0, 0.071, -0.372, 0.018, 0.012, 0.020, { color: [0.70, 0.72, 0.76] }); // folded front BUIS
      bDark.addCylinder(0, 0.038, -0.57, 0.0135, 0.0115, 0.056, 12, { axis: 'z' });
      addVentRings(bMetal, 0, 0.038, -0.590, -0.554, 0.015, 3, [0.72, 0.74, 0.78]);
      // Ergonomic stippled pistol grip + angled trigger guard + curved trigger
      bPoly.addBeveledBox(0, -0.076, 0.076, 0.030, 0.108, 0.042, 0.005, { rotX: -0.32 });
      bDark.addBox(0, -0.036, 0.016, 0.013, 0.005, 0.072);
      bMetal.addBox(0, -0.021, 0.020, 0.005, 0.024, 0.007, { rotX: 0.24 });
      // Sleek angled handstop / foregrip
      bPoly.addBeveledBox(0, -0.010, -0.255, 0.026, 0.026, 0.082, 0.004, { rotX: 0.24 });
      // Buffer tube, castle nut & FDE SOPMOD crane stock + crisp UA yellow ID tape wrap on stock!
      bMetal.addCylinder(0, 0.038, 0.125, 0.021, 0.021, 0.018, 12, { axis: 'z', color: [0.70, 0.72, 0.76] }); // castle nut
      bDark.addCylinder(0, 0.038, 0.21, 0.0175, 0.0175, 0.23, 12, { axis: 'z' });
      bAcc.addBeveledBox(0, 0.018, 0.26, 0.050, 0.100, 0.175, 0.009, { color: [0.80, 0.73, 0.64] });
      bPoly.addBox(0, 0.012, 0.348, 0.046, 0.110, 0.018);
      bTape.addBox(0, 0.034, -0.132, 0.048, 0.050, 0.016); // UA yellow ID band on handguard collar
      // --- Sleek Low-Profile EOTech EXPS3 Holographic Sight (centered at y = 0.106, total hood height = 0.042!) ---
      bMetal.addBeveledBox(0, 0.074, 0.002, 0.034, 0.014, 0.072, 0.002, { color: [0.68, 0.70, 0.74] }); // QD base mount
      bMetal.addBox(-0.020, 0.074, 0.008, 0.005, 0.010, 0.026, { color: [0.74, 0.76, 0.80] }); // left QD throw lever
      bAcc.addBeveledBox(0, 0.086, -0.032, 0.034, 0.018, 0.032, 0.004, { color: [0.82, 0.74, 0.64] }); // front battery compartment
      bDark.addBox(0, 0.086, 0.008, 0.036, 0.007, 0.044); // low floor tray
      // Beveled low-cutaway protective U-hood (slanted top chamfers for sleek modern optic silhouette!)
      bDark.addBeveledBox(-0.020, 0.105, 0.008, 0.0055, 0.036, 0.042, 0.0018, { color: [0.64, 0.66, 0.70] }); // left strut
      bDark.addBeveledBox(0.020, 0.105, 0.008, 0.0055, 0.036, 0.042, 0.0018, { color: [0.64, 0.66, 0.70] });  // right strut
      bDark.addBeveledBox(0, 0.125, 0.008, 0.042, 0.0055, 0.042, 0.0018, { color: [0.68, 0.70, 0.74] });     // low top arch
      bMetal.addBox(-0.016, 0.122, 0.008, 0.008, 0.004, 0.040, { rotZ: 0.78, color: [0.68, 0.70, 0.74] }); // left corner bevel
      bMetal.addBox(0.016, 0.122, 0.008, 0.008, 0.004, 0.040, { rotZ: -0.78, color: [0.68, 0.70, 0.74] }); // right corner bevel
      bMetal.addCylinder(0.024, 0.094, 0.004, 0.0045, 0.0045, 0.005, 8, { axis: 'x' }); // windage dial
      // Crystal-clear subtle cyan optic lens (zero emissive pink wash!) + pinpoint glowing holographic reticle
      bLens.addBox(0, 0.106, -0.002, 0.034, 0.031, 0.0015);
      bRet.addBox(0, 0.106, 0.0, 0.0020, 0.0020, 0.0015); // crisp pinpoint red center dot
      bRet.addBox(0, 0.114, 0.0, 0.0010, 0.0032, 0.0015);
      bRet.addBox(0, 0.098, 0.0, 0.0010, 0.0032, 0.0015);
      bRet.addBox(-0.008, 0.106, 0.0, 0.0032, 0.0010, 0.0015);
      bRet.addBox(0.008, 0.106, 0.0, 0.0032, 0.0010, 0.0015);
      // Animated bolt carrier + ambidextrous T-charging handle
      bBolt.addBox(0.016, 0.038, -0.025, 0.011, 0.016, 0.070, { color: [0.76, 0.78, 0.82] });
      bBolt.addBeveledBox(0, 0.056, 0.098, 0.048, 0.010, 0.014, 0.002, { color: [0.72, 0.74, 0.78] });
      // Animated detachable curved FDE PMAG magazine with witness window & brass top round
      bMag.addBeveledBox(0, -0.095, -0.078, 0.027, 0.115, 0.056, 0.004, { color: [0.82, 0.75, 0.65] });
      bMag.addBeveledBox(0, -0.175, -0.094, 0.026, 0.088, 0.054, 0.004, { rotX: 0.20, color: [0.80, 0.73, 0.63] });
      bMag.addBox(0, -0.215, -0.104, 0.030, 0.013, 0.060, { rotX: 0.20, color: [0.30, 0.30, 0.32] });
      bMagAlt.addCylinder(0, -0.036, -0.078, 0.0048, 0.0042, 0.044, 8, { axis: 'z' });
      rig.pivots.mag = [0, -0.05, -0.08];
    } else if (style === 'ak74m') {
      // --- RU AK-74M ---
      // Stamped steel receiver + ribbed top dust cover + left dovetail mount
      bDark.addBeveledBox(0, 0.024, -0.01, 0.040, 0.054, 0.24, 0.004, { color: [0.68, 0.70, 0.74] });
      bMetal.addBeveledBox(0, 0.056, 0.002, 0.035, 0.022, 0.225, 0.006, { color: [0.68, 0.70, 0.74] });
      bMetal.addBox(-0.023, 0.026, 0.015, 0.007, 0.016, 0.105, { color: [0.70, 0.72, 0.76] });
      // Ribbed black polymer lower & upper handguard + gas tube
      bPoly.addBeveledBox(0, 0.018, -0.225, 0.042, 0.034, 0.175, 0.006);
      bPoly.addBeveledBox(0, 0.052, -0.220, 0.034, 0.026, 0.155, 0.005);
      bDark.addCylinder(0, 0.056, -0.33, 0.009, 0.009, 0.11, 10, { axis: 'z' });
      // Barrel + 45-degree gas block + front sight hood + AK-74 zig-zag muzzle brake
      bMetal.addCylinder(0, 0.030, -0.36, 0.0105, 0.0115, 0.45, 14, { axis: 'z', color: [0.68, 0.70, 0.74] });
      bDark.addCylinder(0, 0.012, -0.42, 0.0035, 0.0035, 0.30, 8, { axis: 'z' });
      bMetal.addWedge(0, 0.046, -0.39, 0.022, 0.036, 0.036, { color: [0.68, 0.70, 0.74] });
      bMetal.addBox(0, 0.058, -0.535, 0.020, 0.050, 0.024, { color: [0.68, 0.70, 0.74] });
      bDark.addCylinder(0, 0.030, -0.59, 0.015, 0.014, 0.075, 12, { axis: 'z' });
      addVentRings(bMetal, 0, 0.030, -0.618, -0.568, 0.0165, 3, [0.72, 0.74, 0.78]);
      bMetal.addBox(0, 0.070, -0.125, 0.022, 0.014, 0.056, { color: [0.70, 0.72, 0.76] });
      // Grip, trigger guard, folding polymer stock + RU white ID tape
      bPoly.addBeveledBox(0, -0.075, 0.088, 0.030, 0.106, 0.040, 0.005, { rotX: -0.30 });
      bDark.addBox(0, -0.028, 0.022, 0.014, 0.005, 0.068);
      bMetal.addBox(0, -0.016, 0.032, 0.006, 0.024, 0.007, { rotX: 0.2 });
      bPoly.addBeveledBox(0, 0.006, 0.25, 0.038, 0.095, 0.25, 0.006, { rotX: -0.06 });
      bTape.addBox(0, 0.006, 0.24, 0.041, 0.098, 0.022);
      // Sleek Low-Profile Dovetail OKP-7 Open Reflex Optic (centered at y = 0.126, height = 0.038!)
      bMetal.addBox(-0.026, 0.058, 0.012, 0.008, 0.062, 0.054, { color: [0.68, 0.70, 0.74] });
      bMetal.addBeveledBox(-0.010, 0.094, 0.012, 0.038, 0.012, 0.062, 0.002, { color: [0.68, 0.70, 0.74] });
      bDark.addBeveledBox(0, 0.104, 0.012, 0.036, 0.009, 0.056, 0.002);
      bMetal.addBeveledBox(-0.018, 0.126, 0.006, 0.0045, 0.036, 0.016, 0.0012, { color: [0.68, 0.70, 0.74] });
      bMetal.addBeveledBox(0.018, 0.126, 0.006, 0.0045, 0.036, 0.016, 0.0012, { color: [0.68, 0.70, 0.74] });
      bMetal.addBeveledBox(0, 0.143, 0.006, 0.038, 0.0045, 0.016, 0.0012, { color: [0.68, 0.70, 0.74] });
      bLens.addBox(0, 0.126, 0.006, 0.032, 0.030, 0.0015);
      // Pinpoint glowing green OKP-7 chevron reticle
      bRet.addBox(-0.0038, 0.124, 0.008, 0.0072, 0.0016, 0.0015, { rotZ: 0.65 });
      bRet.addBox(0.0038, 0.124, 0.008, 0.0072, 0.0016, 0.0015, { rotZ: -0.65 });
      bRet.addBox(0, 0.127, 0.008, 0.0020, 0.0020, 0.0015);
      // Animated right-side bolt carrier + hooked charging handle
      bBolt.addBox(0.020, 0.040, -0.022, 0.012, 0.018, 0.075, { color: [0.76, 0.78, 0.82] });
      bBolt.addBox(0.036, 0.042, -0.034, 0.024, 0.009, 0.012, { rotZ: 0.25, color: [0.76, 0.78, 0.82] });
      // Animated curved bakelite 5.45 magazine
      bMag.addBeveledBox(0, -0.082, -0.088, 0.029, 0.105, 0.056, 0.004, { rotX: 0.10 });
      bMag.addBeveledBox(0, -0.172, -0.118, 0.028, 0.105, 0.054, 0.004, { rotX: 0.34 });
      bMag.addBox(0, -0.220, -0.136, 0.032, 0.012, 0.060, { rotX: 0.34, color: [0.22, 0.22, 0.24] });
      bMagAlt.addCylinder(0, -0.028, -0.082, 0.0046, 0.004, 0.044, 8, { axis: 'z' });
      rig.pivots.mag = [0, -0.03, -0.09];
    } else if (style === 'm249') {
      // --- UA M249 SAW ---
      // Heavy squared stamped receiver + hydraulic buffer housing
      bDark.addBeveledBox(0, 0.028, -0.02, 0.064, 0.078, 0.31, 0.006);
      bMetal.addBox(0, -0.018, -0.10, 0.054, 0.024, 0.11); // mag/box hanger
      // Perforated heat shield & heavy quick-change barrel + carry handle
      bMetal.addBeveledBox(0, 0.020, -0.30, 0.056, 0.056, 0.28, 0.007, { color: [0.64, 0.66, 0.68] });
      bPoly.addBeveledBox(0, -0.006, -0.29, 0.060, 0.034, 0.24, 0.006);
      bDark.addCylinder(0, 0.044, -0.44, 0.015, 0.016, 0.54, 14, { axis: 'z' });
      bMetal.addCylinder(0, 0.018, -0.40, 0.012, 0.012, 0.32, 10, { axis: 'z' }); // gas regulator cylinder
      bMetal.addBox(0, 0.070, -0.56, 0.022, 0.044, 0.022); // tall front sight post
      bDark.addCylinder(0, 0.044, -0.71, 0.019, 0.016, 0.068, 12, { axis: 'z' }); // birdcage flash hider
      // Folded steel bipod legs under handguard
      bMetal.addCylinder(-0.024, -0.028, -0.35, 0.007, 0.007, 0.28, 8, { axis: 'z' });
      bMetal.addCylinder(0.024, -0.028, -0.35, 0.007, 0.007, 0.28, 8, { axis: 'z' });
      // Pistol grip + tubular Para stock + UA yellow tape
      bPoly.addBeveledBox(0, -0.082, 0.12, 0.034, 0.115, 0.044, 0.005, { rotX: -0.28 });
      bDark.addCylinder(-0.016, 0.042, 0.24, 0.009, 0.009, 0.23, 8, { axis: 'z' });
      bDark.addCylinder(0.016, 0.042, 0.24, 0.009, 0.009, 0.23, 8, { axis: 'z' });
      bPoly.addBeveledBox(0, 0.018, 0.34, 0.052, 0.118, 0.042, 0.006);
      bTape.addBox(0, 0.022, -0.20, 0.062, 0.062, 0.022);
      // Exposed linked brass 5.56 belt draping from left side of feed tray
      for (let i = 0; i < 6; i++) {
        const yOff = 0.032 - i * 0.016;
        const xOff = -0.034 - i * 0.006;
        bBrass.addCylinder(xOff, yOff, -0.085, 0.0046, 0.0042, 0.048, 8, { axis: 'z' });
      }
      // Animated hinged top feed cover with Picatinny rail + Elcan/Red-Dot optic
      bCover.addBeveledBox(0, 0.080, -0.025, 0.058, 0.024, 0.25, 0.005, { color: [0.55, 0.58, 0.62] });
      addPicatinnyRail(bCover, 0, 0.095, -0.12, 0.075, 0.024, 10, [0.75, 0.78, 0.80]);
      // Rugged LMG optic mounted on cover (centered at y = 0.168)
      bCover.addBox(0, 0.118, 0.01, 0.036, 0.026, 0.092, { color: [0.46, 0.48, 0.42] });
      bCover.addCylinder(0, 0.166, 0.01, 0.028, 0.028, 0.115, 14, { axis: 'z', openEnded: true, color: [0.46, 0.48, 0.42] });
      bLens.addCylinder(0, 0.168, -0.02, 0.022, 0.022, 0.004, 14, { axis: 'z' });
      bRet.addBox(0, 0.168, -0.018, 0.0034, 0.0034, 0.002);
      rig.pivots.cover = [0, 0.078, -0.15];
      // Animated right-side charging handle
      bBolt.addBox(0.038, 0.044, -0.01, 0.020, 0.016, 0.046, { color: [0.85, 0.85, 0.88] });
      // Animated 100-round olive polymer drum/box mag
      bMag.addBeveledBox(0, -0.105, -0.10, 0.096, 0.145, 0.092, 0.008, { color: [0.42, 0.46, 0.34] });
      bMagAlt.addBox(0, -0.030, -0.10, 0.048, 0.024, 0.068, { color: [0.78, 0.64, 0.28] }); // brass starter belt
      rig.pivots.mag = [0, -0.04, -0.10];
    } else if (style === 'pkm') {
      // --- RU PKM ---
      // Long riveted steel receiver + side charging rail
      bDark.addBeveledBox(0, 0.026, -0.02, 0.062, 0.074, 0.32, 0.005);
      bMetal.addBox(-0.034, 0.028, -0.02, 0.008, 0.046, 0.26, { color: [0.68, 0.70, 0.72] });
      // Fluted heavy barrel + gas piston tube + carry handle + long conical PKM flash hider
      bDark.addCylinder(0, 0.044, -0.45, 0.016, 0.018, 0.56, 14, { axis: 'z' });
      bMetal.addCylinder(0, 0.012, -0.34, 0.014, 0.014, 0.34, 12, { axis: 'z' }); // gas tube
      bWood.addCylinder(0.032, 0.066, -0.25, 0.011, 0.011, 0.085, 10, { axis: 'z', rotY: 0.2 }); // carry handle
      bMetal.addBox(0, 0.076, -0.60, 0.020, 0.048, 0.024); // front sight
      bDark.addCylinder(0, 0.044, -0.75, 0.022, 0.015, 0.088, 12, { axis: 'z' }); // PKM trumpet flash hider
      // Folded steel bipod
      bMetal.addCylinder(-0.024, -0.020, -0.36, 0.007, 0.007, 0.28, 8, { axis: 'z' });
      bMetal.addCylinder(0.024, -0.020, -0.36, 0.007, 0.007, 0.28, 8, { axis: 'z' });
      // Bakelite grip + iconic skeletonized wood PKM stock + white tape
      bWood.addBeveledBox(0, -0.080, 0.125, 0.032, 0.112, 0.042, 0.005, { rotX: -0.28 });
      bWood.addBeveledBox(0, 0.046, 0.25, 0.034, 0.032, 0.23, 0.004);
      bWood.addBeveledBox(0, -0.018, 0.26, 0.032, 0.032, 0.22, 0.004, { rotX: 0.14 });
      bWood.addBeveledBox(0, 0.014, 0.355, 0.038, 0.115, 0.034, 0.005);
      bTape.addBox(0, 0.046, 0.25, 0.038, 0.036, 0.028);
      // Exposed linked 7.62x54R brass belt feeding from RIGHT side (authentic PKM!)
      for (let i = 0; i < 6; i++) {
        bBrass.addCylinder(0.036 + i * 0.006, 0.028 - i * 0.016, -0.095, 0.0055, 0.0048, 0.056, 8, { axis: 'z' });
      }
      // Animated hinged top feed cover + rear iron sight leaf (y = 0.128)
      bCover.addBeveledBox(0, 0.076, -0.03, 0.056, 0.026, 0.26, 0.005, { color: [0.52, 0.54, 0.56] });
      bCover.addBox(0, 0.112, 0.055, 0.024, 0.032, 0.028, { color: [0.72, 0.74, 0.76] });
      bRet.addBox(0, 0.128, -0.59, 0.004, 0.006, 0.004); // luminous tritium front dot
      rig.pivots.cover = [0, 0.076, -0.16];
      // Animated right charging handle
      bBolt.addBox(0.038, 0.038, 0.01, 0.022, 0.014, 0.036, { color: [0.85, 0.85, 0.88] });
      // Animated 100-rd olive steel PKM ammo box beneath receiver
      bMag.addBeveledBox(0, -0.105, -0.105, 0.092, 0.145, 0.105, 0.006, { color: [0.34, 0.40, 0.30] });
      bMagAlt.addBox(0.028, -0.028, -0.105, 0.036, 0.022, 0.072, { color: [0.82, 0.68, 0.28] });
      rig.pivots.mag = [0, -0.04, -0.105];
    } else if (style === 'm24') {
      // --- UA M24 SWS (Bolt-Action Sniper) ---
      // Remington 700 cylindrical steel receiver
      bDark.addCylinder(0, 0.048, -0.02, 0.020, 0.020, 0.23, 14, { axis: 'z' });
      // Heavy free-floating bull barrel + tactical muzzle brake
      bDark.addCylinder(0, 0.048, -0.45, 0.013, 0.016, 0.64, 16, { axis: 'z' });
      bMetal.addBeveledBox(0, 0.048, -0.78, 0.028, 0.024, 0.058, 0.003); // multi-baffle brake
      // Ergonomic olive-drab HS Precision sniper stock & cheek riser
      bAcc.addBeveledBox(0, 0.010, -0.16, 0.046, 0.048, 0.44, 0.010); // forend
      bAcc.addBeveledBox(0, -0.024, 0.11, 0.038, 0.068, 0.14, 0.008, { rotX: -0.35 }); // grip wrist
      bAcc.addBeveledBox(0, 0.002, 0.28, 0.044, 0.096, 0.26, 0.008); // buttstock
      bPoly.addBeveledBox(0, 0.056, 0.25, 0.042, 0.032, 0.13, 0.008); // cheek weld pad
      bTape.addBox(0, 0.010, -0.26, 0.050, 0.052, 0.022); // UA blue/yellow tape
      // Folded Harris bipod beneath forend
      bMetal.addCylinder(-0.020, -0.022, -0.30, 0.007, 0.007, 0.20, 8, { axis: 'z' });
      bMetal.addCylinder(0.020, -0.022, -0.30, 0.007, 0.007, 0.20, 8, { axis: 'z' });
      // Picatinny scope base + heavy scope rings + high-magnification Leupold M3A Mil-Dot Scope
      addPicatinnyRail(bMetal, 0, 0.070, -0.11, 0.075, 0.024, 10, [0.7, 0.72, 0.74]);
      bMetal.addCylinder(0, 0.122, -0.07, 0.022, 0.022, 0.024, 14, { axis: 'z' }); // front ring
      bMetal.addCylinder(0, 0.122, 0.05, 0.022, 0.022, 0.024, 14, { axis: 'z' });  // rear ring
      bDark.addCylinder(0, 0.122, -0.02, 0.018, 0.018, 0.30, 16, { axis: 'z' });   // main scope tube
      bDark.addCylinder(0, 0.122, -0.18, 0.028, 0.019, 0.095, 16, { axis: 'z' });  // objective bell
      bDark.addCylinder(0, 0.122, 0.13, 0.023, 0.019, 0.075, 16, { axis: 'z' });   // ocular bell
      bMetal.addCylinder(0, 0.146, -0.01, 0.010, 0.010, 0.022, 12, { axis: 'y' }); // elevation turret
      bMetal.addCylinder(0.024, 0.122, -0.01, 0.010, 0.010, 0.022, 12, { axis: 'x' }); // windage turret
      bLens.addCylinder(0, 0.122, 0.165, 0.019, 0.019, 0.004, 14, { axis: 'z' });
      // Animated rotating/sliding cylindrical bolt + oversized tactical bolt knob
      bBolt.addCylinder(0, 0.048, 0.01, 0.013, 0.013, 0.14, 12, { axis: 'z', color: [0.92, 0.94, 0.96] });
      bBolt.addCylinder(0.026, 0.042, 0.056, 0.0045, 0.0045, 0.042, 8, { axis: 'x', rotZ: -0.35, color: [0.85, 0.87, 0.90] });
      bBolt.addSphere(0.052, 0.032, 0.056, 0.011, 10, 8, { color: [0.35, 0.37, 0.40] });
      rig.pivots.bolt = [0, 0.048, 0.04];
      // Animated detachable 5-round steel sniper box mag
      bMag.addBeveledBox(0, -0.055, -0.072, 0.028, 0.088, 0.078, 0.004, { color: [0.32, 0.34, 0.36] });
      bMagAlt.addCylinder(0, -0.008, -0.072, 0.0054, 0.0046, 0.062, 8, { axis: 'z' });
      rig.pivots.mag = [0, -0.02, -0.072];
    } else if (style === 'svd') {
      // --- RU SVD Dragunov ---
      // Long milled slim receiver + top dust cover
      bDark.addBeveledBox(0, 0.030, -0.02, 0.036, 0.052, 0.27, 0.004);
      bMetal.addBeveledBox(0, 0.060, -0.01, 0.032, 0.018, 0.23, 0.005);
      // Iconic vented laminated wood handguard
      bWood.addBeveledBox(0, 0.032, -0.27, 0.038, 0.046, 0.26, 0.008);
      for (let i = 0; i < 5; i++) {
        bDark.addBox(0, 0.034, -0.19 - i * 0.042, 0.040, 0.012, 0.018); // vent slots
      }
      // Very long slender barrel + gas block + iconic slotted Dragunov flash hider
      bDark.addCylinder(0, 0.042, -0.49, 0.010, 0.012, 0.62, 14, { axis: 'z' });
      bMetal.addBox(0, 0.056, -0.44, 0.018, 0.032, 0.028);
      bMetal.addBox(0, 0.066, -0.71, 0.018, 0.046, 0.024);
      bDark.addCylinder(0, 0.042, -0.78, 0.013, 0.012, 0.092, 12, { axis: 'z' });
      // Iconic skeletonized wooden thumbhole stock with leather cheek pad
      bWood.addBeveledBox(0, -0.064, 0.115, 0.028, 0.096, 0.042, 0.005, { rotX: -0.28 });
      bWood.addBeveledBox(0, 0.036, 0.25, 0.030, 0.028, 0.24, 0.004);
      bWood.addBeveledBox(0, -0.026, 0.25, 0.028, 0.026, 0.23, 0.004, { rotX: 0.16 });
      bWood.addBeveledBox(0, 0.008, 0.36, 0.034, 0.108, 0.034, 0.005);
      bPoly.addBeveledBox(0, 0.062, 0.25, 0.036, 0.028, 0.12, 0.007); // cheek rest
      bTape.addBox(0, 0.036, 0.26, 0.034, 0.032, 0.024);
      // Iconic PSO-1 side-mounted Soviet illuminated sniper scope
      bMetal.addBox(-0.022, 0.062, 0.02, 0.009, 0.076, 0.088);
      bMetal.addBox(-0.010, 0.100, 0.02, 0.034, 0.018, 0.088);
      bMetal.addCylinder(0, 0.124, -0.01, 0.017, 0.017, 0.28, 16, { axis: 'z', color: [0.62, 0.65, 0.66] });
      bMetal.addCylinder(0, 0.124, -0.155, 0.021, 0.018, 0.065, 14, { axis: 'z', color: [0.58, 0.62, 0.64] });
      bPoly.addCylinder(0, 0.124, 0.155, 0.022, 0.018, 0.075, 14, { axis: 'z' }); // rubber eyecup
      bMetal.addCylinder(0, 0.146, 0.01, 0.009, 0.009, 0.020, 12, { axis: 'y' });
      bLens.addCylinder(0, 0.124, 0.175, 0.016, 0.016, 0.004, 14, { axis: 'z' });
      // Animated right bolt carrier
      bBolt.addBox(0.018, 0.044, -0.02, 0.012, 0.018, 0.082, { color: [0.92, 0.92, 0.94] });
      bBolt.addBox(0.034, 0.044, -0.03, 0.022, 0.008, 0.012, { color: [0.92, 0.92, 0.94] });
      // Animated short 10-round stamped steel waffle magazine
      bMag.addBeveledBox(0, -0.068, -0.095, 0.027, 0.102, 0.082, 0.004, { rotX: 0.08, color: [0.36, 0.38, 0.40] });
      bMagAlt.addCylinder(0, -0.014, -0.095, 0.0055, 0.0048, 0.062, 8, { axis: 'z' });
      rig.pivots.mag = [0, -0.02, -0.095];
    } else if (style === 'm870') {
      // --- UA M870 Tactical (Pump Shotgun) ---
      // Rounded steel shotgun receiver + side shell saddle holding 4 red shells!
      bDark.addBeveledBox(0, 0.034, -0.01, 0.042, 0.060, 0.22, 0.008);
      bPoly.addBox(-0.024, 0.032, -0.01, 0.008, 0.038, 0.13); // side saddle carrier
      for (let i = 0; i < 4; i++) {
        const zS = -0.055 + i * 0.028;
        bAcc.addCylinder(-0.031, 0.036, zS, 0.009, 0.009, 0.046, 10, { axis: 'y', color: [0.78, 0.14, 0.12] });
        bBrass.addCylinder(-0.031, 0.012, zS, 0.0095, 0.0095, 0.014, 10, { axis: 'y' });
      }
      // Top rail + ghost-ring iron sights
      addPicatinnyRail(bMetal, 0, 0.067, -0.10, 0.075, 0.022, 9, [0.72, 0.74, 0.76]);
      bMetal.addCylinder(0, 0.095, 0.062, 0.012, 0.012, 0.010, 12, { axis: 'z', openEnded: true }); // ghost ring
      bMetal.addBox(0, 0.084, -0.62, 0.014, 0.028, 0.018); // front blade
      bRet.addBox(0, 0.098, -0.62, 0.0045, 0.0045, 0.0045); // bright fiber-optic bead
      // Heavy 12ga barrel + underbarrel tubular magazine + barrel clamp + breacher choke
      bDark.addCylinder(0, 0.052, -0.39, 0.0145, 0.015, 0.56, 16, { axis: 'z' });
      bMetal.addCylinder(0, 0.016, -0.36, 0.013, 0.013, 0.50, 14, { axis: 'z' }); // mag tube
      bMetal.addBox(0, 0.034, -0.55, 0.032, 0.052, 0.022); // clamp
      bDark.addCylinder(0, 0.052, -0.67, 0.017, 0.016, 0.042, 12, { axis: 'z' }); // toothed breacher muzzle
      // Tactical shotgun stock & pistol grip wrist + UA tape
      bPoly.addBeveledBox(0, -0.032, 0.13, 0.036, 0.068, 0.12, 0.008, { rotX: -0.38 });
      bPoly.addBeveledBox(0, -0.004, 0.28, 0.042, 0.102, 0.24, 0.008);
      bTape.addBox(0, -0.004, 0.26, 0.046, 0.105, 0.022);
      // Animated chrome shotgun bolt visible through right ejection port
      bBolt.addBox(0.018, 0.042, -0.02, 0.010, 0.022, 0.072, { color: [0.94, 0.94, 0.96] });
      // Animated ribbed pump forend (uses mag slot for pump slide motion!)
      bMag.addCylinder(0, 0.016, -0.28, 0.024, 0.024, 0.185, 14, { axis: 'z', color: [0.24, 0.24, 0.26] });
      addVentRings(bMag, 0, 0.016, -0.355, -0.205, 0.0255, 8, [0.30, 0.30, 0.33]);
      // Individual red 12ga shell for hand-insertion reload animation
      bShell.addCylinder(0, 0, 0, 0.0095, 0.0095, 0.054, 12, { axis: 'z', color: [0.86, 0.14, 0.12] });
      bShell.addCylinder(0, 0, 0.028, 0.0102, 0.0102, 0.015, 12, { axis: 'z', color: [0.92, 0.76, 0.32] });
    } else if (style === 'saiga12') {
      // --- RU Saiga-12K (Box-Mag Semi-Auto 12ga) ---
      bDark.addBeveledBox(0, 0.026, -0.01, 0.044, 0.060, 0.24, 0.005);
      bMetal.addBeveledBox(0, 0.062, 0.002, 0.040, 0.024, 0.22, 0.006);
      // Chunky shotgun polymer handguard + massive gas tube + wide 12ga barrel + breacher brake
      bPoly.addBeveledBox(0, 0.028, -0.23, 0.048, 0.056, 0.20, 0.007);
      bDark.addCylinder(0, 0.036, -0.38, 0.0155, 0.016, 0.38, 16, { axis: 'z' });
      bMetal.addCylinder(0, 0.062, -0.31, 0.013, 0.013, 0.14, 12, { axis: 'z' });
      bMetal.addBeveledBox(0, 0.036, -0.57, 0.034, 0.034, 0.056, 0.004); // GK-01 slotted shotgun compensator
      // Pistol grip, folding stock + RU white tape
      bPoly.addBeveledBox(0, -0.075, 0.092, 0.032, 0.106, 0.042, 0.005, { rotX: -0.30 });
      bPoly.addBeveledBox(0, 0.008, 0.25, 0.040, 0.096, 0.24, 0.006);
      bTape.addBox(0, 0.008, 0.24, 0.044, 0.100, 0.024);
      // Side rail + compact reflex red-dot (y = 0.146)
      bMetal.addBox(-0.026, 0.066, 0.01, 0.009, 0.068, 0.068);
      bMetal.addBox(-0.010, 0.104, 0.01, 0.042, 0.016, 0.072);
      bDark.addCylinder(0, 0.144, 0.01, 0.023, 0.023, 0.068, 14, { axis: 'z', openEnded: true });
      bLens.addCylinder(0, 0.144, -0.01, 0.019, 0.019, 0.003, 14, { axis: 'z' });
      bRet.addBox(0, 0.146, -0.008, 0.0038, 0.0038, 0.002);
      // Bolt carrier
      bBolt.addBox(0.022, 0.044, -0.02, 0.014, 0.020, 0.078, { color: [0.92, 0.92, 0.95] });
      bBolt.addBox(0.038, 0.046, -0.032, 0.024, 0.010, 0.012, { color: [0.92, 0.92, 0.95] });
      // Massive chunky 8-round 12ga polymer box magazine with red shell peeking out top!
      bMag.addBeveledBox(0, -0.108, -0.094, 0.038, 0.185, 0.078, 0.005, { rotX: 0.12, color: [0.22, 0.23, 0.25] });
      bMagAlt.addCylinder(0, -0.015, -0.088, 0.0095, 0.0095, 0.056, 10, { axis: 'z', color: [0.85, 0.14, 0.12] });
      rig.pivots.mag = [0, -0.03, -0.09];
    } else if (style === 'm320') {
      // --- UA M320 GLM (40mm Break-Open Side-Swing Launcher) ---
      // Compact polymer receiver & grip housing
      bPoly.addBeveledBox(0, 0.018, 0.02, 0.052, 0.068, 0.14, 0.007);
      bPoly.addBeveledBox(0, -0.074, 0.052, 0.034, 0.105, 0.044, 0.005, { rotX: -0.24 });
      bPoly.addBeveledBox(0, -0.072, -0.21, 0.030, 0.098, 0.036, 0.005, { rotX: 0.14 }); // foldable vertical foregrip
      // Collapsible twin-rod shoulder stock + UA yellow tape
      bMetal.addCylinder(-0.018, 0.024, 0.20, 0.007, 0.007, 0.24, 8, { axis: 'z' });
      bMetal.addCylinder(0.018, 0.024, 0.20, 0.007, 0.007, 0.24, 8, { axis: 'z' });
      bPoly.addBeveledBox(0, 0.005, 0.32, 0.048, 0.105, 0.032, 0.006);
      bTape.addBox(0, 0.018, 0.04, 0.056, 0.070, 0.020);
      // Leaf ladder range sight (aligned at y = 0.132)
      bMetal.addBox(-0.034, 0.088, -0.04, 0.008, 0.072, 0.018);
      bMetal.addBox(0, 0.126, -0.04, 0.042, 0.008, 0.012);
      bRet.addBox(0, 0.132, -0.04, 0.0045, 0.0045, 0.004);
      // Animated side-swinging 40mm rifled launcher barrel (pivots open via cover!)
      bCover.addCylinder(0, 0.032, -0.23, 0.027, 0.027, 0.34, 16, { axis: 'z', color: [0.36, 0.38, 0.42] });
      bCover.addCylinder(0, 0.032, -0.40, 0.029, 0.029, 0.028, 16, { axis: 'z', color: [0.28, 0.30, 0.32] });
      addPicatinnyRail(bCover, 0, 0.062, -0.34, -0.09, 0.022, 9, [0.58, 0.60, 0.64]);
      rig.pivots.cover = [-0.028, 0.032, -0.30];
      // Gold-tipped 40mm HEDP grenade round for breech loading animation
      bShell.addCylinder(0, 0, 0.015, 0.020, 0.020, 0.052, 14, { axis: 'z', color: [0.34, 0.40, 0.28] });
      bShell.addSphere(0, 0, -0.016, 0.0195, 12, 10, { color: [0.92, 0.74, 0.22] }); // gold HEDP nose cone
    } else if (style === 'rg6') {
      // --- RU RG-6 6-Shot Revolving 40mm Grenade Launcher ---
      // Heavy frame bridge & pistol grip + telescoping buttstock
      bDark.addBeveledBox(0, 0.094, -0.14, 0.046, 0.024, 0.36, 0.005);
      bDark.addBeveledBox(0, 0.022, 0.02, 0.056, 0.096, 0.068, 0.006); // rear shield
      bPoly.addBeveledBox(0, -0.075, 0.088, 0.032, 0.106, 0.042, 0.005, { rotX: -0.26 });
      bPoly.addBeveledBox(0, -0.064, -0.28, 0.030, 0.095, 0.036, 0.005, { rotX: 0.12 }); // foregrip
      // Front short 40mm barrel + quadrant sight
      bDark.addCylinder(0, 0.042, -0.38, 0.028, 0.028, 0.20, 16, { axis: 'z' });
      bMetal.addBox(0, 0.128, -0.04, 0.026, 0.046, 0.016);
      bRet.addBox(0, 0.145, -0.35, 0.0045, 0.0045, 0.0045);
      // Buttstock rods + pad + RU white tape
      bMetal.addCylinder(-0.018, 0.026, 0.20, 0.008, 0.008, 0.24, 8, { axis: 'z' });
      bMetal.addCylinder(0.018, 0.026, 0.20, 0.008, 0.008, 0.24, 8, { axis: 'z' });
      bPoly.addBeveledBox(0, 0.006, 0.32, 0.048, 0.108, 0.034, 0.006);
      bTape.addBox(0, 0.094, -0.02, 0.050, 0.028, 0.024);
      // Animated 6-chamber revolving 40mm cylinder drum (uses cover slot for rotation & swing!)
      bCover.addCylinder(0, 0.012, -0.14, 0.068, 0.068, 0.165, 18, { axis: 'z', color: [0.32, 0.34, 0.36] });
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        const cx = Math.cos(ang) * 0.040;
        const cy = 0.012 + Math.sin(ang) * 0.040;
        bCover.addCylinder(cx, cy, -0.14, 0.020, 0.020, 0.172, 10, { axis: 'z', color: [0.22, 0.24, 0.26] });
        // Visible VOG-25 noses inside cylinder chambers
        bCover.addSphere(cx, cy, -0.228, 0.015, 8, 6, { color: [0.46, 0.48, 0.36] });
      }
      rig.pivots.cover = [0, 0.012, -0.14];
      // VOG-25 caseless grenade for reload animation
      bShell.addCylinder(0, 0, 0, 0.019, 0.019, 0.072, 12, { axis: 'z', color: [0.40, 0.44, 0.32] });
      bShell.addSphere(0, 0, -0.036, 0.018, 10, 8, { color: [0.28, 0.30, 0.32] });
    } else if (style === 'rpg7') {
      // --- RPG-7V2 Anti-Tank Launcher (Sleek Authentic Proportions — Zero FOV Obstruction!) ---
      // Seamless steel 40mm launch tube (r=0.021) + flared rear venturi bell (rBot=0.021 -> rTop=0.035 at rear +Z)
      bDark.addCylinder(0, 0.032, -0.08, 0.021, 0.021, 0.80, 16, { axis: 'z' });
      bDark.addCylinder(0, 0.032, 0.38, 0.035, 0.021, 0.14, 16, { axis: 'z' }); // rear venturi blast bell
      bMetal.addCylinder(0, 0.032, -0.48, 0.0245, 0.023, 0.030, 16, { axis: 'z' }); // muzzle indexing collar
      // Slender ribbed wooden heat shield (r=0.027) + blued steel clamp bands
      bWood.addCylinder(0, 0.032, -0.03, 0.027, 0.027, 0.32, 16, { axis: 'z' });
      addVentRings(bDark, 0, 0.032, -0.18, 0.11, 0.0285, 5, [0.42, 0.44, 0.46]);
      // Compact front trigger grip + rear support grip + firing mechanism block
      bWood.addBeveledBox(0, -0.070, -0.16, 0.026, 0.094, 0.036, 0.005, { rotX: -0.20 });
      bPoly.addBeveledBox(0, -0.070, 0.02, 0.026, 0.088, 0.034, 0.005, { rotX: 0.15 });
      bDark.addBeveledBox(0, -0.014, -0.16, 0.028, 0.034, 0.088, 0.004);
      bTape.addCylinder(0, 0.032, 0.18, 0.0225, 0.0225, 0.024, 14, { axis: 'z' }); // neat faction tape wrap
      // Low-profile fold-up iron sights + sleek tucked PGO-7V optical scope mount
      bMetal.addBox(0, 0.074, -0.42, 0.009, 0.044, 0.012); // slim front sight post
      bMetal.addBox(0, 0.074, -0.10, 0.018, 0.042, 0.010); // slim rear sight frame
      bMetal.addBeveledBox(-0.025, 0.068, -0.05, 0.008, 0.046, 0.042, 0.002); // side dovetail arm
      bDark.addCylinder(-0.026, 0.096, -0.05, 0.014, 0.014, 0.118, 14, { axis: 'z' }); // PGO-7V body
      bPoly.addCylinder(-0.026, 0.096, 0.018, 0.016, 0.013, 0.028, 12, { axis: 'z' }); // rubber eyecup
      bMetal.addCylinder(-0.026, 0.096, -0.114, 0.016, 0.015, 0.022, 12, { axis: 'z' }); // objective bezel
      bRet.addBox(0, 0.098, -0.42, 0.0036, 0.0036, 0.003);
      // Animated PROTRUDING PG-7VL Tandem HEAT Warhead (tapered accurately: -Z = front nose, +Z = booster!)
      bWarhead.addCylinder(0, 0.032, -0.51, 0.016, 0.016, 0.095, 14, { axis: 'z', color: [0.36, 0.42, 0.28] }); // booster neck
      bWarhead.addCylinder(0, 0.032, -0.585, 0.018, 0.036, 0.075, 16, { axis: 'z', color: [0.30, 0.37, 0.24] }); // rear flare cone
      bWarhead.addCylinder(0, 0.032, -0.665, 0.036, 0.017, 0.105, 16, { axis: 'z', color: [0.32, 0.39, 0.25] }); // front ogive nose
      bWarhead.addCylinder(0, 0.032, -0.745, 0.011, 0.0065, 0.075, 12, { axis: 'z', color: [0.24, 0.28, 0.20] }); // standoff probe
      bWarheadBrass.addCylinder(0, 0.032, -0.622, 0.0372, 0.0372, 0.014, 16, { axis: 'z', color: [0.92, 0.78, 0.22] }); // yellow HEAT band
      bWarheadBrass.addSphere(0, 0.032, -0.785, 0.0085, 10, 8, { color: [0.85, 0.65, 0.28] }); // piezoelectric fuse tip
    }

    // Finalize all sub-mesh groups
    addPart(rig.body, bMetal, gl, matMetal);
    addPart(rig.body, bDark, gl, matDarkSteel);
    addPart(rig.body, bPoly, gl, matPolymer);
    addPart(rig.body, bAcc, gl, matAccent);
    addPart(rig.body, bWood, gl, matWood);
    addPart(rig.body, bTape, gl, matTape);
    addPart(rig.body, bBrass, gl, matBrass);
    addPart(rig.body, bLens, gl, matLens);
    addPart(rig.reticle, bRet, gl, matReticle);

    addPart(rig.bolt, bBolt, gl, matMetal);

    const magMat = style === 'ak74m' ? matBakelite : (style === 'm4' ? matAccent : matPolymer);
    addPart(rig.mag, bMag, gl, magMat);
    addPart(rig.mag, bMagAlt, gl, style === 'saiga12' ? makeMat('polymer', [0.85, 0.15, 0.12], 0.45, 0.1) : matBrass);

    addPart(rig.cover, bCover, gl, matDarkSteel);
    addPart(rig.shell, bShell, gl, makeMat('polymer', [0.88, 0.74, 0.30], 0.35, 0.45));
    addPart(rig.warhead, bWarhead, gl, makeMat('armor_ru', [0.34, 0.40, 0.26], 0.56, 0.35));
    addPart(rig.warhead, bWarheadBrass, gl, matBrass);

    return rig;
  }

  // ---------------------------------------------------------------------------
  // Articulated Left & Right Tactical Forearms + Gloved Hands (UA & RU)
  // Local space of hand rig: origin (0,0,0) = center of palm grip;
  // forearm extends backward along +Z / slightly down & outward so sleeves NEVER detach!
  // ---------------------------------------------------------------------------
  function buildArmRig(gl, faction, side) {
    const isLeft = side === 'left';
    const sx = isLeft ? -1 : 1;
    const isUA = faction !== 'RU';

    const matSleeve = makeMat(
      isUA ? 'uniform_ua' : 'uniform_ru',
      isUA ? [0.76, 0.74, 0.68] : [0.68, 0.72, 0.66],
      0.86,
      0.03,
      { thermalHeat: 0.46 }
    );
    const matGlove = makeMat('polymer', isUA ? [0.62, 0.56, 0.46] : [0.44, 0.48, 0.43], 0.80, 0.05, { uvScale: [3.0, 3.0], thermalHeat: 0.40 });
    const matKnuckle = makeMat('metal_dark', [0.34, 0.36, 0.40], 0.50, 0.38, { thermalHeat: 0.36 });
    const matBand = makeMat(
      'polymer',
      isUA ? [0.18, 0.68, 1.25] : [1.15, 0.22, 0.20],
      0.66,
      0.04,
      { thermalHeat: 0.42 }
    );

    const bSleeve = newBuilder();
    const bGlove = newBuilder();
    const bKnuckle = newBuilder();
    const bBand = newBuilder();

    // Slimmer athletic tapered tactical forearm extending back toward shoulder (rTop=rear elbow, rBot=wrist)
    bSleeve.addCylinder(sx * 0.048, -0.068, 0.245, 0.048, 0.037, 0.35, 16, {
      axis: 'z',
      rotX: -0.25,
      rotY: sx * -0.17
    });
    // Folded ripstop sleeve cuff + compact faction ID wrist band
    bSleeve.addCylinder(sx * 0.014, -0.022, 0.096, 0.040, 0.036, 0.052, 16, {
      axis: 'z',
      rotX: -0.18,
      rotY: sx * -0.12
    });
    bBand.addCylinder(sx * 0.020, -0.028, 0.124, 0.0415, 0.040, 0.022, 16, {
      axis: 'z',
      rotX: -0.18,
      rotY: sx * -0.12
    });

    // Sleek contoured tactical Mechanix/Oakley glove + wrist watch (on left wrist!)
    bGlove.addBeveledBox(sx * 0.004, -0.006, 0.044, 0.058, 0.036, 0.060, 0.008);
    bGlove.addBeveledBox(0, -0.001, -0.004, 0.062, 0.029, 0.064, 0.007);
    // Molded carbon knuckle ridge + velcro strap + tactical matte watch on left wrist
    for (let k = 0; k < 4; k++) {
      bKnuckle.addSphere(-0.020 + k * 0.0135, 0.014, -0.018, 0.0072, 8, 6);
    }
    bKnuckle.addBeveledBox(sx * 0.004, 0.012, -0.016, 0.058, 0.009, 0.018, 0.003);
    bKnuckle.addBeveledBox(sx * 0.004, 0.010, 0.058, 0.060, 0.009, 0.022, 0.002);
    if (isLeft) {
      bKnuckle.addCylinder(-0.012, 0.016, 0.074, 0.014, 0.015, 0.008, 12, { axis: 'y', rotZ: 0.25 }); // G-Shock bezel
    }

    // 4 contoured articulated fingers wrapping cleanly around handguard/grip
    for (let f = 0; f < 4; f++) {
      const fx = (-0.021 + f * 0.014);
      const len = f === 0 || f === 3 ? 0.036 : 0.042;
      bGlove.addCylinder(fx, -0.003, -0.044, 0.0078, 0.0072, len, 10, {
        axis: 'z',
        rotX: 0.40
      });
      bGlove.addCylinder(fx, -0.022, -0.058, 0.0068, 0.0062, 0.026, 10, {
        axis: 'y',
        rotX: -0.24
      });
    }
    // Articulated thumb wrapping inward
    bGlove.addCylinder(-sx * 0.032, 0.007, -0.016, 0.0095, 0.0082, 0.045, 10, {
      axis: 'z',
      rotY: sx * 0.46,
      rotX: 0.14
    });

    const parts = [];
    addPart(parts, bSleeve, gl, matSleeve);
    addPart(parts, bGlove, gl, matGlove);
    addPart(parts, bKnuckle, gl, matKnuckle);
    addPart(parts, bBand, gl, matBand);
    return parts;
  }

  // ---------------------------------------------------------------------------
  // AAA Tapered Multi-Port Muzzle Flash Plumes (zero flat yellow box quads!)
  // ---------------------------------------------------------------------------
  function buildMuzzleFlash(gl) {
    const bCore = newBuilder();
    const bPorts = newBuilder();

    // Narrow incandescent axial core cone (base at +Z near muzzle, tapered tip pointing -Z)
    bCore.addCylinder(0, 0, -0.068, 0.015, 0.0018, 0.135, 10, {
      axis: 'z',
      color: [1.0, 0.96, 0.84],
      aoTop: 1.0,
      aoBottom: 0.25
    });
    // Twin lateral muzzle-brake compensator jets (sleek tapered cones angled ±68° sideways!)
    bPorts.addCylinder(-0.042, 0, -0.026, 0.011, 0.0016, 0.092, 10, {
      axis: 'z',
      rotY: 1.18,
      color: [1.0, 0.68, 0.24],
      aoTop: 0.95,
      aoBottom: 0.18
    });
    bPorts.addCylinder(0.042, 0, -0.026, 0.011, 0.0016, 0.092, 10, {
      axis: 'z',
      rotY: -1.18,
      color: [1.0, 0.68, 0.24],
      aoTop: 0.95,
      aoBottom: 0.18
    });
    // Subtle upper compensator vent jet
    bPorts.addCylinder(0, 0.032, -0.024, 0.0085, 0.0014, 0.065, 8, {
      axis: 'z',
      rotX: 1.12,
      color: [1.0, 0.72, 0.28],
      aoTop: 0.9,
      aoBottom: 0.15
    });

    const coreMesh = safeFinish(bCore, gl);
    const portsMesh = safeFinish(bPorts, gl);
    const coreMat = makeMat('gunmetal', [1.0, 0.96, 0.82], 0.08, 0.0, {
      emissive: [6.4, 4.8, 2.2],
      alpha: 0.88,
      doubleSided: true,
      thermalHeat: 1.0
    });
    const portsMat = makeMat('gunmetal', [1.0, 0.66, 0.22], 0.1, 0.0, {
      emissive: [4.4, 1.9, 0.42],
      alpha: 0.64,
      doubleSided: true,
      thermalHeat: 1.0
    });
    return { mesh: coreMesh, material: coreMat, portsMesh, portsMat };
  }

  // ---------------------------------------------------------------------------
  // 2nd-Order Damped Harmonic Spring Oscillators (tactile AAA weapon feel!)
  // ---------------------------------------------------------------------------
  function createSpring(k, d, minV, maxV) {
    return { x: 0, v: 0, k, d, min: minV, max: maxV };
  }
  function impulseSpring(sp, dv) {
    sp.v += dv;
  }
  function stepSpring(sp, target, dt) {
    const a = sp.k * (target - sp.x) - sp.d * sp.v;
    sp.v += a * dt;
    sp.x += sp.v * dt;
    if (sp.x < sp.min) { sp.x = sp.min; if (sp.v < 0) sp.v *= -0.2; }
    else if (sp.x > sp.max) { sp.x = sp.max; if (sp.v > 0) sp.v *= -0.2; }
    return sp.x;
  }
  function resetSpring(sp) {
    sp.x = 0; sp.v = 0;
  }

  // ---------------------------------------------------------------------------
  // Viewmodel State Machine
  // ---------------------------------------------------------------------------
  const state = {
    initialized: false,
    rigs: Object.create(null), // key: 'UA_0' .. 'RU_5'
    arms: { UA: null, RU: null },
    muzzleFlash: null,

    slot: 0,
    faction: 'UA',
    spec: null,

    // Movement & aiming state
    isAds: false,
    adsProgress: 0,
    isSprint: false,
    sprintProgress: 0,
    vaultProgress: 0,
    wasVaulting: false,
    isCrouching: false,
    moveSpeed: 0,
    grounded: true,
    wasGrounded: true,
    bobPhase: 0,
    swayTargetX: 0,
    swayTargetY: 0,

    // Damped harmonic spring bank
    spKickZ: createSpring(215, 20.5, -0.025, 0.145),
    spKickPitch: createSpring(168, 17.5, -0.065, 0.28),
    spKickYaw: createSpring(145, 16.0, -0.14, 0.14),
    spKickRoll: createSpring(138, 15.5, -0.22, 0.22),
    spSwayX: createSpring(115, 16.5, -0.065, 0.065),
    spSwayY: createSpring(115, 16.5, -0.055, 0.055),
    spLandDip: createSpring(98, 12.5, -0.075, 0.045),
    spBumpY: createSpring(185, 18.0, -0.045, 0.055),
    spBumpPitch: createSpring(175, 17.5, -0.16, 0.18),
    spSprint: createSpring(115, 16.5, -0.08, 1.18),

    // Synchronized footstep stride tracking (1:1 weapon bob <-> camera roll <-> footstep audio)
    strideCount: 0,
    strideSide: 'left',
    strideBobX: 0,
    strideBobY: 0,
    strideCamRoll: 0,
    lastStrideIndex: 0,

    // Equip transition
    equipTimer: 0,
    equipDuration: 0.34,
    pendingSlot: -1,
    pendingFaction: null,

    // Firing & barrel heat smoke wisps
    boltOffset: 0,
    muzzleFlashTimer: 0,
    muzzleFlashRoll: 0,
    barrelHeat: 0,
    barrelWispAccum: 0,
    rg6CylinderAngle: 0,
    rg6CylinderTarget: 0,
    ammoInMag: 30,

    // Post-shot cycle (M870 pump / M24 bolt)
    cycleActive: false,
    cycleTimer: 0,
    cycleDuration: 0.6,
    cycleEjected: false,
    cycleFoleyStage: 0,

    // Reload multi-stage state machine
    reloading: false,
    reloadEmpty: false,
    reloadTimer: 0,
    reloadDuration: 2.2,
    reloadStageFlags: 0,
    reloadStageLabel: '',

    // Cached world positions for muzzle & ejection port
    lastMuzzleWorld: [0, 1.6, 0],
    lastEjectWorld: [0, 1.6, 0],
    lastCamRight: [1, 0, 0],
    lastCamUp: [0, 1, 0],
    lastCamForward: [0, 0, -1],
    lastCamPos: [0, 1.6, 0],

    // Reusable matrices + per-frame draw matrix pool (guarantees distinct Float32Arrays per submitMesh!)
    mCamWorld: null,
    mWeaponRoot: null,
    mLocal: null,
    matPool: [],
    matPoolIdx: 0
  };

  function allocMat() {
    if (state.matPoolIdx >= state.matPool.length) {
      state.matPool.push(DF.Mat4.create());
    }
    return state.matPool[state.matPoolIdx++];
  }

  function emitFoley(stage) {
    if (DF.Audio && typeof DF.Audio.playReloadFoley === 'function') {
      DF.Audio.playReloadFoley(stage, null);
    }
  }

  function spawnShellEjection(casingType) {
    if (!casingType || casingType === 'none') return;
    if (!DF.Ballistics || typeof DF.Ballistics.spawnCasing !== 'function') return;

    const r = state.lastCamRight;
    const u = state.lastCamUp;
    const f = state.lastCamForward;
    const isLeftEject = state.spec && state.spec.geometrySpec.style === 'pkm';
    const sideDir = isLeftEject ? -1 : 1;

    const spdRight = (1.6 + Math.random() * 0.85) * sideDir;
    const spdUp = 1.15 + Math.random() * 0.65;
    const spdFwd = -0.35 + Math.random() * 0.45;

    const vel = [
      r[0] * spdRight + u[0] * spdUp + f[0] * spdFwd,
      r[1] * spdRight + u[1] * spdUp + f[1] * spdFwd,
      r[2] * spdRight + u[2] * spdUp + f[2] * spdFwd
    ];
    const rotVel = [
      (Math.random() * 2 - 1) * 18,
      (Math.random() * 2 - 1) * 14,
      (Math.random() * 2 - 1) * 24
    ];
    DF.Ballistics.spawnCasing(
      [state.lastEjectWorld[0], state.lastEjectWorld[1], state.lastEjectWorld[2]],
      vel,
      rotVel,
      casingType
    );
  }

  function init(gl) {
    if (!gl || !DF.MeshGen || !DF.MeshGen.Builder || !DF.WeaponCatalog) return;
    state.mCamWorld = DF.Mat4.create();
    state.mWeaponRoot = DF.Mat4.create();
    state.mLocal = DF.Mat4.create();
    state.matPool.length = 0;
    for (let i = 0; i < 32; i++) state.matPool.push(DF.Mat4.create());
    state.matPoolIdx = 0;

    for (const fac of ['UA', 'RU']) {
      const list = DF.WeaponCatalog.getSlotList(fac);
      for (let i = 0; i < list.length; i++) {
        state.rigs[fac + '_' + i] = buildWeaponRig(gl, list[i]);
      }
      state.arms[fac] = {
        left: buildArmRig(gl, fac, 'left'),
        right: buildArmRig(gl, fac, 'right')
      };
    }

    state.muzzleFlash = buildMuzzleFlash(gl);
    state.spec = DF.WeaponCatalog.get(0, 'UA');
    state.ammoInMag = state.spec.magSize;
    state.initialized = true;
  }

  function equip(slotIndex, faction) {
    const newSlot = DF.WeaponCatalog ? DF.WeaponCatalog.getSlotIndex(slotIndex) : (slotIndex | 0);
    const newFac = faction === 'RU' ? 'RU' : (faction === 'UA' ? 'UA' : state.faction);
    const same = newSlot === state.slot && newFac === state.faction && state.spec;

    state.slot = newSlot;
    state.faction = newFac;
    state.spec = DF.WeaponCatalog ? DF.WeaponCatalog.get(newSlot, newFac) : state.spec;
    state.reloading = false;
    state.reloadTimer = 0;
    state.reloadStageFlags = 0;
    state.reloadStageLabel = '';
    state.cycleActive = false;
    state.cycleTimer = 0;
    state.boltOffset = 0;
    state.muzzleFlashTimer = 0;
    state.barrelHeat = 0;
    state.rg6CylinderAngle = 0;
    state.rg6CylinderTarget = 0;
    resetSpring(state.spKickZ);
    resetSpring(state.spKickPitch);
    resetSpring(state.spKickYaw);
    resetSpring(state.spKickRoll);
    resetSpring(state.spBumpY);
    resetSpring(state.spBumpPitch);

    if (!same) {
      state.equipTimer = state.equipDuration;
      resetSpring(state.spSprint);
      state.sprintProgress = 0;
      impulseSpring(state.spBumpY, 0.22);
      emitFoley('equip');
    }
  }

  function triggerFire(ammoRemaining) {
    if (!state.spec) return;
    const s = state.spec;
    // Instant crisp snap-to-fire out of tactical sprint!
    if (state.sprintProgress > 0.05) {
      state.sprintProgress *= 0.2;
      state.spSprint.x *= 0.2;
      state.spSprint.v = -4.5;
    }
    const adsScale = lerp(1.0, 0.56, state.adsProgress);
    impulseSpring(state.spKickZ, (s.recoilKick || 0.055) * 28.0 * adsScale);
    impulseSpring(state.spKickPitch, (s.recoilPitch || 0.02) * 34.0 * adsScale);
    impulseSpring(state.spKickYaw, ((Math.random() * 2 - 1) * (s.recoilYaw || 0.01)) * 22.0 * adsScale);
    impulseSpring(state.spKickRoll, ((Math.random() < 0.5 ? -1 : 1) * (s.recoilRoll || 0.025)) * 18.0 * adsScale);

    // Accumulate barrel heat so lazy heat-smoke wisps curl from muzzle after bursts / heavy shots!
    const heatGain = (s.class === 'rpg' || s.class === 'gl' || s.class === 'shotgun' || s.class === 'sniper') ? 0.34 : 0.16;
    state.barrelHeat = clamp(state.barrelHeat + heatGain, 0, 1.0);

    state.muzzleFlashTimer = s.class === 'rpg' ? 0.085 : 0.042;
    state.muzzleFlashRoll = (Math.random() - 0.5) * 0.55;

    // Volumetric muzzle flash burst + high-speed muzzle-brake sparks + hot barrel gas wisps!
    if (DF.Renderer && typeof DF.Renderer.spawnParticle === 'function') {
      const m = state.lastMuzzleWorld;
      const f = state.lastCamForward;
      const r = state.lastCamRight;
      const u = state.lastCamUp;
      const isHeavy = s.class === 'rpg' || s.class === 'shotgun' || s.class === 'sniper';
      const fwdOff = 0.08;
      const p0 = [m[0] + f[0] * fwdOff, m[1] + f[1] * fwdOff, m[2] + f[2] * fwdOff];

      // Organic feathered radial starburst core
      DF.Renderer.spawnParticle({
        type: 'flash',
        pos: p0,
        vel: [f[0] * 1.4, f[1] * 1.4, f[2] * 1.4],
        size: isHeavy ? 0.28 : 0.18,
        sizeEnd: isHeavy ? 0.48 : 0.30,
        life: isHeavy ? 0.065 : 0.042,
        color: [1.0, 0.82, 0.44],
        alpha: 0.88,
        gravity: 0,
        drag: 3.0,
        additive: true
      });

      // 6-8 ultra-fast golden velocity-stretched muzzle sparks
      const sparkN = isHeavy ? 9 : 6;
      for (let i = 0; i < sparkN; i++) {
        const spFwd = 11 + Math.random() * 14;
        const spSide = (Math.random() - 0.5) * (isHeavy ? 10 : 6.5);
        const spUp = (Math.random() - 0.42) * 5.0;
        DF.Renderer.spawnParticle({
          type: 'spark',
          pos: p0,
          vel: [
            f[0] * spFwd + r[0] * spSide + u[0] * spUp,
            f[1] * spFwd + r[1] * spSide + u[1] * spUp,
            f[2] * spFwd + r[2] * spSide + u[2] * spUp
          ],
          size: 0.042 + Math.random() * 0.025,
          sizeEnd: 0.012,
          life: 0.075 + Math.random() * 0.085,
          color: [1.0, 0.82 + Math.random() * 0.15, 0.36],
          alpha: 0.95,
          gravity: 5.5,
          drag: 2.2,
          additive: true
        });
      }

      // Soft translucent barrel propellant smoke + rising heat wisp
      for (let i = 0; i < (isHeavy ? 3 : 2); i++) {
        const sFwd = 1.6 + Math.random() * 2.4;
        const sSide = (Math.random() - 0.5) * 1.2;
        DF.Renderer.spawnParticle({
          type: 'smoke',
          pos: [p0[0] + f[0] * 0.05, p0[1] + f[1] * 0.05, p0[2] + f[2] * 0.05],
          vel: [
            f[0] * sFwd + r[0] * sSide,
            f[1] * sFwd + 0.55 + Math.random() * 0.4,
            f[2] * sFwd + r[2] * sSide
          ],
          size: isHeavy ? 0.16 : 0.09,
          sizeEnd: isHeavy ? 0.65 : 0.38,
          life: 0.45 + Math.random() * 0.35,
          color: [0.76, 0.77, 0.80],
          alpha: isHeavy ? 0.30 : 0.18,
          gravity: -0.45,
          drag: 2.8
        });
      }
    }

    if (typeof ammoRemaining === 'number') {
      state.ammoInMag = ammoRemaining;
    } else if (state.ammoInMag > 0) {
      state.ammoInMag--;
    }

    if (s.geometrySpec.style === 'rg6') {
      state.rg6CylinderTarget += Math.PI / 3;
    }

    // Automatic & semi-auto bolt snap + immediate casing ejection
    if (s.actionType === 'auto' || s.actionType === 'semi') {
      state.boltOffset = 0.075;
      if (s.casingType && s.casingType !== 'none') {
        spawnShellEjection(s.casingType);
      }
    } else if (s.actionType === 'pump' || s.actionType === 'bolt') {
      // Trigger post-shot pump/bolt cycle animation
      state.cycleActive = true;
      state.cycleTimer = 0;
      state.cycleDuration = s.cycleTime || (s.actionType === 'bolt' ? 1.05 : 0.62);
      state.cycleEjected = false;
      state.cycleFoleyStage = 0;
    }
  }

  function triggerReload(isEmpty) {
    if (!state.spec) return;
    state.reloading = true;
    state.reloadEmpty = !!isEmpty;
    state.reloadTimer = 0;
    state.reloadDuration = isEmpty
      ? (state.spec.reloadEmptyTime || 2.8)
      : (state.spec.reloadTacticalTime || 2.2);
    state.reloadStageFlags = 0;
    state.reloadStageLabel = 'MAG OUT';
    state.cycleActive = false;
  }

  function cancelReload() {
    state.reloading = false;
    state.reloadTimer = 0;
    state.reloadStageFlags = 0;
    state.reloadStageLabel = '';
  }

  function setADS(b) { state.isAds = !!b; }
  function setSprint(b) { state.isSprint = !!b; }

  function setMoveState(speed, grounded, swayX, swayY, crouching) {
    state.moveSpeed = speed || 0;
    state.wasGrounded = state.grounded;
    state.grounded = grounded !== undefined ? !!grounded : true;
    if (!state.wasGrounded && state.grounded) {
      impulseSpring(state.spLandDip, -0.42);
      impulseSpring(state.spBumpPitch, -0.32);
    }
    if (typeof swayX === 'number') state.swayTargetX = clamp(state.swayTargetX + swayX * 0.014, -0.06, 0.06);
    if (typeof swayY === 'number') state.swayTargetY = clamp(state.swayTargetY + swayY * 0.012, -0.05, 0.05);
    if (crouching !== undefined) state.isCrouching = !!crouching;
  }

  function update(dt, extState) {
    if (!state.initialized) return;
    const cdt = clamp(dt || 0.016, 0.001, 0.05);

    if (extState) {
      if (extState.slot !== undefined && (extState.slot !== state.slot || (extState.faction && extState.faction !== state.faction))) {
        equip(extState.slot, extState.faction || state.faction);
      }
      if (extState.isAds !== undefined) state.isAds = !!extState.isAds;
      if (extState.ads !== undefined) state.isAds = !!extState.ads;
      if (typeof extState.adsBlend === 'number') state.adsProgress = clamp(extState.adsBlend, 0, 1);
      if (extState.isSprint !== undefined) state.isSprint = !!extState.isSprint;
      if (extState.sprinting !== undefined) state.isSprint = !!extState.sprinting;
      if (extState.sprint !== undefined) state.isSprint = !!extState.sprint;
      if (typeof extState.vaultProgress === 'number') {
        const vp = clamp(extState.vaultProgress, 0, 1);
        if (state.wasVaulting && vp <= 0.001) {
          impulseSpring(state.spLandDip, -0.28);
          impulseSpring(state.spBumpPitch, -0.20);
        }
        state.vaultProgress = vp;
        state.wasVaulting = vp > 0.001;
      } else {
        if (state.wasVaulting) {
          impulseSpring(state.spLandDip, -0.28);
          impulseSpring(state.spBumpPitch, -0.20);
        }
        state.vaultProgress = 0;
        state.wasVaulting = false;
      }
      if (extState.crouching !== undefined) state.isCrouching = !!extState.crouching;
      if (extState.moveSpeed !== undefined) state.moveSpeed = extState.moveSpeed;
      if (extState.speed !== undefined) state.moveSpeed = extState.speed;
      if (extState.grounded !== undefined) {
        if (!state.grounded && extState.grounded) {
          impulseSpring(state.spLandDip, -0.42);
          impulseSpring(state.spBumpPitch, -0.32);
        }
        state.grounded = !!extState.grounded;
      }
      if (extState.ammoInMag !== undefined) state.ammoInMag = extState.ammoInMag;
      if (extState.magAmmo !== undefined) state.ammoInMag = extState.magAmmo;
      if (extState.mag !== undefined) state.ammoInMag = extState.mag;
      if (extState.reloading === false && state.reloading) {
        cancelReload();
      } else if (extState.reloading === true && !state.reloading) {
        triggerReload(!!extState.reloadIsEmpty);
      }
    }

    // ADS & Tactical Sprint damped harmonic blending (weighty sprint entry, instant crisp snap-to-ADS/fire!)
    const targetAds = (state.isAds && !state.reloading && !state.isSprint && state.equipTimer <= 0.05) ? 1 : 0;
    const adsSpeed = state.spec && (state.spec.class === 'sniper' || state.spec.class === 'rpg') ? 9.5 : 13.5;
    state.adsProgress = damp(state.adsProgress, targetAds, adsSpeed, cdt);

    const targetSprint = (state.isSprint && !state.reloading && !state.isAds && state.equipTimer <= 0.08) ? 1 : 0;
    // Snappier stiffness when snapping out of sprint to aim/fire; weighty smooth ramp when raising into sprint
    state.spSprint.k = targetSprint > 0.5 ? 105 : 260;
    state.spSprint.d = targetSprint > 0.5 ? 15.2 : 24.5;
    stepSpring(state.spSprint, targetSprint, cdt);
    state.sprintProgress = clamp(state.spSprint.x, 0, 1);

    // Equip timer
    if (state.equipTimer > 0) {
      state.equipTimer = Math.max(0, state.equipTimer - cdt);
    }

    // Walk & Tactical Sprint stride phase + 1:1 synchronized footstep event emitter
    const gSpec = state.spec && state.spec.geometrySpec;
    const cadence = (gSpec && gSpec.sprintCadence) || 1.0;
    const isActivelyMoving = state.grounded && (state.moveSpeed > 0.55 || (targetSprint > 0.5 && state.sprintProgress > 0.3));
    if (isActivelyMoving) {
      const effSpeed = Math.max(state.moveSpeed, targetSprint > 0.5 ? 6.2 : 0.6);
      const bobFreq = state.sprintProgress > 0.45
        ? (10.4 * cadence)
        : (state.isCrouching ? 5.6 : 7.8);
      state.bobPhase += cdt * bobFreq * clamp(effSpeed / 4.6, 0.45, 1.48);

      // Emit crisp synchronized footstep event every half-stride (each PI crossing = left/right boot impact!)
      const strideIdx = Math.floor((state.bobPhase + 0.35) / Math.PI);
      if (strideIdx !== state.lastStrideIndex) {
        state.lastStrideIndex = strideIdx;
        state.strideCount++;
        state.strideSide = (state.strideCount & 1) ? 'right' : 'left';
        const sprintingNow = state.sprintProgress > 0.45;
        impulseSpring(state.spBumpY, sprintingNow ? -0.135 : -0.048);
        if (DF.Events && typeof DF.Events.emit === 'function') {
          DF.Events.emit('viewmodel:footstep', {
            count: state.strideCount,
            side: state.strideSide,
            isSprint: sprintingNow,
            speed: effSpeed
          });
        }
      }
    } else {
      state.bobPhase += cdt * 1.4; // subtle idle breathing
      state.lastStrideIndex = Math.floor((state.bobPhase + 0.35) / Math.PI);
    }

    // Update synchronized camera/viewmodel stride bob immediately in update() (zero 1-frame lag for main.js camera roll!)
    const adsTNow = smoothstep(0, 1, state.adsProgress);
    const sprClampedNow = state.sprintProgress;
    const sprintStyleNow = (gSpec && gSpec.sprintStyle) || 'tac_high';
    const walkAmpNow = lerp(1.0, 0.14, adsTNow) * (state.moveSpeed > 0.25 ? clamp(state.moveSpeed / 4.5, 0.25, 1.25) : 0.12);
    const walkXNow = Math.cos(state.bobPhase) * 0.011 * walkAmpNow;
    const walkYNow = Math.abs(Math.sin(state.bobPhase)) * -0.012 * walkAmpNow + Math.sin(state.bobPhase * 0.5) * 0.0025;
    const heavyMultNow = sprintStyleNow === 'heavy_low' ? 1.25 : (sprintStyleNow === 'rpg_carry' ? 0.85 : 1.0);
    const sprBobXNow = Math.cos(state.bobPhase) * (sprintStyleNow === 'rpg_carry' ? 0.018 : 0.032) * heavyMultNow;
    const sprBobYNow = (Math.abs(Math.sin(state.bobPhase)) * -0.028 + Math.sin(state.bobPhase * 2.0) * 0.008) * heavyMultNow;
    state.strideBobX = lerp(walkXNow, sprBobXNow, sprClampedNow);
    state.strideBobY = lerp(walkYNow, sprBobYNow, sprClampedNow);
    state.strideCamRoll = -Math.cos(state.bobPhase) * lerp(0.0035 * walkAmpNow, 0.016, sprClampedNow);

    // Step damped harmonic spring oscillators (silky AAA recoil, look sway, jump/land & reload thumps!)
    stepSpring(state.spSwayX, state.swayTargetX, cdt);
    stepSpring(state.spSwayY, state.swayTargetY, cdt);
    state.swayTargetX = damp(state.swayTargetX, 0, 14, cdt);
    state.swayTargetY = damp(state.swayTargetY, 0, 14, cdt);

    stepSpring(state.spLandDip, 0, cdt);
    stepSpring(state.spKickZ, 0, cdt);
    stepSpring(state.spKickPitch, 0, cdt);
    stepSpring(state.spKickYaw, 0, cdt);
    stepSpring(state.spKickRoll, 0, cdt);
    stepSpring(state.spBumpY, 0, cdt);
    stepSpring(state.spBumpPitch, 0, cdt);

    // Bolt snap return
    state.boltOffset = damp(state.boltOffset, 0, 32, cdt);
    state.rg6CylinderAngle = damp(state.rg6CylinderAngle, state.rg6CylinderTarget, 18, cdt);

    if (state.muzzleFlashTimer > 0) {
      state.muzzleFlashTimer = Math.max(0, state.muzzleFlashTimer - cdt);
    }

    // Lazy barrel heat smoke wisps rising from hot muzzle after sustained bursts!
    if (state.barrelHeat > 0) {
      state.barrelHeat = Math.max(0, state.barrelHeat - cdt * 0.16);
      if (state.barrelHeat > 0.22 && state.muzzleFlashTimer <= 0 && DF.Renderer && typeof DF.Renderer.spawnParticle === 'function') {
        state.barrelWispAccum += cdt;
        const interval = lerp(0.16, 0.075, state.barrelHeat);
        if (state.barrelWispAccum >= interval) {
          state.barrelWispAccum = 0;
          const m = state.lastMuzzleWorld;
          DF.Renderer.spawnParticle({
            type: 'smoke',
            pos: [m[0] + (Math.random() - 0.5) * 0.015, m[1] + 0.012, m[2] + (Math.random() - 0.5) * 0.015],
            vel: [(Math.random() - 0.5) * 0.18 + 0.06, 0.42 + Math.random() * 0.28, (Math.random() - 0.5) * 0.18],
            size: 0.036 + state.barrelHeat * 0.025,
            sizeEnd: 0.22 + state.barrelHeat * 0.12,
            life: 0.85 + Math.random() * 0.45,
            color: [0.78, 0.80, 0.84],
            alpha: 0.10 + state.barrelHeat * 0.12,
            gravity: -0.22,
            drag: 1.8
          });
        }
      }
    }

    // Post-shot Pump / Bolt Cycle state machine
    if (state.cycleActive && state.spec) {
      state.cycleTimer += cdt;
      const p = clamp(state.cycleTimer / state.cycleDuration, 0, 1);
      if (state.spec.actionType === 'pump') {
        if (p >= 0.24 && state.cycleFoleyStage < 1) {
          state.cycleFoleyStage = 1;
          emitFoley('pump');
        }
        if (p >= 0.45 && !state.cycleEjected) {
          state.cycleEjected = true;
          spawnShellEjection('shell');
        }
      } else if (state.spec.actionType === 'bolt') {
        if (p >= 0.22 && state.cycleFoleyStage < 1) {
          state.cycleFoleyStage = 1;
          emitFoley('bolt_pull');
        }
        if (p >= 0.48 && !state.cycleEjected) {
          state.cycleEjected = true;
          spawnShellEjection('brass');
        }
        if (p >= 0.72 && state.cycleFoleyStage < 2) {
          state.cycleFoleyStage = 2;
          emitFoley('bolt_release');
        }
      }
      if (p >= 1) {
        state.cycleActive = false;
      }
    }

    // Multi-stage Reload state machine & synced Foley emitter
    if (state.reloading && state.spec) {
      state.reloadTimer += cdt;
      const p = clamp(state.reloadTimer / Math.max(0.1, state.reloadDuration), 0, 1);
      const rType = state.spec.reloadType;

      if (rType === 'mag_ar' || rType === 'mag_ak' || rType === 'mag_sniper') {
        if (p >= 0.16 && !(state.reloadStageFlags & 1)) {
          state.reloadStageFlags |= 1;
          state.reloadStageLabel = 'MAG OUT';
          emitFoley('mag_out');
        }
        if (p >= 0.56 && !(state.reloadStageFlags & 2)) {
          state.reloadStageFlags |= 2;
          state.reloadStageLabel = 'MAG IN';
          emitFoley('mag_in');
          impulseSpring(state.spBumpY, 0.32);
          impulseSpring(state.spBumpPitch, 0.65);
          impulseSpring(state.spKickRoll, -0.45);
        }
        if (state.reloadEmpty) {
          if (p >= 0.75 && !(state.reloadStageFlags & 4)) {
            state.reloadStageFlags |= 4;
            state.reloadStageLabel = 'BOLT';
            emitFoley('bolt_pull');
          }
          if (p >= 0.87 && !(state.reloadStageFlags & 8)) {
            state.reloadStageFlags |= 8;
            emitFoley('bolt_release');
            impulseSpring(state.spKickZ, 0.36);
            impulseSpring(state.spKickRoll, 0.38);
          }
        }
      } else if (rType === 'lmg_belt') {
        if (p >= 0.14 && !(state.reloadStageFlags & 1)) {
          state.reloadStageFlags |= 1;
          state.reloadStageLabel = 'OPEN COVER';
          emitFoley('bolt_pull');
        }
        if (p >= 0.30 && !(state.reloadStageFlags & 2)) {
          state.reloadStageFlags |= 2;
          state.reloadStageLabel = 'BOX OUT';
          emitFoley('mag_out');
        }
        if (p >= 0.55 && !(state.reloadStageFlags & 4)) {
          state.reloadStageFlags |= 4;
          state.reloadStageLabel = 'BELT LOAD';
          emitFoley('mag_in');
          impulseSpring(state.spBumpY, 0.36);
          impulseSpring(state.spBumpPitch, 0.75);
        }
        if (p >= 0.76 && !(state.reloadStageFlags & 8)) {
          state.reloadStageFlags |= 8;
          state.reloadStageLabel = 'CLOSE COVER';
          emitFoley('bolt_release');
          impulseSpring(state.spBumpY, -0.35);
          impulseSpring(state.spBumpPitch, -0.68);
        }
        if (state.reloadEmpty && p >= 0.88 && !(state.reloadStageFlags & 16)) {
          state.reloadStageFlags |= 16;
          state.reloadStageLabel = 'CHARGE';
          emitFoley('bolt_pull');
          impulseSpring(state.spKickZ, 0.34);
        }
      } else if (rType === 'shell_pump') {
        const shellCount = 4;
        for (let i = 0; i < shellCount; i++) {
          const trig = 0.16 + i * 0.165;
          const bit = 1 << i;
          if (p >= trig && !(state.reloadStageFlags & bit)) {
            state.reloadStageFlags |= bit;
            state.reloadStageLabel = 'SHELL ' + (i + 1);
            emitFoley('shell_insert');
            impulseSpring(state.spBumpY, 0.24);
            impulseSpring(state.spBumpPitch, 0.42);
          }
        }
        if (state.reloadEmpty && p >= 0.84 && !(state.reloadStageFlags & 32)) {
          state.reloadStageFlags |= 32;
          state.reloadStageLabel = 'PUMP';
          emitFoley('pump');
          impulseSpring(state.spKickZ, 0.32);
        }
      } else if (rType === 'gl_break') {
        if (p >= 0.14 && !(state.reloadStageFlags & 1)) {
          state.reloadStageFlags |= 1;
          state.reloadStageLabel = 'BREECH OPEN';
          emitFoley('breech_open');
        }
        if (p >= 0.52 && !(state.reloadStageFlags & 2)) {
          state.reloadStageFlags |= 2;
          state.reloadStageLabel = 'LOAD 40MM';
          emitFoley('shell_insert');
          impulseSpring(state.spKickZ, 0.30);
        }
        if (p >= 0.80 && !(state.reloadStageFlags & 4)) {
          state.reloadStageFlags |= 4;
          state.reloadStageLabel = 'LOCK BREECH';
          emitFoley('breech_close');
          impulseSpring(state.spBumpPitch, 0.58);
          impulseSpring(state.spKickRoll, -0.35);
        }
      } else if (rType === 'gl_revolver') {
        if (p >= 0.14 && !(state.reloadStageFlags & 1)) {
          state.reloadStageFlags |= 1;
          state.reloadStageLabel = 'DRUM OPEN';
          emitFoley('breech_open');
        }
        if (p >= 0.36 && !(state.reloadStageFlags & 2)) {
          state.reloadStageFlags |= 2;
          state.reloadStageLabel = 'LOAD VOG';
          emitFoley('shell_insert');
          impulseSpring(state.spBumpY, 0.22);
        }
        if (p >= 0.58 && !(state.reloadStageFlags & 4)) {
          state.reloadStageFlags |= 4;
          emitFoley('shell_insert');
          impulseSpring(state.spBumpY, 0.22);
        }
        if (p >= 0.80 && !(state.reloadStageFlags & 8)) {
          state.reloadStageFlags |= 8;
          state.reloadStageLabel = 'LOCK DRUM';
          emitFoley('breech_close');
          impulseSpring(state.spBumpPitch, 0.55);
        }
      } else if (rType === 'rpg_front') {
        if (p >= 0.26 && !(state.reloadStageFlags & 1)) {
          state.reloadStageFlags |= 1;
          state.reloadStageLabel = 'INSERT PG-7V';
          emitFoley('rpg_load');
        }
        if (p >= 0.68 && !(state.reloadStageFlags & 2)) {
          state.reloadStageFlags |= 2;
          state.reloadStageLabel = 'LOCK WARHEAD';
          emitFoley('bolt_release');
          impulseSpring(state.spKickZ, 0.48);
          impulseSpring(state.spKickRoll, 0.42);
        }
      }

      if (p >= 1) {
        state.reloading = false;
        state.reloadTimer = 0;
        state.reloadStageFlags = 0;
        state.reloadStageLabel = '';
        state.ammoInMag = state.spec.magSize;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Compute multi-stage pose offsets for body, bolt, mag, cover, shell, warhead, hands
  // ---------------------------------------------------------------------------
  function computeAnimPose(spec) {
    const g = spec.geometrySpec;
    const pose = {
      gunPos: [0, 0, 0],
      gunRot: [0, 0, 0], // pitch X, yaw Y, roll Z
      magPos: [0, 0, 0],
      magRot: [0, 0, 0],
      magVisible: true,
      boltPos: [0, 0, state.boltOffset],
      boltRot: [0, 0, 0],
      coverPos: [0, 0, 0],
      coverRot: [0, 0, 0],
      shellVisible: false,
      shellPos: [0, 0, 0],
      shellRot: [0, 0, 0],
      warheadVisible: g.style === 'rpg7' && (state.ammoInMag > 0 || (state.reloading && state.reloadTimer / state.reloadDuration > 0.24)),
      warheadPos: [0, 0, 0],
      warheadRot: [0, 0, 0],
      leftHandPos: g.leftHandGrip.slice(),
      leftHandRot: [0.05, 0.16, 0.28],
      rightHandPos: g.rightHandGrip.slice(),
      rightHandRot: [0.08, -0.06, -0.10]
    };

    if (g.style === 'rg6') {
      pose.coverRot[2] = state.rg6CylinderAngle;
    }

    // 1) Post-shot pump / bolt cycle poses
    if (state.cycleActive) {
      const p = clamp(state.cycleTimer / state.cycleDuration, 0, 1);
      if (spec.actionType === 'pump') {
        const pull = p < 0.48
          ? smoothstep(0.14, 0.44, p)
          : (1 - smoothstep(0.52, 0.86, p));
        pose.magPos[2] = pull * 0.088; // M870 pump forend slides back toward shooter (+Z)
        pose.boltPos[2] = pull * 0.068;
        pose.leftHandPos[2] += pull * 0.088;
        pose.gunRot[2] += pull * 0.14;
        pose.gunRot[0] += pull * 0.06;
      } else if (spec.actionType === 'bolt') {
        const lift = p < 0.25 ? smoothstep(0.05, 0.22, p)
          : (p > 0.75 ? 1 - smoothstep(0.76, 0.94, p) : 1);
        const pull = p < 0.50 ? smoothstep(0.22, 0.48, p)
          : (1 - smoothstep(0.54, 0.78, p));
        pose.boltRot[2] = lift * 0.95; // bolt handle rotates upward
        pose.boltPos[2] = pull * 0.085;
        pose.gunRot[2] += lift * 0.22;
        pose.gunRot[0] += lift * 0.07;
        // Right hand leaves grip to operate bolt knob!
        const handBlend = p < 0.18 ? smoothstep(0.0, 0.16, p)
          : (p > 0.84 ? 1 - smoothstep(0.84, 1.0, p) : 1);
        const knobTarget = [g.boltAnchor[0] + 0.01, g.boltAnchor[1] + lift * 0.025, g.boltAnchor[2] + pull * 0.085];
        lerp3(pose.rightHandPos, pose.rightHandPos, knobTarget, handBlend);
      }
    }

    // 2) Multi-stage reload poses
    if (state.reloading) {
      const p = clamp(state.reloadTimer / Math.max(0.1, state.reloadDuration), 0, 1);
      const rType = spec.reloadType;

      if (rType === 'mag_ar' || rType === 'mag_ak' || rType === 'mag_sniper') {
        const tilt = p < 0.14 ? smoothstep(0, 0.14, p)
          : (p > 0.90 ? 1 - smoothstep(0.90, 1.0, p) : 1);
        pose.gunRot[2] += tilt * 0.36;
        pose.gunRot[0] += tilt * 0.18;
        pose.gunRot[1] -= tilt * 0.12;
        pose.gunPos[1] -= tilt * 0.025;

        if (p < 0.16) {
          // Left hand moves to magazine
          const t = smoothstep(0.02, 0.16, p);
          lerp3(pose.leftHandPos, g.leftHandGrip, g.magAnchor, t);
        } else if (p < 0.36) {
          // Pull & drop spent magazine
          const t = smoothstep(0.16, 0.34, p);
          pose.magPos[1] = -t * 0.26;
          pose.magPos[2] = rType === 'mag_ak' ? -t * 0.06 : t * 0.02;
          pose.magRot[0] = rType === 'mag_ak' ? t * 0.45 : 0;
          lerp3(pose.leftHandPos, g.magAnchor, [g.magAnchor[0] - 0.04, g.magAnchor[1] - 0.24, g.magAnchor[2]], t);
        } else if (p < 0.46) {
          // Offscreen mag swap
          pose.magVisible = false;
          pose.leftHandPos = [g.magAnchor[0] - 0.05, g.magAnchor[1] - 0.28, g.magAnchor[2] + 0.02];
        } else if (p < 0.64) {
          // Fresh magazine rises & seats firmly
          const t = smoothstep(0.46, 0.60, p);
          const inv = 1 - t;
          pose.magPos[1] = -inv * 0.24;
          pose.magRot[0] = rType === 'mag_ak' ? inv * 0.38 : 0;
          pose.leftHandPos = [g.magAnchor[0] - inv * 0.04, g.magAnchor[1] - inv * 0.24, g.magAnchor[2]];
        } else if (state.reloadEmpty && p < 0.90) {
          // Bolt rack / release
          const reach = smoothstep(0.64, 0.74, p);
          const pull = p < 0.85 ? smoothstep(0.74, 0.84, p) : 1 - smoothstep(0.85, 0.90, p);
          const backToGrip = smoothstep(0.86, 0.94, p);
          pose.boltPos[2] = pull * 0.082;
          if (rType === 'mag_sniper') {
            pose.boltRot[2] = smoothstep(0.72, 0.78, p) * (1 - smoothstep(0.86, 0.90, p)) * 0.95;
            lerp3(pose.rightHandPos, g.rightHandGrip, [g.boltAnchor[0], g.boltAnchor[1], g.boltAnchor[2] + pull * 0.08], reach * (1 - backToGrip));
          } else {
            const boltTarget = [g.boltAnchor[0], g.boltAnchor[1], g.boltAnchor[2] + pull * 0.082];
            lerp3(pose.leftHandPos, g.magAnchor, boltTarget, reach);
            if (backToGrip > 0) lerp3(pose.leftHandPos, boltTarget, g.leftHandGrip, backToGrip);
          }
        } else {
          // Return left hand to handguard
          const t = smoothstep(0.66, 0.90, p);
          lerp3(pose.leftHandPos, g.magAnchor, g.leftHandGrip, t);
        }
      } else if (rType === 'lmg_belt') {
        const tilt = p < 0.12 ? smoothstep(0, 0.12, p)
          : (p > 0.92 ? 1 - smoothstep(0.92, 1.0, p) : 1);
        pose.gunRot[2] += tilt * 0.24;
        pose.gunRot[0] += tilt * 0.14;
        pose.gunPos[1] -= tilt * 0.03;

        // Top cover hinges open from 0.14 -> 0.76
        const coverOpen = p < 0.24 ? smoothstep(0.12, 0.24, p)
          : (p > 0.74 ? 1 - smoothstep(0.74, 0.82, p) : 1);
        pose.coverRot[0] = coverOpen * 1.18; // flips up!

        if (p < 0.24) {
          lerp3(pose.leftHandPos, g.leftHandGrip, [-0.02, 0.09, 0.04], smoothstep(0.0, 0.22, p));
        } else if (p < 0.44) {
          const t = smoothstep(0.26, 0.42, p);
          pose.magPos[1] = -t * 0.26;
          lerp3(pose.leftHandPos, g.magAnchor, [g.magAnchor[0] - 0.04, g.magAnchor[1] - 0.24, g.magAnchor[2]], t);
        } else if (p < 0.50) {
          pose.magVisible = false;
          pose.leftHandPos = [g.magAnchor[0] - 0.04, g.magAnchor[1] - 0.26, g.magAnchor[2]];
        } else if (p < 0.64) {
          const t = smoothstep(0.50, 0.62, p);
          pose.magPos[1] = -(1 - t) * 0.24;
          pose.leftHandPos = [g.magAnchor[0], g.magAnchor[1] - (1 - t) * 0.22, g.magAnchor[2]];
        } else if (p < 0.82) {
          // Lay belt & slam top cover shut
          const t = smoothstep(0.64, 0.78, p);
          lerp3(pose.leftHandPos, [-0.03, 0.04, -0.08], [0.0, 0.10, -0.02], t);
        } else if (state.reloadEmpty && p < 0.94) {
          const pull = smoothstep(0.84, 0.90, p) * (1 - smoothstep(0.90, 0.95, p));
          pose.boltPos[2] = pull * 0.085;
          lerp3(pose.leftHandPos, [0.0, 0.10, -0.02], g.leftHandGrip, smoothstep(0.82, 0.94, p));
        } else {
          lerp3(pose.leftHandPos, [0.0, 0.10, -0.02], g.leftHandGrip, smoothstep(0.82, 0.98, p));
        }
      } else if (rType === 'shell_pump') {
        const endInsert = state.reloadEmpty ? 0.80 : 0.92;
        const tilt = p < 0.14 ? smoothstep(0, 0.14, p)
          : (p > endInsert ? 1 - smoothstep(endInsert, 0.96, p) : 1);
        pose.gunRot[2] -= tilt * 0.56; // tilt shotgun sideways exposing bottom loading gate
        pose.gunRot[0] += tilt * 0.24;

        if (p >= 0.12 && p <= endInsert) {
          const localCycle = ((p - 0.12) / (endInsert - 0.12)) * 4;
          const phase = localCycle - Math.floor(localCycle);
          const up = smoothstep(0.0, 0.62, phase);
          const away = smoothstep(0.70, 0.98, phase);
          pose.shellVisible = phase < 0.72;
          const port = [0.0, -0.025, -0.055];
          const low = [-0.04, -0.22, -0.04];
          lerp3(pose.shellPos, low, port, up);
          pose.shellRot[0] = 0.25 * (1 - up);
          lerp3(pose.leftHandPos, low, port, up * (1 - away * 0.6));
        } else if (state.reloadEmpty && p > 0.80) {
          const pp = (p - 0.80) / 0.20;
          const pull = pp < 0.5 ? smoothstep(0.05, 0.45, pp) : 1 - smoothstep(0.55, 0.95, pp);
          pose.magPos[2] = pull * 0.088;
          pose.boltPos[2] = pull * 0.068;
          pose.leftHandPos[2] += pull * 0.088;
        } else {
          const t = p < 0.14 ? smoothstep(0, 0.14, p) : 1 - smoothstep(0.92, 1.0, p);
          lerp3(pose.leftHandPos, g.leftHandGrip, [-0.04, -0.18, -0.05], t);
        }
      } else if (rType === 'gl_break') {
        const open = p < 0.22 ? smoothstep(0.06, 0.22, p)
          : (p > 0.76 ? 1 - smoothstep(0.76, 0.88, p) : 1);
        pose.coverRot[1] = -open * 0.62; // barrel swings out left
        pose.gunRot[2] += open * 0.28;
        pose.gunRot[0] += open * 0.14;
        if (p >= 0.26 && p <= 0.72) {
          const ins = smoothstep(0.32, 0.64, p);
          pose.shellVisible = p < 0.70;
          lerp3(pose.shellPos, [-0.14, -0.14, 0.06], [-0.075, 0.028, -0.05], ins);
          lerp3(pose.leftHandPos, [-0.14, -0.16, 0.08], [-0.08, 0.01, -0.02], ins);
        } else {
          const t = p < 0.26 ? smoothstep(0, 0.26, p) : 1 - smoothstep(0.72, 0.96, p);
          lerp3(pose.leftHandPos, g.leftHandGrip, [-0.12, -0.12, 0.04], t);
        }
      } else if (rType === 'gl_revolver') {
        const tilt = p < 0.16 ? smoothstep(0, 0.16, p)
          : (p > 0.84 ? 1 - smoothstep(0.84, 1.0, p) : 1);
        pose.gunRot[2] += tilt * 0.42;
        pose.gunRot[0] += tilt * 0.20;
        pose.coverPos[0] = -tilt * 0.055;
        pose.coverRot[2] += p * Math.PI * 2;
        if (p >= 0.22 && p <= 0.78) {
          const cyc = ((p - 0.22) / 0.56) * 2;
          const ph = cyc - Math.floor(cyc);
          const ins = smoothstep(0.0, 0.70, ph);
          pose.shellVisible = ph < 0.75;
          lerp3(pose.shellPos, [-0.10, -0.18, -0.04], [-0.04, 0.01, -0.10], ins);
          lerp3(pose.leftHandPos, [-0.10, -0.18, -0.02], [-0.05, 0.0, -0.08], ins);
        }
      } else if (rType === 'rpg_front') {
        const dip = p < 0.20 ? smoothstep(0, 0.20, p)
          : (p > 0.82 ? 1 - smoothstep(0.82, 1.0, p) : 1);
        pose.gunRot[0] -= dip * 0.34; // lower muzzle slightly to load from front
        pose.gunRot[1] += dip * 0.22;
        pose.gunPos[1] -= dip * 0.065;
        pose.gunPos[2] += dip * 0.08;

        if (p >= 0.24) {
          const slide = smoothstep(0.24, 0.66, p);
          const twist = smoothstep(0.66, 0.78, p);
          pose.warheadPos[2] = -(1 - slide) * 0.36; // slides back (+Z) into front launch tube!
          pose.warheadPos[1] = -(1 - slide) * 0.14;
          pose.warheadRot[2] = twist * 0.78;
          const handTarget = [-0.04, -0.02 + pose.warheadPos[1], -0.56 + pose.warheadPos[2]];
          const reach = p < 0.34 ? smoothstep(0.10, 0.34, p)
            : (p > 0.78 ? 1 - smoothstep(0.78, 0.96, p) : 1);
          lerp3(pose.leftHandPos, g.leftHandGrip, handTarget, reach);
        }
      }
    }

    // 3) First-person window vault / mantle pose (weapon tucks down-right while camera-space left arm plants on sill!)
    if (state.vaultProgress > 0.001) {
      const vp = clamp(state.vaultProgress, 0, 1);
      const tuck = vp < 0.22
        ? smoothstep(0.0, 0.22, vp)
        : (vp > 0.72 ? 1 - smoothstep(0.72, 1.0, vp) : 1.0);
      const surge = Math.sin(vp * Math.PI);
      pose.gunPos[0] += 0.11 * tuck;
      pose.gunPos[1] -= 0.16 * tuck + 0.025 * surge;
      pose.gunPos[2] += 0.06 * tuck;
      pose.gunRot[0] -= 0.30 * tuck;
      pose.gunRot[1] += 0.32 * tuck;
      pose.gunRot[2] -= 0.38 * tuck;
    }

    return pose;
  }

  // ---------------------------------------------------------------------------
  // Build camera-to-world matrix safely from camState
  // ---------------------------------------------------------------------------
  function buildCamWorldMatrix(out, camState) {
    const M = DF.Mat4;
    if (camState && camState.viewMat && camState.viewMat.length === 16) {
      const inv = M.invert(out, camState.viewMat);
      if (inv && isFinite(out[0]) && isFinite(out[12])) {
        return out;
      }
    }
    const pos = (camState && camState.pos) || [0, 1.7, 0];
    const yaw = (camState && camState.yaw) || 0;
    const pitch = (camState && camState.pitch) || 0;
    const roll = (camState && camState.roll) || 0;
    M.fromTRS(out, pos, [pitch, yaw, roll], [1, 1, 1]);
    return out;
  }

  function submitPartGroup(renderer, parts, worldMat, flags) {
    if (!parts) return;
    for (let i = 0; i < parts.length; i++) {
      renderer.submitMesh(parts[i].mesh, worldMat, parts[i].material, flags);
    }
  }

  function render(renderer, camState) {
    if (!state.initialized || !renderer || !state.spec) return;

    const M = DF.Mat4;
    const spec = state.spec;
    const g = spec.geometrySpec;
    const rig = state.rigs[state.faction + '_' + state.slot];
    const arms = state.arms[state.faction];
    if (!rig || !arms) return;

    // 1) Camera world transform & axes
    const camWorld = buildCamWorldMatrix(state.mCamWorld, camState);
    state.lastCamRight[0] = camWorld[0]; state.lastCamRight[1] = camWorld[1]; state.lastCamRight[2] = camWorld[2];
    state.lastCamUp[0] = camWorld[4]; state.lastCamUp[1] = camWorld[5]; state.lastCamUp[2] = camWorld[6];
    state.lastCamForward[0] = -camWorld[8]; state.lastCamForward[1] = -camWorld[9]; state.lastCamForward[2] = -camWorld[10];
    state.lastCamPos[0] = camWorld[12]; state.lastCamPos[1] = camWorld[13]; state.lastCamPos[2] = camWorld[14];

    // Hide 3D viewmodel when fully zoomed inside optical scope overlays (Mil-Dot, PSO-1, PGO-7V)
    const hideForScope = (spec.scopeType === 'mildot' || spec.scopeType === 'pso' || spec.scopeType === 'pgo7') && state.adsProgress > 0.82;

    // 2) Compute weapon root transform in camera-local space
    const pose = computeAnimPose(spec);

    const hip = g.hipPos;
    const ads = g.adsPos;
    const spr = g.sprintPos;

    const adsT = smoothstep(0, 1, state.adsProgress);
    const sprT = clamp(state.spSprint.x, -0.06, 1.12); // allows subtle physical spring settle!
    const sprClamped = clamp(sprT, 0, 1);
    const eqT = state.equipTimer > 0 ? smoothstep(0, 1, state.equipTimer / state.equipDuration) : 0;

    // Base position hip -> ADS -> class-specific Tactical Sprint pose
    let px = lerp(hip[0], ads[0], adsT);
    let py = lerp(hip[1], ads[1], adsT);
    let pz = lerp(hip[2], ads[2], adsT);

    px = lerp(px, spr[0], sprT);
    py = lerp(py, spr[1], sprT);
    pz = lerp(pz, spr[2], sprT);

    // Per-class AAA Figure-8 Stride Bob & Shoulder Inertia
    const sprintStyle = g.sprintStyle || 'tac_high';
    const walkAmp = lerp(1.0, 0.14, adsT) * (state.moveSpeed > 0.25 ? clamp(state.moveSpeed / 4.5, 0.25, 1.25) : 0.12);
    const walkX = Math.cos(state.bobPhase) * 0.011 * walkAmp;
    const walkY = Math.abs(Math.sin(state.bobPhase)) * -0.012 * walkAmp + Math.sin(state.bobPhase * 0.5) * 0.0025;

    const heavyMult = sprintStyle === 'heavy_low' ? 1.25 : (sprintStyle === 'rpg_carry' ? 0.85 : 1.0);
    const sprBobX = Math.cos(state.bobPhase) * (sprintStyle === 'rpg_carry' ? 0.018 : 0.032) * heavyMult;
    const sprBobY = (Math.abs(Math.sin(state.bobPhase)) * -0.028 + Math.sin(state.bobPhase * 2.0) * 0.008) * heavyMult;
    const sprBobZ = Math.sin(state.bobPhase) * (sprintStyle === 'heavy_low' ? 0.022 : 0.016);
    const sprRollBob = -Math.cos(state.bobPhase) * (sprintStyle === 'tac_high' ? 0.078 : 0.058);
    const sprPitchBob = Math.sin(state.bobPhase * 2.0) * (sprintStyle === 'heavy_low' ? 0.054 : 0.042);

    const bobX = lerp(walkX, sprBobX, sprClamped);
    const bobY = lerp(walkY, sprBobY, sprClamped);
    const bobZ = sprBobZ * sprClamped;

    // Export synchronized camera stride sway for main.js camera roll & vertical step sync
    state.strideBobX = bobX;
    state.strideBobY = bobY;
    state.strideCamRoll = -Math.cos(state.bobPhase) * lerp(0.0035 * walkAmp, 0.016, sprClamped);

    // Apply damped harmonic springs: sway, landing dip, reload/footstep bump, equip drop, recoil kickback
    const swayScale = lerp(1.0, 0.22, adsT);
    const sx = state.spSwayX.x * swayScale;
    const sy = state.spSwayY.x * swayScale;

    px += bobX + sx + pose.gunPos[0];
    py += bobY + sy + state.spLandDip.x + state.spBumpY.x - eqT * 0.32 + pose.gunPos[1];
    pz += bobZ + state.spKickZ.x + pose.gunPos[2];

    // Optional hipfire carry tilt + per-class Tactical Sprint rotation (High-Ready / Heavy Low-Ready / RPG Up-Right)
    const hipRot = g.hipRot || [0, 0, 0];
    const sprRot = g.sprintRot || [-0.22, 0.58, -0.28];
    const hipRotBlend = (1 - adsT) * (1 - sprClamped);

    const pitch = state.spKickPitch.x + state.spBumpPitch.x - eqT * 0.65 + sprRot[0] * sprT + sprPitchBob * sprClamped + pose.gunRot[0] + sy * 1.45 + hipRot[0] * hipRotBlend;
    const yaw = state.spKickYaw.x + sprRot[1] * sprT + pose.gunRot[1] - sx * 1.85 + hipRot[1] * hipRotBlend;
    const roll = state.spKickRoll.x + sprRot[2] * sprT + sprRollBob * sprClamped + pose.gunRot[2] - sx * 2.25 + hipRot[2] * hipRotBlend;

    // Rhythmic forearm & wrist counter-roll follow-through during Tactical Sprint!
    if (sprClamped > 0.02 && !state.reloading) {
      const wristSwing = Math.sin(state.bobPhase) * 0.085 * sprClamped;
      pose.leftHandRot[2] += wristSwing + 0.14 * sprClamped;
      pose.leftHandRot[0] += 0.10 * sprClamped;
      pose.rightHandRot[2] -= wristSwing * 0.75;
      if (sprintStyle === 'tac_high') {
        pose.leftHandPos[2] += 0.028 * sprClamped;
        pose.leftHandPos[1] -= 0.008 * sprClamped;
      }
    }

    M.fromTRS(state.mLocal, [px, py, pz], [pitch, yaw, roll], [1, 1, 1]);
    M.multiply(state.mWeaponRoot, camWorld, state.mLocal);

    // Update exact world-space muzzle & ejection port positions for ballistics & VFX!
    M.transformPoint(state.lastMuzzleWorld, state.mWeaponRoot, g.muzzleOffset);
    M.transformPoint(state.lastEjectWorld, state.mWeaponRoot, g.ejectOffset);

    // Dynamic muzzle flash light in world space
    if (state.muzzleFlashTimer > 0 && renderer.addDynamicLight) {
      const intensity = (state.muzzleFlashTimer / 0.05) * (spec.class === 'rpg' ? 9.0 : 5.5);
      renderer.addDynamicLight(state.lastMuzzleWorld, [1.0, 0.68, 0.28], intensity, 7.5);
    }

    if (hideForScope) return;

    const vmFlags = { castShadow: false, receiveShadow: true, viewmodel: true, unlit: false };
    const unlitFlags = { castShadow: false, receiveShadow: false, viewmodel: true, unlit: true };
    state.matPoolIdx = 0;

    // 3) Submit static weapon body + illuminated optic reticle
    const mBody = allocMat();
    M.copy(mBody, state.mWeaponRoot);
    submitPartGroup(renderer, rig.body, mBody, vmFlags);
    submitPartGroup(renderer, rig.reticle, mBody, unlitFlags);

    // 4) Submit animated bolt carrier / rotating M24 bolt
    if (rig.bolt.length > 0) {
      const bp = rig.pivots.bolt;
      const mBolt = allocMat();
      M.identity(state.mLocal);
      M.translate(state.mLocal, state.mLocal, [pose.boltPos[0] + bp[0], pose.boltPos[1] + bp[1], pose.boltPos[2] + bp[2]]);
      if (pose.boltRot[2] !== 0) M.rotateZ(state.mLocal, state.mLocal, pose.boltRot[2]);
      M.translate(state.mLocal, state.mLocal, [-bp[0], -bp[1], -bp[2]]);
      M.multiply(mBolt, state.mWeaponRoot, state.mLocal);
      submitPartGroup(renderer, rig.bolt, mBolt, vmFlags);
    }

    // 5) Submit animated magazine / M870 pump forend
    if (pose.magVisible && rig.mag.length > 0) {
      const mp = rig.pivots.mag;
      const mMag = allocMat();
      M.identity(state.mLocal);
      M.translate(state.mLocal, state.mLocal, [pose.magPos[0] + mp[0], pose.magPos[1] + mp[1], pose.magPos[2] + mp[2]]);
      if (pose.magRot[0] !== 0) M.rotateX(state.mLocal, state.mLocal, pose.magRot[0]);
      if (pose.magRot[1] !== 0) M.rotateY(state.mLocal, state.mLocal, pose.magRot[1]);
      if (pose.magRot[2] !== 0) M.rotateZ(state.mLocal, state.mLocal, pose.magRot[2]);
      M.translate(state.mLocal, state.mLocal, [-mp[0], -mp[1], -mp[2]]);
      M.multiply(mMag, state.mWeaponRoot, state.mLocal);
      submitPartGroup(renderer, rig.mag, mMag, vmFlags);
    }

    // 6) Submit animated LMG hinged top cover / M320 break barrel / RG-6 revolving drum
    if (rig.cover.length > 0) {
      const cp = rig.pivots.cover;
      const mCov = allocMat();
      M.identity(state.mLocal);
      M.translate(state.mLocal, state.mLocal, [pose.coverPos[0] + cp[0], pose.coverPos[1] + cp[1], pose.coverPos[2] + cp[2]]);
      if (pose.coverRot[1] !== 0) M.rotateY(state.mLocal, state.mLocal, pose.coverRot[1]);
      if (pose.coverRot[0] !== 0) M.rotateX(state.mLocal, state.mLocal, pose.coverRot[0]);
      if (pose.coverRot[2] !== 0) M.rotateZ(state.mLocal, state.mLocal, pose.coverRot[2]);
      M.translate(state.mLocal, state.mLocal, [-cp[0], -cp[1], -cp[2]]);
      M.multiply(mCov, state.mWeaponRoot, state.mLocal);
      submitPartGroup(renderer, rig.cover, mCov, vmFlags);
    }

    // 7) Submit individual shell / 40mm grenade during hand insertion
    if (pose.shellVisible && rig.shell.length > 0) {
      const mShell = allocMat();
      M.fromTRS(state.mLocal, pose.shellPos, pose.shellRot, [1, 1, 1]);
      M.multiply(mShell, state.mWeaponRoot, state.mLocal);
      submitPartGroup(renderer, rig.shell, mShell, vmFlags);
    }

    // 8) Submit RPG-7 protruding PG-7VL warhead
    if (pose.warheadVisible && rig.warhead.length > 0) {
      const mWar = allocMat();
      M.fromTRS(state.mLocal, pose.warheadPos, pose.warheadRot, [1, 1, 1]);
      M.multiply(mWar, state.mWeaponRoot, state.mLocal);
      submitPartGroup(renderer, rig.warhead, mWar, vmFlags);
    }

    // 9) Submit articulated Left & Right tactical forearms and gloved hands
    const mLeft = allocMat();
    M.fromTRS(state.mLocal, pose.leftHandPos, pose.leftHandRot, [1, 1, 1]);
    M.multiply(mLeft, state.mWeaponRoot, state.mLocal);
    if (state.vaultProgress > 0.001) {
      // Camera-space left-hand sill plant: glove reaches forward-left onto the window ledge while forearm extends cleanly off bottom-left edge!
      const vp = clamp(state.vaultProgress, 0, 1);
      const handPlant = vp < 0.18
        ? smoothstep(0.0, 0.18, vp)
        : (vp > 0.68 ? 1 - smoothstep(0.68, 0.96, vp) : 1.0);
      if (handPlant > 0.001) {
        const push = smoothstep(0.18, 0.68, vp);
        const vx = lerp(-0.17, -0.22, push);
        const vy = lerp(-0.15, -0.23, push) + Math.sin(push * Math.PI) * 0.035;
        const vz = lerp(-0.34, -0.20, push);
        const vrx = lerp(-0.22, -0.36, push);
        const vry = lerp(-0.18, -0.05, push);
        const vrz = lerp(0.14, 0.22, push);
        const mVaultLocal = allocMat();
        const mVaultWorld = allocMat();
        M.fromTRS(mVaultLocal, [vx, vy, vz], [vrx, vry, vrz], [1, 1, 1]);
        M.multiply(mVaultWorld, camWorld, mVaultLocal);
        // Rigidly blend world-space matrix columns & Gram-Schmidt orthonormalize upper 3x3
        for (let k = 0; k < 16; k++) {
          mLeft[k] = lerp(mLeft[k], mVaultWorld[k], handPlant);
        }
        // Orthonormalize col2 (-Z), col0 (X), col1 (Y)
        let z0 = mLeft[8], z1 = mLeft[9], z2 = mLeft[10];
        const zl = Math.hypot(z0, z1, z2) || 1;
        z0 /= zl; z1 /= zl; z2 /= zl;
        let x0 = mLeft[4] * z2 - mLeft[5] * z1; // wait: Y x Z = X
        // Compute X = normalize(Y_blend x Z)
        const yb0 = mLeft[4], yb1 = mLeft[5], yb2 = mLeft[6];
        x0 = yb1 * z2 - yb2 * z1;
        let x1 = yb2 * z0 - yb0 * z2;
        let x2 = yb0 * z1 - yb1 * z0;
        const xl = Math.hypot(x0, x1, x2) || 1;
        x0 /= xl; x1 /= xl; x2 /= xl;
        const y0 = z1 * x2 - z2 * x1;
        const y1 = z2 * x0 - z0 * x2;
        const y2 = z0 * x1 - z1 * x0;
        mLeft[0] = x0; mLeft[1] = x1; mLeft[2] = x2; mLeft[3] = 0;
        mLeft[4] = y0; mLeft[5] = y1; mLeft[6] = y2; mLeft[7] = 0;
        mLeft[8] = z0; mLeft[9] = z1; mLeft[10] = z2; mLeft[11] = 0;
        mLeft[15] = 1;
      }
    }
    submitPartGroup(renderer, arms.left, mLeft, vmFlags);

    const mRight = allocMat();
    M.fromTRS(state.mLocal, pose.rightHandPos, pose.rightHandRot, [1, 1, 1]);
    M.multiply(mRight, state.mWeaponRoot, state.mLocal);
    submitPartGroup(renderer, arms.right, mRight, vmFlags);

    // 10) Submit tapered 3D muzzle-brake flash plumes
    if (state.muzzleFlashTimer > 0 && state.muzzleFlash && state.muzzleFlash.mesh) {
      const mFlash = allocMat();
      const fade = clamp(state.muzzleFlashTimer / 0.042, 0.35, 1.0);
      const fScale = (0.72 + Math.random() * 0.38) * fade * (spec.class === 'rpg' ? 1.55 : (spec.class === 'shotgun' ? 1.28 : 0.92));
      M.fromTRS(state.mLocal, g.muzzleOffset, [0, 0, state.muzzleFlashRoll], [fScale, fScale, fScale]);
      M.multiply(mFlash, state.mWeaponRoot, state.mLocal);
      renderer.submitMesh(state.muzzleFlash.mesh, mFlash, state.muzzleFlash.material, unlitFlags);
      if (state.muzzleFlash.portsMesh) {
        renderer.submitMesh(state.muzzleFlash.portsMesh, mFlash, state.muzzleFlash.portsMat, unlitFlags);
      }
    }
  }

  function getStrideStep() {
    return {
      phase: state.bobPhase,
      count: state.strideCount,
      side: state.strideSide,
      sprintBlend: state.sprintProgress,
      isSprint: state.sprintProgress > 0.45,
      bobX: state.strideBobX,
      bobY: state.strideBobY,
      camRoll: state.strideCamRoll
    };
  }

  function getState() {
    return {
      slot: state.slot,
      faction: state.faction,
      spec: state.spec,
      adsProgress: state.adsProgress,
      sprintProgress: state.sprintProgress,
      reloading: state.reloading,
      reloadProgress: state.reloading ? clamp(state.reloadTimer / Math.max(0.1, state.reloadDuration), 0, 1) : 0,
      reloadStageLabel: state.reloadStageLabel,
      cycling: state.cycleActive,
      barrelHeat: state.barrelHeat,
      muzzleWorld: state.lastMuzzleWorld,
      ejectWorld: state.lastEjectWorld
    };
  }

  DF.Viewmodel = {
    init,
    equip,
    triggerFire,
    triggerReload,
    cancelReload,
    setADS,
    setSprint,
    setMoveState,
    update,
    render,
    getState,
    getStrideStep,
    getMuzzleWorldPos: () => state.lastMuzzleWorld,
    getEjectWorldPos: () => state.lastEjectWorld
  };
})();
