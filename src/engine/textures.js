(() => {
  'use strict';

  const DF = (window.DF = window.DF || {});

  const TEXTURE_KEYS = [
    'concrete',
    'concrete_damaged',
    'brick',
    'plaster',
    'asphalt',
    'mud_rubble',
    'sandbag',
    'wood',
    'metal_rust',
    'metal_dark',
    'gunmetal',
    'polymer',
    'bakelite',
    'glass',
    'armor_ua',
    'armor_ru',
    'uniform_ua',
    'uniform_ru',
    'skin',
    'rubber',
    'burnt_wreck',
    'crate_mil',
    'tactical_flag_ua',
    'tactical_flag_ru',
  ];

  // 13 Hero Materials baked on GPU via WebGL2 MRT Fragment Shaders + 8-Neighbor Sobel Normal Pass
  const GPU_MATERIAL_ID = {
    concrete: 0,
    concrete_damaged: 1,
    brick: 2,
    asphalt: 3,
    gunmetal: 4,
    polymer: 5,
    armor_ua: 6,
    armor_ru: 7,
    uniform_ua: 8,
    uniform_ru: 9,
    burnt_wreck: 10,
    metal_rust: 11,
    wood: 12,
  };

  const HIGH_RES_HERO_KEYS = {
    concrete: true,
    concrete_damaged: true,
    brick: true,
    asphalt: true,
    armor_ua: true,
    armor_ru: true,
  };

  // ---------------------------------------------------------------------------
  // WebGL2 GPU Substance-Grade PBR Texture Baker Shaders
  // ---------------------------------------------------------------------------
  const BAKE_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;

  // Pass 1 MRT Baker: loc 0 = Albedo (A=1.0), loc 1 = ORM (AO/Rough/Metal), loc 2 = Height (R)
  const BAKE_MAT_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform int uMatId;

layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outOrm;
layout(location = 2) out vec4 outHeight;

// Periodic tileable 2D hash (exact wrap at integer period 'per')
vec2 hash22p(vec2 p, vec2 per) {
  p = mod(p, per);
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float hash21p(vec2 p, vec2 per) {
  p = mod(p, per);
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Periodic tileable value noise at integer frequency 'freq' (vec2 for 100% seamless anisotropic tiling!)
float vnoiseP(vec2 uv, vec2 freq, float seed) {
  vec2 g = uv * freq;
  vec2 i = floor(g);
  vec2 f = fract(g);
  f = f * f * (3.0 - 2.0 * f);
  vec2 s = vec2(seed * 17.0, seed * 31.0);
  float a = hash21p(i + s, freq);
  float b = hash21p(i + vec2(1.0, 0.0) + s, freq);
  float c = hash21p(i + vec2(0.0, 1.0) + s, freq);
  float d = hash21p(i + vec2(1.0, 1.0) + s, freq);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 5-octave periodic tileable FBM (accepts integer vec2 baseFreq)
float fbmP2(vec2 uv, vec2 baseFreq, float seed) {
  float v = 0.0;
  float a = 0.5;
  vec2 f = baseFreq;
  for (int i = 0; i < 5; i++) {
    v += a * vnoiseP(uv, f, seed + float(i) * 3.1);
    f *= 2.0;
    a *= 0.5;
  }
  return v / 0.96875;
}

float fbmP(vec2 uv, float baseFreq, float seed) {
  return fbmP2(uv, vec2(baseFreq), seed);
}

// Periodic tileable Voronoi returning (F1, F2 - F1 edge distance, cellId)
vec3 voronoiP2(vec2 uv, vec2 freq, float seed) {
  vec2 g = uv * freq;
  vec2 i = floor(g);
  vec2 f = fract(g);
  float md1 = 8.0;
  float md2 = 8.0;
  float cid = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 n = vec2(float(dx), float(dy));
      vec2 cell = mod(i + n, freq);
      vec2 o = hash22p(cell + vec2(seed * 7.0, seed * 13.0), freq);
      vec2 r = n + o - f;
      float d = dot(r, r);
      if (d < md1) {
        md2 = md1;
        md1 = d;
        cid = o.x;
      } else if (d < md2) {
        md2 = d;
      }
    }
  }
  return vec3(sqrt(md1), sqrt(md2) - sqrt(md1), cid);
}

vec3 voronoiP(vec2 uv, float freq, float seed) {
  return voronoiP2(uv, vec2(freq), seed);
}

float ridgedP2(vec2 uv, vec2 baseFreq, float seed) {
  float v = 0.0;
  float a = 0.5;
  vec2 f = baseFreq;
  for (int i = 0; i < 4; i++) {
    float n = vnoiseP(uv, f, seed + float(i) * 5.7);
    v += a * (1.0 - abs(n * 2.0 - 1.0));
    f *= 2.0;
    a *= 0.5;
  }
  return v / 0.9375;
}

void main() {
  vec2 uv = vUv;
  vec3 albedo = vec3(0.5);
  float h = 0.5;
  float ao = 0.9;
  float rough = 0.8;
  float metal = 0.0;

  // ---------------------------------------------------------------------------
  // 0 & 1: CONCRETE & CONCRETE_DAMAGED (Soviet Khrushchyovka precast panels)
  // ---------------------------------------------------------------------------
  if (uMatId == 0 || uMatId == 1) {
    bool dmg = (uMatId == 1);
    float fLow = fbmP(uv, 4.0, 1.3);
    float fMid = fbmP(uv, 12.0, 4.7);
    float fFine = fbmP(uv, 48.0, 9.2);
    vec3 pores = voronoiP(uv, 42.0, 2.1);
    float porePit = 1.0 - smoothstep(0.06, 0.20, pores.x);

    // 2x2 precast concrete slab panel seams + subtle chamfer lip (no comic-book ink outlines!)
    vec2 cell = fract(uv * 2.0);
    vec2 panelId = floor(uv * 2.0);
    float panelShade = 0.94 + 0.11 * hash21p(panelId, vec2(2.0));
    float dEdge = min(min(cell.x, 1.0 - cell.x), min(cell.y, 1.0 - cell.y));
    float seam = 1.0 - smoothstep(0.005, 0.014, dEdge);
    float bevel = smoothstep(0.012, 0.026, dEdge) * (1.0 - smoothstep(0.026, 0.048, dEdge));

    // Tiny authentic formwork tie-rod dimples (4 per panel) + subtle rust-weeping streaks
    vec2 tieCell = fract(uv * 4.0) - vec2(0.5);
    float tieHole = 1.0 - smoothstep(0.011, 0.021, length(tieCell));
    float underTie = (1.0 - smoothstep(0.0, 0.032, abs(tieCell.x))) * (1.0 - smoothstep(-0.36, 0.01, tieCell.y)) * smoothstep(-0.40, -0.04, tieCell.y);
    float dripMask = underTie * (0.35 + 0.55 * fMid);

    // Vertical weathering rain wash streaks from top seam (integer vec2 frequencies for 100% seamless wrap!)
    float washCol = fbmP2(uv, vec2(18.0, 3.0), 6.2);
    float rainWash = smoothstep(0.45, 0.85, washCol) * smoothstep(0.55, 1.0, cell.y) * 0.18;

    // Hairline structural cracks (Voronoi cell edges warped by FBM — zero circular polka-dots!)
    vec2 crackUv = uv + vec2(fMid - 0.5, fLow - 0.5) * 0.07;
    vec3 crackVor = voronoiP(crackUv, dmg ? 7.0 : 4.0, 11.4);
    float crackLine = (1.0 - smoothstep(0.0, dmg ? 0.036 : 0.015, crackVor.y)) * smoothstep(0.44, 0.70, fLow);

    // Linear jagged concrete spalling scars & exposed rusty rebar slivers (on concrete_damaged)
    float spall = 0.0;
    float rebar = 0.0;
    if (dmg) {
      float spField = ridgedP2(uv + vec2(fLow * 0.14), vec2(6.0, 3.0), 19.3);
      spall = smoothstep(0.76, 0.86, spField) * smoothstep(0.46, 0.66, fMid);
      float barH = 1.0 - smoothstep(0.0, 0.12, abs(fract(uv.y * 18.0) - 0.5));
      float barV = 1.0 - smoothstep(0.0, 0.12, abs(fract(uv.x * 18.0) - 0.5));
      rebar = spall * max(barH, barV) * smoothstep(0.35, 0.65, spall);
    }

    vec3 baseCol = (dmg ? vec3(0.48, 0.47, 0.44) : vec3(0.54, 0.52, 0.49)) * panelShade;
    baseCol *= (0.84 + 0.26 * fLow + (fFine - 0.5) * 0.14);
    baseCol = mix(baseCol, vec3(0.36, 0.27, 0.20), dripMask * 0.34);
    baseCol *= (1.0 - rainWash);
    baseCol = mix(baseCol, vec3(0.26, 0.25, 0.24), spall * 0.58);
    baseCol = mix(baseCol, vec3(0.44, 0.22, 0.12), rebar * 0.85);
    baseCol *= (1.0 - seam * 0.22 - tieHole * 0.24 - crackLine * 0.34 - porePit * 0.12);

    albedo = clamp(baseCol, 0.06, 0.90);
    h = clamp(0.62 + (fFine - 0.5) * 0.16 + bevel * 0.05 - seam * 0.18 - tieHole * 0.18 - crackLine * 0.22 - porePit * 0.12 - spall * 0.26 + rebar * 0.16, 0.0, 1.0);
    ao = clamp(0.92 - seam * 0.24 - tieHole * 0.20 - crackLine * 0.24 - spall * 0.26 - porePit * 0.12 - rainWash * 0.20, 0.34, 1.0);
    rough = clamp(0.86 + (1.0 - fLow) * 0.09 + spall * 0.06 - rebar * 0.30, 0.45, 0.98);
    metal = rebar * 0.55;
  }

  // ---------------------------------------------------------------------------
  // 2: BRICK (Weathered desaturated Donbas Soviet masonry + deep mortar + pitting)
  // ---------------------------------------------------------------------------
  else if (uMatId == 2) {
    float rows = 16.0;
    float cols = 8.0;
    float rIdx = floor(uv.y * rows);
    float rowShift = mod(rIdx, 2.0) * 0.5;
    vec2 bg = vec2(uv.x * cols + rowShift, uv.y * rows);
    vec2 bid = floor(bg);
    vec2 bf = fract(bg);

    float mortarX = 0.045;
    float mortarY = 0.090;
    float fWarp = (fbmP(uv, 24.0, 3.1) - 0.5) * 0.018;
    float bx = smoothstep(mortarX, mortarX + 0.03, bf.x + fWarp) * (1.0 - smoothstep(1.0 - mortarX - 0.03, 1.0 - mortarX, bf.x + fWarp));
    float by = smoothstep(mortarY, mortarY + 0.05, bf.y + fWarp) * (1.0 - smoothstep(1.0 - mortarY - 0.05, 1.0 - mortarY, bf.y + fWarp));
    float brickMask = bx * by;

    float bRnd = hash21p(bid, vec2(cols, rows));
    float bRnd2 = hash21p(bid + vec2(3.0, 5.0), vec2(cols, rows));
    float fLow = fbmP(uv, 5.0, 5.2);
    float fFine = fbmP(uv, 44.0, 8.8);
    vec3 pitVor = voronoiP(uv, 36.0, 4.4);
    float chip = (1.0 - smoothstep(0.05, 0.16, pitVor.x)) * 0.22;

    // Authentic muted dusty Donbas clay/terracotta/ochre/soot bricks (zero cartoon Lego red!)
    vec3 brickCol;
    if (bRnd < 0.50) {
      brickCol = mix(vec3(0.41, 0.28, 0.24), vec3(0.50, 0.34, 0.28), bRnd2);
    } else if (bRnd < 0.82) {
      brickCol = mix(vec3(0.46, 0.38, 0.31), vec3(0.54, 0.44, 0.36), bRnd2);
    } else {
      brickCol = mix(vec3(0.30, 0.24, 0.22), vec3(0.37, 0.30, 0.27), bRnd2);
    }
    vec3 mortarCol = vec3(0.44, 0.42, 0.39) * (0.85 + 0.30 * fFine);

    // Soot & efflorescence weathering
    float soot = smoothstep(0.58, 0.88, fLow) * 0.30;
    float lime = smoothstep(0.74, 0.90, fbmP(uv, 8.0, 13.7)) * 0.16;
    brickCol = (brickCol * (0.84 + 0.28 * fFine - chip) + vec3(lime)) * (1.0 - soot);

    albedo = mix(mortarCol * (1.0 - soot * 0.5), brickCol, brickMask);
    h = clamp(0.18 + brickMask * (0.64 + (bRnd2 - 0.5) * 0.10 - chip * 0.6) + (fFine - 0.5) * 0.14, 0.0, 1.0);
    ao = clamp(mix(0.36, 0.92 - soot * 0.18 - chip * 0.25, brickMask), 0.28, 1.0);
    rough = clamp(mix(0.95, 0.86 + (1.0 - fFine) * 0.10, brickMask), 0.78, 0.98);
    metal = 0.0;
  }

  // ---------------------------------------------------------------------------
  // 3: ASPHALT (Crisp 1024px flat charcoal bitumen aggregate + tar-sealed cracks)
  // ---------------------------------------------------------------------------
  else if (uMatId == 3) {
    // Tight micro mineral aggregate via Voronoi pebbles + high-freq FBM (zero broad wavy hills!)
    vec3 agg1 = voronoiP(uv, 96.0, 1.7);
    vec3 agg2 = voronoiP(uv, 180.0, 4.9);
    float fMacro = fbmP(uv, 4.0, 2.3);
    float fFine = fbmP(uv, 64.0, 7.1);

    // Sinuous narrow tar-sealed cracks (Voronoi cell edges warped by FBM)
    vec2 cUv = uv + vec2(fbmP(uv, 6.0, 9.1) - 0.5, fbmP(uv, 6.0, 12.4) - 0.5) * 0.09;
    vec3 cVor = voronoiP(cUv, 3.0, 5.5);
    float crackCore = 1.0 - smoothstep(0.0, 0.012, cVor.y);
    float tarSeal = 1.0 - smoothstep(0.008, 0.030, cVor.y);

    float stone = clamp(0.45 + (1.0 - agg1.x) * 0.35 + (1.0 - agg2.x) * 0.20, 0.0, 1.0);
    float gritTone = 0.84 + (agg1.z - 0.5) * 0.16 + (fFine - 0.5) * 0.12 + (fMacro - 0.5) * 0.14;
    vec3 col = vec3(0.145, 0.155, 0.175) * gritTone;
    col = mix(col, vec3(0.065, 0.068, 0.075), tarSeal * 0.75);
    col = mix(col, vec3(0.03, 0.03, 0.035), crackCore);

    albedo = clamp(col, 0.025, 0.42);
    // Flat rolled tarmac height: ONLY micro stone grit + recessed tar crack (ZERO ocean-wave hills!)
    h = clamp(0.52 + (stone - 0.5) * 0.13 + (fFine - 0.5) * 0.06 - crackCore * 0.28 + (tarSeal - crackCore) * 0.04, 0.0, 1.0);
    ao = clamp(0.86 + stone * 0.12 - crackCore * 0.42, 0.35, 1.0);
    rough = clamp(0.80 + (1.0 - stone) * 0.12 - tarSeal * 0.26, 0.45, 0.94);
    metal = 0.0;
  }

  // ---------------------------------------------------------------------------
  // 4: GUNMETAL (CNC machined / parkerized firearm steel + oil sheen + scratches)
  // ---------------------------------------------------------------------------
  else if (uMatId == 4) {
    float brush1 = fbmP2(uv, vec2(2.0, 96.0), 3.1);
    float brush2 = vnoiseP(uv, vec2(4.0, 256.0), 6.4);
    float oil = smoothstep(0.44, 0.78, fbmP(uv, 5.0, 9.2));
    float wear = smoothstep(0.66, 0.86, fbmP(uv, 6.0, 14.3));
    float scr = (1.0 - smoothstep(0.0, 0.014, voronoiP2(uv, vec2(6.0, 32.0), 18.1).y)) * smoothstep(0.55, 0.80, fbmP(uv, 8.0, 21.0));

    float br = brush1 * 0.65 + brush2 * 0.35;
    vec3 col = vec3(0.12, 0.132, 0.150) * (0.82 + br * 0.34) + vec3(0.14, 0.15, 0.17) * (wear * 0.28 + scr * 0.38);
    col += vec3(0.0, 0.005, 0.012) * oil;

    albedo = clamp(col, 0.05, 0.38);
    h = clamp(0.50 + (br - 0.5) * 0.24 - scr * 0.18, 0.0, 1.0);
    ao = clamp(0.88 + br * 0.12 - scr * 0.14, 0.58, 1.0);
    rough = clamp(0.36 + (1.0 - br) * 0.14 - wear * 0.08 - oil * 0.06 - scr * 0.10, 0.20, 0.60);
    metal = clamp(0.84 + wear * 0.08 + scr * 0.06, 0.72, 0.94);
  }

  // ---------------------------------------------------------------------------
  // 5: POLYMER (Tactical diamond grip stippling + glass-filled matte nylon)
  // ---------------------------------------------------------------------------
  else if (uMatId == 5) {
    vec2 diag = vec2(uv.x + uv.y, uv.x - uv.y) * 56.0;
    float knurl = (sin(diag.x * 6.28318) * sin(diag.y * 6.28318)) * 0.5 + 0.5;
    vec3 peb = voronoiP(uv, 72.0, 4.2);
    float pebble = 1.0 - peb.x;
    float palm = smoothstep(0.48, 0.80, fbmP(uv, 4.0, 8.5));

    float st = knurl * 0.60 + pebble * 0.40;
    vec3 col = vec3(0.125, 0.132, 0.142) * (0.78 + st * 0.42 + palm * 0.18);
    albedo = clamp(col, 0.05, 0.45);
    h = clamp(0.34 + knurl * 0.44 + pebble * 0.20, 0.0, 1.0);
    ao = clamp(0.74 + st * 0.26, 0.55, 1.0);
    rough = clamp(0.58 - palm * 0.16 + (1.0 - st) * 0.12, 0.32, 0.78);
    metal = 0.04;
  }

  // ---------------------------------------------------------------------------
  // 6 & 7: ARMOR_UA / ARMOR_RU (Layered military painted steel, welds, primer & bare steel chips)
  // ---------------------------------------------------------------------------
  else if (uMatId == 6 || uMatId == 7) {
    bool isUA = (uMatId == 6);
    float fBroad = fbmP(uv, 3.0, isUA ? 2.1 : 5.3);
    float fCamo2 = fbmP(uv + vec2(0.31, 0.67), 4.0, isUA ? 7.4 : 11.2);
    float fMicro = fbmP(uv, 36.0, 15.1);
    float fGrime = fbmP2(uv, vec2(15.0, 4.0), 19.7);

    // 2x2 welded steel armor plates + weld bead + corner bolts
    vec2 pc = fract(uv * 2.0);
    float dEdge = min(min(pc.x, 1.0 - pc.x), min(pc.y, 1.0 - pc.y));
    float seam = 1.0 - smoothstep(0.005, 0.013, dEdge);
    float weld = smoothstep(0.011, 0.020, dEdge) * (1.0 - smoothstep(0.020, 0.032, dEdge)) * (0.5 + 0.5 * fMicro);

    vec2 bPos = min(pc, 1.0 - pc) - vec2(0.065);
    float bolt = 1.0 - smoothstep(0.014, 0.024, length(bPos));

    // Layered paint wear: bare metallic steel chips along weld edges + primer halo + combat scrapes
    float edgeChip = smoothstep(0.010, 0.018, dEdge) * (1.0 - smoothstep(0.024, 0.052, dEdge)) * smoothstep(0.46, 0.68, fMicro);
    float scratchVor = 1.0 - smoothstep(0.0, 0.010, voronoiP(uv, 7.0, 23.4).y);
    float combatScr = scratchVor * smoothstep(0.68, 0.84, fCamo2);
    float bareSteel = clamp(edgeChip + combatScr, 0.0, 1.0);
    float primerRim = smoothstep(0.018, 0.062, dEdge) * (1.0 - smoothstep(0.062, 0.085, dEdge)) * smoothstep(0.54, 0.74, fMicro) * (1.0 - bareSteel);

    vec3 paintCol;
    if (isUA) {
      // Smooth organic weathered Ukrainian military steppe olive-khaki camo (ZERO noisy moss pixels!)
      vec3 cOlive = vec3(0.27, 0.30, 0.22);
      vec3 cSage = vec3(0.35, 0.37, 0.27);
      vec3 cPine = vec3(0.20, 0.23, 0.17);
      vec3 cSteppe = vec3(0.34, 0.31, 0.24);
      paintCol = mix(cOlive, cSage, smoothstep(0.44, 0.58, fBroad));
      paintCol = mix(paintCol, cPine, smoothstep(0.56, 0.70, fCamo2) * 0.75);
      paintCol = mix(paintCol, cSteppe, smoothstep(0.62, 0.76, fBroad * 0.5 + (1.0 - fCamo2) * 0.5) * 0.65);
    } else {
      // Russian weathered 4BO dark protective olive steel
      vec3 c4bo = vec3(0.21, 0.25, 0.19);
      vec3 cDark = vec3(0.15, 0.18, 0.14);
      vec3 cFade = vec3(0.27, 0.30, 0.23);
      paintCol = mix(c4bo, cDark, smoothstep(0.50, 0.72, fBroad) * 0.7);
      paintCol = mix(paintCol, cFade, smoothstep(0.56, 0.78, fCamo2) * 0.5);
    }

    // Oil drips & Donbas road dust accumulation
    float oilStreak = smoothstep(0.62, 0.86, fGrime) * smoothstep(0.25, 0.95, pc.y) * 0.34;
    float dust = smoothstep(0.58, 0.86, fbmP(uv, 5.0, 29.1)) * 0.42;

    vec3 col = paintCol * (0.88 + 0.24 * fMicro) * (1.0 - oilStreak);
    col = mix(col, vec3(0.34, 0.31, 0.25), dust);
    col = mix(col, vec3(0.36, 0.25, 0.20), primerRim * 0.65);
    col = mix(col, vec3(0.54, 0.56, 0.59), bareSteel);
    col *= (1.0 - seam * 0.62);

    albedo = clamp(col, 0.04, 0.85);
    h = clamp(0.56 - seam * 0.45 + weld * 0.18 + bolt * 0.30 - bareSteel * 0.06 + (fMicro - 0.5) * 0.09, 0.0, 1.0);
    ao = clamp(0.92 - seam * 0.56 - oilStreak * 0.22 - dust * 0.10, 0.28, 1.0);
    rough = clamp(mix(0.68 + dust * 0.22 + (1.0 - fMicro) * 0.08 - oilStreak * 0.18, 0.26, bareSteel), 0.20, 0.94);
    metal = clamp(mix(0.22 * (1.0 - dust) + bolt * 0.48, 0.88, bareSteel), 0.0, 0.95);
  }

  // ---------------------------------------------------------------------------
  // 8 & 9: UNIFORM_UA (MM-14) / UNIFORM_RU (EMR Digital Flora) — crisp ripstop fabric
  // ---------------------------------------------------------------------------
  else if (uMatId == 8 || uMatId == 9) {
    bool isUA = (uMatId == 8);
    float grid1 = isUA ? 22.0 : 34.0;
    float grid2 = grid1 * 2.0;
    float c1 = hash21p(floor(uv * grid1), vec2(grid1));
    float c2 = hash21p(floor(uv * grid2), vec2(grid2));
    float pick = (hash21p(floor(uv * grid2) + vec2(9.0, 3.0), vec2(grid2)) < 0.52) ? c2 : c1;

    vec3 col;
    if (isUA) {
      if (pick < 0.24) col = vec3(0.56, 0.54, 0.45);
      else if (pick < 0.48) col = vec3(0.65, 0.62, 0.52);
      else if (pick < 0.72) col = vec3(0.42, 0.45, 0.35);
      else if (pick < 0.88) col = vec3(0.34, 0.33, 0.27);
      else col = vec3(0.49, 0.47, 0.39);
    } else {
      if (pick < 0.28) col = vec3(0.18, 0.25, 0.17);
      else if (pick < 0.56) col = vec3(0.27, 0.35, 0.23);
      else if (pick < 0.76) col = vec3(0.24, 0.21, 0.17);
      else if (pick < 0.90) col = vec3(0.15, 0.19, 0.15);
      else col = vec3(0.30, 0.37, 0.25);
    }

    // Crisp ripstop grid threads + fine diagonal twill + natural combat fabric folds
    vec2 rip = abs(fract(uv * 72.0) - 0.5);
    float ripThread = max(1.0 - smoothstep(0.0, 0.12, rip.x), 1.0 - smoothstep(0.0, 0.12, rip.y));
    float twill = sin((uv.x * 190.0 + uv.y * 240.0) * 6.28318) * 0.5 + 0.5;
    float fold = sin((uv.x * 3.0 + uv.y * 2.0) * 6.28318 + fbmP(uv, 4.0, 3.3) * 4.5) * 0.5 + 0.5;
    float dust = smoothstep(0.66, 0.90, fbmP(uv, 5.0, 7.9)) * 0.18;

    col = col * (0.82 + fold * 0.24 + (twill - 0.5) * 0.06 + ripThread * 0.06) + vec3(0.24, 0.22, 0.18) * dust;
    albedo = clamp(col, 0.06, 0.85);
    h = clamp(0.42 + fold * 0.32 + ripThread * 0.16 + twill * 0.08, 0.0, 1.0);
    ao = clamp(0.78 + fold * 0.22 - ripThread * 0.10, 0.55, 1.0);
    rough = clamp(0.86 + (1.0 - twill) * 0.08, 0.78, 0.96);
    metal = 0.0;
  }

  // ---------------------------------------------------------------------------
  // 10: BURNT_WRECK (Charred dark ash-steel, subtle heat-blued metal & muted rust — zero lumpy clay!)
  // ---------------------------------------------------------------------------
  else if (uMatId == 10) {
    float fChar = fbmP(uv, 5.0, 4.1);
    float fRust = fbmP(uv, 7.0, 8.7);
    float fBlis = fbmP(uv, 24.0, 12.3);
    vec3 peel = voronoiP(uv, 14.0, 16.5);

    float ash = smoothstep(0.60, 0.86, fChar);
    float rust = smoothstep(0.54, 0.82, fRust) * (1.0 - ash * 0.60);
    float bare = smoothstep(0.66, 0.84, fBlis) * (1.0 - rust * 0.55) * (1.0 - ash * 0.65);
    float blister = (1.0 - smoothstep(0.08, 0.24, peel.x)) * 0.08;

    vec3 col = vec3(0.14, 0.145, 0.155) + vec3(0.05) * fBlis;
    col = mix(col, vec3(0.30, 0.17, 0.11), rust * 0.36);
    col = mix(col, vec3(0.38, 0.39, 0.41), ash * 0.45);
    col = mix(col, vec3(0.34, 0.36, 0.40), bare * 0.65);

    albedo = clamp(col, 0.06, 0.55);
    h = clamp(0.48 + (fBlis - 0.5) * 0.14 + blister + (fChar - 0.5) * 0.10 - bare * 0.06, 0.0, 1.0);
    ao = clamp(0.74 + fBlis * 0.20 - blister * 0.25, 0.44, 1.0);
    rough = clamp(mix(0.66 + rust * 0.20 + ash * 0.18, 0.34, bare), 0.28, 0.94);
    metal = clamp(0.42 * (1.0 - rust * 0.70) * (1.0 - ash * 0.80) + bare * 0.48, 0.0, 0.86);
  }

  // ---------------------------------------------------------------------------
  // 11: METAL_RUST (Oxidized plated steel with flaking iron-oxide rust & weld seams)
  // ---------------------------------------------------------------------------
  else if (uMatId == 11) {
    float fRust = fbmP(uv, 5.0, 3.7) * 0.65 + fbmP(uv, 14.0, 8.2) * 0.35;
    float fFine = fbmP(uv, 40.0, 11.9);
    float rustMask = smoothstep(0.36, 0.66, fRust);
    float deepRust = smoothstep(0.56, 0.80, fbmP(uv, 8.0, 15.3));

    vec2 pc = fract(uv * 2.0);
    float seam = 1.0 - smoothstep(0.005, 0.015, min(min(pc.x, 1.0 - pc.x), min(pc.y, 1.0 - pc.y)));

    vec3 steelCol = vec3(0.30, 0.32, 0.35) * (0.82 + 0.34 * fFine);
    vec3 rustCol = mix(vec3(0.44, 0.24, 0.14), vec3(0.58, 0.26, 0.12), deepRust) * (0.78 + 0.38 * fFine);
    vec3 col = mix(steelCol, rustCol, rustMask) * (1.0 - seam * 0.55);

    albedo = clamp(col, 0.05, 0.80);
    h = clamp((0.56 - rustMask * 0.14 + fFine * 0.28 * rustMask) * (1.0 - seam * 0.65), 0.0, 1.0);
    ao = clamp((0.88 - rustMask * 0.18) * (1.0 - seam * 0.52), 0.32, 1.0);
    rough = clamp(mix(0.34, 0.90, rustMask) + (fFine - 0.5) * 0.08, 0.24, 0.96);
    metal = clamp(mix(0.86, 0.05, rustMask), 0.0, 0.92);
  }

  // ---------------------------------------------------------------------------
  // 12: WOOD (Weathered timber planks with warped wood rings, fibers & knots)
  // ---------------------------------------------------------------------------
  else {
    float planks = 6.0;
    float pIdx = floor(uv.y * planks);
    float py = fract(uv.y * planks);
    float seam = (1.0 - smoothstep(0.0, 0.032, py)) + (1.0 - smoothstep(0.0, 0.032, 1.0 - py));
    seam = clamp(seam, 0.0, 1.0);
    float pTint = hash21p(vec2(pIdx, 2.0), vec2(planks, 4.0));

    float warp = fbmP2(uv, vec2(6.0, 16.0), 6.1) * 2.2;
    float rings = sin((uv.y * 18.0 + pIdx * 1.7 + warp) * 6.28318) * 0.5 + 0.5;
    float fiber = fbmP2(uv, vec2(16.0, 128.0), 9.4);
    float grain = rings * 0.55 + fiber * 0.45;
    float wear = 0.78 + 0.32 * fbmP(uv, 6.0, 13.2);

    vec3 col = (vec3(0.42, 0.32, 0.22) + vec3(0.14, 0.10, 0.07) * grain + (pTint - 0.5) * vec3(0.10, 0.08, 0.06)) * wear * (1.0 - seam * 0.65);
    albedo = clamp(col, 0.05, 0.75);
    h = clamp((0.46 + grain * 0.38) * (1.0 - seam * 0.75), 0.0, 1.0);
    ao = clamp(0.88 - seam * 0.54 + grain * 0.12, 0.30, 1.0);
    rough = clamp(0.74 + (1.0 - grain) * 0.16 + seam * 0.08, 0.60, 0.96);
    metal = 0.0;
  }

  outAlbedo = vec4(albedo, 1.0);
  outOrm = vec4(ao, rough, metal, 1.0);
  outHeight = vec4(h, h, h, 1.0);
}`;

  // Pass 2: 8-Neighbor Periodic Sobel Height-to-Normal GPU Shader (OpenGL +U right, +V up)
  const BAKE_NORMAL_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uHeightTex;
uniform float uTexel;
uniform float uStrength;

out vec4 outNormal;

float sH(vec2 ofs) {
  return texture(uHeightTex, fract(vUv + ofs * uTexel)).r;
}

void main() {
  float tl = sH(vec2(-1.0,  1.0));
  float t  = sH(vec2( 0.0,  1.0));
  float tr = sH(vec2( 1.0,  1.0));
  float l  = sH(vec2(-1.0,  0.0));
  float r  = sH(vec2( 1.0,  0.0));
  float bl = sH(vec2(-1.0, -1.0));
  float b  = sH(vec2( 0.0, -1.0));
  float br = sH(vec2( 1.0, -1.0));

  float dU = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float dV = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);

  vec3 n = normalize(vec3(-dU * uStrength, -dV * uStrength, 1.0));
  outNormal = vec4(n * 0.5 + 0.5, 1.0);
}`;

  const GPU_NORMAL_STRENGTH = {
    concrete: 2.8,
    concrete_damaged: 3.8,
    brick: 3.6,
    asphalt: 1.35,
    gunmetal: 2.1,
    polymer: 2.7,
    armor_ua: 2.5,
    armor_ru: 2.5,
    uniform_ua: 2.4,
    uniform_ru: 2.4,
    burnt_wreck: 1.35,
    metal_rust: 3.0,
    wood: 2.6,
  };

  function compileBakeProg(gl, vsSrc, fsSrc) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      gl.deleteShader(vs);
      return null;
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  }

  function createEmptyTex(gl, size) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return tex;
  }

  function finalizeTex(gl, tex, anisoExt, aniso) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (anisoExt && aniso > 1) {
      gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, aniso);
    }
  }

  // Try baking the 13 hero Substance-grade materials directly on the WebGL2 GPU (<30ms!)
  function bakeHeroMaterialsOnGPU(gl, quality, baseSize, anisoExt, aniso) {
    if (!gl.drawBuffers || !gl.createFramebuffer) return null;
    const matProg = compileBakeProg(gl, BAKE_VS, BAKE_MAT_FS);
    const normProg = compileBakeProg(gl, BAKE_VS, BAKE_NORMAL_FS);
    if (!matProg || !normProg) {
      if (matProg) gl.deleteProgram(matProg);
      if (normProg) gl.deleteProgram(normProg);
      return null;
    }

    const uMatId = gl.getUniformLocation(matProg, 'uMatId');
    const uHeightTex = gl.getUniformLocation(normProg, 'uHeightTex');
    const uTexel = gl.getUniformLocation(normProg, 'uTexel');
    const uStrength = gl.getUniformLocation(normProg, 'uStrength');

    const prevFbo = gl.getParameter ? gl.getParameter(gl.FRAMEBUFFER_BINDING) : null;
    const prevVp = gl.getParameter ? gl.getParameter(gl.VIEWPORT) : null;

    const vao = gl.createVertexArray();
    const fboMat = gl.createFramebuffer();
    const fboNorm = gl.createFramebuffer();
    const hTexCache = Object.create(null);

    const results = Object.create(null);
    let ok = true;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(vao);

    const keys = Object.keys(GPU_MATERIAL_ID);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const sz = (quality === 'ultra' && HIGH_RES_HERO_KEYS[key]) ? 1024 : baseSize;
      let hTex = hTexCache[sz];
      if (!hTex) hTex = hTexCache[sz] = createEmptyTex(gl, sz);

      const albedoTex = createEmptyTex(gl, sz);
      const ormTex = createEmptyTex(gl, sz);
      const normalTex = createEmptyTex(gl, sz);

      // Pass 1: MRT Material Bake (Albedo + ORM + Height)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboMat);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, albedoTex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, ormTex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, hTex, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);

      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteTexture(albedoTex);
        gl.deleteTexture(ormTex);
        gl.deleteTexture(normalTex);
        ok = false;
        break;
      }

      gl.viewport(0, 0, sz, sz);
      gl.useProgram(matProg);
      gl.uniform1i(uMatId, GPU_MATERIAL_ID[key]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Pass 2: 8-Neighbor Sobel Height-to-Normal
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboNorm);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, normalTex, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

      gl.useProgram(normProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hTex);
      gl.uniform1i(uHeightTex, 0);
      gl.uniform1f(uTexel, 1.0 / sz);
      gl.uniform1f(uStrength, GPU_NORMAL_STRENGTH[key] || 2.5);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);

      finalizeTex(gl, albedoTex, anisoExt, aniso);
      finalizeTex(gl, normalTex, anisoExt, aniso);
      finalizeTex(gl, ormTex, anisoExt, aniso);

      results[key] = { albedo: albedoTex, normal: normalTex, orm: ormTex };
    }

    // Cleanup temporary baker GPU objects & restore state cleanly
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo || null);
    if (prevVp && prevVp.length === 4) {
      gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    for (const s in hTexCache) gl.deleteTexture(hTexCache[s]);
    gl.deleteFramebuffer(fboMat);
    gl.deleteFramebuffer(fboNorm);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(matProg);
    gl.deleteProgram(normProg);

    if (!ok) {
      for (const k in results) {
        gl.deleteTexture(results[k].albedo);
        gl.deleteTexture(results[k].normal);
        gl.deleteTexture(results[k].orm);
      }
      return null;
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // CPU Periodic Noise & Canvas2D Procedural Generators (for remaining 11 keys + fallback)
  // ---------------------------------------------------------------------------
  function hash2D(ix, iy, seed) {
    let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function buildPeriodicNoise(size, freq, seed) {
    const out = new Float32Array(size * size);
    const inv = freq / size;
    for (let y = 0; y < size; y++) {
      const fy = y * inv;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const iy0 = ((y0 % freq) + freq) % freq;
      const iy1 = (iy0 + 1) % freq;
      const rowOff = y * size;
      for (let x = 0; x < size; x++) {
        const fx = x * inv;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const ix0 = ((x0 % freq) + freq) % freq;
        const ix1 = (ix0 + 1) % freq;
        const v00 = hash2D(ix0, iy0, seed);
        const v10 = hash2D(ix1, iy0, seed);
        const v01 = hash2D(ix0, iy1, seed);
        const v11 = hash2D(ix1, iy1, seed);
        const vx0 = v00 + (v10 - v00) * sx;
        const vx1 = v01 + (v11 - v01) * sx;
        out[rowOff + x] = vx0 + (vx1 - vx0) * sy;
      }
    }
    return out;
  }

  function buildNoiseBank(size) {
    const n4 = buildPeriodicNoise(size, 4, 101);
    const n8 = buildPeriodicNoise(size, 8, 211);
    const n16 = buildPeriodicNoise(size, 16, 307);
    const n32 = buildPeriodicNoise(size, 32, 409);
    const n64 = buildPeriodicNoise(size, 64, 521);
    const n128 = buildPeriodicNoise(size, 128, 631);
    const n8b = buildPeriodicNoise(size, 8, 743);
    const n16b = buildPeriodicNoise(size, 16, 857);

    const len = size * size;
    const fbm = new Float32Array(len);
    const fbm2 = new Float32Array(len);
    const detail = new Float32Array(len);
    const grain = new Float32Array(len);
    const shift = size === 512 ? 9 : 8;

    for (let i = 0; i < len; i++) {
      fbm[i] = n4[i] * 0.36 + n8[i] * 0.28 + n16[i] * 0.18 + n32[i] * 0.11 + n64[i] * 0.07;
      fbm2[i] = n8b[i] * 0.42 + n16b[i] * 0.30 + n32[i] * 0.18 + n64[i] * 0.10;
      detail[i] = n32[i] * 0.45 + n64[i] * 0.35 + n128[i] * 0.20;
      grain[i] = hash2D(i & (size - 1), i >>> shift, 997);
    }

    return { size, n4, n8, n16, n32, n64, n128, fbm, fbm2, detail, grain };
  }

  function clamp255(v) { return v < 0 ? 0 : (v > 255 ? 255 : (v | 0)); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function smoothstep(a, b, x) {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }

  function heightToNormalRGBA(height, size, strength) {
    const out = new Uint8Array(size * size * 4);
    const mask = size - 1;
    const s = strength || 2.5;
    for (let y = 0; y < size; y++) {
      const ym = ((y - 1) & mask) * size;
      const yc = y * size;
      const yp = ((y + 1) & mask) * size;
      for (let x = 0; x < size; x++) {
        const xm = (x - 1) & mask;
        const xp = (x + 1) & mask;
        const dX = (height[ym + xp] + 2 * height[yc + xp] + height[yp + xp]) - (height[ym + xm] + 2 * height[yc + xm] + height[yp + xm]);
        const dY = (height[yp + xm] + 2 * height[yp + x] + height[yp + xp]) - (height[ym + xm] + 2 * height[ym + x] + height[ym + xp]);
        let nx = -dX * s, ny = dY * s, nz = 1.0;
        const inv = 1.0 / Math.hypot(nx, ny, nz);
        const o = (yc + x) * 4;
        out[o] = clamp255((nx * inv * 0.5 + 0.5) * 255);
        out[o + 1] = clamp255((ny * inv * 0.5 + 0.5) * 255);
        out[o + 2] = clamp255((nz * inv * 0.5 + 0.5) * 255);
        out[o + 3] = 255;
      }
    }
    return out;
  }

  function packOrmRGBA(ao, rough, metal, size) {
    const len = size * size;
    const out = new Uint8Array(len * 4);
    for (let i = 0; i < len; i++) {
      const o = i * 4;
      out[o] = clamp255(clamp01(ao[i]) * 255);
      out[o + 1] = clamp255(clamp01(rough[i]) * 255);
      out[o + 2] = clamp255(clamp01(metal[i]) * 255);
      out[o + 3] = 255;
    }
    return out;
  }

  function uploadTexture(gl, rgba, size, anisoExt, anisoLevel) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (anisoExt && anisoLevel > 1) {
      gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, anisoLevel);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return tex;
  }

  function uploadSolid1x1(gl, r, g, b, a) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, a]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return tex;
  }

  function drawCrack(ctx, rng, size, x0, y0, len, steps, width, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    let x = x0, y = y0, ang = rng.range(0, Math.PI * 2);
    ctx.moveTo(x, y);
    for (let i = 0; i < steps; i++) {
      ang += rng.range(-0.65, 0.65);
      x += Math.cos(ang) * (len / steps);
      y += Math.sin(ang) * (len / steps);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function generateMaterialCPU(key, nb, canvas, ctx) {
    const S = nb.size;
    const len = S * S;
    const albedo = new Uint8Array(len * 4);
    const height = new Float32Array(len);
    const ao = new Float32Array(len);
    const rough = new Float32Array(len);
    const metal = new Float32Array(len);
    const { n8, n16, n32, n64, n128, fbm, fbm2, detail, grain } = nb;
    const scale = S / 512;
    let normalStrength = 2.6;

    const resetCanvas = (fill) => {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, S, S);
    };
    const readCanvas = () => ctx.getImageData(0, 0, S, S).data;

    if (key === 'plaster') {
      normalStrength = 2.4;
      const rng = new DF.RNG(5123);
      resetCanvas('#b8b4a4');
      for (let i = 0; i < 14; i++) {
        drawCrack(ctx, rng, S, rng.range(0, S), rng.range(0, S), rng.range(45, 130) * scale, 10, rng.range(0.8, 1.8) * scale, '#5e5a52');
      }
      const cImg = readCanvas();
      for (let i = 0; i < len; i++) {
        const o = i * 4;
        const peelMask = smoothstep(0.56, 0.64, fbm[i] * 0.7 + fbm2[i] * 0.3);
        const edgeRim = smoothstep(0.53, 0.58, fbm[i] * 0.7 + fbm2[i] * 0.3) * (1 - peelMask);
        const damp = smoothstep(0.64, 0.9, fbm2[i]) * 0.22;
        const pR = (cImg[o] * 0.92 + 12) * (1 - damp), pG = (cImg[o + 1] * 0.95 + 10) * (1 - damp), pB = (cImg[o + 2] * 0.88 + 6) * (1 - damp);
        const rR = 114 + detail[i] * 34, rG = 112 + detail[i] * 32, rB = 108 + detail[i] * 30;
        albedo[o] = clamp255(pR + (rR - pR) * peelMask - edgeRim * 28 + (grain[i] - 0.5) * 10);
        albedo[o + 1] = clamp255(pG + (rG - pG) * peelMask - edgeRim * 28 + (grain[i] - 0.5) * 10);
        albedo[o + 2] = clamp255(pB + (rB - pB) * peelMask - edgeRim * 28 + (grain[i] - 0.5) * 10);
        albedo[o + 3] = 255;
        height[i] = clamp01((1 - peelMask) * 0.68 + 0.15 + detail[i] * 0.15 + edgeRim * 0.12);
        ao[i] = clamp01(0.92 - edgeRim * 0.38 - peelMask * 0.12);
        rough[i] = clamp01(0.76 + peelMask * 0.18 + (grain[i] - 0.5) * 0.06);
        metal[i] = 0.0;
      }
    } else if (key === 'mud_rubble') {
      normalStrength = 3.2;
      const rng = new DF.RNG(8011);
      resetCanvas('#3f3830');
      for (let i = 0; i < 140; i++) {
        const px = rng.range(0, S), py = rng.range(0, S);
        const rw = rng.range(4, 14) * scale, rh = rng.range(3, 10) * scale;
        const kind = rng.next();
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(rng.range(0, Math.PI));
        if (kind < 0.18) ctx.fillStyle = `rgba(${rng.int(84, 100)},${rng.int(64, 74)},${rng.int(56, 64)},0.65)`;
        else if (kind < 0.65) ctx.fillStyle = `rgba(${rng.int(78, 98)},${rng.int(76, 94)},${rng.int(70, 86)},0.62)`;
        else ctx.fillStyle = `rgba(${rng.int(50, 64)},${rng.int(46, 56)},${rng.int(40, 48)},0.75)`;
        ctx.beginPath();
        ctx.moveTo(-rw * 0.5, -rh * 0.25);
        ctx.lineTo(-rw * 0.1, -rh * 0.52);
        ctx.lineTo(rw * 0.48, -rh * 0.30);
        ctx.lineTo(rw * 0.36, rh * 0.45);
        ctx.lineTo(-rw * 0.32, rh * 0.48);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      const cImg = readCanvas();
      for (let i = 0; i < len; i++) {
        const o = i * 4;
        const damp = smoothstep(0.62, 0.84, fbm2[i]) * 0.22;
        const isStone = cImg[o] > 76;
        const dark = 1.0 - damp;
        albedo[o] = clamp255((cImg[o] * (0.80 + detail[i] * 0.32)) * dark);
        albedo[o + 1] = clamp255((cImg[o + 1] * (0.79 + detail[i] * 0.32)) * dark);
        albedo[o + 2] = clamp255((cImg[o + 2] * (0.78 + detail[i] * 0.32)) * dark);
        albedo[o + 3] = 255;
        height[i] = clamp01(fbm[i] * 0.55 + detail[i] * 0.25 + (isStone ? 0.18 : 0));
        ao[i] = clamp01(0.56 + height[i] * 0.42);
        rough[i] = clamp01(0.88 + (1 - detail[i]) * 0.08 - damp * 0.14);
        metal[i] = 0.0;
      }
    } else if (key === 'sandbag') {
      normalStrength = 4.0;
      const rows = 8, cols = 4, bagH = S / rows, bagW = S / cols;
      for (let y = 0; y < S; y++) {
        const row = Math.floor(y / bagH), vLocal = (y - row * bagH) / bagH;
        const xShift = (row & 1) ? bagW * 0.5 : 0, rowOff = y * S;
        for (let x = 0; x < S; x++) {
          const xs = (x + xShift) % S, col = Math.floor(xs / bagW), uLocal = (xs - col * bagW) / bagW;
          const i = rowOff + x, o = i * 4;
          const dome = Math.pow(Math.max(0, Math.sin(uLocal * Math.PI) * Math.sin(vLocal * Math.PI)), 0.45);
          const weave = ((Math.sin((x * 1.45) / scale) * 0.5 + 0.5) * 0.5 + (Math.sin((y * 1.45) / scale) * 0.5 + 0.5) * 0.5) * 0.12;
          const bagTint = (hash2D(col, row, 551) - 0.5) * 24;
          const base = 0.66 + dome * 0.34 - fbm[i] * 0.04 + weave * 0.4;
          height[i] = clamp01(dome * 0.80 + weave + detail[i] * 0.06);
          ao[i] = clamp01(0.42 + dome * 0.58);
          rough[i] = clamp01(0.86 + (1 - weave) * 0.10);
          metal[i] = 0.0;
          albedo[o] = clamp255((154 + bagTint) * base);
          albedo[o + 1] = clamp255((138 + bagTint * 0.9) * base);
          albedo[o + 2] = clamp255((106 + bagTint * 0.7) * base);
          albedo[o + 3] = 255;
        }
      }
    } else if (key === 'metal_dark') {
      normalStrength = 2.0;
      const mask = S - 1;
      for (let y = 0; y < S; y++) {
        const rowOff = y * S, borderY = Math.min(y, S - 1 - y, Math.abs(y - S * 0.5));
        for (let x = 0; x < S; x++) {
          const i = rowOff + x, o = i * 4;
          const edgeDist = Math.min(Math.min(x, S - 1 - x, Math.abs(x - S * 0.5)), borderY) / scale;
          const seam = edgeDist < 2.2 ? 1.0 : 0.0;
          const edgeWear = (edgeDist >= 2.2 && edgeDist < 9.0) ? smoothstep(0.45, 0.78, detail[i]) : 0.0;
          const brush = detail[y * S + ((x * 3) & mask)] * 0.5 + grain[i] * 0.5;
          const oil = smoothstep(0.62, 0.85, fbm2[i]) * 0.25;
          const base = 54 + brush * 18 + edgeWear * 52 - seam * 14;
          albedo[o] = clamp255(base * 0.96); albedo[o + 1] = clamp255(base); albedo[o + 2] = clamp255(base * 1.06); albedo[o + 3] = 255;
          height[i] = clamp01(0.60 + brush * 0.12 - seam * 0.22);
          ao[i] = clamp01(0.92 - seam * 0.24 - oil * 0.10);
          rough[i] = clamp01(0.44 - edgeWear * 0.20 - oil * 0.14 + (1 - brush) * 0.14);
          metal[i] = clamp01(0.76 + edgeWear * 0.20 - oil * 0.12);
        }
      }
    } else if (key === 'bakelite') {
      normalStrength = 1.4;
      for (let y = 0; y < S; y++) {
        const rowOff = y * S;
        for (let x = 0; x < S; x++) {
          const i = rowOff + x, o = i * 4;
          const m = (Math.sin((x * 0.05 + y * 0.09) / scale + fbm[i] * 9.0) * 0.5 + 0.5) * 0.72 + detail[i] * 0.28;
          albedo[o] = clamp255(104 + m * 74); albedo[o + 1] = clamp255(36 + m * 42); albedo[o + 2] = clamp255(16 + m * 16); albedo[o + 3] = 255;
          height[i] = clamp01(0.5 + (m - 0.5) * 0.18 + (grain[i] - 0.5) * 0.06);
          ao[i] = clamp01(0.92 + m * 0.08);
          rough[i] = clamp01(0.30 + (1 - m) * 0.14);
          metal[i] = 0.03;
        }
      }
    } else if (key === 'glass') {
      normalStrength = 1.8;
      const rng = new DF.RNG(6113);
      resetCanvas('#000000');
      const ix = S * 0.62, iy = S * 0.38;
      ctx.strokeStyle = '#ffffff';
      for (let r = 0; r < 9; r++) {
        const ang = (r / 9) * Math.PI * 2 + rng.range(-0.2, 0.2);
        const rLen = rng.range(S * 0.10, S * 0.34);
        ctx.lineWidth = rng.range(0.8, 1.5) * scale;
        ctx.beginPath(); ctx.moveTo(ix, iy);
        for (let st = 1; st <= 5; st++) {
          const d = (st / 5) * rLen;
          ctx.lineTo(ix + Math.cos(ang + rng.range(-0.12, 0.12)) * d, iy + Math.sin(ang + rng.range(-0.12, 0.12)) * d);
        }
        ctx.stroke();
      }
      const crackImg = readCanvas();
      for (let y = 0; y < S; y++) {
        const rowOff = y * S, ey = Math.min(y, S - 1 - y) / (S * 0.16);
        for (let x = 0; x < S; x++) {
          const i = rowOff + x, o = i * 4;
          const edgeDust = clamp01(1 - Math.min(Math.min(x, S - 1 - x) / (S * 0.16), ey)) * (0.45 + fbm[i] * 0.55);
          const crack = crackImg[o] / 255;
          albedo[o] = clamp255(16 + crack * 92 + edgeDust * 34);
          albedo[o + 1] = clamp255(22 + crack * 94 + edgeDust * 32);
          albedo[o + 2] = clamp255(28 + crack * 98 + edgeDust * 28);
          albedo[o + 3] = 255;
          height[i] = clamp01(0.54 - crack * 0.32 + edgeDust * 0.06);
          ao[i] = clamp01(0.95 - crack * 0.22 - edgeDust * 0.20);
          rough[i] = clamp01(0.05 + edgeDust * 0.42 + crack * 0.30 + fbm2[i] * 0.04);
          metal[i] = clamp01(0.22 * (1 - edgeDust));
        }
      }
    } else if (key === 'skin') {
      normalStrength = 0.9;
      for (let i = 0; i < len; i++) {
        const o = i * 4, pore = detail[i] * 0.6 + grain[i] * 0.4, tone = fbm[i];
        const smudge = smoothstep(0.72, 0.94, fbm2[i]) * 0.22;
        albedo[o] = clamp255((194 + (tone - 0.5) * 20 - smudge * 58) * (0.95 + pore * 0.08));
        albedo[o + 1] = clamp255((152 + (tone - 0.5) * 18 - smudge * 48) * (0.95 + pore * 0.08));
        albedo[o + 2] = clamp255((126 + (tone - 0.5) * 14 - smudge * 38) * (0.95 + pore * 0.08));
        albedo[o + 3] = 255;
        height[i] = clamp01(0.5 + (pore - 0.5) * 0.24);
        ao[i] = clamp01(0.92 + pore * 0.08);
        rough[i] = clamp01(0.58 + (1 - tone) * 0.12 + smudge * 0.18);
        metal[i] = 0.0;
      }
    } else if (key === 'rubber') {
      normalStrength = 3.2;
      const treadW = 32 * scale;
      for (let y = 0; y < S; y++) {
        const rowOff = y * S;
        for (let x = 0; x < S; x++) {
          const i = rowOff + x, o = i * 4;
          const cx = Math.abs((x / S) - 0.5) * S;
          const groove = (((y + cx * 0.65) % treadW) / treadW < 0.28 || Math.abs(x - S * 0.5) < 5 * scale) ? 1.0 : 0.0;
          const dustInGroove = groove * (0.35 + fbm[i] * 0.45);
          albedo[o] = clamp255(32 + grain[i] * 10 + dustInGroove * 58);
          albedo[o + 1] = clamp255(33 + grain[i] * 10 + dustInGroove * 48);
          albedo[o + 2] = clamp255(36 + grain[i] * 10 + dustInGroove * 36);
          albedo[o + 3] = 255;
          height[i] = clamp01(0.76 - groove * 0.54 + detail[i] * 0.12);
          ao[i] = clamp01(0.94 - groove * 0.46);
          rough[i] = clamp01(0.74 + groove * 0.18 + grain[i] * 0.08);
          metal[i] = 0.02;
        }
      }
    } else if (key === 'crate_mil') {
      normalStrength = 2.8;
      resetCanvas('#4d583c');
      const slats = 4, sh = S / slats;
      for (let s = 0; s < slats; s++) {
        ctx.fillStyle = s & 1 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.03)';
        ctx.fillRect(0, s * sh, S, sh);
        ctx.fillStyle = '#1f2418';
        ctx.fillRect(0, s * sh, S, 3 * scale);
      }
      ctx.strokeStyle = '#3d4730'; ctx.lineWidth = 22 * scale;
      ctx.strokeRect(11 * scale, 11 * scale, S - 22 * scale, S - 22 * scale);
      ctx.fillStyle = '#2a2e30';
      const br = 44 * scale;
      ctx.fillRect(0, 0, br, br); ctx.fillRect(S - br, 0, br, br);
      ctx.fillRect(0, S - br, br, br); ctx.fillRect(S - br, S - br, br, br);
      ctx.fillRect(S * 0.18, 0, 14 * scale, S); ctx.fillRect(S * 0.80, 0, 14 * scale, S);
      ctx.fillStyle = 'rgba(218, 184, 62, 0.86)';
      ctx.fillRect(S * 0.28, S * 0.34, S * 0.44, 14 * scale);
      ctx.fillRect(S * 0.28, S * 0.44, S * 0.26, 8 * scale);
      ctx.fillRect(S * 0.28, S * 0.56, S * 0.44, 6 * scale);
      for (let k = 0; k < 4; k++) ctx.fillRect(S * (0.28 + k * 0.11), S * 0.64, 24 * scale, 12 * scale);
      const cImg = readCanvas();
      for (let y = 0; y < S; y++) {
        const rowOff = y * S, slatGap = ((y % sh) < 3.5 * scale) ? 1.0 : 0.0;
        for (let x = 0; x < S; x++) {
          const i = rowOff + x, o = i * 4;
          const isMetal = (x < br && (y < br || y > S - br)) || (x > S - br && (y < br || y > S - br)) ||
            (x >= S * 0.18 && x <= S * 0.18 + 14 * scale) || (x >= S * 0.80 && x <= S * 0.80 + 14 * scale);
          const woodGrain = Math.sin((y * 0.7 / scale) + fbm[i] * 8.0) * 0.5 + 0.5;
          const scuff = smoothstep(0.74, 0.88, detail[i]);
          let r = cImg[o] * (0.86 + woodGrain * 0.20), g = cImg[o + 1] * (0.86 + woodGrain * 0.20), b = cImg[o + 2] * (0.86 + woodGrain * 0.20);
          if (scuff > 0 && !isMetal) { r += scuff * 48; g += scuff * 36; b += scuff * 20; }
          albedo[o] = clamp255(r); albedo[o + 1] = clamp255(g); albedo[o + 2] = clamp255(b); albedo[o + 3] = 255;
          height[i] = clamp01((isMetal ? 0.80 : (0.52 + woodGrain * 0.12)) - slatGap * 0.38);
          ao[i] = clamp01(0.92 - slatGap * 0.45);
          rough[i] = clamp01(isMetal ? 0.38 : (0.72 + (1 - woodGrain) * 0.16));
          metal[i] = isMetal ? 0.78 : 0.0;
        }
      }
    } else if (key === 'tactical_flag_ua' || key === 'tactical_flag_ru') {
      const isUA = key === 'tactical_flag_ua';
      normalStrength = 2.4;
      for (let y = 0; y < S; y++) {
        const v = y / S, rowOff = y * S;
        for (let x = 0; x < S; x++) {
          const i = rowOff + x, o = i * 4, u = x / S;
          let r, g, b;
          const dx = (u - 0.5) * 1.45, dy = v - 0.5;
          const diamond = Math.abs(dx) + Math.abs(dy);
          if (isUA) {
            // Blue Team tactical banner: cobalt blue field + crisp white tactical diamond emblem & sky-blue stripe
            if (Math.abs(v - 0.5) < 0.065 || (diamond < 0.24 && diamond > 0.145)) {
              r = 232; g = 240; b = 248;
            } else if (diamond <= 0.145) {
              r = 56; g = 166; b = 242;
            } else {
              r = 24; g = 88; b = 196;
            }
          } else {
            // Red Team tactical banner: crimson red field + crisp white twin-chevron / bar emblem
            const chev = Math.abs(Math.abs(dy) - (0.34 - Math.abs(dx) * 0.78));
            if ((Math.abs(dx) < 0.34 && chev < 0.055) || Math.abs(v - 0.5) < 0.045 && Math.abs(u - 0.5) > 0.24) {
              r = 236; g = 234; b = 230;
            } else {
              r = 196; g = 34; b = 34;
            }
          }
          const weave = (Math.sin(x * 1.6 / scale) * Math.sin(y * 1.6 / scale)) * 0.06;
          const wave = Math.sin(u * Math.PI * 6 + v * Math.PI * 2 + fbm[i] * 1.6) * 0.5 + 0.5;
          const grime = smoothstep(0.60, 0.95, fbm2[i]) * (0.14 + u * 0.18 + v * 0.14);
          const shade = 0.86 + wave * 0.22 + weave;
          albedo[o] = clamp255(r * shade * (1 - grime) + 64 * grime);
          albedo[o + 1] = clamp255(g * shade * (1 - grime) + 58 * grime);
          albedo[o + 2] = clamp255(b * shade * (1 - grime) + 50 * grime);
          albedo[o + 3] = 255;
          height[i] = clamp01(0.30 + wave * 0.56 + weave + detail[i] * 0.08);
          ao[i] = clamp01(0.76 + wave * 0.24);
          rough[i] = clamp01(0.84 + grain[i] * 0.08);
          metal[i] = 0.0;
        }
      }
    } else {
      // Compact CPU fallback for any of the 13 GPU-baked keys if GPU MRT is unavailable
      const isDark = key === 'asphalt' || key === 'gunmetal' || key === 'polymer' || key === 'burnt_wreck';
      const isMetal = key === 'gunmetal' || key === 'metal_rust' || key === 'armor_ua' || key === 'armor_ru';
      const baseR = key === 'brick' ? 116 : (key === 'armor_ua' ? 80 : (key === 'armor_ru' ? 58 : (isDark ? 42 : 126)));
      const baseG = key === 'brick' ? 84 : (key === 'armor_ua' ? 86 : (key === 'armor_ru' ? 68 : (isDark ? 44 : 124)));
      const baseB = key === 'brick' ? 72 : (key === 'armor_ua' ? 66 : (key === 'armor_ru' ? 52 : (isDark ? 48 : 118)));
      for (let i = 0; i < len; i++) {
        const o = i * 4, m = 0.82 + fbm[i] * 0.28 + (detail[i] - 0.5) * 0.12;
        albedo[o] = clamp255(baseR * m); albedo[o + 1] = clamp255(baseG * m); albedo[o + 2] = clamp255(baseB * m); albedo[o + 3] = 255;
        height[i] = clamp01(0.5 + (detail[i] - 0.5) * 0.35 + (n64[i] - 0.5) * 0.15);
        ao[i] = clamp01(0.78 + fbm2[i] * 0.22);
        rough[i] = clamp01(key === 'gunmetal' ? 0.30 : (key === 'asphalt' ? 0.86 : 0.78));
        metal[i] = key === 'gunmetal' ? 0.90 : (isMetal ? 0.35 : 0.0);
      }
    }

    return { albedo, height, ao, rough, metal, normalStrength };
  }

  // ---------------------------------------------------------------------------
  // DF.Textures public manager
  // ---------------------------------------------------------------------------
  let _gl = null;
  let _quality = 'ultra';
  let _size = 512;
  let _cache = Object.create(null);
  let _fallback = null;

  function disposeAll() {
    if (!_gl) return;
    for (const k in _cache) {
      const t = _cache[k];
      if (t) {
        if (t.albedo) _gl.deleteTexture(t.albedo);
        if (t.normal) _gl.deleteTexture(t.normal);
        if (t.orm) _gl.deleteTexture(t.orm);
      }
    }
    _cache = Object.create(null);
  }

  function ensureFallback(gl) {
    if (_fallback) return _fallback;
    _fallback = {
      albedo: uploadSolid1x1(gl, 180, 178, 174, 255),
      normal: uploadSolid1x1(gl, 128, 128, 255, 255),
      orm: uploadSolid1x1(gl, 255, 192, 0, 255),
    };
    return _fallback;
  }

  function getAnisoForQuality(quality, maxAniso) {
    if (quality === 'low') return 1;
    if (quality === 'medium') return Math.min(4, maxAniso);
    if (quality === 'high') return Math.min(8, maxAniso);
    return Math.min(16, maxAniso);
  }

  DF.Textures = {
    KEYS: TEXTURE_KEYS.slice(),

    init(gl, quality = 'ultra') {
      if (!gl) return;
      const targetSize = quality === 'low' ? 256 : 512;
      const anisoExt =
        gl.getExtension('EXT_texture_filter_anisotropic') ||
        gl.getExtension('MOZ_EXT_texture_filter_anisotropic') ||
        gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
      const maxAniso = anisoExt ? gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
      const aniso = getAnisoForQuality(quality, maxAniso);

      // Skip full rebake if same context & resolution tier (ultra uses 1024px heroes vs 512px high/med)
      const sameTier = (_quality === 'ultra') === (quality === 'ultra') && _size === targetSize;
      if (_gl === gl && sameTier && Object.keys(_cache).length === TEXTURE_KEYS.length) {
        _quality = quality;
        if (anisoExt) {
          for (const k in _cache) {
            const t = _cache[k];
            for (const tex of [t.albedo, t.normal, t.orm]) {
              gl.bindTexture(gl.TEXTURE_2D, tex);
              gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, aniso);
            }
          }
          gl.bindTexture(gl.TEXTURE_2D, null);
        }
        return;
      }

      if (_gl === gl) disposeAll();
      else { _cache = Object.create(null); _fallback = null; }

      _gl = gl;
      _quality = quality;
      _size = targetSize;
      ensureFallback(gl);

      // 1. Bake all 13 Substance-grade hero textures on GPU (1024px/512px, <30ms!)
      const gpuBaked = bakeHeroMaterialsOnGPU(gl, quality, targetSize, anisoExt, aniso);
      if (gpuBaked) {
        for (const k in gpuBaked) _cache[k] = gpuBaked[k];
      }

      // 2. Generate remaining 11 textures (and any fallback if GPU baker failed) on Canvas2D
      const remaining = TEXTURE_KEYS.filter((k) => !_cache[k]);
      if (remaining.length > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = targetSize;
        canvas.height = targetSize;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const nb = buildNoiseBank(targetSize);

        for (let i = 0; i < remaining.length; i++) {
          const key = remaining[i];
          const mat = generateMaterialCPU(key, nb, canvas, ctx);
          const normalRGBA = heightToNormalRGBA(mat.height, targetSize, mat.normalStrength);
          const ormRGBA = packOrmRGBA(mat.ao, mat.rough, mat.metal, targetSize);
          _cache[key] = {
            albedo: uploadTexture(gl, mat.albedo, targetSize, anisoExt, aniso),
            normal: uploadTexture(gl, normalRGBA, targetSize, anisoExt, aniso),
            orm: uploadTexture(gl, ormRGBA, targetSize, anisoExt, aniso),
          };
        }
      }

      gl.bindTexture(gl.TEXTURE_2D, null);
    },

    get(key) {
      if (key && _cache[key]) return _cache[key];
      if (_cache.concrete) return _cache.concrete;
      if (_gl) return ensureFallback(_gl);
      return null;
    },

    getQuality() { return _quality; },
    getResolution() { return _size; },
  };
})();
