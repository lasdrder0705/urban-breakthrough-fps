(() => {
  'use strict';

  const DF = (window.DF = window.DF || {});
  const Mat4 = DF.Mat4;
  const Vec3 = DF.Vec3;
  const DMath = DF.Math;

  // ---------------------------------------------------------------------------
  // Quality Tier Definitions (Ultra default — full AAA Frostbite pipeline!)
  // ---------------------------------------------------------------------------
  const QUALITY_PRESETS = {
    ultra: {
      name: 'ultra',
      shadowSize: 3072,
      pcfTaps: 16,
      pcss: true,
      planarRefl: true,
      maxPixelRatio: 2.0,
      ssao: true,
      ssaoSamples: 12,
      volShafts: true,
      volSteps: 16,
      bloom: true,
      fxaa: true,
      sharpen: 0.30,
      maxParticles: 2000,
      texQuality: 'ultra',
    },
    high: {
      name: 'high',
      shadowSize: 2048,
      pcfTaps: 12,
      pcss: true,
      planarRefl: true,
      maxPixelRatio: 1.5,
      ssao: true,
      ssaoSamples: 10,
      volShafts: true,
      volSteps: 12,
      bloom: true,
      fxaa: true,
      sharpen: 0.28,
      maxParticles: 1300,
      texQuality: 'high',
    },
    medium: {
      name: 'medium',
      shadowSize: 1536,
      pcfTaps: 9,
      pcss: false,
      planarRefl: true,
      maxPixelRatio: 1.25,
      ssao: true,
      ssaoSamples: 8,
      volShafts: true,
      volSteps: 8,
      bloom: true,
      fxaa: true,
      sharpen: 0.20,
      maxParticles: 750,
      texQuality: 'medium',
    },
    low: {
      name: 'low',
      shadowSize: 1024,
      pcfTaps: 4,
      pcss: false,
      planarRefl: false,
      maxPixelRatio: 1.0,
      ssao: false,
      ssaoSamples: 0,
      volShafts: false,
      volSteps: 0,
      bloom: false,
      fxaa: false,
      sharpen: 0.0,
      maxParticles: 360,
      texQuality: 'low',
    },
  };

  // Dramatic Frostbite low-angle (~19 deg) golden dusk sun vs cool Donbas steel-slate shadow fill
  const SUN_DIR = Vec3.normalize(Vec3.create(), [-0.74, 0.33, 0.58]);
  const SUN_COLOR = [1.0, 0.70, 0.40];
  const SUN_INTENSITY = 4.95;
  const SKY_TOP_COLOR = [0.18, 0.24, 0.34];
  const SKY_HORIZON_COLOR = [0.32, 0.31, 0.34];
  const GROUND_BOUNCE_COLOR = [0.18, 0.15, 0.12];

  const MAX_DYNAMIC_LIGHTS = 16;
  const MAX_POOL_ITEMS = 6144;
  const PARTICLE_FLOATS = 16; // 4 x vec4 per instance
  const MAX_DECALS = 96;
  const DECAL_FLOATS = 12;    // 3 x vec4 per instance
  const MAX_TRACERS = 256;
  const TRACER_FLOATS = 12;   // 3 x vec4 per instance (fromWidth, toAlpha, colorHot)

  const PARTICLE_TYPE_ID = {
    smoke: 0, fire: 1, spark: 2, ember: 2, dust: 3, debris: 4,
    flash: 5, muzzle: 5, shockwave: 6, tracer: 7, blood: 8, casing: 9,
  };

  const DECAL_TYPE_ID = {
    bullet: 0, bullet_concrete: 0, concrete: 0, brick: 0, plaster: 0, asphalt: 0, stone: 0, earth: 0,
    bullet_metal: 1, metal: 1, armor: 1, ricochet: 1, steel: 1,
    bullet_wood: 2, wood: 2, sandbag: 2, bullet_glass: 2, glass: 2,
    scorch: 3, explosion: 3, blast: 3, crater: 3,
    blood: 4,
  };

  const VISION_MODE_ID = {
    normal: 0, thermal_white: 1, thermal_green: 2, optic: 3, nvg: 4,
  };

  const DEFAULT_THERMAL_BY_TEX = {
    skin: 0.96, uniform_ua: 0.80, uniform_ru: 0.80, burnt_wreck: 0.56,
    armor_ua: 0.42, armor_ru: 0.42, gunmetal: 0.30, rubber: 0.24,
    metal_dark: 0.20, metal_rust: 0.18, asphalt: 0.14, concrete: 0.11,
    concrete_damaged: 0.12, brick: 0.13, plaster: 0.10, mud_rubble: 0.10,
    sandbag: 0.12, wood: 0.12, glass: 0.08, crate_mil: 0.14, polymer: 0.22,
    bakelite: 0.22, tactical_flag_ua: 0.16, tactical_flag_ru: 0.16,
  };

  // ---------------------------------------------------------------------------
  // GLSL ES 3.00 Shaders (strict edge0 < edge1 smoothstep everywhere!)
  // ---------------------------------------------------------------------------
  const FULLSCREEN_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;

  const SHADOW_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uLightVP;
uniform mat4 uModel;
void main() {
  gl_Position = uLightVP * uModel * vec4(aPos, 1.0);
}`;

  const SHADOW_FS = `#version 300 es
precision highp float;
void main() {}`;

  const WIREFRAME_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 4) in vec3 aColor;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform vec3 uCamPos;
uniform float uSolidPass;
out vec3 vColor;
void main() {
  vColor = aColor;
  vec4 wp = uModel * vec4(aPos, 1.0);
  if (uSolidPass < 0.5) {
    vec3 toCam = uCamPos - wp.xyz;
    float d = length(toCam);
    if (d > 0.001) {
      wp.xyz += (toCam / d) * min(0.006 * d, 0.18);
    }
  }
  vec4 clip = uViewProj * wp;
  if (uSolidPass < 0.5) {
    clip.z -= 0.00035 * clip.w;
  }
  gl_Position = clip;
}`;

  const WIREFRAME_FS = `#version 300 es
precision highp float;
uniform vec3 uWireColor;
uniform float uSolidPass;
in vec3 vColor;
out vec4 fragColor;
void main() {
  if (uSolidPass > 0.5) {
    fragColor = vec4(0.008, 0.012, 0.018, 1.0);
  } else {
    fragColor = vec4(uWireColor * (0.78 + 0.22 * vColor), 1.0);
  }
}`;

  // Main Cook-Torrance GGX PBR + PCSS Physical Shadows + 4-Band Wet Ground + Planar Reflections
  const PBR_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec4 aTangent;
layout(location = 4) in vec3 aColor;

uniform mat4 uView;
uniform mat4 uProj;
uniform mat4 uModel;
uniform mat4 uWorldModel;
uniform mat4 uLightVP;
uniform vec2 uUvScale;

out vec3 vWorldPos;
out vec3 vNormal;
out vec4 vTangent;
out vec2 vUv;
out vec3 vColor;
out vec4 vShadowPos;

void main() {
  vec4 renderPos = uModel * vec4(aPos, 1.0);
  vec4 worldPos = uWorldModel * vec4(aPos, 1.0);
  vWorldPos = worldPos.xyz;

  mat3 m3 = mat3(uWorldModel);
  mat3 nMat = transpose(inverse(m3));
  vNormal = normalize(nMat * aNormal);
  vTangent = vec4(normalize(m3 * aTangent.xyz), aTangent.w);
  vUv = aUv * uUvScale;
  vColor = aColor;
  vShadowPos = uLightVP * worldPos;

  gl_Position = uProj * uView * renderPos;
}`;

  const PBR_FS = `#version 300 es
precision highp float;
precision highp int;

in vec3 vWorldPos;
in vec3 vNormal;
in vec4 vTangent;
in vec2 vUv;
in vec3 vColor;
in vec4 vShadowPos;

uniform sampler2D uAlbedoMap;
uniform sampler2D uNormalMap;
uniform sampler2D uOrmMap;
uniform sampler2D uShadowMap;
uniform sampler2D uPlanarReflTex;

uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uGroundBounce;

uniform vec3 uBaseColor;
uniform vec2 uRoughParam;
uniform vec2 uMetalParam;
uniform vec3 uEmissive;
uniform float uAlpha;
uniform float uThermalHeat;
uniform float uReceiveShadow;
uniform float uUnlit;
uniform float uIsViewmodel;
uniform float uIsRoad;
uniform float uPlanarClip;
uniform float uPlanarEnabled;
uniform vec2 uInvScreen;

uniform int uVisionMode;
uniform int uPcfTaps;
uniform int uUsePCSS;
uniform vec2 uShadowTexel;
uniform float uShadowWorldSpan;
uniform float uTime;

uniform int uLightCount;
uniform vec4 uLightPosRad[${MAX_DYNAMIC_LIGHTS}];
uniform vec4 uLightColInt[${MAX_DYNAMIC_LIGHTS}];

out vec4 fragColor;

const float PI = 3.14159265359;
const float GOLDEN_ANGLE = 2.39996323;

float interleavedNoise(vec2 p) {
  vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
  return fract(magic.z * fract(dot(p, magic.xy)));
}

vec2 vogelDisk(int idx, int count, float phi) {
  float r = sqrt((float(idx) + 0.5) / float(max(count, 1)));
  float theta = float(idx) * GOLDEN_ANGLE + phi;
  return vec2(cos(theta), sin(theta)) * r;
}

float distributionGGX(float NdotH, float rough) {
  float a = rough * rough;
  float a2 = a * a;
  float d = (NdotH * NdotH) * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 1e-6);
}

float geometrySchlickGGX(float NdotV, float rough) {
  float r = rough + 1.0;
  float k = (r * r) * 0.125;
  return NdotV / (NdotV * (1.0 - k) + k + 1e-6);
}

float geometrySmith(float NdotV, float NdotL, float rough) {
  return geometrySchlickGGX(NdotV, rough) * geometrySchlickGGX(NdotL, rough);
}

vec3 fresnelSchlick(float cosTheta, vec3 F0) {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

vec3 fresnelSchlickRoughness(float cosTheta, vec3 F0, float rough) {
  return F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

float wHash2(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec2 wHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float wNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(wHash2(i), wHash2(i + vec2(1.0, 0.0)), f.x),
    mix(wHash2(i + vec2(0.0, 1.0)), wHash2(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float wFbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 3; i++) {
    v += a * wNoise(p);
    p = m * p * 2.04 + vec2(4.1, 7.3);
    a *= 0.5;
  }
  return v / 0.875;
}

// Animated procedural expanding circular raindrop ripples in standing street puddles
vec2 evalRainRipples(vec2 wp, float t) {
  vec2 grad = vec2(0.0);
  for (int layer = 0; layer < 2; layer++) {
    float freq = (layer == 0) ? 1.45 : 2.35;
    vec2 g = wp * freq + float(layer) * 19.3;
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    vec2 rnd = wHash22(cell + float(layer) * 7.1);
    float phase = fract(t * (0.48 + rnd.x * 0.28) + rnd.y);
    vec2 delta = f - (rnd - 0.5) * 0.52;
    float d = length(delta);
    float rad = phase * 0.48;
    float ring = sin((d - rad) * 42.0) * exp(-abs(d - rad) * 14.0) * (1.0 - phase) * smoothstep(0.0, 0.08, phase);
    if (d > 0.002) {
      grad += (delta / d) * ring * 0.015;
    }
  }
  // Subtle micro-wind wave on puddle mirror surface
  grad.x += sin(wp.x * 7.0 + t * 2.1) * 0.0018;
  grad.y += cos(wp.y * 6.5 - t * 1.8) * 0.0018;
  return grad;
}

vec3 evalAnalyticalIBL(vec3 R, float rough) {
  float up = clamp(R.y, -1.0, 1.0);
  float horizonMask = exp(-abs(up) * mix(6.5, 2.0, rough));
  vec3 zenithCol = vec3(0.08, 0.13, 0.22);
  vec3 horzCool = vec3(0.24, 0.28, 0.36);
  vec3 skyCol = mix(horzCool, zenithCol, pow(clamp(up, 0.0, 1.0), 0.50));
  vec3 gndCol = mix(uGroundBounce * 1.1, uGroundBounce * 0.45, clamp(-up, 0.0, 1.0));
  vec3 env = up >= 0.0 ? mix(skyCol, horzCool * 1.25, horizonMask * 0.50) : mix(gndCol, horzCool * 0.55, horizonMask * 0.45);

  if (up > 0.01 && rough < 0.35) {
    vec2 cUv = R.xz / (up + 0.22) * 1.2 + vec2(uTime * 0.012, uTime * 0.005);
    float cl = smoothstep(0.32, 0.76, wFbm(cUv));
    float clSun = pow(max(dot(R, uSunDir), 0.0), 3.0);
    vec3 clCol = mix(vec3(0.11, 0.14, 0.20), uSunColor * 1.15, 0.25 + 0.75 * clSun);
    env = mix(env, clCol, cl * (1.0 - rough * 2.6) * 0.68);
  }

  float sunDot = max(dot(R, uSunDir), 0.0);
  float lobeExp = mix(280.0, 9.0, rough * rough);
  float sunSpec = pow(sunDot, lobeExp) * mix(1.25, 0.12, rough);
  env += uSunColor * sunSpec;

  float warmAzimuth = pow(max(dot(normalize(vec3(R.x, 0.0, R.z) + 1e-5), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0), 2.8);
  env += uSunColor * warmAzimuth * horizonMask * 0.48;
  return env;
}

// Upgrade A: True PCSS Physical Soft Shadows (dFdx/dFdy receiver-plane bias + 8-tap blocker search + 16-tap Vogel PCF)
float calcShadowPCSS(vec4 shadowPos, float NdotL) {
  if (uReceiveShadow < 0.5) return 1.0;
  vec3 proj = shadowPos.xyz / shadowPos.w;
  proj = proj * 0.5 + 0.5;
  if (proj.z > 1.0 || proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0) {
    return 1.0;
  }
  vec2 edgeDist = min(proj.xy, 1.0 - proj.xy);
  float edgeFade = smoothstep(0.0, 0.06, min(edgeDist.x, edgeDist.y));

  // Receiver-plane depth bias from screen-space shadow coordinate derivatives
  vec3 dPdx = dFdx(proj);
  vec3 dPdy = dFdy(proj);
  float det = dPdx.x * dPdy.y - dPdx.y * dPdy.x;
  vec2 dzduv = vec2(0.0);
  if (abs(det) > 1e-7) {
    dzduv = vec2(dPdy.y * dPdx.z - dPdx.y * dPdy.z, dPdx.x * dPdy.z - dPdy.x * dPdx.z) / det;
    dzduv = clamp(dzduv, vec2(-0.14), vec2(0.14));
  }
  float baseBias = max(0.0014 * (1.0 - NdotL), 0.00038);
  float phi = interleavedNoise(gl_FragCoord.xy) * 6.2831853;

  float filterRadUV = uShadowTexel.x * 2.0;
  if (uUsePCSS > 0) {
    // 8-tap IGN-rotated Vogel disk blocker search
    float searchRad = 22.0 * uShadowTexel.x;
    float blockerSum = 0.0;
    float blockerCnt = 0.0;
    for (int i = 0; i < 8; i++) {
      vec2 ofs = vogelDisk(i, 8, phi) * searchRad;
      float sd = texture(uShadowMap, proj.xy + ofs).r;
      if (sd < proj.z - baseBias) {
        blockerSum += sd;
        blockerCnt += 1.0;
      }
    }
    if (blockerCnt < 0.5) return 1.0; // Fast early-out on fully sunlit surfaces!
    float avgBlocker = blockerSum / blockerCnt;
    // Ortho shadow depth span is 240m (near=10, far=250)
    float distM = max(proj.z - avgBlocker, 0.0) * 240.0;
    float penM = clamp(distM * 0.022, 0.014, 0.55);
    filterRadUV = max(penM / max(uShadowWorldSpan, 20.0), uShadowTexel.x * 0.9);
  }

  float shadow = 0.0;
  int taps = uPcfTaps;
  for (int i = 0; i < 16; i++) {
    if (i >= taps) break;
    vec2 ofs = vogelDisk(i, taps, phi + 1.047) * filterRadUV;
    float rBias = baseBias + clamp(dot(ofs, dzduv), -0.0026, 0.0026);
    float d = texture(uShadowMap, proj.xy + ofs).r;
    shadow += (proj.z - rBias > d) ? 0.0 : 1.0;
  }
  shadow /= float(max(taps, 1));
  return mix(1.0, shadow, edgeFade);
}

void main() {
  // Planar reflection clip plane (skips street ground during Y=0 mirrored pass!)
  if (uPlanarClip > 0.5 && vWorldPos.y < 0.03) discard;

  vec4 texAlbedo = texture(uAlbedoMap, vUv);
  vec3 orm = texture(uOrmMap, vUv).rgb;
  vec3 nSample = texture(uNormalMap, vUv).xyz * 2.0 - 1.0;

  vec3 Ngeom = normalize(vNormal);
  if (!gl_FrontFacing) Ngeom = -Ngeom;
  vec3 T = normalize(vTangent.xyz - Ngeom * dot(Ngeom, vTangent.xyz));
  vec3 B = cross(Ngeom, T) * vTangent.w;
  vec3 N = normalize(T * nSample.x + B * nSample.y + Ngeom * nSample.z);

  vec3 V = normalize(uCamPos - vWorldPos);
  float NdotV = max(dot(N, V), 0.001);

  float alpha = uAlpha * texAlbedo.a;
  if (alpha < 0.02) discard;

  vec3 albedo = pow(max(texAlbedo.rgb, vec3(0.0)), vec3(2.2)) * uBaseColor * vColor;

  // FLIR Thermal Vision direct radiance path
  if (uVisionMode == 1 || uVisionMode == 2) {
    float sunWarm = max(dot(N, uSunDir), 0.0) * 0.12;
    float edgeRim = pow(1.0 - NdotV, 2.2) * 0.14;
    float detailVar = (texAlbedo.g - 0.5) * 0.08 + (orm.r - 0.5) * 0.06;
    float emissiveHeat = dot(uEmissive, vec3(0.3, 0.6, 0.1)) * 1.4;
    float baseHeat = uThermalHeat + emissiveHeat;
    float heat = baseHeat + sunWarm * (1.0 - smoothstep(0.4, 0.9, baseHeat)) + edgeRim * 0.75 + detailVar;
    float dist = length(uCamPos - vWorldPos);
    float thermalFog = 1.0 - exp(-dist * 0.0055);
    heat = mix(heat, 0.10, thermalFog * (1.0 - smoothstep(0.55, 1.0, baseHeat)));
    fragColor = vec4(vec3(max(heat, 0.02)), alpha);
    return;
  }

  if (uUnlit > 0.5) {
    fragColor = vec4(albedo + uEmissive, alpha);
    return;
  }

  float ao = orm.r;
  float rough = uRoughParam.x > 0.5
    ? clamp(uRoughParam.y + (orm.g - 0.5) * 0.45, 0.04, 1.0)
    : clamp(orm.g, 0.04, 1.0);
  float metallic = uMetalParam.x > 0.5
    ? clamp(uMetalParam.y + (orm.b - 0.5) * 0.30, 0.0, 1.0)
    : clamp(orm.b, 0.0, 1.0);
  if (uMetalParam.x > 0.5 && uMetalParam.y <= 0.01) metallic = 0.0;

  // World-space vertical foundation grime & contact AO + Continuous 4-Band Wet Asphalt & Planar Puddles!
  float soakedMask = 0.0;
  float puddleMask = 0.0;
  if (uIsViewmodel < 0.5) {
    float hY = max(vWorldPos.y, 0.0);
    float isVert = smoothstep(0.15, 0.85, 1.0 - abs(Ngeom.y));
    float contactAO = mix(0.46, 1.0, smoothstep(0.0, 0.78, hY));
    ao *= mix(1.0, contactAO, isVert * 0.92);
    float baseGrime = 1.0 - (1.0 - smoothstep(0.0, 0.65, hY)) * 0.24 * isVert;
    albedo *= baseGrime;

    // Upgrade B: Continuous 4-Band Wet Road + 6m Tar Expansion Joints + Tire Lanes + Rain Ripples
    // Strictly restricted to paved asphalt road & central plaza (zero off-road mud/dirt mercury!)
    if (Ngeom.y > 0.78 && vWorldPos.y < 0.20 && metallic < 0.15 && uPlanarClip < 0.5) {
      float macroVar = wFbm(vWorldPos.xz * 0.065);
      float midVar = wFbm(vWorldPos.xz * 0.22 + vec2(11.3, 5.7));
      albedo *= mix(0.76, 1.14, macroVar * 0.65 + midVar * 0.35);

      float inAve = 1.0 - smoothstep(9.2, 11.4, abs(vWorldPos.z));
      float inPlaza = (1.0 - smoothstep(13.0, 15.8, abs(vWorldPos.x - 4.0))) * (1.0 - smoothstep(17.5, 20.5, abs(vWorldPos.z)));
      float pavedMask = uIsRoad * max(inAve, inPlaza);

      if (vWorldPos.y < 0.12 && pavedMask > 0.01) {
        // 6m tar-sealed concrete/asphalt expansion joints
        vec2 jCell = abs(fract(vWorldPos.xz / 6.0) - 0.5) * 6.0;
        float jDist = min(jCell.x, jCell.y);
        float tarJoint = (1.0 - smoothstep(0.008, 0.026, jDist)) * pavedMask;
        albedo *= (1.0 - tarJoint * 0.48);
        ao *= (1.0 - tarJoint * 0.26);
        rough = mix(rough, 0.38, tarJoint * 0.70);

        // Traffic-polished tire lanes along Main Armored Avenue
        float lane1 = exp(-pow((abs(vWorldPos.z) - 2.6) * 0.95, 2.0));
        float lane2 = exp(-pow((abs(vWorldPos.z) - 5.6) * 0.95, 2.0));
        float tirePol = clamp((lane1 + lane2) * 0.65, 0.0, 1.0) * pavedMask;
        albedo *= (1.0 - tirePol * 0.12);
        rough = max(0.58, rough - tirePol * 0.10);

        // 4-Band Continuous Wetness Ramp: dry (~0.82) -> damp (0.44) -> soaked rim (0.18) -> puddle (0.055)
        float pField = wFbm(vWorldPos.xz * 0.125) * 0.68 + wFbm(vWorldPos.xz * 0.32 + vec2(3.7, 9.1)) * 0.32;
        float dampMask = smoothstep(0.495, 0.555, pField) * pavedMask;
        soakedMask = smoothstep(0.555, 0.605, pField) * pavedMask;
        puddleMask = smoothstep(0.605, 0.642, pField) * pavedMask;

        albedo *= mix(1.0, 0.78, dampMask);
        albedo *= mix(1.0, 0.62, soakedMask);
        albedo *= mix(1.0, 0.68, puddleMask);

        rough = mix(min(rough, 0.85), 0.44, dampMask);
        rough = mix(rough, 0.18, soakedMask);
        rough = mix(rough, 0.055, puddleMask);

        if (soakedMask > 0.01) {
          N = normalize(mix(N, vec3(0.0, 1.0, 0.0), soakedMask * 0.65));
        }
        if (puddleMask > 0.01) {
          vec2 rip = evalRainRipples(vWorldPos.xz, uTime);
          vec3 rippleN = normalize(vec3(rip.x, 1.0, rip.y));
          N = normalize(mix(N, rippleN, puddleMask * 0.97));
          NdotV = max(dot(N, V), 0.001);
        }
      }
    }
  }

  vec3 F0 = mix(vec3(0.04), albedo, metallic);
  F0 = mix(F0, vec3(0.032), max(soakedMask * 0.5, puddleMask));

  // 1. Directional Sun PBR + PCSS Physical Soft Shadows
  vec3 L = uSunDir;
  vec3 H = normalize(V + L);
  float NdotL = max(dot(N, L), 0.0);
  float NdotH = max(dot(N, H), 0.0);
  float HdotV = max(dot(H, V), 0.0);

  float shadow = (NdotL > 0.001) ? calcShadowPCSS(vShadowPos, NdotL) : 0.0;

  vec3 F = fresnelSchlick(HdotV, F0);
  float D = distributionGGX(NdotH, rough);
  float G = geometrySmith(NdotV, NdotL, rough);
  vec3 spec = (D * G * F) / (4.0 * NdotV * NdotL + 0.001);
  vec3 kD = (vec3(1.0) - F) * (1.0 - metallic);
  vec3 Lo = (kD * albedo / PI + spec) * (uSunColor * uSunIntensity) * NdotL * shadow;

  // 2. Up to 16 Simultaneous Dynamic Point Lights
  for (int i = 0; i < ${MAX_DYNAMIC_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec3 lPos = uLightPosRad[i].xyz;
    float lRad = uLightPosRad[i].w;
    vec3 toL = lPos - vWorldPos;
    float d2 = dot(toL, toL);
    if (d2 > lRad * lRad) continue;
    float d = sqrt(d2);
    vec3 Lp = toL / max(d, 0.0001);
    float pNdotL = max(dot(N, Lp), 0.0);
    if (pNdotL <= 0.0001) continue;

    float ratio = d / max(lRad, 0.01);
    float r2 = ratio * ratio;
    float win = clamp(1.0 - r2 * r2, 0.0, 1.0);
    float atten = (win * win) / (d2 * 0.55 + 0.45);

    vec3 Hp = normalize(V + Lp);
    vec3 Fp = fresnelSchlick(max(dot(Hp, V), 0.0), F0);
    float Dp = distributionGGX(max(dot(N, Hp), 0.0), rough);
    float Gp = geometrySmith(NdotV, pNdotL, rough);
    vec3 pSpec = (Dp * Gp * Fp) / (4.0 * NdotV * pNdotL + 0.001);
    vec3 pKd = (vec3(1.0) - Fp) * (1.0 - metallic);
    Lo += (pKd * albedo / PI + pSpec) * uLightColInt[i].rgb * atten * pNdotL;
  }

  // 3. Dual-Hemisphere Sky/Ground Bounce GI + Analytical IBL + Live Planar Mirror Reflections!
  float hemi = N.y * 0.5 + 0.5;
  vec3 skyDiff = mix(uGroundBounce, mix(uSkyHorizon * 0.62, uSkyTop * 1.22, clamp(N.y, 0.0, 1.0)), hemi);
  float wrapSun = clamp(dot(N, uSunDir) * 0.45 + 0.55, 0.0, 1.0);
  skyDiff += uSunColor * (0.06 * wrapSun);

  vec3 F_ibl = fresnelSchlickRoughness(NdotV, F0, rough);
  vec3 kD_ibl = (vec3(1.0) - F_ibl) * (1.0 - metallic);
  vec3 diffuseIBL = kD_ibl * albedo * skyDiff * 0.72;

  vec3 R = reflect(-V, N);
  vec3 envSpec = evalAnalyticalIBL(R, rough);
  float specOccl = clamp(pow(NdotV + ao, exp2(-16.0 * rough - 1.0)) - 1.0 + ao, 0.0, 1.0);
  vec3 specularIBL = envSpec * (F_ibl * mix(1.05, 0.30, rough)) * specOccl;

  float wetBlend = max(soakedMask * 0.38, puddleMask);
  if (wetBlend > 0.01 && uPlanarClip < 0.5) {
    float pFresnel = 0.025 + 0.88 * pow(clamp(1.0 - NdotV, 0.0, 1.0), 4.5);
    vec3 wetEnv = envSpec * mix(0.32, 0.72, smoothstep(-0.04, 0.32, R.y));
    if (uPlanarEnabled > 0.5) {
      vec2 reflUv = gl_FragCoord.xy * uInvScreen;
      reflUv += N.xz * mix(0.14, 0.42, puddleMask);
      reflUv = clamp(reflUv, vec2(0.004), vec2(0.996));
      vec3 planarCol = texture(uPlanarReflTex, reflUv).rgb;
      // Blend real-time mirrored buildings, tanks, burning wrecks & sky cleanly!
      wetEnv = mix(wetEnv, planarCol * 0.82, mix(0.45, 0.92, puddleMask));
    }
    specularIBL = mix(specularIBL, wetEnv * pFresnel, wetBlend);
  }

  // Restrained Tactical Viewmodel Rim/Key PBR Polish (zero frosted-silver blowout!)
  vec3 vmBoost = vec3(0.0);
  if (uIsViewmodel > 0.5) {
    ao = pow(ao, 1.35);
    float vmRim = pow(1.0 - NdotV, 3.6) * (0.25 + 0.75 * clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
    vec3 coolRim = vec3(0.22, 0.30, 0.42) * vmRim * mix(0.04, 0.18, metallic);
    vec3 keySheen = (spec * (uSunColor * uSunIntensity) * NdotL * shadow) * (0.10 * metallic);
    vmBoost = albedo * 0.02 + coolRim + keySheen;
  }

  vec3 color = (diffuseIBL * ao) + specularIBL + Lo + uEmissive + vmBoost;

  // 4. Atmospheric Distance Fog + Low Ground Haze + Controlled Solar Mie Scattering
  if (uIsViewmodel < 0.5) {
    float dist = length(vWorldPos - uCamPos);
    vec3 viewDir = (vWorldPos - uCamPos) / max(dist, 0.001);
    float heightHaze = exp(-max(vWorldPos.y, 0.0) * 0.14);
    float fogDensity = 0.0019 + heightHaze * 0.0013;
    float fogOnset = smoothstep(16.0, 36.0, dist);
    float fogAmt = (1.0 - exp(-max(dist - 12.0, 0.0) * fogDensity)) * fogOnset;
    fogAmt = clamp(fogAmt, 0.0, 0.56);

    float sunScatter = pow(max(dot(viewDir, uSunDir), 0.0), 5.5);
    vec3 coolFog = vec3(0.09, 0.13, 0.19);
    vec3 warmFog = vec3(0.36, 0.21, 0.11);
    vec3 fogColor = mix(coolFog, warmFog, sunScatter * 0.65 + heightHaze * 0.12);
    color = mix(color, fogColor, fogAmt);
  }

  fragColor = vec4(color, alpha);
}`;

  // Procedural Atmospheric Donbas Sky Dome Shader
  const SKY_VS = `#version 300 es
precision highp float;
out vec2 vNdc;
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vNdc = pos * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 1.0, 1.0);
}`;

  const SKY_FS = `#version 300 es
precision highp float;
in vec2 vNdc;

uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform float uTime;
uniform int uVisionMode;

out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = m * p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec4 farClip = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 worldFar = farClip.xyz / farClip.w;
  vec3 dir = normalize(worldFar - uCamPos);
  float y = dir.y;
  float az = atan(dir.z, dir.x);

  if (uVisionMode == 1 || uVisionMode == 2) {
    float h = clamp(y, 0.0, 1.0);
    float cold = mix(0.11, 0.03, pow(h, 0.6));
    float cl = fbm(vec2(az * 2.5 + uTime * 0.008, h * 5.0)) * 0.03;
    fragColor = vec4(vec3(cold + cl), 1.0);
    return;
  }

  float up = clamp(y, 0.0, 1.0);
  float sunDot = max(dot(dir, uSunDir), 0.0);
  float sunAz = pow(max(dot(normalize(vec3(dir.x, 0.0, dir.z) + 1e-5), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0), 2.4);

  vec3 zenith = vec3(0.06, 0.10, 0.18);
  vec3 midSky = mix(vec3(0.14, 0.20, 0.29), vec3(0.32, 0.26, 0.26), sunAz * 0.65);
  vec3 horz = mix(vec3(0.19, 0.22, 0.28), vec3(0.95, 0.52, 0.22), sunAz * 0.85);

  vec3 col = mix(horz, midSky, pow(up, 0.38));
  col = mix(col, zenith, pow(up, 1.05));

  float mieWide = pow(sunDot, 5.5) * 0.48;
  float mieTight = pow(sunDot, 42.0) * 1.15;
  float sunDisk = smoothstep(0.9986, 0.99945, sunDot) * 8.5;
  col += uSunColor * (mieWide + mieTight) * smoothstep(-0.08, 0.28, y);
  col += vec3(1.0, 0.90, 0.72) * sunDisk * smoothstep(-0.02, 0.05, y);

  if (y > -0.02) {
    vec2 cloudUv = dir.xz / (max(y, 0.05) + 0.13) * 1.45;
    float c1 = fbm(cloudUv + vec2(uTime * 0.015, uTime * 0.007));
    float c2 = fbm(cloudUv * 2.3 - vec2(uTime * 0.010, -uTime * 0.012));
    float cDensity = c1 * 0.68 + c2 * 0.32;
    float sunBreak = smoothstep(0.96, 0.996, sunDot) * 0.28;
    float cloudMask = smoothstep(0.35 + sunBreak, 0.74 + sunBreak * 0.5, cDensity) * smoothstep(0.0, 0.14, y);
    float edgeSilver = smoothstep(0.34, 0.54, cDensity) * (1.0 - smoothstep(0.54, 0.72, cDensity));

    float sunRim = pow(sunDot, 2.5);
    vec3 cloudBelly = mix(vec3(0.08, 0.10, 0.15), vec3(0.16, 0.14, 0.15), sunRim * 0.55);
    vec3 cloudGoldRim = mix(vec3(0.34, 0.36, 0.42), vec3(1.55, 0.88, 0.42), 0.35 + 0.65 * sunRim);
    vec3 cloudCol = mix(cloudBelly, cloudGoldRim, clamp(edgeSilver * 1.85 + (1.0 - c2) * sunRim * 0.55, 0.0, 1.0));
    col = mix(col, cloudCol, cloudMask * 0.86);
  }

  float colWave = sin(az * 7.0 + 1.2) * 0.5 + 0.5;
  float smokeCol = pow(colWave, 8.0) * (1.0 - smoothstep(0.02, 0.24, y)) * smoothstep(-0.04, 0.01, y);
  float smokeNoise = fbm(vec2(az * 14.0, y * 16.0 - uTime * 0.18));
  col = mix(col, vec3(0.14, 0.15, 0.17), clamp(smokeCol * smokeNoise * 1.15, 0.0, 0.72));

  float cityBlock = floor((az + 3.14159) * 28.0);
  float bHeight = (hash(vec2(cityBlock, 3.1)) * 0.036 + 0.006) * step(0.28, hash(vec2(cityBlock, 8.7)));
  float stack = step(0.90, hash(vec2(floor((az + 3.14159) * 72.0), 19.3))) * 0.048;
  float ruinNotch = (noise(vec2(az * 95.0, 2.0)) - 0.5) * 0.008;
  float skylineY = max(bHeight, stack) + ruinNotch;
  if (y < skylineY) {
    float fogSilhouette = smoothstep(-0.02, 0.05, y);
    vec3 cityCol = mix(vec3(0.11, 0.13, 0.16), horz * 0.42, fogSilhouette * 0.65);
    float ember = step(0.95, hash(vec2(cityBlock, 44.2))) * (1.0 - smoothstep(0.0, 0.014, abs(y - 0.004)));
    cityCol += vec3(1.4, 0.45, 0.12) * ember * (0.65 + 0.35 * sin(uTime * 4.5 + cityBlock));
    col = mix(col, cityCol, 1.0 - smoothstep(skylineY - 0.004, skylineY, y));
  }

  fragColor = vec4(col, 1.0);
}`;

  // Upgrade F: 3-Layer Pixel-Width-Clamped Velocity-Aligned HDR Tracer Shader
  const TRACER_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec4 aFromWidth; // xyz = tail start, w = base width
layout(location = 1) in vec4 aToAlpha;   // xyz = nose tip, w = alpha
layout(location = 2) in vec4 aColorHot;  // rgb = tracer tint, w = maxPx

uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform float uWorldPerPx;

out vec2 vUv;
out vec3 vColor;
out float vAlpha;

void main() {
  float along = (gl_VertexID & 2) == 0 ? 0.0 : 1.0; // 0 = tail, 1 = leading nose
  float sideSign = (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
  vUv = vec2(sideSign, along);
  vColor = aColorHot.rgb;
  vAlpha = aToAlpha.w;

  vec3 p0 = aFromWidth.xyz;
  vec3 p1 = aToAlpha.xyz;
  vec3 seg = p1 - p0;
  float segLen = length(seg);
  vec3 dir = segLen > 0.0001 ? (seg / segLen) : vec3(0.0, 0.0, -1.0);
  vec3 pos = mix(p0, p1, along);
  vec3 toCam = uCamPos - pos;
  float dist = max(length(toCam), 0.1);
  vec3 side = cross(toCam / dist, dir);
  float sLen = length(side);
  side = sLen > 0.001 ? (side / sLen) : vec3(1.0, 0.0, 0.0);

  // Pixel-width clamped: razor-thin core + 6x outer glow envelope visible cleanly at any distance!
  float maxPx = max(aColorHot.w, 12.0);
  float halfW = clamp(aFromWidth.w * 3.0, dist * uWorldPerPx * 2.2, dist * uWorldPerPx * maxPx);
  vec3 wp = pos + side * (sideSign * halfW);
  gl_Position = uViewProj * vec4(wp, 1.0);
}`;

  const TRACER_FS = `#version 300 es
precision highp float;

in vec2 vUv;
in vec3 vColor;
in float vAlpha;

uniform int uVisionMode;
out vec4 fragColor;

void main() {
  float across = abs(vUv.x); // 0 = center, 1 = outer halo edge
  float along = vUv.y;       // 0 = tail, 1 = nose tip

  float alongFade = smoothstep(0.0, 0.72, along) * (1.0 - smoothstep(0.92, 1.0, along));
  // Layer 1: Razor-thin blazing incandescent core (1/6 of quad width)
  float core = exp(-pow(across / 0.15, 2.0) * 4.5) * alongFade;
  // Layer 2: 6x wide faint atmospheric bloom halo
  float halo = exp(-pow(across / 0.82, 2.0) * 2.6) * alongFade * 0.24;
  // Layer 3: White-hot leading nose spark
  float nose = exp(-pow(across / 0.26, 2.0) * 5.0) * smoothstep(0.76, 0.95, along) * (1.0 - smoothstep(0.96, 1.0, along));

  float energy = core + halo + nose * 1.4;
  if (energy <= 0.008) discard;

  vec3 col = vColor * (halo * 1.8 + core * 3.6) + vec3(4.5, 4.1, 3.2) * (core * 0.55 + nose * 1.6);
  if (uVisionMode == 1 || uVisionMode == 2) {
    col = vec3(2.8 * energy);
  }
  fragColor = vec4(col * vAlpha, 0.0);
}`;

  // Soft-Particle Instanced Shader (3D spherical+billow smoke, soot-backed flames, velocity-stretched sparks, starburst flash)
  const PARTICLE_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec4 aInstPosSize;
layout(location = 1) in vec4 aInstColorAlpha;
layout(location = 2) in vec4 aInstParams;
layout(location = 3) in vec4 aInstVel;

uniform mat4 uView;
uniform mat4 uProj;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform vec3 uCamPos;
uniform float uTime;

out vec2 vUv;
out vec4 vColorAlpha;
out vec4 vParams;
out float vLinearZ;
out vec3 vWorldPos;

void main() {
  vec2 corner = vec2((gl_VertexID & 1) == 0 ? -1.0 : 1.0, (gl_VertexID & 2) == 0 ? -1.0 : 1.0);
  vUv = corner * 0.5 + 0.5;
  vColorAlpha = aInstColorAlpha;
  vParams = aInstParams;

  vec3 center = aInstPosSize.xyz;
  float size = aInstPosSize.w;
  float typeId = floor(aInstParams.x + 0.01);
  float rot = aInstParams.y;
  float stretch = aInstVel.w;

  vec3 rightVec = uCamRight;
  vec3 upVec = uCamUp;

  if (stretch > 0.01) {
    vec3 vel = aInstVel.xyz;
    float vLen = length(vel);
    if (vLen > 0.15) {
      vec3 dir = vel / vLen;
      vec3 vProj = vel - uCamForward * dot(vel, uCamForward);
      float projLen = length(vProj);
      vec3 toCam = normalize(uCamPos - center);
      vec3 side = cross(toCam, dir);
      float sLen = length(side);
      side = sLen > 0.001 ? (side / sLen) : uCamRight;
      float dynStretch = (typeId > 1.5 && typeId < 2.5)
        ? clamp(stretch * (0.45 + projLen * 0.14), 1.8, 11.5)
        : clamp(stretch * (0.65 + projLen * 0.04), 2.5, 14.0);
      float thinW = (typeId > 1.5 && typeId < 2.5) ? 0.24 : 0.18;
      rightVec = side * thinW;
      upVec = dir * dynStretch;
    }
  } else if (typeId > 0.5 && typeId < 1.5) {
    vec3 upProj = vec3(0.0, 1.0, 0.0) - uCamForward * uCamForward.y;
    float uLen = length(upProj);
    vec3 upright = uLen > 0.01 ? (upProj / uLen) : uCamUp;
    vec3 side = normalize(cross(uCamForward, upright));
    float lean = sin(uTime * 7.5 + rot * 11.3) * 0.13;
    rightVec = (side + upright * lean) * 0.84;
    upVec = (upright - side * lean) * 1.48;
  } else if (typeId > 5.5 && typeId < 6.5) {
    rightVec = normalize(mix(vec3(1.0, 0.0, 0.0), uCamRight, 0.35));
    upVec = normalize(mix(vec3(0.0, 0.0, 1.0), uCamUp, 0.35));
  } else {
    float c = cos(rot), s = sin(rot);
    rightVec = uCamRight * c + uCamUp * s;
    upVec = -uCamRight * s + uCamUp * c;
    if (typeId < 0.5 || (typeId > 2.5 && typeId < 3.5)) {
      size *= 1.34;
    }
  }

  vec3 worldPos = center + (rightVec * corner.x + upVec * corner.y) * (size * 0.5);
  vWorldPos = worldPos;
  vec4 viewPos = uView * vec4(worldPos, 1.0);
  vLinearZ = -viewPos.z;
  gl_Position = uProj * viewPos;
}`;

  const PARTICLE_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
in vec4 vColorAlpha;
in vec4 vParams;
in float vLinearZ;
in vec3 vWorldPos;

uniform sampler2D uDepthTex;
uniform sampler2D uSmokeAtlas;
uniform vec2 uInvScreen;
uniform float uNear;
uniform float uFar;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyTop;
uniform float uTime;
uniform int uVisionMode;

uniform int uLightCount;
uniform vec4 uLightPosRad[${MAX_DYNAMIC_LIGHTS}];
uniform vec4 uLightColInt[${MAX_DYNAMIC_LIGHTS}];

out vec4 fragColor;

float linearizeDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / max(uFar + uNear - z * (uFar - uNear), 0.0001);
}

vec4 sampleSmokeAtlas(vec2 uv, float variantIdx) {
  float idx = clamp(floor(variantIdx + 0.5), 0.0, 3.0);
  vec2 cell = vec2(mod(idx, 2.0), floor(idx * 0.5));
  vec2 atlasUv = (cell + clamp(uv, 0.02, 0.98)) * 0.5;
  return texture(uSmokeAtlas, atlasUv);
}

float pHash2(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float pNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(pHash2(i), pHash2(i + vec2(1.0, 0.0)), f.x),
    mix(pHash2(i + vec2(0.0, 1.0)), pHash2(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float pFbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 3; i++) {
    v += a * pNoise(p);
    p = m * p * 2.05 + vec2(3.7, 8.1);
    a *= 0.5;
  }
  return v / 0.875;
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.02) discard;

  float typeId = floor(vParams.x + 0.01);
  float variant = floor(fract(vParams.x) * 10.0 + 0.5);
  float rot = vParams.y;
  float age = vParams.z;
  float isAdd = vParams.w;

  vec2 screenUv = gl_FragCoord.xy * uInvScreen;
  float sceneDepth = linearizeDepth(texture(uDepthTex, screenUv).r);
  float softRange = (typeId < 0.5 || (typeId > 2.5 && typeId < 3.5)) ? 1.55 : ((typeId < 1.5) ? 0.65 : 0.45);
  float depthFade = smoothstep(0.0, softRange, sceneDepth - vLinearZ);
  if (depthFade <= 0.005) discard;

  vec3 col = vColorAlpha.rgb;
  float alpha = vColorAlpha.a * depthFade;
  float outA = (isAdd > 0.5) ? 0.0 : alpha;

  if (typeId < 0.5 || (typeId > 2.5 && typeId < 3.5)) {
    // 0: Volumetric Billowing Smoke / 3: Dust — 3D spherical normal Ns + billow normal Nb + age erosion
    vec4 atlas1 = sampleSmokeAtlas(vUv, variant);
    vec2 driftUv = clamp(vUv * 0.84 + 0.08 + vec2(sin(age * 1.4 + rot) * 0.09, -age * 0.16), 0.02, 0.98);
    vec4 atlas2 = sampleSmokeAtlas(driftUv, mod(variant + 1.0, 4.0));
    float wispNoise = pFbm(vUv * 4.2 + vec2(rot * 1.9 + age * 0.6, -age * 0.9));

    float rawD = atlas1.a * (0.52 + 0.52 * atlas2.a) * (0.62 + 0.62 * wispNoise);
    float er = age * 0.28;
    float density = smoothstep(er, er + 0.62, rawD);
    if (density <= 0.015) discard;

    // Combine 3D spherical puff normal Ns with rotated atlas billow normal Nb
    float c = cos(rot), s = sin(rot);
    vec2 spXY = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
    vec3 Ns = normalize(uCamRight * spXY.x + uCamUp * spXY.y - uCamForward * sqrt(max(0.08, 1.0 - min(0.92, r * r))));
    vec3 tn = normalize(mix(atlas1.rgb, atlas2.rgb, 0.35) * 2.0 - 1.0);
    vec2 rxy = vec2(tn.x * c - tn.y * s, tn.x * s + tn.y * c);
    vec3 Nb = normalize(uCamRight * rxy.x + uCamUp * rxy.y - uCamForward * max(tn.z, 0.25));
    vec3 N_puff = normalize(mix(Ns, Nb, 0.65));

    float NdotL = dot(N_puff, uSunDir);
    float sunWrap = clamp(NdotL * 0.52 + 0.48, 0.0, 1.0);
    float topSky = clamp(N_puff.y * 0.45 + 0.55, 0.0, 1.0);
    float shadowSide = mix(0.44, 1.0, sunWrap);

    vec3 viewDir = normalize(vWorldPos - uCamPos);
    float forwardScatter = pow(max(dot(viewDir, uSunDir), 0.0), 5.0) * density * 0.55;

    vec3 ambCol = mix(uSkyTop * 0.95, vec3(0.32, 0.36, 0.42), topSky * 0.55);
    vec3 sunLit = uSunColor * (1.18 * shadowSide + forwardScatter);

    vec3 fireGlow = vec3(0.0);
    for (int i = 0; i < ${MAX_DYNAMIC_LIGHTS}; i++) {
      if (i >= uLightCount) break;
      vec3 toL = uLightPosRad[i].xyz - vWorldPos;
      float lRad = uLightPosRad[i].w * 1.15;
      float d2 = dot(toL, toL);
      if (d2 > lRad * lRad) continue;
      float d = sqrt(d2);
      float w = clamp(1.0 - d / max(lRad, 0.01), 0.0, 1.0);
      float pWrap = clamp(dot(N_puff, toL / max(d, 0.001)) * 0.5 + 0.5, 0.0, 1.0);
      fireGlow += uLightColInt[i].rgb * (w * w / (d2 * 0.50 + 1.25)) * pWrap * 1.05;
    }

    float colLum = dot(col, vec3(0.3, 0.59, 0.11));
    bool isHeavyOil = (typeId < 0.5 && colLum < 0.35);
    vec3 smokeBase = isHeavyOil ? (col * 0.72) : (col * 0.90);
    float coreFireMask = (density * density) * (1.0 - smoothstep(0.10, 0.62, r));
    col = smokeBase * (ambCol + sunLit) + min(fireGlow, vec3(1.65)) * coreFireMask * 0.68;

    float puffCap = isHeavyOil ? 0.42 : 0.28;
    float radialFade = 1.0 - smoothstep(0.08, 0.74, r);
    float camNearFade = smoothstep(1.2, 3.0, vLinearZ);
    alpha = min(alpha, 1.0) * puffCap * (density * density * 0.72 + density * 0.28) * radialFade * camNearFade;
    outA = alpha;
  } else if (typeId < 1.5) {
    // 1: Alpha-Blended Soot-Backed Turbulent Fire Tongues (sculpted lobes, smoke occludes cleanly!)
    float y01 = clamp(p.y * 0.5 + 0.5, 0.0, 1.0);
    float flick = uTime * 4.4 + rot * 13.7;
    float sway = (pNoise(vec2(y01 * 2.5 - flick * 0.52, rot * 3.1)) - 0.5) * (0.20 + 0.58 * y01);
    float taperWidth = max(0.68 * pow(1.0 - y01, 0.78) + 0.04, 0.04);
    float xDist = abs(p.x + sway) / taperWidth;

    float turb1 = pFbm(vec2((p.x + sway) * 3.8, y01 * 3.4 - flick * 0.88) + vec2(rot * 5.3, 0.0));
    float turb2 = pFbm(vec2((p.x - sway) * 7.5, y01 * 6.8 - flick * 1.55) + vec2(11.1, rot * 2.7));
    float vertEnv = smoothstep(0.0, 0.16, y01) * (1.0 - smoothstep(0.42, 0.96, y01));
    float carved = vertEnv * (1.0 - smoothstep(0.08, 1.02, xDist + (0.54 - turb1) * 1.25));
    float sootMask = smoothstep(0.12, 0.62, carved * (0.60 + 0.85 * turb2));
    float wisps = smoothstep(0.24, 0.78, carved * (0.55 + 0.95 * turb2));
    if (sootMask <= 0.02) discard;

    // Charred soot backing at turbulent outer lobe -> blazing crimson-orange -> hot gold-white base core
    vec3 sootCol = vec3(0.05, 0.04, 0.035);
    vec3 fireCol = mix(vec3(0.92, 0.09, 0.01), vec3(1.65, 0.42, 0.03), smoothstep(0.04, 0.45, wisps));
    fireCol = mix(fireCol, vec3(2.55, 1.32, 0.32), smoothstep(0.40, 0.78, wisps) * (1.0 - y01 * 0.60));
    fireCol = mix(fireCol, vec3(3.4, 2.8, 1.8), pow(wisps, 3.0) * (1.0 - y01 * 0.78));
    col = mix(sootCol, fireCol * (0.88 + 0.40 * (1.0 - age)), smoothstep(0.05, 0.42, wisps));
    alpha *= sootMask * 0.88;
    // Alpha-blended soot backing so smoke naturally occludes fire instead of blowing out flat white!
    outA = clamp(sootMask * 0.68, 0.0, 0.82);
  } else if (typeId < 2.5 || (typeId > 6.5 && typeId < 7.5)) {
    // 2: Velocity-Stretched Spark Needle / 7: 3-Layer Incandescent Tracer Particle
    float along = vUv.y;
    float halfW = max(0.14 + 0.42 * along, 0.06);
    float acrossEnv = exp(-pow(abs(p.x) / halfW, 2.0) * 5.2);
    float haloEnv = exp(-pow(abs(p.x) / 0.85, 2.0) * 2.5) * 0.22;
    float tailEnv = smoothstep(0.0, 0.78, along) * (1.0 - smoothstep(0.86, 1.0, along));
    float needle = (acrossEnv + haloEnv) * tailEnv;
    if (needle <= 0.01) discard;
    vec3 tailCol = mix(vec3(1.5, 0.28, 0.03), vec3(2.8, 1.55, 0.48), pow(along, 1.15));
    vec3 sparkCol = mix(tailCol, vec3(5.2, 4.6, 3.3), pow(along, 3.6) * acrossEnv);
    col = sparkCol * (0.45 + 0.75 * col);
    alpha *= clamp(needle, 0.0, 1.0);
    outA = 0.0;
  } else if (typeId < 4.5) {
    // 4: Angular tumbling masonry/rubble debris chunk with top/bottom directional shading
    float ang = atan(p.y, p.x);
    float poly = 0.62 + 0.22 * cos(ang * 3.0 + rot * 4.0) + 0.14 * sin(ang * 5.0 - rot * 3.0);
    float shape = 1.0 - smoothstep(poly * 0.80, poly, r);
    if (shape <= 0.05) discard;
    float shade = 0.55 + 0.55 * clamp(p.y * 0.5 + 0.5, 0.0, 1.0);
    col *= shade * (uSkyTop * 0.7 + uSunColor * 0.55 + 0.25);
    alpha *= shape;
    outA = alpha;
  } else if (typeId > 8.5) {
    // 9: Brass shell casing silhouette with metallic sheen
    float shape = 1.0 - smoothstep(0.45, 0.68, max(abs(p.x) * 1.4, abs(p.y) * 0.72));
    if (shape <= 0.05) discard;
    col *= (0.65 + 0.85 * exp(-p.x * p.x * 14.0));
    alpha *= shape;
    outA = alpha;
  } else if (typeId < 5.5) {
    // 5: Organic Soft-Feathered Starburst Muzzle Flash / Explosion Core
    float ang = atan(p.y, p.x);
    float flareNoise = pNoise(vec2(ang * 3.4 + rot * 4.7, r * 3.2 + rot));
    float spikes = 0.48 + 0.30 * cos(ang * 5.0 + rot * 6.0) + 0.22 * sin(ang * 7.0 - rot * 3.5);
    float spikeLen = clamp(spikes * (0.65 + 0.65 * flareNoise), 0.22, 0.92);
    float flare = exp(-pow(r / spikeLen, 2.2) * 3.4);
    float hotCore = exp(-r * r * 16.0);
    float outerCorona = exp(-r * r * 4.8) * 0.42;
    float edgeMask = 1.0 - smoothstep(0.28, 0.94, r);
    float flash = clamp((hotCore * 1.4 + flare * 0.85 + outerCorona) * edgeMask, 0.0, 1.6);
    if (flash <= 0.01) discard;
    vec3 fCol = mix(vec3(1.6, 0.55, 0.10), vec3(4.8, 3.8, 2.2), clamp(hotCore * 1.35 + flare * 0.35, 0.0, 1.0));
    col = fCol * (0.55 + 0.55 * col);
    alpha *= clamp(flash, 0.0, 1.0);
    outA = 0.0;
  } else if (typeId < 6.5) {
    // 6: Turbulent explosion blast shockwave / dust ring (organic tattered edge)
    float ang = atan(p.y, p.x);
    float nRing = pNoise(vec2(ang * 4.0 + rot * 3.0, r * 4.5 - age * 2.0));
    float rPert = r + (nRing - 0.5) * 0.11;
    float ring = exp(-pow((rPert - 0.74) * 9.5, 2.0)) * (0.65 + 0.55 * nRing);
    col = col * 1.45;
    alpha *= clamp(ring, 0.0, 1.0);
    outA = 0.0;
  } else if (typeId > 7.5 && typeId < 8.5) {
    // 8: Dark arterial-crimson blood mist + fine scattered droplets (never pastel-pink cotton balls!)
    float nMist = pFbm(vUv * 5.5 + vec2(rot * 3.1, age * 0.9));
    float nDrops = pNoise(vUv * 15.0 + vec2(rot * 7.3, rot * 2.9));
    float mist = smoothstep(0.34, 0.78, nMist) * (1.0 - smoothstep(0.10, 0.74, r)) * 0.55;
    float drops = smoothstep(0.68, 0.86, nDrops) * (1.0 - smoothstep(0.20, 0.86, r)) * 0.92;
    float bMask = clamp(mist + drops, 0.0, 1.0) * (1.0 - age * 0.55);
    if (bMask <= 0.03) discard;
    float lit = 0.45 + 0.55 * clamp(uSunDir.y * 0.5 + 0.5, 0.0, 1.0);
    col = vec3(0.15, 0.007, 0.009) * (0.65 + 0.55 * drops) * lit;
    alpha *= bMask * 0.82;
    outA = alpha;
  } else {
    vec4 atlas = sampleSmokeAtlas(vUv, variant);
    alpha *= smoothstep(0.05, 0.85, atlas.a);
    outA = alpha;
  }

  if (alpha <= 0.004) discard;

  if (uVisionMode == 1 || uVisionMode == 2) {
    float thermalVal = (typeId > 0.5 && typeId < 2.5) || (typeId > 4.5 && typeId < 7.5) ? 2.4 : (typeId > 7.5 && typeId < 8.5 ? 0.95 : 0.18);
    col = vec3(thermalVal);
  }

  fragColor = vec4(col * alpha, outA);
}`;

  // Zero-CPU GPU Atmospheric Floating Dust Motes & Drifting Battle Ash (1 instanced draw call!)
  const MOTE_VS = `#version 300 es
precision highp float;

uniform mat4 uView;
uniform mat4 uProj;
uniform mat4 uLightVP;
uniform sampler2D uShadowMap;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uTime;

out vec2 vUv;
out float vSunLit;
out float vAlpha;
out float vLinearZ;

float mHash(float n) {
  return fract(sin(n * 127.1 + 311.7) * 43758.5453123);
}

void main() {
  vec2 corner = vec2((gl_VertexID & 1) == 0 ? -1.0 : 1.0, (gl_VertexID & 2) == 0 ? -1.0 : 1.0);
  vUv = corner;
  float id = float(gl_InstanceID);

  vec3 box = vec3(20.0, 9.0, 20.0);
  vec3 seed = vec3(mHash(id * 1.3 + 0.7), mHash(id * 2.9 + 5.1), mHash(id * 4.7 + 11.3));
  vec3 drift = vec3(
    uTime * (0.32 + seed.y * 0.25) + sin(uTime * 0.7 + id * 1.7) * 0.55,
    sin(uTime * 0.55 + id * 2.3) * 0.45 - uTime * (0.08 + seed.x * 0.09),
    uTime * (0.14 - seed.z * 0.20) + cos(uTime * 0.6 + id * 1.1) * 0.50
  );
  vec3 rel = mod(seed * box + drift - uCamPos + box * 0.5, box) - box * 0.5;
  vec3 center = uCamPos + rel;
  center.y = max(center.y, 0.22);

  // Sample directional sun shadow map so dust motes glint warm gold inside sunbeams & dim ash in shade!
  vec4 lp = uLightVP * vec4(center, 1.0);
  vec3 sp = (lp.xyz / lp.w) * 0.5 + 0.5;
  float vis = 0.0;
  if (sp.x > 0.01 && sp.x < 0.99 && sp.y > 0.01 && sp.y < 0.99 && sp.z > 0.0 && sp.z < 1.0) {
    vis = step(sp.z - 0.004, textureLod(uShadowMap, sp.xy, 0.0).r);
  }
  vSunLit = vis;

  float dist = length(center - uCamPos);
  float edgeFade = smoothstep(1.6, 3.8, dist) * (1.0 - smoothstep(6.8, 9.8, length(rel.xz)));
  float shimmer = 0.65 + 0.35 * sin(uTime * (2.4 + seed.x * 3.0) + id * 5.7);
  vAlpha = edgeFade * shimmer;

  float sz = mix(0.014, 0.028, seed.z) * (1.0 + vis * 0.35);
  vec3 wp = center + (uCamRight * corner.x + uCamUp * corner.y) * sz;
  vec4 vp = uView * vec4(wp, 1.0);
  vLinearZ = -vp.z;
  gl_Position = uProj * vp;
}`;

  const MOTE_FS = `#version 300 es
precision highp float;

in vec2 vUv;
in float vSunLit;
in float vAlpha;
in float vLinearZ;

uniform sampler2D uDepthTex;
uniform vec2 uInvScreen;
uniform float uNear;
uniform float uFar;
uniform vec3 uSunColor;

out vec4 fragColor;

float linearizeDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / max(uFar + uNear - z * (uFar - uNear), 0.0001);
}

void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0 || vAlpha < 0.02) discard;
  float soft = exp(-r2 * 4.5) * (1.0 - smoothstep(0.55, 1.0, r2));

  float sceneDepth = linearizeDepth(texture(uDepthTex, gl_FragCoord.xy * uInvScreen).r);
  float zVis = smoothstep(0.0, 0.35, sceneDepth - vLinearZ);
  float a = soft * vAlpha * zVis * mix(0.24, 0.42, vSunLit);
  if (a < 0.008) discard;

  vec3 col = mix(vec3(0.16, 0.18, 0.21), uSunColor * 1.45, vSunLit);
  fragColor = vec4(col * a, a * (1.0 - vSunLit * 0.75));
}`;

  // Persistent GPU-Instanced Multi-Material Bullet-Hole & Scorch Decal Shader (256x256 Atlas!)
  const DECAL_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec4 aDecalPosSize;
layout(location = 1) in vec4 aDecalNormRot;
layout(location = 2) in vec4 aDecalParams;

uniform mat4 uViewProj;

out vec2 vUv;
out vec3 vWorldPos;
out vec3 vNormal;
out vec4 vParams;

void main() {
  vec2 corner = vec2((gl_VertexID & 1) == 0 ? -1.0 : 1.0, (gl_VertexID & 2) == 0 ? -1.0 : 1.0);
  vUv = corner * 0.5 + 0.5;
  vParams = aDecalParams;

  vec3 N = normalize(aDecalNormRot.xyz);
  vNormal = N;
  vec3 ref = abs(N.y) < 0.92 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(ref, N));
  vec3 B = cross(N, T);
  float c = cos(aDecalNormRot.w), s = sin(aDecalNormRot.w);
  vec3 rAxis = T * c + B * s;
  vec3 uAxis = -T * s + B * c;

  vec3 wp = aDecalPosSize.xyz + (rAxis * corner.x + uAxis * corner.y) * aDecalPosSize.w;
  vWorldPos = wp;
  gl_Position = uViewProj * vec4(wp, 1.0);
}`;

  const DECAL_FS = `#version 300 es
precision highp float;

in vec2 vUv;
in vec3 vWorldPos;
in vec3 vNormal;
in vec4 vParams;

uniform sampler2D uDecalAtlas;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyTop;
uniform int uVisionMode;

out vec4 fragColor;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;

  float typeId = vParams.x;
  float age = vParams.y;
  float strength = vParams.w;

  vec3 col;
  float alpha;
  float hotEmber = 0.0;

  if (typeId < 3.5) {
    float idx = clamp(floor(typeId + 0.5), 0.0, 3.0);
    vec2 cell = vec2(mod(idx, 2.0), floor(idx * 0.5));
    vec2 aUv = (cell + clamp(vUv, 0.015, 0.985)) * 0.5;
    vec4 tex = texture(uDecalAtlas, aUv);
    col = pow(max(tex.rgb, vec3(0.0)), vec3(2.2));
    alpha = tex.a * strength;
    if (typeId > 2.5) {
      float coolFade = 1.0 - smoothstep(0.0, 9.0, age);
      hotEmber = (1.0 - smoothstep(0.08, 0.42, r)) * coolFade * tex.a;
    }
  } else {
    // Blood splatter
    float ang = atan(p.y, p.x);
    float lob = 0.55 + 0.25 * sin(ang * 5.0 + vParams.z) + 0.16 * cos(ang * 9.0 - vParams.z * 2.0);
    alpha = (1.0 - smoothstep(lob * 0.45, lob, r)) * 0.78 * strength;
    col = vec3(0.14, 0.008, 0.008);
  }

  if (alpha <= 0.02) discard;

  if (uVisionMode == 1 || uVisionMode == 2) {
    float th = typeId > 2.5 && typeId < 3.5 ? (0.24 + hotEmber * 1.45) : (typeId > 3.5 ? 0.55 : 0.16);
    fragColor = vec4(vec3(th), alpha);
    return;
  }

  float sunLit = max(dot(normalize(vNormal), uSunDir), 0.0);
  vec3 lit = col * (uSkyTop * 0.78 + uSunColor * (1.20 * sunLit) + 0.22) + vec3(1.6, 0.42, 0.05) * hotEmber;
  float dist = length(vWorldPos - uCamPos);
  float fogAmt = clamp((1.0 - exp(-max(dist - 10.0, 0.0) * 0.0028)) * smoothstep(14.0, 32.0, dist), 0.0, 0.75);
  lit = mix(lit, vec3(0.14, 0.17, 0.22), fogAmt);
  fragColor = vec4(lit, alpha);
}`;

  // Upgrade C: Ambient-Only Bilateral SSAO (attenuated on sunlit surfaces, cool-blue crevice tint!)
  const SSAO_FS = `#version 300 es
precision highp float;
in vec2 vUv;

uniform sampler2D uDepthTex;
uniform sampler2D uShadowMap;
uniform mat4 uInvProj;
uniform mat4 uProj;
uniform mat4 uInvViewProj;
uniform mat4 uLightVP;
uniform mat4 uCamWorld;
uniform vec3 uSunDir;
uniform vec2 uTexelSize;
uniform int uSamples;

out vec4 fragColor;

vec3 reconstructViewPos(vec2 uv, float depth) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 vp = uInvProj * ndc;
  return vp.xyz / vp.w;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

const vec2 SPIRAL[12] = vec2[12](
  vec2(0.18, 0.06),  vec2(-0.14, 0.26), vec2(-0.34, -0.10), vec2(0.10, -0.42),
  vec2(0.48, 0.18),  vec2(-0.22, 0.54), vec2(-0.62, -0.22), vec2(0.28, -0.66),
  vec2(0.74, 0.28),  vec2(-0.42, 0.78), vec2(-0.88, -0.34), vec2(0.45, -0.90)
);

void main() {
  float d0 = texture(uDepthTex, vUv).r;
  if (d0 >= 0.9997) {
    fragColor = vec4(1.0);
    return;
  }

  vec3 pos = reconstructViewPos(vUv, d0);
  float dist = -pos.z;
  if (dist > 85.0) {
    fragColor = vec4(1.0);
    return;
  }

  float dR = texture(uDepthTex, vUv + vec2(uTexelSize.x, 0.0)).r;
  float dL = texture(uDepthTex, vUv - vec2(uTexelSize.x, 0.0)).r;
  float dU = texture(uDepthTex, vUv + vec2(0.0, uTexelSize.y)).r;
  float dD = texture(uDepthTex, vUv - vec2(0.0, uTexelSize.y)).r;

  vec3 pX = (abs(dR - d0) < abs(dL - d0))
    ? (reconstructViewPos(vUv + vec2(uTexelSize.x, 0.0), dR) - pos)
    : (pos - reconstructViewPos(vUv - vec2(uTexelSize.x, 0.0), dL));
  vec3 pY = (abs(dU - d0) < abs(dD - d0))
    ? (reconstructViewPos(vUv + vec2(0.0, uTexelSize.y), dU) - pos)
    : (pos - reconstructViewPos(vUv - vec2(0.0, uTexelSize.y), dD));

  vec3 rawN = cross(pX, pY);
  float nLen = length(rawN);
  if (nLen < 1e-6) {
    fragColor = vec4(1.0);
    return;
  }
  vec3 N = rawN / nLen;

  // Ambient-only attenuation: check direct sun illumination so sunlit walls stay clean & crisp!
  vec3 worldN = normalize(mat3(uCamWorld) * N);
  vec4 wp4 = uInvViewProj * vec4(vUv * 2.0 - 1.0, d0 * 2.0 - 1.0, 1.0);
  vec3 worldPos = wp4.xyz / wp4.w;
  vec4 sp = uLightVP * vec4(worldPos, 1.0);
  vec3 spProj = (sp.xyz / sp.w) * 0.5 + 0.5;
  float sunVis = 1.0;
  if (spProj.x > 0.0 && spProj.x < 1.0 && spProj.y > 0.0 && spProj.y < 1.0 && spProj.z < 1.0) {
    sunVis = step(spProj.z - 0.0025, texture(uShadowMap, spProj.xy).r);
  }
  float lit = clamp(dot(worldN, uSunDir), 0.0, 1.0) * sunVis;
  float aoMask = 1.0 - 0.80 * lit;

  float radius = 0.72;
  vec2 screenRad = (radius / max(dist, 0.5)) * vec2(uProj[0][0], uProj[1][1]) * 0.45;
  screenRad = clamp(screenRad, uTexelSize * 2.0, vec2(0.055));

  float angle = hash12(gl_FragCoord.xy) * 6.2831853;
  float ca = cos(angle), sa = sin(angle);
  mat2 rot = mat2(ca, -sa, sa, ca);

  float occ = 0.0;
  int count = uSamples;
  for (int i = 0; i < 12; i++) {
    if (i >= count) break;
    vec2 sUv = vUv + (rot * SPIRAL[i]) * screenRad;
    if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) continue;
    float sd = texture(uDepthTex, sUv).r;
    if (sd >= 0.9997) continue;
    vec3 sPos = reconstructViewPos(sUv, sd);
    vec3 diff = sPos - pos;
    float dLen = length(diff);
    if (dLen < 0.001 || dLen > radius * 1.55) continue;
    float nd = dot(N, diff / dLen);
    float rangeFade = 1.0 - smoothstep(radius * 0.42, radius * 1.55, dLen);
    occ += max(0.0, nd - 0.16) * rangeFade;
  }

  float ao = 1.0 - clamp((occ / float(max(count, 1))) * 1.75 * aoMask, 0.0, 0.52);
  ao = mix(ao, 1.0, smoothstep(55.0, 85.0, dist));
  // Subtle cool-blue shadow crevice tint (exact 1.0 on open/unoccluded pixels!)
  vec3 tintedAO = vec3(
    ao * mix(0.92, 1.0, ao),
    ao * mix(0.97, 1.0, ao),
    min(1.0, ao * mix(1.07, 1.0, ao))
  );
  fragColor = vec4(tintedAO, 1.0);
}`;

  // RGB Depth-Bilateral Blur (shared by Ambient-Only SSAO AND 3D Volumetric Sun Shafts!)
  const BILATERAL_BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uDepthTex;
uniform vec2 uDir;
uniform float uSkipSky;
out vec4 fragColor;

void main() {
  float cDepth = texture(uDepthTex, vUv).r;
  if (uSkipSky > 0.5 && cDepth >= 0.9997) {
    fragColor = vec4(1.0);
    return;
  }
  vec3 sum = texture(uTex, vUv).rgb * 0.28;
  float wSum = 0.28;
  const float W[3] = float[3](0.20, 0.11, 0.05);
  for (int i = 1; i <= 3; i++) {
    vec2 ofs = uDir * float(i);
    float dP = texture(uDepthTex, vUv + ofs).r;
    float wP = W[i - 1] * exp(-abs(dP - cDepth) * 420.0);
    sum += texture(uTex, vUv + ofs).rgb * wP;
    wSum += wP;

    float dN = texture(uDepthTex, vUv - ofs).r;
    float wN = W[i - 1] * exp(-abs(dN - cDepth) * 420.0);
    sum += texture(uTex, vUv - ofs).rgb * wN;
    wSum += wN;
  }
  fragColor = vec4(sum / max(wSum, 0.001), 1.0);
}`;

  const COPY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 fragColor;
void main() {
  fragColor = texture(uTex, vUv);
}`;

  // Upgrade C: True 3D Shadow-Marched Volumetric Sun Shafts (two-lobe Henyey-Greenstein + IGN jitter!)
  const VOL_FOG_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;

uniform sampler2D uDepthTex;
uniform sampler2D uShadowMap;
uniform mat4 uInvViewProj;
uniform mat4 uLightVP;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform int uSteps;

out vec4 fragColor;

const float PI = 3.14159265359;

float ign(vec2 p) {
  vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
  return fract(magic.z * fract(dot(p, magic.xy)));
}

float hgPhase(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 0.001), 1.5));
}

void main() {
  float depth = texture(uDepthTex, vUv).r;
  vec4 clipEnd = uInvViewProj * vec4(vUv * 2.0 - 1.0, min(depth, 0.9999) * 2.0 - 1.0, 1.0);
  vec3 worldEnd = clipEnd.xyz / clipEnd.w;
  vec3 toEnd = worldEnd - uCamPos;
  float totalDist = length(toEnd);
  if (totalDist < 0.25) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 rayDir = toEnd / totalDist;
  float maxDist = min(totalDist, 92.0);
  float startDist = 0.8;
  float marchLen = max(maxDist - startDist, 0.0);
  if (marchLen <= 0.05) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float mu = dot(rayDir, uSunDir);
  // Two-lobe Henyey-Greenstein: localized golden forward beams + restrained urban canyon shafts!
  float phase = hgPhase(mu, 0.80) * 0.62 + hgPhase(mu, 0.22) * 0.38;

  int steps = max(uSteps, 1);
  float dt = marchLen / float(steps);
  float jitter = ign(gl_FragCoord.xy);
  float accum = 0.0;

  for (int i = 0; i < 16; i++) {
    if (i >= steps) break;
    float t = startDist + (float(i) + jitter) * dt;
    vec3 p = uCamPos + rayDir * t;

    vec4 lp = uLightVP * vec4(p, 1.0);
    vec3 proj = (lp.xyz / lp.w) * 0.5 + 0.5;
    float vis = 0.0;
    if (proj.x > 0.01 && proj.x < 0.99 && proj.y > 0.01 && proj.y < 0.99 && proj.z > 0.0 && proj.z < 1.0) {
      float sd = texture(uShadowMap, proj.xy).r;
      vis = step(proj.z - 0.0022, sd);
    }
    // Low battle-dust & moisture density near street canyon
    float hDens = exp(-max(p.y, 0.0) * 0.085) * 0.85 + 0.15;
    float distFade = 1.0 - smoothstep(65.0, 92.0, t);
    accum += vis * hDens * distFade * dt;
  }

  vec3 scatter = uSunColor * (accum * phase * 0.036);
  // Keep dramatic shafts crisp WITHOUT washing out West-facing shadows or skyline contrast!
  scatter = min(scatter, vec3(0.24));
  fragColor = vec4(scatter, 1.0);
}`;

  const BLOOM_BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSceneTex;
uniform float uThreshold;
out vec4 fragColor;

void main() {
  vec3 c = texture(uSceneTex, vUv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float knee = 0.45;
  float soft = clamp(lum - uThreshold + knee, 0.0, 2.0 * knee);
  soft = (soft * soft) / (4.0 * knee + 0.0001);
  float contrib = max(lum - uThreshold, soft) / max(lum, 0.0001);
  fragColor = vec4(min(c * contrib, vec3(10.0)), 1.0);
}`;

  const BLUR_9_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 fragColor;

void main() {
  vec3 c = texture(uTex, vUv).rgb * 0.227027;
  c += (texture(uTex, vUv + uDir * 1.384615).rgb + texture(uTex, vUv - uDir * 1.384615).rgb) * 0.316216;
  c += (texture(uTex, vUv + uDir * 3.230769).rgb + texture(uTex, vUv - uDir * 3.230769).rgb) * 0.070270;
  fragColor = vec4(c, 1.0);
}`;

  // Upgrade E Pass 1: ACES + AgX Filmic Blend + Display Split-Tone + Occlusion-Tested Sun Flare + FLIR/NVG
  const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;

uniform sampler2D uSceneTex;
uniform sampler2D uBloomTex;
uniform sampler2D uVolTex;
uniform sampler2D uDepthTex;

uniform float uBloomStrength;
uniform float uVolStrength;
uniform float uSuppression;
uniform float uDamageFlash;
uniform float uConcussion;
uniform float uVignette;
uniform float uChromatic;
uniform float uMuzzleExposure;
uniform vec2 uSunUv;
uniform float uSunVis;
uniform int uVisionMode;
uniform float uTime;
uniform vec2 uResolution;

out vec4 fragColor;

vec3 acesFilm(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// Smooth AgX highlight roll-off (desaturates intense explosions/fire cores cleanly toward white!)
vec3 agxFilm(vec3 x) {
  mat3 agxMat = mat3(
    0.84247906, 0.04232824, 0.04237565,
    0.07843360, 0.87846864, 0.07843360,
    0.07922375, 0.07916613, 0.87914297
  );
  mat3 agxInv = mat3(
     1.19687900, -0.05289685, -0.05297163,
    -0.09802088,  1.15190313, -0.09804345,
    -0.09902975, -0.09896118,  1.15107368
  );
  vec3 v = max(agxMat * max(x, vec3(0.0)), vec3(1e-6));
  v = clamp((log2(v) + 12.47393) / 16.5, 0.0, 1.0);
  vec3 v2 = v * v;
  vec3 v4 = v2 * v2;
  vec3 y = 15.5 * v4 * v2 - 40.14 * v4 * v + 31.96 * v4 - 6.868 * v2 * v + 0.4298 * v2 + 0.1191 * v - 0.00232;
  return clamp(agxInv * y, 0.0, 1.0);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 centered = vUv - 0.5;
  float r2 = dot(centered, centered);
  float r = sqrt(r2);

  // Strictly radial, subtle optical lens CA (zero 25px rainbow stripes; center & gun stay razor-clean!)
  float caBase = min(uChromatic, 0.0012) + uSuppression * 0.0012 + uConcussion * 0.0020 + uDamageFlash * 0.0014;
  float caAmt = min(caBase * (r2 * 1.45), 0.0026);
  vec2 caDir = centered * caAmt;

  vec3 hdr;
  if (uConcussion > 0.02) {
    vec3 acc = vec3(0.0);
    float blurStr = uConcussion * 0.024;
    for (int i = 0; i < 6; i++) {
      float f = (float(i) / 5.0 - 0.5) * blurStr;
      vec2 suv = vUv + centered * f;
      acc += vec3(
        texture(uSceneTex, suv + caDir).r,
        texture(uSceneTex, suv).g,
        texture(uSceneTex, suv - caDir).b
      );
    }
    hdr = acc / 6.0;
  } else if (caAmt > 0.0002) {
    hdr = vec3(
      texture(uSceneTex, vUv + caDir).r,
      texture(uSceneTex, vUv).g,
      texture(uSceneTex, vUv - caDir).b
    );
  } else {
    hdr = texture(uSceneTex, vUv).rgb;
  }

  // Add bloom + 3D shadow-marched volumetric sun shafts
  if (uBloomStrength > 0.001) {
    vec3 bCol = texture(uBloomTex, vUv).rgb;
    hdr += bCol * uBloomStrength;
  }
  if (uVolStrength > 0.001 && uVisionMode != 1 && uVisionMode != 2) {
    hdr += texture(uVolTex, vUv).rgb * uVolStrength;
  }

  // Occlusion-tested subtle optical anamorphic sun streak & lens ghost (zero bleed behind buildings!)
  if (uSunVis > 0.01 && uVisionMode == 0) {
    float occ = 0.0;
    vec2 px = 2.5 / max(uResolution, vec2(1.0));
    occ += step(0.9994, texture(uDepthTex, clamp(uSunUv, 0.005, 0.995)).r);
    occ += step(0.9994, texture(uDepthTex, clamp(uSunUv + vec2(px.x, 0.0), 0.005, 0.995)).r);
    occ += step(0.9994, texture(uDepthTex, clamp(uSunUv - vec2(px.x, 0.0), 0.005, 0.995)).r);
    occ += step(0.9994, texture(uDepthTex, clamp(uSunUv + vec2(0.0, px.y), 0.005, 0.995)).r);
    occ *= 0.25 * uSunVis;
    if (occ > 0.01) {
      float aspect = uResolution.x / max(uResolution.y, 1.0);
      vec2 ds = (vUv - uSunUv) * vec2(aspect, 1.0);
      float streak = exp(-abs(ds.y) * 32.0) * exp(-abs(ds.x) * 2.2) * 0.24;
      vec2 ghostPos = vec2(1.0) - uSunUv;
      vec2 dg = (vUv - mix(uSunUv, ghostPos, 0.65)) * vec2(aspect, 1.0);
      float ghost = exp(-dot(dg, dg) * 65.0) * 0.14;
      hdr += vec3(1.0, 0.72, 0.40) * (streak + ghost) * occ;
    }
  }

  // FLIR Thermal Vision Modes ('thermal_white' / 'thermal_green')
  if (uVisionMode == 1 || uVisionMode == 2) {
    float heat = clamp(hdr.r, 0.0, 2.5);
    float mapped = 1.0 - exp(-heat * 1.45);
    mapped = smoothstep(0.03, 0.94, mapped);
    float scan = 0.965 + 0.035 * sin(gl_FragCoord.y * 3.14159);
    float flirNoise = (hash(vUv * uResolution + fract(uTime * 17.3)) - 0.5) * 0.045;
    float v = clamp(mapped * scan + flirNoise, 0.0, 1.0);
    vec3 flirCol = (uVisionMode == 1)
      ? mix(vec3(0.03, 0.05, 0.07), vec3(0.96, 0.99, 1.0), v)
      : mix(vec3(0.01, 0.05, 0.02), vec3(0.74, 1.0, 0.78), v);
    flirCol *= (1.0 - smoothstep(0.32, 0.76, r) * 0.42);
    fragColor = vec4(flirCol, 1.0);
    return;
  }

  // Exposure + ACES/AgX Filmic Blend (punchy fire oranges + rich shadow contrast, zero washout!)
  float exposure = 0.98 + uMuzzleExposure * 0.24;
  vec3 expHdr = hdr * exposure;
  vec3 col = mix(acesFilm(expHdr), agxFilm(expHdr), 0.28);

  // Display-linear Battlefield split-tone grade: cool teal-slate shadows vs warm amber highlights
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 sh = vec3(0.86, 1.00, 1.11);
  vec3 hi = vec3(1.07, 1.00, 0.90);
  col = clamp(col * mix(sh, hi, smoothstep(0.10, 0.80, lum)), 0.0, 1.0);

  if (uVisionMode == 3) {
    col = mix(vec3(lum), col, 1.12) * vec3(0.94, 1.01, 0.98);
    col *= (1.0 - smoothstep(0.38, 0.72, r) * 0.32);
  } else if (uVisionMode == 4) {
    float nvgLum = clamp(lum * 2.1 + 0.06, 0.0, 1.0);
    float nvgNoise = (hash(vUv * uResolution + fract(uTime * 23.1)) - 0.5) * 0.09;
    col = vec3(0.12, 0.96, 0.28) * clamp(nvgLum + nvgNoise, 0.0, 1.0);
    col *= (1.0 - smoothstep(0.34, 0.68, r) * 0.68);
  }

  if (uSuppression > 0.01) {
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(l), uSuppression * 0.45 * smoothstep(0.18, 0.65, r));
  }
  float vigStr = clamp(uVignette + uSuppression * 0.55 + uConcussion * 0.25, 0.0, 0.92);
  col *= (1.0 - smoothstep(0.28, 0.78, r) * vigStr);

  if (uDamageFlash > 0.005) {
    float dmgEdge = smoothstep(0.18, 0.72, r);
    col = mix(col, vec3(0.72, 0.04, 0.03), clamp(uDamageFlash * (0.22 + 0.68 * dmgEdge), 0.0, 0.78));
  }

  // Gamma encode to sRGB + store luma in alpha channel for fast FXAA!
  col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  fragColor = vec4(col, luma);
}`;

  // Upgrade E Pass 2: FXAA Anti-Aliasing + Edge-Masked Unsharp Sharpening + Anti-Banding Sky Dither
  const FINAL_AA_FS = `#version 300 es
precision highp float;
in vec2 vUv;

uniform sampler2D uLdrTex;
uniform vec2 uInvRes;
uniform float uFxaaEnabled;
uniform float uSharpen;
uniform float uTime;

out vec4 fragColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec4 cM = texture(uLdrTex, vUv);
  vec3 col = cM.rgb;
  float edgeAmt = 0.0;

  if (uFxaaEnabled > 0.5) {
    vec4 cNW = texture(uLdrTex, vUv + vec2(-uInvRes.x,  uInvRes.y));
    vec4 cNE = texture(uLdrTex, vUv + vec2( uInvRes.x,  uInvRes.y));
    vec4 cSW = texture(uLdrTex, vUv + vec2(-uInvRes.x, -uInvRes.y));
    vec4 cSE = texture(uLdrTex, vUv + vec2( uInvRes.x, -uInvRes.y));

    float lM = cM.a;
    float lNW = cNW.a, lNE = cNE.a, lSW = cSW.a, lSE = cSE.a;
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    float lRange = lMax - lMin;
    edgeAmt = smoothstep(0.04, 0.18, lRange);

    if (lRange > max(0.0312, lMax * 0.125)) {
      vec2 dir;
      dir.x = -((lNW + lNE) - (lSW + lSE));
      dir.y =  ((lNW + lSW) - (lNE + lSE));
      float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
      float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
      dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * uInvRes;

      vec3 rgbA = 0.5 * (
        texture(uLdrTex, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
        texture(uLdrTex, vUv + dir * (2.0 / 3.0 - 0.5)).rgb
      );
      vec3 rgbB = rgbA * 0.5 + 0.25 * (
        texture(uLdrTex, vUv + dir * -0.5).rgb +
        texture(uLdrTex, vUv + dir *  0.5).rgb
      );
      float lB = dot(rgbB, vec3(0.299, 0.587, 0.114));
      col = (lB < lMin || lB > lMax) ? rgbA : rgbB;
    }
  }

  // Edge-backed-off Unsharp Mask (0.30): sharpens PBR textures while preserving silky FXAA silhouettes!
  if (uSharpen > 0.01) {
    vec3 cN = texture(uLdrTex, vUv + vec2(0.0, uInvRes.y)).rgb;
    vec3 cS = texture(uLdrTex, vUv - vec2(0.0, uInvRes.y)).rgb;
    vec3 cE = texture(uLdrTex, vUv + vec2(uInvRes.x, 0.0)).rgb;
    vec3 cW = texture(uLdrTex, vUv - vec2(uInvRes.x, 0.0)).rgb;
    vec3 blur = (cN + cS + cE + cW) * 0.25;
    float backOff = 1.0 - edgeAmt * 0.72;
    vec3 detail = clamp(col - blur, vec3(-0.14), vec3(0.14));
    col = clamp(col + detail * (uSharpen * 1.45 * backOff), 0.0, 1.0);
  }

  // Triangular PDF anti-banding dither (eliminates 8-bit sky gradient banding cleanly)
  float d1 = hash12(gl_FragCoord.xy + fract(uTime * 11.3));
  float d2 = hash12(gl_FragCoord.xy + vec2(17.1, 31.7) + fract(uTime * 19.7));
  float triDither = (d1 + d2 - 1.0) * (0.9 / 255.0);
  fragColor = vec4(clamp(col + triDither, 0.0, 1.0), 1.0);
}`;

  // ---------------------------------------------------------------------------
  // WebGL2 Helpers
  // ---------------------------------------------------------------------------
  function compileShader(gl, type, src, label) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error(`[DF.Renderer] Shader compile error (${label}):`, gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function createProgram(gl, vsSrc, fsSrc, label) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, label + ':VS');
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, label + ':FS');
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error(`[DF.Renderer] Program link error (${label}):`, gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return null;
    }
    const u = Object.create(null);
    const num = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < num; i++) {
      const info = gl.getActiveUniform(prog, i);
      if (!info) continue;
      const name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(prog, info.name);
    }
    return { prog, u };
  }

  function createColorTex(gl, w, h, internalFormat, format, type, linear = true) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  function createDepthTex(gl, w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  function createFBO(gl, w, h, opts) {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    let colorTex = null, depthTex = null;
    if (opts.color) {
      colorTex = createColorTex(gl, w, h, opts.internalFormat, opts.format, opts.type, opts.linear !== false);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    } else {
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
    }
    if (opts.depth) {
      depthTex = createDepthTex(gl, w, h);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { fbo, colorTex, depthTex, w, h, ok: status === gl.FRAMEBUFFER_COMPLETE };
  }

  function deleteFBO(gl, obj) {
    if (!obj) return;
    if (obj.colorTex) gl.deleteTexture(obj.colorTex);
    if (obj.depthTex) gl.deleteTexture(obj.depthTex);
    if (obj.fbo) gl.deleteFramebuffer(obj.fbo);
  }

  // ---------------------------------------------------------------------------
  // Renderer Internal State
  // ---------------------------------------------------------------------------
  let _gl = null;
  let _canvas = null;
  let _quality = QUALITY_PRESETS.ultra;
  let _hdrSupported = false;
  let _width = 1;
  let _height = 1;

  // Programs
  let _progShadow = null;
  let _progPBR = null;
  let _progSky = null;
  let _progWire = null;
  let _progParticle = null;
  let _progMote = null;
  let _progTracer = null;
  let _progDecal = null;
  let _progSSAO = null;
  let _progBilateral = null;
  let _progCopy = null;
  let _progVolFog = null;
  let _progBloomBright = null;
  let _progBlur9 = null;
  let _progComposite = null;
  let _progFinalAA = null;
  let _emptyVao = null;

  // Framebuffers
  let _shadowFBO = null;
  let _planarReflFBO = null;
  let _sceneFBO = null;
  let _depthCopyFBO = null;
  let _ssaoFBO = null;
  let _ssaoBlurTmp = null;
  let _ssaoBlurOut = null;
  let _volRawFBO = null;
  let _volTmpFBO = null;
  let _volOutFBO = null;
  let _bloomHalfA = null;
  let _bloomQuarterA = null;
  let _bloomQuarterB = null;
  let _ldrFBO = null;

  // Camera & Shadow Matrices
  const _camPos = Vec3.create(-55, 2.2, 0);
  const _reflCamPos = Vec3.create(-55, -2.2, 0);
  const _camForward = Vec3.create(1, 0, 0);
  const _camRight = Vec3.create(0, 0, 1);
  const _camUp = Vec3.create(0, 1, 0);
  const _viewMat = Mat4.create();
  const _reflViewMat = Mat4.create();
  const _projMat = Mat4.create();
  const _vmProjMat = Mat4.create();
  const _camWorldMat = Mat4.create();
  const _viewProjMat = Mat4.create();
  const _invViewProjMat = Mat4.create();
  const _reflViewProjMat = Mat4.create();
  const _invReflViewProjMat = Mat4.create();
  const _invProjMat = Mat4.create();
  const _lightViewMat = Mat4.create();
  const _lightProjMat = Mat4.create();
  const _lightVPMat = Mat4.create();
  const _identityMat = Mat4.create();
  const _tmpMatA = Mat4.create();
  const _tmpVec = Vec3.create();

  let _camFov = 72 * DMath.DEG2RAD;
  let _camNear = 0.12;
  let _camFar = 450.0;
  let _shadowWorldSpan = 108.0;

  // Vision & PostFX
  let _visionMode = 'normal';
  let _visionModeId = 0;
  const _postFX = {
    suppression: 0, damageFlash: 0, concussion: 0,
    vignette: 0.24, chromatic: 0.0012, muzzleExposure: 0,
  };

  let _wireframe = false;
  let _diagCam = null;

  let _time = 0;
  let _dt = 0.016;
  let _fpsSmooth = 60;
  let _particlesUpdatedThisFrame = false;
  const _stats = {
    fps: 60, drawCalls: 0, triangles: 0, particles: 0, activeLights: 0, quality: 'ultra',
  };

  // Preallocated Draw Item Pool
  const _itemPool = new Array(MAX_POOL_ITEMS);
  for (let i = 0; i < MAX_POOL_ITEMS; i++) {
    _itemPool[i] = {
      mesh: null, modelMat: new Float32Array(16), texKey: 'concrete',
      color: [1, 1, 1], hasRough: 0, rough: 0.7, hasMetal: 0, metal: 0.0,
      emissive: [0, 0, 0], uvScale: [1, 1], alpha: 1.0, thermalHeat: 0.12,
      doubleSided: false, castShadow: true, receiveShadow: true,
      viewmodel: false, cameraSpace: false, worldSpace: false, unlit: false, distSq: 0,
    };
  }
  let _poolUsed = 0;
  const _opaqueQueue = [];
  const _transparentQueue = [];
  const _viewmodelQueue = [];

  // Dynamic Light Pool
  const _lights = [];
  const _lightPosRadBuf = new Float32Array(MAX_DYNAMIC_LIGHTS * 4);
  const _lightColIntBuf = new Float32Array(MAX_DYNAMIC_LIGHTS * 4);

  // Instanced Soft-Particles + 256x256 Worley/FBM Smoke Atlas
  let _particles = [];
  let _particleVao = null;
  let _particleInstVbo = null;
  let _smokeAtlasTex = null;
  let _particleInstData = new Float32Array(2000 * PARTICLE_FLOATS);
  let _particleSortBuf = [];

  // Instanced 3-Layer Tracers
  const _tracers = [];
  let _tracerVao = null;
  let _tracerInstVbo = null;
  const _tracerInstData = new Float32Array(MAX_TRACERS * TRACER_FLOATS);

  // Instanced Impact Decals + 256x256 Multi-Material Bullet-Hole Atlas
  const _decals = [];
  let _decalWriteIdx = 0;
  let _decalVao = null;
  let _decalInstVbo = null;
  let _decalAtlasTex = null;
  let _dummyBlackTex = null;
  const _decalInstData = new Float32Array(MAX_DECALS * DECAL_FLOATS);

  // ---------------------------------------------------------------------------
  // Procedural Atlases (256x256 Smoke Atlas + 256x256 Multi-Material Decal Atlas)
  // ---------------------------------------------------------------------------
  function createSmokeAtlasTexture(gl) {
    const S = 256, HALF = 128;
    const rgba = new Uint8Array(S * S * 4);
    const dens = new Float32Array(HALF * HALF);

    const hash2 = (ix, iy, seed) => {
      let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const worley = (u, v, cells, seed) => {
      const gx = u * cells, gy = v * cells, ix = Math.floor(gx), iy = Math.floor(gy);
      let minD2 = 9.0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ix + dx, cy = iy + dy;
          const ddx = gx - (cx + hash2(cx, cy, seed));
          const ddy = gy - (cy + hash2(cx, cy, seed + 97));
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 < minD2) minD2 = d2;
        }
      }
      return Math.max(0, 1.0 - Math.sqrt(minD2));
    };
    const vnoise = (u, v, freq, seed) => {
      const gx = u * freq, gy = v * freq, ix = Math.floor(gx), iy = Math.floor(gy);
      const fx = gx - ix, fy = gy - iy;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
      const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
      return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
    };

    for (let variant = 0; variant < 4; variant++) {
      const ox = (variant & 1) * HALF, oy = (variant >> 1) * HALF;
      const seed = 3100 + variant * 733;
      const tilt = variant * 0.78 + 0.35, ct = Math.cos(tilt), st = Math.sin(tilt);
      const sx = 0.86 + (variant & 1) * 0.24, sy = 1.18 - (variant >> 1) * 0.22;

      for (let y = 0; y < HALF; y++) {
        const v = (y + 0.5) / HALF, py = v * 2.0 - 1.0;
        for (let x = 0; x < HALF; x++) {
          const u = (x + 0.5) / HALF, px = u * 2.0 - 1.0;
          const ax = (px * ct - py * st) * sx, ay = (px * st + py * ct) * sy;
          const w1x = (vnoise(u, v, 3, seed + 17) * 0.62 + vnoise(u, v, 6, seed + 53) * 0.38 - 0.5) * 0.82;
          const w1y = (vnoise(u, v, 3, seed + 109) * 0.62 + vnoise(u, v, 6, seed + 193) * 0.38 - 0.5) * 0.82;
          const u2 = u + w1x * 0.22, v2 = v + w1y * 0.22;
          const w2x = (vnoise(u2, v2, 8, seed + 271) - 0.5) * 0.42;
          const w2y = (vnoise(u2, v2, 8, seed + 347) - 0.5) * 0.42;
          const wx = ax + w1x + w2x, wy = ay + w1y + w2y;

          const rRaw = Math.hypot(px, py);
          const borderFade = DMath.smoothstep(0.86, 0.22, rRaw);
          const gaussEnv = Math.exp(-(wx * wx + wy * wy) * 2.4) * borderFade;

          const c1 = worley(u2, v2, 4, seed);
          const c2 = worley(u2 + 0.17, v2 - 0.13, 8, seed + 211);
          const nFine = vnoise(u2, v2, 6, seed + 409) * 0.45 + vnoise(u2, v2, 13, seed + 613) * 0.35 + vnoise(u2, v2, 24, seed + 881) * 0.20;
          const ridged = 1.0 - Math.abs(nFine * 2.0 - 1.0);
          const billow = c1 * 0.34 + c2 * 0.22 + nFine * 0.26 + ridged * 0.18;

          const skirtCut = (1.0 - borderFade) * 0.38;
          dens[y * HALF + x] = DMath.clamp(gaussEnv * (0.36 + billow * 1.08) - skirtCut * (1.0 - nFine), 0, 1);
        }
      }

      for (let y = 0; y < HALF; y++) {
        const ym = Math.max(0, y - 1), yp = Math.min(HALF - 1, y + 1);
        const py = ((y + 0.5) / HALF) * 2.0 - 1.0;
        for (let x = 0; x < HALF; x++) {
          const xm = Math.max(0, x - 1), xp = Math.min(HALF - 1, x + 1);
          const px = ((x + 0.5) / HALF) * 2.0 - 1.0;
          const d = dens[y * HALF + x];
          const dX = (dens[y * HALF + xp] - dens[y * HALF + xm]) * 3.8;
          const dY = (dens[yp * HALF + x] - dens[ym * HALF + x]) * 3.8;
          let nx = px * 0.52 - dX, ny = py * 0.52 - dY;
          let nz = Math.sqrt(Math.max(0.18, 1.0 - Math.min(0.82, px * px * 0.45 + py * py * 0.45))) * 0.85 + 0.25;
          const inv = 1.0 / Math.hypot(nx, ny, nz);
          const outIdx = ((oy + y) * S + (ox + x)) * 4;
          rgba[outIdx] = Math.max(0, Math.min(255, ((nx * inv * 0.5 + 0.5) * 255) | 0));
          rgba[outIdx + 1] = Math.max(0, Math.min(255, ((ny * inv * 0.5 + 0.5) * 255) | 0));
          rgba[outIdx + 2] = Math.max(0, Math.min(255, ((nz * inv * 0.5 + 0.5) * 255) | 0));
          rgba[outIdx + 3] = Math.max(0, Math.min(255, (d * 255) | 0));
        }
      }
    }

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  // Upgrade F: 256x256 Procedural 4-Cell Multi-Material Bullet-Hole & Blast Scorch Atlas
  function createDecalAtlasTexture(gl) {
    const S = 256, HALF = 128;
    const rgba = new Uint8Array(S * S * 4);
    const hash2 = (ix, iy, seed) => {
      let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const n2 = (u, v, freq, seed) => {
      const gx = u * freq, gy = v * freq, ix = Math.floor(gx), iy = Math.floor(gy);
      const fx = gx - ix, fy = gy - iy;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
      const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
      return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
    };

    for (let cell = 0; cell < 4; cell++) {
      const ox = (cell & 1) * HALF, oy = (cell >> 1) * HALF;
      for (let y = 0; y < HALF; y++) {
        const v = (y + 0.5) / HALF, py = v * 2.0 - 1.0;
        for (let x = 0; x < HALF; x++) {
          const u = (x + 0.5) / HALF, px = u * 2.0 - 1.0;
          const r = Math.hypot(px, py);
          const ang = Math.atan2(py, px);
          const f1 = n2(u, v, 7, 400 + cell * 71);
          const f2 = n2(u, v, 18, 900 + cell * 71);
          const jag = r + (f1 - 0.5) * 0.22 + (f2 - 0.5) * 0.12;
          const border = DMath.smoothstep(0.95, 0.72, r);

          let cr = 20, cg = 20, cb = 20, a = 0;
          if (cell === 0) {
            // 0: Concrete / Brick spalled crater + pale dust halo + 7 jagged radial cracks
            const hole = DMath.smoothstep(0.36, 0.16, jag);
            const spall = DMath.smoothstep(0.76, 0.28, jag) * (1.0 - hole * 0.75);
            const rays = Math.pow(Math.abs(Math.sin(ang * 3.5 + f1 * 2.2)), 14.0) * DMath.smoothstep(0.92, 0.24, r);
            const dark = Math.min(1, hole + rays * 0.75);
            cr = 132 * (1 - dark) + 18 * dark;
            cg = 126 * (1 - dark) + 17 * dark;
            cb = 118 * (1 - dark) + 17 * dark;
            a = Math.min(1, hole * 0.96 + spall * 0.45 + rays * 0.65) * border;
          } else if (cell === 1) {
            // 1: Metal / Armor peeled steel bullet gouge + bright metallic scraped rim + soot streaks
            const pit = DMath.smoothstep(0.34, 0.14, jag);
            const lip = DMath.smoothstep(0.22, 0.36, jag) * DMath.smoothstep(0.60, 0.38, jag);
            const soot = DMath.smoothstep(0.84, 0.25, jag) * (0.4 + 0.6 * f2);
            cr = 18 * pit + 195 * lip + 28 * soot * (1 - lip);
            cg = 19 * pit + 202 * lip + 28 * soot * (1 - lip);
            cb = 22 * pit + 212 * lip + 30 * soot * (1 - lip);
            a = Math.min(1, pit * 0.95 + lip * 0.85 + soot * 0.40) * border;
          } else if (cell === 2) {
            // 2: Wood splinters / Cracked glass impact star
            const hole = DMath.smoothstep(0.38, 0.16, jag);
            const splinters = Math.pow(Math.abs(Math.cos(ang * 5.0 + f1 * 1.4)), 10.0) * DMath.smoothstep(0.88, 0.20, r);
            cr = 48 * (1 - hole) + 16 * hole;
            cg = 36 * (1 - hole) + 14 * hole;
            cb = 26 * (1 - hole) + 12 * hole;
            a = Math.min(1, hole * 0.90 + splinters * 0.58) * border;
          } else {
            // 3: Heavy Explosion / RPG Blast Scorch Mark (tattered soot star + ash ring)
            const rays = 0.72 + 0.28 * Math.sin(ang * 6.0 + f1 * 4.0) * Math.cos(ang * 3.0 - f2 * 3.0);
            const blast = DMath.smoothstep(0.92 * rays, 0.14, jag) * (0.62 + 0.38 * f2);
            const ash = DMath.smoothstep(0.26, 0.55, jag) * DMath.smoothstep(0.85, 0.55, jag) * 0.35;
            cr = 22 + ash * 95;
            cg = 21 + ash * 90;
            cb = 20 + ash * 84;
            a = Math.min(0.92, blast * 0.94) * border;
          }

          const o = ((oy + y) * S + (ox + x)) * 4;
          rgba[o] = Math.max(0, Math.min(255, cr | 0));
          rgba[o + 1] = Math.max(0, Math.min(255, cg | 0));
          rgba[o + 2] = Math.max(0, Math.min(255, cb | 0));
          rgba[o + 3] = Math.max(0, Math.min(255, (a * 255) | 0));
        }
      }
    }

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  // ---------------------------------------------------------------------------
  // FBO & Buffer Allocation
  // ---------------------------------------------------------------------------
  function detectHDR(gl) {
    const extF = gl.getExtension('EXT_color_buffer_float');
    const extHF = gl.getExtension('EXT_color_buffer_half_float');
    if (!extF && !extHF) return false;
    const test = createFBO(gl, 8, 8, {
      color: true, depth: false, internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
    });
    const ok = test.ok;
    deleteFBO(gl, test);
    return ok;
  }

  function rebuildShadowFBO() {
    if (!_gl) return;
    deleteFBO(_gl, _shadowFBO);
    const sz = _quality.shadowSize;
    _shadowFBO = createFBO(_gl, sz, sz, { color: false, depth: true });
  }

  function rebuildScreenFBOs(w, h) {
    if (!_gl) return;
    const gl = _gl;
    _width = Math.max(1, w | 0);
    _height = Math.max(1, h | 0);
    const hw = Math.max(1, _width >> 1);
    const hh = Math.max(1, _height >> 1);
    const qw = Math.max(1, _width >> 2);
    const qh = Math.max(1, _height >> 2);

    deleteFBO(gl, _planarReflFBO);
    deleteFBO(gl, _sceneFBO);
    deleteFBO(gl, _depthCopyFBO);
    deleteFBO(gl, _ssaoFBO);
    deleteFBO(gl, _ssaoBlurTmp);
    deleteFBO(gl, _ssaoBlurOut);
    deleteFBO(gl, _volRawFBO);
    deleteFBO(gl, _volTmpFBO);
    deleteFBO(gl, _volOutFBO);
    deleteFBO(gl, _bloomHalfA);
    deleteFBO(gl, _bloomQuarterA);
    deleteFBO(gl, _bloomQuarterB);
    deleteFBO(gl, _ldrFBO);

    const hdrOpts = _hdrSupported
      ? { color: true, internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }
      : { color: true, internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    const ldrOpts = { color: true, depth: false, internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };

    _sceneFBO = createFBO(gl, _width, _height, Object.assign({ depth: true }, hdrOpts));
    if (!_sceneFBO.ok && _hdrSupported) {
      _hdrSupported = false;
      deleteFBO(gl, _sceneFBO);
      _sceneFBO = createFBO(gl, _width, _height, {
        color: true, depth: true, internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE,
      });
    }
    _depthCopyFBO = createFBO(gl, _width, _height, { color: false, depth: true });

    const fxOpts = _hdrSupported
      ? { color: true, depth: false, internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }
      : ldrOpts;

    // Half-res Planar Reflection FBO (with depth buffer!)
    _planarReflFBO = createFBO(gl, hw, hh, Object.assign({ depth: true }, fxOpts));

    _ssaoFBO = createFBO(gl, hw, hh, ldrOpts);
    _ssaoBlurTmp = createFBO(gl, hw, hh, ldrOpts);
    _ssaoBlurOut = createFBO(gl, hw, hh, ldrOpts);

    _volRawFBO = createFBO(gl, hw, hh, fxOpts);
    _volTmpFBO = createFBO(gl, hw, hh, fxOpts);
    _volOutFBO = createFBO(gl, hw, hh, fxOpts);

    _bloomHalfA = createFBO(gl, hw, hh, fxOpts);
    _bloomQuarterA = createFBO(gl, qw, qh, fxOpts);
    _bloomQuarterB = createFBO(gl, qw, qh, fxOpts);

    // Full-res LDR intermediate FBO for FXAA + Edge-Masked Unsharp Mask
    _ldrFBO = createFBO(gl, _width, _height, ldrOpts);
  }

  function ensureCanvasSize() {
    if (!_canvas || !_gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, _quality.maxPixelRatio);
    const cw = Math.max(1, Math.round((_canvas.clientWidth || _canvas.width || window.innerWidth || 1280) * dpr));
    const ch = Math.max(1, Math.round((_canvas.clientHeight || _canvas.height || window.innerHeight || 720) * dpr));
    if (_canvas.width !== cw || _canvas.height !== ch || !_sceneFBO || _width !== cw || _height !== ch) {
      _canvas.width = cw;
      _canvas.height = ch;
      rebuildScreenFBOs(cw, ch);
    }
  }

  function initInstancedVAO(gl, floatCount, vec4Count, byteLen) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, byteLen, gl.DYNAMIC_DRAW);
    const stride = floatCount * 4;
    for (let loc = 0; loc < vec4Count; loc++) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, loc * 16);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return { vao, vbo };
  }

  // ---------------------------------------------------------------------------
  // Camera & Shadow Matrix Computation
  // ---------------------------------------------------------------------------
  function applyCameraParams(cfg) {
    if (!cfg) return;
    const aspect = _width / Math.max(_height, 1);
    const rawFov = cfg.fov !== undefined ? cfg.fov : _camFov;
    _camFov = rawFov > 3.2 ? rawFov * DMath.DEG2RAD : rawFov;
    _camNear = cfg.near !== undefined ? cfg.near : 0.12;
    _camFar = cfg.far !== undefined ? cfg.far : 450.0;

    if (cfg.viewMat) {
      Mat4.copy(_viewMat, cfg.viewMat);
      Mat4.invert(_camWorldMat, _viewMat);
      if (cfg.pos) Vec3.copy(_camPos, cfg.pos);
      else Mat4.getTranslation(_camPos, _camWorldMat);
    } else if (cfg.lookAt && cfg.pos) {
      Vec3.copy(_camPos, cfg.pos);
      Mat4.lookAt(_viewMat, cfg.pos, cfg.lookAt, cfg.up || [0, 1, 0]);
      Mat4.invert(_camWorldMat, _viewMat);
    } else {
      if (cfg.pos) Vec3.copy(_camPos, cfg.pos);
      Mat4.fromTRS(_camWorldMat, _camPos, [cfg.pitch || 0, cfg.yaw || 0, cfg.roll || 0], [1, 1, 1]);
      Mat4.invert(_viewMat, _camWorldMat);
    }

    _camRight[0] = _camWorldMat[0]; _camRight[1] = _camWorldMat[1]; _camRight[2] = _camWorldMat[2];
    _camUp[0] = _camWorldMat[4]; _camUp[1] = _camWorldMat[5]; _camUp[2] = _camWorldMat[6];
    _camForward[0] = -_camWorldMat[8]; _camForward[1] = -_camWorldMat[9]; _camForward[2] = -_camWorldMat[10];
    Vec3.normalize(_camRight, _camRight);
    Vec3.normalize(_camUp, _camUp);
    Vec3.normalize(_camForward, _camForward);

    if (cfg.projMat) Mat4.copy(_projMat, cfg.projMat);
    else Mat4.perspective(_projMat, _camFov, aspect, _camNear, _camFar);

    Mat4.perspective(_vmProjMat, _camFov, aspect, 0.015, 14.0);
    Mat4.multiply(_viewProjMat, _projMat, _viewMat);
    Mat4.invert(_invViewProjMat, _viewProjMat);
    Mat4.invert(_invProjMat, _projMat);

    // Mirrored camera across Y = 0 plane: _reflViewMat = _viewMat * diag(1, -1, 1, 1)
    Mat4.copy(_reflViewMat, _viewMat);
    _reflViewMat[4] = -_reflViewMat[4];
    _reflViewMat[5] = -_reflViewMat[5];
    _reflViewMat[6] = -_reflViewMat[6];
    _reflViewMat[7] = -_reflViewMat[7];
    _reflCamPos[0] = _camPos[0];
    _reflCamPos[1] = -_camPos[1];
    _reflCamPos[2] = _camPos[2];
    Mat4.multiply(_reflViewProjMat, _projMat, _reflViewMat);
    Mat4.invert(_invReflViewProjMat, _reflViewProjMat);
  }

  function updateSunShadowMatrix() {
    const halfExt = _diagCam ? 78.0 : 54.0;
    _shadowWorldSpan = halfExt * 2.0;
    const focusDist = _diagCam ? 12.0 : 22.0;
    const tx = DMath.clamp(_camPos[0] + _camForward[0] * focusDist, -82, 82);
    const ty = DMath.clamp(_camPos[1] * 0.35, 0, 14);
    const tz = DMath.clamp(_camPos[2] + _camForward[2] * focusDist, -50, 50);

    const eye = [tx + SUN_DIR[0] * 115, ty + SUN_DIR[1] * 115, tz + SUN_DIR[2] * 115];
    Mat4.lookAt(_lightViewMat, eye, [tx, ty, tz], [0, 1, 0]);

    const worldUnitsPerTexel = _shadowWorldSpan / _quality.shadowSize;
    Mat4.transformPoint(_tmpVec, _lightViewMat, [0, 0, 0]);
    _lightViewMat[12] += Math.round(_tmpVec[0] / worldUnitsPerTexel) * worldUnitsPerTexel - _tmpVec[0];
    _lightViewMat[13] += Math.round(_tmpVec[1] / worldUnitsPerTexel) * worldUnitsPerTexel - _tmpVec[1];

    Mat4.ortho(_lightProjMat, -halfExt, halfExt, -halfExt, halfExt, 10.0, 250.0);
    Mat4.multiply(_lightVPMat, _lightProjMat, _lightViewMat);
  }

  // ---------------------------------------------------------------------------
  // Render Passes
  // ---------------------------------------------------------------------------
  function packActiveLights() {
    const count = Math.min(_lights.length, MAX_DYNAMIC_LIGHTS);
    if (_lights.length > MAX_DYNAMIC_LIGHTS) {
      for (let i = 0; i < _lights.length; i++) {
        const l = _lights[i];
        const dx = l.pos[0] - _camPos[0], dy = l.pos[1] - _camPos[1], dz = l.pos[2] - _camPos[2];
        l.score = (l.intensity * l.radius) / (Math.sqrt(dx * dx + dy * dy + dz * dz) + 4.0);
      }
      _lights.sort((a, b) => b.score - a.score);
    }
    _stats.activeLights = count;
    for (let i = 0; i < count; i++) {
      const l = _lights[i], o = i * 4;
      _lightPosRadBuf[o] = l.pos[0]; _lightPosRadBuf[o + 1] = l.pos[1];
      _lightPosRadBuf[o + 2] = l.pos[2]; _lightPosRadBuf[o + 3] = l.radius;
      _lightColIntBuf[o] = l.color[0] * l.intensity; _lightColIntBuf[o + 1] = l.color[1] * l.intensity;
      _lightColIntBuf[o + 2] = l.color[2] * l.intensity; _lightColIntBuf[o + 3] = 1.0;
    }
    return count;
  }

  function bindPBRSharedUniforms(gl, prog, isPlanarPass) {
    const u = prog.u;
    gl.uniformMatrix4fv(u.uLightVP, false, _lightVPMat);
    gl.uniform3fv(u.uCamPos, isPlanarPass ? _reflCamPos : _camPos);
    gl.uniform3fv(u.uSunDir, SUN_DIR);
    gl.uniform3fv(u.uSunColor, SUN_COLOR);
    gl.uniform1f(u.uSunIntensity, SUN_INTENSITY);
    gl.uniform3fv(u.uSkyTop, SKY_TOP_COLOR);
    gl.uniform3fv(u.uSkyHorizon, SKY_HORIZON_COLOR);
    gl.uniform3fv(u.uGroundBounce, GROUND_BOUNCE_COLOR);
    gl.uniform1i(u.uVisionMode, _visionModeId);
    gl.uniform1i(u.uPcfTaps, isPlanarPass ? 4 : _quality.pcfTaps);
    gl.uniform1i(u.uUsePCSS, (!isPlanarPass && _quality.pcss) ? 1 : 0);
    gl.uniform2f(u.uShadowTexel, 1.0 / _quality.shadowSize, 1.0 / _quality.shadowSize);
    gl.uniform1f(u.uShadowWorldSpan, _shadowWorldSpan);
    gl.uniform1f(u.uTime, _time);
    gl.uniform1f(u.uPlanarClip, isPlanarPass ? 1.0 : 0.0);
    const usePlanar = !isPlanarPass && _camPos[1] >= 0.05 && _quality.planarRefl && _visionModeId !== 1 && _visionModeId !== 2 && _planarReflFBO && _planarReflFBO.ok;
    gl.uniform1f(u.uPlanarEnabled, usePlanar ? 1.0 : 0.0);
    gl.uniform2f(u.uInvScreen, 1.0 / _width, 1.0 / _height);

    const count = _stats.activeLights;
    gl.uniform1i(u.uLightCount, count);
    if (count > 0) {
      gl.uniform4fv(u.uLightPosRad, _lightPosRadBuf);
      gl.uniform4fv(u.uLightColInt, _lightColIntBuf);
    }

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, _shadowFBO.depthTex);
    gl.uniform1i(u.uShadowMap, 3);
    // Always bind a non-feedback texture to TEXTURE4 (critical for WebGL2 FBO feedback rules!)
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, usePlanar ? _planarReflFBO.colorTex : _dummyBlackTex);
    gl.uniform1i(u.uPlanarReflTex, 4);
    gl.uniform1i(u.uAlbedoMap, 0);
    gl.uniform1i(u.uNormalMap, 1);
    gl.uniform1i(u.uOrmMap, 2);
  }

  function renderShadowPass(gl) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, _shadowFBO.fbo);
    gl.viewport(0, 0, _shadowFBO.w, _shadowFBO.h);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.colorMask(false, false, false, false);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.6, 2.8);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    gl.useProgram(_progShadow.prog);
    gl.uniformMatrix4fv(_progShadow.u.uLightVP, false, _lightVPMat);

    let lastVao = null;
    for (let i = 0; i < _opaqueQueue.length; i++) {
      const it = _opaqueQueue[i];
      if (!it.castShadow) continue;
      if (it.doubleSided) gl.disable(gl.CULL_FACE);
      else gl.enable(gl.CULL_FACE);
      if (it.mesh.vao !== lastVao) {
        gl.bindVertexArray(it.mesh.vao);
        lastVao = it.mesh.vao;
      }
      gl.uniformMatrix4fv(_progShadow.u.uModel, false, it.modelMat);
      gl.drawElements(gl.TRIANGLES, it.mesh.indexCount, it.mesh.indexType || gl.UNSIGNED_SHORT, 0);
      _stats.drawCalls++;
      _stats.triangles += (it.mesh.indexCount / 3) | 0;
    }

    gl.bindVertexArray(null);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
  }

  function drawPBRList(gl, list, isViewmodel, viewOverride, isPlanarPass) {
    const u = _progPBR.u;
    let lastTexKey = null;
    let lastVao = null;
    let lastCull = true;

    gl.enable(gl.CULL_FACE);
    gl.frontFace(isPlanarPass ? gl.CW : gl.CCW);
    gl.cullFace(gl.BACK);

    if (isViewmodel) {
      gl.uniformMatrix4fv(u.uProj, false, _vmProjMat);
      gl.uniform1f(u.uIsViewmodel, 1.0);
    } else {
      gl.uniformMatrix4fv(u.uView, false, viewOverride || _viewMat);
      gl.uniformMatrix4fv(u.uProj, false, _projMat);
      gl.uniform1f(u.uIsViewmodel, 0.0);
    }

    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      // In planar reflection pass, skip flat street asphalt meshes cleanly
      if (isPlanarPass && it.texKey === 'asphalt' && it.modelMat[13] < 0.08) continue;

      const wantCull = !it.doubleSided;
      if (wantCull !== lastCull) {
        if (wantCull) gl.enable(gl.CULL_FACE);
        else gl.disable(gl.CULL_FACE);
        lastCull = wantCull;
      }

      if (it.texKey !== lastTexKey) {
        const t = DF.Textures.get(it.texKey);
        if (t) {
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t.albedo);
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, t.normal);
          gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, t.orm);
        }
        lastTexKey = it.texKey;
      }

      if (it.mesh.vao !== lastVao) {
        gl.bindVertexArray(it.mesh.vao);
        lastVao = it.mesh.vao;
      }

      if (isViewmodel) {
        let useCamSpace = it.cameraSpace;
        if (!useCamSpace && !it.worldSpace) {
          const mx = it.modelMat[12], my = it.modelMat[13], mz = it.modelMat[14];
          const dOrig = mx * mx + my * my + mz * mz;
          const dx = mx - _camPos[0], dy = my - _camPos[1], dz = mz - _camPos[2];
          if (dOrig < 3.0 && (dx * dx + dy * dy + dz * dz) > 3.0) useCamSpace = true;
        }
        if (useCamSpace) {
          gl.uniformMatrix4fv(u.uView, false, _identityMat);
          gl.uniformMatrix4fv(u.uModel, false, it.modelMat);
          Mat4.multiply(_tmpMatA, _camWorldMat, it.modelMat);
          gl.uniformMatrix4fv(u.uWorldModel, false, _tmpMatA);
        } else {
          gl.uniformMatrix4fv(u.uView, false, _viewMat);
          gl.uniformMatrix4fv(u.uModel, false, it.modelMat);
          gl.uniformMatrix4fv(u.uWorldModel, false, it.modelMat);
        }
      } else {
        gl.uniformMatrix4fv(u.uModel, false, it.modelMat);
        gl.uniformMatrix4fv(u.uWorldModel, false, it.modelMat);
      }

      gl.uniform3f(u.uBaseColor, it.color[0], it.color[1], it.color[2]);
      gl.uniform2f(u.uRoughParam, it.hasRough, it.rough);
      gl.uniform2f(u.uMetalParam, it.hasMetal, it.metal);
      gl.uniform3f(u.uEmissive, it.emissive[0], it.emissive[1], it.emissive[2]);
      gl.uniform2f(u.uUvScale, it.uvScale[0], it.uvScale[1]);
      gl.uniform1f(u.uAlpha, it.alpha);
      gl.uniform1f(u.uThermalHeat, it.thermalHeat);
      gl.uniform1f(u.uReceiveShadow, it.receiveShadow ? 1.0 : 0.0);
      gl.uniform1f(u.uUnlit, it.unlit ? 1.0 : 0.0);
      gl.uniform1f(u.uIsRoad, it.texKey === 'asphalt' ? 1.0 : 0.0);

      gl.drawElements(gl.TRIANGLES, it.mesh.indexCount, it.mesh.indexType || gl.UNSIGNED_SHORT, 0);
      _stats.drawCalls++;
      _stats.triangles += (it.mesh.indexCount / 3) | 0;
    }

    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);
    gl.frontFace(gl.CCW);
    gl.cullFace(gl.BACK);
  }

  function renderPlanarReflectionPass(gl) {
    if (!_progPBR || !_quality.planarRefl || _visionModeId === 1 || _visionModeId === 2 || !_planarReflFBO || !_planarReflFBO.ok) return;
    if (_camPos[1] < 0.05) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, _planarReflFBO.fbo);
    gl.viewport(0, 0, _planarReflFBO.w, _planarReflFBO.h);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clearColor(0.14, 0.18, 0.24, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(_progPBR.prog);
    bindPBRSharedUniforms(gl, _progPBR, true);
    drawPBRList(gl, _opaqueQueue, false, _reflViewMat, true);

    renderSkyDome(gl, _invReflViewProjMat, _reflCamPos);
  }

  function renderSkyDome(gl, invVPOverride, camPosOverride) {
    gl.useProgram(_progSky.prog);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    const u = _progSky.u;
    gl.uniformMatrix4fv(u.uInvViewProj, false, invVPOverride || _invViewProjMat);
    gl.uniform3fv(u.uCamPos, camPosOverride || _camPos);
    gl.uniform3fv(u.uSunDir, SUN_DIR);
    gl.uniform3fv(u.uSunColor, SUN_COLOR);
    gl.uniform3fv(u.uSkyTop, SKY_TOP_COLOR);
    gl.uniform3fv(u.uSkyHorizon, SKY_HORIZON_COLOR);
    gl.uniform1f(u.uTime, _time);
    gl.uniform1i(u.uVisionMode, _visionModeId);

    gl.bindVertexArray(_emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.CULL_FACE);
    _stats.drawCalls++;
  }

  function renderWireframeScene(gl) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, _sceneFBO.fbo);
    gl.viewport(0, 0, _width, _height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.clearColor(0.005, 0.008, 0.013, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(_progWire.prog);
    gl.uniformMatrix4fv(_progWire.u.uViewProj, false, _viewProjMat);
    gl.uniform3fv(_progWire.u.uCamPos, _camPos);

    gl.depthRange(0.002, 1.0);
    gl.uniform1f(_progWire.u.uSolidPass, 1.0);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2.5, 4.0);
    const drawSolidList = (list) => {
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (it.doubleSided) gl.disable(gl.CULL_FACE);
        else gl.enable(gl.CULL_FACE);
        gl.bindVertexArray(it.mesh.vao);
        gl.uniformMatrix4fv(_progWire.u.uModel, false, it.modelMat);
        gl.drawElements(gl.TRIANGLES, it.mesh.indexCount, it.mesh.indexType || gl.UNSIGNED_SHORT, 0);
        _stats.drawCalls++;
      }
    };
    drawSolidList(_opaqueQueue);
    drawSolidList(_transparentQueue);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.CULL_FACE);

    gl.depthRange(0.0, 0.998);
    gl.uniform1f(_progWire.u.uSolidPass, 0.0);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    const drawWireList = (list) => {
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (!it.mesh.wireframeIbo || !it.mesh.wireframeCount) continue;
        gl.bindVertexArray(it.mesh.vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, it.mesh.wireframeIbo);
        gl.uniformMatrix4fv(_progWire.u.uModel, false, it.modelMat);
        const isArmor = it.texKey.indexOf('armor') !== -1;
        const isUnit = it.texKey.indexOf('uniform') !== -1 || it.texKey === 'skin';
        if (isUnit) gl.uniform3f(_progWire.u.uWireColor, 1.0, 0.80, 0.24);
        else if (isArmor) gl.uniform3f(_progWire.u.uWireColor, 0.98, 0.44, 0.18);
        else gl.uniform3f(_progWire.u.uWireColor, 0.22, 0.86, 0.96);
        gl.drawElements(gl.LINES, it.mesh.wireframeCount, it.mesh.indexType || gl.UNSIGNED_SHORT, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, it.mesh.ibo);
        _stats.drawCalls++;
      }
    };
    drawWireList(_opaqueQueue);
    drawWireList(_transparentQueue);
    gl.bindVertexArray(null);
    gl.depthRange(0.0, 1.0);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
  }

  function renderSSAOPass(gl) {
    if (!_quality.ssao || _visionModeId === 1 || _visionModeId === 2) return;

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(_emptyVao);

    gl.bindFramebuffer(gl.FRAMEBUFFER, _ssaoFBO.fbo);
    gl.viewport(0, 0, _ssaoFBO.w, _ssaoFBO.h);
    gl.useProgram(_progSSAO.prog);
    const u = _progSSAO.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _depthCopyFBO.depthTex); gl.uniform1i(u.uDepthTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, _shadowFBO.depthTex); gl.uniform1i(u.uShadowMap, 1);
    gl.uniformMatrix4fv(u.uInvProj, false, _invProjMat);
    gl.uniformMatrix4fv(u.uProj, false, _projMat);
    gl.uniformMatrix4fv(u.uInvViewProj, false, _invViewProjMat);
    gl.uniformMatrix4fv(u.uLightVP, false, _lightVPMat);
    gl.uniformMatrix4fv(u.uCamWorld, false, _camWorldMat);
    gl.uniform3fv(u.uSunDir, SUN_DIR);
    gl.uniform2f(u.uTexelSize, 1.0 / _width, 1.0 / _height);
    gl.uniform1i(u.uSamples, _quality.ssaoSamples);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(_progBilateral.prog);
    gl.uniform1i(_progBilateral.u.uTex, 0);
    gl.uniform1i(_progBilateral.u.uDepthTex, 1);
    gl.uniform1f(_progBilateral.u.uSkipSky, 1.0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, _depthCopyFBO.depthTex);

    gl.bindFramebuffer(gl.FRAMEBUFFER, _ssaoBlurTmp.fbo);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _ssaoFBO.colorTex);
    gl.uniform2f(_progBilateral.u.uDir, 1.25 / _ssaoFBO.w, 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, _ssaoBlurOut.fbo);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _ssaoBlurTmp.colorTex);
    gl.uniform2f(_progBilateral.u.uDir, 0.0, 1.25 / _ssaoFBO.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, _sceneFBO.fbo);
    gl.viewport(0, 0, _width, _height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.DST_COLOR, gl.ZERO);
    gl.useProgram(_progCopy.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _ssaoBlurOut.colorTex);
    gl.uniform1i(_progCopy.u.uTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    _stats.drawCalls += 4;
  }

  function renderDecals(gl) {
    const count = _decals.length;
    if (count === 0 || !_progDecal || !_decalVao) return;

    for (let i = 0; i < count; i++) {
      const d = _decals[i], o = i * DECAL_FLOATS;
      _decalInstData[o] = d.pos[0]; _decalInstData[o + 1] = d.pos[1]; _decalInstData[o + 2] = d.pos[2]; _decalInstData[o + 3] = d.size;
      _decalInstData[o + 4] = d.normal[0]; _decalInstData[o + 5] = d.normal[1]; _decalInstData[o + 6] = d.normal[2]; _decalInstData[o + 7] = d.rot;
      _decalInstData[o + 8] = d.typeId; _decalInstData[o + 9] = Math.max(0, _time - d.spawnTime); _decalInstData[o + 10] = d.seed; _decalInstData[o + 11] = d.intensity;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, _decalInstVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, _decalInstData.subarray(0, count * DECAL_FLOATS));

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-2.0, -4.0);

    gl.useProgram(_progDecal.prog);
    const u = _progDecal.u;
    gl.uniformMatrix4fv(u.uViewProj, false, _viewProjMat);
    gl.uniform3fv(u.uCamPos, _camPos);
    gl.uniform3fv(u.uSunDir, SUN_DIR);
    gl.uniform3fv(u.uSunColor, SUN_COLOR);
    gl.uniform3fv(u.uSkyTop, SKY_TOP_COLOR);
    gl.uniform1i(u.uVisionMode, _visionModeId);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _decalAtlasTex);
    gl.uniform1i(u.uDecalAtlas, 0);

    gl.bindVertexArray(_decalVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);

    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.CULL_FACE);
    _stats.drawCalls++;
    _stats.triangles += count * 2;
  }

  function renderTracers(gl) {
    const count = Math.min(_tracers.length, MAX_TRACERS);
    if (count === 0 || !_progTracer || !_tracerVao) return;

    for (let i = 0; i < count; i++) {
      const tr = _tracers[i], o = i * TRACER_FLOATS;
      _tracerInstData[o] = tr.from[0]; _tracerInstData[o + 1] = tr.from[1]; _tracerInstData[o + 2] = tr.from[2]; _tracerInstData[o + 3] = tr.width;
      _tracerInstData[o + 4] = tr.to[0]; _tracerInstData[o + 5] = tr.to[1]; _tracerInstData[o + 6] = tr.to[2]; _tracerInstData[o + 7] = tr.alpha;
      _tracerInstData[o + 8] = tr.color[0]; _tracerInstData[o + 9] = tr.color[1]; _tracerInstData[o + 10] = tr.color[2]; _tracerInstData[o + 11] = tr.maxPx;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, _tracerInstVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, _tracerInstData.subarray(0, count * TRACER_FLOATS));

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(_progTracer.prog);
    const u = _progTracer.u;
    gl.uniformMatrix4fv(u.uViewProj, false, _viewProjMat);
    gl.uniform3fv(u.uCamPos, _camPos);
    gl.uniform1f(u.uWorldPerPx, (2.0 * Math.tan(_camFov * 0.5)) / Math.max(_height, 1));
    gl.uniform1i(u.uVisionMode, _visionModeId);

    gl.bindVertexArray(_tracerVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    _stats.drawCalls++;
    _stats.triangles += count * 2;
  }

  function renderParticles(gl) {
    const count = _particles.length;
    _stats.particles = count;
    if (count === 0) return;

    _particleSortBuf.length = count;
    for (let i = 0; i < count; i++) {
      const p = _particles[i];
      const dx = p.pos[0] - _camPos[0], dy = p.pos[1] - _camPos[1], dz = p.pos[2] - _camPos[2];
      p._distSq = dx * dx + dy * dy + dz * dz;
      _particleSortBuf[i] = p;
    }
    _particleSortBuf.sort((a, b) => b._distSq - a._distSq);

    const maxDraw = Math.min(count, _quality.maxParticles);
    if (_particleInstData.length < maxDraw * PARTICLE_FLOATS) {
      _particleInstData = new Float32Array(maxDraw * PARTICLE_FLOATS);
      gl.bindBuffer(gl.ARRAY_BUFFER, _particleInstVbo);
      gl.bufferData(gl.ARRAY_BUFFER, _particleInstData.byteLength, gl.DYNAMIC_DRAW);
    }

    for (let i = 0; i < maxDraw; i++) {
      const p = _particleSortBuf[i];
      const t = 1.0 - DMath.clamp(p.life / p.maxLife, 0, 1);
      const size = DMath.lerp(p.size, p.sizeEnd, t);
      const fadeIn = Math.min(t * 7.0, 1.0);
      const fadeOut = 1.0 - t * t;
      const alpha = p.alpha * fadeIn * fadeOut;

      const o = i * PARTICLE_FLOATS;
      _particleInstData[o] = p.pos[0]; _particleInstData[o + 1] = p.pos[1]; _particleInstData[o + 2] = p.pos[2]; _particleInstData[o + 3] = size;
      _particleInstData[o + 4] = p.color[0]; _particleInstData[o + 5] = p.color[1]; _particleInstData[o + 6] = p.color[2]; _particleInstData[o + 7] = alpha;
      _particleInstData[o + 8] = p.typeId + (p.variant || 0) * 0.1; _particleInstData[o + 9] = p.rot; _particleInstData[o + 10] = t; _particleInstData[o + 11] = p.additive ? 1.0 : 0.0;
      _particleInstData[o + 12] = p.vel[0]; _particleInstData[o + 13] = p.vel[1]; _particleInstData[o + 14] = p.vel[2]; _particleInstData[o + 15] = p.stretch;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, _particleInstVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, _particleInstData.subarray(0, maxDraw * PARTICLE_FLOATS));

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(_progParticle.prog);
    const u = _progParticle.u;
    gl.uniformMatrix4fv(u.uView, false, _viewMat);
    gl.uniformMatrix4fv(u.uProj, false, _projMat);
    gl.uniform3fv(u.uCamRight, _camRight);
    gl.uniform3fv(u.uCamUp, _camUp);
    gl.uniform3fv(u.uCamForward, _camForward);
    gl.uniform3fv(u.uCamPos, _camPos);
    gl.uniform2f(u.uInvScreen, 1.0 / _width, 1.0 / _height);
    gl.uniform1f(u.uNear, _camNear);
    gl.uniform1f(u.uFar, _camFar);
    gl.uniform3fv(u.uSunDir, SUN_DIR);
    gl.uniform3fv(u.uSunColor, SUN_COLOR);
    gl.uniform3fv(u.uSkyTop, SKY_TOP_COLOR);
    gl.uniform1f(u.uTime, _time);
    gl.uniform1i(u.uVisionMode, _visionModeId);

    const lCount = _stats.activeLights;
    gl.uniform1i(u.uLightCount, lCount);
    if (lCount > 0) {
      gl.uniform4fv(u.uLightPosRad, _lightPosRadBuf);
      gl.uniform4fv(u.uLightColInt, _lightColIntBuf);
    }

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _depthCopyFBO.depthTex); gl.uniform1i(u.uDepthTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, _smokeAtlasTex); gl.uniform1i(u.uSmokeAtlas, 1);

    gl.bindVertexArray(_particleVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, maxDraw);
    gl.bindVertexArray(null);

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    _stats.drawCalls++;
    _stats.triangles += maxDraw * 2;
  }

  function renderAmbientMotes(gl) {
    if (!_progMote || _quality.name === 'low' || _visionModeId === 1 || _visionModeId === 2) return;
    const count = _quality.name === 'ultra' ? 76 : (_quality.name === 'high' ? 56 : 36);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(_progMote.prog);
    const u = _progMote.u;
    gl.uniformMatrix4fv(u.uView, false, _viewMat);
    gl.uniformMatrix4fv(u.uProj, false, _projMat);
    gl.uniformMatrix4fv(u.uLightVP, false, _lightVPMat);
    gl.uniform3fv(u.uCamPos, _camPos);
    gl.uniform3fv(u.uCamRight, _camRight);
    gl.uniform3fv(u.uCamUp, _camUp);
    gl.uniform1f(u.uTime, _time);
    gl.uniform2f(u.uInvScreen, 1.0 / _width, 1.0 / _height);
    gl.uniform1f(u.uNear, _camNear);
    gl.uniform1f(u.uFar, _camFar);
    gl.uniform3fv(u.uSunColor, SUN_COLOR);

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _depthCopyFBO.depthTex); gl.uniform1i(u.uDepthTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, _shadowFBO.depthTex); gl.uniform1i(u.uShadowMap, 1);

    gl.bindVertexArray(_emptyVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    _stats.drawCalls++;
    _stats.triangles += count * 2;
  }

  function renderVolumetricShafts(gl) {
    if (!_quality.volShafts || _visionModeId === 1 || _visionModeId === 2) return 0.0;

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(_emptyVao);

    // 1. Half-res 3D Shadow-Marched Volumetric Scattering Pass
    gl.bindFramebuffer(gl.FRAMEBUFFER, _volRawFBO.fbo);
    gl.viewport(0, 0, _volRawFBO.w, _volRawFBO.h);
    gl.useProgram(_progVolFog.prog);
    const u = _progVolFog.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _depthCopyFBO.depthTex); gl.uniform1i(u.uDepthTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, _shadowFBO.depthTex); gl.uniform1i(u.uShadowMap, 1);
    gl.uniformMatrix4fv(u.uInvViewProj, false, _invViewProjMat);
    gl.uniformMatrix4fv(u.uLightVP, false, _lightVPMat);
    gl.uniform3fv(u.uCamPos, _camPos);
    gl.uniform3fv(u.uSunDir, SUN_DIR);
    gl.uniform3fv(u.uSunColor, SUN_COLOR);
    gl.uniform1i(u.uSteps, _quality.volSteps);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2. Depth-Bilateral Separable Blur (H + V) smooths IGN jitter while preserving sharp building edges!
    gl.useProgram(_progBilateral.prog);
    gl.uniform1i(_progBilateral.u.uTex, 0);
    gl.uniform1i(_progBilateral.u.uDepthTex, 1);
    gl.uniform1f(_progBilateral.u.uSkipSky, 0.0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, _depthCopyFBO.depthTex);

    gl.bindFramebuffer(gl.FRAMEBUFFER, _volTmpFBO.fbo);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _volRawFBO.colorTex);
    gl.uniform2f(_progBilateral.u.uDir, 1.4 / _volRawFBO.w, 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, _volOutFBO.fbo);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _volTmpFBO.colorTex);
    gl.uniform2f(_progBilateral.u.uDir, 0.0, 1.4 / _volRawFBO.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(null);
    _stats.drawCalls += 3;
    return 0.72;
  }

  function renderBloom(gl) {
    if (!_quality.bloom) return 0.0;

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(_emptyVao);

    gl.bindFramebuffer(gl.FRAMEBUFFER, _bloomHalfA.fbo);
    gl.viewport(0, 0, _bloomHalfA.w, _bloomHalfA.h);
    gl.useProgram(_progBloomBright.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _sceneFBO.colorTex);
    gl.uniform1i(_progBloomBright.u.uSceneTex, 0);
    gl.uniform1f(_progBloomBright.u.uThreshold, _hdrSupported ? 1.45 : 0.88);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, _bloomQuarterA.fbo);
    gl.viewport(0, 0, _bloomQuarterA.w, _bloomQuarterA.h);
    gl.useProgram(_progCopy.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _bloomHalfA.colorTex);
    gl.uniform1i(_progCopy.u.uTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(_progBlur9.prog);
    gl.uniform1i(_progBlur9.u.uTex, 0);
    for (let iter = 0; iter < 2; iter++) {
      const spread = iter === 0 ? 1.0 : 1.75;
      gl.bindFramebuffer(gl.FRAMEBUFFER, _bloomQuarterB.fbo);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _bloomQuarterA.colorTex);
      gl.uniform2f(_progBlur9.u.uDir, spread / _bloomQuarterA.w, 0.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, _bloomQuarterA.fbo);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _bloomQuarterB.colorTex);
      gl.uniform2f(_progBlur9.u.uDir, 0.0, spread / _bloomQuarterA.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.bindVertexArray(null);
    _stats.drawCalls += 6;
    return _visionModeId === 1 || _visionModeId === 2 ? 0.14 : 0.22;
  }

  function renderComposite(gl, bloomStrength, volStrength) {
    // Compute screen-space sun UV for occlusion-tested optical sun flare
    let sunU = -2.0, sunV = -2.0, sunVis = 0.0;
    const sunDot = Vec3.dot(_camForward, SUN_DIR);
    if (sunDot > 0.15 && !_wireframe) {
      const swx = _camPos[0] + SUN_DIR[0] * 300.0;
      const swy = _camPos[1] + SUN_DIR[1] * 300.0;
      const swz = _camPos[2] + SUN_DIR[2] * 300.0;
      const cx = _viewProjMat[0] * swx + _viewProjMat[4] * swy + _viewProjMat[8] * swz + _viewProjMat[12];
      const cy = _viewProjMat[1] * swx + _viewProjMat[5] * swy + _viewProjMat[9] * swz + _viewProjMat[13];
      const cw = _viewProjMat[3] * swx + _viewProjMat[7] * swy + _viewProjMat[11] * swz + _viewProjMat[15];
      if (cw > 0.001) {
        sunU = (cx / cw) * 0.5 + 0.5;
        sunV = (cy / cw) * 0.5 + 0.5;
        if (sunU > -0.1 && sunU < 1.1 && sunV > -0.1 && sunV < 1.1) {
          sunVis = DMath.smoothstep(0.15, 0.55, sunDot);
        }
      }
    }

    const useFinalAA = !_wireframe && (_quality.fxaa || _quality.sharpen > 0.01) && _ldrFBO && _ldrFBO.ok;

    // Pass 9a: Tone Mapping (ACES+AgX) + Split-Tone + Sun Flare + Combat FX -> _ldrFBO (or screen directly)
    gl.bindFramebuffer(gl.FRAMEBUFFER, useFinalAA ? _ldrFBO.fbo : null);
    gl.viewport(0, 0, _width, _height);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    gl.useProgram(_progComposite.prog);
    const u = _progComposite.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _sceneFBO.colorTex); gl.uniform1i(u.uSceneTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, _bloomQuarterA.colorTex); gl.uniform1i(u.uBloomTex, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, _volOutFBO.colorTex); gl.uniform1i(u.uVolTex, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, _depthCopyFBO.depthTex); gl.uniform1i(u.uDepthTex, 3);

    gl.uniform1f(u.uBloomStrength, bloomStrength);
    gl.uniform1f(u.uVolStrength, volStrength);
    gl.uniform1f(u.uSuppression, _postFX.suppression);
    gl.uniform1f(u.uDamageFlash, _postFX.damageFlash);
    gl.uniform1f(u.uConcussion, _postFX.concussion);
    gl.uniform1f(u.uVignette, _postFX.vignette);
    gl.uniform1f(u.uChromatic, _postFX.chromatic);
    gl.uniform1f(u.uMuzzleExposure, _postFX.muzzleExposure);
    gl.uniform2f(u.uSunUv, sunU, sunV);
    gl.uniform1f(u.uSunVis, sunVis);
    gl.uniform1i(u.uVisionMode, _visionModeId);
    gl.uniform1f(u.uTime, _time);
    gl.uniform2f(u.uResolution, _width, _height);

    gl.bindVertexArray(_emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    _stats.drawCalls++;

    // Pass 9b: FXAA Anti-Aliasing + Edge-Masked Unsharp Sharpening + Sky Dither -> Screen!
    if (useFinalAA) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, _width, _height);
      gl.useProgram(_progFinalAA.prog);
      const fu = _progFinalAA.u;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _ldrFBO.colorTex); gl.uniform1i(fu.uLdrTex, 0);
      gl.uniform2f(fu.uInvRes, 1.0 / _width, 1.0 / _height);
      const isThermal = (_visionModeId === 1 || _visionModeId === 2);
      gl.uniform1f(fu.uFxaaEnabled, (_quality.fxaa && !isThermal) ? 1.0 : 0.0);
      gl.uniform1f(fu.uSharpen, (!isThermal && _postFX.concussion < 0.04) ? _quality.sharpen : 0.0);
      gl.uniform1f(fu.uTime, _time);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      _stats.drawCalls++;
    }

    gl.bindVertexArray(null);
  }

  // ---------------------------------------------------------------------------
  // Diagnostic View Presets
  // ---------------------------------------------------------------------------
  const DIAGNOSTIC_VIEWS = {
    overview: { pos: [-64, 21, 13], lookAt: [10, 3.0, -3], fov: 56 },
    closeup: { pos: [-24, 2.6, 10], lookAt: [-38, 1.9, 0], fov: 56 },
    ground: { pos: [-14, 0.55, 6.5], lookAt: [4, 0.9, -4], fov: 62 },
  };

  // ---------------------------------------------------------------------------
  // Public DF.Renderer API
  // ---------------------------------------------------------------------------
  const Renderer = {
    get gl() { return _gl; },
    getGL() { return _gl; },

    init(canvas, quality = 'ultra') {
      _canvas = canvas;
      const gl = canvas.getContext('webgl2', {
        antialias: false, alpha: false, depth: true, stencil: false,
        powerPreference: 'high-performance', preserveDrawingBuffer: true,
      });
      if (!gl) throw new Error('WebGL2 is required for Urban Breakthrough renderer.');
      _gl = gl;
      _quality = QUALITY_PRESETS[quality] || QUALITY_PRESETS.ultra;
      _stats.quality = _quality.name;
      _hdrSupported = detectHDR(gl);

      if (DF.Textures) DF.Textures.init(gl, _quality.texQuality);

      _progShadow = createProgram(gl, SHADOW_VS, SHADOW_FS, 'Shadow');
      _progPBR = createProgram(gl, PBR_VS, PBR_FS, 'PBR');
      _progSky = createProgram(gl, SKY_VS, SKY_FS, 'Sky');
      _progWire = createProgram(gl, WIREFRAME_VS, WIREFRAME_FS, 'Wireframe');
      _progParticle = createProgram(gl, PARTICLE_VS, PARTICLE_FS, 'Particle');
      _progMote = createProgram(gl, MOTE_VS, MOTE_FS, 'AmbientMotes');
      _progTracer = createProgram(gl, TRACER_VS, TRACER_FS, 'Tracer');
      _progDecal = createProgram(gl, DECAL_VS, DECAL_FS, 'Decal');
      _progSSAO = createProgram(gl, FULLSCREEN_VS, SSAO_FS, 'SSAO');
      _progBilateral = createProgram(gl, FULLSCREEN_VS, BILATERAL_BLUR_FS, 'BilateralBlur');
      _progCopy = createProgram(gl, FULLSCREEN_VS, COPY_FS, 'Copy');
      _progVolFog = createProgram(gl, FULLSCREEN_VS, VOL_FOG_FS, 'VolFog3D');
      _progBloomBright = createProgram(gl, FULLSCREEN_VS, BLOOM_BRIGHT_FS, 'BloomBright');
      _progBlur9 = createProgram(gl, FULLSCREEN_VS, BLUR_9_FS, 'Blur9');
      _progComposite = createProgram(gl, FULLSCREEN_VS, COMPOSITE_FS, 'Composite');
      _progFinalAA = createProgram(gl, FULLSCREEN_VS, FINAL_AA_FS, 'FinalAA');

      _emptyVao = gl.createVertexArray();
      const pBuf = initInstancedVAO(gl, PARTICLE_FLOATS, 4, _particleInstData.byteLength);
      _particleVao = pBuf.vao; _particleInstVbo = pBuf.vbo;
      const tBuf = initInstancedVAO(gl, TRACER_FLOATS, 3, _tracerInstData.byteLength);
      _tracerVao = tBuf.vao; _tracerInstVbo = tBuf.vbo;
      const dBuf = initInstancedVAO(gl, DECAL_FLOATS, 3, _decalInstData.byteLength);
      _decalVao = dBuf.vao; _decalInstVbo = dBuf.vbo;

      _smokeAtlasTex = createSmokeAtlasTexture(gl);
      _decalAtlasTex = createDecalAtlasTexture(gl);
      _dummyBlackTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, _dummyBlackTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindTexture(gl.TEXTURE_2D, null);
      rebuildShadowFBO();
      ensureCanvasSize();

      applyCameraParams({ pos: [-68, 3.2, 2], lookAt: [-20, 2.0, 0], fov: 72 });

      const dbg = (window.DF_DEBUG = window.DF_DEBUG || {});
      if (!dbg.setDiagnosticView) dbg.setDiagnosticView = (mode) => Renderer.setDiagnosticView(mode);
      if (!dbg.setWireframe) dbg.setWireframe = (flag) => Renderer.setWireframe(flag);
      if (!dbg.setHideHUD) {
        dbg.setHideHUD = (hide) => {
          const els = document.querySelectorAll('#df-hud, .df-hud, [data-df-hud]');
          for (let i = 0; i < els.length; i++) els[i].style.display = hide ? 'none' : '';
          if (DF.Events) DF.Events.emit('debug:hideHud', !!hide);
        };
      }
      if (!dbg.getStats) dbg.getStats = () => Renderer.getStats();

      return gl;
    },

    setQuality(tier) {
      const preset = QUALITY_PRESETS[tier];
      if (!preset) return;
      const shadowChanged = preset.shadowSize !== _quality.shadowSize;
      const dprChanged = preset.maxPixelRatio !== _quality.maxPixelRatio;
      _quality = preset;
      _stats.quality = preset.name;
      if (_gl) {
        if (shadowChanged) rebuildShadowFBO();
        if (dprChanged) ensureCanvasSize();
        if (DF.Textures) DF.Textures.init(_gl, preset.texQuality);
        if (_particles.length > preset.maxParticles) _particles.length = preset.maxParticles;
      }
    },

    getQuality() { return _quality.name; },
    setWireframe(enabled) { _wireframe = !!enabled; },
    setDiagnosticCamera(camOverride) { _diagCam = camOverride || null; },

    setDiagnosticView(mode) {
      if (mode === 'wireframe') {
        _wireframe = true;
      } else if (mode === 'gameplay') {
        _wireframe = false;
        _diagCam = null;
      } else if (DIAGNOSTIC_VIEWS[mode]) {
        _wireframe = false;
        _diagCam = DIAGNOSTIC_VIEWS[mode];
      }
    },

    setCamera(cfg) {
      if (_diagCam) return;
      applyCameraParams(cfg);
    },

    setVisionMode(mode) {
      _visionMode = mode in VISION_MODE_ID ? mode : 'normal';
      _visionModeId = VISION_MODE_ID[_visionMode];
    },

    setPostFX(fx) {
      if (!fx) return;
      if (fx.suppression !== undefined) _postFX.suppression = DMath.clamp(fx.suppression, 0, 1);
      if (fx.damageFlash !== undefined) _postFX.damageFlash = DMath.clamp(fx.damageFlash, 0, 1);
      if (fx.concussion !== undefined) _postFX.concussion = DMath.clamp(fx.concussion, 0, 1);
      if (fx.vignette !== undefined) _postFX.vignette = DMath.clamp(fx.vignette, 0, 1);
      if (fx.chromatic !== undefined) _postFX.chromatic = DMath.clamp(fx.chromatic, 0, 0.05);
      if (fx.muzzleExposure !== undefined) _postFX.muzzleExposure = DMath.clamp(fx.muzzleExposure, 0, 2);
    },

    beginFrame(time, dt) {
      ensureCanvasSize();
      _time = time || 0;
      _dt = dt !== undefined ? DMath.clamp(dt, 0.0001, 0.1) : 0.016;
      _fpsSmooth = DMath.lerp(_fpsSmooth, 1.0 / Math.max(_dt, 0.001), 0.08);
      _stats.fps = Math.round(_fpsSmooth);
      _stats.drawCalls = 0;
      _stats.triangles = 0;

      _poolUsed = 0;
      _opaqueQueue.length = 0;
      _transparentQueue.length = 0;
      _viewmodelQueue.length = 0;
      _lights.length = 0;
      _tracers.length = 0;
      _particlesUpdatedThisFrame = false;

      if (_diagCam) applyCameraParams(_diagCam);
    },

    submitMesh(mesh, modelMat, material, flags) {
      if (!mesh || !mesh.vao || !mesh.indexCount || _poolUsed >= MAX_POOL_ITEMS) return;
      const it = _itemPool[_poolUsed++];
      it.mesh = mesh;
      if (modelMat) it.modelMat.set(modelMat);
      else Mat4.identity(it.modelMat);

      const m = material || {};
      const f = flags || {};

      it.texKey = m.texKey || m.tex || 'concrete';
      const mc = m.color || m.tint;
      if (mc) { it.color[0] = mc[0]; it.color[1] = mc[1]; it.color[2] = mc[2]; }
      else { it.color[0] = 1; it.color[1] = 1; it.color[2] = 1; }

      if (m.roughness !== undefined && m.roughness !== null) { it.hasRough = 1; it.rough = m.roughness; }
      else { it.hasRough = 0; it.rough = 0.7; }

      if (m.metalness !== undefined && m.metalness !== null) { it.hasMetal = 1; it.metal = m.metalness; }
      else { it.hasMetal = 0; it.metal = 0.0; }

      if (m.emissive) { it.emissive[0] = m.emissive[0]; it.emissive[1] = m.emissive[1]; it.emissive[2] = m.emissive[2]; }
      else { it.emissive[0] = 0; it.emissive[1] = 0; it.emissive[2] = 0; }

      if (m.uvScale !== undefined) {
        if (typeof m.uvScale === 'number') { it.uvScale[0] = m.uvScale; it.uvScale[1] = m.uvScale; }
        else { it.uvScale[0] = m.uvScale[0]; it.uvScale[1] = m.uvScale[1]; }
      } else { it.uvScale[0] = 1; it.uvScale[1] = 1; }

      it.alpha = m.alpha !== undefined ? m.alpha : 1.0;
      it.thermalHeat = m.thermalHeat !== undefined
        ? m.thermalHeat
        : (DEFAULT_THERMAL_BY_TEX[it.texKey] !== undefined ? DEFAULT_THERMAL_BY_TEX[it.texKey] : 0.12);
      it.doubleSided = !!m.doubleSided;

      it.viewmodel = !!f.viewmodel;
      it.cameraSpace = !!f.cameraSpace;
      it.worldSpace = !!f.worldSpace;
      it.unlit = !!f.unlit;
      it.castShadow = f.castShadow !== undefined ? !!f.castShadow : (!it.viewmodel && it.alpha >= 0.99);
      it.receiveShadow = f.receiveShadow !== undefined ? !!f.receiveShadow : true;

      if (it.viewmodel) {
        _viewmodelQueue.push(it);
      } else if (it.alpha < 0.99) {
        const dx = it.modelMat[12] - _camPos[0], dy = it.modelMat[13] - _camPos[1], dz = it.modelMat[14] - _camPos[2];
        it.distSq = dx * dx + dy * dy + dz * dz;
        _transparentQueue.push(it);
      } else {
        _opaqueQueue.push(it);
      }
    },

    // Upgrade F: 3-Layer Pixel-Width-Clamped Velocity-Aligned HDR Tracer API
    submitTracer(from, to, width = 0.028, color, alpha = 1.0, maxPx = 14.0) {
      if (!from || !to || _tracers.length >= MAX_TRACERS) return;
      const c = color || [1.0, 0.78, 0.36];
      _tracers.push({
        from: [from[0], from[1], from[2]],
        to: [to[0], to[1], to[2]],
        width: Math.max(0.008, width),
        color: [c[0], c[1], c[2]],
        alpha: DMath.clamp(alpha, 0, 1.5),
        maxPx,
      });
    },

    addDynamicLight(pos, color, intensity = 5.0, radius = 12.0) {
      if (!pos || intensity <= 0.001 || radius <= 0.01) return;
      const c = color || [1, 0.75, 0.4];
      _lights.push({ pos: [pos[0], pos[1], pos[2]], color: [c[0], c[1], c[2]], intensity, radius, score: 0 });
    },

    spawnParticle(cfg) {
      if (!cfg || !cfg.pos) return;
      const type = cfg.type || 'smoke';
      const typeId = PARTICLE_TYPE_ID[type] !== undefined ? PARTICLE_TYPE_ID[type] : 0;
      if (_particles.length >= _quality.maxParticles) _particles.shift();

      const isAddDefault = type === 'spark' || type === 'ember' || type === 'flash' || type === 'muzzle' || type === 'tracer' || type === 'shockwave';
      const life = Math.max(cfg.life !== undefined ? cfg.life : 1.0, 0.03);
      const size = cfg.size !== undefined ? cfg.size : 0.5;
      const col = cfg.color || (
        type === 'fire' ? [1.0, 0.62, 0.22] :
        type === 'spark' || type === 'ember' ? [1.0, 0.78, 0.35] :
        type === 'flash' || type === 'muzzle' ? [1.0, 0.88, 0.55] :
        type === 'blood' ? [0.52, 0.04, 0.04] :
        type === 'dust' ? [0.64, 0.59, 0.52] :
        type === 'debris' ? [0.32, 0.30, 0.28] :
        type === 'tracer' ? [1.0, 0.82, 0.40] :
        [0.45, 0.46, 0.48]
      );
      const szEnd = cfg.sizeEnd !== undefined ? cfg.sizeEnd : cfg.endSize;

      _particles.push({
        type, typeId,
        pos: [cfg.pos[0], cfg.pos[1], cfg.pos[2]],
        vel: cfg.vel ? [cfg.vel[0], cfg.vel[1], cfg.vel[2]] : [0, 0.5, 0],
        size,
        sizeEnd: szEnd !== undefined ? szEnd : (type === 'smoke' || type === 'dust' ? size * 2.8 : size * 0.4),
        life, maxLife: life,
        color: [col[0], col[1], col[2]],
        alpha: cfg.alpha !== undefined ? cfg.alpha : (isAddDefault || type === 'fire' ? 0.95 : 0.65),
        gravity: cfg.gravity !== undefined ? cfg.gravity : (
          type === 'smoke' ? -0.45 : type === 'fire' ? -1.4 : type === 'dust' ? 0.35 :
          type === 'debris' || type === 'casing' ? 14.5 : type === 'spark' ? 9.5 : type === 'blood' ? 6.5 : 0.0
        ),
        drag: cfg.drag !== undefined ? cfg.drag : (
          type === 'smoke' || type === 'dust' ? 1.4 : type === 'fire' ? 1.8 : type === 'spark' ? 0.6 : 0.25
        ),
        rot: Math.random() * Math.PI * 2,
        rotSpeed: cfg.rotSpeed !== undefined ? cfg.rotSpeed : (Math.random() - 0.5) * 1.1,
        variant: (Math.random() * 4) | 0,
        additive: cfg.additive !== undefined ? !!cfg.additive : isAddDefault,
        stretch: cfg.stretch !== undefined ? cfg.stretch : (type === 'spark' ? 3.5 : (type === 'tracer' ? 6.5 : 0.0)),
        _distSq: 0,
      });
    },

    updateParticles(dt) {
      if (dt <= 0) return;
      _particlesUpdatedThisFrame = true;
      const step = Math.min(dt, 0.08);
      let write = 0;

      for (let i = 0; i < _particles.length; i++) {
        const p = _particles[i];
        p.life -= step;
        if (p.life <= 0) continue;

        const dragMul = Math.exp(-p.drag * step);
        p.vel[0] *= dragMul;
        p.vel[1] = (p.vel[1] - p.gravity * step) * dragMul;
        p.vel[2] *= dragMul;

        if (p.typeId === 0 || p.typeId === 3) {
          const curl = Math.sin(_time * 0.9 + p.pos[1] * 0.55 + p.rot * 2.1);
          const curlZ = Math.cos(_time * 0.75 + p.pos[0] * 0.22 + p.rot * 1.7);
          p.vel[0] += (0.38 + curl * 0.32) * step;
          p.vel[2] += (curlZ * 0.36) * step;
        }

        p.pos[0] += p.vel[0] * step;
        p.pos[1] += p.vel[1] * step;
        p.pos[2] += p.vel[2] * step;
        p.rot += p.rotSpeed * step;

        if ((p.typeId === 2 || p.typeId === 4 || p.typeId === 9) && p.pos[1] < 0.04) {
          p.pos[1] = 0.04;
          p.vel[1] = Math.abs(p.vel[1]) * 0.38;
          p.vel[0] *= 0.65;
          p.vel[2] *= 0.65;
        }

        _particles[write++] = p;
      }
      _particles.length = write;
    },

    clearParticles() { _particles.length = 0; },

    spawnDecal(posOrCfg, normal, size, type) {
      let pos = posOrCfg, norm = normal, sz = size, tp = type;
      if (posOrCfg && !Array.isArray(posOrCfg) && !(posOrCfg instanceof Float32Array) && posOrCfg.pos) {
        pos = posOrCfg.pos; norm = posOrCfg.normal; sz = posOrCfg.size; tp = posOrCfg.type;
      }
      if (!pos || pos.length < 3) return;
      const nx = norm ? norm[0] : 0, ny = norm ? norm[1] : 1, nz = norm ? norm[2] : 0;
      const nLen = Math.hypot(nx, ny, nz) || 1;
      const ux = nx / nLen, uy = ny / nLen, uz = nz / nLen;

      const typeKey = String(tp || 'bullet').toLowerCase();
      const typeId = DECAL_TYPE_ID[typeKey] !== undefined ? DECAL_TYPE_ID[typeKey] : 0;
      const rad = Math.max(0.04, Math.min(sz !== undefined ? sz : (typeId === 3 ? 1.45 : 0.14), 4.5));
      const lift = typeId === 3 ? 0.018 : 0.014;

      const entry = {
        pos: [pos[0] + ux * lift, pos[1] + uy * lift, pos[2] + uz * lift],
        normal: [ux, uy, uz], size: rad, rot: Math.random() * Math.PI * 2,
        typeId, spawnTime: _time, seed: Math.random() * 100.0,
        intensity: typeId === 3 ? 0.95 : 0.90,
      };
      if (_decals.length < MAX_DECALS) _decals.push(entry);
      else {
        _decals[_decalWriteIdx] = entry;
        _decalWriteIdx = (_decalWriteIdx + 1) % MAX_DECALS;
      }
    },

    clearDecals() { _decals.length = 0; _decalWriteIdx = 0; },

    endFrame() {
      if (!_gl) return;
      const gl = _gl;

      if (!_particlesUpdatedThisFrame) Renderer.updateParticles(_dt);

      if (_wireframe) {
        renderWireframeScene(gl);
        renderComposite(gl, 0.0, 0.0);
        return;
      }

      _opaqueQueue.sort((a, b) => (a.texKey < b.texKey ? -1 : (a.texKey > b.texKey ? 1 : 0)));
      packActiveLights();

      // 1. Directional Sun Shadow Map Pass (for PCSS + 3D Volumetric Sun Shafts)
      updateSunShadowMatrix();
      renderShadowPass(gl);

      // 2. Half-Res Real-Time Planar Reflection Pass (Y = 0 mirrored buildings/tanks/sky!)
      renderPlanarReflectionPass(gl);

      // 3. Main World Opaque PBR Pass -> HDR sceneFBO
      gl.bindFramebuffer(gl.FRAMEBUFFER, _sceneFBO.fbo);
      gl.viewport(0, 0, _width, _height);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.clearColor(0.18, 0.22, 0.28, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      if (_progPBR) {
        gl.useProgram(_progPBR.prog);
        bindPBRSharedUniforms(gl, _progPBR, false);
        drawPBRList(gl, _opaqueQueue, false, _viewMat, false);
      }

      // 4. Procedural Atmospheric Sky Dome
      renderSkyDome(gl, _invViewProjMat, _camPos);

      // 5. Copy World Depth for Feedback-Free Ambient-Only SSAO, 3D Volumetric Shafts & Soft Particles
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, _sceneFBO.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, _depthCopyFBO.fbo);
      gl.blitFramebuffer(0, 0, _width, _height, 0, 0, _width, _height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

      // 6. Ambient-Only Bilateral SSAO (cool-blue crevice shadow tint)
      renderSSAOPass(gl);

      // 7. Surface Impact Decals + Transparent Meshes + 3-Layer Tracers + Volumetric Soft Particles
      gl.bindFramebuffer(gl.FRAMEBUFFER, _sceneFBO.fbo);
      gl.viewport(0, 0, _width, _height);
      renderDecals(gl);
      if (_transparentQueue.length > 0 && _progPBR) {
        _transparentQueue.sort((a, b) => b.distSq - a.distSq);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(_progPBR.prog);
        bindPBRSharedUniforms(gl, _progPBR, false);
        drawPBRList(gl, _transparentQueue, false, _viewMat, false);
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }
      renderTracers(gl);
      renderParticles(gl);
      renderAmbientMotes(gl);

      // 8. Depth-Cleared First-Person Hero Viewmodel PBR Pass
      if (_viewmodelQueue.length > 0 && !_diagCam && _progPBR) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, _sceneFBO.fbo);
        gl.viewport(0, 0, _width, _height);
        gl.depthMask(true);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.useProgram(_progPBR.prog);
        bindPBRSharedUniforms(gl, _progPBR, false);

        const vmOpaque = [], vmAlpha = [];
        for (let i = 0; i < _viewmodelQueue.length; i++) {
          if (_viewmodelQueue[i].alpha < 0.99) vmAlpha.push(_viewmodelQueue[i]);
          else vmOpaque.push(_viewmodelQueue[i]);
        }
        if (vmOpaque.length > 0) {
          gl.depthMask(true); gl.disable(gl.BLEND);
          drawPBRList(gl, vmOpaque, true, _viewMat, false);
        }
        if (vmAlpha.length > 0) {
          gl.depthMask(false); gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          drawPBRList(gl, vmAlpha, true, _viewMat, false);
          gl.disable(gl.BLEND); gl.depthMask(true);
        }
      }

      // 9. 3D Shadow-Marched Volumetric Sun Shafts + Dual-Pass Bloom
      const volStr = renderVolumetricShafts(gl);
      const bloomStr = renderBloom(gl);

      // 10. ACES+AgX Filmic Composite + FXAA + Edge-Masked Unsharp Mask + Sky Dither -> Screen!
      renderComposite(gl, bloomStr, volStr);
    },

    getStats() {
      return {
        fps: _stats.fps, drawCalls: _stats.drawCalls, triangles: _stats.triangles,
        particles: _stats.particles, activeLights: _stats.activeLights, quality: _stats.quality,
      };
    },
  };

  DF.Renderer = Renderer;
})();
