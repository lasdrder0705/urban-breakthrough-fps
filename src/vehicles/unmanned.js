(() => {
  'use strict';

  const DF = (window.DF = window.DF || {});

  // ---------------------------------------------------------------------------
  // Internal Math Helpers (Right-Handed Y-Up, -Z Forward, +X Right, +Y Up)
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

  function mat4FromYXZ(out, px, py, pz, yaw, pitch, roll, sx, sy, sz) {
    const cy = Math.cos(yaw), syaw = Math.sin(yaw);
    const cx = Math.cos(pitch), sxp = Math.sin(pitch);
    const cz = Math.cos(roll), szr = Math.sin(roll);

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
    out[0] = rx / l; out[1] = ry / l; out[2] = rz / l;
    return out;
  }

  function addBevel(b, cx, cy, cz, sx, sy, sz, bevel, opts) {
    if (typeof b.addBeveledBox === 'function') {
      b.addBeveledBox(cx, cy, cz, sx, sy, sz, bevel, opts || {});
    } else {
      b.addBox(cx, cy, cz, sx, sy, sz, opts || {});
    }
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

  // ---------------------------------------------------------------------------
  // High-Poly Hero-Asset 3D Mesh Builders: Ducted FPV Drone & Armed Robot Dog
  // ---------------------------------------------------------------------------
  const ROTOR_OFFSETS = [
    [-0.31, 0.055, -0.29],
    [ 0.31, 0.055, -0.29],
    [-0.31, 0.055,  0.29],
    [ 0.31, 0.055,  0.29]
  ];

  function buildDroneMeshes(gl) {
    const bFrame = new DF.MeshGen.Builder();
    const bMetal = new DF.MeshGen.Builder();
    const bAccent = new DF.MeshGen.Builder();
    const bAccent2 = new DF.MeshGen.Builder();
    const bRotorBlades = new DF.MeshGen.Builder();
    const bRotorDisc = new DF.MeshGen.Builder();
    const bGimbal = new DF.MeshGen.Builder();
    const bOpticLens = new DF.MeshGen.Builder();
    const bBomb = new DF.MeshGen.Builder();
    const bLed = new DF.MeshGen.Builder();
    const bStrobeAmber = new DF.MeshGen.Builder();

    const carbon = [0.22, 0.23, 0.25];
    const carbonLite = [0.34, 0.36, 0.38];
    const gunmetal = [0.56, 0.58, 0.60];
    const copperCoil = [0.68, 0.44, 0.22];

    // Layered dual-deck beveled carbon-fiber fuselage + avionics bay + LiPo pack
    addBevel(bFrame, 0, 0.025, 0, 0.22, 0.075, 0.32, 0.016, { color: carbon, aoBottom: 0.70, aoTop: 1.0 });
    addBevel(bFrame, 0, 0.095, 0.02, 0.145, 0.068, 0.22, 0.014, { color: carbonLite, aoBottom: 0.78, aoTop: 1.0 });
    // CNC aluminum standoffs + top avionics heat-sink cooling fins
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        bMetal.addCylinder(sx * 0.088, 0.025, sz * 0.125, 0.008, 0.008, 0.085, 8, { axis: 'y', color: gunmetal });
      }
      // Side battery retention plates & cooling fin ribs
      for (let f = 0; f < 4; f++) {
        bMetal.addBox(sx * 0.076, 0.095, -0.045 + f * 0.036, 0.012, 0.042, 0.012, { color: gunmetal });
      }
    }
    // High-contrast dual-band faction ID markings (Yellow/Blue for UA; Crimson-Red/White for RU!)
    bAccent.addBox(0, 0.105, -0.015, 0.158, 0.058, 0.068, { color: [1, 1, 1] });
    bAccent.addBox(0, 0.068, -0.118, 0.14, 0.014, 0.036, { color: [1, 1, 1] });
    bAccent2.addBox(0, 0.105,  0.056, 0.158, 0.058, 0.064, { color: [1, 1, 1] });
    bAccent2.addBox(0, 0.068,  0.118, 0.14, 0.014, 0.036, { color: [1, 1, 1] });

    // Front protective carbon camera roll-cage bars
    for (let s = -1; s <= 1; s += 2) {
      bMetal.addBox(s * 0.068, 0.015, -0.175, 0.014, 0.095, 0.018, { color: gunmetal, rotX: 0.18 });
    }
    bMetal.addBox(0, 0.060, -0.182, 0.15, 0.012, 0.016, { color: gunmetal });

    // 4 Angled X-frame arms + brushless motors + 16-seg DUCTED AERODYNAMIC ROTOR SHROUDS!
    const shroudR = 0.185;
    for (let i = 0; i < 4; i++) {
      const ro = ROTOR_OFFSETS[i];
      const mx = ro[0] * 0.50;
      const mz = ro[2] * 0.50;
      const armLen = Math.hypot(ro[0], ro[2]);
      const armYaw = Math.atan2(ro[0], ro[2]);
      addBevel(bFrame, mx, 0.028, mz, 0.038, 0.024, armLen, 0.005, { color: carbon, rotY: armYaw });
      // Brushless motor bell + visible copper stator windings
      bMetal.addCylinder(ro[0], ro[1] - 0.006, ro[2], 0.036, 0.038, 0.030, 14, { axis: 'y', color: gunmetal });
      bMetal.addCylinder(ro[0], ro[1] - 0.024, ro[2], 0.030, 0.032, 0.014, 12, { axis: 'y', color: copperCoil });

      // Ducted propeller shroud ring (outer bevel wall + inner duct wall + 3 radial stator struts!)
      bFrame.addCylinder(ro[0], ro[1] + 0.012, ro[2], shroudR + 0.012, shroudR + 0.006, 0.052, 18, {
        axis: 'y', openEnded: true, color: carbonLite
      });
      bFrame.addCylinder(ro[0], ro[1] + 0.012, ro[2], shroudR - 0.004, shroudR - 0.004, 0.050, 18, {
        axis: 'y', openEnded: true, color: carbon
      });
      // Top & bottom shroud lip segments (8-segment bevel cap ring)
      for (let seg = 0; seg < 12; seg++) {
        const a = (seg / 12) * Math.PI * 2;
        const rx = ro[0] + Math.cos(a) * (shroudR + 0.004);
        const rz = ro[2] + Math.sin(a) * (shroudR + 0.004);
        bFrame.addBox(rx, ro[1] + 0.038, rz, 0.020, 0.008, (Math.PI * 2 * shroudR) / 12 + 0.01, {
          color: carbon, rotY: -a
        });
      }
      // 3 radial stator struts anchoring shroud ring to motor hub
      for (let st = 0; st < 3; st++) {
        const a = (st / 3) * Math.PI * 2 + i * 0.7;
        const sx = ro[0] + Math.cos(a) * (shroudR * 0.5);
        const sz = ro[2] + Math.sin(a) * (shroudR * 0.5);
        bFrame.addBox(sx, ro[1] - 0.018, sz, shroudR, 0.010, 0.016, { color: carbon, rotY: -a });
      }
      // Motor pod landing bumper foot
      bFrame.addCylinder(ro[0] * 0.94, -0.024, ro[2] * 0.94, 0.011, 0.013, 0.075, 8, { axis: 'y', color: carbon });
    }

    // Twin arched landing skids + rear dual VTX/ELRS dipole antennas + GPS mast
    for (let s = -1; s <= 1; s += 2) {
      bFrame.addBox(s * 0.105, -0.098, 0.0, 0.018, 0.016, 0.30, { color: carbon });
      bFrame.addBox(s * 0.095, -0.048, -0.085, 0.014, 0.105, 0.018, { color: carbon, rotZ: s * 0.16 });
      bFrame.addBox(s * 0.095, -0.048,  0.085, 0.014, 0.105, 0.018, { color: carbon, rotZ: s * 0.16 });
    }
    bMetal.addCylinder(-0.045, 0.125, 0.195, 0.006, 0.008, 0.15, 6, { axis: 'y', color: gunmetal, rotX: -0.45 });
    bMetal.addCylinder( 0.045, 0.125, 0.195, 0.006, 0.008, 0.15, 6, { axis: 'y', color: gunmetal, rotX: -0.45 });
    bMetal.addCylinder(0, 0.145, 0.09, 0.022, 0.020, 0.016, 10, { axis: 'y', color: carbonLite }); // GPS puck

    // 3-Blade Pitched Aerodynamic Carbon Propeller + Separate Translucent Spin Disc!
    bRotorBlades.addCylinder(0, 0.018, 0, 0.016, 0.020, 0.026, 10, { axis: 'y', color: gunmetal });
    bRotorBlades.addSphere(0, 0.032, 0, 0.015, 8, 6, { color: gunmetal });
    for (let b = 0; b < 3; b++) {
      const a = (b / 3) * Math.PI * 2;
      const bx = Math.cos(a) * 0.088;
      const bz = Math.sin(a) * 0.088;
      bRotorBlades.addBox(bx, 0.014, bz, 0.165, 0.005, 0.028, {
        color: [0.16, 0.17, 0.19], rotY: -a, rotX: 0.24
      });
    }
    // Translucent circular motion-blur spin disc inside the shroud
    bRotorDisc.addCylinder(0, 0.014, 0, shroudR - 0.012, shroudR - 0.012, 0.003, 20, { axis: 'y', color: [0.44, 0.48, 0.52] });

    // Front Stabilized Spherical EO/IR Optical Camera Ball + Glowing Lens Ring
    bGimbal.addSphere(0, 0, 0, 0.046, 14, 10, { color: [0.22, 0.24, 0.27] });
    bGimbal.addCylinder(0, 0, -0.034, 0.028, 0.032, 0.022, 12, { axis: 'z', color: gunmetal });
    bOpticLens.addSphere(0, 0, -0.046, 0.019, 10, 8, { color: [1, 1, 1] });

    // Underslung VOG-17 / PG-7 Shaped-Charge Finned Warhead + Release Clamp
    bBomb.addCylinder(0, 0, 0, 0.027, 0.025, 0.165, 12, { axis: 'z', color: [0.38, 0.44, 0.30] });
    bBomb.addCylinder(0, 0, -0.03, 0.029, 0.029, 0.045, 12, { axis: 'z', color: [0.28, 0.32, 0.24] }); // frag collar
    bBomb.addCylinder(0, 0, -0.105, 0.008, 0.026, 0.052, 10, { axis: 'z', color: [0.76, 0.68, 0.38] }); // copper/brass fuze
    bBomb.addBox(0, 0, 0.098, 0.088, 0.007, 0.048, { color: [0.26, 0.28, 0.26] });
    bBomb.addBox(0, 0, 0.098, 0.007, 0.088, 0.048, { color: [0.26, 0.28, 0.26] });

    // Primary underside status beacon + rear tactical amber telemetry strobe
    bLed.addSphere(0, -0.022, 0.05, 0.022, 8, 6, { color: [1, 1, 1] });
    bStrobeAmber.addSphere(0, 0.042, 0.165, 0.016, 8, 6, { color: [1, 0.72, 0.15] });

    return {
      frame: buildMesh(bFrame, gl),
      metal: buildMesh(bMetal, gl),
      accent: buildMesh(bAccent, gl),
      accent2: buildMesh(bAccent2, gl),
      rotorBlades: buildMesh(bRotorBlades, gl),
      rotorDisc: buildMesh(bRotorDisc, gl),
      gimbal: buildMesh(bGimbal, gl),
      opticLens: buildMesh(bOpticLens, gl),
      bomb: buildMesh(bBomb, gl),
      led: buildMesh(bLed, gl),
      strobeAmber: buildMesh(bStrobeAmber, gl)
    };
  }

  // Quadruped Robot Dog Leg & Hero Articulated Body Geometry
  const LEG_L1 = 0.34; // Upper hip-to-knee femur length
  const LEG_L2 = 0.34; // Lower knee-to-paw shin length
  const HIP_OFFSETS = [
    [-0.24, -0.03, -0.34], // 0: Front-Left
    [ 0.24, -0.03, -0.34], // 1: Front-Right
    [-0.24, -0.03,  0.34], // 2: Rear-Left
    [ 0.24, -0.03,  0.34]  // 3: Rear-Right
  ];

  function buildDogMeshes(gl) {
    const bTorso = new DF.MeshGen.Builder();
    const bTorsoDark = new DF.MeshGen.Builder();
    const bTorsoChrome = new DF.MeshGen.Builder();
    const bStencil = new DF.MeshGen.Builder();
    const bStencil2 = new DF.MeshGen.Builder();
    const bOptics = new DF.MeshGen.Builder();
    const bStrobeGreen = new DF.MeshGen.Builder();
    const bStrobeAmber = new DF.MeshGen.Builder();
    const bStrobeRed = new DF.MeshGen.Builder();
    const bLidar = new DF.MeshGen.Builder();
    const bUpperLeg = new DF.MeshGen.Builder();
    const bUpperMetal = new DF.MeshGen.Builder();
    const bLowerLeg = new DF.MeshGen.Builder();
    const bLowerPiston = new DF.MeshGen.Builder();
    const bRwsBase = new DF.MeshGen.Builder();
    const bRwsGun = new DF.MeshGen.Builder();
    const bRwsOptic = new DF.MeshGen.Builder();
    const bLaser = new DF.MeshGen.Builder();

    const armorCol = [0.88, 0.90, 0.86];
    const armorShade = [0.74, 0.77, 0.72];
    const darkMetal = [0.24, 0.26, 0.28];
    const gunCol = [0.36, 0.38, 0.40];
    const chromeSteel = [0.82, 0.85, 0.88];

    // 1. Hero Multi-Layered Beveled Armored Chassis
    addBevel(bTorso, 0, 0.04, 0, 0.38, 0.20, 0.88, 0.048, { color: armorCol, aoBottom: 0.66, aoTop: 1.0, uvScale: 0.5 });
    // Upper faceted spine armor deck & sloped glacis nose shield
    addBevel(bTorso, 0, 0.135, -0.02, 0.30, 0.055, 0.66, 0.018, { color: armorShade, uvScale: 0.5 });
    addBevel(bTorso, 0, 0.088, -0.43, 0.32, 0.14, 0.20, 0.032, { color: armorShade, rotX: 0.26, uvScale: 0.5 });
    // Tapered rear armored battery & telemetry pack
    addBevel(bTorso, 0, 0.055, 0.45, 0.30, 0.15, 0.16, 0.026, { color: armorShade, rotX: -0.18, uvScale: 0.5 });

    for (let s = -1; s <= 1; s += 2) {
      // Side ballistic composite armor cheek shields
      addBevel(bTorso, s * 0.205, 0.068, -0.02, 0.055, 0.125, 0.56, 0.016, { color: armorCol, aoBottom: 0.74, aoTop: 1.0 });
      // Recessed Side Cooling Fin Louver Vents (7 CNC fins per flank!)
      bTorsoDark.addBox(s * 0.195, 0.015, 0.0, 0.038, 0.075, 0.38, { color: [0.14, 0.15, 0.16] });
      for (let f = 0; f < 7; f++) {
        bTorsoChrome.addBox(s * 0.214, 0.015, -0.155 + f * 0.052, 0.018, 0.062, 0.014, { color: [0.58, 0.60, 0.62] });
      }
      // Dual concentric hip brushless actuator drums + flange bolts
      bTorsoDark.addCylinder(s * 0.215, -0.03, -0.34, 0.068, 0.068, 0.11, 14, { axis: 'x', color: darkMetal });
      bTorsoDark.addCylinder(s * 0.215, -0.03,  0.34, 0.068, 0.068, 0.11, 14, { axis: 'x', color: darkMetal });
      bTorsoChrome.addCylinder(s * 0.245, -0.03, -0.34, 0.042, 0.042, 0.065, 12, { axis: 'x', color: chromeSteel });
      bTorsoChrome.addCylinder(s * 0.245, -0.03,  0.34, 0.042, 0.042, 0.065, 12, { axis: 'x', color: chromeSteel });
      // Side armored roll-bar / carry handles
      bTorsoDark.addCylinder(s * 0.145, 0.175, -0.32, 0.011, 0.011, 0.14, 8, { axis: 'z', color: darkMetal });
      bTorsoDark.addCylinder(s * 0.145, 0.175,  0.36, 0.011, 0.011, 0.14, 8, { axis: 'z', color: darkMetal });
      // Prominent dual-color faction tactical ID bands along both flanks (Yellow/Blue UA vs Crimson/White RU!)
      bStencil.addBox(s * 0.237, 0.100, -0.08, 0.012, 0.032, 0.36, { color: [1, 1, 1] });
      bStencil2.addBox(s * 0.237, 0.066, -0.08, 0.012, 0.030, 0.36, { color: [1, 1, 1] });
    }
    // Top rear & nose dual-color faction tactical bars
    bStencil.addBox(0, 0.166, 0.24, 0.24, 0.010, 0.044, { color: [1, 1, 1] });
    bStencil2.addBox(0, 0.166, 0.29, 0.24, 0.010, 0.044, { color: [1, 1, 1] });
    bStencil.addBox(0, 0.156, -0.35, 0.22, 0.010, 0.040, { color: [1, 1, 1], rotX: 0.26 });
    bStencil2.addBox(0, 0.145, -0.39, 0.22, 0.010, 0.040, { color: [1, 1, 1], rotX: 0.26 });

    // Lower armored battery skid keel, Picatinny dorsal rail, rear bumper & twin mesh-comms whip antennas
    bTorsoDark.addBox(0, -0.068, 0, 0.30, 0.055, 0.74, { color: darkMetal });
    bTorsoDark.addBox(0, 0.160, 0.04, 0.17, 0.032, 0.54, { color: darkMetal });
    bTorsoDark.addCylinder(0, 0.115, 0.535, 0.014, 0.014, 0.26, 8, { axis: 'x', color: darkMetal });
    bTorsoDark.addCylinder(-0.11, 0.31, 0.44, 0.005, 0.009, 0.36, 6, { axis: 'y', color: darkMetal, rotX: -0.18 });
    bTorsoDark.addCylinder( 0.11, 0.28, 0.44, 0.005, 0.008, 0.28, 6, { axis: 'y', color: darkMetal, rotX: -0.14 });

    // Front Armored Optical Camera Ball Turret + Stereo Depth Visor
    bTorsoDark.addBox(0, 0.035, -0.495, 0.28, 0.105, 0.05, { color: [0.14, 0.15, 0.17] });
    bTorsoDark.addSphere(0, 0.032, -0.515, 0.048, 12, 10, { color: [0.20, 0.22, 0.25] }); // spherical camera ball
    bOptics.addSphere(0, 0.032, -0.556, 0.022, 10, 8, { color: [1, 1, 1] });             // central glowing EO/IR eye
    bOptics.addSphere(-0.092, 0.044, -0.522, 0.018, 10, 8, { color: [1, 1, 1] });        // left stereo camera
    bOptics.addSphere( 0.092, 0.044, -0.522, 0.018, 10, 8, { color: [1, 1, 1] });        // right stereo camera

    // Rear Amber / Red / Green Tactical Status Strobe Array (recessed inside rear tail bumper!)
    bTorsoDark.addBox(0, 0.068, 0.532, 0.22, 0.042, 0.024, { color: [0.12, 0.13, 0.14] });
    bStrobeGreen.addBox(-0.072, 0.068, 0.545, 0.036, 0.018, 0.012, { color: [0.20, 1.0, 0.42] });
    bStrobeAmber.addBox( 0.000, 0.068, 0.545, 0.042, 0.018, 0.012, { color: [1.0, 0.68, 0.12] });
    bStrobeRed.addBox(   0.072, 0.068, 0.545, 0.036, 0.018, 0.012, { color: [1.0, 0.16, 0.12] });

    // Spinning Armored LiDAR Puck on Front Dorsal Mast (with protective collar!)
    bLidar.addCylinder(0, 0.032, 0, 0.026, 0.036, 0.072, 10, { axis: 'y', color: darkMetal });
    bLidar.addCylinder(0, 0.092, 0, 0.054, 0.054, 0.064, 16, { axis: 'y', color: [0.16, 0.18, 0.22] });
    bLidar.addCylinder(0, 0.128, 0, 0.056, 0.056, 0.016, 16, { axis: 'y', color: [0.56, 0.58, 0.60] });
    bLidar.addCylinder(0, 0.058, 0, 0.058, 0.056, 0.014, 16, { axis: 'y', color: [0.48, 0.50, 0.52] });
    bLidar.addBox(0, 0.092, -0.050, 0.034, 0.026, 0.016, { color: [0.18, 0.62, 0.88] });

    // 2. Hero Articulated Upper Leg (Femur): beveled composite armor + hydraulic actuator cylinder!
    bUpperMetal.addCylinder(0, 0, 0, 0.050, 0.050, 0.082, 12, { axis: 'x', color: darkMetal });
    addBevel(bUpperLeg, 0, -LEG_L1 * 0.5, 0, 0.064, LEG_L1, 0.088, 0.016, { color: armorCol, aoBottom: 0.72, aoTop: 1.0 });
    // Parallel hydraulic damper cylinder along back of femur + machined knee servo joint
    bUpperMetal.addCylinder(0, -LEG_L1 * 0.36, 0.052, 0.017, 0.017, LEG_L1 * 0.56, 10, { axis: 'y', color: chromeSteel });
    bUpperMetal.addCylinder(0, -LEG_L1 * 0.72, 0.052, 0.011, 0.011, LEG_L1 * 0.34, 8, { axis: 'y', color: darkMetal });
    bUpperMetal.addCylinder(0, -LEG_L1, 0, 0.044, 0.044, 0.078, 12, { axis: 'x', color: darkMetal });
    bUpperMetal.addBox(0, -LEG_L1 + 0.01, -0.042, 0.056, 0.065, 0.022, { color: gunCol }); // knee bumper guard

    // 3. Hero Articulated Lower Leg (Shin + Hydraulic Shin Piston + High-Traction Combat Paw!)
    addBevel(bLowerLeg, 0, -LEG_L2 * 0.44, -0.008, 0.046, LEG_L2 * 0.88, 0.052, 0.010, { color: darkMetal });
    // Bright chrome hydraulic shin piston cylinder & shock rod behind lower strut!
    bLowerPiston.addCylinder(0, -LEG_L2 * 0.32, 0.034, 0.015, 0.015, LEG_L2 * 0.46, 10, { axis: 'y', color: [0.36, 0.38, 0.40] });
    bLowerPiston.addCylinder(0, -LEG_L2 * 0.66, 0.034, 0.0095, 0.0095, LEG_L2 * 0.44, 8, { axis: 'y', color: chromeSteel });
    // Tapered shin armor splash guard
    addBevel(bLowerLeg, 0, -LEG_L2 * 0.36, -0.032, 0.040, LEG_L2 * 0.52, 0.020, 0.006, { color: armorShade });
    // Sculpted rubberized combat paw pad with ankle clevis (bottom strictly at -LEG_L2)
    bLowerLeg.addCylinder(0, -LEG_L2 + 0.062, 0, 0.026, 0.026, 0.058, 10, { axis: 'x', color: gunCol });
    bLowerLeg.addSphere(0, -LEG_L2 + 0.038, 0, 0.040, 12, 8, { color: [0.15, 0.15, 0.16] });

    // 4. Hero Dorsal Stabilized 7.62mm Remote Weapon Station (RWS)
    bRwsBase.addCylinder(0, 0.036, 0, 0.105, 0.125, 0.072, 14, { axis: 'y', color: darkMetal });
    for (let s = -1; s <= 1; s += 2) {
      addBevel(bRwsBase, s * 0.095, 0.145, 0, 0.036, 0.19, 0.12, 0.010, { color: [0.38, 0.40, 0.38] });
      bRwsBase.addCylinder(s * 0.115, 0.20, 0, 0.036, 0.036, 0.028, 10, { axis: 'x', color: chromeSteel });
    }

    // RWS Stabilized 7.62mm Weapon Cradle + Perforated Shroud + Ammo Drum + Thermal Ball Pod
    addBevel(bRwsGun, 0, 0.02, -0.02, 0.115, 0.115, 0.48, 0.016, { color: gunCol });
    bRwsGun.addBox(0, 0.084, -0.04, 0.042, 0.016, 0.34, { color: darkMetal }); // top Picatinny rail
    bRwsGun.addCylinder(0, 0.025, -0.37, 0.028, 0.030, 0.30, 12, { axis: 'z', color: darkMetal });
    bRwsGun.addCylinder(0, 0.025, -0.59, 0.015, 0.017, 0.24, 10, { axis: 'z', color: gunCol });
    addBevel(bRwsGun, 0, 0.025, -0.72, 0.044, 0.036, 0.072, 0.006, { color: darkMetal }); // muzzle brake
    // Side-mounted ribbed 100-round ammo drum + brass feed chute
    bRwsGun.addCylinder(0.118, -0.018, 0.02, 0.080, 0.080, 0.098, 16, { axis: 'z', color: [0.40, 0.44, 0.36] });
    bRwsGun.addBox(0.068, 0.018, 0.02, 0.045, 0.038, 0.068, { color: [0.74, 0.62, 0.30] });
    // Left EO/IR thermal targeting pod + glowing optic lens
    addBevel(bRwsGun, -0.105, 0.052, -0.08, 0.078, 0.078, 0.17, 0.012, { color: darkMetal });
    bRwsOptic.addSphere(-0.105, 0.052, -0.168, 0.022, 10, 8, { color: [1, 1, 1] });

    // Collimated glowing tactical laser sight beam
    bLaser.addBox(0, 0.01, -4.4, 0.006, 0.006, 8.6, { color: [1, 1, 1] });

    return {
      torso: buildMesh(bTorso, gl),
      torsoDark: buildMesh(bTorsoDark, gl),
      torsoChrome: buildMesh(bTorsoChrome, gl),
      stencil: buildMesh(bStencil, gl),
      stencil2: buildMesh(bStencil2, gl),
      optics: buildMesh(bOptics, gl),
      strobeGreen: buildMesh(bStrobeGreen, gl),
      strobeAmber: buildMesh(bStrobeAmber, gl),
      strobeRed: buildMesh(bStrobeRed, gl),
      lidar: buildMesh(bLidar, gl),
      upperLeg: buildMesh(bUpperLeg, gl),
      upperMetal: buildMesh(bUpperMetal, gl),
      lowerLeg: buildMesh(bLowerLeg, gl),
      lowerPiston: buildMesh(bLowerPiston, gl),
      rwsBase: buildMesh(bRwsBase, gl),
      rwsGun: buildMesh(bRwsGun, gl),
      rwsOptic: buildMesh(bRwsOptic, gl),
      laser: buildMesh(bLaser, gl)
    };
  }

  // ---------------------------------------------------------------------------
  // State & Unit Factory
  // ---------------------------------------------------------------------------
  let _gl = null;
  let _droneMeshes = null;
  let _dogMeshes = null;
  let _units = [];
  let _vogBombs = [];
  let _controlledUnit = null;
  let _time = 0;

  const DRONE_SPAWNS = {
    UA: { pos: [ 42, 27, -6], yaw:  Math.PI * 0.5 },
    RU: { pos: [-66, 27,  8], yaw: -Math.PI * 0.5 }
  };

  // Verified against actual map colliders: >3m-5.5m clear open asphalt in all directions!
  const DOG_SPAWNS = {
    UA: { pos: [-18, 0, -6.0], yaw:  Math.PI * 0.5 },
    RU: { pos: [-58, 0,  5.0], yaw: -Math.PI * 0.5 }
  };

  const DOG_RWS_SPEC = {
    id: 'dog_rws_762',
    projectileType: 'bullet',
    name: '7.62mm RWS',
    displayName: '7.62mm 遥控武器站',
    caliber: '7.62x51mm',
    rpm: 520,
    muzzleVel: 285,
    gravity: 9.8,
    damage: 25,
    vehicleDamage: 6,
    headMult: 2.0,
    armorPen: 0.28,
    tracerInterval: 2,
    suppressionPower: 0.32,
    spreadHip: 0.008,
    spreadAds: 0.004,
    spread: 0.009,
    audioProfile: 'dog_rws'
  };

  function createDrone(faction) {
    const sp = DRONE_SPAWNS[faction];
    const rotorMats = [];
    for (let i = 0; i < 4; i++) rotorMats.push(mat4Create());

    return {
      id: `drone_${faction.toLowerCase()}`,
      type: 'drone',
      isUnmanned: true,
      faction,
      name: faction === 'UA' ? '蓝方 FPV 察打无人机' : '红方 FPV 察打无人机',
      displayName: faction === 'UA' ? '蓝方 FPV 察打无人机' : '红方 FPV 察打无人机',

      pos: new Float32Array(sp.pos),
      vel: new Float32Array([0, 0, 0]),
      forward: new Float32Array([-Math.sin(sp.yaw), 0, -Math.cos(sp.yaw)]),
      yaw: sp.yaw,
      pitch: 0,
      roll: 0,
      gimbalPitch: -0.78, // angled down toward battlefield
      rotorPhase: rand(0, 6.28),
      altitude: sp.pos[1],
      speed: 0,
      signal: 98,

      hp: 90,
      maxHp: 90,
      radius: 0.52,
      height: 0.35,
      alive: true,
      destroyed: false,
      respawnTimer: 0,
      respawnDelay: 15.0,
      spawnGraceTimer: 12.0,
      battery: 100,

      // Weapons & Strike Mode
      ammo: 3,
      bombs: 3,
      maxAmmo: 3,
      bombCooldown: 0,
      bombRegenTimer: 0,
      kamikazeActive: false,
      kamikazePitchBoost: 0,
      releaseDelayTimer: 0,

      // Control & Sensors
      controlledByPlayer: false,
      playerControlled: false,
      thermalMode: false,
      owner: null,
      order: 'recon',
      orderPos: null,
      orbitAngle: faction === 'UA' ? 0 : Math.PI,
      spotTimer: rand(0.1, 0.35),
      aiDropTimer: rand(5.5, 9.0),
      aiHoverTarget: null,
      aiHoverHold: 0,
      spottedCount: 0,

      // Dedicated per-part matrices
      _matBody: mat4Create(),
      _matRotors: rotorMats,
      _matGimbal: mat4Create(),
      _matBomb: mat4Create(),
      _matTmp: mat4Create()
    };
  }

  function createDog(faction) {
    const sp = DOG_SPAWNS[faction];
    const gy = getGroundY(sp.pos[0], sp.pos[2], 6.0);
    const upperMats = [];
    const lowerMats = [];
    for (let i = 0; i < 4; i++) {
      upperMats.push(mat4Create());
      lowerMats.push(mat4Create());
    }

    return {
      id: `dog_${faction.toLowerCase()}`,
      type: 'dog',
      isUnmanned: true,
      faction,
      name: faction === 'UA' ? '蓝方武装机器狗' : '红方武装机器狗',
      displayName: faction === 'UA' ? '蓝方武装机器狗' : '红方武装机器狗',

      pos: new Float32Array([sp.pos[0], gy, sp.pos[2]]), // feet ground elevation!
      vel: new Float32Array([0, 0, 0]),
      forward: new Float32Array([-Math.sin(sp.yaw), 0, -Math.cos(sp.yaw)]),
      yaw: sp.yaw,
      pitch: 0,
      roll: 0,
      grounded: true,
      stance: 'trot',

      // Dorsal Stabilized RWS Turret
      rwsYaw: sp.yaw,
      rwsPitch: 0,
      muzzleWorldPos: new Float32Array(3),
      muzzleWorldDir: new Float32Array([-Math.sin(sp.yaw), 0, -Math.cos(sp.yaw)]),
      muzzleFlashTimer: 0,

      // Quadruped Kinematics & Gait
      hipHeight: 0.56,
      gaitPhase: rand(0, 6.28),
      lidarAngle: 0,
      bodyBob: 0,
      speed: 0,
      legUpperAngles: new Float32Array(4),
      legKneeAngles: new Float32Array(4),

      // Combat Stats (reinforced composite carapace so robot dog survives active firefights!)
      hp: 265,
      maxHp: 265,
      radius: 0.42,
      height: 0.96,
      alive: true,
      destroyed: false,
      respawnTimer: 0,
      respawnDelay: 16.0,
      spawnGraceTimer: 6.5,
      battery: 100,

      ammo: 100,
      maxAmmo: 100,
      fireCooldown: 0,
      reloadTimer: 0,
      burstRemaining: 0,
      burstPause: 0,

      // Control & AI
      controlledByPlayer: false,
      playerControlled: false,
      thermalMode: false,
      camMode: 0, // 0: low-slung tactical view, 1: RWS optic zoom
      aimZoom: false,
      owner: null,
      order: 'flank',
      orderPos: null,
      aiPath: null,
      aiPathIdx: 0,
      aiPathTimer: rand(0.3, 1.0),
      aiScanTimer: rand(0.15, 0.35),
      aiTarget: null,
      spotTimer: rand(0.2, 0.4),

      // Dedicated per-part matrices
      _matTorso: mat4Create(),
      _matLidar: mat4Create(),
      _matRwsBase: mat4Create(),
      _matRwsGun: mat4Create(),
      _matLegUpper: upperMats,
      _matLegLower: lowerMats,
      _matTmp: mat4Create(),
      _matTmp2: mat4Create()
    };
  }

  // ---------------------------------------------------------------------------
  // 2-Bone Analytical Leg IK for Articulated Quadruped Robot Dog
  // ---------------------------------------------------------------------------
  function solveDogLegIK(dxForward, dyDown) {
    // dxForward: foot displacement along local -Z (positive = forward)
    // dyDown: vertical distance down from hip to foot (positive = below hip)
    const maxReach = (LEG_L1 + LEG_L2) * 0.96;
    const minReach = 0.16;
    let dist = Math.hypot(dxForward, dyDown);
    if (dist > maxReach) {
      const s = maxReach / dist;
      dxForward *= s;
      dyDown *= s;
      dist = maxReach;
    } else if (dist < minReach) {
      dyDown = minReach;
      dist = minReach;
    }

    // Law of cosines for knee bend (dog-style backward-bending knee!)
    const cosKnee = clamp((LEG_L1 * LEG_L1 + LEG_L2 * LEG_L2 - dist * dist) / (2 * LEG_L1 * LEG_L2), -1, 1);
    const interiorKnee = Math.acos(cosKnee);
    const kneeFlex = Math.PI - interiorKnee; // positive bend

    const baseAngle = Math.atan2(dxForward, dyDown);
    const cosAlpha = clamp((LEG_L1 * LEG_L1 + dist * dist - LEG_L2 * LEG_L2) / (2 * LEG_L1 * dist), -1, 1);
    const alpha = Math.acos(cosAlpha);

    // Note on Rx rotation of -Y vector: Rx(theta)*(0, -1, 0) = (0, -cos(theta), -sin(theta))
    // So positive theta swings the limb FORWARD (-Z)!
    // Dog legs bend knee backward (upper tilts slightly back, lower extends forward) -> upper = baseAngle - alpha, knee = +kneeFlex
    return {
      hipPitch: baseAngle - alpha * 0.92,
      kneePitch: kneeFlex * 0.92
    };
  }

  function updateDogTransforms(u, dt) {
    const spd = Math.hypot(u.vel[0], u.vel[2]);
    u.speed = spd;
    u.lidarAngle += dt * 10.5;
    u.forward[0] = -Math.sin(u.yaw);
    u.forward[1] = 0;
    u.forward[2] = -Math.cos(u.yaw);

    // Advance alternating diagonal trot/gallop gait phase synced to ground speed!
    if (spd > 0.18 && u.grounded) {
      const freq = lerp(5.2, 13.5, clamp(spd / 10.0, 0, 1));
      u.gaitPhase += dt * freq;
      u.bodyBob = Math.abs(Math.sin(u.gaitPhase)) * 0.032 * clamp(spd / 5.0, 0, 1);
    } else {
      u.bodyBob = damp(u.bodyBob, 0.008 * Math.sin(_time * 2.6), 8.0, dt);
    }

    // Terrain slope conformance
    const fx = u.forward[0], fz = u.forward[2];
    const rx = Math.cos(u.yaw), rz = -Math.sin(u.yaw);
    const refY = u.pos[1] + 0.7;
    const yf = getGroundY(u.pos[0] + fx * 0.36, u.pos[2] + fz * 0.36, refY);
    const yr = getGroundY(u.pos[0] - fx * 0.36, u.pos[2] - fz * 0.36, refY);
    const yl = getGroundY(u.pos[0] - rx * 0.24, u.pos[2] - rz * 0.24, refY);
    const yri = getGroundY(u.pos[0] + rx * 0.24, u.pos[2] + rz * 0.24, refY);
    const targetPitch = clamp(Math.atan2(yf - yr, 0.72), -0.45, 0.45);
    const targetRoll = clamp(Math.atan2(yl - yri, 0.48), -0.35, 0.35);
    u.pitch = damp(u.pitch, targetPitch, 14.0, dt);
    u.roll = damp(u.roll, targetRoll, 14.0, dt);

    const torsoY = u.pos[1] + u.hipHeight + u.bodyBob;
    mat4FromYXZ(u._matTorso, u.pos[0], torsoY, u.pos[2], u.yaw, u.pitch, u.roll, 1, 1, 1);

    // Spinning LiDAR puck on front brow
    mat4FromYXZ(u._matTmp, 0, 0.145, -0.26, u.lidarAngle, 0, 0, 1, 1, 1);
    mat4Mul(u._matLidar, u._matTorso, u._matTmp);

    // Dorsal Stabilized 7.62mm RWS Turret
    const relRwsYaw = angleDiff(u.yaw, u.rwsYaw);
    mat4FromYXZ(u._matTmp, 0, 0.155, 0.05, relRwsYaw, 0, 0, 1, 1, 1);
    mat4Mul(u._matRwsBase, u._matTorso, u._matTmp);

    const relRwsPitch = clamp(u.rwsPitch - u.pitch * Math.cos(relRwsYaw), -0.45, 0.75);
    mat4FromYXZ(u._matTmp, 0, 0.20, 0, 0, relRwsPitch, 0, 1, 1, 1);
    mat4Mul(u._matRwsGun, u._matRwsBase, u._matTmp);

    mat4TransformPoint(u.muzzleWorldPos, u._matRwsGun, 0, 0.025, -0.74);
    mat4TransformDir(u.muzzleWorldDir, u._matRwsGun, 0, 0, -1);

    // 4 Articulated Two-Segment IK Legs!
    // Diagonal trot pairing: FL(0) + RR(3) in phase; FR(1) + RL(2) shifted by PI
    // At sprint (>7 m/s) shifts smoothly toward energetic bound/gallop!
    const gallopBlend = clamp((spd - 6.5) / 3.5, 0, 1);
    const phaseOffsets = [
      0,
      lerp(Math.PI, 0.45, gallopBlend),
      lerp(Math.PI, Math.PI + 0.25, gallopBlend),
      lerp(0, Math.PI + 0.70, gallopBlend)
    ];

    const strideAmp = clamp(spd * 0.036, 0, 0.25);
    const liftAmp = clamp(spd * 0.022, 0, 0.14);

    // Project velocity into dog local frame for accurate forward/reverse stride sign
    const fwdSpeed = u.vel[0] * fx + u.vel[2] * fz;
    const strideDir = Math.abs(fwdSpeed) > 0.15 ? Math.sign(fwdSpeed) : 1;

    for (let i = 0; i < 4; i++) {
      const hip = HIP_OFFSETS[i];
      const ph = u.gaitPhase + phaseOffsets[i];
      const swingSin = Math.sin(ph);
      const swingCos = Math.cos(ph);

      // Horizontal stride along -Z (forward)
      const footFwd = (u.grounded && spd > 0.18) ? (swingCos * strideAmp * strideDir) : 0;
      const footLift = (u.grounded && spd > 0.18) ? Math.max(0, swingSin) * liftAmp : (!u.grounded ? 0.14 : 0);

      // Sample exact terrain ground directly under each paw so paws never float on stairs/slopes!
      const hipWorld = [0, 0, 0];
      mat4TransformPoint(hipWorld, u._matTorso, hip[0], hip[1], hip[2]);
      const pawGroundY = getGroundY(hipWorld[0] + fx * footFwd, hipWorld[2] + fz * footFwd, hipWorld[1] + 0.45);
      const dyDown = clamp((hipWorld[1] - pawGroundY) - footLift, 0.24, LEG_L1 + LEG_L2 - 0.03);

      const ik = solveDogLegIK(footFwd, dyDown);
      u.legUpperAngles[i] = ik.hipPitch;
      u.legKneeAngles[i] = ik.kneePitch;

      // Upper femur transform from hip
      mat4FromYXZ(u._matTmp, hip[0], hip[1], hip[2], 0, ik.hipPitch, 0, 1, 1, 1);
      mat4Mul(u._matLegUpper[i], u._matTorso, u._matTmp);

      // Lower shin + paw transform from knee (at local 0, -LEG_L1, 0 of upper femur)
      mat4FromYXZ(u._matTmp2, 0, -LEG_L1, 0, 0, ik.kneePitch, 0, 1, 1, 1);
      mat4Mul(u._matLegLower[i], u._matLegUpper[i], u._matTmp2);
    }
  }

  function updateDroneTransforms(u, dt) {
    u.rotorPhase += dt * (u.kamikazeActive ? 88.0 : 54.0);
    u.forward[0] = -Math.sin(u.yaw);
    u.forward[1] = 0;
    u.forward[2] = -Math.cos(u.yaw);

    mat4FromYXZ(u._matBody, u.pos[0], u.pos[1], u.pos[2], u.yaw, u.pitch, u.roll, 1, 1, 1);

    for (let i = 0; i < 4; i++) {
      const ro = ROTOR_OFFSETS[i];
      const spinSign = (i === 0 || i === 3) ? 1 : -1;
      mat4FromYXZ(u._matTmp, ro[0], ro[1], ro[2], u.rotorPhase * spinSign, 0, 0, 1, 1, 1);
      mat4Mul(u._matRotors[i], u._matBody, u._matTmp);
    }

    // Stabilized front EO/IR gimbal counter-pitches chassis tilt
    mat4FromYXZ(u._matTmp, 0, -0.015, -0.17, 0, u.gimbalPitch - u.pitch, -u.roll, 1, 1, 1);
    mat4Mul(u._matGimbal, u._matBody, u._matTmp);

    // Underslung VOG-17 finned grenade
    mat4FromYXZ(u._matTmp, 0, -0.055, -0.01, 0, u.kamikazeActive ? 0.0 : -0.15, 0, 1, 1, 1);
    mat4Mul(u._matBomb, u._matBody, u._matTmp);
  }

  // ---------------------------------------------------------------------------
  // Drone VOG-17 Grenade Drop & FPV Kamikaze Shaped-Charge Strike
  // ---------------------------------------------------------------------------
  function dropVogGrenade(u) {
    if (!u || !u.alive || u.ammo <= 0 || u.bombCooldown > 0) return false;
    u.ammo--;
    u.bombCooldown = 1.15;
    u.bombRegenTimer = 8.5;

    const dropPos = [u.pos[0], u.pos[1] - 0.25, u.pos[2]];
    const dropVel = [u.vel[0] * 0.42, -1.5, u.vel[2] * 0.42];

    _vogBombs.push({
      pos: dropPos,
      vel: dropVel,
      faction: u.faction,
      owner: u.owner || u,
      life: 7.0
    });

    if (DF.Audio && typeof DF.Audio.playReloadFoley === 'function') {
      DF.Audio.playReloadFoley('mag_out', dropPos);
    }
    if (u.controlledByPlayer && DF.UI && typeof DF.UI.showNotification === 'function') {
      DF.UI.showNotification(`VOG-17 榴弹已投掷 (剩余 ${u.ammo}/${u.maxAmmo})`, 'info');
    }
    return true;
  }

  function updateVogBombs(dt) {
    for (let i = _vogBombs.length - 1; i >= 0; i--) {
      const b = _vogBombs[i];
      b.life -= dt;
      if (b.life <= 0) {
        _vogBombs.splice(i, 1);
        continue;
      }

      const prev = [b.pos[0], b.pos[1], b.pos[2]];
      b.vel[1] -= 14.5 * dt;
      b.pos[0] += b.vel[0] * dt;
      b.pos[1] += b.vel[1] * dt;
      b.pos[2] += b.vel[2] * dt;

      const dx = b.pos[0] - prev[0], dy = b.pos[1] - prev[1], dz = b.pos[2] - prev[2];
      const dist = Math.hypot(dx, dy, dz);
      let hitPoint = null;
      let hitVehicle = null;

      if (DF.Physics && typeof DF.Physics.raycast === 'function' && dist > 0.001) {
        const hit = DF.Physics.raycast(prev, [dx / dist, dy / dist, dz / dist], dist, {
          checkEntities: true,
          checkVehicles: true
        });
        if (hit) {
          hitPoint = hit.point;
          hitVehicle = hit.vehicle || (hit.collider && hit.collider.meta && hit.collider.meta.vehicle);
        }
      }

      const gy = getGroundY(b.pos[0], b.pos[2], prev[1] + 0.5);
      if (!hitPoint && b.pos[1] <= gy + 0.08) {
        hitPoint = [b.pos[0], gy + 0.08, b.pos[2]];
      }

      if (hitPoint) {
        // Direct top-armor bonus if VOG lands on an armored vehicle!
        if (hitVehicle && DF.Armor && typeof DF.Armor.damageVehicle === 'function') {
          DF.Armor.damageVehicle(hitVehicle, 115, 'top', b.owner, hitPoint, [0, -1, 0]);
        }
        if (DF.Game && typeof DF.Game.applyExplosion === 'function') {
          DF.Game.applyExplosion(hitPoint, 5.2, 135, b.owner, 'vog17_drone');
        } else {
          if (DF.Audio && typeof DF.Audio.playExplosion === 'function') {
            DF.Audio.playExplosion(hitPoint, 1.1);
          }
          spawnParticle({
            type: 'shockwave', pos: hitPoint, vel: [0, 0.2, 0],
            size: 0.5, sizeEnd: 5.0, life: 0.32, color: [0.98, 0.86, 0.68], alpha: 0.55
          });
          for (let k = 0; k < 10; k++) {
            spawnParticle({
              type: 'fire', pos: hitPoint,
              vel: [rand(-4, 4), rand(2, 7), rand(-4, 4)],
              size: 0.7, sizeEnd: 2.0, life: 0.55,
              color: [1.0, 0.55, 0.15], alpha: 0.88, additive: false
            });
          }
        }
        _vogBombs.splice(i, 1);
      }
    }
  }

  function engageKamikaze(u) {
    if (!u || !u.alive || u.type !== 'drone' || u.kamikazeActive) return false;
    u.kamikazeActive = true;
    u.kamikazePitchBoost = 1.0;
    if (u.controlledByPlayer && DF.UI && typeof DF.UI.showNotification === 'function') {
      DF.UI.showNotification('FPV 自杀俯冲打击模式启动! 瞄准载具顶部装甲!', 'warn');
    }
    return true;
  }

  function detonateFpvDrone(u, impactPos, impactDir) {
    if (!u.alive) return;
    const pos = impactPos || [u.pos[0], u.pos[1], u.pos[2]];
    const dir = impactDir || [0, -1, 0];
    const attacker = u.owner || u;

    // Shaped-charge anti-armor warhead: devastates enemy tank top armor (2.0x multiplier)!
    if (DF.Armor && typeof DF.Armor.getVehicles === 'function') {
      const vehicles = DF.Armor.getVehicles();
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        if (!v.alive || v.faction === u.faction) continue;
        const d = Math.hypot(v.pos[0] - pos[0], v.pos[1] + 1.4 - pos[1], v.pos[2] - pos[2]);
        if (d < 5.2) {
          const zone = (pos[1] > v.pos[1] + v.height * 0.62 || dir[1] < -0.35) ? 'top' : 'side';
          const shapedDmg = d < 3.4 ? 360 : 210;
          DF.Armor.damageVehicle(v, shapedDmg, zone, attacker, pos, dir);
        }
      }
    }

    // Destroy drone as kamikaze BEFORE applyExplosion so blast splash never registers a non-kamikaze self-kill
    destroyUnit(u, attacker, true);

    if (DF.Game && typeof DF.Game.applyExplosion === 'function') {
      DF.Game.applyExplosion(pos, 7.5, 225, attacker, 'fpv_kamikaze');
    } else if (DF.Audio && typeof DF.Audio.playExplosion === 'function') {
      DF.Audio.playExplosion(pos, 1.8);
    }

    spawnParticle({
      type: 'flash', pos: [pos[0], pos[1], pos[2]], vel: [0, 0.4, 0],
      size: 2.2, sizeEnd: 4.5, life: 0.18, color: [1.0, 0.86, 0.48], alpha: 0.96, additive: true
    });
    spawnParticle({
      type: 'shockwave', pos: [pos[0], pos[1], pos[2]], vel: [0, 0.2, 0],
      size: 0.8, sizeEnd: 8.2, life: 0.36, color: [1.0, 0.86, 0.66], alpha: 0.62
    });
    for (let k = 0; k < 16; k++) {
      spawnParticle({
        type: 'fire', pos: [pos[0], pos[1], pos[2]],
        vel: [rand(-6, 6), rand(2, 10), rand(-6, 6)],
        size: 0.9, sizeEnd: 3.0, life: rand(0.45, 0.95),
        color: [1.0, 0.52, 0.14], alpha: 0.90, additive: false
      });
    }
    for (let k = 0; k < 20; k++) {
      spawnParticle({
        type: 'spark', pos: [pos[0], pos[1], pos[2]],
        vel: [rand(-12, 12), rand(4, 14), rand(-12, 12)],
        size: rand(0.12, 0.20), sizeEnd: 0.04, life: rand(0.35, 0.95),
        color: [1.0, rand(0.58, 0.86), 0.28], alpha: 1.0, gravity: 11.0, stretch: 4.0, additive: true
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Recon & Target Spotting (Shared by Drone & Robot Dog)
  // ---------------------------------------------------------------------------
  function performReconScan(u, radius) {
    let spotted = 0;
    const eye = [u.pos[0], u.pos[1] + (u.type === 'dog' ? 0.85 : -0.15), u.pos[2]];

    if (DF.AI && typeof DF.AI.getSoldiers === 'function') {
      const soldiers = DF.AI.getSoldiers();
      for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i];
        if (!s || s.state !== 'alive' || s.faction === u.faction) continue;
        const dist = Math.hypot(s.pos[0] - eye[0], s.pos[2] - eye[2]);
        if (dist > radius) continue;
        const tgtPos = [s.pos[0], s.pos[1] + 1.1, s.pos[2]];

        if (DF.Physics && typeof DF.Physics.lineBlockedBySmoke === 'function') {
          // Thermal-equipped drone still spots faintly through thin smoke, but respect heavy smoke
          if (!u.thermalMode && DF.Physics.lineBlockedBySmoke(eye, tgtPos)) continue;
        }
        if (DF.Physics && typeof DF.Physics.raycast === 'function') {
          const dx = tgtPos[0] - eye[0], dy = tgtPos[1] - eye[1], dz = tgtPos[2] - eye[2];
          const d3 = Math.hypot(dx, dy, dz) || 1;
          const h = DF.Physics.raycast(eye, [dx / d3, dy / d3, dz / d3], d3 - 0.6, {});
          if (h && h.dist < d3 - 1.2) continue;
        }

        s.spottedTimer = Math.max(s.spottedTimer || 0, 5.5);
        spotted++;
      }
    }

    if (DF.Armor && typeof DF.Armor.getVehicles === 'function') {
      const vehicles = DF.Armor.getVehicles();
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        if (!v.alive || v.faction === u.faction) continue;
        const dist = Math.hypot(v.pos[0] - eye[0], v.pos[2] - eye[2]);
        if (dist < radius + 12) {
          v.spottedTimer = Math.max(v.spottedTimer || 0, 6.5);
          spotted++;
        }
      }
    }

    u.spottedCount = spotted;
    if (spotted > 0 && DF.AI && typeof DF.AI.spotTarget === 'function') {
      DF.AI.spotTarget([u.pos[0], 0, u.pos[2]], u.faction);
    }
  }

  function getActiveCombatCenter(faction) {
    if (DF.Map && typeof DF.Map.getSectors === 'function') {
      const secs = DF.Map.getSectors() || [];
      const active = secs.find(s => s.active) || secs[0];
      if (active && active.pos) return active.pos;
    }
    return faction === 'UA' ? [-10, 0, 0] : [8, 0, 0];
  }

  // ---------------------------------------------------------------------------
  // Drone AI & Player Flight Controllers
  // ---------------------------------------------------------------------------
  function readInput(inp) {
    if (!inp) return { fwd: 0, right: 0, ascendVal: 0, jump: false, sprint: false, dx: 0, dy: 0, fire: false, altFire: false, thermal: false, kamikaze: false, camCycle: false };
    const fwd = inp.forward !== undefined ? inp.forward : ((inp.w ? 1 : 0) - (inp.s ? 1 : 0));
    const right = inp.strafe !== undefined ? inp.strafe : (inp.right !== undefined ? inp.right : ((inp.d ? 1 : 0) - (inp.a ? 1 : 0)));
    const ascendVal = typeof inp.ascend === 'number'
      ? inp.ascend
      : (((inp.up || inp.ascend || inp.jump || inp.space) ? 1 : 0) - ((inp.down || inp.descend || inp.crouch || inp.shift) ? 1 : 0));
    const jump = !!(inp.jump || inp.space || (typeof inp.ascend === 'number' && inp.ascend > 0.5));
    const sprint = !!(inp.sprint || inp.shift);
    const dx = inp.lookDeltaX !== undefined ? inp.lookDeltaX : (inp.mouseDX !== undefined ? inp.mouseDX : (inp.lookDX !== undefined ? inp.lookDX : (inp.dx || 0)));
    const dy = inp.lookDeltaY !== undefined ? inp.lookDeltaY : (inp.mouseDY !== undefined ? inp.mouseDY : (inp.lookDY !== undefined ? inp.lookDY : (inp.dy || 0)));
    const fire = !!(inp.fire || inp.lmb || inp.primary);
    const altFire = !!(inp.secondary || inp.altFire || inp.rmb);
    const thermal = !!(inp.thermalToggle || inp.tPressed);
    const kamikaze = !!(inp.kamikaze || inp.dive || inp.fPressed);
    const camCycle = !!(inp.camCycle || inp.cPressed);
    return { fwd, right, ascendVal, jump, sprint, dx, dy, fire, altFire, thermal, kamikaze, camCycle, absYaw: inp.aimYaw, absPitch: inp.aimPitch };
  }

  function updateDrone(u, dt, pIn) {
    if (u.spawnGraceTimer > 0) u.spawnGraceTimer = Math.max(0, u.spawnGraceTimer - dt);
    if (u.bombCooldown > 0) u.bombCooldown = Math.max(0, u.bombCooldown - dt);
    if (u.ammo < u.maxAmmo) {
      u.bombRegenTimer -= dt;
      if (u.bombRegenTimer <= 0) {
        u.ammo = Math.min(u.maxAmmo, u.ammo + 1);
        u.bombRegenTimer = 9.0;
      }
    }
    u.bombs = u.ammo;
    u.altitude = u.pos[1];
    u.speed = Math.hypot(u.vel[0], u.vel[1], u.vel[2]);
    u.battery = clamp(u.battery - dt * (u.kamikazeActive ? 1.8 : 0.16), 12, 100);
    u.signal = clamp(100 - Math.hypot(u.pos[0], u.pos[2]) * 0.14, 72, 99);

    // Periodic spotting in both AI and player flight!
    u.spotTimer -= dt;
    if (u.spotTimer <= 0) {
      u.spotTimer = 0.40;
      performReconScan(u, 50.0);
    }

    let desiredVx = 0, desiredVy = 0, desiredVz = 0;

    if (u.controlledByPlayer) {
      // Mouse yaw + gimbal pitch down to -85 deg!
      if (pIn.absYaw !== undefined && pIn.dx === 0 && pIn.dy === 0) {
        u.yaw = pIn.absYaw;
        if (pIn.absPitch !== undefined) u.gimbalPitch = clamp(pIn.absPitch, -1.483, 0.28);
      } else {
        const sens = (Math.abs(pIn.dx) > 0.35 || Math.abs(pIn.dy) > 0.35) ? 0.0022 : 1.0;
        u.yaw -= pIn.dx * sens;
        u.gimbalPitch = clamp(u.gimbalPitch - pIn.dy * sens, -1.483, 0.28); // down to -85 deg!
      }

      if (pIn.thermal) {
        u.thermalMode = !u.thermalMode;
        if (DF.UI && typeof DF.UI.showNotification === 'function') {
          DF.UI.showNotification(u.thermalMode ? '无人机 FLIR 热成像已开启' : '无人机光学画面', 'info');
        }
      }
      if (pIn.kamikaze) engageKamikaze(u);
      if (pIn.fire && !u.kamikazeActive) dropVogGrenade(u);

      if (u.kamikazeActive) {
        // High-speed FPV Kamikaze Dive along camera vector!
        const diveDir = [0, 0, 0];
        yawPitchToDir(u.yaw, u.gimbalPitch, diveDir);
        const diveSpeed = 34.0;
        desiredVx = diveDir[0] * diveSpeed;
        desiredVy = diveDir[1] * diveSpeed;
        desiredVz = diveDir[2] * diveSpeed;
        u.vel[0] = damp(u.vel[0], desiredVx, 7.5, dt);
        u.vel[1] = damp(u.vel[1], desiredVy, 7.5, dt);
        u.vel[2] = damp(u.vel[2], desiredVz, 7.5, dt);
        u.kamikazePitchBoost = Math.min(2.2, u.kamikazePitchBoost + dt * 0.9);
      } else {
        const fx = -Math.sin(u.yaw), fz = -Math.cos(u.yaw);
        const rx = Math.cos(u.yaw), rz = -Math.sin(u.yaw);
        const hSpeed = 17.5;
        desiredVx = (fx * pIn.fwd + rx * pIn.right) * hSpeed;
        desiredVz = (fz * pIn.fwd + rz * pIn.right) * hSpeed;
        desiredVy = pIn.ascendVal * 9.5;

        u.vel[0] = damp(u.vel[0], desiredVx, 5.2, dt);
        u.vel[1] = damp(u.vel[1], desiredVy, 5.8, dt);
        u.vel[2] = damp(u.vel[2], desiredVz, 5.2, dt);
      }
    } else {
      // Autonomous Recon & VOG-17 Strike AI!
      const center = u.orderPos || getActiveCombatCenter(u.faction);
      u.aiDropTimer -= dt;

      if (u.aiHoverTarget) {
        // Lining up directly over enemy cluster/vehicle for precision VOG-17 drop
        const tx = u.aiHoverTarget[0], tz = u.aiHoverTarget[2];
        const targetAlt = Math.max(getGroundY(tx, tz, 28) + 25.0, 25.0);
        const dx = tx - u.pos[0], dz = tz - u.pos[2];
        const distH = Math.hypot(dx, dz);
        desiredVx = clamp(dx * 1.4, -12, 12);
        desiredVz = clamp(dz * 1.4, -12, 12);
        desiredVy = clamp((targetAlt - u.pos[1]) * 1.6, -6, 6);
        u.yaw = damp(u.yaw, dirToYaw(dx, dz), 3.0, dt);
        u.gimbalPitch = damp(u.gimbalPitch, -1.45, 5.0, dt);

        if (distH < 2.2) {
          u.aiHoverHold += dt;
          if (u.aiHoverHold >= 0.75) {
            dropVogGrenade(u);
            u.aiHoverTarget = null;
            u.aiHoverHold = 0;
            u.aiDropTimer = rand(9.5, 13.5);
          }
        } else if (u.aiDropTimer < -7.0) {
          u.aiHoverTarget = null;
          u.aiDropTimer = 6.0;
        }
      } else {
        // Smooth figure-8 / elliptical combat orbit at safe 24-30m cruise altitude
        u.orbitAngle += dt * 0.34;
        const ox = center[0] + Math.cos(u.orbitAngle) * 20.0;
        const oz = center[2] + Math.sin(u.orbitAngle * 1.3) * 16.0;
        const oy = 27.0 + Math.sin(u.orbitAngle * 2.0) * 3.0;

        const dx = ox - u.pos[0], dz = oz - u.pos[2];
        desiredVx = clamp(dx * 0.9, -11, 11);
        desiredVz = clamp(dz * 0.9, -11, 11);
        desiredVy = clamp((oy - u.pos[1]) * 1.2, -5, 5);
        u.yaw = damp(u.yaw, dirToYaw(center[0] - u.pos[0], center[2] - u.pos[2]), 2.5, dt);
        u.gimbalPitch = damp(u.gimbalPitch, -0.82, 3.0, dt);

        // Pick an enemy target cluster to bomb when ready
        if (u.aiDropTimer <= 0 && u.ammo > 0) {
          const tgt = findDroneBombTarget(u);
          if (tgt) {
            u.aiHoverTarget = tgt;
            u.aiHoverHold = 0;
          } else {
            u.aiDropTimer = 3.5;
          }
        }
      }

      u.vel[0] = damp(u.vel[0], desiredVx, 3.6, dt);
      u.vel[1] = damp(u.vel[1], desiredVy, 4.0, dt);
      u.vel[2] = damp(u.vel[2], desiredVz, 3.6, dt);
    }

    // Move drone & check collisions (or Kamikaze detonation!)
    const prevPos = [u.pos[0], u.pos[1], u.pos[2]];
    const stepX = u.vel[0] * dt;
    const stepY = u.vel[1] * dt;
    const stepZ = u.vel[2] * dt;
    const stepDist = Math.hypot(stepX, stepY, stepZ);

    if (stepDist > 0.001 && DF.Physics && typeof DF.Physics.raycast === 'function') {
      const dir = [stepX / stepDist, stepY / stepDist, stepZ / stepDist];
      const hit = DF.Physics.raycast(prevPos, dir, stepDist + (u.kamikazeActive ? 0.85 : 0.45), {
        checkEntities: u.kamikazeActive,
        checkVehicles: true
      });
      if (hit) {
        if (u.kamikazeActive) {
          detonateFpvDrone(u, hit.point, dir);
          return;
        }
        // Soft bounce off wall in normal flight
        u.vel[0] = (hit.normal ? hit.normal[0] * 3.0 : -u.vel[0] * 0.4);
        u.vel[1] = (hit.normal ? hit.normal[1] * 2.5 : u.vel[1] * 0.4);
        u.vel[2] = (hit.normal ? hit.normal[2] * 3.0 : -u.vel[2] * 0.4);
      }
    }

    u.pos[0] = clamp(u.pos[0] + u.vel[0] * dt, -87, 87);
    u.pos[1] = clamp(u.pos[1] + u.vel[1] * dt, 0.2, 46.0);
    u.pos[2] = clamp(u.pos[2] + u.vel[2] * dt, -52, 52);

    const gy = getGroundY(u.pos[0], u.pos[2], u.pos[1] + 0.8);
    if (u.pos[1] <= gy + (u.kamikazeActive ? 0.45 : 0.55)) {
      if (u.kamikazeActive) {
        detonateFpvDrone(u, [u.pos[0], gy + 0.15, u.pos[2]], [0, -1, 0]);
        return;
      }
      u.pos[1] = gy + 0.55;
      if (u.vel[1] < 0) u.vel[1] = 0;
    }

    // Proximity trigger for Kamikaze Dive against enemy vehicles/soldiers
    if (u.kamikazeActive) {
      if (DF.Armor && typeof DF.Armor.getVehicles === 'function') {
        const vehs = DF.Armor.getVehicles();
        for (let i = 0; i < vehs.length; i++) {
          const v = vehs[i];
          if (!v.alive || v.faction === u.faction) continue;
          const d = Math.hypot(v.pos[0] - u.pos[0], v.pos[1] + 1.4 - u.pos[1], v.pos[2] - u.pos[2]);
          if (d < 2.6) {
            detonateFpvDrone(u, [u.pos[0], u.pos[1], u.pos[2]], [0, -1, 0]);
            return;
          }
        }
      }
    }

    // Realistic quadcopter visual tilt bank proportional to local velocity
    const fx = -Math.sin(u.yaw), fz = -Math.cos(u.yaw);
    const rx = Math.cos(u.yaw), rz = -Math.sin(u.yaw);
    const localFwd = u.vel[0] * fx + u.vel[2] * fz;
    const localRight = u.vel[0] * rx + u.vel[2] * rz;
    const targetPitch = u.kamikazeActive ? clamp(u.gimbalPitch, -0.95, 0.4) : clamp(-localFwd * 0.032, -0.45, 0.45);
    const targetRoll = clamp(-localRight * 0.036, -0.52, 0.52);
    u.pitch = damp(u.pitch, targetPitch, 9.0, dt);
    u.roll = damp(u.roll, targetRoll, 9.0, dt);

    updateDroneTransforms(u, dt);
  }

  function findDroneBombTarget(u) {
    let bestPos = null;
    let bestScore = -1;

    // Prioritize enemy armored vehicles for top-attack VOG drops!
    if (DF.Armor && typeof DF.Armor.getVehicles === 'function') {
      const vehs = DF.Armor.getVehicles();
      for (let i = 0; i < vehs.length; i++) {
        const v = vehs[i];
        if (!v.alive || v.faction === u.faction) continue;
        const d = Math.hypot(v.pos[0] - u.pos[0], v.pos[2] - u.pos[2]);
        if (d < 65 && (120 - d) > bestScore) {
          bestScore = 120 - d;
          bestPos = [v.pos[0], v.pos[1], v.pos[2]];
        }
      }
    }

    // Enemy infantry clusters
    if (DF.AI && typeof DF.AI.getSoldiers === 'function') {
      const soldiers = DF.AI.getSoldiers();
      for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i];
        if (!s || s.state !== 'alive' || s.faction === u.faction) continue;
        const d = Math.hypot(s.pos[0] - u.pos[0], s.pos[2] - u.pos[2]);
        if (d > 58) continue;
        let cluster = 1;
        for (let j = 0; j < soldiers.length; j++) {
          const s2 = soldiers[j];
          if (s2 !== s && s2 && s2.state === 'alive' && s2.faction !== u.faction) {
            if (Math.hypot(s2.pos[0] - s.pos[0], s2.pos[2] - s.pos[2]) < 6.0) cluster++;
          }
        }
        const score = cluster * 35 + (60 - d);
        if (score > bestScore) {
          bestScore = score;
          bestPos = [s.pos[0], s.pos[1], s.pos[2]];
        }
      }
    }

    return bestPos;
  }

  // ---------------------------------------------------------------------------
  // Quadruped Robot Dog Weapons, AI Flanking & Player Control
  // ---------------------------------------------------------------------------
  function fireDogRWS(u) {
    if (!u.alive || u.fireCooldown > 0 || u.reloadTimer > 0) return false;
    if (u.ammo <= 0) {
      u.reloadTimer = 2.8;
      if (DF.Audio && typeof DF.Audio.playReloadFoley === 'function') {
        DF.Audio.playReloadFoley('mag_out', u.pos);
      }
      return false;
    }

    u.ammo--;
    u.fireCooldown = 60 / DOG_RWS_SPEC.rpm;
    u.muzzleFlashTimer = 0.06;

    const origin = [u.muzzleWorldPos[0], u.muzzleWorldPos[1], u.muzzleWorldPos[2]];
    const dir = [u.muzzleWorldDir[0], u.muzzleWorldDir[1], u.muzzleWorldDir[2]];
    const sp = u.controlledByPlayer ? 0.005 : 0.015;
    dir[0] += rand(-sp, sp);
    dir[1] += rand(-sp, sp);
    dir[2] += rand(-sp, sp);
    const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    dir[0] /= l; dir[1] /= l; dir[2] /= l;

    spawnParticle({
      type: 'flash', pos: origin, vel: [dir[0] * 3, dir[1] * 3, dir[2] * 3],
      size: 0.28, sizeEnd: 0.45, life: 0.05, color: [1.0, 0.85, 0.45], alpha: 0.9, additive: true
    });

    const shooter = u.owner || {
      id: u.id,
      name: u.displayName,
      faction: u.faction,
      isPlayer: u.controlledByPlayer
    };

    if (DF.Ballistics && typeof DF.Ballistics.fireWeapon === 'function') {
      DF.Ballistics.fireWeapon(shooter, DOG_RWS_SPEC, origin, dir, u.controlledByPlayer, { spread: sp });
    } else if (DF.Physics && typeof DF.Physics.raycast === 'function') {
      const hit = DF.Physics.raycast(origin, dir, 90, { checkEntities: true, checkVehicles: true });
      if (hit && DF.Game && typeof DF.Game.applyBulletHit === 'function') {
        DF.Game.applyBulletHit(hit, DOG_RWS_SPEC, shooter, dir);
      }
    }
    if (DF.Audio && typeof DF.Audio.playGunshot === 'function') {
      DF.Audio.playGunshot('dog_rws', origin, u.controlledByPlayer);
    }

    if (u.ammo <= 0) {
      u.reloadTimer = 2.8;
    }
    return true;
  }

  function acquireDogTarget(u) {
    if (!DF.AI || typeof DF.AI.getSoldiers !== 'function') return null;
    const eye = [u.pos[0], u.pos[1] + 0.86, u.pos[2]];
    const soldiers = DF.AI.getSoldiers();
    let best = null;
    let bestScore = -1e9;

    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (!s || s.state !== 'alive' || s.inVehicleId || s.faction === u.faction) continue;
      const tx = s.pos[0], ty = s.pos[1] + 1.05, tz = s.pos[2];
      const dx = tx - eye[0], dy = ty - eye[1], dz = tz - eye[2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 55) continue;

      if (DF.Physics && typeof DF.Physics.lineBlockedBySmoke === 'function') {
        if (DF.Physics.lineBlockedBySmoke(eye, [tx, ty, tz])) continue;
      }
      if (DF.Physics && typeof DF.Physics.raycast === 'function') {
        const h = DF.Physics.raycast(eye, [dx / dist, dy / dist, dz / dist], dist - 0.5, {});
        if (h && h.dist < dist - 1.1) continue;
      }

      const score = 100 - dist + (s.spottedTimer > 0 ? 20 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { ref: s, dist };
      }
    }
    return best;
  }

  function updateDog(u, dt, pIn) {
    if (u.spawnGraceTimer > 0) u.spawnGraceTimer = Math.max(0, u.spawnGraceTimer - dt);
    if (u.fireCooldown > 0) u.fireCooldown = Math.max(0, u.fireCooldown - dt);
    if (u.muzzleFlashTimer > 0) u.muzzleFlashTimer = Math.max(0, u.muzzleFlashTimer - dt);
    if (u.reloadTimer > 0) {
      u.reloadTimer -= dt;
      if (u.reloadTimer <= 0) {
        u.reloadTimer = 0;
        u.ammo = u.maxAmmo;
        if (DF.Audio && typeof DF.Audio.playReloadFoley === 'function') {
          DF.Audio.playReloadFoley('mag_in', u.pos);
        }
      }
    }

    // Periodic spotting
    u.spotTimer -= dt;
    if (u.spotTimer <= 0) {
      u.spotTimer = 0.45;
      performReconScan(u, 38.0);
    }

    let desiredVx = 0, desiredVz = 0;

    if (u.controlledByPlayer) {
      const zoomScale = u.aimZoom ? 0.55 : 1.0;
      if (pIn.absYaw !== undefined && pIn.dx === 0 && pIn.dy === 0) {
        u.rwsYaw = pIn.absYaw;
        if (pIn.absPitch !== undefined) u.rwsPitch = clamp(pIn.absPitch, -0.45, 0.72);
      } else {
        const sens = (Math.abs(pIn.dx) > 0.35 || Math.abs(pIn.dy) > 0.35) ? 0.0022 : 1.0;
        u.rwsYaw -= pIn.dx * sens * zoomScale;
        u.rwsPitch = clamp(u.rwsPitch - pIn.dy * sens * zoomScale, -0.45, 0.72);
      }

      u.aimZoom = pIn.altFire;
      if (pIn.thermal) {
        u.thermalMode = !u.thermalMode;
        if (DF.UI && typeof DF.UI.showNotification === 'function') {
          DF.UI.showNotification(u.thermalMode ? '机器狗 FLIR 热成像开启' : '机器狗光学视野', 'info');
        }
      }
      if (pIn.camCycle) u.camMode = (u.camMode + 1) % 2;

      const fx = -Math.sin(u.rwsYaw), fz = -Math.cos(u.rwsYaw);
      const rx = Math.cos(u.rwsYaw), rz = -Math.sin(u.rwsYaw);
      const moveSpeed = pIn.sprint ? 10.6 : 7.0;
      let mx = fx * pIn.fwd + rx * pIn.right;
      let mz = fz * pIn.fwd + rz * pIn.right;
      const ml = Math.hypot(mx, mz);
      if (ml > 1) { mx /= ml; mz /= ml; }
      desiredVx = mx * moveSpeed;
      desiredVz = mz * moveSpeed;

      // Align chassis smoothly toward travel direction (or RWS aim if stationary)
      if (ml > 0.15) {
        const moveYaw = dirToYaw(mx, mz);
        u.yaw += angleDiff(u.yaw, moveYaw) * Math.min(1, dt * 10.0);
      } else {
        u.yaw += angleDiff(u.yaw, u.rwsYaw) * Math.min(1, dt * 6.0);
      }

      // Agile jump-hop over rubble/sandbags
      if (pIn.jump && u.grounded) {
        u.vel[1] = 5.4;
        u.grounded = false;
      }

      if (pIn.fire) fireDogRWS(u);
    } else {
      // Autonomous Flanking & Suppressing Quadruped AI
      u.aiScanTimer -= dt;
      if (u.aiScanTimer <= 0) {
        u.aiScanTimer = rand(0.28, 0.45);
        u.aiTarget = acquireDogTarget(u);
      }

      const center = u.orderPos || getActiveCombatCenter(u.faction);
      // Stay cleanly on open navigable avenue lanes (Z in [-7.5, +7.5]) unless player gives explicit orderPos!
      // Prevents autonomous dog from trying to walk straight into solid apartment north/south walls!
      const flankZ = u.orderPos ? clamp(u.orderPos[2], -46, 46) : (u.faction === 'UA' ? -6.0 : 5.5);
      const goalX = u.orderPos ? clamp(u.orderPos[0], -80, 76) : clamp(center[0] + (u.faction === 'UA' ? 16 : -16), -70, 62);

      // Evade nearby enemy armored vehicles so tanks don't crush or blast the robot dog!
      let evadeX = 0, evadeZ = 0;
      if (DF.Armor && typeof DF.Armor.getVehicles === 'function') {
        const vehs = DF.Armor.getVehicles();
        for (let i = 0; i < vehs.length; i++) {
          const v = vehs[i];
          if (!v.alive || v.faction === u.faction) continue;
          const vx = u.pos[0] - v.pos[0], vz = u.pos[2] - v.pos[2];
          const vd = Math.hypot(vx, vz);
          if (vd > 0.1 && vd < 18.0) {
            const push = (18.0 - vd) / 18.0;
            evadeX += (vx / vd) * push * 6.0;
            evadeZ += (vz / vd) * push * 6.0;
          }
        }
      }

      u.aiPathTimer -= dt;
      if (u.aiPathTimer <= 0) {
        u.aiPathTimer = rand(2.2, 3.6);
        if (DF.Physics && typeof DF.Physics.findPath === 'function') {
          const p = DF.Physics.findPath([u.pos[0], u.pos[1], u.pos[2]], [goalX, 0, flankZ], { isVehicle: false });
          if (p && p.length > 0) {
            u.aiPath = p;
            u.aiPathIdx = 0;
          }
        }
      }

      let wpX = goalX, wpZ = flankZ;
      if (u.aiPath && u.aiPathIdx < u.aiPath.length) {
        const wp = u.aiPath[u.aiPathIdx];
        wpX = wp[0]; wpZ = wp[2];
        if (Math.hypot(wpX - u.pos[0], wpZ - u.pos[2]) < 2.2) {
          u.aiPathIdx++;
        }
      }

      const distGoal = Math.hypot(goalX - u.pos[0], flankZ - u.pos[2]);
      if (Math.hypot(evadeX, evadeZ) > 0.5) {
        desiredVx = evadeX;
        desiredVz = evadeZ;
        u.yaw += angleDiff(u.yaw, dirToYaw(evadeX, evadeZ)) * Math.min(1, dt * 8.0);
      } else if (distGoal > 3.5 && (!u.aiTarget || u.aiTarget.dist > 14)) {
        const dx = wpX - u.pos[0], dz = wpZ - u.pos[2];
        const d = Math.hypot(dx, dz) || 1;
        const aiSpd = u.aiTarget ? 5.6 : 7.4;
        desiredVx = (dx / d) * aiSpd;
        desiredVz = (dz / d) * aiSpd;
        u.yaw += angleDiff(u.yaw, dirToYaw(dx, dz)) * Math.min(1, dt * 8.0);
      }

      // Engage acquired enemy with crisp 4-round 7.62mm suppressing bursts!
      if (u.aiTarget && u.aiTarget.ref && u.aiTarget.ref.state === 'alive') {
        const s = u.aiTarget.ref;
        const dx = s.pos[0] - u.pos[0];
        const dy = (s.pos[1] + 1.0) - (u.pos[1] + 0.85);
        const dz = s.pos[2] - u.pos[2];
        const horiz = Math.hypot(dx, dz) || 1;
        const wantYaw = dirToYaw(dx, dz);
        const wantPitch = clamp(Math.atan2(dy, horiz), -0.4, 0.7);
        u.rwsYaw += angleDiff(u.rwsYaw, wantYaw) * Math.min(1, dt * 11.0);
        u.rwsPitch = damp(u.rwsPitch, wantPitch, 11.0, dt);

        if (u.burstPause > 0) {
          u.burstPause -= dt;
        } else if (Math.abs(angleDiff(u.rwsYaw, wantYaw)) < 0.14) {
          if (u.burstRemaining <= 0) u.burstRemaining = 4;
          if (fireDogRWS(u)) {
            u.burstRemaining--;
            if (u.burstRemaining <= 0) u.burstPause = rand(0.65, 1.15);
          }
        }
      } else {
        u.rwsYaw += angleDiff(u.rwsYaw, u.yaw + Math.sin(_time * 1.4) * 0.45) * Math.min(1, dt * 5.0);
        u.rwsPitch = damp(u.rwsPitch, 0.04, 6.0, dt);
      }
    }

    // Gravity + Capsule Physics (handles stairs, interiors, curbs & rubble smoothly!)
    u.vel[0] = damp(u.vel[0], desiredVx, 10.0, dt);
    u.vel[2] = damp(u.vel[2], desiredVz, 10.0, dt);
    u.vel[1] -= 16.5 * dt;

    if (DF.Physics && typeof DF.Physics.moveCapsule === 'function') {
      const res = DF.Physics.moveCapsule(u.pos, u.vel, u.radius, u.height, dt, {});
      u.grounded = !!(res && res.grounded);
      // If autonomous dog hits a wall/curb obstacle, smoothly nudge laterally & force fresh A* path
      if (!u.controlledByPlayer && res && res.hitWall) {
        u.aiPathTimer = 0;
        u.vel[2] += (u.pos[2] > 0 ? -2.8 : 2.8);
      }
    } else {
      u.pos[0] += u.vel[0] * dt;
      u.pos[1] += u.vel[1] * dt;
      u.pos[2] += u.vel[2] * dt;
      const gy = getGroundY(u.pos[0], u.pos[2], u.pos[1] + 0.8);
      if (u.pos[1] <= gy) {
        u.pos[1] = gy;
        u.vel[1] = 0;
        u.grounded = true;
      }
    }

    u.pos[0] = clamp(u.pos[0], -88, 88);
    u.pos[2] = clamp(u.pos[2], -53, 53);

    updateDogTransforms(u, dt);
    u.stance = !u.grounded ? 'leap' : (u.speed > 7.5 ? 'sprint' : (u.speed > 0.35 ? 'trot' : 'idle'));
  }

  // ---------------------------------------------------------------------------
  // Damage, Destruction & Respawn Lifecycle
  // ---------------------------------------------------------------------------
  function damageUnit(unitOrId, dmg, attacker, hitPoint) {
    const u = typeof unitOrId === 'string'
      ? _units.find(x => x.id === unitOrId)
      : unitOrId;
    if (!u || !u.alive || dmg <= 0) return { applied: 0, destroyed: false };

    // Strict friendly-fire guard (blocks AI teammates, player stray fire & own VOG/kamikaze blast)
    const attFac = attacker && (attacker.faction || (attacker.owner && attacker.owner.faction) || (attacker.driver && attacker.driver.faction));
    if (attFac && attFac === u.faction) return { applied: 0, destroyed: false };

    // Reinforced ballistic carapace & deployment grace resilience
    let effDmg = dmg;
    if (u.type === 'dog') {
      effDmg *= 0.58;
      if (u.spawnGraceTimer > 0) effDmg *= 0.25;
    } else if (u.type === 'drone') {
      if (u.spawnGraceTimer > 0) effDmg *= 0.15;
    }

    u.hp = Math.max(0, u.hp - effDmg);
    const pt = hitPoint || [u.pos[0], u.pos[1] + (u.type === 'dog' ? 0.55 : 0), u.pos[2]];

    for (let i = 0; i < 6; i++) {
      spawnParticle({
        type: 'spark', pos: pt,
        vel: [rand(-4, 4), rand(1, 5), rand(-4, 4)],
        size: 0.12, sizeEnd: 0.04, life: 0.35,
        color: [0.65, 0.88, 1.0], alpha: 1.0, gravity: 10.0, additive: true
      });
    }

    if (u.hp <= 0) {
      destroyUnit(u, attacker, false);
      return { applied: effDmg, destroyed: true };
    }
    return { applied: effDmg, destroyed: false };
  }

  function destroyUnit(u, attacker, isKamikaze) {
    if (!u.alive) return;
    u.alive = false;
    u.destroyed = true;
    u.hp = 0;
    u.kamikazeActive = false;
    u.respawnTimer = u.respawnDelay;

    const pt = [u.pos[0], u.pos[1] + (u.type === 'dog' ? 0.55 : 0), u.pos[2]];
    if (!isKamikaze) {
      if (DF.Audio && typeof DF.Audio.playExplosion === 'function') {
        DF.Audio.playExplosion(pt, u.type === 'dog' ? 0.9 : 0.65);
      }
      for (let i = 0; i < 12; i++) {
        spawnParticle({
          type: 'spark', pos: pt,
          vel: [rand(-6, 6), rand(2, 8), rand(-6, 6)],
          size: 0.18, sizeEnd: 0.05, life: 0.55,
          color: [1.0, 0.72, 0.25], alpha: 1.0, gravity: 11.0, additive: true
        });
      }
      spawnParticle({
        type: 'smoke', pos: pt, vel: [0, 1.8, 0],
        size: 0.6, sizeEnd: 2.2, life: 1.6, color: [0.20, 0.20, 0.20], alpha: 0.75
      });
    }

    if (_controlledUnit === u) {
      releaseControl();
      if (DF.UI && typeof DF.UI.showNotification === 'function') {
        DF.UI.showNotification(
          isKamikaze
            ? `FPV 自杀撞击命中! 信号中断 (${u.respawnDelay}s 后重新部署)`
            : `${u.displayName} 已被摧毁 (${u.respawnDelay}s 后重新部署)`,
          isKamikaze ? 'info' : 'warn'
        );
      }
    }

    if (DF.UI && typeof DF.UI.addKillfeed === 'function' && !isKamikaze) {
      const killerName = (attacker && (attacker.name || attacker.displayName)) || '敌方火力';
      const killerFac = (attacker && attacker.faction) || (u.faction === 'UA' ? 'RU' : 'UA');
      DF.UI.addKillfeed(killerName, '摧毁无人装备', u.displayName, killerFac, u.faction);
    }
  }

  function respawnUnit(u) {
    u.alive = true;
    u.destroyed = false;
    u.hp = u.maxHp;
    u.battery = 100;
    u.ammo = u.maxAmmo;
    u.kamikazeActive = false;
    u.kamikazePitchBoost = 0;
    u.vel[0] = 0; u.vel[1] = 0; u.vel[2] = 0;

    if (u.type === 'drone') {
      const sp = DRONE_SPAWNS[u.faction];
      u.pos[0] = sp.pos[0]; u.pos[1] = sp.pos[1]; u.pos[2] = sp.pos[2];
      u.yaw = sp.yaw;
      u.gimbalPitch = -0.78;
      u.aiHoverTarget = null;
      u.aiDropTimer = 6.0;
      u.spawnGraceTimer = 10.0;
      updateDroneTransforms(u, 0.016);
    } else {
      const sp = DOG_SPAWNS[u.faction];
      const gy = getGroundY(sp.pos[0], sp.pos[2], 6.0);
      u.pos[0] = sp.pos[0]; u.pos[1] = gy; u.pos[2] = sp.pos[2];
      u.yaw = sp.yaw;
      u.rwsYaw = sp.yaw;
      u.rwsPitch = 0;
      u.reloadTimer = 0;
      u.aiPath = null;
      u.spawnGraceTimer = 5.0;
      updateDogTransforms(u, 0.016);
    }

    if (DF.UI && typeof DF.UI.showNotification === 'function') {
      const playerFac = (DF.AI && typeof DF.AI.getPlayerSoldier === 'function' && DF.AI.getPlayerSoldier())
        ? DF.AI.getPlayerSoldier().faction
        : null;
      if (!playerFac || playerFac === u.faction) {
        DF.UI.showNotification(`${u.displayName} 已重新部署就绪`, 'info');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Control Takeover, Orders, Camera Transform & Raycast Support
  // ---------------------------------------------------------------------------
  function takeOver(type, faction) {
    const fac = faction || (DF.AI && typeof DF.AI.getPlayerSoldier === 'function' && DF.AI.getPlayerSoldier()
      ? DF.AI.getPlayerSoldier().faction
      : 'UA');

    const target = _units.find(u => u.type === type && u.faction === fac);
    if (!target) return null;
    if (!target.alive) {
      if (DF.UI && typeof DF.UI.showNotification === 'function') {
        DF.UI.showNotification(`${target.displayName} 正在重新部署 (${Math.ceil(target.respawnTimer)}s)`, 'warn');
      }
      return null;
    }

    // Toggle off if already controlling this exact unit
    if (_controlledUnit === target) {
      releaseControl();
      return null;
    }

    if (_controlledUnit) {
      _controlledUnit.controlledByPlayer = false;
      _controlledUnit.playerControlled = false;
      _controlledUnit.thermalMode = false;
    }

    target.controlledByPlayer = true;
    target.playerControlled = true;
    target.owner = (DF.AI && typeof DF.AI.getPlayerSoldier === 'function') ? DF.AI.getPlayerSoldier() : null;
    if (target.type === 'dog') {
      // Face down the open combat corridor if dog was near a sidewalk/edge so WASD moves immediately!
      if (Math.abs(target.pos[2]) > 8.8) {
        target.pos[2] = Math.sign(target.pos[2]) * 7.5;
        target.pos[1] = getGroundY(target.pos[0], target.pos[2], target.pos[1] + 1.0);
      }
      target.rwsYaw = target.faction === 'UA' ? Math.PI * 0.5 : -Math.PI * 0.5;
      target.yaw = target.rwsYaw;
      target.rwsPitch = 0;
    }
    _controlledUnit = target;

    if (DF.UI && typeof DF.UI.showNotification === 'function') {
      const hint = type === 'drone'
        ? '接管无人机: [WASD]飞行 [Space/Shift]升降 [LMB]投弹 [F]自杀俯冲 [T]热成像 [7]返回步兵'
        : '接管武装机器狗: [WASD]冲刺 [Space]跃障 [LMB]7.62mm射击 [T]热成像 [8]返回步兵';
      DF.UI.showNotification(hint, 'info');
    }
    return target;
  }

  function releaseControl() {
    if (_controlledUnit) {
      _controlledUnit.controlledByPlayer = false;
      _controlledUnit.playerControlled = false;
      _controlledUnit.thermalMode = false;
      _controlledUnit = null;
    }
    if (DF.Renderer && typeof DF.Renderer.setVisionMode === 'function') {
      DF.Renderer.setVisionMode('normal');
    }
  }

  // Supports BOTH issueOrder(faction, type, order, targetPos) AND issueOrder(type, order, targetPos)
  function issueOrder(arg1, arg2, arg3, arg4) {
    let faction, type, order, targetPos;
    if (arg1 === 'UA' || arg1 === 'RU') {
      faction = arg1; type = arg2; order = arg3; targetPos = arg4;
    } else {
      const ps = (DF.AI && typeof DF.AI.getPlayerSoldier === 'function') ? DF.AI.getPlayerSoldier() : null;
      faction = (ps && ps.faction) || 'UA';
      type = arg1; order = arg2; targetPos = arg3;
    }

    for (let i = 0; i < _units.length; i++) {
      const u = _units[i];
      if (u.faction !== faction) continue;
      if (type && type !== 'all' && u.type !== type) continue;
      u.order = order || 'attack';
      u.orderPos = targetPos ? [targetPos[0], targetPos[1] || 0, targetPos[2]] : null;
      u.aiPathTimer = 0;
      if (u.type === 'drone' && targetPos && order === 'attack') {
        u.aiHoverTarget = [targetPos[0], targetPos[1] || 0, targetPos[2]];
        u.aiHoverHold = 0;
      }
    }
  }

  function getCameraTransform(unit) {
    const u = unit || _controlledUnit;
    if (!u || !u.alive) return null;

    if (u.type === 'drone') {
      // Nose-mounted gimbal camera view (supports looking straight down -85 deg for bomb aiming!)
      const eye = [0, 0, 0];
      mat4TransformPoint(eye, u._matBody, 0, -0.08, -0.22);
      const dir = [0, 0, 0];
      yawPitchToDir(u.yaw, u.gimbalPitch, dir);
      const target = [eye[0] + dir[0] * 40, eye[1] + dir[1] * 40, eye[2] + dir[2] * 40];
      return {
        pos: eye,
        yaw: u.yaw,
        pitch: u.gimbalPitch,
        roll: u.roll * 0.25,
        fov: u.kamikazeActive ? 84 : 74,
        near: 0.12,
        far: 360,
        visionMode: u.thermalMode ? 'thermal_white' : 'normal',
        target,
        lookAt: target,
        forward: dir
      };
    }

    // Quadruped Robot Dog: low-slung tactical camera behind/above dorsal RWS or zoomed RWS optic
    const dir = [0, 0, 0];
    yawPitchToDir(u.rwsYaw, u.rwsPitch, dir);
    const eye = [0, 0, 0];
    if (u.camMode === 1 || u.aimZoom) {
      // Mounted right beside the dorsal RWS optic!
      mat4TransformPoint(eye, u._matRwsGun, -0.10, 0.10, -0.14);
    } else {
      // Nimble low-slung over-shoulder tactical view with wall collision pullback
      const pivot = [u.pos[0], u.pos[1] + 1.05, u.pos[2]];
      let backDist = 1.65;
      const backDir = [-dir[0], 0.18 - dir[1] * 0.2, -dir[2]];
      const bl = Math.hypot(backDir[0], backDir[1], backDir[2]) || 1;
      backDir[0] /= bl; backDir[1] /= bl; backDir[2] /= bl;
      if (DF.Physics && typeof DF.Physics.raycast === 'function') {
        const h = DF.Physics.raycast(pivot, backDir, backDist, {});
        if (h && h.dist < backDist) backDist = Math.max(0.35, h.dist - 0.25);
      }
      eye[0] = pivot[0] + backDir[0] * backDist;
      eye[1] = pivot[1] + backDir[1] * backDist;
      eye[2] = pivot[2] + backDir[2] * backDist;
    }

    const target = [eye[0] + dir[0] * 40, eye[1] + dir[1] * 40, eye[2] + dir[2] * 40];
    return {
      pos: eye,
      yaw: u.rwsYaw,
      pitch: u.rwsPitch,
      roll: 0,
      fov: u.aimZoom ? 40 : 72,
      near: 0.12,
      far: 320,
      visionMode: u.thermalMode ? 'thermal_white' : (u.aimZoom ? 'optic' : 'normal'),
      target,
      lookAt: target,
      forward: dir
    };
  }

  function raycastUnits(origin, dir, maxDist, ignoreFaction) {
    let bestHit = null;
    let bestDist = maxDist;
    for (let i = 0; i < _units.length; i++) {
      const u = _units[i];
      if (!u.alive) continue;
      if (ignoreFaction && u.faction === ignoreFaction) continue;
      const cx = u.pos[0];
      const cy = u.pos[1] + (u.type === 'dog' ? 0.52 : 0.02);
      const cz = u.pos[2];
      const ocx = origin[0] - cx, ocy = origin[1] - cy, ocz = origin[2] - cz;
      const b = ocx * dir[0] + ocy * dir[1] + ocz * dir[2];
      const c = ocx * ocx + ocy * ocy + ocz * ocz - (u.radius * u.radius * 1.44);
      const disc = b * b - c;
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t > 0 && t < bestDist) {
        bestDist = t;
        const px = origin[0] + dir[0] * t;
        const py = origin[1] + dir[1] * t;
        const pz = origin[2] + dir[2] * t;
        const nx = (px - cx) / (u.radius || 0.5);
        const ny = (py - cy) / (u.radius || 0.5);
        const nz = (pz - cz) / (u.radius || 0.5);
        const nl = Math.hypot(nx, ny, nz) || 1;
        bestHit = {
          dist: t,
          point: [px, py, pz],
          normal: [nx / nl, ny / nl, nz / nl],
          unit: u,
          material: 'metal'
        };
      }
    }
    return bestHit;
  }

  // ---------------------------------------------------------------------------
  // Main Update & Render Loops
  // ---------------------------------------------------------------------------
  function update(dt, playerInput) {
    if (!dt || dt <= 0) return;
    const clampedDt = Math.min(dt, 0.05);
    _time += clampedDt;
    const pIn = readInput(playerInput);

    for (let i = 0; i < _units.length; i++) {
      const u = _units[i];
      if (!u.alive) {
        u.respawnTimer -= clampedDt;
        if (u.respawnTimer <= 0) respawnUnit(u);
        continue;
      }
      if (u.type === 'drone') updateDrone(u, clampedDt, pIn);
      else updateDog(u, clampedDt, pIn);
    }

    updateVogBombs(clampedDt);
  }

  function render(renderer, time) {
    const r = renderer || DF.Renderer;
    if (!r || typeof r.submitMesh !== 'function') return;
    const t = time !== undefined ? time : _time;
    const castFlags = { castShadow: true, receiveShadow: true };

    for (let i = 0; i < _units.length; i++) {
      const u = _units[i];
      if (!u.alive) continue;

      const isUA = u.faction === 'UA';

      if (u.type === 'drone' && _droneMeshes) {
        // Skip self-body in first-person drone camera so gimbal never clips frame
        if (u.controlledByPlayer) continue;

        const m = _droneMeshes;
        const matFrame = {
          texKey: 'metal_dark',
          color: isUA ? [0.56, 0.54, 0.44] : [0.22, 0.24, 0.26],
          uvScale: [0.45, 0.45],
          roughness: 0.44, metalness: 0.38, thermalHeat: 0.72
        };
        const matMetal = { texKey: 'gunmetal', color: [0.76, 0.78, 0.80], roughness: 0.36, metalness: 0.86, thermalHeat: 0.78 };
        const matAccent = {
          texKey: 'concrete',
          color: isUA ? [0.14, 0.62, 1.0] : [0.94, 0.14, 0.12],
          emissive: isUA ? [0.04, 0.16, 0.32] : [0.24, 0.03, 0.03],
          roughness: 0.56, metalness: 0.06, thermalHeat: 0.65
        };
        const matAccent2 = {
          texKey: 'concrete',
          color: isUA ? [0.92, 0.96, 1.0] : [0.94, 0.94, 0.92],
          emissive: isUA ? [0.12, 0.16, 0.20] : [0.14, 0.14, 0.14],
          roughness: 0.56, metalness: 0.06, thermalHeat: 0.65
        };
        const matBlades = { texKey: 'metal_dark', color: [0.24, 0.26, 0.28], uvScale: [0.45, 0.45], roughness: 0.40, metalness: 0.36, thermalHeat: 0.60 };
        const matDisc = { texKey: 'glass', color: [0.58, 0.62, 0.68], roughness: 0.18, metalness: 0.12, alpha: 0.24, doubleSided: true, thermalHeat: 0.50 };
        const matBomb = { texKey: 'armor_ru', color: [0.58, 0.62, 0.46], roughness: 0.65, metalness: 0.45, thermalHeat: 0.42 };

        const blink = u.kamikazeActive
          ? (Math.sin(t * 36.0) > 0 ? 3.8 : 0.2)
          : (0.65 + 0.35 * Math.sin(t * 6.0 + i * 2.0));
        const ledCol = u.kamikazeActive
          ? [1.0, 0.12, 0.08]
          : (isUA ? [0.16, 0.78, 1.0] : [1.0, 0.16, 0.12]);
        const matLed = {
          texKey: 'concrete', color: ledCol,
          emissive: [ledCol[0] * blink * 2.2, ledCol[1] * blink * 2.2, ledCol[2] * blink * 2.2],
          roughness: 0.2, metalness: 0.0, thermalHeat: 0.95
        };
        const ambPulse = (Math.sin(t * 9.5 + i) > 0.3) ? 2.6 : 0.2;
        const matStrobeA = {
          texKey: 'concrete', color: [1.0, 0.68, 0.14],
          emissive: [1.0 * ambPulse, 0.62 * ambPulse, 0.10 * ambPulse],
          roughness: 0.2, metalness: 0.0, thermalHeat: 0.90
        };
        const matLens = {
          texKey: 'concrete', color: isUA ? [0.18, 0.80, 1.0] : [1.0, 0.20, 0.14],
          emissive: isUA ? [0.32, 1.25, 1.85] : [1.85, 0.24, 0.14],
          roughness: 0.08, metalness: 0.2, thermalHeat: 0.92
        };

        r.submitMesh(m.frame, u._matBody, matFrame, castFlags);
        if (m.metal) r.submitMesh(m.metal, u._matBody, matMetal, castFlags);
        r.submitMesh(m.accent, u._matBody, matAccent, castFlags);
        if (m.accent2) r.submitMesh(m.accent2, u._matBody, matAccent2, castFlags);
        r.submitMesh(m.gimbal, u._matGimbal, matMetal, castFlags);
        if (m.opticLens) r.submitMesh(m.opticLens, u._matGimbal, matLens, { castShadow: false, receiveShadow: false, unlit: true });
        r.submitMesh(m.led, u._matBody, matLed, { castShadow: false, receiveShadow: false, unlit: true });
        if (m.strobeAmber) r.submitMesh(m.strobeAmber, u._matBody, matStrobeA, { castShadow: false, receiveShadow: false, unlit: true });
        if (u.ammo > 0 || u.kamikazeActive) {
          r.submitMesh(m.bomb, u._matBomb, matBomb, castFlags);
        }
        for (let k = 0; k < 4; k++) {
          r.submitMesh(m.rotorBlades, u._matRotors[k], matBlades, { castShadow: false, receiveShadow: false });
          if (m.rotorDisc) r.submitMesh(m.rotorDisc, u._matRotors[k], matDisc, { castShadow: false, receiveShadow: false });
        }
      } else if (u.type === 'dog' && _dogMeshes) {
        const m = _dogMeshes;
        const hideSelf = u.controlledByPlayer && (u.camMode === 1 || u.aimZoom);
        if (hideSelf) continue;

        const matArmor = {
          texKey: isUA ? 'armor_ua' : 'armor_ru',
          color: isUA ? [1.04, 0.98, 0.80] : [0.34, 0.38, 0.36],
          uvScale: [0.55, 0.55],
          roughness: isUA ? 0.62 : 0.56, metalness: 0.44, thermalHeat: 0.86
        };
        const matDark = {
          texKey: 'metal_dark', color: isUA ? [0.42, 0.44, 0.44] : [0.26, 0.28, 0.30],
          roughness: 0.48, metalness: 0.74, thermalHeat: 0.82
        };
        const matChrome = {
          texKey: 'gunmetal', color: [0.86, 0.88, 0.90],
          roughness: 0.24, metalness: 0.92, thermalHeat: 0.78
        };
        const matGun = {
          texKey: 'gunmetal', color: [0.68, 0.70, 0.72],
          roughness: 0.38, metalness: 0.86, thermalHeat: u.muzzleFlashTimer > 0 ? 1.0 : 0.76
        };
        const matStencil = {
          texKey: 'concrete',
          color: isUA ? [0.14, 0.62, 1.0] : [0.94, 0.14, 0.12],
          emissive: isUA ? [0.04, 0.16, 0.32] : [0.24, 0.03, 0.03],
          roughness: 0.58, metalness: 0.05, thermalHeat: 0.70
        };
        const matStencil2 = {
          texKey: 'concrete',
          color: isUA ? [0.92, 0.96, 1.0] : [0.94, 0.94, 0.92],
          emissive: isUA ? [0.12, 0.16, 0.20] : [0.14, 0.14, 0.14],
          roughness: 0.58, metalness: 0.05, thermalHeat: 0.70
        };
        const opticCol = isUA ? [0.14, 0.84, 1.0] : [1.0, 0.16, 0.12];
        const matOptic = {
          texKey: 'concrete', color: opticCol,
          emissive: [opticCol[0] * 1.55, opticCol[1] * 1.55, opticCol[2] * 1.55],
          roughness: 0.12, metalness: 0.0, thermalHeat: 0.96
        };
        const matGreen = {
          texKey: 'concrete', color: [0.20, 1.0, 0.45],
          emissive: [0.35, 2.2, 0.85], roughness: 0.15, metalness: 0.0, thermalHeat: 0.90
        };
        const ambBlink = Math.sin(t * 7.5 + i) > 0.2 ? 2.4 : 0.18;
        const matAmber = {
          texKey: 'concrete', color: [1.0, 0.68, 0.12],
          emissive: [1.0 * ambBlink, 0.62 * ambBlink, 0.10 * ambBlink],
          roughness: 0.15, metalness: 0.0, thermalHeat: 0.90
        };
        const redBlink = (u.aiTarget || u.fireCooldown > 0) ? (Math.sin(t * 18.0) > 0 ? 3.0 : 0.4) : 0.45;
        const matRed = {
          texKey: 'concrete', color: [1.0, 0.18, 0.14],
          emissive: [1.0 * redBlink, 0.14 * redBlink, 0.10 * redBlink],
          roughness: 0.15, metalness: 0.0, thermalHeat: 0.92
        };
        const matLaser = {
          texKey: 'concrete',
          color: isUA ? [0.18, 0.86, 1.0] : [1.0, 0.16, 0.14],
          emissive: isUA ? [0.30, 1.65, 2.2] : [2.2, 0.28, 0.20],
          alpha: 0.42, roughness: 0.1, metalness: 0.0, thermalHeat: 0.3
        };

        r.submitMesh(m.torso, u._matTorso, matArmor, castFlags);
        r.submitMesh(m.torsoDark, u._matTorso, matDark, castFlags);
        if (m.torsoChrome) r.submitMesh(m.torsoChrome, u._matTorso, matChrome, castFlags);
        if (m.stencil) r.submitMesh(m.stencil, u._matTorso, matStencil, castFlags);
        if (m.stencil2) r.submitMesh(m.stencil2, u._matTorso, matStencil2, castFlags);
        r.submitMesh(m.optics, u._matTorso, matOptic, { castShadow: false, receiveShadow: false, unlit: true });
        if (m.strobeGreen) r.submitMesh(m.strobeGreen, u._matTorso, matGreen, { castShadow: false, receiveShadow: false, unlit: true });
        if (m.strobeAmber) r.submitMesh(m.strobeAmber, u._matTorso, matAmber, { castShadow: false, receiveShadow: false, unlit: true });
        if (m.strobeRed) r.submitMesh(m.strobeRed, u._matTorso, matRed, { castShadow: false, receiveShadow: false, unlit: true });
        r.submitMesh(m.lidar, u._matLidar, matDark, castFlags);
        r.submitMesh(m.rwsBase, u._matRwsBase, matDark, castFlags);
        r.submitMesh(m.rwsGun, u._matRwsGun, matGun, castFlags);
        if (m.rwsOptic) r.submitMesh(m.rwsOptic, u._matRwsGun, matOptic, { castShadow: false, receiveShadow: false, unlit: true });
        r.submitMesh(m.laser, u._matRwsGun, matLaser, { castShadow: false, receiveShadow: false, unlit: true });

        // Render all 4 articulated 2-segment IK legs with hydraulic steel shin pistons!
        for (let k = 0; k < 4; k++) {
          r.submitMesh(m.upperLeg, u._matLegUpper[k], matArmor, castFlags);
          if (m.upperMetal) r.submitMesh(m.upperMetal, u._matLegUpper[k], matChrome, castFlags);
          r.submitMesh(m.lowerLeg, u._matLegLower[k], matDark, castFlags);
          if (m.lowerPiston) r.submitMesh(m.lowerPiston, u._matLegLower[k], matChrome, castFlags);
        }

        if (u.muzzleFlashTimer > 0) {
          addLight(u.muzzleWorldPos, [1.0, 0.78, 0.38], 3.8, 7.5);
        }
      }
    }

    // Render falling physical VOG-17 grenades
    if (_droneMeshes && _vogBombs.length > 0) {
      const matVog = { texKey: 'armor_ru', color: [0.56, 0.62, 0.44], roughness: 0.55, metalness: 0.48, thermalHeat: 0.75 };
      for (let i = 0; i < _vogBombs.length; i++) {
        const b = _vogBombs[i];
        if (!b._mat) b._mat = mat4Create();
        mat4FromYXZ(b._mat, b.pos[0], b.pos[1], b.pos[2], 0, -Math.PI * 0.5, 0, 1.35, 1.35, 1.35);
        r.submitMesh(_droneMeshes.bomb, b._mat, matVog, { castShadow: false, receiveShadow: false });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Init & Reset
  // ---------------------------------------------------------------------------
  function reset() {
    _controlledUnit = null;
    _vogBombs = [];
    _time = 0;
    _units = [
      createDrone('UA'),
      createDrone('RU'),
      createDog('UA'),
      createDog('RU')
    ];
    for (let i = 0; i < _units.length; i++) {
      if (_units[i].type === 'drone') updateDroneTransforms(_units[i], 0.016);
      else updateDogTransforms(_units[i], 0.016);
    }
  }

  function init(gl) {
    _gl = gl;
    if (gl && DF.MeshGen && DF.MeshGen.Builder) {
      _droneMeshes = buildDroneMeshes(gl);
      _dogMeshes = buildDogMeshes(gl);
    }
    reset();
  }

  // ---------------------------------------------------------------------------
  // Public DF.Unmanned Contract
  // ---------------------------------------------------------------------------
  DF.Unmanned = {
    init,
    reset,
    takeOver,
    releaseControl,
    isControlled() {
      return !!(_controlledUnit && _controlledUnit.alive);
    },
    getControlledUnit() {
      return (_controlledUnit && _controlledUnit.alive) ? _controlledUnit : null;
    },
    issueOrder,
    damageUnit,
    dropVogGrenade,
    engageKamikaze,
    triggerKamikaze(unit) {
      return engageKamikaze(unit || _controlledUnit);
    },
    raycastUnits,
    getUnits(faction) {
      if (!faction) return _units;
      return _units.filter(u => u.faction === faction);
    },
    getDrones() {
      return _units.filter(u => u.type === 'drone');
    },
    getDogs() {
      return _units.filter(u => u.type === 'dog');
    },
    getCameraTransform,
    update,
    render
  };
})();
