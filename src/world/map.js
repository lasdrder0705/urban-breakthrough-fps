(() => {
  'use strict';

  const DF = (window.DF = window.DF || {});

  const IDENTITY_MAT = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ]);

  // Deterministic PRNG for procedural variation without visual drift across reloads
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeYawMatrix(px, py, pz, ry, sx, sy, sz, out) {
    const m = out || new Float32Array(16);
    const c = Math.cos(ry), s = Math.sin(ry);
    m[0] = c * sx; m[1] = 0;  m[2] = -s * sx; m[3] = 0;
    m[4] = 0;      m[5] = sy; m[6] = 0;       m[7] = 0;
    m[8] = s * sz; m[9] = 0;  m[10] = c * sz; m[11] = 0;
    m[12] = px;    m[13] = py; m[14] = pz;    m[15] = 1;
    return m;
  }

  // ---- Battlefield Craters (strictly outside building footprints & main vehicle centerlines) ----
  const CRATERS = [
    { x: -64, z: -4.2, r: 3.4, depth: 0.42, rim: 0.14 },
    { x: -46, z: 5.2,  r: 3.0, depth: 0.38, rim: 0.12 },
    { x: -20, z: -4.6, r: 3.8, depth: 0.46, rim: 0.15 },
    { x: -4,  z: -6.0, r: 4.1, depth: 0.48, rim: 0.16 }, // Lenin Square artillery crater
    { x: 22,  z: 4.8,  r: 3.5, depth: 0.42, rim: 0.14 },
    { x: -58, z: -38,  r: 3.4, depth: 0.44, rim: 0.15 }, // North flank crater
    { x: 10,  z: -40,  r: 3.6, depth: 0.44, rim: 0.15 },
    { x: -30, z: 39,   r: 3.6, depth: 0.45, rim: 0.15 }, // South flank crater
    { x: 24,  z: 40,   r: 3.4, depth: 0.42, rim: 0.14 }
  ];

  // Continuous exact terrain height function shared with DF.Physics
  function terrainHeight(x, z) {
    let y = 0.0;
    // Gentle mud embankment rise outside the flank alleys (|Z| > 47) and outer ends
    const absZ = Math.abs(z);
    if (absZ > 47.5) {
      const t = Math.min(1, (absZ - 47.5) / 10.0);
      y += t * t * 1.15;
    }
    const absX = Math.abs(x);
    if (absX > 88.5) {
      const t = Math.min(1, (absX - 88.5) / 14.0);
      y += t * t * 1.2;
    }

    // Smooth artillery craters with raised earth rim
    for (let i = 0; i < CRATERS.length; i++) {
      const c = CRATERS[i];
      const dx = x - c.x;
      const dz = z - c.z;
      const d2 = dx * dx + dz * dz;
      const outerR = c.r * 1.55;
      if (d2 >= outerR * outerR) continue;
      const d = Math.sqrt(d2);
      if (d < c.r) {
        const u = d / c.r;
        const bowl = Math.cos(u * Math.PI * 0.5);
        y -= c.depth * bowl * bowl;
      } else {
        const u = (d - c.r) / (outerR - c.r);
        const ridge = Math.sin(u * Math.PI);
        y += c.rim * ridge;
      }
    }
    return y;
  }

  // ---- Map Runtime State ----
  let staticBatches = []; // Array<{ mesh, material, flags }>
  let sectors = [];
  let ammoCrates = [];
  let vaultWindows = [];
  let flagPoles = []; // Dynamic sector flags that swap texture UA/RU and wave gently
  let wreckFires = []; // Ambient smoldering battlefield fires (point light + rising smoke)
  let interiorLights = []; // Subtle warm tungsten/emergency interior lights in buildings
  let flagMesh = null;
  let fireSmokeAccum = 0;
  let lastRenderTime = 0;

  // Destructible shared meshes built once during init(gl)
  const destMeshes = {};
  let colliderSeq = 1;
  let destSeq = 1;

  // Material batcher: collects static geometry into 1 mesh per visual material profile
  function createBatchManager(gl) {
    const batches = new Map();
    const Builder = DF.MeshGen && DF.MeshGen.Builder;

    function get(key, materialCfg, flagsCfg) {
      let entry = batches.get(key);
      if (!entry) {
        entry = {
          key,
          builder: Builder ? new Builder() : null,
          material: Object.assign({
            texKey: key,
            color: [1, 1, 1],
            roughness: 0.85,
            metalness: 0.05,
            emissive: [0, 0, 0],
            uvScale: [1, 1],
            alpha: 1.0,
            thermalHeat: 0.10,
            doubleSided: false
          }, materialCfg || {}),
          flags: Object.assign({
            castShadow: true,
            receiveShadow: true,
            viewmodel: false,
            unlit: false
          }, flagsCfg || {})
        };
        batches.set(key, entry);
      }
      return entry.builder;
    }

    function finalize() {
      const result = [];
      if (!gl || !Builder) return result;
      batches.forEach((entry) => {
        if (!entry.builder || entry.builder.indices.length === 0) return;
        const mesh = entry.builder.build(gl);
        result.push({
          key: entry.key,
          mesh,
          material: entry.material,
          flags: entry.flags
        });
      });
      return result;
    }

    return { get, finalize };
  }

  // Helper to add static collider safely
  function addStaticCol(prefix, min, max, meta) {
    if (!DF.Physics) return null;
    const id = prefix + '_' + (colliderSeq++);
    DF.Physics.addCollider(id, min, max, meta);
    return id;
  }

  function addCover(pos, normal, height, sectorIdx, factionHint, destructibleId) {
    if (!DF.Physics) return null;
    return DF.Physics.addCoverNode({
      pos,
      normal,
      height,
      sectorIdx,
      factionHint,
      destructibleId
    });
  }

  // ---- Build Modular Destructible Meshes ----
  function buildDestructibleArchetypes(gl) {
    if (!gl || !DF.MeshGen || typeof DF.MeshGen.Builder !== 'function') return;
    const Builder = DF.MeshGen.Builder;

    const makePanel = (w, h, d, damaged, texType) => {
      const b = new Builder();
      if (!damaged) {
        // Intact beveled precast/brick architectural bay with sill & seam grooves
        b.addBeveledBox(0, h * 0.5, 0, w, h, d, 0.022, {
          color: [0.95, 0.94, 0.91],
          uvScale: 0.30,
          aoBottom: 0.68,
          aoTop: 1.0
        });
        // Horizontal precast concrete panel reveal band
        b.addBox(0, h * 0.52, 0, w * 0.98, 0.07, d + 0.03, {
          color: [0.68, 0.67, 0.65],
          uvScale: 0.5
        });
        if (texType === 'brick') {
          // Base plinth trim
          b.addBox(0, 0.14, 0, w, 0.28, d + 0.04, { color: [0.58, 0.56, 0.54], uvScale: 0.4 });
        }
      } else {
        // Damaged cracked state: split jagged masonry halves with blown center notch & exposed rebar!
        const sideW = w * 0.36;
        b.addBox(-w * 0.32, h * 0.48, 0, sideW, h * 0.94, d, {
          color: [0.76, 0.74, 0.71], uvScale: 0.32, aoBottom: 0.62
        });
        b.addBox(w * 0.32, h * 0.46, 0, sideW, h * 0.90, d, {
          color: [0.74, 0.72, 0.69], uvScale: 0.32, aoBottom: 0.62
        });
        // Cracked lower sill bridge & upper lintel stub
        b.addBox(0, h * 0.16, 0, w * 0.42, h * 0.32, d * 0.92, {
          color: [0.65, 0.62, 0.58], uvScale: 0.35
        });
        b.addBox(0, h * 0.88, 0, w * 0.44, h * 0.22, d * 0.92, {
          color: [0.68, 0.66, 0.63], uvScale: 0.35
        });
        // Exposed twisted rebar rods spanning the cracked breach
        for (let r = 0; r < 3; r++) {
          b.addCylinder(0, h * (0.38 + r * 0.16), (r - 1) * 0.05, 0.018, 0.018, w * 0.48, 5, {
            axis: 'x',
            color: [0.30, 0.22, 0.18],
            rotZ: (r - 1) * 0.18
          });
        }
      }
      return b.build(gl);
    };

    // Standard exterior wall bay (4.0m wide x 3.35m tall x 0.34m thick)
    destMeshes.wallConcreteIntact = makePanel(4.0, 3.35, 0.34, false, 'concrete');
    destMeshes.wallConcreteDamaged = makePanel(4.0, 3.35, 0.34, true, 'concrete');
    destMeshes.wallBrickIntact = makePanel(4.0, 3.35, 0.34, false, 'brick');
    destMeshes.wallBrickDamaged = makePanel(4.0, 3.35, 0.34, true, 'brick');

    // Interior partition wall (3.6m wide x 3.35m tall x 0.22m thick)
    destMeshes.partitionIntact = makePanel(3.6, 3.35, 0.22, false, 'plaster');
    destMeshes.partitionDamaged = makePanel(3.6, 3.35, 0.22, true, 'plaster');

    // Balcony / roof parapet (3.6m wide x 1.08m tall x 0.20m thick)
    {
      const bi = new Builder();
      bi.addBeveledBox(0, 0.50, 0, 3.6, 0.96, 0.18, 0.018, { color: [0.88, 0.87, 0.84], uvScale: 0.35, aoBottom: 0.72 });
      bi.addBox(0, 1.02, 0, 3.64, 0.08, 0.24, { color: [0.68, 0.67, 0.64], uvScale: 0.4 });
      destMeshes.parapetIntact = bi.build(gl);

      const bd = new Builder();
      bd.addBox(-1.15, 0.46, 0, 1.25, 0.92, 0.18, { color: [0.74, 0.72, 0.68], uvScale: 0.35 });
      bd.addBox(1.15, 0.44, 0, 1.25, 0.88, 0.18, { color: [0.72, 0.70, 0.66], uvScale: 0.35 });
      bd.addBox(0, 0.22, 0, 1.2, 0.44, 0.16, { color: [0.64, 0.62, 0.58], uvScale: 0.35 });
      bd.addCylinder(0, 0.68, 0, 0.016, 0.016, 1.4, 5, { axis: 'x', color: [0.32, 0.24, 0.20], rotZ: 0.12 });
      destMeshes.parapetDamaged = bd.build(gl);
    }

    // Breakable window glass + deep 3D cross mullions (dark reflective Fresnel glass, zero flat light-blue!)
    {
      const b = new Builder();
      b.addBox(0, 0.775, 0, 2.14, 1.50, 0.025, { color: [0.22, 0.28, 0.34], unitUV: true });
      // Recessed wood/metal casement cross mullions
      b.addBox(0, 0.775, 0, 0.07, 1.52, 0.07, { color: [0.28, 0.26, 0.24], uvScale: 1 });
      b.addBox(0, 0.86, 0, 2.16, 0.07, 0.07, { color: [0.28, 0.26, 0.24], uvScale: 1 });
      destMeshes.windowGlass = b.build(gl);
    }

    // Wooden Door (1.28m x 2.38m x 0.09m)
    {
      const bi = new Builder();
      bi.addBeveledBox(0, 1.19, 0, 1.26, 2.36, 0.08, 0.012, { color: [0.82, 0.68, 0.52], unitUV: true, aoBottom: 0.74 });
      // Recessed door panel strips + steel handle
      bi.addBox(0, 1.68, 0, 0.86, 0.72, 0.10, { color: [0.70, 0.56, 0.42], uvScale: 0.6 });
      bi.addBox(0, 0.68, 0, 0.86, 0.72, 0.10, { color: [0.70, 0.56, 0.42], uvScale: 0.6 });
      bi.addBox(0.46, 1.06, 0, 0.14, 0.04, 0.18, { color: [0.35, 0.36, 0.38] });
      destMeshes.doorIntact = bi.build(gl);

      const bd = new Builder();
      bd.addBox(0, 0.66, 0, 1.24, 1.32, 0.08, { color: [0.68, 0.54, 0.40], unitUV: true });
      bd.addBox(-0.34, 1.62, 0, 0.52, 0.92, 0.08, { color: [0.64, 0.50, 0.38], rotZ: 0.08 });
      destMeshes.doorDamaged = bd.build(gl);
    }

    // Organic Staggered Sandbag Trench Wall (curved slumped bags, seam variation, tied ear-nubs & timber stake pickets!)
    {
      const makeSandbags = (rows) => {
        const b = new Builder();
        const rng = mulberry32(rows === 4 ? 7101 : 7102);
        // Subtle outward defensive bow curve along X
        const archZ = (x) => -0.075 * (x * x);
        for (let r = 0; r < rows; r++) {
          const yBase = 0.13 + r * 0.245;
          const count = r % 2 === 0 ? 5 : 4;
          const stepX = 0.555;
          const startX = -((count - 1) * stepX) * 0.5;
          for (let i = 0; i < count; i++) {
            const x = startX + i * stepX + (rng() - 0.5) * 0.065;
            const zCurve = archZ(x);
            const bagW = 0.50 + rng() * 0.08;
            const bagH = 0.215 + rng() * 0.035;
            const bagD = 0.32 + rng() * 0.05;
            // Varied dusty burlap tones (khaki, sun-bleached canvas, damp earth-stained)
            const tone = rng();
            const cR = (0.76 + tone * 0.20) * (0.90 + rng() * 0.10);
            const cG = (0.70 + tone * 0.19) * (0.89 + rng() * 0.10);
            const cB = (0.58 + tone * 0.16) * (0.86 + rng() * 0.10);
            const depthRow = r < 2 ? [-0.165, 0.165] : (r === 2 ? [-0.07, 0.09] : [0.0]);
            for (let d = 0; d < depthRow.length; d++) {
              const bx = x + (rng() - 0.5) * 0.03;
              const by = yBase + (rng() - 0.5) * 0.025;
              const bz = zCurve + depthRow[d] + (rng() - 0.5) * 0.045;
              const ry = -x * 0.14 + (rng() - 0.5) * 0.18;
              const rz = (rng() - 0.5) * 0.10;
              const rx = (rng() - 0.5) * 0.07;
              // Plump beveled sandbag pillow
              b.addBeveledBox(bx, by, bz, bagW, bagH, bagD, 0.068, {
                color: [cR, cG, cB],
                uvScale: 0.9,
                rotY: ry,
                rotZ: rz,
                rotX: rx,
                aoBottom: r === 0 ? 0.50 : 0.74,
                aoTop: 1.0
              });
              // Tied neck pinch nubs on alternating bag ends for authentic cloth silhouette
              if ((i + r + d) % 2 === 0) {
                b.addBox(bx + bagW * 0.46, by - 0.01, bz, 0.07, bagH * 0.42, bagD * 0.52, {
                  color: [cR * 0.78, cG * 0.76, cB * 0.72], rotY: ry, rotZ: rz
                });
              }
            }
          }
        }
        // Timber revetment picket stakes bracing the sandbag trench ends
        for (const sx of [-1.26, 1.26]) {
          b.addCylinder(sx, 0.56, archZ(sx) - 0.24, 0.042, 0.052, 1.18, 6, {
            color: [0.46, 0.38, 0.30], rotZ: sx < 0 ? 0.07 : -0.07, aoBottom: 0.55
          });
        }
        return b.build(gl);
      };
      destMeshes.sandbagIntact = makeSandbags(4);
      destMeshes.sandbagDamaged = makeSandbags(2);
    }

    // Concrete Jersey Barrier (2.6m long x 1.05m tall x 0.66m base width)
    {
      const bi = new Builder();
      // Wide lower base foot
      bi.addBeveledBox(0, 0.14, 0, 2.6, 0.28, 0.66, 0.025, { color: [0.84, 0.83, 0.80], uvScale: 0.4, aoBottom: 0.58 });
      // Tapered mid slope (front & back wedges)
      bi.addBox(0, 0.44, 0, 2.58, 0.34, 0.42, { color: [0.86, 0.85, 0.82], uvScale: 0.4 });
      bi.addWedge(0, 0.44, 0.25, 2.58, 0.34, 0.16, { color: [0.82, 0.81, 0.78], uvScale: 0.4 });
      bi.addWedge(0, 0.44, -0.25, 2.58, 0.34, 0.16, { color: [0.82, 0.81, 0.78], uvScale: 0.4, rotY: Math.PI });
      // Upper vertical stem
      bi.addBeveledBox(0, 0.82, 0, 2.56, 0.46, 0.24, 0.025, { color: [0.90, 0.89, 0.86], uvScale: 0.4 });
      // Hazard paint end stripes
      bi.addBox(-1.12, 0.82, 0, 0.22, 0.32, 0.26, { color: [0.88, 0.68, 0.18] });
      bi.addBox(1.12, 0.82, 0, 0.22, 0.32, 0.26, { color: [0.88, 0.68, 0.18] });
      destMeshes.jerseyIntact = bi.build(gl);

      const bd = new Builder();
      bd.addBeveledBox(0, 0.14, 0, 2.55, 0.28, 0.64, 0.02, { color: [0.72, 0.71, 0.68], uvScale: 0.4, aoBottom: 0.56 });
      bd.addBox(-0.55, 0.52, 0, 1.15, 0.58, 0.32, { color: [0.74, 0.73, 0.70], uvScale: 0.4, rotZ: 0.04 });
      bd.addBox(0.62, 0.46, 0, 1.05, 0.48, 0.30, { color: [0.70, 0.69, 0.66], uvScale: 0.4, rotZ: -0.07 });
      bd.addCylinder(0.05, 0.66, 0, 0.015, 0.015, 0.55, 5, { axis: 'x', color: [0.32, 0.24, 0.18] });
      destMeshes.jerseyDamaged = bd.build(gl);
    }

    // Military Supply Crate (1.25m x 0.82m x 0.88m)
    {
      const b = new Builder();
      b.addBeveledBox(0, 0.41, 0, 1.24, 0.82, 0.86, 0.02, { color: [0.92, 0.90, 0.84], unitUV: true, aoBottom: 0.62 });
      // Corner battens & lid rim
      b.addBox(0, 0.78, 0, 1.28, 0.09, 0.90, { color: [0.76, 0.74, 0.68], uvScale: 0.6 });
      b.addBox(-0.58, 0.41, 0, 0.10, 0.82, 0.90, { color: [0.70, 0.68, 0.62], uvScale: 0.6 });
      b.addBox(0.58, 0.41, 0, 0.10, 0.82, 0.90, { color: [0.70, 0.68, 0.62], uvScale: 0.6 });
      destMeshes.crateIntact = b.build(gl);
    }

    // Explosive High-Poly East-European Sedan (Lada-2107 / Skoda silhouette: open shattered cabin, seats, dash, deep-dish rims & thick treaded tires flush Y=0!)
    {
      const addDeepWheel = (b, wx, wy, wz, radius, width, sideSign, rimCol) => {
        // Thick 16-seg outer rubber tread cylinder
        b.addCylinder(wx, wy, wz, radius, radius, width, 16, { axis: 'x', color: [0.13, 0.13, 0.14] });
        // Recessed dark inner brake-drum barrel
        b.addCylinder(wx + sideSign * (width * 0.36), wy, wz, radius * 0.62, radius * 0.62, 0.06, 14, { axis: 'x', color: [0.22, 0.22, 0.24] });
        // Outer metallic rim lip ring + central hubcap lug boss
        b.addCylinder(wx + sideSign * (width * 0.44), wy, wz, radius * 0.64, radius * 0.56, 0.04, 14, { axis: 'x', color: rimCol });
        b.addCylinder(wx + sideSign * (width * 0.48), wy, wz, radius * 0.24, radius * 0.24, 0.05, 10, { axis: 'x', color: [0.36, 0.36, 0.38] });
        // 5 radial wheel spokes catching grazing specular
        for (let sp = 0; sp < 5; sp++) {
          const a = (sp / 5) * Math.PI * 2;
          b.addBox(
            wx + sideSign * (width * 0.44),
            wy + Math.cos(a) * radius * 0.34,
            wz + Math.sin(a) * radius * 0.34,
            0.035, 0.055, radius * 0.42,
            { color: rimCol, rotX: a }
          );
        }
      };

      const buildCar = (damaged) => {
        const b = new Builder();
        const bodyTint = damaged ? [0.66, 0.60, 0.54] : [0.96, 0.95, 0.94];
        const trimCol = [0.20, 0.20, 0.22];
        const chromeCol = [0.64, 0.65, 0.64];
        const seatCol = [0.28, 0.24, 0.22];

        // 1. Segmented rocker panels & fender body around recessed wheel arches (Y = 0.34..0.84)
        b.addBeveledBox(0, 0.56, 0, 1.56, 0.44, 4.10, 0.035, { color: [0.18, 0.18, 0.19], aoBottom: 0.46 }); // Dark inner floorpan/wheelwells
        b.addBeveledBox(0, 0.62, 0, 1.82, 0.46, 1.78, 0.035, { color: bodyTint, uvScale: 0.5, aoBottom: 0.52 }); // Center door body
        b.addBeveledBox(0, 0.72, 1.52, 1.80, 0.34, 1.24, 0.035, { color: bodyTint, uvScale: 0.5 }); // Front fenders over wheel wells
        b.addBeveledBox(0, 0.72, -1.52, 1.80, 0.34, 1.18, 0.035, { color: bodyTint, uvScale: 0.5 }); // Rear quarter panels
        // Side rub-strip molding & door handles
        for (const sgn of [-1, 1]) {
          b.addBox(sgn * 0.915, 0.62, 0.0, 0.035, 0.06, 1.76, { color: trimCol });
          b.addBox(sgn * 0.915, 0.78, 0.18, 0.04, 0.04, 0.14, { color: chromeCol });
          b.addBox(sgn * 0.915, 0.78, -0.52, 0.04, 0.04, 0.14, { color: chromeCol });
          // Side wing mirrors
          b.addBox(sgn * 0.97, 0.96, 0.62, 0.14, 0.09, 0.07, { color: trimCol, rotY: sgn * -0.15 });
        }

        // 2. Sculpted Sloped Hood (+Z) & Trunk Deck (-Z) with raised crown lines
        b.addBeveledBox(0, 0.88, 1.44, 1.66, 0.14, 1.26, 0.03, {
          color: bodyTint, uvScale: 0.5, rotX: damaged ? 0.14 : 0.055
        });
        b.addBeveledBox(0, 0.91, 1.38, 0.88, 0.06, 1.12, 0.02, {
          color: bodyTint, uvScale: 0.5, rotX: damaged ? 0.14 : 0.055
        });
        b.addBeveledBox(0, 0.88, -1.48, 1.66, 0.16, 1.08, 0.03, { color: bodyTint, uvScale: 0.5, rotX: -0.04 });

        // 3. Open Shattered Cabin with Dashboard, Steering Wheel, Front Bucket Seats & Rear Bench!
        // Interior dashboard & steering column
        b.addBeveledBox(0, 0.94, 0.68, 1.46, 0.24, 0.34, 0.02, { color: [0.20, 0.20, 0.21] });
        b.addCylinder(-0.36, 1.02, 0.44, 0.16, 0.16, 0.035, 12, { axis: 'z', color: [0.16, 0.16, 0.17], rotX: 0.42 });
        // Front bucket seats + headrests + rear bench seat visible through open windows!
        for (const sx of [-0.36, 0.36]) {
          b.addBeveledBox(sx, 0.78, 0.06, 0.48, 0.14, 0.48, 0.025, { color: seatCol });
          b.addBeveledBox(sx, 1.04, -0.12, 0.46, 0.44, 0.14, 0.025, { color: seatCol, rotX: -0.16 });
          b.addBeveledBox(sx, 1.30, -0.16, 0.24, 0.14, 0.10, 0.02, { color: seatCol });
        }
        b.addBeveledBox(0, 0.82, -0.68, 1.36, 0.16, 0.48, 0.025, { color: seatCol });
        b.addBeveledBox(0, 1.06, -0.88, 1.34, 0.42, 0.16, 0.025, { color: seatCol, rotX: -0.18 });

        // Roof panel + drip rails + thin angled A/B/C pillars (NO opaque black cabin box!)
        b.addBeveledBox(0, 1.44, -0.14, 1.46, 0.09, 1.62, 0.03, {
          color: bodyTint, uvScale: 0.5, rotZ: damaged ? 0.05 : 0
        });
        for (const sgn of [-1, 1]) {
          // Angled A-pillar (front windshield frame)
          b.addBox(sgn * 0.72, 1.16, 0.76, 0.065, 0.58, 0.07, { color: bodyTint, rotX: -0.44, rotZ: sgn * 0.14 });
          // Vertical B-pillar (door divider)
          b.addBox(sgn * 0.74, 1.16, -0.06, 0.065, 0.56, 0.09, { color: bodyTint, rotZ: sgn * 0.12 });
          // Angled wide C-pillar (rear quarter roof post)
          b.addBox(sgn * 0.71, 1.16, -0.94, 0.075, 0.56, 0.18, { color: bodyTint, rotX: 0.40, rotZ: sgn * 0.14 });
          // Upper side roof-frame rail
          b.addBox(sgn * 0.72, 1.41, -0.14, 0.06, 0.06, 1.60, { color: bodyTint });
        }
        // Front & rear window cowl header bars
        b.addBox(0, 1.40, 0.62, 1.42, 0.06, 0.08, { color: bodyTint });
        b.addBox(0, 1.40, -0.90, 1.42, 0.06, 0.08, { color: bodyTint });

        // 4. Slatted Radiator Grille, Recessed Headlights, Taillights, License Plates & Wrap-Around Bumpers
        b.addBeveledBox(0, 0.44, 2.18, 1.84, 0.15, 0.18, 0.025, { color: trimCol });
        b.addBeveledBox(0, 0.44, -2.16, 1.84, 0.15, 0.18, 0.025, { color: trimCol });
        b.addBox(0, 0.68, 2.13, 1.12, 0.22, 0.07, { color: [0.14, 0.14, 0.15] });
        for (let g = -2; g <= 2; g++) {
          b.addBox(0, 0.68 + g * 0.04, 2.16, 1.08, 0.015, 0.03, { color: chromeCol });
        }
        // Headlight reflectors & amber turn indicators
        for (const sgn of [-1, 1]) {
          b.addBeveledBox(sgn * 0.68, 0.69, 2.13, 0.28, 0.17, 0.07, 0.015, { color: [0.84, 0.84, 0.78] });
          b.addBox(sgn * 0.85, 0.69, 2.11, 0.08, 0.15, 0.06, { color: [0.86, 0.48, 0.12] });
          // Rear red/amber taillight clusters
          b.addBox(sgn * 0.66, 0.72, -2.11, 0.34, 0.15, 0.06, { color: [0.64, 0.16, 0.14] });
        }
        // License plates (front & rear)
        b.addBox(0, 0.45, 2.27, 0.48, 0.11, 0.02, { color: [0.82, 0.82, 0.80] });
        b.addBox(0, 0.58, -2.13, 0.48, 0.11, 0.02, { color: [0.82, 0.82, 0.80] });

        // 5. 4 Grounded Deep-Dish Treaded Wheels (r=0.34m, center Y=0.34m -> DEAD-FLUSH Y=0.000m!)
        const wx = [-0.84, 0.84];
        const wz = [1.34, -1.30];
        for (let i = 0; i < 2; i++) {
          for (let j = 0; j < 2; j++) {
            addDeepWheel(b, wx[i], 0.34, wz[j], 0.34, 0.24, i === 0 ? -1 : 1, [0.58, 0.58, 0.56]);
          }
        }
        return b.build(gl);
      };
      destMeshes.carIntact = buildCar(false);
      destMeshes.carDamaged = buildCar(true);

      // Explosive Soviet UAZ-452 "Bukhanka" / Utility Van (1.92m W x 1.98m H x 4.42m L, flush Y=0!)
      const buildVan = (damaged) => {
        const b = new Builder();
        const bodyTint = damaged ? [0.60, 0.58, 0.54] : [0.94, 0.94, 0.92];
        const trimCol = [0.20, 0.20, 0.22];
        // Lower body skirt + ribbed cargo side walls
        b.addBeveledBox(0, 0.64, 0, 1.62, 0.48, 4.18, 0.035, { color: [0.18, 0.18, 0.19], aoBottom: 0.46 });
        b.addBeveledBox(0, 0.88, 0, 1.88, 0.68, 4.30, 0.05, { color: bodyTint, uvScale: 0.45, aoBottom: 0.54 });
        // Side cargo upper panel (rear half solid ribbed metal, front half open shattered cab windows!)
        b.addBeveledBox(0, 1.54, -0.78, 1.82, 0.68, 2.66, 0.05, { color: bodyTint, uvScale: 0.45 });
        // Open front cab pillars + split windshield center post + interior seats & dash
        b.addBeveledBox(0, 1.10, 1.72, 1.64, 0.26, 0.38, 0.02, { color: [0.22, 0.22, 0.24] });
        b.addCylinder(-0.46, 1.24, 1.46, 0.18, 0.18, 0.04, 12, { axis: 'z', color: [0.16, 0.16, 0.17], rotX: 0.55 });
        for (const sx of [-0.46, 0.46]) {
          b.addBeveledBox(sx, 1.18, 1.06, 0.46, 0.48, 0.16, 0.02, { color: [0.30, 0.26, 0.23] });
        }
        for (const sgn of [-1, 1]) {
          b.addBox(sgn * 0.86, 1.54, 1.98, 0.08, 0.68, 0.09, { color: bodyTint, rotX: -0.16 });
          b.addBox(sgn * 0.88, 1.54, 0.72, 0.08, 0.68, 0.11, { color: bodyTint });
          // Side cargo horizontal ribs
          b.addBox(sgn * 0.92, 1.04, -0.45, 0.04, 0.06, 3.10, { color: [0.68, 0.68, 0.66] });
          b.addBox(sgn * 0.92, 0.78, -0.45, 0.04, 0.06, 3.10, { color: [0.68, 0.68, 0.66] });
        }
        b.addBox(0, 1.54, 2.02, 0.07, 0.68, 0.08, { color: bodyTint, rotX: -0.16 }); // Iconic split windshield center bar
        // Rounded van roof crown + tubular roof cargo rack
        b.addBeveledBox(0, 1.90, -0.02, 1.76, 0.14, 4.10, 0.05, { color: bodyTint, uvScale: 0.45 });
        for (const sgn of [-0.74, 0.74]) {
          b.addBox(sgn, 2.04, -0.45, 0.04, 0.04, 2.6, { color: trimCol });
        }
        for (const rz of [-1.6, -0.5, 0.6]) {
          b.addBox(0, 2.04, rz, 1.48, 0.04, 0.04, { color: trimCol });
        }
        // Snub-nose grille, round UAZ headlights, heavy steel bumpers & rear spare wheel!
        b.addBeveledBox(0, 0.48, 2.22, 1.92, 0.18, 0.20, 0.025, { color: trimCol });
        b.addBeveledBox(0, 0.48, -2.22, 1.92, 0.18, 0.20, 0.025, { color: trimCol });
        b.addBox(0, 0.86, 2.16, 0.96, 0.34, 0.06, { color: [0.15, 0.15, 0.16] });
        for (const sgn of [-0.66, 0.66]) {
          b.addCylinder(sgn, 0.92, 2.16, 0.13, 0.14, 0.08, 12, { axis: 'z', color: [0.85, 0.84, 0.76] });
        }
        b.addCylinder(0.35, 1.02, -2.24, 0.34, 0.34, 0.22, 12, { axis: 'z', color: [0.15, 0.15, 0.16] }); // Rear door spare tire
        // 4 Grounded Heavy Off-Road Wheels (r=0.38m -> DEAD-FLUSH Y=0.000m!)
        for (const wx of [-0.88, 0.88]) {
          for (const wz of [1.26, -1.26]) {
            addDeepWheel(b, wx, 0.38, wz, 0.38, 0.26, wx < 0 ? -1 : 1, [0.50, 0.50, 0.48]);
          }
        }
        return b.build(gl);
      };
      destMeshes.vanIntact = buildVan(false);
      destMeshes.vanDamaged = buildVan(true);
    }

    // Explosive Red 200L Fuel Drum (r=0.31m, h=0.96m, flush at Y=0)
    {
      const buildDrum = (damaged) => {
        const b = new Builder();
        const col = damaged ? [0.68, 0.20, 0.15] : [0.95, 0.95, 0.95];
        b.addCylinder(0, 0.48, 0, 0.30, 0.30, 0.94, 14, { color: col, uvScale: 0.7, aoBottom: 0.58 });
        // 3 steel rolling ribs
        b.addCylinder(0, 0.04, 0, 0.32, 0.32, 0.05, 14, { color: [0.75, 0.75, 0.75] });
        b.addCylinder(0, 0.34, 0, 0.32, 0.32, 0.04, 14, { color: [0.75, 0.75, 0.75] });
        b.addCylinder(0, 0.64, 0, 0.32, 0.32, 0.04, 14, { color: [0.75, 0.75, 0.75] });
        b.addCylinder(0, 0.93, 0, 0.32, 0.32, 0.05, 14, { color: [0.75, 0.75, 0.75] });
        // Filler bung cap on top
        b.addCylinder(0.14, 0.97, 0.05, 0.045, 0.045, 0.04, 8, { color: [0.35, 0.35, 0.36] });
        return b.build(gl);
      };
      destMeshes.drumIntact = buildDrum(false);
      destMeshes.drumDamaged = buildDrum(true);
    }

    // Sector Flag cloth mesh (2.2m wide x 1.35m tall, hanging from X=0..2.2, Y=0..1.35)
    {
      const b = new Builder();
      const segs = 6;
      const w = 2.2, h = 1.35;
      for (let i = 0; i < segs; i++) {
        const t0 = i / segs, t1 = (i + 1) / segs;
        const x0 = t0 * w, x1 = t1 * w;
        const z0 = Math.sin(t0 * Math.PI * 1.8) * 0.14;
        const z1 = Math.sin(t1 * Math.PI * 1.8) * 0.14;
        b.addQuad(
          [x0, 0, z0], [x1, 0, z1], [x1, h, z1], [x0, h, z0],
          [t0, 0], [t1, 0], [t1, 1], [t0, 1],
          [0.98, 0.98, 0.98]
        );
      }
      flagMesh = b.build(gl);
    }
  }

  // ---- Register Destructible Helpers ----
  function spawnDestWall(pos, size, rotY, material, floorY, sectorIdx, coverNormal) {
    if (!DF.Destruction) return null;
    const id = 'wall_' + (destSeq++);
    const isBrick = material === 'brick';
    const isPartition = material === 'plaster';
    const isParapet = size[1] < 1.5;

    let meshIntact, meshDamaged, scale;
    if (isParapet) {
      meshIntact = destMeshes.parapetIntact;
      meshDamaged = destMeshes.parapetDamaged;
      scale = [size[0] / 3.6, size[1] / 1.08, size[2] / 0.20];
    } else if (isPartition) {
      meshIntact = destMeshes.partitionIntact;
      meshDamaged = destMeshes.partitionDamaged;
      scale = [size[0] / 3.6, size[1] / 3.35, size[2] / 0.22];
    } else {
      meshIntact = isBrick ? destMeshes.wallBrickIntact : destMeshes.wallConcreteIntact;
      meshDamaged = isBrick ? destMeshes.wallBrickDamaged : destMeshes.wallConcreteDamaged;
      scale = [size[0] / 4.0, size[1] / 3.35, size[2] / 0.34];
    }

    const hp = isParapet ? 130 : isPartition ? 105 : isBrick ? 175 : 210;
    const p = DF.Destruction.registerPiece({
      id,
      kind: isParapet ? 'parapet' : isPartition ? 'partition' : 'wall',
      pos,
      size,
      rotY,
      scale,
      material,
      texKey: isBrick ? 'brick' : isPartition ? 'plaster' : 'concrete',
      damagedTexKey: isBrick ? 'brick' : 'concrete_damaged',
      color: isBrick ? [0.84, 0.68, 0.60] : isPartition ? [0.86, 0.83, 0.78] : [0.82, 0.83, 0.82],
      hp,
      maxHp: hp,
      meshIntact,
      meshDamaged,
      floorY,
      spawnsRubble: true
    });

    if (coverNormal && p) {
      addCover(
        [pos[0] - coverNormal[0] * 0.95, floorY, pos[2] - coverNormal[2] * 0.95],
        coverNormal,
        isParapet ? 1.1 : 1.8,
        sectorIdx,
        null,
        id
      );
    }
    return p;
  }

  function spawnWindowGlass(pos, width, height, rotY, floorY) {
    if (!DF.Destruction) return null;
    const id = 'win_' + (destSeq++);
    return DF.Destruction.registerPiece({
      id,
      kind: 'window',
      pos,
      size: [width, height, 0.08],
      rotY,
      scale: [width / 2.2, height / 1.55, 1],
      material: 'glass',
      texKey: 'glass',
      damagedTexKey: 'glass',
      color: [0.20, 0.26, 0.32],
      roughness: 0.06,
      metalness: 0.22,
      alpha: 0.48,
      doubleSided: true,
      hp: 24,
      maxHp: 24,
      meshIntact: destMeshes.windowGlass,
      meshDamaged: destMeshes.windowGlass,
      floorY,
      spawnsRubble: false
    });
  }

  function spawnDoor(pos, rotY, floorY) {
    if (!DF.Destruction) return null;
    const id = 'door_' + (destSeq++);
    return DF.Destruction.registerPiece({
      id,
      kind: 'door',
      pos,
      size: [1.3, 2.38, 0.12],
      rotY,
      scale: [1, 1, 1],
      material: 'wood',
      texKey: 'wood',
      damagedTexKey: 'wood',
      color: [0.72, 0.60, 0.48],
      hp: 58,
      maxHp: 58,
      meshIntact: destMeshes.doorIntact,
      meshDamaged: destMeshes.doorDamaged,
      floorY,
      spawnsRubble: true
    });
  }

  function spawnSandbagWall(x, z, rotY, sectorIdx, factionHint, coverDirSign) {
    if (!DF.Destruction) return null;
    const y = DF.Physics ? DF.Physics.getGroundY(x, z, 0.5) : terrainHeight(x, z);
    const id = 'sandbag_' + (destSeq++);
    const p = DF.Destruction.registerPiece({
      id,
      kind: 'sandbag',
      pos: [x, y, z],
      size: [2.8, 1.12, 0.74],
      rotY,
      scale: [1, 1, 1],
      material: 'sandbag',
      texKey: 'sandbag',
      damagedTexKey: 'sandbag',
      color: [0.88, 0.83, 0.72],
      roughness: 0.95,
      metalness: 0.02,
      hp: 155,
      maxHp: 155,
      meshIntact: destMeshes.sandbagIntact,
      meshDamaged: destMeshes.sandbagDamaged,
      floorY: y,
      spawnsRubble: true
    });
    // Register tactical cover on both or designated facing side
    const nx = Math.sin(rotY) * (coverDirSign || 1);
    const nz = Math.cos(rotY) * (coverDirSign || 1);
    addCover([x - nx * 1.05, y, z - nz * 1.05], [nx, 0, nz], 1.15, sectorIdx, factionHint, id);
    if (!coverDirSign) {
      addCover([x + nx * 1.05, y, z + nz * 1.05], [-nx, 0, -nz], 1.15, sectorIdx, null, id);
    }
    return p;
  }

  function spawnJerseyBarrier(x, z, rotY, sectorIdx) {
    if (!DF.Destruction) return null;
    const y = DF.Physics ? DF.Physics.getGroundY(x, z, 0.5) : terrainHeight(x, z);
    const id = 'jersey_' + (destSeq++);
    const p = DF.Destruction.registerPiece({
      id,
      kind: 'barrier',
      pos: [x, y, z],
      size: [2.6, 1.05, 0.66],
      rotY,
      scale: [1, 1, 1],
      material: 'concrete',
      texKey: 'concrete',
      damagedTexKey: 'concrete_damaged',
      color: [0.84, 0.83, 0.80],
      roughness: 0.88,
      metalness: 0.04,
      hp: 210,
      maxHp: 210,
      meshIntact: destMeshes.jerseyIntact,
      meshDamaged: destMeshes.jerseyDamaged,
      floorY: y,
      spawnsRubble: true
    });
    const nx = Math.sin(rotY);
    const nz = Math.cos(rotY);
    addCover([x - nx * 1.05, y, z - nz * 1.05], [nx, 0, nz], 1.08, sectorIdx, null, id);
    addCover([x + nx * 1.05, y, z + nz * 1.05], [-nx, 0, -nz], 1.08, sectorIdx, null, id);
    return p;
  }

  function spawnCrate(x, yRef, z, rotY, sectorIdx) {
    if (!DF.Destruction) return null;
    const y = DF.Physics ? DF.Physics.getGroundY(x, z, yRef) : yRef;
    const id = 'crate_' + (destSeq++);
    return DF.Destruction.registerPiece({
      id,
      kind: 'crate',
      pos: [x, y, z],
      size: [1.26, 0.84, 0.88],
      rotY,
      scale: [1, 1, 1],
      material: 'wood',
      texKey: 'crate_mil',
      damagedTexKey: 'wood',
      color: [0.88, 0.86, 0.80],
      roughness: 0.82,
      metalness: 0.08,
      hp: 85,
      maxHp: 85,
      meshIntact: destMeshes.crateIntact,
      meshDamaged: destMeshes.crateIntact,
      floorY: y,
      spawnsRubble: true
    });
  }

  function spawnExplosiveCar(x, z, rotY, paintColor, sectorIdx, isVan) {
    if (!DF.Destruction) return null;
    const y = DF.Physics ? DF.Physics.getGroundY(x, z, 0.5) : terrainHeight(x, z);
    const id = (isVan ? 'van_' : 'car_') + (destSeq++);
    const p = DF.Destruction.registerPiece({
      id,
      kind: 'car',
      pos: [x, y, z],
      size: isVan ? [1.92, 1.98, 4.42] : [1.86, 1.50, 4.40],
      rotY,
      scale: [1, 1, 1],
      material: 'metal',
      texKey: 'metal_rust',
      damagedTexKey: 'burnt_wreck',
      color: paintColor || [0.68, 0.24, 0.20],
      roughness: 0.54,
      metalness: 0.52,
      hp: isVan ? 175 : 150,
      maxHp: isVan ? 175 : 150,
      explosive: true,
      blastRadius: 11.5,
      blastDamage: 215,
      meshIntact: isVan ? destMeshes.vanIntact : destMeshes.carIntact,
      meshDamaged: isVan ? destMeshes.vanDamaged : destMeshes.carDamaged,
      floorY: y,
      spawnsRubble: true
    });
    // Hard cover beside the vehicle until blown up
    const rx = Math.cos(rotY);
    const rz = -Math.sin(rotY);
    addCover([x + rx * 1.65, y, z + rz * 1.65], [-rx, 0, -rz], 1.25, sectorIdx, null, id);
    addCover([x - rx * 1.65, y, z - rz * 1.65], [rx, 0, rz], 1.25, sectorIdx, null, id);
    return p;
  }

  function spawnFuelDrum(x, yRef, z, sectorIdx) {
    if (!DF.Destruction) return null;
    const y = DF.Physics ? DF.Physics.getGroundY(x, z, yRef) : terrainHeight(x, z);
    const id = 'drum_' + (destSeq++);
    return DF.Destruction.registerPiece({
      id,
      kind: 'fuel_drum',
      pos: [x, y, z],
      size: [0.66, 0.98, 0.66],
      rotY: (destSeq * 1.37) % 6.28,
      scale: [1, 1, 1],
      material: 'metal',
      texKey: 'metal_rust',
      damagedTexKey: 'burnt_wreck',
      color: [0.84, 0.16, 0.12],
      roughness: 0.44,
      metalness: 0.58,
      hp: 45,
      maxHp: 45,
      explosive: true,
      blastRadius: 8.5,
      blastDamage: 175,
      meshIntact: destMeshes.drumIntact,
      meshDamaged: destMeshes.drumDamaged,
      floorY: y,
      spawnsRubble: true
    });
  }

  // ---- 1. Ground Terrain, Wet Cracked Asphalt Avenue, Sidewalks, Craters & Perimeter Ruin Backdrop ----
  function buildTerrainAndRoads(bm) {
    const bAsphalt = bm.get('asphalt', { texKey: 'asphalt', color: [0.92, 0.93, 0.95], roughness: 0.44, metalness: 0.08 });
    const bPuddle = bm.get('wet_puddle', { texKey: 'asphalt', color: [0.36, 0.42, 0.48], roughness: 0.07, metalness: 0.16 });
    const bMud = bm.get('mud_rubble', { texKey: 'mud_rubble', color: [0.84, 0.81, 0.76], roughness: 0.98, metalness: 0.0 });
    const bCurb = bm.get('concrete', { texKey: 'concrete', color: [0.82, 0.81, 0.79], roughness: 0.86, metalness: 0.04 });
    const bPaint = bm.get('road_paint', { texKey: 'concrete_damaged', color: [0.48, 0.47, 0.44], roughness: 0.95, metalness: 0.0 });

    // Playable 180m x 110m terrain grid (3m quads matching terrainHeight(x,z) mathematically!)
    const stepX = 3.0;
    const stepZ = 2.5;
    for (let x = -90; x < 90; x += stepX) {
      const x1 = x + stepX;
      const midX = (x + x1) * 0.5;
      for (let z = -55; z < 55; z += stepZ) {
        const z1 = z + stepZ;
        const midZ = (z + z1) * 0.5;
        const absZ = Math.abs(midZ);

        const y00 = terrainHeight(x, z);
        const y01 = terrainHeight(x, z1);
        const y11 = terrainHeight(x1, z1);
        const y10 = terrainHeight(x1, z);

        // Main avenue Z in [-10,10], Lenin Square plaza X in [-8,16] Z in [-15,15], crossroads X in [-46,-30]
        const isRoad =
          absZ <= 10.0 ||
          (midX >= -46 && midX <= -30 && absZ <= 15.0) ||
          (midX >= -8 && midX <= 16 && absZ <= 15.0) ||
          (midX >= 34 && midX <= 50 && absZ <= 15.0) ||
          (midX >= -26 && midX <= -12 && absZ <= 35.0);

        const builder = isRoad ? bAsphalt : bMud;
        const uvS = isRoad ? 0.16 : 0.14;
        // Darken crater centers slightly for scorched shell blast realism
        const avgY = (y00 + y01 + y11 + y10) * 0.25;
        const scorch = avgY < -0.10 ? Math.max(0.45, 1.0 + avgY * 1.1) : 1.0;
        const col = [scorch, scorch * 0.98, scorch * 0.96];

        if (builder) {
          builder.addQuad(
            [x, y00, z],
            [x, y01, z1],
            [x1, y11, z1],
            [x1, y10, z],
            [x * uvS, z * uvS],
            [x * uvS, z1 * uvS],
            [x1 * uvS, z1 * uvS],
            [x1 * uvS, z * uvS],
            col
          );
        }
      }
    }

    // Outer non-playable terrain apron out to X[-170..170], Z[-125..125] (zero floating rectangle!)
    const apronRects = [
      [-170, -125, -90, 125],
      [90, -125, 170, 125],
      [-90, -125, 90, -55],
      [-90, 55, 90, 125]
    ];
    for (let i = 0; i < apronRects.length; i++) {
      const r = apronRects[i];
      const yA = 1.15;
      if (bMud) {
        const x0 = r[0], z0 = r[1], x1 = r[2], z1 = r[3];
        // Match inner edge height seamlessly to playable border
        const y00 = terrainHeight(Math.max(-90, Math.min(90, x0)), Math.max(-55, Math.min(55, z0)));
        const y01 = terrainHeight(Math.max(-90, Math.min(90, x0)), Math.max(-55, Math.min(55, z1)));
        const y11 = terrainHeight(Math.max(-90, Math.min(90, x1)), Math.max(-55, Math.min(55, z1)));
        const y10 = terrainHeight(Math.max(-90, Math.min(90, x1)), Math.max(-55, Math.min(55, z0)));
        bMud.addQuad(
          [x0, y00, z0], [x0, y01, z1], [x1, y11, z1], [x1, y10, z0],
          [x0 * 0.08, z0 * 0.08], [x0 * 0.08, z1 * 0.08], [x1 * 0.08, z1 * 0.08], [x1 * 0.08, z0 * 0.08],
          [0.62, 0.59, 0.55]
        );
      }
      void yA;
    }

    // Raised beveled concrete sidewalks along main avenue (Y = 0.12m, smoothly steppable!) + cast-iron gutter storm drains & curb joints
    const bIronDrain = bm.get('metal_dark', { texKey: 'metal_dark', color: [0.24, 0.25, 0.27], roughness: 0.58, metalness: 0.76 });
    const sidewalkSegments = [
      // North sidewalks (Z = -12.2..-10.0)
      [-86, -48, -12.2, -10.0],
      [-28, -14, -12.2, -10.0],
      [18, 48, -12.2, -10.0],
      // South sidewalks (Z = +10.0..+12.2)
      [-86, -48, 10.0, 12.2],
      [-28, -12, 10.0, 12.2],
      [18, 35, 10.0, 12.2]
    ];
    for (let i = 0; i < sidewalkSegments.length; i++) {
      const s = sidewalkSegments[i];
      const cx = (s[0] + s[1]) * 0.5;
      const cz = (s[2] + s[3]) * 0.5;
      const sx = s[1] - s[0];
      const sz = s[3] - s[2];
      const isNorth = cz < 0;
      const curbZ = isNorth ? s[3] : s[2];
      if (bCurb) {
        bCurb.addBeveledBox(cx, 0.02, cz, sx, 0.20, sz, 0.03, {
          color: [0.78, 0.77, 0.74], uvScale: 0.35, aoBottom: 0.60
        });
        // Distinct weathered granite curbstone blocks + expansion joints along street edge
        for (let gx = s[0] + 1.5; gx < s[1] - 1.0; gx += 3.0) {
          bCurb.addBeveledBox(gx, 0.075, curbZ - (isNorth ? 0.12 : -0.12), 2.86, 0.11, 0.24, 0.02, {
            color: [0.68 + ((Math.abs(gx) % 3) * 0.03), 0.67, 0.65], uvScale: 0.5, aoBottom: 0.55
          });
        }
      }
      // Recessed cast-iron gutter storm drain grates flush along street curb
      if (bIronDrain) {
        for (let dx = s[0] + 5.0; dx < s[1] - 4.0; dx += 13.0) {
          const gz = curbZ + (isNorth ? 0.38 : -0.38);
          const gy = terrainHeight(dx, gz);
          if (Math.abs(gy) > 0.05) continue;
          // Outer cast-iron frame
          bIronDrain.addBeveledBox(dx, gy + 0.014, gz, 0.88, 0.028, 0.54, 0.008, { color: [0.22, 0.23, 0.25] });
          // 5 parallel iron drainage grate bars
          for (let bar = -2; bar <= 2; bar++) {
            bIronDrain.addBox(dx + bar * 0.15, gy + 0.026, gz, 0.05, 0.014, 0.44, { color: [0.34, 0.35, 0.37] });
          }
        }
      }
      addStaticCol('sidewalk', [s[0], -0.1, s[2]], [s[1], 0.12, s[3]], {
        type: 'floor', material: 'concrete'
      });
    }

    // Faded Soviet road dashed centerlines & Sector A crosswalk stripes (sitting flush +0.015m above flat road)
    if (bPaint) {
      for (let x = -84; x <= 44; x += 6.5) {
        // Skip right inside crater depressions
        if (Math.abs(terrainHeight(x, 0)) > 0.04) continue;
        bPaint.addBox(x, 0.012, 0, 3.2, 0.014, 0.24, { color: [0.76, 0.74, 0.64] });
      }
      // Crosswalk zebra stripes at Sector A crossroads (X = -46.5 and X = -29.5)
      for (const cx of [-46.5, -29.5]) {
        for (let z = -8.5; z <= 8.5; z += 1.55) {
          if (Math.abs(terrainHeight(cx, z)) > 0.04) continue;
          bPaint.addBox(cx, 0.013, z, 2.2, 0.014, 0.65, { color: [0.74, 0.72, 0.65] });
        }
      }
    }

    // Wet asphalt puddles are rendered organically via world-space FBM in DF.Renderer (zero rectangular puddle boxes!)
    void bPuddle;

    // Scattered angular curb rubble & artillery crater rim debris chunks (matte dusty concrete & weathered brick!)
    buildStreetRubbleAndCraterDebris(bm);

    // Perimeter low boundary concrete fences & distant shattered Soviet skyline silhouettes
    buildPerimeterRuinBackdrop(bm);
  }

  function buildStreetRubbleAndCraterDebris(bm) {
    const bConcDeb = bm.get('concrete_damaged', { texKey: 'concrete_damaged', color: [0.80, 0.78, 0.74], roughness: 0.96, metalness: 0.0 });
    const bBrickDeb = bm.get('brick', { texKey: 'brick', color: [0.76, 0.66, 0.58], roughness: 0.96, metalness: 0.0 });
    const bRebar = bm.get('metal_rust', { texKey: 'metal_rust', color: [0.42, 0.34, 0.29], roughness: 0.84, metalness: 0.52 });
    const rng = mulberry32(8421);

    // 1. Crater blast-rim angular chunks around each artillery crater
    for (let i = 0; i < CRATERS.length; i++) {
      const cr = CRATERS[i];
      for (let k = 0; k < 7; k++) {
        const ang = (k / 7) * Math.PI * 2 + rng() * 0.6;
        const dist = cr.r * (0.95 + rng() * 0.45);
        const rx = cr.x + Math.cos(ang) * dist;
        const rz = cr.z + Math.sin(ang) * dist;
        const ry = terrainHeight(rx, rz);
        const sx = 0.24 + rng() * 0.42;
        const sy = 0.12 + rng() * 0.20;
        const sz = 0.22 + rng() * 0.38;
        const shade = 0.66 + rng() * 0.20;
        const b = k % 3 === 0 ? bBrickDeb : bConcDeb;
        if (b) {
          b.addBox(rx, ry + sy * 0.36, rz, sx, sy, sz, {
            color: [shade, shade * 0.98, shade * 0.94],
            uvScale: 0.7,
            rotY: rng() * 3.14,
            rotX: (rng() - 0.5) * 0.42,
            rotZ: (rng() - 0.5) * 0.42,
            aoBottom: 0.58
          });
        }
      }
    }

    // 2. Angular fallen masonry/curb rubble clusters along building bases & sidewalks (non-blocking visual density!)
    const curbPiles = [
      [-51.0, -13.2], [-34.0, -13.1], [-27.0, -13.3],
      [-48.0, 13.1],  [-26.5, 13.2],  [-11.0, -14.0],
      [6.0, -14.1],   [17.0, -13.9],  [-8.5, 14.0],
      [14.5, 14.1],   [29.5, -14.8],  [45.0, -14.8],
      [48.5, -10.5],  [48.5, 10.5],   [-60.0, -12.4],
      [-64.0, 12.4],  [24.0, -12.2],  [24.0, 12.2]
    ];
    for (let i = 0; i < curbPiles.length; i++) {
      const px = curbPiles[i][0], pz = curbPiles[i][1];
      const py = DF.Physics ? DF.Physics.getGroundY(px, pz, 0.4) : terrainHeight(px, pz);
      // 6-8 sharp angular fallen slab & brick chunks per pile
      for (let k = 0; k < 7; k++) {
        const a = rng() * Math.PI * 2;
        const rad = rng() * 1.15;
        const cx = px + Math.cos(a) * rad;
        const cz = pz + Math.sin(a) * rad * 0.65;
        const sx = 0.22 + rng() * 0.48;
        const sy = 0.10 + rng() * 0.22;
        const sz = 0.20 + rng() * 0.44;
        const shade = 0.68 + rng() * 0.22;
        const useBrick = (i + k) % 3 === 0;
        const b = useBrick ? bBrickDeb : bConcDeb;
        if (b) {
          if (k === 0 && typeof b.addWedge === 'function') {
            b.addWedge(cx, py + sy * 0.5, cz, sx * 1.3, sy * 1.25, sz * 1.2, {
              color: [shade, shade * 0.98, shade * 0.95], uvScale: 0.65, rotY: rng() * 6.28
            });
          } else {
            b.addBox(cx, py + sy * 0.42, cz, sx, sy, sz, {
              color: [shade, shade * 0.98, shade * 0.95],
              uvScale: 0.7,
              rotY: rng() * 3.14,
              rotX: (rng() - 0.5) * 0.38,
              rotZ: (rng() - 0.5) * 0.38,
              aoBottom: 0.58
            });
          }
        }
      }
      // Occasional twisted rebar rod sticking out of fallen facade masonry
      if (i % 2 === 0 && bRebar) {
        bRebar.addTube([
          [px - 0.2, py + 0.08, pz],
          [px + 0.15, py + 0.34, pz + 0.12],
          [px + 0.45, py + 0.42, pz - 0.10]
        ], 0.016, 4, { color: [0.38, 0.30, 0.26] });
      }
    }
  }

  function buildPerimeterRuinBackdrop(bm) {
    const bRuinConc = bm.get('concrete_damaged', { texKey: 'concrete_damaged', color: [0.74, 0.74, 0.75], roughness: 0.94, metalness: 0.02 });
    const bRuinBrick = bm.get('brick', { texKey: 'brick', color: [0.76, 0.68, 0.62], roughness: 0.94, metalness: 0.02 });
    const bMetal = bm.get('metal_rust', { texKey: 'metal_rust', color: [0.50, 0.44, 0.39], roughness: 0.80, metalness: 0.58 });
    const bDark = bm.get('metal_dark', { texKey: 'metal_dark', color: [0.22, 0.24, 0.27], roughness: 0.72, metalness: 0.45 });

    // Low perimeter concrete slab fences right at map edges (X=+-90, Z=+-55)
    for (let x = -88; x <= 88; x += 12) {
      for (const zEdge of [-55.6, 55.6]) {
        const y = terrainHeight(x, zEdge > 0 ? 54 : -54);
        const h = 2.1 + ((Math.abs(x * 7) % 5) * 0.18);
        if (bRuinConc) {
          bRuinConc.addBeveledBox(x, y + h * 0.5 - 0.1, zEdge, 11.4, h, 0.45, 0.03, {
            color: [0.68, 0.67, 0.66], uvScale: 0.3, aoBottom: 0.55
          });
        }
      }
    }

    // 14 Tall shattered Soviet apartment & industrial steelworks silhouettes ringing the perimeter
    const skyline = [
      // North horizon ruins (Z < -64)
      { x: -82, z: -74, w: 28, d: 14, h: 22, mat: 'conc' },
      { x: -42, z: -78, w: 32, d: 16, h: 27, mat: 'brick' },
      { x: 4,   z: -74, w: 34, d: 15, h: 24, mat: 'conc' },
      { x: 50,  z: -76, w: 30, d: 16, h: 29, mat: 'conc' },
      { x: 92,  z: -72, w: 26, d: 15, h: 21, mat: 'brick' },
      // South horizon ruins (Z > +64)
      { x: -78, z: 75,  w: 30, d: 15, h: 23, mat: 'brick' },
      { x: -34, z: 78,  w: 28, d: 14, h: 20, mat: 'conc' },
      { x: 14,  z: 76,  w: 32, d: 16, h: 26, mat: 'conc' },
      { x: 64,  z: 74,  w: 28, d: 15, h: 24, mat: 'brick' },
      // East industrial Donbas skyline behind Sector C (X > +98)
      { x: 108, z: -34, w: 18, d: 28, h: 26, mat: 'conc' },
      { x: 112, z: 2,   w: 20, d: 30, h: 31, mat: 'conc' },
      { x: 106, z: 36,  w: 18, d: 26, h: 22, mat: 'brick' },
      // West backdrop ruins behind RU staging (X < -102)
      { x: -110, z: -26, w: 18, d: 28, h: 24, mat: 'conc' },
      { x: -108, z: 28,  w: 18, d: 28, h: 21, mat: 'brick' }
    ];

    for (let i = 0; i < skyline.length; i++) {
      const s = skyline[i];
      const b = s.mat === 'brick' ? bRuinBrick : bRuinConc;
      if (!b) continue;
      // Main tower block grounded deep (-0.5m) into outer terrain
      b.addBox(s.x, s.h * 0.5 - 0.5, s.z, s.w, s.h, s.d, {
        color: [0.58, 0.59, 0.62], uvScale: 0.22, aoBottom: 0.48
      });
      // Jagged broken upper crown blocks + Soviet elevator hut & parapet silhouette
      b.addBox(s.x - s.w * 0.24, s.h + 1.2, s.z, s.w * 0.42, 2.8, s.d * 0.92, {
        color: [0.52, 0.53, 0.56], uvScale: 0.25
      });
      b.addBox(s.x + s.w * 0.22, s.h + 1.5, s.z, 4.4, 3.2, 4.0, {
        color: [0.50, 0.51, 0.54], uvScale: 0.3
      });
      if (bDark) {
        // Rooftop antenna mast on distant apartment towers
        const ax = s.x + s.w * 0.22;
        bDark.addCylinder(ax, s.h + 5.6, s.z, 0.08, 0.14, 5.2, 6, { color: [0.26, 0.28, 0.30] });
        bDark.addBox(ax, s.h + 7.2, s.z, 2.8, 0.10, 0.10, { color: [0.28, 0.30, 0.32] });
      }
      // Recessed dark window bands
      for (let wy = 4.0; wy < s.h - 2.0; wy += 3.6) {
        b.addBox(s.x, wy, s.z + (s.z < 0 ? s.d * 0.51 : -s.d * 0.51), s.w * 0.84, 1.45, 0.25, {
          color: [0.14, 0.16, 0.19]
        });
      }
    }

    // Iconic Donbas steelworks smokestack & industrial crane tower to the NE
    if (bRuinBrick && bMetal) {
      bRuinBrick.addCylinder(118, 22, -62, 1.8, 3.4, 46, 12, { color: [0.52, 0.42, 0.38], uvScale: 0.2, aoBottom: 0.45 });
      bRuinBrick.addCylinder(118, 41, -62, 2.05, 2.05, 1.8, 12, { color: [0.68, 0.28, 0.22] });
      bMetal.addCylinder(112, 18, 52, 1.2, 2.2, 38, 10, { color: [0.36, 0.35, 0.36] });
    }
  }

  // ---- 2. Architectural Building Builder (Enterable F1, F2, optional Roof, Stairwells, Balconies, Ruined 3-5F) ----
  function addSlabsAroundCutouts(builder, x0, x1, z0, z1, yBot, yTop, cutouts, colPrefix, color) {
    // Recursively subtract rectangular stairwell cutouts from a floor slab [x0..x1] x [z0..z1]
    let rects = [{ x0, x1, z0, z1 }];
    for (let c = 0; c < cutouts.length; c++) {
      const cut = cutouts[c];
      const next = [];
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        // No overlap
        if (cut.x1 <= r.x0 || cut.x0 >= r.x1 || cut.z1 <= r.z0 || cut.z0 >= r.z1) {
          next.push(r);
          continue;
        }
        // Left strip
        if (cut.x0 > r.x0 + 0.05) next.push({ x0: r.x0, x1: cut.x0, z0: r.z0, z1: r.z1 });
        // Right strip
        if (cut.x1 < r.x1 - 0.05) next.push({ x0: cut.x1, x1: r.x1, z0: r.z0, z1: r.z1 });
        const ix0 = Math.max(r.x0, cut.x0);
        const ix1 = Math.min(r.x1, cut.x1);
        // Back strip (-Z)
        if (cut.z0 > r.z0 + 0.05) next.push({ x0: ix0, x1: ix1, z0: r.z0, z1: cut.z0 });
        // Front strip (+Z)
        if (cut.z1 < r.z1 - 0.05) next.push({ x0: ix0, x1: ix1, z0: cut.z1, z1: r.z1 });
      }
      rects = next;
    }

    const h = yTop - yBot;
    const cy = (yBot + yTop) * 0.5;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const sx = r.x1 - r.x0;
      const sz = r.z1 - r.z0;
      if (sx < 0.08 || sz < 0.08) continue;
      if (builder) {
        builder.addBox((r.x0 + r.x1) * 0.5, cy, (r.z0 + r.z1) * 0.5, sx, h, sz, {
          color: color || [0.76, 0.75, 0.72],
          uvScale: 0.28
        });
      }
      addStaticCol(colPrefix, [r.x0, yBot, r.z0], [r.x1, yTop, r.z1], {
        type: 'floor',
        material: 'concrete'
      });
    }
  }

  // Compute generously expanded stairwell slab cutout (+0.90m entry headroom, +0.44m open-side margin > 0.36m player radius!)
  function computeStairCutout(st) {
    const entryPad = 0.90;
    const sidePad = 0.44;
    let x0 = st.x0, x1 = st.x1, z0 = st.z0, z1 = st.z1;
    if (st.dir === '+x') x0 -= entryPad;
    else if (st.dir === '-x') x1 += entryPad;
    else if (st.dir === '+z') z0 -= entryPad;
    else if (st.dir === '-z') z1 += entryPad;

    if (st.guardRailSide === '+z') z1 += sidePad;
    else if (st.guardRailSide === '-z') z0 -= sidePad;
    else if (st.guardRailSide === '+x') x1 += sidePad;
    else if (st.guardRailSide === '-x') x0 -= sidePad;
    else if (st.guardRailSide === 'both') {
      if (st.dir === '+x' || st.dir === '-x') { z0 -= sidePad; z1 += sidePad; }
      else { x0 -= sidePad; x1 += sidePad; }
    }
    return { x0, x1, z0, z1 };
  }

  function addInteriorStaircase(bm, cfg) {
    // cfg: { x0, x1, z0, z1, y0, y1, dir: '+x'|'-x'|'+z'|'-z', guardRailSide }
    const bConc = bm.get('concrete', { texKey: 'concrete', color: [0.80, 0.79, 0.76], roughness: 0.88, metalness: 0.04 });
    const bMetal = bm.get('metal_dark', { texKey: 'metal_dark', color: [0.32, 0.34, 0.36], roughness: 0.58, metalness: 0.72 });

    const steps = 22;
    const dy = cfg.y1 - cfg.y0;
    const alongX = cfg.dir === '+x' || cfg.dir === '-x';
    const len = alongX ? (cfg.x1 - cfg.x0) : (cfg.z1 - cfg.z0);
    const wid = alongX ? (cfg.z1 - cfg.z0) : (cfg.x1 - cfg.x0);
    const stepRun = len / steps;
    const stepRise = dy / steps;
    const midX = (cfg.x0 + cfg.x1) * 0.5;
    const midZ = (cfg.z0 + cfg.z1) * 0.5;
    const midY = (cfg.y0 + cfg.y1) * 0.5;
    const slopeLen = Math.hypot(len, dy);
    const slopeAng = Math.atan2(dy, len);

    if (bConc && bMetal) {
      // 1. Sleek angled reinforced-concrete underside soffit & twin side stringer beams (ZERO clunky stacked monoliths!)
      const soffitThick = 0.20;
      const soffitOffY = -0.14;
      if (alongX) {
        const rotZ = cfg.dir === '+x' ? slopeAng : -slopeAng;
        bConc.addBox(midX, midY + soffitOffY, midZ, slopeLen, soffitThick, wid - 0.04, {
          color: [0.68, 0.67, 0.65], uvScale: 0.4, rotZ
        });
        for (const side of [-1, 1]) {
          bConc.addBeveledBox(midX, midY + soffitOffY + 0.14, midZ + side * (wid * 0.5 - 0.07), slopeLen, 0.28, 0.14, 0.015, {
            color: [0.74, 0.73, 0.70], uvScale: 0.45, rotZ
          });
        }
      } else {
        const rotX = cfg.dir === '+z' ? -slopeAng : slopeAng;
        bConc.addBox(midX, midY + soffitOffY, midZ, wid - 0.04, soffitThick, slopeLen, {
          color: [0.68, 0.67, 0.65], uvScale: 0.4, rotX
        });
        for (const side of [-1, 1]) {
          bConc.addBeveledBox(midX + side * (wid * 0.5 - 0.07), midY + soffitOffY + 0.14, midZ, 0.14, 0.28, slopeLen, 0.015, {
            color: [0.74, 0.73, 0.70], uvScale: 0.45, rotX
          });
        }
      }

      // 2. Exact visual-to-physics aligned concrete steps (treadTop sits strictly at/below getStairY ramp -> ZERO foot/camera step clipping!)
      const treadH = Math.max(stepRise + 0.02, 0.18);
      for (let i = 0; i < steps; i++) {
        const treadTop = cfg.y0 + (i / steps) * dy; // Strictly <= getStairY(x,z) across entire step!
        const cy = treadTop - treadH * 0.5;
        if (alongX) {
          const sxPos = cfg.dir === '+x'
            ? cfg.x0 + (i + 0.5) * stepRun
            : cfg.x1 - (i + 0.5) * stepRun;
          const noseX = cfg.dir === '+x' ? sxPos - stepRun * 0.46 : sxPos + stepRun * 0.46;
          bConc.addBox(sxPos, cy, midZ, stepRun + 0.03, treadH, wid - 0.18, {
            color: [0.78 + (i % 2) * 0.02, 0.77, 0.74], uvScale: 0.55
          });
          // Crisp dark steel anti-slip tread nosing edge strip
          bMetal.addBox(noseX, treadTop - 0.012, midZ, 0.04, 0.024, wid - 0.20, { color: [0.28, 0.29, 0.31] });
        } else {
          const szPos = cfg.dir === '+z'
            ? cfg.z0 + (i + 0.5) * stepRun
            : cfg.z1 - (i + 0.5) * stepRun;
          const noseZ = cfg.dir === '+z' ? szPos - stepRun * 0.46 : szPos + stepRun * 0.46;
          bConc.addBox(midX, cy, szPos, wid - 0.18, treadH, stepRun + 0.03, {
            color: [0.78 + (i % 2) * 0.02, 0.77, 0.74], uvScale: 0.55
          });
          bMetal.addBox(midX, treadTop - 0.012, noseZ, wid - 0.20, 0.024, 0.04, { color: [0.28, 0.29, 0.31] });
        }
      }
    }

    // 3. Tubular steel handrails & vertical balusters along both edges of staircase
    if (bMetal) {
      for (const side of [-1, 1]) {
        const inset = wid * 0.5 - 0.08;
        let p0, p1;
        if (alongX) {
          const rz = midZ + side * inset;
          p0 = [cfg.dir === '+x' ? cfg.x0 : cfg.x1, cfg.y0 + 0.94, rz];
          p1 = [cfg.dir === '+x' ? cfg.x1 : cfg.x0, cfg.y1 + 0.94, rz];
        } else {
          const rx = midX + side * inset;
          p0 = [rx, cfg.y0 + 0.94, cfg.dir === '+z' ? cfg.z0 : cfg.z1];
          p1 = [rx, cfg.y1 + 0.94, cfg.dir === '+z' ? cfg.z1 : cfg.z0];
        }
        bMetal.addTube([p0, p1], 0.028, 6, { color: [0.36, 0.38, 0.40] });
        for (let k = 0; k <= 5; k++) {
          const t = k / 5;
          const bx = p0[0] + (p1[0] - p0[0]) * t;
          const by = (cfg.y0 + dy * t) + 0.47;
          const bz = p0[2] + (p1[2] - p0[2]) * t;
          bMetal.addCylinder(bx, by, bz, 0.018, 0.018, 0.94, 6, { color: [0.30, 0.32, 0.34] });
        }
      }
    }

    // 4. Smooth inclined physics stair collider!
    addStaticCol('stair', [cfg.x0, cfg.y0, cfg.z0], [cfg.x1, cfg.y1, cfg.z1], {
      type: 'stair',
      material: 'concrete',
      stairDir: cfg.dir,
      stairY0: cfg.y0,
      stairY1: cfg.y1
    });

    // 5. Upper floor stairwell safety railing placed cleanly along the EXPANDED cutout rim (+0.44m side, +0.90m entry!)
    if (bMetal && bConc && cfg.guardRailSide) {
      const cut = computeStairCutout(cfg);
      const yR = cfg.y1;
      const cutLenX = cut.x1 - cut.x0;
      const cutLenZ = cut.z1 - cut.z0;
      const cutMidX = (cut.x0 + cut.x1) * 0.5;
      const cutMidZ = (cut.z0 + cut.z1) * 0.5;

      const addGuardSegment = (gx0, gz0, gx1, gz1) => {
        const sx = Math.max(0.06, Math.abs(gx1 - gx0));
        const sz = Math.max(0.06, Math.abs(gz1 - gz0));
        const cx = (gx0 + gx1) * 0.5;
        const cz = (gz0 + gz1) * 0.5;
        // Concrete curb kickplate + top/mid steel railing + corner posts
        bConc.addBox(cx, yR + 0.08, cz, sx + 0.04, 0.16, sz + 0.04, { color: [0.68, 0.67, 0.65] });
        bMetal.addBox(cx, yR + 0.96, cz, sx, 0.05, sz, { color: [0.36, 0.38, 0.40] });
        bMetal.addBox(cx, yR + 0.52, cz, sx, 0.04, sz, { color: [0.34, 0.36, 0.38] });
        bMetal.addCylinder(gx0, yR + 0.50, gz0, 0.025, 0.025, 0.98, 6, { color: [0.32, 0.34, 0.36] });
        bMetal.addCylinder(gx1, yR + 0.50, gz1, 0.025, 0.025, 0.98, 6, { color: [0.32, 0.34, 0.36] });
        addStaticCol('stairguard', [Math.min(gx0, gx1) - 0.06, yR, Math.min(gz0, gz1) - 0.06], [Math.max(gx0, gx1) + 0.06, yR + 1.02, Math.max(gz0, gz1) + 0.06], {
          type: 'cover', material: 'metal', passableForBullets: true
        });
      };

      if (alongX) {
        if (cfg.guardRailSide === 'both') {
          addGuardSegment(cut.x0, cut.z0 - 0.06, cut.x1, cut.z0 - 0.06);
          addGuardSegment(cut.x0, cut.z1 + 0.06, cut.x1, cut.z1 + 0.06);
        } else {
          const gz = cfg.guardRailSide === '+z' ? cut.z1 + 0.06 : cut.z0 - 0.06;
          addGuardSegment(cut.x0, gz, cut.x1, gz);
        }
        // Close off the entry-end rim on the upper floor so upper-floor soldiers don't step into the cutout!
        const endX = cfg.dir === '+x' ? cut.x0 - 0.06 : cut.x1 + 0.06;
        addGuardSegment(endX, cut.z0, endX, cut.z1);
      } else {
        if (cfg.guardRailSide === 'both') {
          addGuardSegment(cut.x0 - 0.06, cut.z0, cut.x0 - 0.06, cut.z1);
          addGuardSegment(cut.x1 + 0.06, cut.z0, cut.x1 + 0.06, cut.z1);
        } else {
          const gx = cfg.guardRailSide === '+x' ? cut.x1 + 0.06 : cut.x0 - 0.06;
          addGuardSegment(gx, cut.z0, gx, cut.z1);
        }
        const endZ = cfg.dir === '+z' ? cut.z0 - 0.06 : cut.z1 + 0.06;
        addGuardSegment(cut.x0, endZ, cut.x1, endZ);
      }
      void cutLenX; void cutLenZ; void cutMidX; void cutMidZ;
    }
  }

  // Modular bay wall generator along a straight exterior wall line
  function buildWallFacadeLine(bm, opts) {
    // opts: { x0, z0, x1, z1, yBase, h, thick, bays, material, sectorIdx, outNormal, floorIdx, hasBalconyOnBays }
    const dx = opts.x1 - opts.x0;
    const dz = opts.z1 - opts.z0;
    const totalLen = Math.hypot(dx, dz);
    const alongX = Math.abs(dx) >= Math.abs(dz);
    const ux = dx / totalLen;
    const uz = dz / totalLen;
    const rotY = alongX ? 0 : Math.PI * 0.5;
    const bays = opts.bays;
    const bayCount = bays.length;
    const pierW = 0.52;
    const baySpan = (totalLen - pierW * (bayCount + 1)) / bayCount;
    const wallThick = opts.thick || 0.36;
    const matKey = opts.material === 'brick' ? 'brick' : 'concrete';

    const bWall = bm.get(matKey, {
      texKey: matKey,
      color: matKey === 'brick' ? [0.78, 0.70, 0.64] : [0.82, 0.83, 0.82],
      roughness: 0.92,
      metalness: 0.02
    });
    const bTrim = bm.get('concrete', { texKey: 'concrete', color: [0.76, 0.76, 0.74], roughness: 0.86, metalness: 0.04 });

    // Structural columns between every bay (indestructible anchors so upper floors NEVER float!)
    for (let i = 0; i <= bayCount; i++) {
      const dist = pierW * 0.5 + i * (baySpan + pierW);
      const px = opts.x0 + ux * dist;
      const pz = opts.z0 + uz * dist;
      const sx = alongX ? pierW : wallThick + 0.14;
      const sz = alongX ? wallThick + 0.14 : pierW;
      if (bTrim) {
        bTrim.addBeveledBox(px, opts.yBase + opts.h * 0.5, pz, sx, opts.h, sz, 0.025, {
          color: [0.74, 0.74, 0.72], uvScale: 0.32, aoBottom: opts.floorIdx === 0 ? 0.58 : 0.82
        });
      }
      addStaticCol('pier', [px - sx * 0.5, opts.yBase, pz - sz * 0.5], [px + sx * 0.5, opts.yBase + opts.h, pz + sz * 0.5], {
        type: 'wall', material: 'concrete'
      });
    }

    // Build each bay
    for (let i = 0; i < bayCount; i++) {
      const bayType = bays[i];
      const dist = pierW + baySpan * 0.5 + i * (baySpan + pierW);
      const cx = opts.x0 + ux * dist;
      const cz = opts.z0 + uz * dist;
      const sx = alongX ? baySpan : wallThick;
      const sz = alongX ? wallThick : baySpan;
      const outN = opts.outNormal;

      if (bayType === 'solid') {
        if (bWall) {
          bWall.addBox(cx, opts.yBase + opts.h * 0.5, cz, sx, opts.h, sz, {
            color: [0.92, 0.90, 0.88], uvScale: 0.30, aoBottom: opts.floorIdx === 0 ? 0.62 : 0.84
          });
        }
        addStaticCol('wall', [cx - sx * 0.5, opts.yBase, cz - sz * 0.5], [cx + sx * 0.5, opts.yBase + opts.h, cz + sz * 0.5], {
          type: 'wall', material: opts.material
        });
      } else if (bayType === 'dest') {
        // Destructible exterior wall bay!
        spawnDestWall(
          [cx, opts.yBase, cz],
          [baySpan, opts.h, wallThick],
          rotY,
          opts.material,
          opts.yBase,
          opts.sectorIdx,
          outN
        );
      } else if (bayType === 'door' || bayType === 'door_open' || bayType === 'balcony_door') {
        // Doorway opening (width ~1.9m or 1.3m with door, lintel header above 2.45m)
        const doorW = bayType === 'door' ? 1.32 : Math.min(2.1, baySpan * 0.62);
        const doorH = 2.42;
        const sideW = Math.max(0.2, (baySpan - doorW) * 0.5);
        const lintelH = opts.h - doorH;

        // Lintel above door + protruding architectural doorway hood & concrete frame trim
        if (bWall) {
          bWall.addBox(cx, opts.yBase + doorH + lintelH * 0.5, cz, sx, lintelH, sz, {
            color: [0.88, 0.87, 0.84], uvScale: 0.3
          });
        }
        if (bTrim) {
          bTrim.addBeveledBox(
            cx + outN[0] * 0.11, opts.yBase + doorH + 0.12, cz + outN[2] * 0.11,
            alongX ? doorW + 0.44 : wallThick + 0.28, 0.18, alongX ? wallThick + 0.28 : doorW + 0.44,
            0.02, { color: [0.72, 0.71, 0.68], uvScale: 0.45, aoBottom: 0.62 }
          );
        }
        addStaticCol('lintel', [cx - sx * 0.5, opts.yBase + doorH, cz - sz * 0.5], [cx + sx * 0.5, opts.yBase + opts.h, cz + sz * 0.5], {
          type: 'wall', material: opts.material
        });

        // Side jamb walls flanking doorway
        for (const sgn of [-1, 1]) {
          const offset = (doorW + sideW) * 0.5 * sgn;
          const jx = cx + ux * offset;
          const jz = cz + uz * offset;
          const jsx = alongX ? sideW : wallThick;
          const jsz = alongX ? wallThick : sideW;
          if (bWall) {
            bWall.addBox(jx, opts.yBase + doorH * 0.5, jz, jsx, doorH, jsz, {
              color: [0.90, 0.89, 0.86], uvScale: 0.3, aoBottom: opts.floorIdx === 0 ? 0.62 : 0.84
            });
          }
          addStaticCol('jamb', [jx - jsx * 0.5, opts.yBase, jz - jsz * 0.5], [jx + jsx * 0.5, opts.yBase + doorH, jz + jsz * 0.5], {
            type: 'wall', material: opts.material
          });
        }

        // Ground-floor concrete entry threshold step so street -> Y=0.25 feels grounded & crisp
        if (opts.floorIdx === 0 && bTrim) {
          const stepX = cx + outN[0] * 0.52;
          const stepZ = cz + outN[2] * 0.52;
          const stW = alongX ? doorW + 0.5 : 0.82;
          const stD = alongX ? 0.82 : doorW + 0.5;
          bTrim.addBeveledBox(stepX, 0.02, stepZ, stW, 0.22, stD, 0.025, {
            color: [0.76, 0.75, 0.72], uvScale: 0.4, aoBottom: 0.6
          });
        }

        if (bayType === 'door') {
          spawnDoor([cx, opts.yBase, cz], rotY, opts.yBase);
        }

        // Protruding exterior balcony attached to Floor 2 balcony_door bay!
        if (bayType === 'balcony_door' && opts.floorIdx === 1) {
          buildBalcony(bm, cx, opts.yBase, cz, baySpan + 0.3, 2.25, outN, rotY, opts.sectorIdx);
        }
      } else if (bayType === 'win' || bayType === 'win_open') {
        // Window bay: waist-high sill wall (1.02m) + open 1.56m aperture + lintel (0.77m)
        const sillH = 1.02;
        const winH = 1.56;
        const lintelH = opts.h - sillH - winH;
        const winW = Math.min(2.2, baySpan * 0.68);
        const sideW = Math.max(0.15, (baySpan - winW) * 0.5);

        // Sill wall (solid waist cover!)
        if (bWall) {
          bWall.addBox(cx, opts.yBase + sillH * 0.5, cz, sx, sillH, sz, {
            color: [0.88, 0.87, 0.84], uvScale: 0.3, aoBottom: opts.floorIdx === 0 ? 0.62 : 0.84
          });
        }
        // Deep protruding beveled concrete window sill ledge (+0.13m overhang catching dusk light & casting shadow!)
        if (bTrim) {
          bTrim.addBeveledBox(
            cx + outN[0] * 0.09, opts.yBase + sillH + 0.035, cz + outN[2] * 0.09,
            alongX ? winW + 0.34 : wallThick + 0.24, 0.11, alongX ? wallThick + 0.24 : winW + 0.34,
            0.018, { color: [0.76, 0.75, 0.72], uvScale: 0.5, aoBottom: 0.68 }
          );
          // Deep protruding concrete top lintel hood above window aperture (casts crisp horizontal shadow!)
          bTrim.addBeveledBox(
            cx + outN[0] * 0.08, opts.yBase + sillH + winH + 0.10, cz + outN[2] * 0.08,
            alongX ? winW + 0.38 : wallThick + 0.22, 0.18, alongX ? wallThick + 0.22 : winW + 0.38,
            0.018, { color: [0.72, 0.71, 0.69], uvScale: 0.45, aoBottom: 0.64 }
          );
        }
        // Recessed 3D dark casement outer window frame (top/bottom/left/right jamb rails recessed inside wall!)
        const bFrame = bm.get('metal_dark', { texKey: 'metal_dark', color: [0.22, 0.23, 0.25], roughness: 0.78, metalness: 0.25 });
        if (bFrame) {
          const fT = 0.08;
          const fDepth = Math.max(0.14, wallThick * 0.62);
          // Bottom & top casement bars
          bFrame.addBox(cx, opts.yBase + sillH + fT * 0.5, cz, alongX ? winW : fDepth, fT, alongX ? fDepth : winW, { color: [0.24, 0.24, 0.25] });
          bFrame.addBox(cx, opts.yBase + sillH + winH - fT * 0.5, cz, alongX ? winW : fDepth, fT, alongX ? fDepth : winW, { color: [0.24, 0.24, 0.25] });
          // Left & right casement jamb bars
          for (const sgn of [-1, 1]) {
            const jOff = (winW * 0.5 - fT * 0.5) * sgn;
            bFrame.addBox(cx + ux * jOff, opts.yBase + sillH + winH * 0.5, cz + uz * jOff, alongX ? fT : fDepth, winH, alongX ? fDepth : fT, { color: [0.24, 0.24, 0.25] });
          }
          // Broken stub mullion on blown-out windows for authentic war-damaged silhouette
          if (bayType === 'win_open') {
            bFrame.addBox(cx - ux * 0.08, opts.yBase + sillH + winH * 0.76, cz - uz * 0.08, alongX ? 0.06 : 0.10, winH * 0.46, alongX ? 0.10 : 0.06, { color: [0.26, 0.24, 0.22] });
          }
        }
        addStaticCol('sill', [cx - sx * 0.5, opts.yBase, cz - sz * 0.5], [cx + sx * 0.5, opts.yBase + sillH, cz + sz * 0.5], {
          type: 'cover', material: opts.material
        });

        // Lintel above window
        if (bWall) {
          bWall.addBox(cx, opts.yBase + sillH + winH + lintelH * 0.5, cz, sx, lintelH, sz, {
            color: [0.88, 0.87, 0.84], uvScale: 0.3
          });
        }
        addStaticCol('wlintel', [cx - sx * 0.5, opts.yBase + sillH + winH, cz - sz * 0.5], [cx + sx * 0.5, opts.yBase + opts.h, cz + sz * 0.5], {
          type: 'wall', material: opts.material
        });

        // Side mullions
        for (const sgn of [-1, 1]) {
          const offset = (winW + sideW) * 0.5 * sgn;
          const mx = cx + ux * offset;
          const mz = cz + uz * offset;
          const msx = alongX ? sideW : wallThick;
          const msz = alongX ? wallThick : sideW;
          if (bWall) {
            bWall.addBox(mx, opts.yBase + sillH + winH * 0.5, mz, msx, winH, msz, {
              color: [0.88, 0.87, 0.84], uvScale: 0.3
            });
          }
          addStaticCol('wmull', [mx - msx * 0.5, opts.yBase + sillH, mz - msz * 0.5], [mx + msx * 0.5, opts.yBase + sillH + winH, mz + msz * 0.5], {
            type: 'wall', material: opts.material
          });
        }

        // Breakable glass pane on intact windows
        let glassPiece = null;
        if (bayType === 'win') {
          glassPiece = spawnWindowGlass([cx, opts.yBase + sillH, cz], winW, winH, rotY, opts.yBase);
        }

        // Register vaultable large window portal (W + Space mantle in/out, auto-shatters intact glass!)
        if (winW >= 1.15 && winH >= 1.15) {
          vaultWindows.push({
            id: 'vault_win_' + vaultWindows.length,
            cx,
            cz,
            yBase: opts.yBase,
            sillY: opts.yBase + sillH,
            lintelY: opts.yBase + sillH + winH,
            winW,
            winH,
            wallThick,
            nx: outN[0],
            nz: outN[2],
            tx: ux,
            tz: uz,
            floorIdx: opts.floorIdx || 0,
            glassId: glassPiece ? glassPiece.id : null
          });
        }

        // Register high-value tactical Cover Node right inside the window looking outward!
        addCover(
          [cx - outN[0] * 0.95, opts.yBase, cz - outN[2] * 0.95],
          outN,
          1.08,
          opts.sectorIdx,
          opts.floorIdx >= 1 ? 'UA' : null,
          null
        );
      }
    }
  }

  function buildBalcony(bm, cx, floorY, cz, width, depth, outN, rotY, sectorIdx) {
    const bConc = bm.get('concrete', { texKey: 'concrete', color: [0.78, 0.77, 0.74], roughness: 0.86, metalness: 0.04 });
    const alongX = Math.abs(outN[2]) > 0.5;
    const bx = cx + outN[0] * (depth * 0.5 + 0.14);
    const bz = cz + outN[2] * (depth * 0.5 + 0.14);
    const sx = alongX ? width : depth;
    const sz = alongX ? depth : width;

    // Concrete balcony floor slab flush with Floor 2 (Y = 3.85) + cantilever support brackets underneath
    if (bConc) {
      bConc.addBeveledBox(bx, floorY - 0.11, bz, sx, 0.22, sz, 0.02, {
        color: [0.76, 0.75, 0.72], uvScale: 0.35
      });
      // Cantilever beams underneath
      for (const sgn of [-0.36, 0.36]) {
        const kx = alongX ? bx + width * sgn : bx;
        const kz = alongX ? bz : bz + width * sgn;
        bConc.addBox(kx, floorY - 0.30, kz, alongX ? 0.22 : depth * 0.85, 0.24, alongX ? depth * 0.85 : 0.22, {
          color: [0.64, 0.63, 0.60], uvScale: 0.4
        });
      }
    }
    addStaticCol('balcony_floor', [bx - sx * 0.5, floorY - 0.24, bz - sz * 0.5], [bx + sx * 0.5, floorY, bz + sz * 0.5], {
      type: 'floor', material: 'concrete'
    });

    // Destructible front parapet railing facing the street!
    const fx = cx + outN[0] * (depth + 0.04);
    const fz = cz + outN[2] * (depth + 0.04);
    spawnDestWall(
      [fx, floorY, fz],
      [width, 1.08, 0.20],
      rotY,
      'concrete',
      floorY,
      sectorIdx,
      outN
    );

    // Side end railings (static metal/concrete stubs)
    for (const sgn of [-1, 1]) {
      const ex = alongX ? bx + sgn * (width * 0.5 - 0.09) : bx;
      const ez = alongX ? bz : bz + sgn * (width * 0.5 - 0.09);
      const esx = alongX ? 0.18 : depth;
      const esz = alongX ? depth : 0.18;
      if (bConc) {
        bConc.addBox(ex, floorY + 0.52, ez, esx, 1.04, esz, { color: [0.74, 0.73, 0.70], uvScale: 0.4 });
      }
      addStaticCol('balc_side', [ex - esx * 0.5, floorY, ez - esz * 0.5], [ex + esx * 0.5, floorY + 1.04, ez + esz * 0.5], {
        type: 'cover', material: 'concrete'
      });
    }
  }

  // Ruined Soviet 3rd-5th story upper architecture + artillery damage scars + bent exposed roof rebar!
  function buildRuinedUpperStories(bm, bCfg) {
    const { x0, x1, z0, z1, material, upperTopY, seed } = bCfg;
    const rng = mulberry32(seed || 9001);
    const matKey = material === 'brick' ? 'brick' : 'concrete';
    const bWall = bm.get(matKey, {
      texKey: matKey,
      color: matKey === 'brick' ? [0.78, 0.70, 0.64] : [0.80, 0.81, 0.80],
      roughness: 0.92,
      metalness: 0.02
    });
    const bConc = bm.get('concrete', { texKey: 'concrete', color: [0.78, 0.77, 0.74], roughness: 0.90, metalness: 0.03 });
    const bDmg = bm.get('concrete_damaged', { texKey: 'concrete_damaged', color: [0.74, 0.73, 0.70], roughness: 0.95, metalness: 0.02 });
    const bDark = bm.get('metal_dark', { texKey: 'metal_dark', color: [0.18, 0.19, 0.21], roughness: 0.78, metalness: 0.35 });
    const bRebar = bm.get('metal_rust', { texKey: 'metal_rust', color: [0.46, 0.36, 0.30], roughness: 0.78, metalness: 0.62 });

    const w = x1 - x0;
    const d = z1 - z0;
    const cx = (x0 + x1) * 0.5;
    const cz = (z0 + z1) * 0.5;
    const baseY = 7.45;
    const upperH = Math.max(3.6, upperTopY - baseY);

    // Non-enterable ceiling slab at Y = 7.20..7.45 capping Floor 2
    if (bDmg) {
      bDmg.addBox(cx, 7.32, cz, w + 0.25, 0.26, d + 0.25, { color: [0.70, 0.70, 0.68], uvScale: 0.28 });
    }
    addStaticCol('roof_cap', [x0, 7.20, z0], [x1, 7.45, z1], { type: 'floor', material: 'concrete' });

    // Belt course horizontal cornice trim at Floor 2 and Floor 3 seams
    if (bConc) {
      bConc.addBox(cx, 3.74, cz, w + 0.34, 0.26, d + 0.34, { color: [0.70, 0.70, 0.68], uvScale: 0.3 });
      bConc.addBox(cx, 7.36, cz, w + 0.38, 0.28, d + 0.38, { color: [0.70, 0.70, 0.68], uvScale: 0.3 });
    }

    // Divide upper facade into 4 architectural bays along X with staggered artillery-sheared heights
    const segs = 4;
    const segW = w / segs;
    for (let i = 0; i < segs; i++) {
      const sx0 = x0 + i * segW;
      const sx1 = sx0 + segW;
      const scx = (sx0 + sx1) * 0.5;
      // Dramatic artillery blast notch on one upper bay (or lower West bay for Building 2 camera clearance!)
      let bayH = upperH;
      const isShearedBay = (bCfg.shearedWest && i <= 1) || (i === (seed % segs));
      if (bCfg.shearedWest && i <= 1) {
        bayH = Math.min(upperH, 5.4 - i * 0.35); // Keeps West end under Y=13.0m!
      } else if (i === (seed % segs)) {
        bayH = upperH * 0.62; // Shell-blasted notch!
      } else {
        bayH = upperH * (0.88 + rng() * 0.12);
      }

      const roofY = baseY + bayH;

      if (bWall) {
        bWall.addBox(scx, baseY + bayH * 0.5, cz, segW - 0.06, bayH, d, {
          color: [0.84 + rng() * 0.07, 0.82 + rng() * 0.07, 0.80 + rng() * 0.06],
          uvScale: 0.26
        });
      }

      // Recessed 3D Architectural Windows on Upper Stories (deep dark interior backing + 3D side reveals + mullions + concrete lintels & sills!)
      if (bDark && bConc) {
        const winW = segW * 0.34;
        const winH = 1.60;
        for (let wy = baseY + 1.55; wy < roofY - 1.15; wy += 3.4) {
          for (const zSign of [-1, 1]) {
            const wallFaceZ = cz + zSign * (d * 0.5);
            for (const xMul of [-0.22, 0.22]) {
              const wx = scx + segW * xMul;
              // 1. Deep shadowed charred interior backing cavity
              bDark.addBox(wx, wy, wallFaceZ + zSign * 0.015, winW, winH, 0.04, { color: [0.04, 0.05, 0.07] });
              // 2. Protruding 3D concrete surround (top lintel hood + bottom sloped sill + left/right depth reveals casting shadows!)
              bConc.addBeveledBox(wx, wy + winH * 0.5 + 0.11, wallFaceZ + zSign * 0.09, winW + 0.32, 0.18, 0.22, 0.018, {
                color: [0.70, 0.70, 0.68], uvScale: 0.45, aoBottom: 0.62
              });
              bConc.addBeveledBox(wx, wy - winH * 0.5 - 0.07, wallFaceZ + zSign * 0.11, winW + 0.28, 0.12, 0.24, 0.016, {
                color: [0.74, 0.73, 0.70], uvScale: 0.45, aoBottom: 0.65
              });
              for (const sgn of [-1, 1]) {
                bConc.addBox(wx + sgn * (winW * 0.5 + 0.07), wy, wallFaceZ + zSign * 0.06, 0.14, winH + 0.06, 0.15, {
                  color: [0.68, 0.68, 0.66], uvScale: 0.45
                });
              }
              // 3. Recessed 3D window casement mullions (partially broken on sheared bays for war-torn authenticity)
              const mullZ = wallFaceZ + zSign * 0.05;
              bDark.addBox(wx, wy + winH * 0.14, mullZ, winW - 0.04, 0.06, 0.06, { color: [0.22, 0.22, 0.24] });
              if (!isShearedBay || rng() > 0.35) {
                bDark.addBox(wx, wy, mullZ, 0.06, winH - 0.04, 0.06, { color: [0.22, 0.22, 0.24] });
              }
            }
          }
        }
      }

      // Authentic Soviet Rooftop Silhouette: weathered concrete deck + raised beveled parapet rims!
      if (bConc && bDmg) {
        bDmg.addBox(scx, roofY + 0.12, cz, segW - 0.10, 0.26, d - 0.10, {
          color: [0.64, 0.63, 0.61], uvScale: 0.28
        });
        const paraH = isShearedBay ? 0.38 : 0.72;
        const paraT = 0.36;
        // North & South parapet coping walls
        bConc.addBeveledBox(scx, roofY + 0.24 + paraH * 0.5, z0 + paraT * 0.5, segW - 0.06, paraH, paraT, 0.03, {
          color: [0.74, 0.73, 0.70], uvScale: 0.35, aoBottom: 0.72
        });
        bConc.addBeveledBox(scx, roofY + 0.24 + paraH * 0.5, z1 - paraT * 0.5, segW - 0.06, paraH, paraT, 0.03, {
          color: [0.74, 0.73, 0.70], uvScale: 0.35, aoBottom: 0.72
        });
        // End parapet walls on outer West/East bays
        if (i === 0) {
          bConc.addBeveledBox(x0 + paraT * 0.5, roofY + 0.24 + paraH * 0.5, cz, paraT, paraH, d, 0.03, {
            color: [0.74, 0.73, 0.70], uvScale: 0.35, aoBottom: 0.72
          });
        }
        if (i === segs - 1) {
          bConc.addBeveledBox(x1 - paraT * 0.5, roofY + 0.24 + paraH * 0.5, cz, paraT, paraH, d, 0.03, {
            color: [0.74, 0.73, 0.70], uvScale: 0.35, aoBottom: 0.72
          });
        }
      }

      // Soviet rooftop infrastructure: elevator machine-room penthouse hut, brick vent stacks, HVAC boxes & TV Yagi antennas!
      if (!bCfg.shearedWest || i >= 2) {
        if (i === 1 || i === 2) {
          if (i === (seed % 2 === 0 ? 1 : 2) && bConc && bDark && bRebar) {
            // Iconic Khrushchyovka precast elevator / stairwell penthouse hut
            const hutW = Math.min(3.8, segW * 0.62);
            const hutD = 4.2;
            const hutH = 2.45;
            const hz = cz - d * 0.14;
            bConc.addBeveledBox(scx, roofY + 0.24 + hutH * 0.5, hz, hutW, hutH, hutD, 0.04, {
              color: [0.72, 0.71, 0.69], uvScale: 0.35, aoBottom: 0.62
            });
            // Overhanging flat cap slab on elevator hut
            bConc.addBeveledBox(scx, roofY + 0.24 + hutH + 0.12, hz, hutW + 0.36, 0.22, hutD + 0.36, 0.03, {
              color: [0.64, 0.63, 0.61], uvScale: 0.35
            });
            // Steel roof-access door & louver grill
            bDark.addBox(scx, roofY + 1.15, hz + hutD * 0.5 + 0.04, 1.0, 1.85, 0.08, { color: [0.24, 0.25, 0.27] });
            bRebar.addBox(scx + hutW * 0.5 + 0.05, roofY + 1.8, hz, 0.10, 0.65, 1.2, { color: [0.36, 0.34, 0.32] });
          } else if (bRebar && bDark) {
            // Galvanized HVAC chiller & ventilation duct box + Soviet Yagi TV aerial mast
            const hx = scx + (rng() - 0.5) * 1.0;
            const hz = cz + d * 0.18;
            bRebar.addBeveledBox(hx, roofY + 0.85, hz, 2.2, 1.25, 1.5, 0.03, {
              color: [0.56, 0.58, 0.58], uvScale: 0.5, aoBottom: 0.62
            });
            bDark.addBox(hx, roofY + 0.88, hz + 0.77, 1.5, 0.72, 0.06, { color: [0.18, 0.20, 0.22] });
            // Tall TV antenna mast with horizontal dipole elements
            const ax = scx - segW * 0.22;
            const az = cz - d * 0.28;
            bDark.addCylinder(ax, roofY + 2.4, az, 0.035, 0.055, 4.4, 6, { color: [0.32, 0.34, 0.36] });
            bDark.addBox(ax, roofY + 4.2, az, 1.9, 0.04, 0.04, { color: [0.38, 0.40, 0.42] });
            bDark.addBox(ax, roofY + 3.6, az, 1.3, 0.04, 0.04, { color: [0.38, 0.40, 0.42], rotY: 0.45 });
            bDark.addBox(ax, roofY + 3.1, az, 0.04, 0.04, 1.4, { color: [0.38, 0.40, 0.42] });
          }
        } else if (bWall && bConc) {
          // Soviet ventilation chimney shaft stack
          const vx = scx;
          const vz = cz + (i === 0 ? -d * 0.20 : d * 0.20);
          bWall.addBeveledBox(vx, roofY + 1.05, vz, 1.45, 1.75, 1.15, 0.03, {
            color: [0.72, 0.68, 0.64], uvScale: 0.45, aoBottom: 0.65
          });
          bConc.addBox(vx, roofY + 2.02, vz, 1.65, 0.16, 1.35, { color: [0.64, 0.63, 0.61] });
        }
      }

      // Exposed bent rebar only on shell-sheared roof notches
      if (bRebar && isShearedBay) {
        for (let r = 0; r < 3; r++) {
          const rx = scx + (rng() - 0.5) * segW * 0.65;
          const rz = cz + (rng() - 0.5) * d * 0.72;
          const topY = roofY + 0.22;
          bRebar.addTube([
            [rx, topY, rz],
            [rx + (rng() - 0.5) * 0.35, topY + 0.65 + rng() * 0.45, rz + (rng() - 0.5) * 0.35],
            [rx + (rng() - 0.5) * 0.75, topY + 1.05 + rng() * 0.55, rz + (rng() - 0.5) * 0.75]
          ], 0.022, 5, { color: [0.34, 0.26, 0.22] });
        }
      }
    }

    // Blocking collider for upper inaccessible mass so drones/shells collide solidly with upper stories!
    addStaticCol('upper_mass', [x0, baseY, z0], [x1, baseY + upperH * 0.85, z1], {
      type: 'wall', material: material
    });
  }

  // ---- Build Standard Khrushchyovka Enterable Apartment Block ----
  function buildApartmentBuilding(bm, cfg) {
    const { x0, x1, z0, z1, material, sectorIdx, faceDir, stairs, upperTopY, seed, shearedWest } = cfg;
    const bConc = bm.get('concrete', { texKey: 'concrete', color: [0.80, 0.79, 0.76], roughness: 0.88, metalness: 0.04 });
    const bWood = bm.get('wood', { texKey: 'wood', color: [0.66, 0.54, 0.40], roughness: 0.84, metalness: 0.05 });

    const cx = (x0 + x1) * 0.5;
    const cz = (z0 + z1) * 0.5;
    const w = x1 - x0;
    const d = z1 - z0;

    // 1. Ground Floor 1 slab (Y = -0.15..+0.25, exact top Y = 0.25m, zero floating!)
    addSlabsAroundCutouts(bConc, x0, x1, z0, z1, -0.15, 0.25, [], 'f1_slab', [0.74, 0.73, 0.70]);

    // 2. Floor 2 slab (Y = 3.60..3.85) with generously EXPANDED cutouts over every stairwell (zero clipping!)
    const f2Cutouts = stairs.map((st) => computeStairCutout(st));
    addSlabsAroundCutouts(bConc, x0, x1, z0, z1, 3.60, 3.85, f2Cutouts, 'f2_slab', [0.76, 0.75, 0.72]);

    // 3. Build Staircases (F1 -> F2)
    for (let i = 0; i < stairs.length; i++) {
      addInteriorStaircase(bm, stairs[i]);
    }

    // 4. Exterior Facade Walls (Floor 1 Y=0.25..3.60 & Floor 2 Y=3.85..7.20)
    const streetIsSouth = faceDir === '+z'; // North buildings face +Z (South toward avenue)
    const southBaysF1 = streetIsSouth ? ['win_open', 'dest', 'door_open', 'win', 'dest'] : ['solid', 'win', 'door_open', 'win_open', 'solid'];
    const northBaysF1 = !streetIsSouth ? ['win_open', 'dest', 'door_open', 'win', 'dest'] : ['solid', 'win', 'door_open', 'win_open', 'solid'];
    const southBaysF2 = streetIsSouth ? ['win_open', 'balcony_door', 'win', 'balcony_door', 'win_open'] : ['solid', 'win', 'dest', 'win', 'solid'];
    const northBaysF2 = !streetIsSouth ? ['win_open', 'balcony_door', 'win', 'balcony_door', 'win_open'] : ['solid', 'win', 'dest', 'win', 'solid'];

    // South exterior wall (Z = z1)
    buildWallFacadeLine(bm, { x0, z0: z1, x1, z1, yBase: 0.25, h: 3.35, thick: 0.36, bays: southBaysF1, material, sectorIdx, outNormal: [0, 0, 1], floorIdx: 0 });
    buildWallFacadeLine(bm, { x0, z0: z1, x1, z1, yBase: 3.85, h: 3.35, thick: 0.36, bays: southBaysF2, material, sectorIdx, outNormal: [0, 0, 1], floorIdx: 1 });

    // North exterior wall (Z = z0)
    buildWallFacadeLine(bm, { x0, z0, x1, z1: z0, yBase: 0.25, h: 3.35, thick: 0.36, bays: northBaysF1, material, sectorIdx, outNormal: [0, 0, -1], floorIdx: 0 });
    buildWallFacadeLine(bm, { x0, z0, x1, z1: z0, yBase: 3.85, h: 3.35, thick: 0.36, bays: northBaysF2, material, sectorIdx, outNormal: [0, 0, -1], floorIdx: 1 });

    // West exterior wall (X = x0) — facing approaching attackers!
    buildWallFacadeLine(bm, { x0, z0, x1: x0, z1, yBase: 0.25, h: 3.35, thick: 0.36, bays: ['dest', 'door_open', 'win_open'], material, sectorIdx, outNormal: [-1, 0, 0], floorIdx: 0 });
    buildWallFacadeLine(bm, { x0, z0, x1: x0, z1, yBase: 3.85, h: 3.35, thick: 0.36, bays: ['win_open', 'dest', 'win'], material, sectorIdx, outNormal: [-1, 0, 0], floorIdx: 1 });

    // East exterior wall (X = x1) — defender flank/withdrawal side
    buildWallFacadeLine(bm, { x0: x1, z0, x1, z1, yBase: 0.25, h: 3.35, thick: 0.36, bays: ['win', 'door', 'dest'], material, sectorIdx, outNormal: [1, 0, 0], floorIdx: 0 });
    buildWallFacadeLine(bm, { x0: x1, z0, x1, z1, yBase: 3.85, h: 3.35, thick: 0.36, bays: ['win', 'dest', 'win_open'], material, sectorIdx, outNormal: [1, 0, 0], floorIdx: 1 });

    // 5. Interior Rooms, Destructible Plaster Partitions, Pillars, Ceiling Beams, Radiators & War-Torn Apartment Furniture (kept >=2.0m clear of ALL stairwells!)
    const partX1 = x0 + w * 0.34;
    const partX2 = x0 + w * 0.66;
    // On accessibleRoof buildings (B5), keep roomZ cleanly South toward street so Stair 2 (F2->Roof) has wide open landings!
    const roomZ = cfg.accessibleRoof
      ? (z1 - 4.2)
      : (streetIsSouth ? (z0 + d * 0.62) : (z0 + d * 0.38));

    // Interior destructible plaster partition walls on Floor 1 & Floor 2 (leaving wide CQB passageways & clear stairwell landings!)
    spawnDestWall([partX1, 0.25, roomZ], [3.6, 3.35, 0.22], Math.PI * 0.5, 'plaster', 0.25, sectorIdx, [-1, 0, 0]);
    spawnDestWall([partX2, 0.25, roomZ], [3.6, 3.35, 0.22], Math.PI * 0.5, 'plaster', 0.25, sectorIdx, [-1, 0, 0]);
    if (!cfg.accessibleRoof) {
      spawnDestWall([partX1, 3.85, roomZ], [3.6, 3.35, 0.22], Math.PI * 0.5, 'plaster', 3.85, sectorIdx, [-1, 0, 0]);
    }

    const bDarkInt = bm.get('metal_dark', { texKey: 'metal_dark', color: [0.28, 0.30, 0.32], roughness: 0.64, metalness: 0.62 });
    const bDmgInt = bm.get('concrete_damaged', { texKey: 'concrete_damaged', color: [0.64, 0.62, 0.59], roughness: 0.96, metalness: 0.0 });
    const bSandInt = bm.get('sandbag', { texKey: 'sandbag', color: [0.80, 0.75, 0.64], roughness: 0.96, metalness: 0.0 });
    const bCouch = bm.get('plaster', { texKey: 'plaster', color: [0.54, 0.42, 0.36], roughness: 0.95, metalness: 0.0 });
    const rngInt = mulberry32((seed || 100) * 13 + 7);

    // Helper: check if (px, pz) on floorIdx is strictly outside every stairwell + landing buffer (>= 2.1m clearance!)
    const isClearOfStairs = (px, pz, floorIdx) => {
      const checkSt = (st) => {
        if (!st) return true;
        const cut = computeStairCutout(st);
        const pad = 1.9;
        return px < cut.x0 - pad || px > cut.x1 + pad || pz < cut.z0 - pad || pz > cut.z1 + pad;
      };
      for (let k = 0; k < stairs.length; k++) {
        if (!checkSt(stairs[k])) return false;
      }
      if (floorIdx >= 1 && cfg.roofStair && !checkSt(cfg.roofStair)) return false;
      return true;
    };

    // Furnish Floor 1 (Y=0.25) and Floor 2 (Y=3.85) with lived-in Soviet apartment/office micro-detail!
    const streetWallZ = streetIsSouth ? z1 - 0.52 : z0 + 0.52;
    const backWallZ = streetIsSouth ? z0 + 0.62 : z1 - 0.62;
    const inwardSign = streetIsSouth ? -1 : 1;

    for (let fIdx = 0; fIdx < 2; fIdx++) {
      const py = fIdx === 0 ? 0.25 : 3.85;
      const ceilY = py + 3.35;

      // 1. Structural Concrete Ceiling Beams (clear of stairwell cutouts) + Hanging Broken Tilted Fluorescent Fixtures!
      if (bConc && bDarkInt) {
        const beamXs = [x0 + w * 0.25, x0 + w * 0.50, x0 + w * 0.75];
        for (let b = 0; b < beamXs.length; b++) {
          const bx = beamXs[b];
          const bzSpan = d * 0.52;
          const bcz = streetIsSouth ? (z1 - bzSpan * 0.5 - 0.2) : (z0 + bzSpan * 0.5 + 0.2);
          bConc.addBox(bx, ceilY - 0.14, bcz, 0.34, 0.28, bzSpan, { color: [0.68, 0.67, 0.65], uvScale: 0.4 });
          // Hanging tilted broken Soviet twin-tube fluorescent light fixture suspended from beam
          if (b !== 1 || fIdx === 0) {
            const tilt = (rngInt() - 0.5) * 0.26;
            bDarkInt.addCylinder(bx - 0.45, ceilY - 0.34, bcz, 0.012, 0.012, 0.36, 4, { color: [0.36, 0.38, 0.40] });
            bDarkInt.addCylinder(bx + 0.45, ceilY - 0.38, bcz, 0.012, 0.012, 0.44, 4, { color: [0.36, 0.38, 0.40] });
            bDarkInt.addBeveledBox(bx, ceilY - 0.52, bcz, 1.32, 0.09, 0.22, 0.012, {
              color: [0.66, 0.67, 0.65], rotZ: tilt
            });
          }
        }
      }

      // 2. Interior Concrete Column with Plinth Base & Capital Collar
      const colX = cx;
      const colZ = roomZ;
      if (isClearOfStairs(colX, colZ, fIdx)) {
        if (bConc) {
          bConc.addBeveledBox(colX, py + 1.675, colZ, 0.52, 3.35, 0.52, 0.02, {
            color: [0.72, 0.71, 0.68], uvScale: 0.4, aoBottom: 0.62
          });
          bConc.addBeveledBox(colX, py + 0.14, colZ, 0.68, 0.28, 0.68, 0.02, { color: [0.64, 0.63, 0.61], aoBottom: 0.56 });
          bConc.addBeveledBox(colX, py + 3.22, colZ, 0.68, 0.24, 0.68, 0.02, { color: [0.68, 0.67, 0.65] });
        }
        addStaticCol('int_col', [colX - 0.26, py, colZ - 0.26], [colX + 0.26, py + 3.35, colZ + 0.26], {
          type: 'cover', material: 'concrete'
        });
        addCover([colX + 0.9, py, colZ], [-1, 0, 0], 1.8, sectorIdx, null, null);
        addCover([colX - 0.9, py, colZ], [1, 0, 0], 1.8, sectorIdx, null, null);
      }

      // 3. Cast-Iron Ribbed Soviet Wall Radiators tucked beneath street-facing windows + interior wall baseboard trim!
      if (bDarkInt && bWood) {
        const radXs = [x0 + w * 0.14, x0 + w * 0.50, x0 + w * 0.86];
        for (let r = 0; r < radXs.length; r++) {
          const rx = radXs[r];
          const rz = streetWallZ + inwardSign * 0.06;
          // 8 vertical cast-iron radiator fins + top/bottom manifold pipes
          for (let fin = -3; fin <= 3; fin++) {
            bDarkInt.addBox(rx + fin * 0.11, py + 0.44, rz, 0.045, 0.58, 0.14, { color: [0.64, 0.63, 0.60] });
          }
          bDarkInt.addCylinder(rx, py + 0.68, rz, 0.026, 0.026, 0.86, 6, { axis: 'x', color: [0.54, 0.52, 0.50] });
          bDarkInt.addCylinder(rx, py + 0.20, rz, 0.026, 0.026, 0.86, 6, { axis: 'x', color: [0.54, 0.52, 0.50] });
        }
        // Dark timber baseboards along interior street wall
        bWood.addBox(cx, py + 0.08, streetWallZ - inwardSign * 0.22, w - 1.2, 0.16, 0.06, { color: [0.42, 0.34, 0.26] });
      }

      // 4. Wooden Office Table / Overturned Desk + Broken Chairs (West room)
      const tx = cx - w * 0.22;
      const tz = roomZ;
      if (isClearOfStairs(tx, tz, fIdx)) {
        if (bWood) {
          bWood.addBeveledBox(tx, py + 0.78, tz, 1.85, 0.08, 0.95, 0.012, { color: [0.62, 0.49, 0.36], uvScale: 0.6 });
          for (const lx of [-0.82, 0.82]) {
            for (const lz of [-0.38, 0.38]) {
              bWood.addBox(tx + lx, py + 0.38, tz + lz, 0.08, 0.76, 0.08, { color: [0.50, 0.39, 0.28] });
            }
          }
          // Overturned wooden chair lying beside desk
          const chX = tx + 1.35, chZ = tz + 0.35;
          bWood.addBox(chX, py + 0.24, chZ, 0.46, 0.44, 0.06, { color: [0.56, 0.44, 0.32], rotY: 0.6, rotX: 1.35 });
          bWood.addBox(chX + 0.14, py + 0.42, chZ + 0.12, 0.46, 0.06, 0.44, { color: [0.54, 0.42, 0.30], rotY: 0.6 });
        }
        addStaticCol('table', [tx - 0.92, py, tz - 0.48], [tx + 0.92, py + 0.82, tz + 0.48], {
          type: 'cover', material: 'wood'
        });
      }

      // 5. Overturned Padded Soviet Apartment Couch / Sofa (East room, doubles as CQB crouch cover!)
      const sx = cx + w * 0.22;
      const sz = roomZ + inwardSign * 0.6;
      if (isClearOfStairs(sx, sz, fIdx)) {
        if (bCouch && bWood) {
          bCouch.addBeveledBox(sx, py + 0.30, sz, 2.05, 0.40, 0.84, 0.04, { color: [0.54, 0.40, 0.34], rotY: 0.14, aoBottom: 0.56 });
          bCouch.addBeveledBox(sx, py + 0.68, sz - inwardSign * 0.32, 2.05, 0.56, 0.24, 0.04, { color: [0.50, 0.36, 0.31], rotY: 0.14 });
          for (const arm of [-0.94, 0.94]) {
            bCouch.addBeveledBox(sx + arm, py + 0.52, sz, 0.20, 0.52, 0.82, 0.03, { color: [0.48, 0.35, 0.30], rotY: 0.14 });
          }
          bWood.addBox(sx, py + 0.08, sz, 1.92, 0.14, 0.72, { color: [0.38, 0.30, 0.24], rotY: 0.14 });
        }
        addStaticCol('couch', [sx - 1.05, py, sz - 0.46], [sx + 1.05, py + 0.92, sz + 0.46], {
          type: 'cover', material: 'wood'
        });
        addCover([sx, py, sz - inwardSign * 1.0], [0, 0, inwardSign], 0.96, sectorIdx, null, null);
      }

      // 6. Tall Soviet Wooden Wardrobe / Bookshelf & Metal Filing Cabinet against clear back/side walls!
      const shelfX = x0 + 1.5;
      const shelfZ = backWallZ;
      if (isClearOfStairs(shelfX, shelfZ, fIdx)) {
        if (bWood) {
          bWood.addBeveledBox(shelfX, py + 1.02, shelfZ, 1.48, 2.04, 0.48, 0.02, { color: [0.52, 0.40, 0.30], aoBottom: 0.56 });
          // Open recessed shelf tiers
          for (let sh = 0; sh < 4; sh++) {
            bWood.addBox(shelfX, py + 0.42 + sh * 0.44, shelfZ + inwardSign * 0.20, 1.36, 0.045, 0.16, { color: [0.64, 0.52, 0.40] });
          }
        }
        addStaticCol('shelf', [shelfX - 0.75, py, shelfZ - 0.28], [shelfX + 0.75, py + 2.05, shelfZ + 0.28], {
          type: 'cover', material: 'wood'
        });
      }
      // Battered olive-grey steel filing cabinet in opposite corner
      const cabX = x1 - 1.45;
      const cabZ = streetWallZ + inwardSign * 1.45;
      if (isClearOfStairs(cabX, cabZ, fIdx)) {
        if (bDarkInt) {
          bDarkInt.addBeveledBox(cabX, py + 0.72, cabZ, 0.54, 1.42, 0.66, 0.018, { color: [0.40, 0.44, 0.41], aoBottom: 0.58 });
          for (let dr = 0; dr < 4; dr++) {
            bDarkInt.addBox(cabX - 0.28, py + 0.24 + dr * 0.32, cabZ, 0.04, 0.26, 0.54, { color: [0.46, 0.50, 0.47] });
            bDarkInt.addBox(cabX - 0.31, py + 0.26 + dr * 0.32, cabZ, 0.03, 0.03, 0.14, { color: [0.70, 0.68, 0.64] });
          }
        }
        addStaticCol('cabinet', [cabX - 0.30, py, cabZ - 0.35], [cabX + 0.30, py + 1.44, cabZ + 0.35], {
          type: 'cover', material: 'metal'
        });
      }

      // 7. Sandbagged 2nd-Floor Sniper Window Firing Nests (gives Floor 2 fortified urban combat character!)
      if (fIdx === 1 && bSandInt) {
        for (const nx of [x0 + w * 0.16, x0 + w * 0.84]) {
          const nz = streetWallZ + inwardSign * 0.45;
          if (!isClearOfStairs(nx, nz, fIdx)) continue;
          for (let row = 0; row < 3; row++) {
            for (let bag = -1; bag <= 1; bag++) {
              bSandInt.addBeveledBox(nx + bag * 0.52, py + 0.13 + row * 0.23, nz + (bag === 0 ? 0 : inwardSign * 0.10), 0.48, 0.21, 0.30, 0.05, {
                color: [0.80 - row * 0.03, 0.75 - row * 0.03, 0.64 - row * 0.03],
                rotY: bag * -0.18 * inwardSign,
                aoBottom: row === 0 ? 0.56 : 0.78
              });
            }
          }
        }
      }

      // 8. Scattered Indoor Plaster/Brick Rubble Chunks along corners (pure visual grit, non-blocking)
      if (bDmgInt) {
        const rubSpots = [[x0 + 1.4, streetWallZ + inwardSign * 1.1], [cx + 2.2, streetWallZ + inwardSign * 0.9]];
        for (let r = 0; r < rubSpots.length; r++) {
          const rx = rubSpots[r][0], rz = rubSpots[r][1];
          for (let k = 0; k < 4; k++) {
            const sxr = 0.18 + rngInt() * 0.24, syr = 0.07 + rngInt() * 0.11, szr = 0.16 + rngInt() * 0.22;
            bDmgInt.addBox(rx + (rngInt() - 0.5) * 0.9, py + syr * 0.45, rz + (rngInt() - 0.5) * 0.7, sxr, syr, szr, {
              color: [0.58, 0.56, 0.53], rotY: rngInt() * 3.14, aoBottom: 0.62
            });
          }
        }
      }
    }

    // Subtle warm interior emergency hallway lamps on F1 and F2 (keeps rooms & stairs crisp and readable!)
    interiorLights.push({
      pos: [cx, 3.15, cz],
      color: [1.0, 0.76, 0.44],
      intensity: 2.5,
      radius: 13.5
    });

    // 6. Upper Ruined 3rd-5th Story Facade (or Accessible Roof Deck if cfg.accessibleRoof!)
    if (cfg.accessibleRoof) {
      buildAccessibleRoofDeck(bm, cfg);
    } else {
      buildRuinedUpperStories(bm, { x0, x1, z0, z1, material, upperTopY: upperTopY || 16.5, seed, shearedWest });
    }
  }

  // ---- Accessible Rooftop Parapet Deck (Y = 7.45m) for Building 5 & Sector C Command HQ ----
  function buildAccessibleRoofDeck(bm, cfg) {
    const { x0, x1, z0, z1, roofStair, sectorIdx, isHQ } = cfg;
    const bConc = bm.get('concrete', { texKey: 'concrete', color: [0.78, 0.77, 0.75], roughness: 0.88, metalness: 0.04 });
    const bMetal = bm.get('metal_rust', { texKey: 'metal_rust', color: [0.46, 0.40, 0.36], roughness: 0.72, metalness: 0.65 });

    // Roof floor slab (Y = 7.20..7.45) with generously EXPANDED cutout over roofStair (zero clipping!)
    const cut = computeStairCutout(roofStair);
    addSlabsAroundCutouts(bConc, x0, x1, z0, z1, 7.20, 7.45, [cut], 'roof_slab', [0.70, 0.70, 0.68]);

    // Build F2 -> Roof staircase
    addInteriorStaircase(bm, roofStair);

    // Rooftop perimeter parapets (1.12m tall waist cover — West facing panels destructible!)
    const w = x1 - x0;
    const d = z1 - z0;
    const yR = 7.45;

    // West sniper parapet (destructible panels overlooking the battlefield!)
    const westSegs = Math.max(2, Math.floor(d / 4.2));
    const westStep = d / westSegs;
    for (let i = 0; i < westSegs; i++) {
      const pz = z0 + (i + 0.5) * westStep;
      spawnDestWall([x0 + 0.14, yR, pz], [westStep - 0.28, 1.12, 0.22], Math.PI * 0.5, 'concrete', yR, sectorIdx, [-1, 0, 0]);
    }
    // North, South, East solid concrete roof parapets
    if (bConc) {
      bConc.addBeveledBox((x0 + x1) * 0.5, yR + 0.56, z0 + 0.14, w, 1.12, 0.26, 0.02, { color: [0.76, 0.75, 0.72], uvScale: 0.35, aoBottom: 0.7 });
      bConc.addBeveledBox((x0 + x1) * 0.5, yR + 0.56, z1 - 0.14, w, 1.12, 0.26, 0.02, { color: [0.76, 0.75, 0.72], uvScale: 0.35, aoBottom: 0.7 });
      bConc.addBeveledBox(x1 - 0.14, yR + 0.56, (z0 + z1) * 0.5, 0.26, 1.12, d, 0.02, { color: [0.76, 0.75, 0.72], uvScale: 0.35, aoBottom: 0.7 });
    }
    addStaticCol('rpara_n', [x0, yR, z0], [x1, yR + 1.12, z0 + 0.28], { type: 'cover', material: 'concrete' });
    addStaticCol('rpara_s', [x0, yR, z1 - 0.28], [x1, yR + 1.12, z1], { type: 'cover', material: 'concrete' });
    addStaticCol('rpara_e', [x1 - 0.28, yR, z0], [x1, yR + 1.12, z1], { type: 'cover', material: 'concrete' });

    // Rooftop elevated cover nodes for snipers/AT defenders
    addCover([x0 + 1.1, yR, (z0 + z1) * 0.5], [-1, 0, 0], 1.12, sectorIdx, 'UA', null);
    addCover([x0 + 1.1, yR, z0 + 3.0], [-1, 0, -0.3], 1.12, sectorIdx, 'UA', null);
    addCover([x0 + 1.1, yR, z1 - 3.0], [-1, 0, 0.3], 1.12, sectorIdx, 'UA', null);

    // Rooftop HVAC vent units & radio communications mast (placed cleanly clear of roofStair cutout!)
    if (bMetal) {
      const hx = isHQ ? (x0 + w * 0.42) : (x0 + 3.2);
      const hz = isHQ ? (z0 + d * 0.30) : (z1 - 3.0);
      bMetal.addBeveledBox(hx, yR + 0.65, hz, 2.2, 1.3, 1.6, 0.03, { color: [0.56, 0.58, 0.56], uvScale: 0.5, aoBottom: 0.6 });
      addStaticCol('hvac', [hx - 1.1, yR, hz - 0.8], [hx + 1.1, yR + 1.3, hz + 0.8], { type: 'cover', material: 'metal' });

      if (isHQ) {
        // Tall Sector C HQ Communications Antenna Mast + radar dish
        const mx = x1 - 3.0;
        const mz = z1 - 3.0;
        bMetal.addCylinder(mx, yR + 4.2, mz, 0.08, 0.22, 8.4, 8, { color: [0.46, 0.44, 0.42] });
        bMetal.addBox(mx, yR + 7.2, mz, 2.6, 0.12, 0.12, { color: [0.54, 0.52, 0.50] });
        bMetal.addBox(mx, yR + 6.0, mz, 0.12, 0.12, 2.2, { color: [0.54, 0.52, 0.50] });
        bMetal.addSphere(mx - 0.6, yR + 5.2, mz, 0.65, 10, 8, { color: [0.76, 0.78, 0.76], scale: [0.35, 1, 1] });
      }
    }
  }

  // ---- Sector C Municipal Command HQ (Building 6: X in [50..66], Z in [-13..+13], 3 Enterable Levels!) ----
  function buildCommandHQ(bm) {
    const x0 = 50, x1 = 66, z0 = -13, z1 = 13;
    const bConc = bm.get('concrete', { texKey: 'concrete', color: [0.84, 0.83, 0.80], roughness: 0.85, metalness: 0.05 });
    const bDmg = bm.get('concrete_damaged', { texKey: 'concrete_damaged', color: [0.74, 0.73, 0.70], roughness: 0.90, metalness: 0.04 });
    const bWood = bm.get('wood', { texKey: 'wood', color: [0.62, 0.48, 0.34], roughness: 0.82, metalness: 0.05 });

    // Floor 1 slab (Y = 0.25)
    addSlabsAroundCutouts(bConc, x0, x1, z0, z1, -0.15, 0.25, [], 'hq_f1', [0.76, 0.75, 0.72]);

    // Stair 1: Floor 1 -> Floor 2 (flush against East interior wall X=65.75, zero side gap!)
    const hqStair1 = { x0: 62.55, x1: 65.75, z0: 3.0, z1: 9.5, y0: 0.25, y1: 3.85, dir: '-z', guardRailSide: '-x' };
    addSlabsAroundCutouts(bConc, x0, x1, z0, z1, 3.60, 3.85, [computeStairCutout(hqStair1)], 'hq_f2', [0.78, 0.77, 0.74]);
    addInteriorStaircase(bm, hqStair1);

    // West Grand Facade (X = 50, facing West toward approaching RU forces!)
    buildWallFacadeLine(bm, {
      x0: 50, z0: -13, x1: 50, z1: 13, yBase: 0.25, h: 3.35, thick: 0.42,
      bays: ['win_open', 'dest', 'door_open', 'dest', 'win_open'],
      material: 'concrete', sectorIdx: 2, outNormal: [-1, 0, 0], floorIdx: 0
    });
    buildWallFacadeLine(bm, {
      x0: 50, z0: -13, x1: 50, z1: 13, yBase: 3.85, h: 3.35, thick: 0.42,
      bays: ['win_open', 'win', 'balcony_door', 'win', 'win_open'],
      material: 'concrete', sectorIdx: 2, outNormal: [-1, 0, 0], floorIdx: 1
    });

    // East Rear Facade (X = 66)
    buildWallFacadeLine(bm, {
      x0: 66, z0: -13, x1: 66, z1: 13, yBase: 0.25, h: 3.35, thick: 0.40,
      bays: ['solid', 'win', 'door_open', 'win', 'solid'],
      material: 'concrete', sectorIdx: 2, outNormal: [1, 0, 0], floorIdx: 0
    });
    buildWallFacadeLine(bm, {
      x0: 66, z0: -13, x1: 66, z1: 13, yBase: 3.85, h: 3.35, thick: 0.40,
      bays: ['solid', 'solid', 'win', 'solid', 'solid'],
      material: 'concrete', sectorIdx: 2, outNormal: [1, 0, 0], floorIdx: 1
    });

    // North & South Side Facades (Z = -13 and Z = +13)
    buildWallFacadeLine(bm, {
      x0: 50, z0: -13, x1: 66, z1: -13, yBase: 0.25, h: 3.35, thick: 0.38,
      bays: ['dest', 'door_open', 'win'],
      material: 'concrete', sectorIdx: 2, outNormal: [0, 0, -1], floorIdx: 0
    });
    buildWallFacadeLine(bm, {
      x0: 50, z0: -13, x1: 66, z1: -13, yBase: 3.85, h: 3.35, thick: 0.38,
      bays: ['win_open', 'dest', 'solid'],
      material: 'concrete', sectorIdx: 2, outNormal: [0, 0, -1], floorIdx: 1
    });
    buildWallFacadeLine(bm, {
      x0: 50, z0: 13, x1: 66, z1: 13, yBase: 0.25, h: 3.35, thick: 0.38,
      bays: ['dest', 'door_open', 'win'],
      material: 'concrete', sectorIdx: 2, outNormal: [0, 0, 1], floorIdx: 0
    });
    buildWallFacadeLine(bm, {
      x0: 50, z0: 13, x1: 66, z1: 13, yBase: 3.85, h: 3.35, thick: 0.38,
      bays: ['win_open', 'dest', 'solid'],
      material: 'concrete', sectorIdx: 2, outNormal: [0, 0, 1], floorIdx: 1
    });

    // Monumental Soviet Portico Colonnade Pillars in front of HQ entrance (X = 48.2, Z = -6.5, -2.5, +2.5, +6.5)
    if (bConc && bDmg) {
      for (const pz of [-6.8, -2.8, 2.8, 6.8]) {
        bConc.addCylinder(48.2, 3.72, pz, 0.42, 0.48, 7.45, 10, { color: [0.84, 0.83, 0.80], uvScale: 0.35, aoBottom: 0.56 });
        addStaticCol('hq_col', [47.7, 0, pz - 0.5], [48.7, 7.45, pz + 0.5], { type: 'cover', material: 'concrete' });
      }
      // Portico canopy beam at Y=7.2..7.8
      bDmg.addBeveledBox(49.0, 7.55, 0, 2.6, 0.65, 15.8, 0.04, { color: [0.76, 0.75, 0.72], uvScale: 0.3 });
    }

    // Ground Hall Interior Pillars, Briefing Map Table, & Sandbag Inner Barricade
    for (const pz of [-5.0, 5.0]) {
      if (bConc) {
        bConc.addBeveledBox(55.5, 1.925, pz, 0.65, 3.35, 0.65, 0.025, { color: [0.76, 0.75, 0.72], aoBottom: 0.65 });
      }
      addStaticCol('hq_intcol', [55.15, 0.25, pz - 0.35], [55.85, 3.60, pz + 0.35], { type: 'cover', material: 'concrete' });
      addCover([56.6, 0.25, pz], [-1, 0, 0], 1.8, 2, 'UA', null);
    }
    // Tactical command briefing desk, field radio terminal, filing cabinets, ceiling beams & chairs on Floor 1 & Floor 2!
    const bDarkHQ = bm.get('metal_dark', { texKey: 'metal_dark', color: [0.26, 0.28, 0.30], roughness: 0.62, metalness: 0.66 });
    const bSandHQ = bm.get('sandbag', { texKey: 'sandbag', color: [0.80, 0.75, 0.64], roughness: 0.96, metalness: 0.0 });
    for (const fy of [0.25, 3.85]) {
      if (bWood && bDarkHQ && bConc) {
        // Ceiling structural beams across HQ Hall
        for (const bz of [-6.5, 0, 6.5]) {
          bConc.addBox(55.8, fy + 3.21, bz, 11.2, 0.28, 0.38, { color: [0.70, 0.69, 0.66], uvScale: 0.4 });
          bDarkHQ.addBeveledBox(55.5, fy + 2.86, bz, 1.45, 0.09, 0.24, 0.012, { color: [0.68, 0.69, 0.67] });
        }
        // Briefing map table + tactical map sheet + military field radio unit with whip antenna!
        bWood.addBeveledBox(56.5, fy + 0.84, 0, 1.6, 0.12, 3.2, 0.02, { color: [0.58, 0.46, 0.34], uvScale: 0.5 });
        bWood.addBox(56.5, fy + 0.40, -1.2, 1.3, 0.80, 0.22, { color: [0.46, 0.36, 0.26] });
        bWood.addBox(56.5, fy + 0.40, 1.2, 1.3, 0.80, 0.22, { color: [0.46, 0.36, 0.26] });
        bDarkHQ.addBeveledBox(56.4, fy + 1.06, -1.05, 0.42, 0.32, 0.54, 0.02, { color: [0.28, 0.34, 0.28] }); // Field radio set
        bDarkHQ.addCylinder(56.4, fy + 1.62, -1.18, 0.009, 0.014, 0.92, 5, { color: [0.36, 0.38, 0.40] });
        // Filing cabinets & tactical shelving against North/South HQ walls
        for (const cz of [-11.5, 11.5]) {
          bDarkHQ.addBeveledBox(54.2, fy + 0.72, cz, 0.64, 1.44, 0.54, 0.018, { color: [0.38, 0.42, 0.40], aoBottom: 0.56 });
          bDarkHQ.addBeveledBox(55.0, fy + 0.72, cz, 0.64, 1.44, 0.54, 0.018, { color: [0.42, 0.45, 0.43], aoBottom: 0.56 });
        }
      }
      // Sandbagged inner window nests on HQ Floor 2 overlooking courtyard
      if (fy > 3.0 && bSandHQ) {
        for (const sz of [-8.2, 8.2]) {
          for (let row = 0; row < 3; row++) {
            for (let bag = -1; bag <= 1; bag++) {
              bSandHQ.addBeveledBox(51.1, fy + 0.13 + row * 0.23, sz + bag * 0.52, 0.30, 0.21, 0.48, 0.05, {
                color: [0.80 - row * 0.03, 0.75 - row * 0.03, 0.64 - row * 0.03]
              });
            }
          }
        }
      }
      addStaticCol('hq_desk', [55.7, fy, -1.6], [57.3, fy + 0.90, 1.6], { type: 'cover', material: 'wood' });
      addCover([58.2, fy, 0], [-1, 0, 0], 0.95, 2, 'UA', null);
    }

    // Accessible Rooftop Sniper Deck (Y = 7.45m) with Stair 2 (flush against East wall X=65.75!)
    buildAccessibleRoofDeck(bm, {
      x0, x1, z0, z1,
      sectorIdx: 2,
      isHQ: true,
      roofStair: {
        x0: 62.55, x1: 65.75, z0: -9.5, z1: -3.0, y0: 3.85, y1: 7.45, dir: '-z', guardRailSide: '-x'
      }
    });

    // Warm interior command hall lighting
    interiorLights.push(
      { pos: [55.5, 3.2, 0], color: [1.0, 0.80, 0.48], intensity: 3.2, radius: 15.0 },
      { pos: [55.5, 6.8, 0], color: [1.0, 0.78, 0.46], intensity: 2.8, radius: 14.0 }
    );
  }

  // ---- Fortified Concrete Pillbox Bunker in Sector C Courtyard (X[37..43], Z[+6..+12]) ----
  function buildCourtyardPillbox(bm) {
    const bConc = bm.get('concrete_damaged', { texKey: 'concrete_damaged', color: [0.76, 0.75, 0.72], roughness: 0.90, metalness: 0.04 });
    const x0 = 37, x1 = 43, z0 = 6.0, z1 = 12.0;
    const y0 = 0.0, yFloor = 0.20, yRoof = 2.55;

    // Grounded concrete floor & sloped blast roof
    if (bConc) {
      bConc.addBox(40, 0.05, 9, 6.0, 0.30, 6.0, { color: [0.70, 0.69, 0.66], uvScale: 0.35 });
      bConc.addBeveledBox(40, yRoof + 0.20, 9, 6.4, 0.42, 6.4, 0.06, { color: [0.74, 0.73, 0.70], uvScale: 0.35 });
      // West wall with horizontal firing slit (Y = 1.25..1.90 open!)
      bConc.addBox(x0 + 0.25, 0.62, 9, 0.50, 1.25, 6.0, { color: [0.76, 0.75, 0.72], uvScale: 0.4, aoBottom: 0.56 });
      bConc.addBox(x0 + 0.25, 2.22, 9, 0.50, 0.65, 6.0, { color: [0.76, 0.75, 0.72], uvScale: 0.4 });
      bConc.addBox(x0 + 0.25, 1.58, z0 + 0.65, 0.50, 0.68, 1.3, { color: [0.74, 0.73, 0.70] });
      bConc.addBox(x0 + 0.25, 1.58, z1 - 0.65, 0.50, 0.68, 1.3, { color: [0.74, 0.73, 0.70] });
      // North wall with horizontal firing slit facing the road!
      bConc.addBox(40, 0.62, z0 + 0.25, 6.0, 1.25, 0.50, { color: [0.76, 0.75, 0.72], uvScale: 0.4, aoBottom: 0.56 });
      bConc.addBox(40, 2.22, z0 + 0.25, 6.0, 0.65, 0.50, { color: [0.76, 0.75, 0.72], uvScale: 0.4 });
      // South solid wall
      bConc.addBox(40, 1.28, z1 - 0.25, 6.0, 2.55, 0.50, { color: [0.74, 0.73, 0.70], uvScale: 0.4, aoBottom: 0.56 });
      // East wall with open entry doorway (Z = 8.0..10.2)
      bConc.addBox(x1 - 0.25, 1.28, 7.0, 0.50, 2.55, 2.0, { color: [0.74, 0.73, 0.70], uvScale: 0.4, aoBottom: 0.56 });
      bConc.addBox(x1 - 0.25, 1.28, 11.1, 0.50, 2.55, 1.8, { color: [0.74, 0.73, 0.70], uvScale: 0.4, aoBottom: 0.56 });
    }

    addStaticCol('pb_floor', [x0, -0.1, z0], [x1, yFloor, z1], { type: 'floor', material: 'concrete' });
    addStaticCol('pb_roof', [x0 - 0.2, yRoof, z0 - 0.2], [x1 + 0.2, yRoof + 0.42, z1 + 0.2], { type: 'floor', material: 'concrete' });
    addStaticCol('pb_w_low', [x0, y0, z0], [x0 + 0.5, 1.25, z1], { type: 'cover', material: 'concrete' });
    addStaticCol('pb_w_hi', [x0, 1.90, z0], [x0 + 0.5, yRoof, z1], { type: 'wall', material: 'concrete' });
    addStaticCol('pb_n_low', [x0, y0, z0], [x1, 1.25, z0 + 0.5], { type: 'cover', material: 'concrete' });
    addStaticCol('pb_n_hi', [x0, 1.90, z0], [x1, yRoof, z0 + 0.5], { type: 'wall', material: 'concrete' });
    addStaticCol('pb_s', [x0, y0, z1 - 0.5], [x1, yRoof, z1], { type: 'wall', material: 'concrete' });
    addStaticCol('pb_e1', [x1 - 0.5, y0, z0], [x1, yRoof, 8.0], { type: 'wall', material: 'concrete' });
    addStaticCol('pb_e2', [x1 - 0.5, y0, 10.2], [x1, yRoof, z1], { type: 'wall', material: 'concrete' });

    addCover([38.5, yFloor, 9.0], [-1, 0, 0], 1.15, 2, 'UA', null);
    addCover([40.0, yFloor, 7.6], [-0.4, 0, -0.9], 1.15, 2, 'UA', null);
  }

  // ---- South Fuel Garage Depot (X[28..44], Z[+18..+30]) ----
  function buildSouthGarage(bm) {
    const bConc = bm.get('concrete', { texKey: 'concrete', color: [0.76, 0.75, 0.72], roughness: 0.88, metalness: 0.04 });
    const bMetal = bm.get('metal_rust', { texKey: 'metal_rust', color: [0.58, 0.48, 0.40], roughness: 0.78, metalness: 0.62 });
    const x0 = 28, x1 = 44, z0 = 18, z1 = 30;

    addSlabsAroundCutouts(bConc, x0, x1, z0, z1, -0.15, 0.22, [], 'gar_f1', [0.70, 0.69, 0.67]);
    // Corrugated steel roof slab (Y = 3.85..4.05)
    if (bMetal) {
      bMetal.addBox(36, 3.96, 24, 16.5, 0.24, 12.4, { color: [0.54, 0.46, 0.38], uvScale: 0.35 });
    }
    addStaticCol('gar_roof', [x0, 3.84, z0], [x1, 4.10, z1], { type: 'floor', material: 'metal' });

    // Open garage bay on North (-Z), destructible bays on West/South/East
    buildWallFacadeLine(bm, { x0, z0, x1, z1: z0, yBase: 0.22, h: 3.62, thick: 0.34, bays: ['door_open', 'dest', 'door_open'], material: 'brick', sectorIdx: 2, outNormal: [0, 0, -1], floorIdx: 0 });
    buildWallFacadeLine(bm, { x0, z0: z1, x1, z1, yBase: 0.22, h: 3.62, thick: 0.34, bays: ['dest', 'door_open', 'win_open'], material: 'brick', sectorIdx: 2, outNormal: [0, 0, 1], floorIdx: 0 });
    buildWallFacadeLine(bm, { x0, z0, x1: x0, z1, yBase: 0.22, h: 3.62, thick: 0.34, bays: ['dest', 'door_open'], material: 'brick', sectorIdx: 2, outNormal: [-1, 0, 0], floorIdx: 0 });
    buildWallFacadeLine(bm, { x0: x1, z0, x1, z1, yBase: 0.22, h: 3.62, thick: 0.34, bays: ['door_open', 'win'], material: 'brick', sectorIdx: 2, outNormal: [1, 0, 0], floorIdx: 0 });
  }

  // ---- 3. Battlefield Landmarks, Streetscape Props, Infrastructure & Ambient Fires ----
  function buildBattlefieldProps(bm) {
    const bConc = bm.get('concrete', { texKey: 'concrete', color: [0.80, 0.79, 0.76], roughness: 0.88, metalness: 0.04 });
    const bDmg = bm.get('concrete_damaged', { texKey: 'concrete_damaged', color: [0.74, 0.73, 0.70], roughness: 0.94, metalness: 0.02 });
    const bWreck = bm.get('burnt_wreck', { texKey: 'burnt_wreck', color: [0.46, 0.44, 0.42], roughness: 0.88, metalness: 0.36 });
    const bBusPaint = bm.get('bus_livery', { texKey: 'metal_rust', color: [0.52, 0.60, 0.64], roughness: 0.74, metalness: 0.35 });
    const bMetal = bm.get('metal_rust', { texKey: 'metal_rust', color: [0.54, 0.46, 0.38], roughness: 0.74, metalness: 0.66 });
    const bDark = bm.get('metal_dark', { texKey: 'metal_dark', color: [0.28, 0.30, 0.32], roughness: 0.56, metalness: 0.72 });
    const bBark = bm.get('tree_bark', { texKey: 'wood', color: [0.48, 0.44, 0.39], roughness: 0.98, metalness: 0.0 });
    const bWood = bm.get('wood', { texKey: 'wood', color: [0.56, 0.48, 0.38], roughness: 0.95, metalness: 0.0 });
    const bCrate = bm.get('crate_mil', { texKey: 'crate_mil', color: [0.88, 0.92, 0.84], roughness: 0.74, metalness: 0.14 });

    // A. Hero Wrecked Burnt Donbas ZiU-9 Trolleybus at Sector A Crossroads (-36.5, 0, -4.6)
    {
      const tx = -36.5, tz = -4.6, rot = 0.26;
      const ty = terrainHeight(tx, tz);
      const c = Math.cos(rot), s = Math.sin(rot);
      const tf = (lx, ly, lz) => [tx + lx * c + lz * s, ty + ly, tz - lx * s + lz * c];

      if (bWreck && bBusPaint && bDark && bMetal) {
        // 1. Undercarriage chassis frame rails + floor deck (Y = 0.56..0.72)
        const pFloor = tf(0, 0.64, 0);
        bDark.addBox(pFloor[0], pFloor[1], pFloor[2], 10.1, 0.16, 2.26, { color: [0.20, 0.20, 0.21], rotY: rot });

        // 2. Lower side panels (two-tone faded Donbas transit blue-slate & scorched lower skirt, segmented around wheel arches!)
        const sideSegs = [
          { x: -4.45, len: 1.55 },
          { x: -0.05, len: 4.90 },
          { x: 4.35,  len: 1.65 }
        ];
        for (const seg of sideSegs) {
          for (const side of [-1.18, 1.18]) {
            // Lower rusted skirt
            const pSkirt = tf(seg.x, 0.82, side);
            bWreck.addBeveledBox(pSkirt[0], pSkirt[1], pSkirt[2], seg.len, 0.44, 0.12, 0.02, {
              color: [0.42, 0.38, 0.34], rotY: rot, uvScale: 0.5, aoBottom: 0.45
            });
            // Upper faded Soviet blue-cream livery waist panel
            const pWaist = tf(seg.x, 1.32, side);
            bBusPaint.addBeveledBox(pWaist[0], pWaist[1], pWaist[2], seg.len, 0.56, 0.13, 0.02, {
              color: [0.58, 0.66, 0.68], rotY: rot, uvScale: 0.4
            });
          }
        }
        // Raised fender wheel-arch lips over front & rear axles
        for (const ax of [-3.15, 3.05]) {
          for (const side of [-1.18, 1.18]) {
            const pArch = tf(ax, 1.38, side);
            bBusPaint.addBeveledBox(pArch[0], pArch[1], pArch[2], 1.36, 0.44, 0.14, 0.02, {
              color: [0.52, 0.58, 0.60], rotY: rot, uvScale: 0.45
            });
            const pTrim = tf(ax, 1.14, side * 1.03);
            bDark.addBox(pTrim[0], pTrim[1], pTrim[2], 1.32, 0.07, 0.08, { color: [0.16, 0.16, 0.17], rotY: rot });
          }
        }
        // Horizontal chrome/oxidized belt molding trim running full length
        for (const side of [-1.25, 1.25]) {
          const pBelt = tf(0, 1.56, side);
          bDark.addBox(pBelt[0], pBelt[1], pBelt[2], 10.3, 0.07, 0.05, { color: [0.46, 0.46, 0.44], rotY: rot });
        }

        // 3. Streamlined Front Cab (+X nose facing East/SE) & Rear Fascia (-X)
        // Lower sloped front apron + recessed radiator grille slats + twin circular headlights + wrap-around bumper
        const pNoseLow = tf(5.26, 1.06, 0);
        bBusPaint.addBeveledBox(pNoseLow[0], pNoseLow[1], pNoseLow[2], 0.34, 0.96, 2.38, 0.05, {
          color: [0.54, 0.60, 0.62], rotY: rot, uvScale: 0.45, aoBottom: 0.5
        });
        // Sloped front windshield corner A-pillars + central mullion + destination lightbox brow
        for (const zp of [-1.12, 0, 1.12]) {
          const pAP = tf(5.22, 2.08, zp);
          bBusPaint.addBox(pAP[0], pAP[1], pAP[2], 0.12, 1.06, 0.12, {
            color: [0.50, 0.54, 0.56], rotY: rot, rotZ: 0.16
          });
        }
        const pDestBox = tf(5.06, 2.66, 0);
        bDark.addBeveledBox(pDestBox[0], pDestBox[1], pDestBox[2], 0.36, 0.28, 1.65, 0.03, {
          color: [0.22, 0.23, 0.25], rotY: rot
        });
        // Front radiator grille + headlights
        const pGrille = tf(5.44, 0.92, 0);
        bDark.addBox(pGrille[0], pGrille[1], pGrille[2], 0.06, 0.38, 1.25, { color: [0.14, 0.14, 0.15], rotY: rot });
        for (const hz of [-0.84, 0.84]) {
          const pHL = tf(5.44, 0.92, hz);
          bMetal.addCylinder(pHL[0], pHL[1], pHL[2], 0.13, 0.14, 0.08, 10, { axis: 'x', color: [0.76, 0.74, 0.66], rotY: rot });
        }
        // Rear engine bulkhead (-X) with louvered vents + rear window mullions
        const pRearLow = tf(-5.26, 1.08, 0);
        bWreck.addBeveledBox(pRearLow[0], pRearLow[1], pRearLow[2], 0.30, 1.02, 2.38, 0.05, {
          color: [0.36, 0.33, 0.31], rotY: rot, uvScale: 0.45, aoBottom: 0.45
        });
        for (const zp of [-1.12, -0.38, 0.38, 1.12]) {
          const pRP = tf(-5.24, 2.08, zp);
          bWreck.addBox(pRP[0], pRP[1], pRP[2], 0.12, 1.04, 0.12, { color: [0.32, 0.30, 0.28], rotY: rot, rotZ: -0.10 });
        }
        // Heavy wrap-around front & rear steel bumpers
        for (const bx of [-5.48, 5.50]) {
          const pBump = tf(bx, 0.58, 0);
          bDark.addBeveledBox(pBump[0], pBump[1], pBump[2], 0.20, 0.22, 2.52, 0.03, { color: [0.22, 0.22, 0.24], rotY: rot });
        }

        // 4. Recessed Side Window Pillars, Upper Window Transoms & Accordion Door Frames
        for (let wx = -4.6; wx <= 4.65; wx += 1.54) {
          for (const side of [-1.18, 1.18]) {
            const pp = tf(wx, 2.08, side);
            bBusPaint.addBox(pp[0], pp[1], pp[2], 0.13, 1.06, 0.11, { color: [0.46, 0.50, 0.52], rotY: rot });
          }
        }
        // Upper horizontal window header rail
        for (const side of [-1.16, 1.16]) {
          const pHead = tf(0, 2.58, side);
          bBusPaint.addBox(pHead[0], pHead[1], pHead[2], 10.35, 0.14, 0.12, { color: [0.44, 0.48, 0.50], rotY: rot });
        }

        // 5. Visible Interior Details (passenger seat frames, driver partition bulkhead & vertical grab poles!)
        const pBulk = tf(3.75, 1.55, -0.35);
        bDark.addBox(pBulk[0], pBulk[1], pBulk[2], 0.10, 1.75, 1.45, { color: [0.24, 0.25, 0.26], rotY: rot });
        for (let sx = -4.0; sx <= 2.8; sx += 1.35) {
          for (const sz of [-0.74, 0.74]) {
            const pSeat = tf(sx, 1.02, sz);
            const pBack = tf(sx - 0.18, 1.34, sz);
            bWreck.addBox(pSeat[0], pSeat[1], pSeat[2], 0.44, 0.12, 0.56, { color: [0.34, 0.26, 0.22], rotY: rot });
            bWreck.addBox(pBack[0], pBack[1], pBack[2], 0.10, 0.58, 0.56, { color: [0.32, 0.24, 0.20], rotY: rot });
          }
          // Vertical interior steel stanchion grab pole
          const pGrab = tf(sx + 0.4, 1.68, 0.32);
          bMetal.addCylinder(pGrab[0], pGrab[1], pGrab[2], 0.022, 0.022, 1.92, 6, { color: [0.56, 0.56, 0.54] });
        }

        // 6. Cambered Roof Crown + Iconic ZiU-9 Rooftop Resistor Boxes + Bent Trolley Poles!
        const pRoofMain = tf(0, 2.74, 0);
        bWreck.addBeveledBox(pRoofMain[0], pRoofMain[1], pRoofMain[2], 10.45, 0.22, 2.38, 0.08, {
          color: [0.40, 0.40, 0.39], rotY: rot, uvScale: 0.35
        });
        const pRoofCrown = tf(0, 2.88, 0);
        bWreck.addBeveledBox(pRoofCrown[0], pRoofCrown[1], pRoofCrown[2], 9.8, 0.14, 1.88, 0.05, {
          color: [0.34, 0.34, 0.34], rotY: rot, uvScale: 0.4
        });
        // 3 Rooftop electrical resistor/shunt housings + roof ventilation hatches
        for (const rx of [-2.8, 0.4, 2.8]) {
          const pBox = tf(rx, 3.06, 0);
          bDark.addBeveledBox(pBox[0], pBox[1], pBox[2], 1.75, 0.28, 1.05, 0.03, {
            color: [0.28, 0.30, 0.31], rotY: rot
          });
        }
        // Spring-loaded trolley pole turret bases + bent/snapped overhead poles!
        for (const pz of [-0.36, 0.36]) {
          const pBase = tf(-0.9, 3.06, pz);
          bDark.addCylinder(pBase[0], pBase[1], pBase[2], 0.16, 0.20, 0.24, 8, { color: [0.24, 0.25, 0.26] });
        }
        bDark.addTube([tf(-0.9, 3.16, -0.36), tf(-3.4, 3.92, -0.52), tf(-5.9, 4.55, -0.78)], [0.042, 0.034, 0.026], 6, { color: [0.26, 0.28, 0.30] });
        bDark.addTube([tf(-0.9, 3.16, 0.36), tf(-3.1, 3.66, 0.56), tf(-5.3, 3.45, 1.05)], [0.042, 0.034, 0.026], 6, { color: [0.26, 0.28, 0.30] });

        // 7. Beefy Heavy-Duty Transit Tires (dual-wheel rear axle, deep steel wheel hubs, flush at Y=0!)
        // Front axle (+3.05): wide single tires (width 0.38m, r=0.50m)
        for (const az of [-1.06, 1.06]) {
          const pw = tf(3.05, 0.50, az);
          bDark.addCylinder(pw[0], pw[1], pw[2], 0.50, 0.50, 0.38, 14, { axis: 'z', color: [0.13, 0.13, 0.14], rotY: rot });
          const ph = tf(3.05, 0.50, az + (az > 0 ? 0.16 : -0.16));
          bMetal.addCylinder(ph[0], ph[1], ph[2], 0.27, 0.27, 0.10, 10, { axis: 'z', color: [0.46, 0.44, 0.42], rotY: rot });
        }
        // Rear axle (-3.15): beefy dual-tire transit bogies (width 0.56m, r=0.50m)
        for (const az of [-0.98, 0.98]) {
          const pw = tf(-3.15, 0.50, az);
          bDark.addCylinder(pw[0], pw[1], pw[2], 0.50, 0.50, 0.56, 14, { axis: 'z', color: [0.13, 0.13, 0.14], rotY: rot });
          const ph = tf(-3.15, 0.50, az + (az > 0 ? 0.25 : -0.25));
          bMetal.addCylinder(ph[0], ph[1], ph[2], 0.26, 0.26, 0.10, 10, { axis: 'z', color: [0.46, 0.44, 0.42], rotY: rot });
        }
      }
      // 10 tight hull-hugging segments along the rotated trolleybus centerline (tucked inside steel skin: zero invisible air wall, bullets shoot cleanly through open windows!)
      for (let si = 0; si < 10; si++) {
        const lx = -4.5 + si * 1.0;
        const pSeg = tf(lx, 0, 0);
        const hx = 0.52, hz = 1.12;
        // Solid lower waist hull (Y = 0..1.52)
        addStaticCol('trolleybus_hull', [pSeg[0] - hx, ty, pSeg[2] - hz], [pSeg[0] + hx, ty + 1.52, pSeg[2] + hz], {
          type: 'cover', material: 'metal'
        });
        // Shattered open window band (blocks movement, lets bullets shoot cleanly through!)
        addStaticCol('trolleybus_win', [pSeg[0] - hx, ty + 1.52, pSeg[2] - hz], [pSeg[0] + hx, ty + 2.60, pSeg[2] + hz], {
          type: 'cover', material: 'metal', passableForBullets: true
        });
        // Solid roof crown (Y = 2.60..3.05)
        addStaticCol('trolleybus_roof', [pSeg[0] - hx, ty + 2.60, pSeg[2] - hz], [pSeg[0] + hx, ty + 3.05, pSeg[2] + hz], {
          type: 'cover', material: 'metal'
        });
      }
      addCover([tx, ty, tz + 3.1], [0, 0, -1], 2.0, 0, null, null);
      addCover([tx + 5.9, ty, tz], [-1, 0, 0], 2.0, 0, 'UA', null);
      addCover([tx - 5.9, ty, tz], [1, 0, 0], 2.0, 0, 'RU', null);
    }

    // B. Shattered Soviet Monument Pedestal in Lenin Square (+4, 0, +1.5)
    {
      const mx = 4.0, mz = 1.5;
      const my = terrainHeight(mx, mz);
      const rngM = mulberry32(4411);
      if (bDmg && bConc && bDark && bMetal) {
        // Tier 1 weathered granite step base + recessed shadow plinth molding
        bDmg.addBeveledBox(mx, my + 0.16, mz, 5.5, 0.32, 5.5, 0.04, { color: [0.58, 0.56, 0.54], uvScale: 0.48, aoBottom: 0.48 });
        bConc.addBeveledBox(mx, my + 0.42, mz, 4.75, 0.22, 4.75, 0.03, { color: [0.64, 0.62, 0.59], uvScale: 0.50, aoBottom: 0.62 });
        // Tier 2 molded granite pedestal + dark stone corner pilasters
        bDmg.addBeveledBox(mx, my + 0.78, mz, 3.65, 0.54, 3.65, 0.045, { color: [0.54, 0.51, 0.49], uvScale: 0.48, aoBottom: 0.58 });
        bConc.addBeveledBox(mx, my + 1.08, mz, 3.85, 0.12, 3.85, 0.025, { color: [0.66, 0.64, 0.61], uvScale: 0.52 });
        // Tier 3 central artillery-scarred monolithic plinth with cornice cap & chipped corner!
        bDmg.addBeveledBox(mx, my + 1.88, mz, 2.02, 1.48, 2.02, 0.05, { color: [0.52, 0.49, 0.47], uvScale: 0.50, aoBottom: 0.64 });
        // Vertical corner stone quoins / trim ribs
        for (const qx of [-0.98, 0.98]) {
          for (const qz of [-0.98, 0.98]) {
            bConc.addBeveledBox(mx + qx, my + 1.84, mz + qz, 0.22, 1.42, 0.22, 0.02, { color: [0.62, 0.60, 0.58], uvScale: 0.6 });
          }
        }
        // Broken beveled cornice ring at Y = 2.62 (missing SW chunk from shell blast!)
        bConc.addBeveledBox(mx + 0.14, my + 2.64, mz - 0.10, 2.18, 0.18, 2.18, 0.03, { color: [0.60, 0.58, 0.55], uvScale: 0.5 });
        // Recessed oxidized bronze commemorative plaque frames on West & East faces
        for (const xSign of [-1, 1]) {
          bDark.addBeveledBox(mx + xSign * 1.02, my + 1.88, mz, 0.08, 0.72, 1.24, 0.015, { color: [0.22, 0.24, 0.22] });
          bMetal.addBox(mx + xSign * 1.05, my + 1.88, mz, 0.04, 0.56, 1.08, { color: [0.42, 0.39, 0.31] });
        }
        // Shattered jagged statue pedestal stump & bent iron armature rebar rods sticking out of the top!
        bDmg.addWedge(mx + 0.18, my + 2.94, mz - 0.12, 1.15, 0.46, 1.10, { color: [0.46, 0.44, 0.42], uvScale: 0.6, rotY: 0.4 });
        bDark.addBeveledBox(mx - 0.24, my + 2.92, mz + 0.15, 0.52, 0.42, 0.44, 0.03, { color: [0.26, 0.28, 0.26], rotY: 0.25 });
        for (let r = 0; r < 6; r++) {
          const a = (r / 6) * Math.PI * 2 + 0.3;
          const rx = mx + Math.cos(a) * 0.42;
          const rz = mz + Math.sin(a) * 0.42;
          bMetal.addTube([
            [rx, my + 2.72, rz],
            [rx + Math.cos(a) * 0.18, my + 3.18 + (r % 3) * 0.16, rz + Math.sin(a) * 0.18],
            [rx + Math.cos(a + 0.4) * 0.36, my + 3.45 + (r % 2) * 0.24, rz + Math.sin(a + 0.4) * 0.36]
          ], 0.022, 5, { color: [0.34, 0.26, 0.22] });
        }
        // Fallen broken bronze statue torso + shattered granite rubble slabs resting around the base!
        bDark.addBeveledBox(mx - 2.25, my + 0.36, mz + 1.55, 1.55, 0.68, 0.92, 0.06, {
          color: [0.28, 0.31, 0.29], rotY: 0.58, rotZ: 0.14, aoBottom: 0.50
        });
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2 + rngM() * 0.4;
          const dist = 2.65 + rngM() * 1.15;
          const sx = 0.28 + rngM() * 0.44;
          const sy = 0.12 + rngM() * 0.20;
          const sz = 0.24 + rngM() * 0.38;
          const sh = 0.44 + rngM() * 0.16;
          bDmg.addBox(mx + Math.cos(a) * dist, my + sy * 0.42, mz + Math.sin(a) * dist, sx, sy, sz, {
            color: [sh, sh * 0.98, sh * 0.95], uvScale: 0.65, rotY: rngM() * 3.14, rotX: (rngM() - 0.5) * 0.35, aoBottom: 0.52
          });
        }
      }
      addStaticCol('monument_base', [mx - 2.75, my - 0.1, mz - 2.75], [mx + 2.75, my + 0.50, mz + 2.75], { type: 'floor', material: 'concrete' });
      addStaticCol('monument_mid', [mx - 1.85, my + 0.50, mz - 1.85], [mx + 1.85, my + 1.12, mz + 1.85], { type: 'cover', material: 'concrete' });
      addStaticCol('monument_top', [mx - 1.05, my + 1.12, mz - 1.05], [mx + 1.05, my + 2.75, mz + 1.05], { type: 'wall', material: 'concrete' });
      addCover([mx + 3.0, my, mz], [-1, 0, 0], 1.25, 1, 'UA', null);
      addCover([mx - 3.0, my, mz], [1, 0, 0], 1.25, 1, 'RU', null);
      addCover([mx, my, mz + 3.0], [0, 0, -1], 1.25, 1, null, null);
      addCover([mx, my, mz - 3.0], [0, 0, 1], 1.25, 1, null, null);
    }

    // C. Concrete Dragon's Teeth Anti-Tank Pyramids (Sector A & Sector C approaches, leaving clean 9m+ armored lanes!)
    const teethCoords = [
      // Sector A anti-tank line (X = -49, wide armored lane Z in [-4.5..+5.5]!)
      [-49, -9.2], [-49, -7.2], [-49, -5.6], [-49, 6.4], [-49, 8.6],
      [-51, -8.2], [-51, -6.4], [-51, 7.5],
      // Sector C anti-tank line (X = +35, wide armored lane Z in [-5.0..+4.2]!)
      [35, -9.4], [35, -7.4], [35, -5.8], [35, 5.0], [35, 7.0],
      [33, -8.4], [33, -6.6], [33, 6.0]
    ];
    for (let i = 0; i < teethCoords.length; i++) {
      const dx = teethCoords[i][0], dz = teethCoords[i][1];
      const dy = terrainHeight(dx, dz);
      if (bConc) {
        // Authentic 4-sided concrete anti-tank pyramid (grounded -0.05 into soil)
        bConc.addCylinder(dx, dy + 0.56, dz, 0.14, 0.88, 1.22, 4, {
          color: [0.78, 0.77, 0.74], rotY: Math.PI * 0.25 + (i % 3) * 0.08, uvScale: 0.6, aoBottom: 0.54
        });
      }
      addStaticCol('dtooth', [dx - 0.62, dy - 0.1, dz - 0.62], [dx + 0.62, dy + 1.15, dz + 0.62], {
        type: 'cover', material: 'concrete'
      });
    }

    // D. Destructible Sandbag Trench Lines & Concrete Jersey Barriers across Sectors A, B, C & Flanks
    // Sector A forward defense arc (flanking infantry trenches, leaving center-south armored lane open)
    spawnSandbagWall(-31.5, -6.2, Math.PI * 0.5 + 0.14, 0, 'UA', -1);
    spawnSandbagWall(-31.2, -3.0, Math.PI * 0.5, 0, 'UA', -1);
    spawnSandbagWall(-31.5, 6.2, Math.PI * 0.5 - 0.14, 0, 'UA', -1);
    spawnSandbagWall(-35.0, 8.2, Math.PI * 0.35, 0, 'UA', -1);
    // RU West approach cover (keep RU_IFV spawn at [-60, 0, 5.2] and RU_DOG at [-58, 0, 5.0] 100% clear!)
    spawnJerseyBarrier(-62.0, -6.5, Math.PI * 0.5 + 0.15, 0);
    spawnJerseyBarrier(-64.2, 7.4, Math.PI * 0.5 - 0.12, 0);
    spawnJerseyBarrier(-53.5, 5.4, Math.PI * 0.5 + 0.08, 0);
    spawnSandbagWall(-70.0, -5.5, Math.PI * 0.5, 0, 'RU', 1);
    spawnSandbagWall(-70.0, 5.8, Math.PI * 0.5, 0, 'RU', 1);

    // Sector B Lenin Square barricades (flanking monument with wide 7m+ armor boulevard lanes!)
    spawnJerseyBarrier(-12.0, -7.8, Math.PI * 0.5 + 0.18, 1);
    spawnJerseyBarrier(-11.5, 8.2, Math.PI * 0.5 - 0.10, 1);
    spawnSandbagWall(9.5, -8.2, Math.PI * 0.5 + 0.15, 1, 'UA', -1);
    spawnSandbagWall(9.8, 8.5, Math.PI * 0.5 - 0.15, 1, 'UA', -1);
    spawnJerseyBarrier(17.5, -7.8, Math.PI * 0.5, 1);
    spawnJerseyBarrier(18.0, 8.4, Math.PI * 0.5 - 0.12, 1);

    // Sector C Citadel approach & Courtyard barricades
    spawnSandbagWall(44.5, -5.8, Math.PI * 0.5 + 0.10, 2, 'UA', -1);
    spawnSandbagWall(44.5, -2.5, Math.PI * 0.5, 2, 'UA', -1);
    spawnSandbagWall(44.5, 1.2, Math.PI * 0.5 - 0.10, 2, 'UA', -1);
    spawnJerseyBarrier(38.0, -7.2, Math.PI * 0.42, 2);
    spawnJerseyBarrier(29.5, 5.8, Math.PI * 0.55, 2);

    // North & South Flank Alley barricades & sandbag posts
    spawnSandbagWall(-40.0, -38.5, Math.PI * 0.5, 0, 'UA', -1);
    spawnJerseyBarrier(-14.0, -40.0, Math.PI * 0.5 + 0.1, 1);
    spawnSandbagWall(24.0, -39.0, Math.PI * 0.5, 2, 'UA', -1);
    spawnSandbagWall(-38.0, 38.5, Math.PI * 0.5, 0, 'UA', -1);
    spawnJerseyBarrier(-8.0, 40.5, Math.PI * 0.5 - 0.12, 1);
    spawnSandbagWall(22.0, 39.0, Math.PI * 0.5, 2, 'UA', -1);

    // E. Explosive High-Poly East-European Sedans & UAZ-452 Vans (6!) & Explosive Red Fuel Drums (10!)
    spawnExplosiveCar(-43.5, 6.4, 1.38, [0.74, 0.24, 0.20], 0, false);  // Red Lada Sedan at Sector A
    spawnExplosiveCar(-6.2, 7.6, 1.72, [0.34, 0.48, 0.60], 1, false);   // Steel-blue Sedan at Sector B South
    spawnExplosiveCar(12.2, -7.8, -1.25, [0.72, 0.66, 0.46], 1, true);  // Ochre UAZ-452 Van at Sector B North!
    spawnExplosiveCar(24.0, 37.5, 1.48, [0.40, 0.50, 0.38], 2, false);  // Olive Sedan on South flank
    spawnExplosiveCar(-55.5, -8.0, 1.62, [0.62, 0.64, 0.60], 0, true);  // Weathered White/Grey UAZ-452 Van on West approach!
    spawnExplosiveCar(28.5, -8.2, -1.42, [0.54, 0.36, 0.30], 2, false); // Maroon Sedan near Sector C approach!

    // Red fuel drum clusters (chain-reaction traps near choke points!)
    spawnFuelDrum(-42.0, 0.4, 8.6, 0);
    spawnFuelDrum(-41.2, 0.4, 9.0, 0);
    spawnFuelDrum(-29.8, 0.4, -5.8, 0);
    spawnFuelDrum(-10.8, 0.4, -5.0, 1);
    spawnFuelDrum(-10.1, 0.4, -5.5, 1);
    spawnFuelDrum(11.4, 0.4, -5.6, 1);
    spawnFuelDrum(36.8, 0.4, 14.5, 2);
    spawnFuelDrum(37.5, 0.4, 14.9, 2);
    spawnFuelDrum(42.5, 0.4, -8.5, 2);
    spawnFuelDrum(43.2, 0.4, -8.1, 2);

    // Destructible military supply crates around sectors
    spawnCrate(-33.5, 0.4, -7.8, 0.25, 0);
    spawnCrate(8.2, 0.4, 7.6, -0.35, 1);
    spawnCrate(46.2, 0.4, -7.2, 0.15, 2);
    spawnCrate(52.8, 0.4, 4.2, 0.08, 2);

    // F. Concrete Culvert Flank Passages & Rusted Corrugated Fences along North/South Alleys
    const culverts = [
      { x: -20, z: -43.5 },
      { x: 48,  z: -42.0 },
      { x: -18, z: 43.5 },
      { x: 52,  z: 42.5 }
    ];
    for (let i = 0; i < culverts.length; i++) {
      const cv = culverts[i];
      const y = terrainHeight(cv.x, cv.z);
      if (bDmg) {
        // Large concrete storm culvert pipe (horizontal along X, great tactical flank cover!)
        bDmg.addCylinder(cv.x, y + 0.95, cv.z, 0.95, 0.95, 5.2, 12, {
          axis: 'x', color: [0.74, 0.73, 0.70], uvScale: 0.4, aoBottom: 0.5
        });
      }
      addStaticCol('culvert', [cv.x - 2.6, y, cv.z - 0.95], [cv.x + 2.6, y + 1.9, cv.z + 0.95], {
        type: 'cover', material: 'concrete'
      });
      addCover([cv.x, y, cv.z + 1.6], [0, 0, -1], 1.5, i % 3, null, null);
      addCover([cv.x, y, cv.z - 1.6], [0, 0, 1], 1.5, i % 3, null, null);
    }

    // Rusted corrugated metal yard fences along outer flank margins
    const fences = [
      [-68, -48.5, 14, 0], [-22, -48.5, 16, 0], [32, -48.5, 16, 0],
      [-66, 48.5, 14, 0],  [-16, 48.5, 16, 0],  [34, 48.5, 16, 0]
    ];
    for (let i = 0; i < fences.length; i++) {
      const f = fences[i];
      const y = terrainHeight(f[0], f[1]);
      if (bMetal) {
        bMetal.addBox(f[0], y + 1.05, f[1], f[2], 2.1, 0.12, {
          color: [0.56, 0.44, 0.36], uvScale: 0.5, aoBottom: 0.58
        });
      }
      addStaticCol('fence', [f[0] - f[2] * 0.5, y, f[1] - 0.14], [f[0] + f[2] * 0.5, y + 2.1, f[1] + 0.14], {
        type: 'wall', material: 'metal'
      });
    }

    // G. Leaning Soviet Gooseneck Streetlamps & Utility Poles lining the Main Avenue
    const lampXs = [-76, -56, -24, -4, 18, 36];
    for (let i = 0; i < lampXs.length; i++) {
      const lx = lampXs[i];
      for (const zSign of [-1, 1]) {
        const lz = zSign * 11.4;
        const ly = DF.Physics ? DF.Physics.getGroundY(lx, lz, 0.5) : 0.12;
        const lean = ((i + (zSign > 0 ? 1 : 0)) % 3 === 0) ? 0.11 * zSign : 0.02;
        if (bConc && bDark) {
          // Tapered concrete Soviet utility post
          bConc.addCylinder(lx, ly + 3.4, lz, 0.11, 0.21, 6.8, 8, {
            color: [0.74, 0.74, 0.72], rotX: lean, uvScale: 0.5, aoBottom: 0.55
          });
          // Curved gooseneck steel arm jutting over the road
          const topY = ly + 6.75;
          const armDir = -zSign;
          bDark.addTube([
            [lx, topY, lz],
            [lx, topY + 0.55, lz + armDir * 0.65],
            [lx, topY + 0.42, lz + armDir * 1.95]
          ], 0.045, 6, { color: [0.30, 0.32, 0.34] });
          // Lamp cobra head housing
          bDark.addBeveledBox(lx, topY + 0.34, lz + armDir * 2.15, 0.32, 0.16, 0.68, 0.02, {
            color: [0.36, 0.38, 0.40]
          });
          // Utility crossbar
          bDark.addBox(lx, ly + 5.75, lz, 1.5, 0.09, 0.09, { color: [0.32, 0.30, 0.28] });
        }
        addStaticCol('lamp', [lx - 0.22, ly, lz - 0.22], [lx + 0.22, ly + 6.8, lz + 0.22], {
          type: 'wall', material: 'concrete'
        });
      }
    }

    // H. Gnarled War-Blasted Donbas Trees (kept well clear of road curbs/tank paths; root flares, crooked knotty trunks & multi-forked branches!)
    const trees = [
      [-68, -20.0, 1.05], [-56, 20.5, 0.96], [-19.5, -21.0, 1.12],
      [-18.0, 21.0, 1.02], [23.5, -21.5, 1.08], [23.0, 21.5, 0.95],
      [-60, -35.5, 1.12], [2, -45.5, 1.08],  [-46, 44.5, 1.05],
      [14, 44.5, 1.02],   [72, -26.0, 1.18], [72, 24.0, 1.12]
    ];
    for (let i = 0; i < trees.length; i++) {
      const tr = trees[i];
      const tx = tr[0], tz = tr[1], sc = tr[2];
      const ty = terrainHeight(tx, tz);
      const rng = mulberry32(5500 + i * 37);
      if (bBark) {
        // Build crooked 7-point S-curved trunk with natural bark knots & shell-sheared splintered top
        const pts = [];
        const rads = [];
        let cx = tx, cz = tz;
        const dirX = (rng() - 0.5) * 0.55;
        const dirZ = (rng() - 0.5) * 0.55;
        const trunkH = (4.6 + rng() * 1.4) * sc;
        for (let k = 0; k <= 6; k++) {
          const f = k / 6;
          const kinkX = k === 0 ? 0 : (dirX * f + Math.sin(f * 5.2 + i) * 0.22 + (rng() - 0.5) * 0.14) * sc;
          const kinkZ = k === 0 ? 0 : (dirZ * f + Math.cos(f * 4.6 + i * 1.7) * 0.22 + (rng() - 0.5) * 0.14) * sc;
          cx = tx + kinkX;
          cz = tz + kinkZ;
          pts.push([cx, ty - 0.18 + f * (trunkH + 0.18), cz]);
          const baseR = k === 0 ? 0.36 : (0.28 * Math.pow(1 - f * 0.68, 0.85));
          rads.push(baseR * sc);
        }
        bBark.addTube(pts, rads, 8, { color: [0.54, 0.50, 0.46], uvScale: 0.7 });

        // 5 flared buttress roots gripping the dirt around the trunk base
        for (let r = 0; r < 5; r++) {
          const ang = (r / 5) * Math.PI * 2 + rng() * 0.4;
          const rLen = (0.55 + rng() * 0.32) * sc;
          bBark.addTube([
            [tx + Math.cos(ang) * 0.12 * sc, ty + 0.52 * sc, tz + Math.sin(ang) * 0.12 * sc],
            [tx + Math.cos(ang) * rLen * 0.55, ty + 0.14 * sc, tz + Math.sin(ang) * rLen * 0.55],
            [tx + Math.cos(ang) * rLen, ty - 0.14, tz + Math.sin(ang) * rLen]
          ], [0.14 * sc, 0.09 * sc, 0.04 * sc], 5, { color: [0.46, 0.43, 0.39], uvScale: 0.8 });
        }

        // Jagged splintered shell-sheared crown spikes at top of trunk
        const topP = pts[6];
        for (let sp = 0; sp < 3; sp++) {
          const sa = (sp / 3) * Math.PI * 2 + rng();
          bBark.addTube([
            [topP[0] + Math.cos(sa) * 0.05 * sc, topP[1] - 0.12 * sc, topP[2] + Math.sin(sa) * 0.05 * sc],
            [topP[0] + Math.cos(sa) * 0.14 * sc, topP[1] + (0.35 + rng() * 0.45) * sc, topP[2] + Math.sin(sa) * 0.14 * sc]
          ], [0.06 * sc, 0.014 * sc], 4, { color: [0.68, 0.61, 0.52] });
        }

        // 5 crooked primary boughs, each splitting into 2 forked secondary limbs + broken twigs!
        for (let b = 0; b < 5; b++) {
          const anchorIdx = Math.min(5, 2 + Math.floor(b * 0.75));
          const anchor = pts[anchorIdx];
          const ang = (b / 5) * Math.PI * 2 + rng() * 0.65;
          const bLen = (1.55 + rng() * 1.15) * sc;
          const elev1 = (0.38 + rng() * 0.35) * sc;
          const elev2 = elev1 + (0.45 + rng() * 0.55) * sc;
          const bendA = ang + (rng() - 0.5) * 0.65;
          const midP = [
            anchor[0] + Math.cos(ang) * bLen * 0.48,
            anchor[1] + elev1,
            anchor[2] + Math.sin(ang) * bLen * 0.48
          ];
          const endP = [
            midP[0] + Math.cos(bendA) * bLen * 0.55,
            anchor[1] + elev2,
            midP[2] + Math.sin(bendA) * bLen * 0.55
          ];
          bBark.addTube([anchor, midP, endP], [0.115 * sc, 0.072 * sc, 0.032 * sc], 6, {
            color: [0.50, 0.46, 0.42], uvScale: 0.9
          });

          // 2 forked crooked secondary branches sprouting off midP and endP
          for (let f = 0; f < 2; f++) {
            const origin = f === 0 ? midP : endP;
            const fAng = bendA + (f === 0 ? 0.62 : -0.58) + (rng() - 0.5) * 0.35;
            const fLen = (0.75 + rng() * 0.75) * sc;
            const fMid = [
              origin[0] + Math.cos(fAng) * fLen * 0.5,
              origin[1] + (0.28 + rng() * 0.30) * sc,
              origin[2] + Math.sin(fAng) * fLen * 0.5
            ];
            const fTip = [
              fMid[0] + Math.cos(fAng + (rng() - 0.5) * 0.6) * fLen * 0.55,
              fMid[1] + (0.22 + rng() * 0.38) * sc,
              fMid[2] + Math.sin(fAng + (rng() - 0.5) * 0.6) * fLen * 0.55
            ];
            bBark.addTube([origin, fMid, fTip], [0.055 * sc, 0.030 * sc, 0.012 * sc], 4, {
              color: [0.46, 0.42, 0.38], uvScale: 1.0
            });
          }
        }
      }
      addStaticCol('tree', [tx - 0.34 * sc, ty, tz - 0.34 * sc], [tx + 0.34 * sc, ty + 4.8 * sc, tz + 0.34 * sc], {
        type: 'cover', material: 'wood'
      });
    }

    // I. 3 Hero Multi-Part Burnt Military Ural-4320 Truck Wrecks (weathered rusted-charred metal, open shattered cab, sloped hood, bed ribs & glowing ember coal bed!)
    const bEmber = bm.get('wreck_embers', {
      texKey: 'burnt_wreck',
      color: [0.95, 0.42, 0.12],
      roughness: 0.92,
      metalness: 0.0,
      emissive: [1.35, 0.34, 0.04],
      thermalHeat: 0.98
    });
    const ambWrecks = [
      { x: -66.0, z: 7.4,  rot: 0.42 }, // West staging burning Ural-4320
      { x: 14.5,  z: 9.2,  rot: -0.35 }, // Lenin Square burning Ural-4320 (r4_03c hero!)
      { x: 70.0,  z: -8.0, rot: 0.55 }  // Behind Sector C smoldering wreck
    ];
    for (let i = 0; i < ambWrecks.length; i++) {
      const w = ambWrecks[i];
      const wy = terrainHeight(w.x, w.z);
      const c = Math.cos(w.rot), s = Math.sin(w.rot);
      const tf = (lx, ly, lz) => [w.x + lx * c + lz * s, wy + ly, w.z - lx * s + lz * c];
      if (bWreck && bMetal && bDark && bEmber) {

        // 1. Heavy steel ladder chassis rails, axles & under-bed cylindrical fuel tank
        for (const rz of [-0.52, 0.52]) {
          const pRail = tf(-0.1, 0.62, rz);
          bDark.addBox(pRail[0], pRail[1], pRail[2], 5.65, 0.22, 0.16, { color: [0.30, 0.28, 0.26], rotY: w.rot });
        }
        const pTank = tf(-0.05, 0.66, 0.96);
        bMetal.addCylinder(pTank[0], pTank[1], pTank[2], 0.22, 0.22, 1.05, 10, { axis: 'x', color: [0.58, 0.44, 0.34], rotY: w.rot });

        // 2. Sculpted Ural-4320 Sloped Engine Hood (+X front), Radiator Grille, Flared Fenders & Bullbar Bumper
        const pHood = tf(2.12, 1.24, 0);
        bMetal.addBeveledBox(pHood[0], pHood[1], pHood[2], 1.48, 0.58, 1.28, 0.04, {
          color: [0.66, 0.52, 0.42], rotY: w.rot, rotZ: -0.06, uvScale: 0.55, aoBottom: 0.58
        });
        // Bowed/buckled engine hood lid popped slightly ajar from fire!
        const pHoodTop = tf(2.08, 1.56, 0);
        bWreck.addBeveledBox(pHoodTop[0], pHoodTop[1], pHoodTop[2], 1.38, 0.10, 1.22, 0.025, {
          color: [0.68, 0.58, 0.48], rotY: w.rot, rotZ: 0.12, rotX: 0.05, uvScale: 0.5
        });
        // Slatted armored radiator grille + headlight buckets
        const pGrille = tf(2.88, 1.18, 0);
        bDark.addBeveledBox(pGrille[0], pGrille[1], pGrille[2], 0.12, 0.54, 1.12, 0.02, { color: [0.24, 0.24, 0.26], rotY: w.rot });
        for (const side of [-0.90, 0.90]) {
          // Flared wide steel wheel fender arches flanking the Ural nose
          const pFend = tf(2.02, 1.12, side);
          bMetal.addBeveledBox(pFend[0], pFend[1], pFend[2], 1.42, 0.16, 0.52, 0.025, { color: [0.62, 0.48, 0.38], rotY: w.rot });
          const pHL = tf(2.74, 1.04, side * 0.94);
          bDark.addCylinder(pHL[0], pHL[1], pHL[2], 0.11, 0.12, 0.14, 10, { axis: 'x', color: [0.46, 0.44, 0.40], rotY: w.rot });
        }
        // Heavy front steel off-road bumper + tow hooks
        const pBump = tf(2.96, 0.72, 0);
        bMetal.addBeveledBox(pBump[0], pBump[1], pBump[2], 0.22, 0.24, 2.28, 0.025, { color: [0.54, 0.46, 0.40], rotY: w.rot });

        // 3. Open Shattered Truck Cab (lower doors, interior bench, open windshield frame, thin A/B pillars & dented roof!)
        const pCabBase = tf(0.88, 1.08, 0);
        bWreck.addBeveledBox(pCabBase[0], pCabBase[1], pCabBase[2], 1.32, 0.68, 2.08, 0.035, {
          color: [0.64, 0.54, 0.46], rotY: w.rot, uvScale: 0.5, aoBottom: 0.55
        });
        // Cab rear bulkhead wall (separating cab from cargo bed)
        const pCabBack = tf(0.24, 1.72, 0);
        bMetal.addBox(pCabBack[0], pCabBack[1], pCabBack[2], 0.12, 0.82, 1.98, { color: [0.58, 0.46, 0.38], rotY: w.rot });
        // Sloped windshield A-pillars + center windshield divider + rear B-pillars (open shattered glass!)
        for (const zp of [-0.96, 0, 0.96]) {
          const pAP = tf(1.44, 1.74, zp);
          bMetal.addBox(pAP[0], pAP[1], pAP[2], 0.09, 0.72, 0.09, { color: [0.64, 0.50, 0.40], rotY: w.rot, rotZ: 0.24 });
        }
        for (const zp of [-0.96, 0.96]) {
          const pBP = tf(0.28, 1.74, zp);
          bMetal.addBox(pBP[0], pBP[1], pBP[2], 0.10, 0.72, 0.10, { color: [0.60, 0.48, 0.38], rotY: w.rot });
        }
        // Dented cab roof crown + popped round turret/escape hatch
        const pCabRoof = tf(0.80, 2.12, 0);
        bWreck.addBeveledBox(pCabRoof[0], pCabRoof[1], pCabRoof[2], 1.24, 0.12, 2.02, 0.03, {
          color: [0.56, 0.48, 0.42], rotY: w.rot, rotZ: -0.04
        });
        const pHatch = tf(0.75, 2.24, -0.35);
        bMetal.addBeveledBox(pHatch[0], pHatch[1], pHatch[2], 0.56, 0.06, 0.56, 0.015, {
          color: [0.58, 0.44, 0.36], rotY: w.rot, rotZ: 0.42
        });

        // 4. Open Troop/Cargo Bed (sideboard walls, bed floor, lowered tailgate, bent steel canopy ribs & glowing ember coal bed!)
        const pBedFloor = tf(-1.45, 0.90, 0);
        bWreck.addBox(pBedFloor[0], pBedFloor[1], pBedFloor[2], 3.10, 0.14, 2.22, { color: [0.46, 0.40, 0.36], rotY: w.rot });
        // Left & right weathered steel/charred-wood bed sideboards with vertical ribs
        for (const sz of [-1.08, 1.08]) {
          const pSide = tf(-1.45, 1.32, sz);
          bMetal.addBeveledBox(pSide[0], pSide[1], pSide[2], 3.12, 0.72, 0.12, 0.02, {
            color: [0.62, 0.50, 0.40], rotY: w.rot, uvScale: 0.5, aoBottom: 0.58
          });
        }
        // Front headboard & bent ajar rear tailgate
        const pHeadB = tf(0.06, 1.34, 0);
        bMetal.addBox(pHeadB[0], pHeadB[1], pHeadB[2], 0.12, 0.76, 2.16, { color: [0.56, 0.46, 0.38], rotY: w.rot });
        const pTail = tf(-3.04, 1.05, 0);
        bWreck.addBeveledBox(pTail[0], pTail[1], pTail[2], 0.12, 0.68, 2.16, 0.02, {
          color: [0.58, 0.48, 0.40], rotY: w.rot, rotZ: -0.62
        });
        // 3 Bent charred steel canvas-canopy hoop ribs arching over the burning cargo bed!
        for (let rIdx = 0; rIdx < 3; rIdx++) {
          const rx = -0.35 - rIdx * 1.12;
          const warp = (rIdx === 1) ? 0.24 : 0.0;
          bDark.addTube([
            tf(rx, 1.62, -1.04),
            tf(rx + warp * 0.4, 2.38 - warp, -0.86),
            tf(rx + warp, 2.54 - warp * 1.3, 0.0),
            tf(rx + warp * 0.5, 2.34 - warp * 0.6, 0.86),
            tf(rx, 1.62, 1.04)
          ], 0.028, 6, { color: [0.38, 0.34, 0.32] });
        }
        // Glowing orange-red ember coal bed tucked inside the burning cargo bay & engine grille!
        const pEmberBed = tf(-1.15, 1.04, 0);
        bEmber.addBeveledBox(pEmberBed[0], pEmberBed[1], pEmberBed[2], 2.25, 0.24, 1.62, 0.05, {
          color: [0.98, 0.46, 0.14], rotY: w.rot
        });
        const pEmberEng = tf(1.95, 1.44, 0);
        bEmber.addBox(pEmberEng[0], pEmberEng[1], pEmberEng[2], 0.75, 0.18, 0.75, { color: [0.95, 0.38, 0.10], rotY: w.rot });

        // 5. 6 Beefy 6x6 Off-Road Ural Tires (radius 0.50m, width 0.38m, deep rusted steel 8-lug hubs, flush at Y=0!)
        for (const wx of [-2.18, -0.82, 1.92]) {
          for (const wz of [-1.02, 1.02]) {
            const pw = tf(wx, 0.50, wz);
            bDark.addCylinder(pw[0], pw[1], pw[2], 0.50, 0.50, 0.38, 14, { axis: 'z', color: [0.16, 0.16, 0.17], rotY: w.rot });
            const ph = tf(wx, 0.50, wz + (wz > 0 ? 0.17 : -0.17));
            bMetal.addCylinder(ph[0], ph[1], ph[2], 0.26, 0.26, 0.10, 10, { axis: 'z', color: [0.54, 0.44, 0.36], rotY: w.rot });
          }
        }
      }
      // 5 tight hull-hugging segments along rotated Ural truck centerline (bed / cab / hood, zero side air-wall overhang!)
      const truckSegs = [
        { lx: -2.40, hx: 0.62, hz: 1.00, h: 1.66 },
        { lx: -1.30, hx: 0.62, hz: 1.00, h: 1.66 },
        { lx: -0.25, hx: 0.60, hz: 1.00, h: 1.68 },
        { lx:  0.80, hx: 0.62, hz: 1.00, h: 2.24 },
        { lx:  2.05, hx: 0.68, hz: 0.94, h: 1.52 }
      ];
      for (let ti = 0; ti < truckSegs.length; ti++) {
        const ts = truckSegs[ti];
        const pT = tf(ts.lx, 0, 0);
        addStaticCol('burn_truck', [pT[0] - ts.hx, wy, pT[2] - ts.hz], [pT[0] + ts.hx, wy + ts.h, pT[2] + ts.hz], {
          type: 'cover', material: 'metal'
        });
      }
      wreckFires.push({
        pos: [w.x, wy + 1.55, w.z],
        radius: 23.0,
        intensity: 18.5,
        plumeScale: 1.25
      });
    }
    // Additional dramatic urban fires (Sector A roadside debris fire & Building 3 burning 3rd-floor room!)
    wreckFires.push(
      { pos: [-43.5, 1.1, -9.8], radius: 20.0, intensity: 16.5, plumeScale: 1.05 },
      { pos: [2.0, 9.2, -14.8],  radius: 22.0, intensity: 17.0, plumeScale: 1.15 }
    );

    // I2. Coiled Concertina Razor-Wire Barricades on Timber Chevaux-de-Frise X-Frames (flanking choke points, armored road lanes 100% clear!)
    const razorBarricades = [
      { x: -47.5, z: -8.6, rot: 0.12, len: 3.6 },
      { x: -34.2, z: 9.2,  rot: -0.22, len: 3.4 },
      { x: -13.2, z: -9.8, rot: 0.18, len: 3.6 },
      { x: 10.6,  z: -9.8, rot: -0.15, len: 3.4 },
      { x: 35.5,  z: -8.8, rot: 0.16, len: 3.6 },
      { x: 44.2,  z: -8.0, rot: -0.10, len: 3.4 }
    ];
    for (let i = 0; i < razorBarricades.length; i++) {
      const rb = razorBarricades[i];
      const ry = terrainHeight(rb.x, rb.z);
      const c = Math.cos(rb.rot), s = Math.sin(rb.rot);
      const tf = (lx, ly, lz) => [rb.x + lx * c + lz * s, ry + ly, rb.z - lx * s + lz * c];
      if (bWood && bMetal && bDark) {
        // 2 weathered timber X-frame end trestles + central spine beam
        for (const ex of [-rb.len * 0.44, rb.len * 0.44]) {
          bWood.addTube([tf(ex, 0.0, -0.46), tf(ex, 1.02, 0.42)], 0.048, 6, { color: [0.54, 0.46, 0.36] });
          bWood.addTube([tf(ex, 0.0, 0.46), tf(ex, 1.02, -0.42)], 0.048, 6, { color: [0.54, 0.46, 0.36] });
        }
        bWood.addTube([tf(-rb.len * 0.48, 0.54, 0), tf(rb.len * 0.48, 0.54, 0)], 0.045, 6, { color: [0.52, 0.44, 0.35] });
        // Continuous helical spiral concertina steel razor-wire coil wrapping the frame!
        const coilPts = [];
        const turns = 7;
        const totalPts = 42;
        for (let k = 0; k <= totalPts; k++) {
          const u = k / totalPts;
          const lx = -rb.len * 0.46 + u * rb.len * 0.92;
          const ang = u * turns * Math.PI * 2;
          const rad = 0.40 + Math.sin(u * 13.0 + i) * 0.04;
          coilPts.push(tf(lx, 0.50 + Math.sin(ang) * rad, Math.cos(ang) * rad));
        }
        bDark.addTube(coilPts, 0.015, 4, { color: [0.46, 0.48, 0.50] });
        // Secondary offset tangled coil loop
        const coilPts2 = [];
        for (let k = 0; k <= 28; k++) {
          const u = k / 28;
          const lx = -rb.len * 0.42 + u * rb.len * 0.84;
          const ang = u * 5 * Math.PI * 2 + 1.4;
          coilPts2.push(tf(lx, 0.44 + Math.sin(ang) * 0.32, Math.cos(ang) * 0.34));
        }
        bMetal.addTube(coilPts2, 0.012, 4, { color: [0.52, 0.46, 0.40] });
      }
      addStaticCol('razorwire', [rb.x - rb.len * 0.46, ry, rb.z - 0.55], [rb.x + rb.len * 0.46, ry + 0.98, rb.z + 0.55], {
        type: 'cover', material: 'metal', passableForBullets: true
      });
    }

    // J. Grounded Ammo Resupply Crates (at West RU staging + Sector A, B, C)
    ammoCrates = [];
    const crateSpots = [
      { x: -74.0, z: -7.5, sector: -1 },
      { x: -33.0, z: 10.8, sector: 0 },
      { x: 7.8,   z: -11.4, sector: 1 },
      { x: 46.8,  z: 4.5, sector: 2 },
      { x: 54.5,  z: -2.0, sector: 2, yRef: 0.6 } // Inside Sector C HQ Hall!
    ];
    for (let i = 0; i < crateSpots.length; i++) {
      const cs = crateSpots[i];
      const cy = DF.Physics ? DF.Physics.getGroundY(cs.x, cs.z, cs.yRef || 0.5) : terrainHeight(cs.x, cs.z);
      if (bCrate && bDark) {
        // Double stacked military green ammo boxes + stenciled lid
        bCrate.addBeveledBox(cs.x, cy + 0.34, cs.z, 1.45, 0.68, 0.92, 0.025, {
          color: [0.85, 0.92, 0.78], unitUV: true, aoBottom: 0.58
        });
        bCrate.addBeveledBox(cs.x - 0.15, cy + 0.84, cs.z + 0.04, 0.96, 0.34, 0.62, 0.02, {
          color: [0.78, 0.86, 0.72], unitUV: true, rotY: 0.12
        });
        // Steel corner latches
        bDark.addBox(cs.x, cy + 0.68, cs.z, 1.50, 0.06, 0.96, { color: [0.24, 0.26, 0.25] });
      }
      addStaticCol('ammo_crate', [cs.x - 0.74, cy, cs.z - 0.48], [cs.x + 0.74, cy + 1.02, cs.z + 0.48], {
        type: 'cover', material: 'wood'
      });
      ammoCrates.push({
        pos: [cs.x, cy, cs.z],
        radius: 3.0,
        sectorIdx: cs.sector
      });
    }

    // K. Sector Flagpoles (dynamically displaying UA or RU procedural flag texture!)
    flagPoles = [];
    const poleCoords = [
      { sectorIdx: 0, x: -35.0, z: 9.2 },
      { sectorIdx: 1, x: 4.0,   z: -11.2 },
      { sectorIdx: 2, x: 47.4,  z: -8.6 }
    ];
    for (let i = 0; i < poleCoords.length; i++) {
      const pc = poleCoords[i];
      const py = DF.Physics ? DF.Physics.getGroundY(pc.x, pc.z, 0.5) : terrainHeight(pc.x, pc.z);
      if (bDark && bConc) {
        bConc.addCylinder(pc.x, py + 0.20, pc.z, 0.36, 0.44, 0.42, 8, { color: [0.72, 0.71, 0.68], aoBottom: 0.55 });
        bDark.addCylinder(pc.x, py + 4.4, pc.z, 0.055, 0.085, 8.6, 8, { color: [0.45, 0.46, 0.48] });
      }
      flagPoles.push({
        sectorIdx: pc.sectorIdx,
        pos: [pc.x, py + 7.25, pc.z],
        mat: new Float32Array(16)
      });
    }

    // L. Dense Donbas Urban Street Storytelling & Military Fortifications (Bus Stops, Kiosk, Electrical Transformers, Overhead Catenary Powerlines, Czech Hedgehogs, Hesco Bastions, Lenin Plaza Park Benches/Planters/Columns, Field Supply Canopies w/ Mortars/Radios/Jerrycans, Street Signs & Curb Scrub!)
    buildStreetStorytelling(bm, lampXs);
  }

  function buildStreetStorytelling(bm, lampXs) {
    const bConc = bm.get('concrete', { texKey: 'concrete', color: [0.80, 0.79, 0.76], roughness: 0.88, metalness: 0.04 });
    const bDmg = bm.get('concrete_damaged', { texKey: 'concrete_damaged', color: [0.72, 0.71, 0.68], roughness: 0.94, metalness: 0.02 });
    const bMetal = bm.get('metal_rust', { texKey: 'metal_rust', color: [0.54, 0.46, 0.38], roughness: 0.76, metalness: 0.64 });
    const bDark = bm.get('metal_dark', { texKey: 'metal_dark', color: [0.26, 0.28, 0.30], roughness: 0.60, metalness: 0.72 });
    const bWood = bm.get('wood', { texKey: 'wood', color: [0.56, 0.46, 0.36], roughness: 0.94, metalness: 0.02 });
    const bSand = bm.get('sandbag', { texKey: 'sandbag', color: [0.76, 0.71, 0.60], roughness: 0.96, metalness: 0.0 });
    const bTarp = bm.get('crate_mil', { texKey: 'crate_mil', color: [0.52, 0.58, 0.46], roughness: 0.92, metalness: 0.04 });
    const bPlaster = bm.get('plaster', { texKey: 'plaster', color: [0.82, 0.82, 0.80], roughness: 0.88, metalness: 0.02 });
    const bBark = bm.get('tree_bark', { texKey: 'wood', color: [0.44, 0.40, 0.34], roughness: 0.98, metalness: 0.0 });

    // 1. Sagging Overhead Catenary Powerlines & Trolleybus Wires linking avenue utility poles (Y = 5.6..6.1m, 100% clear of tanks!)
    if (bDark && lampXs && lampXs.length >= 2) {
      const addCatenary = (p0, p1, sag) => {
        const pts = [];
        for (let k = 0; k <= 6; k++) {
          const u = k / 6;
          const drop = 4 * u * (1 - u) * sag;
          pts.push([
            p0[0] + (p1[0] - p0[0]) * u,
            p0[1] + (p1[1] - p0[1]) * u - drop,
            p0[2] + (p1[2] - p0[2]) * u
          ]);
        }
        bDark.addTube(pts, 0.020, 4, { color: [0.16, 0.17, 0.18] });
      };

      for (let i = 0; i < lampXs.length - 1; i++) {
        const x0 = lampXs[i], x1 = lampXs[i + 1];
        for (const zSign of [-1, 1]) {
          const lz = zSign * 11.4;
          // Twin roadside power cables along North & South pole rows
          addCatenary([x0, 5.85, lz - 0.55], [x1, 5.85, lz - 0.55], 0.55);
          addCatenary([x0, 5.85, lz + 0.55], [x1, 5.85, lz + 0.55], 0.62);
        }
        // Overhead cross-avenue trolleybus support span wires every second pole
        if (i % 2 === 0) {
          addCatenary([x0, 5.90, -11.4], [x0, 5.90, 11.4], 0.42);
        }
      }
      // Snapped dangling power cable hanging dramatically near Sector A damaged pole (-24, -11.4)
      bDark.addTube([[-24.0, 5.80, -11.4], [-23.4, 3.80, -10.8], [-22.8, 1.95, -10.5], [-22.6, 0.85, -10.2]], 0.022, 4, { color: [0.18, 0.18, 0.20] });
    }

    // 2. Two Authentic Soviet Precast Concrete Bus Stop Shelters (cantilever roof, windbreak slabs, slatted wood bench, route sign, trash bin!)
    const busStops = [
      { x: -22.5, z: -12.8, face: 1 },  // North side facing South avenue
      { x: 22.8,  z: 12.8,  face: -1 }  // South side facing North avenue
    ];
    for (let i = 0; i < busStops.length; i++) {
      const bs = busStops[i];
      const by = DF.Physics ? DF.Physics.getGroundY(bs.x, bs.z, 0.5) : terrainHeight(bs.x, bs.z);
      const f = bs.face;
      if (bConc && bWood && bDark && bMetal) {
        // Raised concrete platform floor
        bConc.addBeveledBox(bs.x, by + 0.08, bs.z, 5.2, 0.16, 2.3, 0.02, { color: [0.74, 0.73, 0.70], aoBottom: 0.58 });
        // Cantilevered sloping concrete roof canopy + fascia trim
        bConc.addBeveledBox(bs.x, by + 2.66, bs.z + f * 0.15, 5.5, 0.22, 2.65, 0.03, {
          color: [0.76, 0.75, 0.72], rotX: f * 0.05, uvScale: 0.4
        });
        // Rear concrete windbreak wall (with weathered blue-grey transit stripe) + two side half-walls
        bConc.addBeveledBox(bs.x, by + 1.38, bs.z - f * 1.02, 5.0, 2.48, 0.22, 0.02, { color: [0.78, 0.78, 0.76], uvScale: 0.4, aoBottom: 0.56 });
        bMetal.addBox(bs.x, by + 1.85, bs.z - f * 0.89, 4.6, 0.42, 0.04, { color: [0.32, 0.48, 0.58] });
        for (const sx of [-2.42, 2.42]) {
          bConc.addBeveledBox(bs.x + sx, by + 1.38, bs.z - f * 0.18, 0.20, 2.48, 1.65, 0.02, { color: [0.74, 0.74, 0.72], aoBottom: 0.56 });
          bDark.addCylinder(bs.x + sx, by + 1.38, bs.z + f * 0.98, 0.055, 0.055, 2.52, 8, { color: [0.28, 0.30, 0.32] });
        }
        // Slatted wooden waiting bench inside shelter
        bWood.addBox(bs.x, by + 0.52, bs.z - f * 0.55, 3.6, 0.07, 0.46, { color: [0.60, 0.48, 0.36] });
        bWood.addBox(bs.x, by + 0.88, bs.z - f * 0.76, 3.6, 0.26, 0.06, { color: [0.58, 0.46, 0.34] });
        for (const lx of [-1.45, 0, 1.45]) {
          bDark.addBox(bs.x + lx, by + 0.28, bs.z - f * 0.55, 0.07, 0.44, 0.40, { color: [0.24, 0.25, 0.27] });
        }
        // Transit stop flagpole & timetable sign + rusted street bin
        bDark.addCylinder(bs.x + 3.0, by + 1.45, bs.z + f * 0.75, 0.035, 0.04, 2.9, 6, { color: [0.34, 0.35, 0.37] });
        bMetal.addBeveledBox(bs.x + 3.0, by + 2.62, bs.z + f * 0.75, 0.62, 0.56, 0.06, 0.01, { color: [0.26, 0.46, 0.68] });
        bMetal.addCylinder(bs.x - 3.0, by + 0.38, bs.z + f * 0.72, 0.24, 0.20, 0.72, 10, { color: [0.48, 0.42, 0.36], aoBottom: 0.55 });
      }
      addStaticCol('busstop_back', [bs.x - 2.6, by, bs.z - f * 1.15 - 0.14], [bs.x + 2.6, by + 2.6, bs.z - f * 1.15 + 0.14], { type: 'cover', material: 'concrete' });
      addStaticCol('busstop_roof', [bs.x - 2.75, by + 2.52, bs.z - 1.2], [bs.x + 2.75, by + 2.80, bs.z + 1.4], { type: 'floor', material: 'concrete' });
      addCover([bs.x, by, bs.z - f * 1.65], [0, 0, f], 1.8, i === 0 ? 0 : 1, null, null);
    }

    // 3. Street-Corner Soviet Metal Newsstand / Kiosk (-15.8, -14.2) & Two High-Voltage Electrical Transformer Cabinets!
    {
      const kx = -15.8, kz = -14.2;
      const ky = terrainHeight(kx, kz);
      if (bMetal && bDark && bConc && bPlaster) {
        bConc.addBox(kx, ky + 0.08, kz, 3.6, 0.18, 2.6, { color: [0.68, 0.67, 0.65], aoBottom: 0.56 });
        // Ribbed metal kiosk cabin (faded blue-green Soviet Soyuzpechat kiosk!)
        bMetal.addBeveledBox(kx, ky + 1.32, kz, 3.3, 2.38, 2.3, 0.03, { color: [0.42, 0.54, 0.52], uvScale: 0.5, aoBottom: 0.54 });
        // Overhanging sloped corrugated awning roof + service window shutter & counter ledge
        bDark.addBeveledBox(kx, ky + 2.62, kz + 0.22, 3.7, 0.18, 2.95, 0.025, { color: [0.32, 0.34, 0.36], rotX: 0.07 });
        bDark.addBox(kx, ky + 1.56, kz + 1.17, 1.95, 0.96, 0.08, { color: [0.14, 0.16, 0.18] }); // Dark shattered service window
        bPlaster.addBeveledBox(kx, ky + 1.04, kz + 1.28, 2.15, 0.09, 0.34, 0.015, { color: [0.74, 0.72, 0.68] }); // Counter sill
        bPlaster.addBox(kx, ky + 2.30, kz + 1.18, 2.85, 0.32, 0.06, { color: [0.76, 0.34, 0.26] }); // Faded kiosk fascia sign
      }
      addStaticCol('kiosk', [kx - 1.7, ky, kz - 1.2], [kx + 1.7, ky + 2.75, kz + 1.25], { type: 'wall', material: 'metal' });
      addCover([kx - 2.3, ky, kz], [1, 0, 0], 1.8, 1, null, null);
      addCover([kx + 2.3, ky, kz], [-1, 0, 0], 1.8, 1, 'UA', null);
    }

    // Two Industrial Electrical Transformer Cabinets (ceramic high-voltage roof insulators + yellow hazard placard!)
    const transformers = [
      { x: 23.0,  z: -14.0, rot: 0 },
      { x: -56.0, z: 13.8,  rot: Math.PI }
    ];
    for (let i = 0; i < transformers.length; i++) {
      const tr = transformers[i];
      const ty = terrainHeight(tr.x, tr.z);
      if (bConc && bMetal && bDark && bPlaster) {
        bConc.addBeveledBox(tr.x, ty + 0.12, tr.z, 2.4, 0.24, 1.7, 0.02, { color: [0.70, 0.69, 0.66], aoBottom: 0.56 });
        bMetal.addBeveledBox(tr.x, ty + 1.24, tr.z, 2.15, 2.02, 1.45, 0.03, { color: [0.46, 0.52, 0.46], uvScale: 0.6, aoBottom: 0.55 });
        bDark.addBeveledBox(tr.x, ty + 2.30, tr.z, 2.32, 0.14, 1.62, 0.02, { color: [0.30, 0.32, 0.33] });
        // Cooling fin louvers & yellow/black electrical hazard sign
        bDark.addBox(tr.x, ty + 1.22, tr.z + (i === 0 ? 0.74 : -0.74), 1.42, 0.62, 0.06, { color: [0.22, 0.24, 0.25] });
        bPlaster.addBox(tr.x - 0.55, ty + 1.72, tr.z + (i === 0 ? 0.75 : -0.75), 0.34, 0.30, 0.04, { color: [0.90, 0.74, 0.16] });
        // 3 Ceramic high-voltage rooftop ribbed insulators!
        for (const ix of [-0.56, 0, 0.56]) {
          bPlaster.addCylinder(tr.x + ix, ty + 2.66, tr.z, 0.08, 0.11, 0.58, 8, { color: [0.84, 0.82, 0.78] });
          bDark.addCylinder(tr.x + ix, ty + 2.98, tr.z, 0.04, 0.04, 0.10, 6, { color: [0.32, 0.34, 0.36] });
        }
      }
      addStaticCol('transformer', [tr.x - 1.15, ty, tr.z - 0.82], [tr.x + 1.15, ty + 2.45, tr.z + 0.82], { type: 'cover', material: 'metal' });
      addCover([tr.x + 1.75, ty, tr.z], [-1, 0, 0], 1.8, i === 0 ? 2 : 0, null, null);
    }

    // 4. Steel Czech Hedgehog Anti-Tank X-Barricades (3 mutually perpendicular crossed riveted steel I-beams!)
    const hedgehogs = [
      [-48.0, -4.4], [-48.2, 5.2], [-25.0, -10.8], [19.5, -10.4], [34.2, -4.4], [34.4, 3.8]
    ];
    for (let i = 0; i < hedgehogs.length; i++) {
      const hx = hedgehogs[i][0], hz = hedgehogs[i][1];
      const hy = terrainHeight(hx, hz);
      if (bDark && bMetal) {
        const yC = hy + 0.68;
        const rot = i * 0.55;
        // 3 orthogonal crossed steel I-beams (1.75m long, resting firmly at Y=0!)
        bMetal.addBeveledBox(hx, yC, hz, 1.76, 0.14, 0.14, 0.015, { color: [0.46, 0.38, 0.32], rotY: rot, rotZ: 0.78 });
        bMetal.addBeveledBox(hx, yC, hz, 1.76, 0.14, 0.14, 0.015, { color: [0.44, 0.36, 0.30], rotY: rot + 2.09, rotZ: 0.78 });
        bMetal.addBeveledBox(hx, yC, hz, 1.76, 0.14, 0.14, 0.015, { color: [0.48, 0.40, 0.34], rotY: rot + 4.19, rotZ: 0.78 });
        // Center bolted steel gusset clamp plate
        bDark.addBeveledBox(hx, yC, hz, 0.30, 0.30, 0.30, 0.02, { color: [0.28, 0.28, 0.30], rotY: rot });
      }
      addStaticCol('hedgehog', [hx - 0.68, hy, hz - 0.68], [hx + 0.68, hy + 1.25, hz + 0.68], { type: 'cover', material: 'metal' });
    }

    // 5. Modular Military Hesco Bastion Wire-Basket Defense Walls (galvanized mesh ribs + sand-filled cores!)
    const hescos = [
      { x: -30.0, z: -8.6, rot: 0.15, n: 2, sec: 0 },
      { x: 10.6,  z: -9.8, rot: -0.10, n: 2, sec: 1 },
      { x: 45.6,  z: -6.8, rot: 0.06, n: 2, sec: 2 },
      { x: 45.6,  z: 3.4,  rot: -0.06, n: 2, sec: 2 }
    ];
    for (let i = 0; i < hescos.length; i++) {
      const h = hescos[i];
      const hy = terrainHeight(h.x, h.z);
      const c = Math.cos(h.rot), s = Math.sin(h.rot);
      for (let k = 0; k < h.n; k++) {
        const off = (k - (h.n - 1) * 0.5) * 1.22;
        const bx = h.x + off * s;
        const bz = h.z + off * c;
        if (bSand && bDark) {
          // Sand-filled fabric bastion cell (1.15m x 1.32m x 1.15m)
          bSand.addBeveledBox(bx, hy + 0.66, bz, 1.14, 1.32, 1.14, 0.03, {
            color: [0.74 + (k % 2) * 0.04, 0.69, 0.58], rotY: h.rot, uvScale: 0.7, aoBottom: 0.56
          });
          // Galvanized welded-wire basket frame ribs around exterior
          for (const wy of [0.18, 0.66, 1.14]) {
            bDark.addBox(bx, hy + wy, bz, 1.18, 0.035, 1.18, { color: [0.46, 0.48, 0.50], rotY: h.rot });
          }
          for (const cx of [-0.57, 0.57]) {
            for (const cz of [-0.57, 0.57]) {
              const px = bx + cx * c + cz * s;
              const pz = bz - cx * s + cz * c;
              bDark.addCylinder(px, hy + 0.66, pz, 0.022, 0.022, 1.34, 5, { color: [0.46, 0.48, 0.50] });
            }
          }
        }
        addStaticCol('hesco', [bx - 0.60, hy, bz - 0.60], [bx + 0.60, hy + 1.34, bz + 0.60], { type: 'cover', material: 'sandbag' });
      }
      addCover([h.x + 1.25, hy, h.z], [-1, 0, 0], 1.32, h.sec, 'UA', null);
    }

    // 6. Upgraded Lenin Plaza Civic Park (4 Fluted Broken Columns, 4 Shattered Park Benches, 4 Concrete Planters w/ Charred Shrubs, Broken Ornamental Cast-Iron Park Fencing!)
    {
      // 4 Concrete civic planters with dark earth & charred winter shrub branches around Lenin Square
      const planters = [[-2.8, -11.4], [10.8, -11.4], [-2.8, 11.4], [10.8, 11.4]];
      for (let i = 0; i < planters.length; i++) {
        const px = planters[i][0], pz = planters[i][1];
        const py = terrainHeight(px, pz);
        if (bConc && bDmg && bBark) {
          bConc.addBeveledBox(px, py + 0.34, pz, 1.75, 0.68, 1.75, 0.03, { color: [0.74, 0.72, 0.69], uvScale: 0.5, aoBottom: 0.55 });
          bDmg.addBox(px, py + 0.64, pz, 1.42, 0.14, 1.42, { color: [0.34, 0.30, 0.26] });
          // Charred gnarled shrub twigs sprouting from planter
          for (let t = 0; t < 4; t++) {
            const a = (t / 4) * Math.PI * 2 + i * 0.7;
            bBark.addTube([
              [px + Math.cos(a) * 0.25, py + 0.66, pz + Math.sin(a) * 0.25],
              [px + Math.cos(a) * 0.48, py + 1.12, pz + Math.sin(a) * 0.48],
              [px + Math.cos(a + 0.4) * 0.68, py + 1.36, pz + Math.sin(a + 0.4) * 0.68]
            ], [0.038, 0.022, 0.010], 4, { color: [0.36, 0.33, 0.29] });
          }
        }
        addStaticCol('planter', [px - 0.88, py, pz - 0.88], [px + 0.88, py + 0.70, pz + 0.88], { type: 'cover', material: 'concrete' });
      }

      // 4 Shattered Soviet Park Benches lining Lenin Square & cross-streets
      const benches = [
        { x: -1.5, z: -12.6, rot: 0 },
        { x: 8.5,  z: -12.6, rot: 0.08 },
        { x: -1.5, z: 12.6,  rot: Math.PI },
        { x: 8.5,  z: 12.6,  rot: Math.PI - 0.12 }
      ];
      for (let i = 0; i < benches.length; i++) {
        const bn = benches[i];
        const by = terrainHeight(bn.x, bn.z);
        if (bWood && bDark) {
          bWood.addBox(bn.x, by + 0.46, bn.z, 2.05, 0.06, 0.46, { color: [0.56, 0.45, 0.34], rotY: bn.rot });
          bWood.addBox(bn.x, by + 0.80, bn.z + (i < 2 ? -0.22 : 0.22), 1.98, 0.26, 0.06, { color: [0.54, 0.43, 0.32], rotY: bn.rot, rotZ: i % 2 === 0 ? 0.05 : -0.04 });
          for (const lx of [-0.78, 0.78]) {
            bDark.addBox(bn.x + lx, by + 0.24, bn.z, 0.08, 0.46, 0.44, { color: [0.20, 0.21, 0.23], rotY: bn.rot });
          }
        }
        addStaticCol('bench', [bn.x - 1.02, by, bn.z - 0.30], [bn.x + 1.02, by + 0.86, bn.z + 0.30], { type: 'cover', material: 'wood' });
      }

      // 4 Fluted Broken Decorative Civic Columns & Ornamental Cast-Iron Park Railings flanking Lenin Square!
      const cols = [[-6.5, -13.2, 2.8], [14.5, -13.2, 2.1], [-6.5, 13.2, 2.4], [14.5, 13.2, 3.1]];
      for (let i = 0; i < cols.length; i++) {
        const cx = cols[i][0], cz = cols[i][1], ch = cols[i][2];
        const cy = terrainHeight(cx, cz);
        if (bConc && bDark) {
          bConc.addBeveledBox(cx, cy + 0.24, cz, 0.84, 0.48, 0.84, 0.03, { color: [0.74, 0.73, 0.70], aoBottom: 0.54 });
          bConc.addCylinder(cx, cy + 0.48 + ch * 0.5, cz, 0.26, 0.30, ch, 10, { color: [0.78, 0.77, 0.74], uvScale: 0.5 });
          // Short broken ornamental cast-iron park fence segment attached to each pillar
          const fx = cx + (cx < 4 ? 1.8 : -1.8);
          bDark.addBox(fx, cy + 0.92, cz, 2.4, 0.045, 0.045, { color: [0.20, 0.21, 0.23] });
          bDark.addBox(fx, cy + 0.24, cz, 2.4, 0.045, 0.045, { color: [0.20, 0.21, 0.23] });
          for (let p = -4; p <= 4; p++) {
            bDark.addCylinder(fx + p * 0.26, cy + 0.58, cz, 0.016, 0.016, 0.72, 5, { color: [0.22, 0.23, 0.25] });
          }
        }
        addStaticCol('plaza_col', [cx - 0.42, cy, cz - 0.42], [cx + 0.42, cy + ch + 0.5, cz + 0.42], { type: 'cover', material: 'concrete' });
      }
    }

    // 7. Military Field Supply Canopies / Camo-Netted Sandbag Command Posts (Ammo, Jerrycans, Deployed 82mm Mortar Tube & Field Radio!)
    const supplyPosts = [
      { x: -33.0, z: 11.4, sec: 0 },
      { x: 7.8,   z: -11.8, sec: 1 },
      { x: 46.8,  z: 4.8, sec: 2 }
    ];
    for (let i = 0; i < supplyPosts.length; i++) {
      const sp = supplyPosts[i];
      const sy = DF.Physics ? DF.Physics.getGroundY(sp.x, sp.z, 0.5) : terrainHeight(sp.x, sp.z);
      if (bTarp && bDark && bMetal) {
        // 4 corner steel canopy poles + draped matte olive camo tarp overhead (Y = 2.45m walk-under clearance!)
        for (const px of [-1.45, 1.45]) {
          for (const pz of [-1.15, 1.15]) {
            bDark.addCylinder(sp.x + px, sy + 1.24, sp.z + pz, 0.032, 0.036, 2.48, 6, { color: [0.28, 0.30, 0.28] });
          }
        }
        bTarp.addBeveledBox(sp.x, sy + 2.48, sp.z, 3.25, 0.08, 2.62, 0.02, {
          color: [0.46, 0.52, 0.40], rotX: 0.04, rotZ: -0.03, uvScale: 0.6
        });
        // Olive steel Jerrycans + field radio transceiver on crate
        bMetal.addBeveledBox(sp.x + 1.02, sy + 0.24, sp.z + 0.35, 0.20, 0.46, 0.34, 0.02, { color: [0.36, 0.44, 0.32], rotY: 0.3, aoBottom: 0.56 });
        bMetal.addBeveledBox(sp.x + 1.08, sy + 0.24, sp.z - 0.12, 0.20, 0.46, 0.34, 0.02, { color: [0.64, 0.22, 0.18], rotY: -0.2, aoBottom: 0.56 });
        bDark.addBeveledBox(sp.x + 0.32, sy + 0.86, sp.z - 0.12, 0.36, 0.28, 0.28, 0.015, { color: [0.26, 0.32, 0.26] });
        bDark.addCylinder(sp.x + 0.32, sy + 1.42, sp.z - 0.18, 0.008, 0.012, 0.88, 5, { color: [0.36, 0.38, 0.40] });
        // Deployed 82mm Infantry Mortar Tube on heavy circular baseplate + bipod legs!
        const mx = sp.x - 1.15, mz = sp.z - 0.35;
        bDark.addCylinder(mx, sy + 0.05, mz, 0.32, 0.36, 0.09, 10, { color: [0.26, 0.28, 0.27] });
        bDark.addCylinder(mx - 0.22, sy + 0.62, mz, 0.055, 0.062, 1.24, 10, { color: [0.32, 0.35, 0.32], rotZ: 0.48 });
        bDark.addTube([[mx - 0.38, sy + 0.82, mz], [mx - 0.62, sy + 0.02, mz - 0.32]], 0.018, 5, { color: [0.26, 0.28, 0.28] });
        bDark.addTube([[mx - 0.38, sy + 0.82, mz], [mx - 0.62, sy + 0.02, mz + 0.32]], 0.018, 5, { color: [0.26, 0.28, 0.28] });
      }
    }

    // 8. Bent Ukrainian/Soviet Street Signposts & Dry Steppe Curbside Winter Scrub Tufts
    const signs = [
      { x: -46.8, z: -10.8, col: [0.24, 0.44, 0.72] },
      { x: -29.2, z: 10.8,  col: [0.76, 0.22, 0.18] },
      { x: -8.5,  z: -11.0, col: [0.84, 0.68, 0.18] },
      { x: 17.0,  z: 11.0,  col: [0.24, 0.44, 0.72] },
      { x: 36.2,  z: -10.6, col: [0.76, 0.22, 0.18] }
    ];
    if (bDark && bMetal && bBark) {
      for (let i = 0; i < signs.length; i++) {
        const sg = signs[i];
        const sy = DF.Physics ? DF.Physics.getGroundY(sg.x, sg.z, 0.5) : terrainHeight(sg.x, sg.z);
        const tilt = (i % 2 === 0 ? 1 : -1) * 0.09;
        bDark.addCylinder(sg.x, sy + 1.38, sg.z, 0.032, 0.036, 2.76, 6, { color: [0.42, 0.43, 0.45], rotZ: tilt });
        bMetal.addBeveledBox(sg.x + tilt * 1.1, sy + 2.52, sg.z, 0.68, 0.52, 0.04, 0.01, { color: sg.col, rotY: Math.PI * 0.5, rotZ: tilt });
      }
      // Curbside dry winter scrub weeds sprouting from sidewalk/wall cracks
      const scrubRng = mulberry32(9917);
      const scrubPts = [
        [-60, -12.6], [-48, -13.4], [-25, -12.8], [-12, -14.2], [18, -13.6], [30, -14.6],
        [-58, 12.6],  [-26, 12.8],  [-11, 14.2],  [19, 13.4],  [46, -12.8], [46, 12.8]
      ];
      for (let i = 0; i < scrubPts.length; i++) {
        const sx = scrubPts[i][0], sz = scrubPts[i][1];
        const sy = terrainHeight(sx, sz);
        for (let st = 0; st < 5; st++) {
          const a = (st / 5) * Math.PI * 2 + scrubRng() * 0.8;
          const h = 0.28 + scrubRng() * 0.34;
          const spread = 0.18 + scrubRng() * 0.24;
          bBark.addTube([
            [sx, sy - 0.04, sz],
            [sx + Math.cos(a) * spread * 0.5, sy + h * 0.6, sz + Math.sin(a) * spread * 0.5],
            [sx + Math.cos(a) * spread, sy + h, sz + Math.sin(a) * spread]
          ], [0.022, 0.014, 0.007], 4, { color: [0.46, 0.42, 0.33] });
        }
      }
    }
  }

  // ---- Grounded Spawn Tables ----
  // Note: src/main.js uses forward = (-sin(yaw), 0, -cos(yaw)):
  //   yaw = -PI/2 -> faces +X (East, RU attackers)
  //   yaw = +PI/2 -> faces -X (West, UA defenders)
  const RAW_SPAWNS = {
    RU: [
      // Sector 0 assault staging (West X in [-84..-62], 22 distinct grounded slots!)
      [
        { x: -78, z: -4.5, y: 0.5 }, { x: -78, z: 0.5, y: 0.5 },  { x: -78, z: 5.5, y: 0.5 },
        { x: -73, z: -6.2, y: 0.5 }, { x: -73, z: -1.5, y: 0.5 }, { x: -73, z: 3.5, y: 0.5 },
        { x: -67, z: -7.0, y: 0.5 }, { x: -67, z: -1.0, y: 0.5 }, { x: -67, z: 4.5, y: 0.5 },
        { x: -82, z: -3.0, y: 0.5 }, { x: -82, z: 3.0, y: 0.5 },  { x: -82, z: 8.0, y: 0.5 },
        // North Flank Squad
        { x: -76, z: -37.0, y: 0.5 }, { x: -72, z: -40.5, y: 0.5 }, { x: -68, z: -36.5, y: 0.5 },
        { x: -64, z: -41.0, y: 0.5 }, { x: -79, z: -41.5, y: 0.5 },
        // South Flank Squad
        { x: -76, z: 37.0, y: 0.5 },  { x: -72, z: 40.5, y: 0.5 },  { x: -68, z: 36.5, y: 0.5 },
        { x: -64, z: 41.0, y: 0.5 },  { x: -79, z: 41.5, y: 0.5 }
      ],
      // Sector 1 forward staging (after Sector A captured)
      [
        { x: -42, z: -2.0, y: 0.5 }, { x: -42, z: 2.5, y: 0.5 },  { x: -38, z: 6.0, y: 0.5 },
        { x: -34, z: -1.5, y: 0.5 }, { x: -34, z: 3.5, y: 0.5 },  { x: -29, z: 0.0, y: 0.5 },
        { x: -46, z: -6.5, y: 0.5 }, { x: -46, z: 1.0, y: 0.5 },  { x: -39, z: -17.5, y: 0.5 },
        { x: -37, z: 17.5, y: 0.5 }, { x: -45, z: -38.0, y: 0.5 }, { x: -40, z: -41.0, y: 0.5 },
        { x: -34, z: -37.5, y: 0.5 }, { x: -44, z: 38.0, y: 0.5 }, { x: -38, z: 41.0, y: 0.5 },
        { x: -32, z: 37.5, y: 0.5 }, { x: -26, z: -5.0, y: 0.5 }, { x: -26, z: 5.0, y: 0.5 },
        { x: -50, z: -2.0, y: 0.5 }, { x: -50, z: 3.0, y: 0.5 }
      ],
      // Sector 2 forward staging (after Sector B captured)
      [
        { x: -6, z: -2.0, y: 0.5 },  { x: -6, z: 3.5, y: 0.5 },   { x: 0, z: -6.0, y: 0.5 },
        { x: 0, z: 6.5, y: 0.5 },    { x: 6, z: -3.5, y: 0.5 },   { x: 6, z: 5.5, y: 0.5 },
        { x: 12, z: -1.5, y: 0.5 },  { x: 12, z: 3.0, y: 0.5 },   { x: -6.5, z: -19.0, y: 0.5 },
        { x: 4, z: 22.0, y: 0.5 },   { x: -8, z: -38.0, y: 0.5 }, { x: 2, z: -39.5, y: 0.5 },
        { x: 12, z: -38.0, y: 0.5 }, { x: -6, z: 38.0, y: 0.5 },  { x: 4, z: 39.5, y: 0.5 },
        { x: 14, z: 38.0, y: 0.5 },  { x: 18, z: -1.0, y: 0.5 },  { x: 18, z: 3.0, y: 0.5 },
        { x: -14, z: 0.0, y: 0.5 },  { x: -14, z: 3.5, y: 0.5 }
      ]
    ],
    UA: [
      // Sector 0 defense (All 5 UA defenders shielded behind sturdy trench / fortified 1F & 2F rooms!)
      [
        { x: -29.2, z: -3.2, y: 0.5 },    // Ground crossroads sandbag trench + trolleybus hard cover (Player start!)
        { x: -38.0, z: -15.6, y: 4.1 },   // Building 1 Floor 2 South window overlooking Sector A!
        { x: -36.0, z: 15.6, y: 4.1 },    // Building 2 Floor 2 North window overlooking Sector A!
        { x: -31.5, z: -16.8, y: 0.5 },   // Building 1 Floor 1 fortified interior window
        { x: -30.5, z: 16.8, y: 0.5 },    // Building 2 Floor 1 fortified interior window
        { x: -29.5, z: -6.2, y: 0.5 },    // Crossroads north sandbag wing
        { x: -22.0, z: 2.5, y: 0.5 },     // Reserve cover
        { x: -31.0, z: -21.0, y: 0.5 }    // Building 1 ground hall
      ],
      // Sector 1 defense (Lenin Square + Building 3 & 4 2nd floor overwatch)
      [
        { x: 11.2, z: -1.5, y: 0.5 },     // Lenin Square east barricade
        { x: 2.0,  z: -16.6, y: 4.1 },    // Building 3 Floor 2 overwatch
        { x: 4.0,  z: 16.6, y: 4.1 },     // Building 4 Floor 2 overwatch
        { x: 11.5, z: 4.5, y: 0.5 },      // Square south sandbags
        { x: 12.0, z: -37.5, y: 0.5 },    // North flank defense
        { x: 14.0, z: 37.5, y: 0.5 },     // South flank defense
        { x: 20.0, z: 0.0, y: 0.5 },
        { x: 10.2, z: -18.5, y: 0.5 }
      ],
      // Sector 2 defense (Sector C Municipal Command HQ — Ground, Floor 2, Roof Y=7.45, Pillbox!)
      [
        { x: 52.0, z: -1.5, y: 4.1 },     // HQ Floor 2 Command Room overlooking courtyard
        { x: 52.5, z: 2.5, y: 7.7 },      // HQ Rooftop Sniper Parapet (Y = 7.45!)
        { x: 39.2, z: 9.0, y: 0.5 },      // Courtyard Pillbox Bunker!
        { x: 46.2, z: -1.0, y: 0.5 },     // HQ Courtyard sandbag line
        { x: 31.5, z: -22.5, y: 7.7 },    // Building 5 Rooftop overwatch (Y = 7.45!)
        { x: 54.0, z: 4.5, y: 0.5 },      // HQ Ground Hall
        { x: 70.0, z: 0.0, y: 0.5 },      // East rear reserve
        { x: 70.0, z: -16.0, y: 0.5 }
      ]
    ]
  };

  // ---- Public API: DF.Map ----
  const MapModule = {
    init(gl) {
      staticBatches = [];
      ammoCrates = [];
      vaultWindows = [];
      flagPoles = [];
      wreckFires = [];
      interiorLights = [];
      colliderSeq = 1;
      destSeq = 1;
      fireSmokeAccum = 0;
      lastRenderTime = 0;

      // Bind exact continuous crater terrain height function to DF.Physics
      if (DF.Physics && typeof DF.Physics.setTerrainHeightFn === 'function') {
        DF.Physics.setTerrainHeightFn(terrainHeight);
      }

      // Initialize the 3 Breakthrough Sectors (exact coordinates & names from DESIGN.md)
      sectors = [
        {
          id: 'A',
          name: '前线十字路口街垒',
          pos: [-38, 0, 0],
          radius: 15,
          owner: 'UA',
          progress: 0,
          active: true
        },
        {
          id: 'B',
          name: '中心广场与受损居民楼群',
          pos: [4, 0, 0],
          radius: 18,
          owner: 'UA',
          progress: 0,
          active: false
        },
        {
          id: 'C',
          name: '市政指挥楼核心阵地',
          pos: [52, 0, 0],
          radius: 16,
          owner: 'UA',
          progress: 0,
          active: false
        }
      ];

      // Build shared destructible piece meshes
      buildDestructibleArchetypes(gl);

      // Build static geometry batches & register colliders, destructibles, and cover nodes
      const bm = createBatchManager(gl);

      // 1. Ground terrain, wet asphalt avenue, sidewalks, craters, puddles & horizon ruins
      buildTerrainAndRoads(bm);

      // 2. The 6 Enterable Multi-Story Donbas Soviet Buildings (all stairwells flush against back walls with expanded zero-clipping cutouts & >=2.0m clear landings!)
      // Building 1: Sector A North Khrushchyovka (X[-52..-26], Z[-30..-14])
      buildApartmentBuilding(bm, {
        x0: -52, x1: -26, z0: -30, z1: -14,
        material: 'concrete',
        sectorIdx: 0,
        faceDir: '+z',
        upperTopY: 16.4,
        seed: 101,
        stairs: [
          { x0: -35.5, x1: -29.0, z0: -29.75, z1: -27.05, y0: 0.25, y1: 3.85, dir: '+x', guardRailSide: '+z' }
        ]
      });

      // Building 2: Sector A South Brick Khrushchyovka (X[-50..-24], Z[+14..+30])
      // Note: shearedWest caps West roofline under 13.5m so wireframe diagnostic camera [-42,16,26] has clear vista!
      buildApartmentBuilding(bm, {
        x0: -50, x1: -24, z0: 14, z1: 30,
        material: 'brick',
        sectorIdx: 0,
        faceDir: '-z',
        upperTopY: 15.6,
        shearedWest: true,
        seed: 202,
        stairs: [
          { x0: -33.5, x1: -27.0, z0: 27.05, z1: 29.75, y0: 0.25, y1: 3.85, dir: '+x', guardRailSide: '-z' }
        ]
      });

      // Building 3: Sector B North Precast Soviet Block (X[-12..+18], Z[-31..-15]) with DUAL stairwells!
      buildApartmentBuilding(bm, {
        x0: -12, x1: 18, z0: -31, z1: -15,
        material: 'concrete',
        sectorIdx: 1,
        faceDir: '+z',
        upperTopY: 17.5,
        seed: 303,
        stairs: [
          { x0: -9.0, x1: -2.5, z0: -30.75, z1: -28.05, y0: 0.25, y1: 3.85, dir: '+x', guardRailSide: '+z' },
          { x0: 8.5,  x1: 15.0, z0: -30.75, z1: -28.05, y0: 0.25, y1: 3.85, dir: '-x', guardRailSide: '+z' }
        ]
      });

      // Building 4: Sector B South Brick Municipal Hall (X[-10..+18], Z[+15..+31])
      buildApartmentBuilding(bm, {
        x0: -10, x1: 18, z0: 15, z1: 31,
        material: 'brick',
        sectorIdx: 1,
        faceDir: '-z',
        upperTopY: 14.8,
        seed: 404,
        stairs: [
          { x0: 7.5, x1: 14.0, z0: 28.05, z1: 30.75, y0: 0.25, y1: 3.85, dir: '+x', guardRailSide: '-z' }
        ]
      });

      // Building 5: Sector C North Fortified Barracks Wing (X[+28..+46], Z[-32..-16]) with Accessible Roof Y=7.45!
      buildApartmentBuilding(bm, {
        x0: 28, x1: 46, z0: -32, z1: -16,
        material: 'concrete',
        sectorIdx: 2,
        faceDir: '+z',
        accessibleRoof: true,
        seed: 505,
        stairs: [
          { x0: 31.5, x1: 38.0, z0: -31.75, z1: -29.05, y0: 0.25, y1: 3.85, dir: '+x', guardRailSide: '+z' }
        ],
        roofStair: {
          x0: 36.2, x1: 42.7, z0: -26.8, z1: -24.1, y0: 3.85, y1: 7.45, dir: '-x', guardRailSide: 'both'
        }
      });

      // Building 6: Sector C Municipal Command HQ (X[+50..+66], Z[-13..+13], 3 Levels: F1, F2, Roof Y=7.45!)
      buildCommandHQ(bm);

      // Fortified Courtyard Pillbox & South Fuel Garage Depot
      buildCourtyardPillbox(bm);
      buildSouthGarage(bm);

      // 3. Battlefield Props, Barricades, Wrecks, Trees, Lamps, Ammo Crates & Flags
      buildBattlefieldProps(bm);

      // 4. Finalize batched GPU static meshes
      staticBatches = bm.finalize();

      // 5. Build initial 2m multi-floor A* navigation grid + stair links!
      if (DF.Physics && typeof DF.Physics.buildNavGrid === 'function') {
        DF.Physics.buildNavGrid();
      }
    },

    getSectors() {
      return sectors;
    },

    getAmmoCrates() {
      return ammoCrates;
    },

    getVaultWindows() {
      return vaultWindows;
    },

    getBuildings() {
      return [
        { id: 'B1', label: 'B1', x0: -52, x1: -26, z0: -30, z1: -14, floors: 2, sectorIdx: 0 },
        { id: 'B2', label: 'B2', x0: -50, x1: -24, z0: 14,  z1: 30,  floors: 2, sectorIdx: 0 },
        { id: 'B3', label: 'B3', x0: -12, x1: 18,  z0: -31, z1: -15, floors: 2, sectorIdx: 1 },
        { id: 'B4', label: 'B4', x0: -10, x1: 18,  z0: 15,  z1: 31,  floors: 2, sectorIdx: 1 },
        { id: 'B5', label: 'B5', x0: 28,  x1: 46,  z0: -32, z1: -16, floors: 3, sectorIdx: 2 },
        { id: 'HQ', label: 'HQ', x0: 50,  x1: 66,  z0: -13, z1: 13,  floors: 3, sectorIdx: 2, isHQ: true },
        { id: 'PB', label: 'PB', x0: 37,  x1: 43,  z0: 6,   z1: 12,  floors: 1, sectorIdx: 2 },
        { id: 'DEP', label: 'DEP', x0: 28, x1: 44, z0: 18,  z1: 30,  floors: 1, sectorIdx: 2 }
      ];
    },

    getSpawns(faction, sectorIdx) {
      const f = faction === 'RU' ? 'RU' : 'UA';
      const idx = Math.max(0, Math.min(2, sectorIdx | 0));
      const list = RAW_SPAWNS[f][idx] || RAW_SPAWNS[f][0];
      const baseYaw = f === 'RU' ? -Math.PI * 0.5 : Math.PI * 0.5;
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        const gy = DF.Physics ? DF.Physics.getGroundY(s.x, s.z, s.y) : terrainHeight(s.x, s.z);
        out.push({
          pos: [s.x, gy, s.z],
          yaw: baseYaw
        });
      }
      return out;
    },

    render(renderer, time) {
      if (!renderer || typeof renderer.submitMesh !== 'function') return;
      const t = time || 0;
      const dt = lastRenderTime > 0 ? Math.min(0.1, Math.max(0, t - lastRenderTime)) : 0.016;
      lastRenderTime = t;

      // 1. Submit all pre-baked static batched meshes (~12-15 draw calls total for entire city!)
      for (let i = 0; i < staticBatches.length; i++) {
        const b = staticBatches[i];
        renderer.submitMesh(b.mesh, IDENTITY_MAT, b.material, b.flags);
      }

      // 2. Render dynamic Sector Marker Flags (swapping UA/RU texture with gentle wind sway)
      if (flagMesh) {
        for (let i = 0; i < flagPoles.length; i++) {
          const fp = flagPoles[i];
          const sec = sectors[fp.sectorIdx];
          const isRU = sec && sec.owner === 'RU';
          const windYaw = 0.25 + Math.sin(t * 2.1 + i * 1.4) * 0.16;
          makeYawMatrix(fp.pos[0], fp.pos[1], fp.pos[2], windYaw, 1, 1, 1, fp.mat);
          renderer.submitMesh(
            flagMesh,
            fp.mat,
            {
              texKey: isRU ? 'tactical_flag_ru' : 'tactical_flag_ua',
              color: [0.96, 0.96, 0.96],
              roughness: 0.78,
              metalness: 0.02,
              emissive: [0.05, 0.05, 0.05],
              uvScale: [1, 1],
              alpha: 1.0,
              thermalHeat: 0.18,
              doubleSided: true
            },
            { castShadow: true, receiveShadow: true }
          );
        }
      }

      // 3. Smoldering ambient battlefield wreck fires & burning ruin windows (warm flickering orange point lights + tall billowing smoke columns + floating embers!)
      const hasLights = typeof renderer.addDynamicLight === 'function';
      if (hasLights) {
        for (let i = 0; i < wreckFires.length; i++) {
          const wf = wreckFires[i];
          const flick = 0.78 + 0.22 * Math.sin(t * 14.8 + i * 2.3) + 0.14 * Math.cos(t * 26.3 + i * 1.1);
          renderer.addDynamicLight(
            wf.pos,
            [1.0, 0.44, 0.10],
            wf.intensity * flick,
            wf.radius
          );
        }
        // Subtle warm interior building lamps
        for (let i = 0; i < interiorLights.length; i++) {
          const il = interiorLights[i];
          renderer.addDynamicLight(il.pos, il.color, il.intensity, il.radius);
        }
      }

      // Emit tall billowing dark oily smoke plumes, core flame tongues, glowing rising embers & subtle sunlit avenue dust!
      fireSmokeAccum += dt;
      if (fireSmokeAccum >= 0.11 && typeof renderer.spawnParticle === 'function') {
        fireSmokeAccum = 0;
        for (let i = 0; i < wreckFires.length; i++) {
          const wf = wreckFires[i];
          const ps = wf.plumeScale || 1.0;
          // Tall dark billowy smoke puff rising into the dusk sky
          renderer.spawnParticle({
            type: 'smoke',
            pos: [
              wf.pos[0] + (Math.random() - 0.5) * 1.1 * ps,
              wf.pos[1] + 0.35,
              wf.pos[2] + (Math.random() - 0.5) * 1.1 * ps
            ],
            vel: [
              1.15 + (Math.random() - 0.5) * 0.55,
              2.6 + Math.random() * 1.6,
              0.35 + (Math.random() - 0.5) * 0.55
            ],
            size: (1.5 + Math.random() * 0.6) * ps,
            sizeEnd: (7.4 + Math.random() * 2.6) * ps,
            life: 5.8 + Math.random() * 2.8,
            color: [0.13, 0.13, 0.14],
            alpha: 0.72,
            gravity: -0.35,
            drag: 0.42,
            rotSpeed: (Math.random() - 0.5) * 0.65,
            additive: false
          });
          // Flickering hot soot-backed fire core (additive: false renders turbulent smoke-occluded flames in DF.Renderer!)
          if (Math.random() < 0.85) {
            renderer.spawnParticle({
              type: 'fire',
              pos: [
                wf.pos[0] + (Math.random() - 0.5) * 0.85 * ps,
                wf.pos[1] - 0.05,
                wf.pos[2] + (Math.random() - 0.5) * 0.85 * ps
              ],
              vel: [(Math.random() - 0.5) * 0.6, 2.2 + Math.random() * 1.8, (Math.random() - 0.5) * 0.6],
              size: (0.85 + Math.random() * 0.45) * ps,
              sizeEnd: (1.85 + Math.random() * 0.55) * ps,
              life: 0.38 + Math.random() * 0.28,
              color: [1.0, 0.46 + Math.random() * 0.14, 0.08],
              alpha: 0.92,
              gravity: -1.6,
              drag: 1.2,
              additive: false
            });
          }
          // Glowing rising orange embers curling upward in the thermal draft
          if (Math.random() < 0.75) {
            renderer.spawnParticle({
              type: 'spark',
              pos: [
                wf.pos[0] + (Math.random() - 0.5) * 1.2 * ps,
                wf.pos[1] + 0.4,
                wf.pos[2] + (Math.random() - 0.5) * 1.2 * ps
              ],
              vel: [
                1.2 + (Math.random() - 0.5) * 1.4,
                3.2 + Math.random() * 2.6,
                (Math.random() - 0.5) * 1.4
              ],
              size: 0.11 + Math.random() * 0.07,
              sizeEnd: 0.03,
              life: 1.6 + Math.random() * 1.6,
              color: [1.0, 0.64, 0.18],
              alpha: 1.0,
              gravity: -0.9,
              drag: 0.35,
              additive: true
            });
          }
        }
        // Subtle sunlit battlefield haze/dust motes drifting down the main avenue
        if (Math.random() < 0.45) {
          const dx = -60 + Math.random() * 110;
          const dz = -9 + Math.random() * 18;
          renderer.spawnParticle({
            type: 'dust',
            pos: [dx, 0.6 + Math.random() * 2.5, dz],
            vel: [1.4 + Math.random() * 0.8, 0.15 + Math.random() * 0.25, (Math.random() - 0.5) * 0.4],
            size: 2.2,
            sizeEnd: 5.5,
            life: 4.5 + Math.random() * 2.5,
            color: [0.58, 0.54, 0.48],
            alpha: 0.16,
            gravity: -0.05,
            drag: 0.3,
            rotSpeed: (Math.random() - 0.5) * 0.3,
            additive: false
          });
        }
      }
    }
  };

  DF.Map = MapModule;
})();
