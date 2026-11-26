(() => {
  'use strict';
  const DF = (window.DF = window.DF || {});

  const PLAYER_RADIUS = 0.36;
  const STAND_HEIGHT = 1.78;
  const CROUCH_HEIGHT = 1.22;
  const STAND_EYE = 1.62;
  const CROUCH_EYE = 1.06;
  const DOWNED_EYE = 0.36;
  const GRAVITY = 19.8;
  const JUMP_VEL = 5.65;
  const WALK_SPEED = 4.6;
  const SPRINT_SPEED = 7.2;
  const CROUCH_SPEED = 2.65;
  const ADS_SPEED = 2.55;

  const ORDER_LABELS = {
    follow: '跟随集结',
    attack: '进攻/固守目标',
    suppress: '火力压制',
    flank: '侧翼包抄',
    revive: '医疗救援',
    vehicle: '载具/无人协同',
  };

  const Game = {
    canvas: null,
    uiContainer: null,
    gl: null,
    initialized: false,
    running: false,

    phase: 'menu', // 'menu' | 'playing' | 'paused' | 'ended'
    playerFaction: 'UA',
    controlMode: 'infantry', // 'infantry' | 'vehicle' | 'drone' | 'dog' | 'downed' | 'dead'
    diagnosticView: 'gameplay', // 'gameplay' | 'overview' | 'closeup' | 'ground' | 'wireframe'
    customCameraOverride: null,
    hideHUD: false,

    settings: {
      quality: 'ultra',
      sensitivity: 1.0,
      invertY: false,
      masterVol: 0.85,
      sfxVol: 0.9,
      musicVol: 0.55,
      baseFov: 75,
    },

    // Timing
    time: 0,
    lastFrameTs: 0,
    physAccum: 0,
    frameCount: 0,

    // Input state
    keys: Object.create(null),
    mouseButtons: { left: false, right: false, middle: false },
    pointerLocked: false,
    mouseDeltaX: 0,
    mouseDeltaY: 0,
    qDownTime: 0,
    qHeld: false,
    radialOpen: false,
    mapOpen: false,
    fireTriggerConsumed: false,
    burstRemaining: 0,
    burstTimer: 0,

    // Player infantry runtime state
    eyeHeight: STAND_EYE,
    currentFov: 75,
    adsBlend: 0,
    isAds: false,
    isSprinting: false,
    sprintBlend: 0,
    sprintDemo: false,
    stridePhase: 0,
    lastStrideCount: 0,
    lastPlayerDamageTime: -99,
    _prevPlayerHp: 100,
    swayX: 0,
    swayY: 0,
    recoilPitch: 0,
    recoilYaw: 0,
    recoilPitchVel: 0,
    recoilYawVel: 0,
    equipTimer: 0,
    weaponStates: [], // 6 slots
    fragCount: 2,
    smokeCount: 2,
    grenadeCooldown: 0,
    reviveChannelTarget: null,
    reviveChannelTimer: 0,
    interactPrompt: '',
    interactAction: null,
    vault: null, // Active window vault state
    vaultCooldown: 0,
    jumpConsumedByVault: false,

    // Vehicle / Unmanned active handles
    activeVehicle: null,
    vehicleCamMode: 0, // 0: 3rd person, 1: gunner optic, 2: FLIR thermal
    visionMode: 'normal', // 'normal' | 'thermal_white' | 'thermal_green' | 'optic'
    droneReturnDelay: 0,
    dogReturnDelay: 0,

    // Camera state
    camera: {
      pos: [0, 8, 25],
      yaw: 0,
      pitch: 0,
      roll: 0,
      fov: 75,
      near: 0.1,
      far: 320,
      viewMat: null,
      projMat: null,
      viewProjMat: null,
    },

    // IFF / 3D Overhead Marker & Crosshair Target state
    crosshairTargetType: null, // 'enemy' | 'ally' | null
    losVisible: Object.create(null),
    iffScanTimer: 0,
    crosshairScanTimer: 0,

    // FX & combat feel state
    shakeTrauma: 0,
    shakeOffset: [0, 0, 0],
    shakeRot: [0, 0, 0],
    postFX: {
      suppression: 0,
      damageFlash: 0,
      concussion: 0,
      vignette: 0.18,
      chromatic: 0,
      muzzleExposure: 0,
    },
    damageIndicator: { angle: 0, alpha: 0 },
    hitmarker: { alpha: 0, isKill: false, isHeadshot: false, isArmor: false },
    combatIntensity: 0.15,
    dynamicLights: [],
    pendingExplosions: [],
    explosionDepth: 0,

    // Match player stats
    stats: {
      kills: 0,
      headshots: 0,
      damageDealt: 0,
      vehiclesDestroyed: 0,
      wallsBreached: 0,
      alliesRevived: 0,
      shotsFired: 0,
      shotsHit: 0,
    },
  };

  /* ------------------------------------------------------------------
   * Safe Helpers
   * ------------------------------------------------------------------ */
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function damp(a, b, lambda, dt) {
    return lerp(a, b, 1 - Math.exp(-lambda * dt));
  }

  function safeCall(obj, fnName, ...args) {
    if (obj && typeof obj[fnName] === 'function') {
      return obj[fnName](...args);
    }
    return undefined;
  }

  function forwardFromYawPitch(yaw, pitch) {
    const cp = Math.cos(pitch);
    return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  }

  function rightFromYaw(yaw) {
    return [Math.cos(yaw), 0, -Math.sin(yaw)];
  }

  function normalize3(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  function dist3(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  function getWeaponSpec(slot, faction) {
    if (DF.WeaponCatalog && typeof DF.WeaponCatalog.get === 'function') {
      return DF.WeaponCatalog.get(slot, faction || Game.playerFaction);
    }
    return {
      id: 'ar',
      slot: slot || 0,
      name: faction === 'RU' ? 'AK-74M' : 'M4A1',
      displayName: faction === 'RU' ? 'AK-74M' : 'M4A1 突击步枪',
      caliber: '5.56x45mm',
      rpm: 750,
      damage: 32,
      headMult: 2.3,
      armorPen: 0.2,
      muzzleVel: 860,
      gravity: 9.8,
      spreadHip: 0.025,
      spreadAds: 0.004,
      recoilPitch: 0.018,
      recoilYaw: 0.008,
      magSize: 30,
      reserveMax: 180,
      reloadTacticalTime: 2.1,
      reloadEmptyTime: 2.7,
      fireModes: ['auto', 'semi'],
      adsFov: 52,
      scopeType: 'reddot',
      pelletCount: 1,
      explosiveRadius: 0,
      audioProfile: faction === 'RU' ? 'ar_545' : 'ar_556',
    };
  }

  function loadSettings() {
    try {
      const raw = window.localStorage && localStorage.getItem('df_settings_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        Object.assign(Game.settings, parsed);
      }
    } catch (_) {
      // Ignore storage restrictions on file://
    }
  }

  function saveSettings() {
    try {
      if (window.localStorage) {
        localStorage.setItem('df_settings_v1', JSON.stringify(Game.settings));
      }
    } catch (_) {
      // Ignore
    }
  }

  /* ------------------------------------------------------------------
   * Dynamic Transient Light Pool
   * ------------------------------------------------------------------ */
  Game.addFlashLight = function (pos, color, intensity, radius, duration) {
    if (!pos) return;
    Game.dynamicLights.push({
      pos: [pos[0], pos[1], pos[2]],
      color: color ? [color[0], color[1], color[2]] : [1.0, 0.72, 0.35],
      intensity: intensity || 5,
      radius: radius || 10,
      life: duration || 0.15,
      maxLife: duration || 0.15,
    });
    if (Game.dynamicLights.length > 28) {
      Game.dynamicLights.shift();
    }
  };

  function updateDynamicLights(dt) {
    for (let i = Game.dynamicLights.length - 1; i >= 0; i--) {
      const l = Game.dynamicLights[i];
      l.life -= dt;
      if (l.life <= 0) {
        Game.dynamicLights.splice(i, 1);
      }
    }
  }

  function submitDynamicLights() {
    if (!DF.Renderer || typeof DF.Renderer.addDynamicLight !== 'function') return;
    for (let i = 0; i < Game.dynamicLights.length; i++) {
      const l = Game.dynamicLights[i];
      const t = clamp(l.life / Math.max(0.001, l.maxLife), 0, 1);
      DF.Renderer.addDynamicLight(l.pos, l.color, l.intensity * t * t, l.radius * (0.55 + 0.45 * t));
    }
  }

  /* ------------------------------------------------------------------
   * Player Weapon State Setup
   * ------------------------------------------------------------------ */
  function initPlayerWeaponStates(faction, preferredSlot) {
    Game.weaponStates = [];
    for (let i = 0; i < 6; i++) {
      const spec = getWeaponSpec(i, faction);
      const magSize = spec.magSize || 30;
      const reserveMax = spec.reserveMax != null ? spec.reserveMax : magSize * 5;
      Game.weaponStates.push({
        slot: i,
        mag: magSize,
        magSize,
        reserve: reserveMax,
        reserveMax,
        fireModeIdx: 0,
        reloading: false,
        reloadTimer: 0,
        reloadDuration: 2.0,
        reloadIsEmpty: false,
        shellByShell: !!(spec.shellByShell || (i === 3 && faction === 'UA')),
        shellTimer: 0,
        cooldown: 0,
      });
    }
    Game.fragCount = 2;
    Game.smokeCount = 2;
    Game.grenadeCooldown = 0;
    const slot = clamp(preferredSlot != null ? preferredSlot : 0, 0, 5);
    const ps = getPlayerSoldier();
    if (ps) {
      ps.weaponSlot = slot;
      syncSoldierWeaponAmmo(ps);
    }
    safeCall(DF.Viewmodel, 'equip', slot, faction);
    Game.equipTimer = 0.25;
  }

  function syncSoldierWeaponAmmo(soldier) {
    if (!soldier) return;
    const ws = Game.weaponStates[soldier.weaponSlot || 0];
    if (!ws) return;
    soldier.magAmmo = ws.mag;
    soldier.reserveAmmo = ws.reserve;
    soldier.reloading = ws.reloading;
    soldier.reloadTimer = ws.reloadTimer;
  }

  function getPlayerSoldier() {
    if (!DF.AI) return null;
    if (typeof DF.AI.getPlayerSoldier === 'function') {
      return DF.AI.getPlayerSoldier();
    }
    if (typeof DF.AI.getSoldiers === 'function') {
      const all = DF.AI.getSoldiers();
      for (let i = 0; i < all.length; i++) {
        if (all[i].isPlayer) return all[i];
      }
    }
    return null;
  }

  function getActiveWeaponState() {
    const ps = getPlayerSoldier();
    const slot = ps ? clamp(ps.weaponSlot || 0, 0, 5) : 0;
    return Game.weaponStates[slot] || Game.weaponStates[0];
  }

  function switchWeaponSlot(slot) {
    if (Game.controlMode !== 'infantry') return;
    const ps = getPlayerSoldier();
    if (!ps || ps.state !== 'alive') return;
    const nextSlot = clamp(slot, 0, 5);
    if (ps.weaponSlot === nextSlot && Game.equipTimer <= 0) return;

    // Cancel any ongoing reload cleanly
    const prevWs = Game.weaponStates[ps.weaponSlot || 0];
    if (prevWs && prevWs.reloading) {
      prevWs.reloading = false;
      prevWs.reloadTimer = 0;
      safeCall(DF.Viewmodel, 'cancelReload');
    }

    ps.weaponSlot = nextSlot;
    Game.isAds = false;
    Game.burstRemaining = 0;
    Game.equipTimer = 0.32;
    syncSoldierWeaponAmmo(ps);
    safeCall(DF.Viewmodel, 'equip', nextSlot, ps.faction || Game.playerFaction);
    safeCall(DF.Audio, 'playReloadFoley', 'equip', ps.pos);
  }

  function startReload() {
    if (Game.controlMode !== 'infantry') return;
    const ps = getPlayerSoldier();
    if (!ps || ps.state !== 'alive') return;
    const ws = getActiveWeaponState();
    if (!ws || ws.reloading) return;
    if (ws.mag >= ws.magSize || ws.reserve <= 0) return;

    const spec = getWeaponSpec(ws.slot, ps.faction || Game.playerFaction);
    const isEmpty = ws.mag === 0;
    ws.reloading = true;
    ws.reloadIsEmpty = isEmpty;
    if (ws.shellByShell) {
      ws.reloadDuration = (spec.reloadTacticalTime || 0.55);
      ws.shellTimer = 0.45;
      ws.reloadTimer = ws.reloadDuration;
    } else {
      ws.reloadDuration = isEmpty
        ? (spec.reloadEmptyTime || 2.6)
        : (spec.reloadTacticalTime || 2.0);
      ws.reloadTimer = ws.reloadDuration;
    }
    Game.isAds = false;
    Game.burstRemaining = 0;
    syncSoldierWeaponAmmo(ps);
    safeCall(DF.Viewmodel, 'triggerReload', isEmpty, spec);
  }

  function cycleFireMode() {
    if (Game.controlMode !== 'infantry') return;
    const ps = getPlayerSoldier();
    if (!ps || ps.state !== 'alive') return;
    const ws = getActiveWeaponState();
    if (!ws) return;
    const spec = getWeaponSpec(ws.slot, ps.faction || Game.playerFaction);
    const modes = spec.fireModes || ['auto'];
    if (modes.length <= 1) return;
    ws.fireModeIdx = (ws.fireModeIdx + 1) % modes.length;
    safeCall(DF.Audio, 'playReloadFoley', 'equip', ps.pos);
    safeCall(DF.UI, 'showNotification', `${spec.displayName || spec.name} // ${modes[ws.fireModeIdx].toUpperCase()}`, 'info');
  }

  /* ------------------------------------------------------------------
   * Weapon Firing Logic
   * ------------------------------------------------------------------ */
  function firePlayerInfantryWeapon(ps, ws, spec) {
    if (ws.mag <= 0) {
      safeCall(DF.Audio, 'playReloadFoley', 'dry_fire', ps.pos);
      if (ws.reserve > 0) startReload();
      return false;
    }

    const rpm = spec.rpm || 650;
    ws.cooldown = 60 / rpm;
    ws.mag = Math.max(0, ws.mag - 1);
    ps.fireCooldown = ws.cooldown;
    syncSoldierWeaponAmmo(ps);

    // Eye origin and forward aim vector
    const origin = [ps.pos[0], ps.pos[1] + Game.eyeHeight, ps.pos[2]];
    const fwd = forwardFromYawPitch(ps.yaw, ps.pitch);

    // Spread calculation (hip vs ADS, movement, crouch, suppression)
    const hSpeed = Math.hypot(ps.vel[0] || 0, ps.vel[2] || 0);
    const baseSpread = lerp(spec.spreadHip || 0.025, spec.spreadAds || 0.003, Game.adsBlend);
    const moveSpread = (hSpeed / SPRINT_SPEED) * (Game.adsBlend > 0.6 ? 0.006 : 0.022);
    const crouchMult = ps.crouching ? 0.72 : 1.0;
    const suppSpread = (ps.suppression || 0) * 0.018;
    const totalSpread = (baseSpread + moveSpread + suppSpread) * crouchMult;

    // Slight spread jitter applied to center ray (shotguns handle pellets inside Ballistics)
    const sx = (Math.random() - 0.5) * 2 * totalSpread;
    const sy = (Math.random() - 0.5) * 2 * totalSpread;
    const right = rightFromYaw(ps.yaw);
    const up = [
      Math.sin(ps.yaw) * Math.sin(ps.pitch),
      Math.cos(ps.pitch),
      Math.cos(ps.yaw) * Math.sin(ps.pitch),
    ];
    const dir = normalize3([
      fwd[0] + right[0] * sx + up[0] * sy,
      fwd[1] + right[1] * sx + up[1] * sy,
      fwd[2] + right[2] * sx + up[2] * sy,
    ]);

    // Trigger ballistics projectile(s)
    safeCall(DF.Ballistics, 'fireWeapon', ps, spec, origin, dir, true);

    // Viewmodel recoil & shell ejection
    safeCall(DF.Viewmodel, 'triggerFire', spec);

    // Audio
    safeCall(DF.Audio, 'playGunshot', spec.audioProfile || 'ar_556', origin, true);

    // Recoil kick
    const adsRecoilMult = lerp(1.0, 0.62, Game.adsBlend) * (ps.crouching ? 0.8 : 1.0);
    const rPitch = (spec.recoilPitch || 0.018) * adsRecoilMult;
    const rYaw = ((Math.random() - 0.48) * 2 * (spec.recoilYaw || 0.009)) * adsRecoilMult;
    Game.recoilPitchVel += rPitch * 11.5;
    Game.recoilYawVel += rYaw * 10.0;
    ps.pitch = clamp(ps.pitch + rPitch * 0.45, -1.46, 1.46);
    ps.yaw += rYaw * 0.38;

    // Camera punch & muzzle flash light
    const isHeavy = ws.slot === 5 || ws.slot === 4 || ws.slot === 2 || ws.slot === 3;
    Game.shakeTrauma = clamp(Game.shakeTrauma + (isHeavy ? 0.24 : 0.075), 0, 1);
    Game.postFX.muzzleExposure = clamp(Game.postFX.muzzleExposure + (isHeavy ? 0.35 : 0.14), 0, 0.6);
    Game.combatIntensity = clamp(Game.combatIntensity + 0.05, 0, 1);
    Game.stats.shotsFired++;

    const muzzlePos = [
      origin[0] + fwd[0] * 0.75 + right[0] * (Game.adsBlend > 0.6 ? 0 : 0.16),
      origin[1] + fwd[1] * 0.75 - 0.1,
      origin[2] + fwd[2] * 0.75 + right[2] * (Game.adsBlend > 0.6 ? 0 : 0.16),
    ];
    Game.addFlashLight(muzzlePos, [1.0, 0.78, 0.42], isHeavy ? 11 : 6, isHeavy ? 14 : 9, 0.07);

    // Auto-reload on empty for single-shot launchers/RPG after short delay
    if (ws.mag === 0 && ws.reserve > 0 && (ws.slot === 4 || ws.slot === 5)) {
      startReload();
    }
    return true;
  }

  function throwPlayerGrenade(type) {
    if (Game.controlMode !== 'infantry') return;
    if (Game.grenadeCooldown > 0) return;
    const ps = getPlayerSoldier();
    if (!ps || ps.state !== 'alive') return;
    if (type === 'frag') {
      if (Game.fragCount <= 0) {
        safeCall(DF.UI, 'showNotification', '破片手雷已耗尽', 'warn');
        return;
      }
      Game.fragCount--;
    } else {
      if (Game.smokeCount <= 0) {
        safeCall(DF.UI, 'showNotification', '烟雾弹已耗尽', 'warn');
        return;
      }
      Game.smokeCount--;
    }
    Game.grenadeCooldown = 0.85;
    const origin = [ps.pos[0], ps.pos[1] + Game.eyeHeight - 0.1, ps.pos[2]];
    const fwd = forwardFromYawPitch(ps.yaw, clamp(ps.pitch + 0.12, -1.3, 1.35));
    safeCall(DF.Ballistics, 'throwGrenade', ps, type, origin, fwd);
    safeCall(DF.Audio, 'playReloadFoley', 'equip', origin);
    safeCall(DF.UI, 'showNotification', type === 'frag' ? '投掷破片手雷' : '投掷战术烟雾弹', 'info');
  }

  /* ------------------------------------------------------------------
   * Context Interactions (Vehicle / Revive / Ammo Crate)
   * ------------------------------------------------------------------ */
  function findNearestDownedAlly(pos, faction, maxDist) {
    if (!DF.AI || typeof DF.AI.getSoldiers !== 'function') return null;
    const all = DF.AI.getSoldiers();
    let best = null;
    let bestD = maxDist;
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      if (s.faction === faction && !s.isPlayer && s.state === 'downed') {
        const d = dist3(pos, s.pos);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
    }
    return best;
  }

  function findNearestAmmoCrate(pos, maxDist) {
    if (!DF.Map || typeof DF.Map.getAmmoCrates !== 'function') return null;
    const crates = DF.Map.getAmmoCrates() || [];
    let best = null;
    let bestD = maxDist;
    for (let i = 0; i < crates.length; i++) {
      const c = crates[i];
      const d = dist3(pos, c.pos);
      if (d < Math.min(bestD, (c.radius || 2.8) + 0.8)) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  function updateContextInteract(dt) {
    Game.interactPrompt = '';
    Game.interactAction = null;

    if (Game.controlMode === 'vehicle' && Game.activeVehicle) {
      Game.interactPrompt = `[E] 离开 ${Game.activeVehicle.name || '装甲载具'}  |  [C] 视角  |  [T] 热成像  |  [X] 烟幕`;
      Game.interactAction = { type: 'exit_vehicle' };
      return;
    }

    if (Game.controlMode !== 'infantry') return;
    const ps = getPlayerSoldier();
    if (!ps || ps.state !== 'alive') return;

    // 1. Check downed ally
    const downedAlly = findNearestDownedAlly(ps.pos, ps.faction, 3.0);
    if (downedAlly) {
      Game.interactPrompt = `[长按 E] 急救队友 ${downedAlly.name || ''}`;
      Game.interactAction = { type: 'revive', target: downedAlly };
      if (Game.keys.KeyE) {
        if (Game.reviveChannelTarget !== downedAlly) {
          Game.reviveChannelTarget = downedAlly;
          Game.reviveChannelTimer = 0;
        }
        Game.reviveChannelTimer += dt;
        downedAlly.reviveProgress = clamp(Game.reviveChannelTimer / 2.2, 0, 1);
        if (Game.reviveChannelTimer >= 2.2) {
          safeCall(DF.AI, 'reviveSoldier', downedAlly, ps);
          Game.stats.alliesRevived++;
          Game.reviveChannelTarget = null;
          Game.reviveChannelTimer = 0;
          safeCall(DF.Audio, 'playRadioCue', 'revive');
          safeCall(DF.UI, 'showNotification', `已成功救起队友 ${downedAlly.name || ''}`, 'success');
        }
      } else {
        Game.reviveChannelTarget = null;
        Game.reviveChannelTimer = 0;
      }
      return;
    } else {
      Game.reviveChannelTarget = null;
      Game.reviveChannelTimer = 0;
    }

    // 2. Check nearest enterable friendly/empty vehicle
    const veh = DF.Armor && typeof DF.Armor.getNearestInteractable === 'function'
      ? DF.Armor.getNearestInteractable(ps.pos, ps.faction)
      : null;
    if (veh) {
      Game.interactPrompt = `[E] 登车驾驶 ${veh.displayName || veh.name || veh.type || '装甲车'}`;
      Game.interactAction = { type: 'enter_vehicle', vehicle: veh };
      return;
    }

    // 3. Check ammo crate
    const crate = findNearestAmmoCrate(ps.pos, 3.4);
    if (crate) {
      Game.interactPrompt = '[E] 补充弹药与手雷';
      Game.interactAction = { type: 'resupply', crate };
      return;
    }

    // 4. Check vaultable large window ahead
    if (!Game.vault) {
      const vw = findVaultableWindow(ps);
      if (vw) {
        Game.interactPrompt = '[W + SPACE] 翻越窗口';
        Game.interactAction = null;
      }
    }
  }

  /* ------------------------------------------------------------------
   * Large Window Vault / Mantle System (W + Space facing a large window)
   * ------------------------------------------------------------------ */
  function findVaultableWindow(ps) {
    if (!ps || ps.state !== 'alive' || Game.controlMode !== 'infantry') return null;
    if (!DF.Map || typeof DF.Map.getVaultWindows !== 'function') return null;
    const wins = DF.Map.getVaultWindows();
    if (!wins || wins.length === 0) return null;

    const lookX = -Math.sin(ps.yaw);
    const lookZ = -Math.cos(ps.yaw);
    let best = null;
    let bestScore = 1e9;

    for (let i = 0; i < wins.length; i++) {
      const w = wins[i];
      if (!w || w.winW < 1.15 || w.winH < 1.15) continue;

      // Vertical reachability: sill must be at waist-to-chest height above player feet
      const sillDelta = w.sillY - ps.pos[1];
      if (sillDelta < 0.30 || sillDelta > 1.58) continue;

      const rx = ps.pos[0] - w.cx;
      const rz = ps.pos[2] - w.cz;
      const signedPerp = rx * w.nx + rz * w.nz;
      const absPerp = Math.abs(signedPerp);
      if (absPerp < 0.16 || absPerp > 1.85) continue;

      // Lateral alignment inside the large window aperture
      const lat = rx * w.tx + rz * w.tz;
      const maxLat = Math.max(0.32, w.winW * 0.5 - 0.22);
      if (Math.abs(lat) > maxLat) continue;

      // Must be facing toward the window opening
      const sideSign = signedPerp >= 0 ? 1 : -1;
      const crossX = -w.nx * sideSign;
      const crossZ = -w.nz * sideSign;
      const faceDot = lookX * crossX + lookZ * crossZ;
      if (faceDot < 0.52) continue;

      // Clamp lateral path safely inside the window jambs for zero mullion clipping
      const safeHalfW = Math.max(0.10, w.winW * 0.5 - PLAYER_RADIUS - 0.08);
      const clampedLat = clamp(lat, -safeHalfW, safeHalfW);
      const midX = w.cx + w.tx * clampedLat;
      const midZ = w.cz + w.tz * clampedLat;
      const exitDist = w.wallThick * 0.5 + PLAYER_RADIUS + 0.52;
      const endX = midX + crossX * exitDist;
      const endZ = midZ + crossZ * exitDist;

      // Verify exit side isn't blocked by an interior solid wall or tall shelf/cabinet
      if (DF.Physics && typeof DF.Physics.raycast === 'function') {
        const ignoreIds = w.glassId ? ['dest_col_' + w.glassId] : null;
        const probeOrig = [midX - crossX * 0.15, w.sillY + 0.52, midZ - crossZ * 0.15];
        const probeHit = DF.Physics.raycast(probeOrig, [crossX, 0, crossZ], exitDist + 0.30, {
          forBullets: false,
          checkEntities: false,
          checkVehicles: true,
          ignoreIds
        });
        if (probeHit && probeHit.dist < exitDist + 0.12) continue;
      }

      // Compute landing ground elevation on far side
      const destGroundY = DF.Physics && typeof DF.Physics.getGroundY === 'function'
        ? DF.Physics.getGroundY(endX, endZ, w.sillY + 0.18)
        : 0;

      // Ensure landing spot isn't higher than the sill + 0.15 (would be blocked by tall object)
      if (destGroundY > w.sillY + 0.15) continue;

      const score = absPerp + Math.abs(lat) * 0.45 - faceDot * 0.6;
      if (score < bestScore) {
        bestScore = score;
        best = {
          win: w,
          crossX,
          crossZ,
          midX,
          midZ,
          endX,
          endZ,
          destGroundY,
          isHighDrop: destGroundY < w.yBase - 0.65
        };
      }
    }
    return best;
  }

  function startWindowVault(ps, vw) {
    if (!ps || !vw) return;
    const w = vw.win;
    ps.crouching = false;
    ps.grounded = false;
    Game.isAds = false;
    Game.isSprinting = false;
    Game.burstRemaining = 0;

    // Apex foot height clears sill cleanly while tucked eye height stays ~0.40m below top lintel!
    const apexY = Math.min(w.lintelY - 1.18, w.sillY + 0.14);
    const landY = vw.isHighDrop ? Math.max(vw.destGroundY, w.sillY - 0.30) : vw.destGroundY;

    Game.vault = {
      win: w,
      t: 0,
      duration: 0.54,
      startPos: [ps.pos[0], ps.pos[1], ps.pos[2]],
      midPos: [vw.midX, apexY, vw.midZ],
      endPos: [vw.endX, landY, vw.endZ],
      crossX: vw.crossX,
      crossZ: vw.crossZ,
      destGroundY: vw.destGroundY,
      isHighDrop: vw.isHighDrop,
      glassBroken: false,
      sillSoundPlayed: false
    };
    Game.vaultCooldown = 0.22;
    Game.jumpConsumedByVault = true;

    // Tactile mantle initiation audio & subtle camera kick
    safeCall(DF.Audio, 'playFootstep', detectFootstepSurface(ps.pos), true);
    safeCall(DF.Audio, 'playReloadFoley', 'equip', ps.pos);
    Game.shakeTrauma = clamp(Game.shakeTrauma + 0.06, 0, 1);
  }

  function updateWindowVault(ps, ws, spec, dt) {
    const v = Game.vault;
    if (!v || !ps || ps.state !== 'alive') {
      Game.vault = null;
      return;
    }

    // Keep mouse look responsive during vault so player can scan the room while climbing in!
    const sens = 0.0022 * Game.settings.sensitivity;
    const dx = Game.mouseDeltaX;
    const dy = Game.mouseDeltaY;
    Game.mouseDeltaX = 0;
    Game.mouseDeltaY = 0;
    ps.yaw -= dx * sens;
    const ySign = Game.settings.invertY ? 1 : -1;
    ps.pitch = clamp(ps.pitch + dy * sens * ySign, -1.35, 1.35);

    Game.recoilPitch = damp(Game.recoilPitch, 0, 10, dt);
    Game.recoilYaw = damp(Game.recoilYaw, 0, 10, dt);
    Game.swayX = damp(Game.swayX, clamp(-dx * 0.0014, -0.04, 0.04), 12, dt);
    Game.swayY = damp(Game.swayY, clamp(-dy * 0.0014, -0.04, 0.04), 12, dt);

    v.t += dt / v.duration;
    const p = clamp(v.t, 0, 1);

    // Auto-shatter intact window glass as the hand/body reaches the pane!
    if (!v.glassBroken && p >= 0.20) {
      v.glassBroken = true;
      if (v.win.glassId && DF.Destruction && typeof DF.Destruction.getPiece === 'function') {
        const gp = DF.Destruction.getPiece(v.win.glassId);
        if (gp && !gp.collapsed) {
          DF.Destruction.damagePiece(
            v.win.glassId,
            999,
            [v.midPos[0], v.win.sillY + 0.72, v.midPos[2]],
            [v.crossX, 0.12, v.crossZ],
            false,
            ps
          );
          safeCall(DF.Audio, 'playImpact', 'glass', [v.midPos[0], v.win.sillY + 0.72, v.midPos[2]]);
          Game.shakeTrauma = clamp(Game.shakeTrauma + 0.14, 0, 1);
        }
      } else if (v.win.glassId && DF.Destruction && typeof DF.Destruction.damagePiece === 'function') {
        const hitOk = DF.Destruction.damagePiece(
          v.win.glassId,
          999,
          [v.midPos[0], v.win.sillY + 0.72, v.midPos[2]],
          [v.crossX, 0.12, v.crossZ],
          false,
          ps
        );
        if (hitOk) {
          safeCall(DF.Audio, 'playImpact', 'glass', [v.midPos[0], v.win.sillY + 0.72, v.midPos[2]]);
          Game.shakeTrauma = clamp(Game.shakeTrauma + 0.14, 0, 1);
        }
      }
    }

    // Mid-sill scuff foley as boots clear the concrete ledge
    if (!v.sillSoundPlayed && p >= 0.44) {
      v.sillSoundPlayed = true;
      safeCall(DF.Audio, 'playFootstep', 'concrete', false);
    }

    // Smooth 2-segment Bezier-like 3D path (approach -> clear sill -> land on far side)
    const smoothP = p * p * (3 - 2 * p);
    const inv = 1 - smoothP;
    // Quadratic Bezier for XZ glides continuously through midPos without stalling
    const px = inv * inv * v.startPos[0] + 2 * inv * smoothP * v.midPos[0] + smoothP * smoothP * v.endPos[0];
    const pz = inv * inv * v.startPos[2] + 2 * inv * smoothP * v.midPos[2] + smoothP * smoothP * v.endPos[2];

    // Vertical arc: fast heave up onto sill (0..0.44), hold clearance (0.44..0.62), smooth drop (0.62..1.0)
    let py;
    if (p < 0.44) {
      const u = p / 0.44;
      const easeOut = 1 - (1 - u) * (1 - u);
      py = lerp(v.startPos[1], v.midPos[1], easeOut);
    } else if (p < 0.62) {
      const u = (p - 0.44) / 0.18;
      py = v.midPos[1] + Math.sin(u * Math.PI) * 0.06;
    } else {
      const u = (p - 0.62) / 0.38;
      const easeIn = u * u * (2.2 - 1.2 * u);
      py = lerp(v.midPos[1], v.endPos[1], clamp(easeIn, 0, 1));
    }

    ps.pos[0] = px;
    ps.pos[1] = py;
    ps.pos[2] = pz;
    ps.vel[0] = v.crossX * 3.2;
    ps.vel[1] = 0;
    ps.vel[2] = v.crossZ * 3.2;
    ps.grounded = false;

    // Tuck eye height cleanly under the top window lintel while crossing sill, then restore standing height!
    const tuckEnv = Math.sin(p * Math.PI);
    const targetVaultEye = lerp(STAND_EYE, 0.96, tuckEnv);
    Game.eyeHeight = damp(Game.eyeHeight, targetVaultEye, 26, dt);

    // Visceral Battlefield camera tilt: roll right on left-hand sill plant, counter-roll left as legs swing across!
    const camRollVault = p < 0.48
      ? Math.sin((p / 0.48) * Math.PI) * 0.105
      : -Math.sin(((p - 0.48) / 0.52) * Math.PI) * 0.068;
    const camPitchVault = -Math.sin(p * Math.PI) * 0.075 + (p > 0.72 ? -Math.sin(((p - 0.72) / 0.28) * Math.PI) * 0.045 : 0);

    Game.adsBlend = damp(Game.adsBlend, 0, 18, dt);
    Game.sprintBlend = damp(Game.sprintBlend, 0, 14, dt);
    Game.currentFov = Game.settings.baseFov + Math.sin(p * Math.PI) * 4.0;
    Game.visionMode = 'normal';

    if (Game.equipTimer > 0) Game.equipTimer = Math.max(0, Game.equipTimer - dt);
    if (Game.grenadeCooldown > 0) Game.grenadeCooldown = Math.max(0, Game.grenadeCooldown - dt);
    if (ws && ws.cooldown > 0) ws.cooldown = Math.max(0, ws.cooldown - dt);

    // Update Viewmodel with live vaultProgress (left hand plants on sill, gun tucks right!)
    safeCall(DF.Viewmodel, 'setADS', false);
    safeCall(DF.Viewmodel, 'setSprint', false);
    safeCall(DF.Viewmodel, 'setMoveState', 2.2, false, Game.swayX, Game.swayY);
    safeCall(DF.Viewmodel, 'update', dt, {
      adsBlend: 0,
      sprinting: false,
      sprintBlend: 0,
      vaultProgress: p,
      speed: 2.2,
      grounded: false,
      reloading: ws ? ws.reloading : false,
      reloadProgress: ws && ws.reloading ? clamp(1 - ws.reloadTimer / Math.max(0.01, ws.reloadDuration), 0, 1) : 0,
      reloadIsEmpty: ws ? ws.reloadIsEmpty : false,
      mag: ws ? ws.mag : 0,
      faction: ps.faction || Game.playerFaction,
      slot: ws ? ws.slot : 0,
      swayX: Game.swayX,
      swayY: Game.swayY,
    });

    Game.camera.pos = [ps.pos[0], ps.pos[1] + Game.eyeHeight, ps.pos[2]];
    Game.camera.yaw = ps.yaw;
    Game.camera.pitch = clamp(ps.pitch + camPitchVault, -1.48, 1.48);
    Game.camera.roll = camRollVault;
    Game.camera.fov = Game.currentFov;

    Game.interactPrompt = '';
    Game.interactAction = null;

    // Complete vault & hand smoothly back to grounded/falling infantry physics
    if (v.t >= 1.0) {
      ps.pos[0] = v.endPos[0];
      ps.pos[1] = v.endPos[1];
      ps.pos[2] = v.endPos[2];
      if (v.isHighDrop) {
        // Dropping out of a 2nd-floor window: preserve forward momentum & fall naturally
        ps.vel[0] = v.crossX * 2.9;
        ps.vel[1] = -2.0;
        ps.vel[2] = v.crossZ * 2.9;
        ps.grounded = false;
      } else {
        ps.vel[0] = v.crossX * 2.6;
        ps.vel[1] = 0;
        ps.vel[2] = v.crossZ * 2.6;
        ps.grounded = true;
        safeCall(DF.Audio, 'playFootstep', detectFootstepSurface(ps.pos), true);
        Game.shakeTrauma = clamp(Game.shakeTrauma + 0.08, 0, 1);
      }
      Game.vault = null;
      Game.vaultCooldown = 0.28;
      Game.jumpConsumedByVault = true;
    }
  }

  function triggerInteractPress() {
    if (Game.controlMode === 'vehicle' && Game.activeVehicle) {
      exitCurrentVehicle();
      return;
    }
    if (!Game.interactAction) return;
    const ps = getPlayerSoldier();
    if (!ps || ps.state !== 'alive') return;

    if (Game.interactAction.type === 'enter_vehicle') {
      enterVehicle(Game.interactAction.vehicle);
    } else if (Game.interactAction.type === 'resupply') {
      for (let i = 0; i < Game.weaponStates.length; i++) {
        const ws = Game.weaponStates[i];
        ws.reserve = ws.reserveMax;
        if (ws.mag === 0) ws.mag = ws.magSize;
      }
      Game.fragCount = 2;
      Game.smokeCount = 2;
      ps.hp = Math.min(ps.maxHp || 100, (ps.hp || 100) + 35);
      syncSoldierWeaponAmmo(ps);
      safeCall(DF.Audio, 'playReloadFoley', 'mag_in', ps.pos);
      safeCall(DF.UI, 'showNotification', '弹药、手雷与急救包已补满', 'success');
    }
  }

  function enterVehicle(vehicle) {
    const ps = getPlayerSoldier();
    if (!ps || ps.state !== 'alive') return false;
    if (!vehicle || vehicle.destroyed || vehicle.alive === false || (vehicle.hp != null && vehicle.hp <= 0)) return false;
    if (DF.Armor && typeof DF.Armor.enterVehicle === 'function') {
      const ok = DF.Armor.enterVehicle(vehicle, ps, true);
      if (ok === false) return false;
    }
    Game.activeVehicle = vehicle;
    Game.controlMode = 'vehicle';
    Game.vault = null;
    Game.vehicleCamMode = 0;
    Game.visionMode = 'normal';
    Game.isAds = false;
    ps.inVehicleId = vehicle.id;
    safeCall(DF.Audio, 'playReloadFoley', 'equip', vehicle.pos);
    safeCall(DF.UI, 'showNotification', `已进入 ${vehicle.displayName || vehicle.name || '装甲载具'}`, 'info');
    return true;
  }

  function exitCurrentVehicle() {
    const ps = getPlayerSoldier();
    if (!Game.activeVehicle) {
      Game.controlMode = 'infantry';
      Game.visionMode = 'normal';
      return;
    }
    const veh = Game.activeVehicle;
    if (DF.Armor && typeof DF.Armor.exitVehicle === 'function') {
      DF.Armor.exitVehicle(veh, ps);
    } else if (ps && veh.pos) {
      ps.pos[0] = veh.pos[0] + Math.cos(veh.yaw || 0) * 3.4;
      ps.pos[2] = veh.pos[2] - Math.sin(veh.yaw || 0) * 3.4;
      ps.pos[1] = DF.Physics ? DF.Physics.getGroundY(ps.pos[0], ps.pos[2], veh.pos[1] + 2) : 0;
    }
    if (ps) {
      ps.inVehicleId = null;
      ps.vel = [0, 0, 0];
    }
    Game.activeVehicle = null;
    Game.controlMode = ps && ps.state === 'downed' ? 'downed' : ps && ps.state === 'dead' ? 'dead' : 'infantry';
    Game.visionMode = 'normal';
    Game.vehicleCamMode = 0;
    safeCall(DF.Audio, 'playReloadFoley', 'equip', ps ? ps.pos : veh.pos);
  }

  /* ------------------------------------------------------------------
   * Unmanned Drone ('7') & Robot Dog ('8') Takeover
   * ------------------------------------------------------------------ */
  function toggleUnmannedControl(type) {
    if (Game.phase !== 'playing') return;
    const ps = getPlayerSoldier();
    if (!ps || ps.state !== 'alive') return;

    if (Game.controlMode === type) {
      safeCall(DF.Unmanned, 'releaseControl', type);
      Game.controlMode = Game.activeVehicle ? 'vehicle' : (ps.state === 'downed' ? 'downed' : 'infantry');
      Game.visionMode = 'normal';
      safeCall(DF.Audio, 'playRadioCue', 'ack');
      safeCall(DF.UI, 'showNotification', type === 'drone' ? '已退出无人机遥控，切换回步兵视角' : '已退出机器狗遥控，切换回步兵视角', 'info');
      return;
    }

    // Release any other unmanned unit first
    if (Game.controlMode === 'drone' || Game.controlMode === 'dog') {
      safeCall(DF.Unmanned, 'releaseControl');
    }

    if (!DF.Unmanned || typeof DF.Unmanned.takeOver !== 'function') return;
    const unit = DF.Unmanned.takeOver(type, ps.faction || Game.playerFaction);
    if (!unit) {
      safeCall(DF.UI, 'showNotification', type === 'drone' ? '友方无人机正在重构冷却中' : '友方武装机器狗正在重构冷却中', 'warn');
      return;
    }
    Game.controlMode = type;
    Game.isAds = false;
    Game.vault = null;
    Game.visionMode = 'normal';
    Game.interactPrompt = '';
    Game.interactAction = null;
    safeCall(DF.Audio, 'playRadioCue', 'drone');
    safeCall(DF.UI, 'showNotification', type === 'drone'
      ? '接管侦察/打击无人机 [WASD飞行 Space升 Shift降 LMB投弹 F自杀俯冲 T热成像 7退出]'
      : '接管武装机器狗 [WASD冲刺 Space跳跃 LMB机枪射击 T热成像 8退出]', 'success');
  }

  function toggleThermalVision() {
    if (Game.controlMode === 'vehicle') {
      if (Game.visionMode === 'thermal_white') {
        Game.visionMode = 'thermal_green';
        Game.vehicleCamMode = 2;
      } else if (Game.visionMode === 'thermal_green') {
        Game.visionMode = 'normal';
        Game.vehicleCamMode = 1;
      } else {
        Game.visionMode = 'thermal_white';
        Game.vehicleCamMode = 2;
      }
      if (Game.activeVehicle) {
        Game.activeVehicle.camMode = Game.vehicleCamMode;
        Game.activeVehicle.thermalMode = Game.visionMode !== 'normal';
      }
      safeCall(DF.Audio, 'playRadioCue', 'ack');
      return;
    }
    if (Game.controlMode === 'drone' || Game.controlMode === 'dog') {
      if (Game.visionMode === 'normal') Game.visionMode = 'thermal_white';
      else if (Game.visionMode === 'thermal_white') Game.visionMode = 'thermal_green';
      else Game.visionMode = 'normal';
      const u = safeCall(DF.Unmanned, 'getControlledUnit');
      if (u) u.thermalMode = Game.visionMode !== 'normal';
      safeCall(DF.Audio, 'playRadioCue', 'ack');
    }
  }

  /* ------------------------------------------------------------------
   * Tactical Spotting & Squad Orders (Q / F1-F6 / Map Click)
   * ------------------------------------------------------------------ */
  function getCrosshairWorldTarget() {
    const camPos = Game.camera.pos;
    const dir = forwardFromYawPitch(Game.camera.yaw, Game.camera.pitch);
    const ps = getPlayerSoldier();
    const hit = DF.Physics && typeof DF.Physics.raycast === 'function'
      ? DF.Physics.raycast(camPos, dir, 140, {
          ignoreIds: ps ? [ps.id] : [],
          checkEntities: true,
          checkVehicles: true,
        })
      : null;
    if (hit && hit.point) {
      return { pos: hit.point, entity: hit.entity || hit.vehicle || null };
    }
    // Fallback to ground plane intersection
    if (dir[1] < -0.02) {
      const t = clamp(-camPos[1] / dir[1], 4, 110);
      return {
        pos: [
          clamp(camPos[0] + dir[0] * t, -86, 86),
          0,
          clamp(camPos[2] + dir[2] * t, -52, 52),
        ],
        entity: null,
      };
    }
    return {
      pos: [
        clamp(camPos[0] + dir[0] * 35, -86, 86),
        0,
        clamp(camPos[2] + dir[2] * 35, -52, 52),
      ],
      entity: null,
    };
  }

  Game.spotUnderCrosshair = function () {
    const target = getCrosshairWorldTarget();
    const count = safeCall(DF.AI, 'spotTarget', target.pos, Game.playerFaction);
    safeCall(DF.Audio, 'playRadioCue', 'spot');
    safeCall(DF.UI, 'showNotification', count > 0 ? `已标记 ${count} 个敌方目标，呼叫集火` : '已标记目标区域', 'info');
  };

  Game.issueOrder = function (order, explicitPos, explicitEntity) {
    const ps = getPlayerSoldier();
    const faction = (ps && ps.faction) || Game.playerFaction;
    let pos = explicitPos;
    let entity = explicitEntity || null;
    if (!pos) {
      if (order === 'follow' || order === 'revive') {
        pos = ps ? [ps.pos[0], ps.pos[1], ps.pos[2]] : [0, 0, 0];
      } else {
        const target = getCrosshairWorldTarget();
        pos = target.pos;
        entity = target.entity;
      }
    }
    safeCall(DF.AI, 'issueSquadOrder', faction, order, pos, entity);
    if (DF.Unmanned && typeof DF.Unmanned.issueOrder === 'function') {
      DF.Unmanned.issueOrder(faction, 'drone', order, pos);
      DF.Unmanned.issueOrder(faction, 'dog', order, pos);
    }
    safeCall(DF.Audio, 'playRadioCue', 'order');
    safeCall(DF.UI, 'showNotification', `小队指令: ${ORDER_LABELS[order] || order}`, 'info');
  };

  /* ------------------------------------------------------------------
   * Unified Combat Damage Bus
   * ------------------------------------------------------------------ */
  Game.applyBulletHit = function (hitOrEntity, dmgArg, hitZoneArg, attackerArg, weaponIdArg, hitPointArg, hitNormalArg, materialArg) {
    // Normalize both object-based and positional invocation
    let info;
    if (hitOrEntity && typeof hitOrEntity === 'object' && ('point' in hitOrEntity || 'damage' in hitOrEntity || 'entity' in hitOrEntity || 'vehicle' in hitOrEntity || 'collider' in hitOrEntity || 'destructibleId' in hitOrEntity)) {
      info = hitOrEntity;
    } else {
      info = {
        entity: hitOrEntity,
        damage: dmgArg,
        hitZone: hitZoneArg,
        attacker: attackerArg,
        weaponId: weaponIdArg,
        point: hitPointArg,
        normal: hitNormalArg,
        material: materialArg,
      };
    }

    const damage = info.damage != null ? info.damage : 25;
    const hitZone = info.hitZone || 'torso';
    const attacker = info.attacker || null;
    const weaponId = info.weaponId || (info.weaponSpec && (info.weaponSpec.displayName || info.weaponSpec.name || info.weaponSpec.id)) || 'RIFLE';
    const point = info.point || (info.entity && info.entity.pos) || (info.vehicle && info.vehicle.pos) || [0, 1, 0];
    const normal = info.normal || [0, 1, 0];
    const dir = info.dir || [-normal[0], -normal[1], -normal[2]];
    const attackerIsPlayer = !!(attacker && (attacker.isPlayer || attacker === getPlayerSoldier() || attacker.controlledByPlayer));

    // 1. Soldier hit
    const soldier = info.soldier || (info.entity && info.entity.faction && info.entity.hp != null && !info.entity.turretYaw && !info.entity.isUnmanned ? info.entity : null);
    if (soldier) {
      const prevState = soldier.state;
      const isHead = hitZone === 'head';
      if (DF.AI && typeof DF.AI.damageSoldier === 'function') {
        DF.AI.damageSoldier(soldier, damage, hitZone, attacker, weaponId);
      } else {
        soldier.hp = Math.max(0, (soldier.hp || 100) - damage * (isHead ? 2.2 : 1.0));
        if (soldier.hp <= 0) soldier.state = 'dead';
      }

      const killed = prevState === 'alive' && (soldier.state === 'downed' || soldier.state === 'dead');

      // Blood mist VFX
      spawnImpactParticles('flesh', point, normal, isHead ? 8 : 5);
      safeCall(DF.Audio, 'playImpact', 'flesh', point);

      if (attackerIsPlayer && soldier.faction !== Game.playerFaction) {
        Game.stats.shotsHit++;
        Game.stats.damageDealt += damage;
        safeCall(DF.GameMode, 'recordDamage', damage, true);
        triggerHitmarker(killed, isHead);
        if (killed) {
          Game.stats.kills++;
          if (isHead) Game.stats.headshots++;
          safeCall(
            DF.UI,
            'addKillfeed',
            (attacker && attacker.name) || '玩家',
            weaponId,
            soldier.name || '敌军',
            Game.playerFaction,
            soldier.faction,
            isHead
          );
        }
      } else if (killed && attacker) {
        safeCall(
          DF.UI,
          'addKillfeed',
          attacker.name || (attacker.faction === 'RU' ? '红方士兵' : '蓝方士兵'),
          weaponId,
          soldier.name || '士兵',
          attacker.faction || 'RU',
          soldier.faction || 'UA',
          isHead
        );
      }

      // If player soldier got hit, trigger damage flash + directional arc + camera kick
      if (soldier.isPlayer) {
        Game.postFX.damageFlash = clamp(Game.postFX.damageFlash + clamp(damage / 55, 0.25, 0.85), 0, 1);
        Game.shakeTrauma = clamp(Game.shakeTrauma + 0.28, 0, 1);
        if (attacker && attacker.pos) {
          setDamageDirection(attacker.pos);
        }
        checkPlayerAliveTransition(soldier);
      }
      return;
    }

    // 2. Armored Vehicle hit
    const vehicle = info.vehicle || (info.entity && info.entity.turretYaw != null ? info.entity : null);
    if (vehicle) {
      const wasDestroyed = !!(vehicle.destroyed || vehicle.alive === false || vehicle.hp <= 0);
      const armorPen = info.armorPen != null ? info.armorPen : (info.weaponSpec ? info.weaponSpec.armorPen : 0.2);
      const effectiveDmg = info.vehicleDamage != null
        ? info.vehicleDamage
        : (armorPen < 0.25 && !info.isExplosive ? damage * 0.15 : damage);
      if (DF.Armor && typeof DF.Armor.damageVehicle === 'function') {
        DF.Armor.damageVehicle(vehicle, effectiveDmg, hitZone, attacker, point, info.isExplosive);
      } else if (vehicle.hp != null) {
        vehicle.hp = Math.max(0, vehicle.hp - effectiveDmg);
      }
      const nowDestroyed = !!(vehicle.destroyed || vehicle.alive === false || vehicle.hp <= 0);
      spawnImpactParticles('metal', point, normal, armorPen >= 0.4 ? 10 : 5);
      safeCall(DF.Audio, 'playImpact', 'metal', point);

      if (attackerIsPlayer && vehicle.faction !== Game.playerFaction) {
        Game.stats.shotsHit++;
        Game.stats.damageDealt += effectiveDmg;
        safeCall(DF.GameMode, 'recordDamage', effectiveDmg, true);
        triggerHitmarker(!wasDestroyed && nowDestroyed, false, true);
        if (!wasDestroyed && nowDestroyed) {
          Game.stats.vehiclesDestroyed++;
          safeCall(
            DF.UI,
            'addKillfeed',
            (attacker && attacker.name) || '玩家',
            weaponId,
            vehicle.displayName || vehicle.name || '敌方载具',
            Game.playerFaction,
            vehicle.faction,
            false
          );
        }
      }
      if (vehicle === Game.activeVehicle) {
        Game.shakeTrauma = clamp(Game.shakeTrauma + 0.35, 0, 1);
        if (attacker && attacker.pos) setDamageDirection(attacker.pos);
        if (nowDestroyed) {
          exitCurrentVehicle();
          const ps = getPlayerSoldier();
          if (ps && ps.state === 'alive') {
            safeCall(DF.AI, 'damageSoldier', ps, 55, 'torso', attacker, 'VEHICLE_COOKOFF');
            checkPlayerAliveTransition(ps);
          }
        }
      }
      return;
    }

    // 3. Unmanned unit (Drone / Robot Dog) hit
    const unmanned = info.unmanned || (info.entity && info.entity.isUnmanned ? info.entity : null);
    if (unmanned) {
      const wasAlive = !unmanned.destroyed && unmanned.hp > 0;
      safeCall(DF.Unmanned, 'damageUnit', unmanned, damage, attacker);
      spawnImpactParticles('metal', point, normal, 7);
      safeCall(DF.Audio, 'playImpact', 'metal', point);
      if (attackerIsPlayer && unmanned.faction !== Game.playerFaction) {
        triggerHitmarker(wasAlive && (unmanned.destroyed || unmanned.hp <= 0), false, true);
      }
      return;
    }

    // 4. Destructible world piece hit
    const destructibleId =
      info.destructibleId ||
      (info.collider && info.collider.meta && info.collider.meta.destructibleId) ||
      (info.collider && info.collider.destructibleId);
    if (destructibleId && DF.Destruction && typeof DF.Destruction.damagePiece === 'function') {
      DF.Destruction.damagePiece(destructibleId, damage, point, dir, !!info.isExplosive);
    }

    // 5. Static / Destructible Surface impact VFX, Decals & SFX (avoid duplicating VFX/decals already spawned by DF.Ballistics)
    const fromBallistics = !!(info.hit && info.weaponSpec);
    const mat = info.material || (info.collider && info.collider.meta && info.collider.meta.material) || 'concrete';
    if (!info.vfxSpawned && !fromBallistics) {
      spawnImpactParticles(mat, point, normal, info.isExplosive ? 8 : 5);
    }
    if (!info.decalSpawned && !fromBallistics && DF.Renderer && typeof DF.Renderer.spawnDecal === 'function') {
      const decalSize = info.isExplosive ? 0.55 : clamp(0.11 + (info.armorPen || 0.15) * 0.16, 0.10, 0.24);
      const decalType =
        mat === 'metal' ? 'bullet_metal' :
        mat === 'wood' ? 'bullet_wood' :
        mat === 'glass' ? 'bullet_glass' :
        'bullet_concrete';
      DF.Renderer.spawnDecal(point, normal, decalSize, decalType);
    }
    safeCall(DF.Audio, 'playImpact', mat, point);
  };

  Game.applyExplosion = function (posOrCfg, radiusArg, damageArg, attackerArg, weaponIdArg) {
    let cfg;
    if (posOrCfg && !Array.isArray(posOrCfg) && !(posOrCfg instanceof Float32Array) && typeof posOrCfg === 'object') {
      cfg = posOrCfg;
    } else {
      cfg = {
        pos: posOrCfg,
        radius: radiusArg,
        damage: damageArg,
        attacker: attackerArg,
        weaponId: weaponIdArg,
      };
    }
    if (!cfg || !cfg.pos) return;

    // Defer nested chain explosions by 1 step so stack never overflows
    if (Game.explosionDepth >= 2) {
      Game.pendingExplosions.push({ delay: 0.14, cfg });
      return;
    }

    Game.explosionDepth++;
    try {
      executeExplosion(cfg);
    } finally {
      Game.explosionDepth--;
    }
  };

  function executeExplosion(cfg) {
    const pos = [cfg.pos[0], cfg.pos[1], cfg.pos[2]];
    const radius = Math.max(1.5, cfg.radius || 8.0);
    const maxDmg = cfg.damage != null ? cfg.damage : 130;
    const attacker = cfg.attacker || null;
    const weaponId = cfg.weaponId || 'EXPLOSIVE';
    const scale = clamp(radius / 8.0, 0.5, 2.5);
    const attackerIsPlayer = !!(attacker && (attacker.isPlayer || attacker === getPlayerSoldier() || attacker.controlledByPlayer));

    Game.combatIntensity = clamp(Game.combatIntensity + 0.25 * scale, 0, 1);

    // 1. Destruction blast on buildings, barricades, windows, explosive cars/barrels
    if (DF.Destruction && typeof DF.Destruction.applyBlast === 'function') {
      DF.Destruction.applyBlast(pos, radius * 1.15, maxDmg * 1.25);
    }

    // 2. Blast damage to soldiers
    if (DF.AI && typeof DF.AI.getSoldiers === 'function') {
      const soldiers = DF.AI.getSoldiers();
      for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i];
        if (!s || s.state === 'dead' || s.inVehicleId) continue;
        const sCenter = [s.pos[0], s.pos[1] + 0.9, s.pos[2]];
        const d = dist3(pos, sCenter);
        if (d > radius) continue;

        let falloff = 1 - d / radius;
        falloff = falloff * falloff * 0.65 + falloff * 0.35;

        // Cover shielding check via raycast
        if (d > 1.2 && DF.Physics && typeof DF.Physics.raycast === 'function') {
          const toS = normalize3([sCenter[0] - pos[0], sCenter[1] - pos[1], sCenter[2] - pos[2]]);
          const block = DF.Physics.raycast(
            [pos[0], pos[1] + 0.35, pos[2]],
            toS,
            d - 0.5,
            { checkEntities: false, checkVehicles: false }
          );
          if (block) falloff *= 0.32;
        }

        const dmg = maxDmg * falloff;
        if (dmg < 2) continue;

        // Suppression
        s.suppression = clamp((s.suppression || 0) + falloff * 0.95, 0, 1);

        const prevState = s.state;
        if (DF.AI.damageSoldier) {
          DF.AI.damageSoldier(s, dmg, 'torso', attacker, weaponId);
        }
        const killed = prevState === 'alive' && (s.state === 'downed' || s.state === 'dead');

        if (attackerIsPlayer && s.faction !== Game.playerFaction) {
          Game.stats.damageDealt += dmg;
          triggerHitmarker(killed, false);
          if (killed) {
            Game.stats.kills++;
            safeCall(DF.UI, 'addKillfeed', (attacker && attacker.name) || '玩家', weaponId, s.name || '敌军', Game.playerFaction, s.faction);
          }
        } else if (killed && attacker) {
          safeCall(DF.UI, 'addKillfeed', attacker.name || '爆破', weaponId, s.name || '士兵', attacker.faction || 'RU', s.faction || 'UA');
        }

        if (s.isPlayer) {
          Game.postFX.damageFlash = clamp(Game.postFX.damageFlash + falloff * 0.8, 0, 1);
          Game.postFX.concussion = clamp(Game.postFX.concussion + falloff * 0.95, 0, 1);
          setDamageDirection(pos);
          checkPlayerAliveTransition(s);
        }
      }
    }

    // 3. Blast damage to Armored Vehicles
    if (DF.Armor && typeof DF.Armor.getVehicles === 'function') {
      const vehicles = DF.Armor.getVehicles() || [];
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        if (!v || v.destroyed || v.alive === false || v.hp <= 0) continue;
        const d = dist3(pos, [v.pos[0], v.pos[1] + 1.2, v.pos[2]]);
        const effRad = radius + 2.6;
        if (d > effRad) continue;
        const falloff = clamp(1 - d / effRad, 0.15, 1);
        const topHit = pos[1] > v.pos[1] + 2.2;
        const zone = topHit ? 'top' : 'side';
        const baseVDmg = cfg.vehicleDamage != null ? cfg.vehicleDamage : (maxDmg * (cfg.isAntiArmor ? 1.85 : 0.85));
        const vDmg = baseVDmg * falloff;
        const wasAlive = !v.destroyed && v.alive !== false && v.hp > 0;
        safeCall(DF.Armor, 'damageVehicle', v, vDmg, zone, attacker, pos, true);
        if (attackerIsPlayer && v.faction !== Game.playerFaction) {
          const nowDead = !!(v.destroyed || v.alive === false || v.hp <= 0);
          triggerHitmarker(wasAlive && nowDead, false, true);
          if (wasAlive && nowDead) {
            Game.stats.vehiclesDestroyed++;
            safeCall(DF.UI, 'addKillfeed', (attacker && attacker.name) || '玩家', weaponId, v.displayName || v.name || '敌方载具', Game.playerFaction, v.faction, false);
          }
        }
      }
    }

    // 4. Blast damage to Unmanned units
    if (DF.Unmanned && typeof DF.Unmanned.getUnits === 'function') {
      const units = DF.Unmanned.getUnits() || [];
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (!u || u.destroyed || u.hp <= 0) continue;
        const d = dist3(pos, u.pos);
        if (d < radius + 1.5) {
          const falloff = clamp(1 - d / (radius + 1.5), 0.2, 1);
          safeCall(DF.Unmanned, 'damageUnit', u, maxDmg * falloff, attacker);
        }
      }
    }

    // 5. Layered Explosion VFX & Persistent Scorch Decal (deduped when DF.Ballistics already emitted VFX/decal)
    if (!cfg.vfxSpawned) {
      spawnExplosionVFX(pos, scale);
    }
    if (!cfg.weaponName && !cfg.decalSpawned && DF.Renderer && typeof DF.Renderer.spawnDecal === 'function') {
      const gy = DF.Physics && typeof DF.Physics.getGroundY === 'function' ? DF.Physics.getGroundY(pos[0], pos[2], pos[1] + 1.0) : 0;
      if (Math.abs(pos[1] - gy) < radius * 0.85) {
        DF.Renderer.spawnDecal([pos[0], gy + 0.012, pos[2]], [0, 1, 0], clamp(radius * 0.44, 1.6, 4.4), 'scorch');
      }
    }

    // 6. Dynamic Explosion Light
    Game.addFlashLight([pos[0], pos[1] + 1.4, pos[2]], [1.0, 0.56, 0.18], 18 * scale, 22 * scale, 0.58);

    // 7. Camera shake / concussion based on proximity
    const camDist = dist3(pos, Game.camera.pos);
    const shakeRadius = radius * 4.5 + 16;
    if (camDist < shakeRadius) {
      const prox = Math.pow(1 - camDist / shakeRadius, 1.5);
      Game.shakeTrauma = clamp(Game.shakeTrauma + prox * 0.9 * scale, 0, 1);
      Game.postFX.concussion = clamp(Game.postFX.concussion + prox * 0.55 * scale, 0, 1);
      Game.postFX.suppression = clamp(Game.postFX.suppression + prox * 0.5, 0, 1);
    }

    // 8. Spatial Audio
    safeCall(DF.Audio, 'playExplosion', pos, scale);
  }

  function spawnImpactParticles(material, pos, normal, count) {
    if (!DF.Renderer || typeof DF.Renderer.spawnParticle !== 'function') return;
    const n = normal || [0, 1, 0];
    for (let i = 0; i < count; i++) {
      const spread = 1.6;
      const vx = n[0] * (1.8 + Math.random() * 2.8) + (Math.random() - 0.5) * spread * 2;
      const vy = n[1] * (1.8 + Math.random() * 2.8) + Math.random() * 1.6;
      const vz = n[2] * (1.8 + Math.random() * 2.8) + (Math.random() - 0.5) * spread * 2;

      if (material === 'metal') {
        DF.Renderer.spawnParticle({
          type: 'spark',
          pos: [pos[0], pos[1], pos[2]],
          vel: [vx * 2.8, vy * 2.4 + 1.2, vz * 2.8],
          size: 0.085,
          sizeEnd: 0.02,
          life: 0.22 + Math.random() * 0.28,
          color: [1.0, 0.82, 0.36],
          alpha: 1.0,
          gravity: 13.5,
          drag: 0.9,
          additive: true,
        });
      } else if (material === 'flesh') {
        DF.Renderer.spawnParticle({
          type: 'blood',
          pos: [pos[0], pos[1], pos[2]],
          vel: [vx * 0.7, vy * 0.7, vz * 0.7],
          size: 0.14,
          sizeEnd: 0.35,
          life: 0.32 + Math.random() * 0.2,
          color: [0.48, 0.05, 0.04],
          alpha: 0.85,
          gravity: 6.5,
          drag: 2.5,
          additive: false,
        });
      } else {
        const isWood = material === 'wood';
        const isBrick = material === 'brick';
        DF.Renderer.spawnParticle({
          type: i % 2 === 0 ? 'dust' : 'debris',
          pos: [pos[0], pos[1], pos[2]],
          vel: [vx, vy, vz],
          size: i % 2 === 0 ? 0.22 : 0.09,
          sizeEnd: i % 2 === 0 ? 0.85 : 0.07,
          life: i % 2 === 0 ? 0.65 + Math.random() * 0.45 : 0.45 + Math.random() * 0.3,
          color: isWood ? [0.55, 0.4, 0.26] : isBrick ? [0.62, 0.34, 0.24] : [0.64, 0.61, 0.56],
          alpha: 0.75,
          gravity: i % 2 === 0 ? -0.4 : 13.5,
          drag: i % 2 === 0 ? 2.4 : 0.6,
          additive: false,
        });
      }
    }
  }

  function spawnExplosionVFX(pos, scale) {
    if (!DF.Renderer || typeof DF.Renderer.spawnParticle !== 'function') return;
    const sp = DF.Renderer.spawnParticle.bind(DF.Renderer);

    // Core flash
    sp({
      type: 'flash',
      pos: [pos[0], pos[1] + 0.7, pos[2]],
      vel: [0, 0.5, 0],
      size: 2.2 * scale,
      sizeEnd: 6.8 * scale,
      life: 0.18,
      color: [1.0, 0.86, 0.55],
      alpha: 1.0,
      gravity: 0,
      drag: 1,
      additive: true,
    });

    // Expanding shockwave ring
    sp({
      type: 'shockwave',
      pos: [pos[0], pos[1] + 0.35, pos[2]],
      vel: [0, 0.1, 0],
      size: 1.0 * scale,
      sizeEnd: 11.5 * scale,
      life: 0.35,
      color: [0.95, 0.88, 0.78],
      alpha: 0.58,
      gravity: 0,
      drag: 0,
      additive: true,
    });

    // Fireballs
    const fireCount = Math.round(12 * scale);
    for (let i = 0; i < fireCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = (1.5 + Math.random() * 4.5) * scale;
      sp({
        type: 'fire',
        pos: [pos[0] + (Math.random() - 0.5) * scale, pos[1] + 0.5 + Math.random() * 0.8, pos[2] + (Math.random() - 0.5) * scale],
        vel: [Math.cos(a) * spd, (3.2 + Math.random() * 5.2) * scale, Math.sin(a) * spd],
        size: (1.1 + Math.random() * 0.9) * scale,
        sizeEnd: (3.2 + Math.random() * 1.4) * scale,
        life: 0.45 + Math.random() * 0.45,
        color: [1.0, 0.42 + Math.random() * 0.25, 0.08],
        alpha: 0.88,
        gravity: -2.2,
        drag: 1.9,
        additive: false,
      });
    }

    // Thick smoke & dust column
    const smokeCount = Math.round(16 * scale);
    for (let i = 0; i < smokeCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = (1.0 + Math.random() * 4.0) * scale;
      const dark = i % 3 === 0 ? 0.16 : 0.32;
      sp({
        type: 'smoke',
        pos: [pos[0] + (Math.random() - 0.5) * 1.8 * scale, pos[1] + 0.6 + Math.random() * 1.0, pos[2] + (Math.random() - 0.5) * 1.8 * scale],
        vel: [Math.cos(a) * spd, (2.2 + Math.random() * 4.8) * scale, Math.sin(a) * spd],
        size: (1.3 + Math.random() * 1.1) * scale,
        sizeEnd: (4.8 + Math.random() * 2.5) * scale,
        life: 2.8 + Math.random() * 2.6,
        color: [dark, dark * 0.96, dark * 0.92],
        alpha: 0.72,
        gravity: -0.75,
        drag: 1.25,
        rotSpeed: (Math.random() - 0.5) * 1.2,
        additive: false,
      });
    }

    // Sparks & debris chunks
    const debrisCount = Math.round(18 * scale);
    for (let i = 0; i < debrisCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = (4.0 + Math.random() * 11.0) * scale;
      const isSpark = i < debrisCount * 0.5;
      sp({
        type: isSpark ? 'spark' : 'debris',
        pos: [pos[0], pos[1] + 0.6, pos[2]],
        vel: [Math.cos(a) * spd, (4.5 + Math.random() * 9.0) * scale, Math.sin(a) * spd],
        size: isSpark ? 0.12 : 0.16 + Math.random() * 0.14,
        sizeEnd: isSpark ? 0.02 : 0.14,
        life: isSpark ? 0.55 + Math.random() * 0.55 : 0.95 + Math.random() * 0.8,
        color: isSpark ? [1.0, 0.68, 0.22] : [0.36, 0.34, 0.31],
        alpha: 0.95,
        gravity: 14.5,
        drag: 0.45,
        additive: isSpark,
      });
    }
  }

  function triggerHitmarker(isKill, isHeadshot, isArmor) {
    Game.hitmarker.alpha = 1.0;
    Game.hitmarker.isKill = !!isKill;
    Game.hitmarker.isHeadshot = !!isHeadshot;
    Game.hitmarker.isArmor = !!isArmor;
    safeCall(DF.Audio, 'playHitmarker', !!isKill, !!isHeadshot, !!isArmor);
  }

  function setDamageDirection(sourcePos) {
    const dx = sourcePos[0] - Game.camera.pos[0];
    const dz = sourcePos[2] - Game.camera.pos[2];
    const worldAngle = Math.atan2(-dx, -dz);
    Game.damageIndicator.angle = worldAngle - Game.camera.yaw;
    Game.damageIndicator.alpha = 1.0;
  }

  function checkPlayerAliveTransition(ps) {
    if (!ps) return;
    if (ps.state === 'downed' && Game.controlMode !== 'downed') {
      if (Game.controlMode === 'drone' || Game.controlMode === 'dog') {
        safeCall(DF.Unmanned, 'releaseControl');
      }
      if (Game.activeVehicle) exitCurrentVehicle();
      Game.controlMode = 'downed';
      Game.isAds = false;
      Game.vault = null;
      Game.visionMode = 'normal';
      safeCall(DF.UI, 'showNotification', '你已负伤倒地！等待队友施救，或按 [Space] 接管存活友军', 'danger');
    } else if (ps.state === 'dead' && Game.controlMode !== 'dead') {
      if (Game.controlMode === 'drone' || Game.controlMode === 'dog') {
        safeCall(DF.Unmanned, 'releaseControl');
      }
      if (Game.activeVehicle) exitCurrentVehicle();
      Game.controlMode = 'dead';
      Game.isAds = false;
      Game.vault = null;
      Game.visionMode = 'normal';
      safeCall(DF.UI, 'showNotification', '阵亡！按 [Space] 接管下一名存活友军', 'danger');
    }
  }

  function detectFootstepSurface(pos) {
    if (!pos) return 'asphalt';
    if (pos[1] > 0.14) return 'concrete';
    const az = Math.abs(pos[2]);
    if (az <= 11.2) return 'asphalt';
    if (az >= 12.0 && az <= 34.5) return 'concrete';
    return 'rubble';
  }

  function onPlayerBodyRestored(ps, noticeText) {
    if (!ps) return;
    if (Game.controlMode === 'drone' || Game.controlMode === 'dog') {
      safeCall(DF.Unmanned, 'releaseControl');
    }
    if (Game.activeVehicle) exitCurrentVehicle();
    Game.controlMode = 'infantry';
    Game.visionMode = 'normal';
    Game.isAds = false;
    Game.adsBlend = 0;
    Game.vault = null;
    Game.vaultCooldown = 0;
    Game.sprintDemo = false;
    Game.eyeHeight = ps.crouching ? CROUCH_EYE : STAND_EYE;
    Game.lastPlayerDamageTime = Game.time;
    Game._prevPlayerHp = ps.hp || ps.maxHp || 100;
    Game.postFX.damageFlash = 0;
    Game.postFX.concussion = 0;
    Game.postFX.suppression = 0;
    initPlayerWeaponStates(ps.faction || Game.playerFaction, ps.weaponSlot || 0);
    if (noticeText) {
      safeCall(DF.UI, 'showNotification', noticeText, 'success');
    }
  }

  Game.respawnPlayerNow = function () {
    if (DF.GameMode && typeof DF.GameMode.respawnPlayerNow === 'function') {
      const res = DF.GameMode.respawnPlayerNow(true);
      const ps = getPlayerSoldier();
      if (res && ps && ps.state === 'alive') {
        onPlayerBodyRestored(ps, '增援重新部署完成，重返前线！');
        safeCall(DF.Audio, 'playRadioCue', 'ack');
        return true;
      }
      if (res === false) {
        safeCall(DF.UI, 'showNotification', '增援兵力已耗尽，无法自动复活', 'danger');
        return false;
      }
    }
    // Fallback safe revive if GameMode didn't respawn
    const ps = getPlayerSoldier();
    if (ps) {
      ps.state = 'alive';
      ps.hp = ps.maxHp || 100;
      ps.bleedTimer = 0;
      ps.reviveProgress = 0;
      ps.inVehicleId = null;
      onPlayerBodyRestored(ps, '增援重新部署完成，重返前线！');
      return true;
    }
    return false;
  };

  Game.takeOverNextAlly = function () {
    if (!DF.GameMode || typeof DF.GameMode.takeOverNextAlly !== 'function') return false;
    const nextSoldier = DF.GameMode.takeOverNextAlly();
    if (!nextSoldier) {
      // No living allies to take over => trigger automatic respawn seamlessly so player is never softlocked!
      return Game.respawnPlayerNow();
    }
    onPlayerBodyRestored(nextSoldier, `已接管友军: ${nextSoldier.name || '战斗员'}`);
    safeCall(DF.Audio, 'playRadioCue', 'ack');
    return true;
  };

  /* ------------------------------------------------------------------
   * Match Lifecycle
   * ------------------------------------------------------------------ */
  Game.startMatch = function (faction) {
    const f = faction === 'RU' ? 'RU' : 'UA';
    Game.playerFaction = f;
    Game.phase = 'playing';
    Game.controlMode = 'infantry';
    Game.diagnosticView = 'gameplay';
    Game.customCameraOverride = null;
    Game.activeVehicle = null;
    Game.vehicleCamMode = 0;
    Game.visionMode = 'normal';
    Game.radialOpen = false;
    Game.mapOpen = false;
    Game.isAds = false;
    Game.adsBlend = 0;
    Game.sprintBlend = 0;
    Game.vault = null;
    Game.vaultCooldown = 0;
    Game.sprintDemo = false;
    Game.stridePhase = 0;
    Game.lastStrideCount = 0;
    Game.lastPlayerDamageTime = -99;
    Game._prevPlayerHp = 100;
    Game.shakeTrauma = 0;
    Game.dynamicLights.length = 0;
    Game.pendingExplosions.length = 0;
    Game.postFX = { suppression: 0, damageFlash: 0, concussion: 0, vignette: 0.18, chromatic: 0, muzzleExposure: 0 };
    Game.stats = {
      kills: 0,
      headshots: 0,
      damageDealt: 0,
      vehiclesDestroyed: 0,
      wallsBreached: 0,
      alliesRevived: 0,
      shotsFired: 0,
      shotsHit: 0,
    };

    safeCall(DF.Renderer, 'setWireframe', false);
    safeCall(DF.Renderer, 'setVisionMode', 'normal');
    safeCall(DF.Renderer, 'clearDecals');
    safeCall(DF.UI, 'reset');

    // Reset world/vehicles/unmanned/AI/gamemode cleanly if supported
    if (DF.Destruction && typeof DF.Destruction.reset === 'function') DF.Destruction.reset();
    if (DF.Ballistics && typeof DF.Ballistics.reset === 'function') DF.Ballistics.reset();
    if (DF.Armor && typeof DF.Armor.reset === 'function') DF.Armor.reset();
    else if (DF.Armor && typeof DF.Armor.init === 'function' && Game.gl) DF.Armor.init(Game.gl);
    if (DF.Unmanned && typeof DF.Unmanned.reset === 'function') DF.Unmanned.reset();
    else if (DF.Unmanned && typeof DF.Unmanned.init === 'function' && Game.gl) DF.Unmanned.init(Game.gl);

    safeCall(DF.AI, 'init', f);
    safeCall(DF.GameMode, 'init', f);

    const ps = getPlayerSoldier();
    if (ps) {
      // Face toward battle center initially
      ps.yaw = f === 'UA' ? Math.PI * 0.5 : -Math.PI * 0.5;
      ps.pitch = 0;
      initPlayerWeaponStates(f, ps.weaponSlot || 0);
    } else {
      initPlayerWeaponStates(f, 0);
    }

    safeCall(DF.Audio, 'unlock');
    safeCall(DF.Audio, 'playRadioCue', 'start');
    safeCall(DF.UI, 'showNotification', f === 'UA'
      ? '部署完成：蓝方防守阵线 (5人精英) — 守卫 A/B/C 扇区！'
      : '部署完成：红方进攻集群 (20人合成) — 突破并占领 A/B/C 扇区！', 'info');
  };

  Game.setPaused = function (paused) {
    if (Game.phase !== 'playing' && Game.phase !== 'paused') return;
    Game.phase = paused ? 'paused' : 'playing';
    if (paused) {
      Game.radialOpen = false;
      Game.mapOpen = false;
      safeCall(DF.UI, 'openRadial', false);
      if (document.pointerLockElement === Game.canvas && document.exitPointerLock) {
        try { document.exitPointerLock(); } catch (_) {}
      }
    }
  };

  Game.applySettings = function (partial) {
    if (!partial) return;
    Object.assign(Game.settings, partial);
    if (partial.quality) {
      safeCall(DF.Renderer, 'setQuality', partial.quality);
    }
    if (partial.masterVol != null || partial.sfxVol != null || partial.musicVol != null) {
      safeCall(DF.Audio, 'setVolumes', {
        master: Game.settings.masterVol,
        sfx: Game.settings.sfxVol,
        music: Game.settings.musicVol,
      });
    }
    saveSettings();
  };

  /* ------------------------------------------------------------------
   * Input Binding
   * ------------------------------------------------------------------ */
  function requestLock() {
    if (!Game.canvas || Game.phase !== 'playing' || Game.mapOpen || Game.radialOpen) return;
    if (document.pointerLockElement !== Game.canvas && Game.canvas.requestPointerLock) {
      try {
        const res = Game.canvas.requestPointerLock();
        if (res && typeof res.catch === 'function') res.catch(() => {});
      } catch (_) {}
    }
  }

  function bindInputs() {
    window.addEventListener('keydown', (e) => {
      safeCall(DF.Audio, 'unlock');
      const code = e.code;

      // Prevent browser scrolling on gameplay keys
      if (Game.phase === 'playing' && (code === 'Space' || code === 'Tab' || code.startsWith('F') && code.length === 2)) {
        e.preventDefault();
      }

      const wasDown = !!Game.keys[code];
      Game.keys[code] = true;

      if (wasDown) return;

      // Pause toggle
      if (code === 'Escape' || code === 'KeyP') {
        if (Game.mapOpen) {
          Game.mapOpen = false;
          safeCall(DF.UI, 'toggleMap', false);
          return;
        }
        if (Game.controlMode === 'drone' || Game.controlMode === 'dog') {
          if (code === 'Escape') {
            toggleUnmannedControl(Game.controlMode);
            return;
          }
        }
        if (Game.phase === 'playing') {
          Game.setPaused(true);
          safeCall(DF.UI, 'togglePause', true);
        } else if (Game.phase === 'paused') {
          Game.setPaused(false);
          safeCall(DF.UI, 'togglePause', false);
        }
        return;
      }

      if (Game.phase !== 'playing') return;

      // Tactical Map toggle
      if (code === 'KeyM') {
        Game.mapOpen = !Game.mapOpen;
        safeCall(DF.UI, 'toggleMap', Game.mapOpen);
        if (Game.mapOpen && document.pointerLockElement === Game.canvas) {
          try { document.exitPointerLock(); } catch (_) {}
        }
        return;
      }

      // Space while downed/dead => takeover next living ally (or respawn if none alive); F => instant skip bleedout & respawn
      if ((code === 'Space' || code === 'KeyF') && (Game.controlMode === 'downed' || Game.controlMode === 'dead')) {
        if (code === 'KeyF') {
          if (DF.GameMode && typeof DF.GameMode.skipBleedout === 'function') {
            const skipped = DF.GameMode.skipBleedout();
            if (skipped === false) Game.respawnPlayerNow();
          } else {
            Game.respawnPlayerNow();
          }
        } else {
          Game.takeOverNextAlly();
        }
        return;
      }

      // Unmanned takeover hotkeys
      if (code === 'Digit7') {
        toggleUnmannedControl('drone');
        return;
      }
      if (code === 'Digit8') {
        toggleUnmannedControl('dog');
        return;
      }

      // Instant F1-F6 squad commands
      if (code === 'F1') { Game.issueOrder('follow'); return; }
      if (code === 'F2') { Game.issueOrder('attack'); return; }
      if (code === 'F3') { Game.issueOrder('suppress'); return; }
      if (code === 'F4') { Game.issueOrder('flank'); return; }
      if (code === 'F5') { Game.issueOrder('revive'); return; }
      if (code === 'F6') { Game.issueOrder('vehicle'); return; }

      // Q spot / hold radial wheel
      if (code === 'KeyQ') {
        Game.qDownTime = performance.now();
        Game.qHeld = true;
        return;
      }

      // Vehicle-specific keys
      if (Game.controlMode === 'vehicle' && Game.activeVehicle) {
        if (code === 'KeyE') { exitCurrentVehicle(); return; }
        if (code === 'KeyC') {
          Game.vehicleCamMode = (Game.vehicleCamMode + 1) % 3;
          Game.visionMode = Game.vehicleCamMode === 2 ? 'thermal_white' : 'normal';
          Game.activeVehicle.camMode = Game.vehicleCamMode;
          Game.activeVehicle.thermalMode = Game.vehicleCamMode === 2;
          safeCall(DF.Audio, 'playRadioCue', 'ack');
          return;
        }
        if (code === 'KeyT') { toggleThermalVision(); return; }
        if (code === 'KeyX') {
          safeCall(DF.Armor, 'deploySmoke', Game.activeVehicle);
          return;
        }
        return;
      }

      // Drone / Dog thermal & special keys
      if (Game.controlMode === 'drone' || Game.controlMode === 'dog') {
        if (code === 'KeyT') { toggleThermalVision(); return; }
        if (code === 'KeyF' && Game.controlMode === 'drone') {
          safeCall(DF.Unmanned, 'triggerKamikaze');
          safeCall(DF.UI, 'showNotification', 'FPV 自杀俯冲锁定启动！', 'danger');
          return;
        }
        return;
      }

      // Infantry controls
      if (Game.controlMode === 'infantry') {
        if (code >= 'Digit1' && code <= 'Digit6') {
          switchWeaponSlot(parseInt(code.slice(5), 10) - 1);
        } else if (code === 'KeyR') {
          startReload();
        } else if (code === 'KeyB') {
          cycleFireMode();
        } else if (code === 'KeyG') {
          throwPlayerGrenade('frag');
        } else if (code === 'KeyT') {
          throwPlayerGrenade('smoke');
        } else if (code === 'KeyE') {
          triggerInteractPress();
        } else if (code === 'KeyC' || code === 'ControlLeft') {
          const ps = getPlayerSoldier();
          if (ps && ps.state === 'alive') {
            ps.crouching = !ps.crouching;
          }
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      const code = e.code;
      Game.keys[code] = false;

      if (code === 'KeyQ' && Game.qHeld) {
        Game.qHeld = false;
        const heldMs = performance.now() - Game.qDownTime;
        if (Game.radialOpen) {
          Game.radialOpen = false;
          const selected = safeCall(DF.UI, 'openRadial', false);
          if (typeof selected === 'string' && selected) {
            Game.issueOrder(selected);
          }
          requestLock();
        } else if (heldMs < 240 && Game.phase === 'playing') {
          Game.spotUnderCrosshair();
        }
      }
    });

    window.addEventListener('blur', () => {
      for (const k in Game.keys) Game.keys[k] = false;
      Game.mouseButtons.left = false;
      Game.mouseButtons.right = false;
      Game.isAds = false;
    });

    document.addEventListener('pointerlockchange', () => {
      Game.pointerLocked = document.pointerLockElement === Game.canvas;
    });

    window.addEventListener('mousemove', (e) => {
      if (Game.phase !== 'playing' || Game.mapOpen) return;
      if (Game.radialOpen) {
        if (Game.pointerLocked) {
          safeCall(DF.UI, 'handleRadialMove', e.movementX || 0, e.movementY || 0);
        }
        return;
      }
      if (Game.pointerLocked || Game.mouseButtons.left || Game.mouseButtons.right) {
        Game.mouseDeltaX += e.movementX || 0;
        Game.mouseDeltaY += e.movementY || 0;
      }
    });

    Game.canvas.addEventListener('mousedown', (e) => {
      safeCall(DF.Audio, 'unlock');
      if (Game.phase !== 'playing' || Game.mapOpen || Game.radialOpen) return;
      requestLock();
      if (e.button === 0) {
        Game.mouseButtons.left = true;
        Game.fireTriggerConsumed = false;
      } else if (e.button === 2) {
        Game.mouseButtons.right = true;
        if (Game.controlMode === 'infantry') Game.isAds = true;
      } else if (e.button === 1) {
        Game.mouseButtons.middle = true;
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        Game.mouseButtons.left = false;
        Game.fireTriggerConsumed = false;
      } else if (e.button === 2) {
        Game.mouseButtons.right = false;
        Game.isAds = false;
      } else if (e.button === 1) {
        Game.mouseButtons.middle = false;
      }
    });

    Game.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('wheel', (e) => {
      if (Game.phase !== 'playing' || Game.controlMode !== 'infantry' || Game.mapOpen) return;
      const ps = getPlayerSoldier();
      if (!ps || ps.state !== 'alive') return;
      const delta = e.deltaY > 0 ? 1 : -1;
      switchWeaponSlot(((ps.weaponSlot || 0) + delta + 6) % 6);
    }, { passive: true });
  }

  /* ------------------------------------------------------------------
   * Player & Control Mode Update Steps
   * ------------------------------------------------------------------ */
  function updateInfantryPlayer(dt) {
    const ps = getPlayerSoldier();
    if (!ps) return;

    // Check if player was downed or killed by AI/explosion
    if (ps.state === 'downed' || ps.state === 'dead') {
      checkPlayerAliveTransition(ps);
      return;
    }

    // Q hold detection for radial wheel
    if (Game.qHeld && !Game.radialOpen && performance.now() - Game.qDownTime >= 220) {
      Game.radialOpen = true;
      safeCall(DF.UI, 'openRadial', true);
      if (document.pointerLockElement === Game.canvas) {
        try { document.exitPointerLock(); } catch (_) {}
      }
    }

    const ws = getActiveWeaponState();
    const spec = getWeaponSpec(ws.slot, ps.faction || Game.playerFaction);

    // Mouse look
    const adsScale = lerp(1.0, (spec.adsFov || 50) / Game.settings.baseFov, Game.adsBlend);
    const sens = 0.0022 * Game.settings.sensitivity * adsScale;
    const dx = Game.mouseDeltaX;
    const dy = Game.mouseDeltaY;
    Game.mouseDeltaX = 0;
    Game.mouseDeltaY = 0;

    ps.yaw -= dx * sens;
    const ySign = Game.settings.invertY ? 1 : -1;
    ps.pitch = clamp(ps.pitch + dy * sens * ySign, -1.46, 1.46);

    // Recoil spring recovery
    Game.recoilPitch += Game.recoilPitchVel * dt;
    Game.recoilYaw += Game.recoilYawVel * dt;
    Game.recoilPitchVel = damp(Game.recoilPitchVel, 0, 14, dt);
    Game.recoilYawVel = damp(Game.recoilYawVel, 0, 14, dt);
    Game.recoilPitch = damp(Game.recoilPitch, 0, 9.5, dt);
    Game.recoilYaw = damp(Game.recoilYaw, 0, 11.0, dt);

    // Weapon sway
    Game.swayX = damp(Game.swayX, clamp(-dx * 0.0018, -0.06, 0.06), 12, dt);
    Game.swayY = damp(Game.swayY, clamp(-dy * 0.0018, -0.06, 0.06), 12, dt);

    // Vault cooldown & active window vault state machine
    if (!Game.keys.Space) Game.jumpConsumedByVault = false;
    if (Game.vaultCooldown > 0) Game.vaultCooldown = Math.max(0, Game.vaultCooldown - dt);
    if (Game.vault) {
      updateWindowVault(ps, ws, spec, dt);
      return;
    }

    // Movement vector
    let moveFwd = 0;
    let moveRight = 0;
    if (Game.keys.KeyW || Game.keys.ArrowUp) moveFwd += 1;
    if (Game.keys.KeyS || Game.keys.ArrowDown) moveFwd -= 1;
    if (Game.keys.KeyD || Game.keys.ArrowRight) moveRight += 1;
    if (Game.keys.KeyA || Game.keys.ArrowLeft) moveRight -= 1;
    const moveMag = Math.hypot(moveFwd, moveRight);
    if (moveMag > 0) {
      moveFwd /= moveMag;
      moveRight /= moveMag;
    }

    const wantsSprint = (!!(Game.keys.ShiftLeft || Game.keys.ShiftRight) && moveFwd > 0.3 && !Game.isAds && !ws.reloading && !Game.mouseButtons.left) || (Game.sprintDemo && !Game.isAds && !ws.reloading);
    if (wantsSprint && ps.crouching) ps.crouching = false;
    Game.isSprinting = wantsSprint;
    Game.sprintBlend = damp(Game.sprintBlend, wantsSprint ? 1 : 0, 8.5, dt);

    // Out-of-combat health recovery fallback (DF.AI handles primary stabilization when ps.timeSinceDamage is active)
    const maxHp = ps.maxHp || 100;
    if (ps.hp < Game._prevPlayerHp - 0.5) {
      Game.lastPlayerDamageTime = Game.time;
    }
    Game._prevPlayerHp = ps.hp;
    if (ps.timeSinceDamage === undefined) {
      const lastDmgT = ps.lastHitTime != null ? Math.max(Game.lastPlayerDamageTime, ps.lastHitTime) : Game.lastPlayerDamageTime;
      if (ps.hp > 0 && ps.hp < maxHp && Game.time - lastDmgT >= 5.5) {
        let regenCap = Math.round(maxHp * 0.80);
        if (findNearestAmmoCrate(ps.pos, 5.5)) {
          regenCap = maxHp;
        } else if (DF.AI && typeof DF.AI.getSoldiers === 'function') {
          const allS = DF.AI.getSoldiers();
          for (let i = 0; i < allS.length; i++) {
            const a = allS[i];
            if (a && !a.isPlayer && a.faction === ps.faction && a.state === 'alive' && a.role === 'medic' && dist3(ps.pos, a.pos) < 6.0) {
              regenCap = maxHp;
              break;
            }
          }
        }
        if (ps.hp < regenCap) {
          ps.hp = Math.min(regenCap, ps.hp + 7.5 * dt);
          Game._prevPlayerHp = ps.hp;
        }
      }
    }

    const targetSpeed = wantsSprint
      ? SPRINT_SPEED
      : ps.crouching
        ? CROUCH_SPEED
        : Game.isAds
          ? ADS_SPEED
          : WALK_SPEED;

    const fwdX = -Math.sin(ps.yaw);
    const fwdZ = -Math.cos(ps.yaw);
    const rightX = Math.cos(ps.yaw);
    const rightZ = -Math.sin(ps.yaw);

    const wishX = (fwdX * moveFwd + rightX * moveRight) * targetSpeed;
    const wishZ = (fwdZ * moveFwd + rightZ * moveRight) * targetSpeed;

    ps.vel = ps.vel || [0, 0, 0];
    const accel = ps.grounded !== false ? 14.0 : 3.5;
    ps.vel[0] = damp(ps.vel[0], wishX, accel, dt);
    ps.vel[2] = damp(ps.vel[2], wishZ, accel, dt);

    // Window Vault (Forward + Jump facing a large window) OR normal Jump
    const wantsForwardVault = (Game.keys.KeyW || Game.keys.ArrowUp || moveFwd > 0.35) && !!Game.keys.Space;
    if (wantsForwardVault && Game.vaultCooldown <= 0 && (ps.grounded || ps.vel[1] > -2.4)) {
      const vw = findVaultableWindow(ps);
      if (vw) {
        startWindowVault(ps, vw);
        updateWindowVault(ps, ws, spec, dt);
        return;
      }
    }

    // Jump
    if (Game.keys.Space && ps.grounded && !Game.jumpConsumedByVault) {
      ps.vel[1] = JUMP_VEL;
      ps.grounded = false;
    }

    // Gravity
    ps.vel[1] -= GRAVITY * dt;

    // Move capsule via DF.Physics
    const capH = ps.crouching ? CROUCH_HEIGHT : STAND_HEIGHT;
    if (DF.Physics && typeof DF.Physics.moveCapsule === 'function') {
      const res = DF.Physics.moveCapsule(ps.pos, ps.vel, PLAYER_RADIUS, capH, dt, {
        isPlayer: true,
        ignoreId: ps.id,
      });
      ps.grounded = !!(res && res.grounded);
    } else {
      ps.pos[0] = clamp(ps.pos[0] + ps.vel[0] * dt, -88, 88);
      ps.pos[1] = Math.max(0, ps.pos[1] + ps.vel[1] * dt);
      ps.pos[2] = clamp(ps.pos[2] + ps.vel[2] * dt, -53, 53);
      ps.grounded = ps.pos[1] <= 0.001;
      if (ps.grounded) ps.vel[1] = 0;
    }

    // Smooth eye height, ADS & dynamic +5° sprint FOV kick
    const targetEye = ps.crouching ? CROUCH_EYE : STAND_EYE;
    Game.eyeHeight = damp(Game.eyeHeight, targetEye, 13, dt);
    Game.adsBlend = damp(Game.adsBlend, Game.isAds && !ws.reloading && !Game.isSprinting ? 1 : 0, 14, dt);
    const hipFov = Game.settings.baseFov + Game.sprintBlend * 5.2;
    Game.currentFov = lerp(hipFov, spec.adsFov || 52, Game.adsBlend);

    // Scope optic vision mode for sniper & PGO-7V anti-tank scopes
    const isScopedOptic = Game.adsBlend > 0.80 && (spec.scopeType === 'pso' || spec.scopeType === 'mildot' || spec.scopeType === 'pgo7');
    Game.visionMode = isScopedOptic ? 'optic' : 'normal';

    // Cooldowns & Reload progression
    if (Game.equipTimer > 0) Game.equipTimer = Math.max(0, Game.equipTimer - dt);
    if (Game.grenadeCooldown > 0) Game.grenadeCooldown = Math.max(0, Game.grenadeCooldown - dt);
    if (ws.cooldown > 0) ws.cooldown = Math.max(0, ws.cooldown - dt);

    if (ws.reloading) {
      if (ws.shellByShell) {
        // Interruptible shell-by-shell reload for M870
        if (Game.mouseButtons.left && ws.mag > 0) {
          ws.reloading = false;
          ws.reloadTimer = 0;
        } else {
          ws.shellTimer -= dt;
          if (ws.shellTimer <= 0) {
            if (ws.mag < ws.magSize && ws.reserve > 0) {
              ws.mag++;
              ws.reserve--;
              ws.shellTimer = 0.52;
              safeCall(DF.Audio, 'playReloadFoley', 'shell_insert', ps.pos);
            }
            if (ws.mag >= ws.magSize || ws.reserve <= 0) {
              ws.reloading = false;
              ws.reloadTimer = 0;
            }
          }
        }
      } else {
        ws.reloadTimer -= dt;
        if (ws.reloadTimer <= 0) {
          const needed = ws.magSize - ws.mag;
          const load = Math.min(needed, ws.reserve);
          ws.mag += load;
          ws.reserve -= load;
          ws.reloading = false;
          ws.reloadTimer = 0;
        }
      }
      syncSoldierWeaponAmmo(ps);
    }

    // Firing (auto / semi / burst / single)
    const modes = spec.fireModes || ['auto'];
    const mode = modes[ws.fireModeIdx % modes.length] || 'auto';
    if (Game.burstRemaining > 0) {
      Game.burstTimer -= dt;
      if (Game.burstTimer <= 0 && ws.cooldown <= 0 && !ws.reloading && Game.equipTimer <= 0) {
        if (firePlayerInfantryWeapon(ps, ws, spec)) {
          Game.burstRemaining--;
          Game.burstTimer = ws.cooldown;
        } else {
          Game.burstRemaining = 0;
        }
      }
    } else if (Game.mouseButtons.left && !ws.reloading && Game.equipTimer <= 0 && ws.cooldown <= 0 && !Game.mapOpen && !Game.radialOpen) {
      if (mode === 'auto') {
        firePlayerInfantryWeapon(ps, ws, spec);
      } else if (mode === 'burst') {
        if (!Game.fireTriggerConsumed) {
          Game.fireTriggerConsumed = true;
          if (firePlayerInfantryWeapon(ps, ws, spec)) {
            Game.burstRemaining = 2;
            Game.burstTimer = ws.cooldown;
          }
        }
      } else {
        // semi / bolt / pump / single
        if (!Game.fireTriggerConsumed) {
          Game.fireTriggerConsumed = true;
          firePlayerInfantryWeapon(ps, ws, spec);
        }
      }
    }

    // Update Viewmodel + 1:1 synced stride camera bob & footstep audio
    const rawHSpeed = Math.hypot(ps.vel[0], ps.vel[2]);
    const effSpeed = Game.sprintDemo ? SPRINT_SPEED : rawHSpeed;
    const isMovingGrounded = (ps.grounded || Game.sprintDemo) && effSpeed > 0.45;
    if (isMovingGrounded) {
      const freq = Game.isSprinting ? 11.4 : (ps.crouching ? 5.8 : 7.8);
      Game.stridePhase += dt * freq;
    }

    safeCall(DF.Viewmodel, 'setADS', Game.isAds && !ws.reloading);
    safeCall(DF.Viewmodel, 'setSprint', Game.isSprinting);
    safeCall(DF.Viewmodel, 'setMoveState', effSpeed, !!(ps.grounded || Game.sprintDemo), Game.swayX, Game.swayY);
    safeCall(DF.Viewmodel, 'update', dt, {
      adsBlend: Game.adsBlend,
      sprinting: Game.isSprinting,
      sprintBlend: Game.sprintBlend,
      speed: effSpeed,
      grounded: !!(ps.grounded || Game.sprintDemo),
      reloading: ws.reloading,
      reloadProgress: ws.reloading ? clamp(1 - ws.reloadTimer / Math.max(0.01, ws.reloadDuration), 0, 1) : 0,
      reloadIsEmpty: ws.reloadIsEmpty,
      mag: ws.mag,
      faction: ps.faction || Game.playerFaction,
      slot: ws.slot,
      swayX: Game.swayX,
      swayY: Game.swayY,
    });

    const vmStride = DF.Viewmodel && typeof DF.Viewmodel.getStrideStep === 'function' ? DF.Viewmodel.getStrideStep() : null;
    if (vmStride && typeof vmStride === 'object') {
      if (typeof vmStride.phase === 'number') Game.stridePhase = vmStride.phase;
      if (typeof vmStride.count === 'number' && vmStride.count !== Game.lastStrideCount) {
        Game.lastStrideCount = vmStride.count;
        if (rawHSpeed > 0.45 && ps.grounded) {
          safeCall(DF.Audio, 'playFootstep', detectFootstepSurface(ps.pos), Game.isSprinting);
        }
      }
    } else if (isMovingGrounded) {
      const stepCount = Math.floor(Game.stridePhase / Math.PI);
      if (stepCount !== Game.lastStrideCount) {
        Game.lastStrideCount = stepCount;
        if (rawHSpeed > 0.45 && ps.grounded) {
          safeCall(DF.Audio, 'playFootstep', detectFootstepSurface(ps.pos), Game.isSprinting);
        }
      }
    }

    // Update camera to player eyes with 1:1 synced visceral stride bob & rhythmic sprint roll
    const bobMask = isMovingGrounded ? clamp(effSpeed / WALK_SPEED, 0, 1.35) * (1 - Game.adsBlend * 0.85) : 0;
    const yBob = vmStride && typeof vmStride.bobY === 'number'
      ? vmStride.bobY * (1 - Game.adsBlend * 0.85)
      : Math.sin(Game.stridePhase * 2) * (Game.isSprinting ? 0.040 : 0.016) * bobMask;
    const rollBob = vmStride && typeof vmStride.camRoll === 'number'
      ? vmStride.camRoll * (1 - Game.adsBlend * 0.85)
      : Math.cos(Game.stridePhase) * (Game.isSprinting ? 0.016 : 0.004) * bobMask;
    Game.camera.pos = [ps.pos[0], ps.pos[1] + Game.eyeHeight + yBob, ps.pos[2]];
    Game.camera.yaw = ps.yaw + Game.recoilYaw * 0.25;
    Game.camera.pitch = clamp(ps.pitch + Game.recoilPitch * 0.35 + yBob * 0.14, -1.48, 1.48);
    Game.camera.roll = clamp(-moveRight * 0.016 + rollBob, -0.048, 0.048);
    Game.camera.fov = Game.currentFov;

    // Context interact prompts
    updateContextInteract(dt);
  }

  function buildVehiclePlayerInput() {
    if (Game.controlMode !== 'vehicle' || !Game.activeVehicle || Game.phase !== 'playing') return null;
    const sens = 0.0020 * Game.settings.sensitivity * (Game.vehicleCamMode > 0 ? 0.55 : 1.0);
    const dx = Game.mouseDeltaX;
    const dy = Game.mouseDeltaY;
    Game.mouseDeltaX = 0;
    Game.mouseDeltaY = 0;

    return {
      vehicle: Game.activeVehicle,
      throttle: (Game.keys.KeyW ? 1 : 0) - (Game.keys.KeyS ? 1 : 0),
      steer: (Game.keys.KeyA ? 1 : 0) - (Game.keys.KeyD ? 1 : 0),
      brake: !!Game.keys.Space,
      lookDeltaX: dx * sens,
      lookDeltaY: dy * sens * (Game.settings.invertY ? -1 : 1),
      firePrimary: !!Game.mouseButtons.left && !Game.mapOpen && !Game.radialOpen,
      fireSecondary: !!Game.mouseButtons.right && !Game.mapOpen && !Game.radialOpen,
      smoke: !!Game.keys.KeyX,
      camMode: Game.vehicleCamMode,
    };
  }

  function buildUnmannedPlayerInput() {
    if ((Game.controlMode !== 'drone' && Game.controlMode !== 'dog') || Game.phase !== 'playing') return null;
    const sens = 0.0022 * Game.settings.sensitivity;
    const dx = Game.mouseDeltaX;
    const dy = Game.mouseDeltaY;
    Game.mouseDeltaX = 0;
    Game.mouseDeltaY = 0;

    return {
      type: Game.controlMode,
      forward: (Game.keys.KeyW ? 1 : 0) - (Game.keys.KeyS ? 1 : 0),
      strafe: (Game.keys.KeyD ? 1 : 0) - (Game.keys.KeyA ? 1 : 0),
      ascend: (Game.keys.Space ? 1 : 0) - (Game.keys.ShiftLeft || Game.keys.ShiftRight ? 1 : 0),
      jump: !!Game.keys.Space,
      sprint: !!(Game.keys.ShiftLeft || Game.keys.ShiftRight),
      lookDeltaX: dx * sens,
      lookDeltaY: dy * sens * (Game.settings.invertY ? -1 : 1),
      fire: !!Game.mouseButtons.left && !Game.mapOpen && !Game.radialOpen,
      secondary: !!Game.mouseButtons.right && !Game.mapOpen && !Game.radialOpen,
      kamikaze: !!Game.keys.KeyF,
    };
  }

  function updateVehicleOrUnmannedCamera(dt) {
    const curPs = getPlayerSoldier();
    if (curPs && curPs.state !== 'alive' && (Game.controlMode === 'vehicle' || Game.controlMode === 'drone' || Game.controlMode === 'dog')) {
      checkPlayerAliveTransition(curPs);
      return;
    }
    if (Game.controlMode === 'vehicle') {
      if (!Game.activeVehicle || Game.activeVehicle.destroyed || Game.activeVehicle.alive === false || Game.activeVehicle.hp <= 0) {
        exitCurrentVehicle();
        return;
      }
      const cam = safeCall(DF.Armor, 'getCameraTransform', Game.activeVehicle, Game.vehicleCamMode);
      if (cam && cam.pos) {
        Game.camera.pos = [cam.pos[0], cam.pos[1], cam.pos[2]];
        Game.camera.yaw = cam.yaw != null ? cam.yaw : (Game.activeVehicle.turretYaw || Game.activeVehicle.yaw || 0);
        Game.camera.pitch = cam.pitch != null ? cam.pitch : (Game.activeVehicle.gunPitch || 0);
        Game.camera.roll = cam.roll || 0;
        Game.camera.fov = cam.fov || (Game.vehicleCamMode === 0 ? 74 : 42);
      }
      updateContextInteract(dt);
      return;
    }

    if (Game.controlMode === 'drone' || Game.controlMode === 'dog') {
      Game.interactPrompt = '';
      Game.interactAction = null;
      const unit = safeCall(DF.Unmanned, 'getControlledUnit');
      if (!unit || unit.destroyed || unit.hp <= 0) {
        // Return cleanly to soldier after brief static burst
        Game.droneReturnDelay += dt;
        Game.postFX.chromatic = 0.7;
        if (Game.droneReturnDelay > 0.65) {
          Game.droneReturnDelay = 0;
          safeCall(DF.Unmanned, 'releaseControl');
          const ps = getPlayerSoldier();
          Game.controlMode = Game.activeVehicle ? 'vehicle' : (ps && ps.state === 'downed' ? 'downed' : 'infantry');
          Game.visionMode = 'normal';
          safeCall(DF.UI, 'showNotification', '无人单位信号中断 — 已切换回本体视角', 'warn');
        }
        return;
      }
      Game.droneReturnDelay = 0;
      const cam = safeCall(DF.Unmanned, 'getCameraTransform', unit);
      if (cam && cam.pos) {
        Game.camera.pos = [cam.pos[0], cam.pos[1], cam.pos[2]];
        Game.camera.yaw = cam.yaw != null ? cam.yaw : (unit.yaw || 0);
        Game.camera.pitch = cam.pitch != null ? cam.pitch : (unit.pitch || 0);
        Game.camera.roll = cam.roll || 0;
        Game.camera.fov = cam.fov || (Game.controlMode === 'drone' ? 84 : 76);
      }
      return;
    }

    if (Game.controlMode === 'downed' || Game.controlMode === 'dead') {
      Game.interactPrompt = '';
      Game.interactAction = null;
      const ps = getPlayerSoldier();
      if (ps) {
        if (ps.state === 'alive') {
          // Player was revived by an AI medic OR auto-respawned by DF.GameMode!
          const wasDead = Game.controlMode === 'dead';
          if (wasDead) {
            onPlayerBodyRestored(ps, '增援自动复活完成，重返战斗！');
          } else {
            Game.controlMode = 'infantry';
            Game.visionMode = 'normal';
            Game.eyeHeight = CROUCH_EYE;
            Game._prevPlayerHp = ps.hp || 75;
            safeCall(DF.UI, 'showNotification', '队友已成功将你救起，重返战斗！', 'success');
          }
          return;
        }
        Game.camera.pos = [ps.pos[0], ps.pos[1] + DOWNED_EYE, ps.pos[2]];
        Game.camera.yaw = ps.yaw + Math.sin(Game.time * 0.6) * 0.08;
        Game.camera.pitch = clamp(0.18 + Math.sin(Game.time * 1.1) * 0.04, -0.4, 0.5);
        Game.camera.roll = 0.24;
        Game.camera.fov = 78;
      }
    }
  }

  /* ------------------------------------------------------------------
   * Pre-Battle Cinematic Flyby & Diagnostic Views
   * ------------------------------------------------------------------ */
  function updateMenuCinematicCamera(t) {
    // Sweeping dramatic flyby down the sunlit smoky Donbas main avenue
    const cycle = t * 0.065;
    const x = -56 + Math.sin(cycle) * 48 + 26;
    const z = Math.cos(cycle * 1.35) * 18 + 9;
    const y = 10.5 + Math.sin(cycle * 2.1) * 3.2;
    const lookX = x + 28 * Math.cos(cycle * 0.5) + 12;
    const lookY = 2.8 + Math.sin(cycle * 1.2) * 0.9;
    const lookZ = Math.sin(cycle * 0.9) * 6;

    const dx = lookX - x;
    const dy = lookY - y;
    const dz = lookZ - z;
    const horiz = Math.hypot(dx, dz) || 1;
    Game.camera.pos = [x, y, z];
    Game.camera.yaw = Math.atan2(-dx, -dz);
    Game.camera.pitch = Math.atan2(dy, horiz);
    Game.camera.roll = Math.sin(cycle * 0.8) * 0.018;
    Game.camera.fov = 66;
  }

  function applyDiagnosticCamera() {
    if (Game.customCameraOverride) {
      const c = Game.customCameraOverride;
      Game.camera.pos = [c.pos[0], c.pos[1], c.pos[2]];
      Game.camera.yaw = c.yaw;
      Game.camera.pitch = c.pitch;
      Game.camera.roll = c.roll || 0;
      Game.camera.fov = c.fov || 68;
      return true;
    }

    const mode = Game.diagnosticView;
    if (mode === 'gameplay' || mode === 'rpg' || mode === 'sprint') return false;

    let pos, target, fov = 62;

    if (mode === 'overview') {
      // Unobstructed dramatic 3/4 Frostbite canyon overview looking WSW into low-angle golden sun, god rays, wet puddles & billowing smoke
      pos = [44, 18.5, -9.5];
      target = [-30, 3.0, 4.0];
      fov = 56;
    } else if (mode === 'closeup') {
      // Close-up front-3/4 PBR detail on active MBT (turret, ERA, barrel, roadwheels, concrete facade & wet puddles)
      let anchor = [8, 1.35, 1.5];
      let yaw = Math.PI * 0.5;
      if (DF.Armor && typeof DF.Armor.getVehicles === 'function') {
        const vehs = DF.Armor.getVehicles() || [];
        const tank =
          vehs.find((v) => !v.destroyed && v.alive !== false && v.faction === 'UA' && (v.type === 'tank' || v.role === 'mbt' || /T-64/i.test(v.name || ''))) ||
          vehs.find((v) => !v.destroyed && v.alive !== false && (v.type === 'tank' || v.role === 'mbt' || /T-64|T-72/i.test(v.name || ''))) ||
          vehs[0];
        if (tank && tank.pos) {
          anchor = [tank.pos[0], tank.pos[1] + 1.35, tank.pos[2]];
          yaw = tank.yaw != null ? tank.yaw : Math.PI * 0.5;
        }
      }
      const fwd = [-Math.sin(yaw), 0, -Math.cos(yaw)];
      const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
      // Choose whichever side keeps camera over open avenue (closer to Z=0)
      const sideSign = anchor[2] > 0 ? -1 : 1;
      let dist = 5.6;
      const offsetDir = normalize3([fwd[0] * 0.72 + right[0] * 0.69 * sideSign, 0.22, fwd[2] * 0.72 + right[2] * 0.69 * sideSign]);
      if (DF.Physics && typeof DF.Physics.raycast === 'function') {
        const h = DF.Physics.raycast(anchor, offsetDir, dist + 0.8, { checkEntities: false, checkVehicles: false });
        if (h && h.dist < dist) dist = Math.max(3.6, h.dist - 0.6);
      }
      pos = [anchor[0] + offsetDir[0] * dist, Math.max(1.85, anchor[1] + offsetDir[1] * dist), anchor[2] + offsetDir[2] * dist];
      target = [anchor[0] + fwd[0] * 0.35, anchor[1] - 0.15, anchor[2] + fwd[2] * 0.35];
      fov = 46;
    } else if (mode === 'ground') {
      // Low-angle street-level front-3/4 ground-contact inspection (treads, roadwheels, curb, building base, barricades, soldiers)
      let anchor = [-26, 0.6, 0];
      let yaw = Math.PI * 0.5;
      if (DF.Armor && typeof DF.Armor.getVehicles === 'function') {
        const vehs = DF.Armor.getVehicles() || [];
        const v =
          vehs.find((x) => !x.destroyed && x.alive !== false && x.faction === 'UA' && x.pos) ||
          vehs.find((x) => !x.destroyed && x.alive !== false && x.pos);
        if (v) {
          anchor = [v.pos[0], v.pos[1] + 0.6, v.pos[2]];
          yaw = v.yaw != null ? v.yaw : Math.PI * 0.5;
        }
      }
      const fwd = [-Math.sin(yaw), 0, -Math.cos(yaw)];
      const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
      const sideSign = anchor[2] > 0 ? -1 : 1;
      let dist = 8.4;
      const dir2d = normalize3([fwd[0] * 0.76 + right[0] * 0.65 * sideSign, 0, fwd[2] * 0.76 + right[2] * 0.65 * sideSign]);
      if (DF.Physics && typeof DF.Physics.raycast === 'function') {
        const h = DF.Physics.raycast([anchor[0], 0.8, anchor[2]], dir2d, dist + 0.8, { checkEntities: false, checkVehicles: false });
        if (h && h.dist < dist) dist = Math.max(4.8, h.dist - 0.7);
      }
      const camX = anchor[0] + dir2d[0] * dist;
      const camZ = anchor[2] + dir2d[2] * dist;
      const gy = DF.Physics && typeof DF.Physics.getGroundY === 'function' ? DF.Physics.getGroundY(camX, camZ, 2.0) : 0;
      pos = [camX, gy + 0.68, camZ];
      target = [anchor[0] - fwd[0] * 1.2, gy + 1.05, anchor[2] - fwd[2] * 1.2];
      fov = 55;
    } else if (mode === 'wireframe') {
      // Unobstructed center-avenue 3/4 topology check (full road + buildings + balconies + armor + barricades + soldiers)
      pos = [32, 14.5, 0.5];
      target = [-28, 2.2, 0.0];
      fov = 56;
    } else if (mode === 'soldiers') {
      // Crisp unobstructed front-3/4 close-up of live outdoor UA/RU combat soldiers (verifying limbs, knees, weapon aim & grounding)
      const soldiers = safeCall(DF.AI, 'getSoldiers') || [];
      let picked = null;
      let bestScore = -Infinity;
      for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i];
        if (!s || s.state !== 'alive' || s.inVehicleId || !s.pos) continue;
        // Prefer outdoor street-level non-player soldiers near avenue so lighting and full body silhouette are crystal clear
        const outdoorBonus = (Math.abs(s.pos[2]) < 12 && s.pos[1] < 0.5) ? 40 : 0;
        const nonPlayerBonus = s.isPlayer ? -15 : 20;
        const uaBonus = s.faction === 'UA' ? 10 : 0;
        const sc = outdoorBonus + nonPlayerBonus + uaBonus - Math.abs(s.pos[0] + 20) * 0.25;
        if (sc > bestScore) {
          bestScore = sc;
          picked = s;
        }
      }
      if (picked) {
        const syaw = picked.yaw != null ? picked.yaw : 0;
        const fwd = [-Math.sin(syaw), 0, -Math.cos(syaw)];
        const right = [Math.cos(syaw), 0, -Math.sin(syaw)];
        const chest = [picked.pos[0], picked.pos[1] + 1.05, picked.pos[2]];
        // Pick unobstructed front-3/4 side (preferring sun-lit side)
        let bestCamPos = [chest[0] + fwd[0] * 2.8 + right[0] * 1.8, picked.pos[1] + 1.28, chest[2] + fwd[2] * 2.8 + right[2] * 1.8];
        let bestClear = 0;
        const candidates = [
          [fwd[0] * 0.78 + right[0] * 0.62, 0.08, fwd[2] * 0.78 + right[2] * 0.62],
          [fwd[0] * 0.78 - right[0] * 0.62, 0.08, fwd[2] * 0.78 - right[2] * 0.62],
          [fwd[0] * 0.45 + right[0] * 0.89, 0.10, fwd[2] * 0.45 + right[2] * 0.89],
          [-fwd[0] * 0.45 + right[0] * 0.89, 0.10, -fwd[2] * 0.45 + right[2] * 0.89],
        ];
        for (let c = 0; c < candidates.length; c++) {
          const dir = normalize3(candidates[c]);
          let dist = 3.55;
          if (DF.Physics && typeof DF.Physics.raycast === 'function') {
            const h = DF.Physics.raycast(chest, dir, dist + 0.5, { checkEntities: false, checkVehicles: false });
            if (h && h.dist < dist) dist = Math.max(1.4, h.dist - 0.45);
          }
          if (dist > bestClear) {
            bestClear = dist;
            bestCamPos = [chest[0] + dir[0] * dist, Math.max(picked.pos[1] + 0.95, chest[1] + dir[1] * dist), chest[2] + dir[2] * dist];
          }
        }
        pos = bestCamPos;
        target = [picked.pos[0], picked.pos[1] + 0.96, picked.pos[2]];
        fov = 44;
      } else {
        pos = [-22, 1.5, 5];
        target = [-28, 1.0, 1];
        fov = 46;
      }
    } else if (mode === 'interior_stairs') {
      // Unobstructed interior stairwell & furnished room inspection view
      let stair = null;
      const stairsList = safeCall(DF.Map, 'getStairs') || (DF.Physics && typeof DF.Physics.getColliders === 'function'
        ? (DF.Physics.getColliders() || []).filter((c) => c && c.meta && c.meta.type === 'stair')
        : []);
      if (Array.isArray(stairsList) && stairsList.length > 0) {
        stair = stairsList.find((s) => (s.y0 != null ? s.y0 : (s.meta && s.meta.stairY0)) < 1.0) || stairsList[0];
      }
      if (stair) {
        const min = stair.min || [stair.x0 || 50, 0.25, stair.z0 || -4];
        const max = stair.max || [stair.x1 || 56, 3.85, stair.z1 || 0];
        const cx = (min[0] + max[0]) * 0.5;
        const cz = (min[2] + max[2]) * 0.5;
        const dir = stair.dir || (stair.meta && stair.meta.stairDir) || '+x';
        const y0 = stair.y0 != null ? stair.y0 : ((stair.meta && stair.meta.stairY0) || 0.25);
        const y1 = stair.y1 != null ? stair.y1 : ((stair.meta && stair.meta.stairY1) || 3.85);
        if (dir === '+x' || dir === '-x') {
          const sx = dir === '+x' ? min[0] - 1.45 : max[0] + 1.45;
          pos = [sx, y0 + 1.65, cz + 0.55];
          target = [cx + (dir === '+x' ? 0.9 : -0.9), (y0 + y1) * 0.52, cz];
        } else {
          const sz = dir === '+z' ? min[2] - 1.45 : max[2] + 1.45;
          pos = [cx + 0.55, y0 + 1.65, sz];
          target = [cx, (y0 + y1) * 0.52, cz + (dir === '+z' ? 0.9 : -0.9)];
        }
        fov = 62;
      } else {
        pos = [53.2, 1.9, -2.5];
        target = [58.5, 2.2, -5.5];
        fov = 62;
      }
    } else {
      return false;
    }

    const dx = target[0] - pos[0];
    const dy = target[1] - pos[1];
    const dz = target[2] - pos[2];
    const horiz = Math.hypot(dx, dz) || 1;
    Game.camera.pos = pos;
    Game.camera.yaw = Math.atan2(-dx, -dz);
    Game.camera.pitch = Math.atan2(dy, horiz);
    Game.camera.roll = 0;
    Game.camera.fov = fov;
    return true;
  }

  /* ------------------------------------------------------------------
   * Main Simulation & Render Loop
   * ------------------------------------------------------------------ */
  function stepSimulation(dt) {
    // Pending chained explosions
    for (let i = Game.pendingExplosions.length - 1; i >= 0; i--) {
      Game.pendingExplosions[i].delay -= dt;
      if (Game.pendingExplosions[i].delay <= 0) {
        const item = Game.pendingExplosions.splice(i, 1)[0];
        Game.applyExplosion(item.cfg);
      }
    }

    if (Game.phase === 'menu') {
      // Gentle living battlefield ambience during menu flyby
      safeCall(DF.Destruction, 'update', dt);
      safeCall(DF.Ballistics, 'update', dt);
      updateDynamicLights(dt);
      updateMenuCinematicCamera(Game.time);
      return;
    }

    if (Game.phase === 'paused') {
      return;
    }

    // Active playing or post-match slow wrap-up
    const simDt = Game.phase === 'ended' ? dt * 0.25 : dt;

    if (Game.phase === 'playing' && Game.controlMode === 'infantry') {
      updateInfantryPlayer(simDt);
    }

    const vehInput = buildVehiclePlayerInput();
    const unmInput = buildUnmannedPlayerInput();

    safeCall(DF.Armor, 'update', simDt, vehInput);
    safeCall(DF.Unmanned, 'update', simDt, unmInput);
    safeCall(DF.AI, 'update', simDt);
    safeCall(DF.Ballistics, 'update', simDt);
    safeCall(DF.Destruction, 'update', simDt);
    safeCall(DF.GameMode, 'update', simDt);

    if (Game.phase === 'playing' && Game.controlMode !== 'infantry') {
      updateVehicleOrUnmannedCamera(simDt);
    }

    // Check match victory / defeat
    if (Game.phase === 'playing' && DF.GameMode && typeof DF.GameMode.getState === 'function') {
      const gm = DF.GameMode.getState();
      if (gm && gm.winner) {
        Game.phase = 'ended';
        if (document.pointerLockElement === Game.canvas) {
          try { document.exitPointerLock(); } catch (_) {}
        }
      }
    }

    // Post-FX & camera shake decay
    Game.shakeTrauma = Math.max(0, Game.shakeTrauma - dt * 1.45);
    const shakeSq = Game.shakeTrauma * Game.shakeTrauma;
    Game.shakeOffset[0] = (Math.sin(Game.time * 47.3) * 0.08 + Math.cos(Game.time * 29.1) * 0.05) * shakeSq;
    Game.shakeOffset[1] = (Math.cos(Game.time * 53.7) * 0.09) * shakeSq;
    Game.shakeOffset[2] = (Math.sin(Game.time * 41.9) * 0.06) * shakeSq;
    Game.shakeRot[0] = Math.sin(Game.time * 38.2) * 0.045 * shakeSq;
    Game.shakeRot[1] = Math.cos(Game.time * 44.6) * 0.035 * shakeSq;
    Game.shakeRot[2] = Math.sin(Game.time * 31.4) * 0.04 * shakeSq;

    const ps = getPlayerSoldier();
    const playerSupp = ps && Game.controlMode === 'infantry' ? (ps.suppression || 0) : 0;
    const lowHp = ps && ps.state === 'alive' && ps.hp < 35 ? (35 - ps.hp) / 35 : 0;
    Game.postFX.suppression = damp(Game.postFX.suppression, playerSupp, 4.5, dt);
    Game.postFX.damageFlash = damp(Game.postFX.damageFlash, lowHp * 0.25, 4.0, dt);
    Game.postFX.concussion = damp(Game.postFX.concussion, 0, 2.2, dt);
    Game.postFX.muzzleExposure = damp(Game.postFX.muzzleExposure, 0, 18.0, dt);
    Game.postFX.vignette = clamp(0.16 + Game.postFX.suppression * 0.35 + lowHp * 0.32 + (Game.controlMode === 'downed' ? 0.45 : 0), 0.14, 0.85);
    Game.postFX.chromatic = damp(Game.postFX.chromatic, Game.postFX.concussion * 0.55 + Game.postFX.suppression * 0.22, 6.0, dt);

    if (Game.hitmarker.alpha > 0) Game.hitmarker.alpha = Math.max(0, Game.hitmarker.alpha - dt * 3.8);
    if (Game.damageIndicator.alpha > 0) Game.damageIndicator.alpha = Math.max(0, Game.damageIndicator.alpha - dt * 1.4);
    Game.combatIntensity = damp(Game.combatIntensity, 0.18, 0.18, dt);

    updateIFFVisibility(dt);
    updateDynamicLights(dt);

    // Update vehicle/drone/dog audio & adaptive score
    if (DF.Audio && typeof DF.Audio.updateVehicleLoops === 'function') {
      const vehicles = safeCall(DF.Armor, 'getVehicles') || [];
      const units = safeCall(DF.Unmanned, 'getUnits') || [];
      const drones = units.filter((u) => u.type === 'drone');
      const dogs = units.filter((u) => u.type === 'dog');
      DF.Audio.updateVehicleLoops(Game.camera.pos, vehicles, drones, dogs, Game.combatIntensity, dt);
    }
  }

  function updateIFFVisibility(dt) {
    if (Game.phase !== 'playing') {
      Game.crosshairTargetType = null;
      return;
    }
    const camPos = Game.camera.pos;
    const fwd = forwardFromYawPitch(Game.camera.yaw, Game.camera.pitch);
    const ps = getPlayerSoldier();
    const myFaction = (ps && ps.faction) || Game.playerFaction;
    const ignoreIds = [];
    if (ps && ps.id) ignoreIds.push(ps.id);
    if (Game.activeVehicle && Game.activeVehicle.colliderId) ignoreIds.push(Game.activeVehicle.colliderId);

    // 1. Crosshair hover IFF check (~16Hz)
    Game.crosshairScanTimer -= dt;
    if (Game.crosshairScanTimer <= 0) {
      Game.crosshairScanTimer = 0.06;
      let targetType = null;
      let bestDist = 98;
      if (DF.Physics && typeof DF.Physics.raycast === 'function') {
        const hit = DF.Physics.raycast(camPos, fwd, bestDist, {
          ignoreIds,
          checkEntities: true,
          checkVehicles: true,
        });
        if (hit) {
          bestDist = hit.dist || bestDist;
          const obj = hit.entity || hit.vehicle || hit.unmanned;
          if (obj && obj.faction && obj.state !== 'dead' && !obj.destroyed && obj.alive !== false) {
            targetType = obj.faction === myFaction ? 'ally' : 'enemy';
          }
        }
      }
      if (DF.Unmanned && typeof DF.Unmanned.raycastUnits === 'function') {
        const uHit = DF.Unmanned.raycastUnits(camPos, fwd, bestDist, null);
        if (uHit && uHit.unit && uHit.unit.alive !== false && !uHit.unit.destroyed && !uHit.unit.playerControlled) {
          targetType = uHit.unit.faction === myFaction ? 'ally' : 'enemy';
        }
      }
      Game.crosshairTargetType = targetType;
    }

    // 2. Throttled nearby enemy LOS scan (~9Hz) for 3D Overhead IFF Markers
    Game.iffScanTimer -= dt;
    if (Game.iffScanTimer <= 0) {
      Game.iffScanTimer = 0.11;
      const losMap = Object.create(null);
      const hasRay = DF.Physics && typeof DF.Physics.raycast === 'function';
      const hasSmoke = DF.Physics && typeof DF.Physics.lineBlockedBySmoke === 'function';

      const checkTargetLOS = (targetPos, maxDist) => {
        const dx = targetPos[0] - camPos[0];
        const dy = targetPos[1] - camPos[1];
        const dz = targetPos[2] - camPos[2];
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 0.8 || dist > maxDist) return false;
        const inv = 1 / dist;
        const dot = (dx * fwd[0] + dy * fwd[1] + dz * fwd[2]) * inv;
        if (dot < 0.22) return false;
        if (hasSmoke && dist > 4.0 && DF.Physics.lineBlockedBySmoke(camPos, targetPos)) return false;
        if (hasRay) {
          const block = DF.Physics.raycast(camPos, [dx * inv, dy * inv, dz * inv], Math.max(0.1, dist - 0.55), {
            ignoreIds,
            checkEntities: false,
            checkVehicles: false,
          });
          if (block) return false;
        }
        return true;
      };

      const soldiers = safeCall(DF.AI, 'getSoldiers') || [];
      for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i];
        if (!s || !s.pos) continue;
        if (s.state === 'dead' || s.inVehicleId) {
          s.inPlayerLOS = false;
          continue;
        }
        if (s.faction === myFaction) {
          s.inPlayerLOS = true;
          if (s.id) losMap[s.id] = true;
        } else {
          const eye = [s.pos[0], s.pos[1] + (s.crouching ? 0.95 : 1.48), s.pos[2]];
          const vis = checkTargetLOS(eye, 72);
          s.inPlayerLOS = vis;
          if (vis && s.id) losMap[s.id] = true;
        }
      }

      const vehicles = safeCall(DF.Armor, 'getVehicles') || [];
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        if (!v || !v.pos) continue;
        if (v.destroyed || v.alive === false) {
          v.inPlayerLOS = false;
          continue;
        }
        if (v.faction === myFaction) {
          v.inPlayerLOS = true;
          if (v.id) losMap[v.id] = true;
        } else {
          const vPt = [v.pos[0], v.pos[1] + 1.85, v.pos[2]];
          const vis = checkTargetLOS(vPt, 95);
          v.inPlayerLOS = vis;
          if (vis && v.id) losMap[v.id] = true;
        }
      }

      const units = safeCall(DF.Unmanned, 'getUnits') || [];
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (!u || !u.pos) continue;
        if (u.destroyed || u.alive === false) {
          u.inPlayerLOS = false;
          continue;
        }
        if (u.faction === myFaction) {
          u.inPlayerLOS = true;
          if (u.id) losMap[u.id] = true;
        } else {
          const uPt = [u.pos[0], u.pos[1] + (u.type === 'dog' ? 0.55 : 0.1), u.pos[2]];
          const vis = checkTargetLOS(uPt, 80);
          u.inPlayerLOS = vis;
          if (vis && u.id) losMap[u.id] = true;
        }
      }

      Game.losVisible = losMap;
    }
  }

  function renderScene(dt) {
    if (!DF.Renderer) return;

    // Apply diagnostic view camera override if active
    const inDiag = applyDiagnosticCamera();
    const isWireframe = Game.diagnosticView === 'wireframe';
    safeCall(DF.Renderer, 'setWireframe', isWireframe);

    const camPos = inDiag
      ? Game.camera.pos
      : [
          Game.camera.pos[0] + Game.shakeOffset[0],
          Game.camera.pos[1] + Game.shakeOffset[1],
          Game.camera.pos[2] + Game.shakeOffset[2],
        ];
    const camYaw = Game.camera.yaw + (inDiag ? 0 : Game.shakeRot[1]);
    const camPitch = clamp(Game.camera.pitch + (inDiag ? 0 : Game.shakeRot[0]), -1.5, 1.5);
    const camRoll = Game.camera.roll + (inDiag ? 0 : Game.shakeRot[2]);

    // Compute view, proj & combined viewProj matrices if DF.Mat4 is present
    const aspect = Game.canvas.width / Math.max(1, Game.canvas.height);
    if (DF.Mat4) {
      if (!Game.camera.viewMat) Game.camera.viewMat = DF.Mat4.create();
      if (!Game.camera.projMat) Game.camera.projMat = DF.Mat4.create();
      if (!Game.camera.viewProjMat) Game.camera.viewProjMat = DF.Mat4.create();
      const fwd = forwardFromYawPitch(camYaw, camPitch);
      const center = [camPos[0] + fwd[0], camPos[1] + fwd[1], camPos[2] + fwd[2]];
      const up = [Math.sin(camRoll), Math.cos(camRoll), 0];
      DF.Mat4.lookAt(Game.camera.viewMat, camPos, center, up);
      DF.Mat4.perspective(Game.camera.projMat, (Game.camera.fov * Math.PI) / 180, aspect, Game.camera.near, Game.camera.far);
      DF.Mat4.multiply(Game.camera.viewProjMat, Game.camera.projMat, Game.camera.viewMat);
    }

    DF.Renderer.setCamera({
      pos: camPos,
      yaw: camYaw,
      pitch: camPitch,
      roll: camRoll,
      fov: Game.camera.fov,
      near: Game.camera.near,
      far: Game.camera.far,
      viewMat: Game.camera.viewMat,
      projMat: Game.camera.projMat,
    });
    safeCall(DF.Audio, 'setListener', camPos, camYaw, camPitch);

    safeCall(DF.Renderer, 'setVisionMode', inDiag ? 'normal' : Game.visionMode);
    safeCall(DF.Renderer, 'setPostFX', inDiag ? { suppression: 0, damageFlash: 0, concussion: 0, vignette: 0.1, chromatic: 0, muzzleExposure: 0 } : Game.postFX);

    DF.Renderer.beginFrame(Game.time, dt);

    submitDynamicLights();

    safeCall(DF.Map, 'render', DF.Renderer, Game.time);
    safeCall(DF.Destruction, 'render', DF.Renderer, Game.time);
    safeCall(DF.Armor, 'render', DF.Renderer, Game.time);
    safeCall(DF.Unmanned, 'render', DF.Renderer, Game.time);
    safeCall(DF.AI, 'render', DF.Renderer, Game.time);
    safeCall(DF.Ballistics, 'render', DF.Renderer, Game.time);

    // Render 1st-person viewmodel ONLY when in active infantry gameplay and not scoped into full sniper reticle
    if (
      Game.phase === 'playing' &&
      Game.controlMode === 'infantry' &&
      !inDiag &&
      Game.visionMode !== 'optic'
    ) {
      safeCall(DF.Viewmodel, 'render', DF.Renderer, {
        pos: camPos,
        yaw: camYaw,
        pitch: camPitch,
        roll: camRoll,
        fov: Game.camera.fov,
        adsBlend: Game.adsBlend,
      });
    }

    safeCall(DF.Renderer, 'updateParticles', dt);
    DF.Renderer.endFrame();
  }

  function buildUISnapshot() {
    const ps = getPlayerSoldier();
    const ws = getActiveWeaponState();
    const faction = (ps && ps.faction) || Game.playerFaction;
    const spec = ws ? getWeaponSpec(ws.slot, faction) : null;
    const soldiers = safeCall(DF.AI, 'getSoldiers') || [];
    const allies = soldiers.filter((s) => s.faction === faction && !s.isPlayer);
    const vehicles = safeCall(DF.Armor, 'getVehicles') || [];
    const unmanned = safeCall(DF.Unmanned, 'getUnits') || [];
    const controlledUnmanned = safeCall(DF.Unmanned, 'getControlledUnit') || null;
    const gmState = safeCall(DF.GameMode, 'getState') || {};
    const sectors = safeCall(DF.Map, 'getSectors') || gmState.sectors || [];

    // Find approaching medic distance if player is downed
    let medicDist = null;
    if (ps && ps.state === 'downed') {
      for (let i = 0; i < allies.length; i++) {
        const a = allies[i];
        if (a.state === 'alive') {
          const d = dist3(ps.pos, a.pos);
          if (medicDist === null || d < medicDist) medicDist = d;
        }
      }
    }

    const fireModes = (spec && spec.fireModes) || ['auto'];
    const fireMode = fireModes[(ws ? ws.fireModeIdx : 0) % fireModes.length] || 'auto';
    const vmState = safeCall(DF.Viewmodel, 'getState') || {};

    return {
      phase: Game.phase,
      faction,
      playerFaction: faction,
      controlMode: Game.controlMode,
      visionMode: Game.visionMode,
      hideHUD: Game.hideHUD,
      settings: Game.settings,
      time: Game.time,
      viewProj: Game.camera.viewProjMat,
      viewProjMat: Game.camera.viewProjMat,
      crosshairTargetType: Game.crosshairTargetType,
      losVisible: Game.losVisible,
      camera: {
        pos: Game.camera.pos,
        yaw: Game.camera.yaw,
        pitch: Game.camera.pitch,
        fov: Game.camera.fov,
      },
      player: ps
        ? {
            id: ps.id,
            name: ps.name,
            role: ps.role,
            hp: Math.round(ps.hp || 0),
            maxHp: ps.maxHp || 100,
            state: ps.state,
            crouching: !!ps.crouching,
            sprinting: Game.isSprinting,
            adsBlend: Game.adsBlend,
            suppression: ps.suppression || 0,
            bleedTimer: ps.bleedTimer || 0,
            reviveProgress: ps.reviveProgress || 0,
            medicDist,
            pos: ps.pos,
            vel: ps.vel,
            weaponSlot: ps.weaponSlot || 0,
          }
        : null,
      weapon: ws && spec
        ? {
            slot: ws.slot,
            id: spec.id,
            name: spec.displayName || spec.name,
            caliber: spec.caliber || '',
            mag: ws.mag,
            magSize: ws.magSize,
            reserve: ws.reserve,
            reloading: ws.reloading,
            reloadProgress: ws.reloading ? clamp(1 - ws.reloadTimer / Math.max(0.01, ws.reloadDuration), 0, 1) : 0,
            reloadStage: vmState.reloadStageLabel || '',
            fireMode,
            scopeType: spec.scopeType || 'iron',
            adsBlend: Game.adsBlend,
            fragCount: Game.fragCount,
            smokeCount: Game.smokeCount,
          }
        : null,
      vehicle: Game.activeVehicle
        ? {
            id: Game.activeVehicle.id,
            name: Game.activeVehicle.displayName || Game.activeVehicle.name,
            type: Game.activeVehicle.type,
            hp: Math.round(Game.activeVehicle.hp || 0),
            maxHp: Game.activeVehicle.maxHp || 1000,
            hullYaw: Game.activeVehicle.yaw || 0,
            turretYaw: Game.activeVehicle.turretYaw || 0,
            speed: Math.abs(Game.activeVehicle.speed || 0),
            camMode: Game.vehicleCamMode,
            mainReload: Game.activeVehicle.mainCooldown || 0,
            mainReloadMax: Game.activeVehicle.mainReloadTime || 4.2,
            secAmmo: Game.activeVehicle.coaxAmmo != null ? Game.activeVehicle.coaxAmmo : (Game.activeVehicle.atgmAmmo != null ? Game.activeVehicle.atgmAmmo : 200),
            smokeReady: (Game.activeVehicle.smokeCooldown || 0) <= 0,
          }
        : null,
      unmannedUnit: controlledUnmanned,
      allies,
      soldiers,
      vehicles,
      unmanned,
      sectors,
      buildings: safeCall(DF.Map, 'getBuildings') || null,
      tickets: gmState.tickets || null,
      activeCounts: gmState.activeCounts || gmState.counts || null,
      playerRespawnTimer: gmState.playerRespawnTimer != null ? gmState.playerRespawnTimer : 0,
      sprintBlend: Game.sprintBlend,
      stridePhase: Game.stridePhase,
      gameMode: gmState,
      hitmarker: Game.hitmarker,
      damageIndicator: Game.damageIndicator,
      interactPrompt: Game.interactPrompt,
      reviveChannelProgress: Game.reviveChannelTarget ? clamp(Game.reviveChannelTimer / 2.2, 0, 1) : 0,
      mapOpen: Game.mapOpen,
      radialOpen: Game.radialOpen,
      stats: Game.stats,
      rendererStats: safeCall(DF.Renderer, 'getStats') || {},
    };
  }

  function frameLoop(ts) {
    if (!Game.running) return;
    requestAnimationFrame(frameLoop);

    const rawDt = Game.lastFrameTs ? (ts - Game.lastFrameTs) / 1000 : 1 / 60;
    Game.lastFrameTs = ts;
    const dt = clamp(rawDt, 0.001, 0.05);
    Game.time += dt;
    Game.frameCount++;

    // Fixed-step cap to keep physics/AI deterministic under low FPS
    const FIXED = 1 / 60;
    Game.physAccum = Math.min(Game.physAccum + dt, 0.1);
    while (Game.physAccum >= FIXED) {
      stepSimulation(FIXED);
      Game.physAccum -= FIXED;
    }

    renderScene(dt);
    safeCall(DF.UI, 'update', dt, buildUISnapshot());
  }

  /* ------------------------------------------------------------------
   * Resize & Event Wiring
   * ------------------------------------------------------------------ */
  function handleResize() {
    if (!Game.canvas) return;
    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 720;
    if (DF.Renderer && typeof DF.Renderer.resize === 'function') {
      DF.Renderer.resize(w, h);
    } else {
      const dpr = Math.min(window.devicePixelRatio || 1, Game.settings.quality === 'ultra' ? 2 : 1.5);
      Game.canvas.width = Math.max(1, Math.floor(w * dpr));
      Game.canvas.height = Math.max(1, Math.floor(h * dpr));
    }
  }

  function wireEvents() {
    if (!DF.Events || typeof DF.Events.on !== 'function') return;
    DF.Events.on('ui:startMatch', (d) => Game.startMatch(typeof d === 'string' ? d : d && d.faction));
    DF.Events.on('ui:resume', () => Game.setPaused(false));
    DF.Events.on('ui:pause', (paused) => {
      if (paused && Game.phase === 'playing') Game.setPaused(true);
      else if (!paused && Game.phase === 'paused') Game.setPaused(false);
    });
    DF.Events.on('ui:restart', () => Game.startMatch(Game.playerFaction));
    DF.Events.on('ui:switchFaction', (f) => Game.startMatch(typeof f === 'string' ? f : (Game.playerFaction === 'UA' ? 'RU' : 'UA')));
    DF.Events.on('ui:settings', (s) => Game.applySettings(s));
    DF.Events.on('ui:order', (d) => {
      if (typeof d === 'string') Game.issueOrder(d);
      else if (d) Game.issueOrder(d.order, d.pos, d.entity);
    });
    DF.Events.on('ui:mapWaypoint', (d) => {
      if (d && d.pos) Game.issueOrder(d.order || 'attack', d.pos);
    });
    DF.Events.on('ui:takeOverAlly', () => Game.takeOverNextAlly());
    DF.Events.on('ui:respawnNow', () => Game.respawnPlayerNow());
    DF.Events.on('ui:skipBleedout', () => {
      if (DF.GameMode && typeof DF.GameMode.skipBleedout === 'function') {
        const res = DF.GameMode.skipBleedout();
        if (res === false) Game.respawnPlayerNow();
      } else {
        Game.respawnPlayerNow();
      }
    });
    DF.Events.on('player:respawned', (ev) => {
      const ps = (ev && ev.soldier) || getPlayerSoldier();
      if (ps && ps.state === 'alive') {
        onPlayerBodyRestored(ps, '增援自动复活完成，重返战斗！');
      }
    });
    DF.Events.on('destruction:collapsed', () => {
      Game.stats.wallsBreached++;
    });
    DF.Events.on('combat:suppression', (d) => {
      if (!d || d.faction === Game.playerFaction) return;
      const amt = clamp(d.amount || 0.25, 0, 0.8);
      Game.postFX.suppression = clamp(Game.postFX.suppression + amt * 0.55, 0, 1);
      Game.shakeTrauma = clamp(Game.shakeTrauma + amt * 0.14, 0, 1);
      const ps = getPlayerSoldier();
      if (ps && ps.state === 'alive') {
        ps.suppression = clamp((ps.suppression || 0) + amt * 0.5, 0, 1);
      }
    });
  }

  /* ------------------------------------------------------------------
   * Initialization
   * ------------------------------------------------------------------ */
  Game.init = function () {
    if (Game.initialized) return;
    Game.initialized = true;
    loadSettings();

    Game.canvas = document.getElementById('gl-canvas');
    if (!Game.canvas) {
      Game.canvas = document.createElement('canvas');
      Game.canvas.id = 'gl-canvas';
      document.body.appendChild(Game.canvas);
    }
    Game.uiContainer = document.getElementById('ui-layer');
    if (!Game.uiContainer) {
      Game.uiContainer = document.createElement('div');
      Game.uiContainer.id = 'ui-layer';
      document.body.appendChild(Game.uiContainer);
    }

    handleResize();
    window.addEventListener('resize', handleResize);

    // 1. Initialize Renderer & WebGL2
    const initOk = safeCall(DF.Renderer, 'init', Game.canvas, Game.settings.quality);
    Game.gl = (DF.Renderer && DF.Renderer.gl) || Game.canvas.getContext('webgl2');
    if (!Game.gl || initOk === false) {
      Game.uiContainer.innerHTML =
        '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#e6edf3;font-family:monospace;padding:32px;text-align:center">' +
        '<div><h2>WebGL2 初始化失败</h2><p>请使用支持 WebGL2 的现代桌面浏览器打开此文件。</p></div></div>';
      return;
    }

    // 2. Initialize all domain modules in contract order (skip duplicate Textures.init if Renderer already ran it)
    if (DF.Textures && !(typeof DF.Textures.get === 'function' && DF.Textures.get('concrete'))) {
      safeCall(DF.Textures, 'init', Game.gl, Game.settings.quality);
    }
    if (DF.MeshGen && typeof DF.MeshGen.Primitives === 'function') {
      DF.MeshGen.Primitives(Game.gl);
    }
    safeCall(DF.Physics, 'init');
    safeCall(DF.Destruction, 'init', Game.gl);
    safeCall(DF.Map, 'init', Game.gl);
    safeCall(DF.Audio, 'init');
    safeCall(DF.Audio, 'setVolumes', {
      master: Game.settings.masterVol,
      sfx: Game.settings.sfxVol,
      music: Game.settings.musicVol,
    });
    safeCall(DF.Viewmodel, 'init', Game.gl);
    safeCall(DF.Ballistics, 'init', Game.gl);
    safeCall(DF.Armor, 'init', Game.gl);
    safeCall(DF.Unmanned, 'init', Game.gl);
    safeCall(DF.Character, 'init', Game.gl);
    safeCall(DF.AI, 'init', 'UA');
    safeCall(DF.GameMode, 'init', 'UA');
    safeCall(DF.GameMode, 'setPhase', 'briefing');
    initPlayerWeaponStates('UA', 0);
    safeCall(DF.UI, 'init', Game.uiContainer);

    wireEvents();
    bindInputs();

    Game.running = true;
    Game.lastFrameTs = performance.now();
    requestAnimationFrame(frameLoop);
  };

  /* ------------------------------------------------------------------
   * Automated Verification & 4-Viewpoint Diagnostic API (window.DF_DEBUG)
   * ------------------------------------------------------------------ */
  window.DF_DEBUG = {
    setDiagnosticView(mode) {
      const valid = ['gameplay', 'overview', 'closeup', 'ground', 'wireframe', 'soldiers', 'rpg', 'interior_stairs', 'sprint'];
      Game.diagnosticView = valid.includes(mode) ? mode : 'gameplay';
      Game.customCameraOverride = null;
      Game.sprintDemo = Game.diagnosticView === 'sprint';
      safeCall(DF.Renderer, 'setWireframe', Game.diagnosticView === 'wireframe');
      if (Game.diagnosticView === 'rpg' || Game.diagnosticView === 'sprint') {
        const ps = getPlayerSoldier();
        if (ps && ps.state !== 'alive') window.DF_DEBUG.revivePlayer();
        if (Game.controlMode !== 'infantry') window.DF_DEBUG.switchControl('infantry');
        switchWeaponSlot(Game.diagnosticView === 'rpg' ? 5 : 0);
        Game.equipTimer = 0;
        Game.isAds = false;
        Game.adsBlend = 0;
        Game.visionMode = 'normal';
        if (Game.diagnosticView === 'sprint') {
          Game.isSprinting = true;
          Game.sprintBlend = 1.0;
        }
        const ps2 = getPlayerSoldier();
        if (ps2) {
          ps2.pitch = 0.02;
          ps2.crouching = false;
        }
      }
      return Game.diagnosticView;
    },

    setSprintDemo(enabled) {
      Game.sprintDemo = !!enabled;
      Game.isSprinting = Game.sprintDemo;
      if (Game.sprintDemo) Game.sprintBlend = 1.0;
      return { sprintDemo: Game.sprintDemo, sprintBlend: Game.sprintBlend };
    },

    teleportPlayer(x, y, z, yaw, pitch) {
      const ps = getPlayerSoldier();
      if (!ps) return null;
      if (ps.state !== 'alive') window.DF_DEBUG.revivePlayer();
      if (Game.controlMode !== 'infantry') window.DF_DEBUG.switchControl('infantry');
      ps.pos[0] = Number(x) || 0;
      ps.pos[1] = Number(y) != null ? Number(y) : 0;
      ps.pos[2] = Number(z) || 0;
      ps.vel = [0, 0, 0];
      if (yaw != null) ps.yaw = Number(yaw);
      if (pitch != null) ps.pitch = clamp(Number(pitch), -1.45, 1.45);
      ps.crouching = false;
      return { pos: [ps.pos[0], ps.pos[1], ps.pos[2]], yaw: ps.yaw, pitch: ps.pitch };
    },

    respawnPlayerNow() {
      return Game.respawnPlayerNow();
    },

    getStairs() {
      if (DF.Map && typeof DF.Map.getStairs === 'function') {
        return DF.Map.getStairs();
      }
      if (DF.Physics && typeof DF.Physics.getColliders === 'function') {
        return (DF.Physics.getColliders() || [])
          .filter((c) => c && c.meta && c.meta.type === 'stair')
          .map((c) => ({
            id: c.id,
            min: c.min,
            max: c.max,
            dir: c.meta.stairDir,
            y0: c.meta.stairY0,
            y1: c.meta.stairY1,
          }));
      }
      return [];
    },

    setADS(enabled, instant) {
      Game.isAds = !!enabled;
      if (instant) {
        Game.adsBlend = Game.isAds ? 1 : 0;
        const ps = getPlayerSoldier();
        const ws = getActiveWeaponState();
        const spec = ws ? getWeaponSpec(ws.slot, (ps && ps.faction) || Game.playerFaction) : null;
        if (spec) {
          Game.currentFov = lerp(Game.settings.baseFov, spec.adsFov || 52, Game.adsBlend);
          const isScopedOptic = Game.adsBlend > 0.80 && (spec.scopeType === 'pso' || spec.scopeType === 'mildot' || spec.scopeType === 'pgo7');
          Game.visionMode = isScopedOptic ? 'optic' : 'normal';
        }
      }
      return { ads: Game.isAds, adsBlend: Game.adsBlend, visionMode: Game.visionMode };
    },

    setCameraOverride(pos, yaw, pitch, fov) {
      Game.customCameraOverride = { pos, yaw, pitch, fov: fov || 65 };
    },

    clearCameraOverride() {
      Game.customCameraOverride = null;
    },

    rotateAim(dx, dy) {
      Game.mouseDeltaX += Number(dx) || 0;
      Game.mouseDeltaY += Number(dy) || 0;
      return { mouseDeltaX: Game.mouseDeltaX, mouseDeltaY: Game.mouseDeltaY };
    },

    setHideHUD(bool) {
      Game.hideHUD = !!bool;
      if (Game.uiContainer) {
        Game.uiContainer.style.display = Game.hideHUD ? 'none' : '';
        Game.uiContainer.classList.toggle('df-hide-hud', Game.hideHUD);
      }
      safeCall(DF.UI, 'setHidden', Game.hideHUD);
      return Game.hideHUD;
    },

    setVisionMode(mode) {
      Game.visionMode = mode || 'normal';
      safeCall(DF.Renderer, 'setVisionMode', Game.visionMode);
      return Game.visionMode;
    },

    startMatch(faction) {
      Game.startMatch(faction || 'UA');
      return Game.playerFaction;
    },

    switchControl(mode) {
      const m = (mode || 'infantry').toLowerCase();
      const ps = getPlayerSoldier();
      if (m === 'infantry') {
        if (Game.controlMode === 'drone' || Game.controlMode === 'dog') safeCall(DF.Unmanned, 'releaseControl');
        if (Game.activeVehicle) exitCurrentVehicle();
        Game.controlMode = 'infantry';
        Game.visionMode = 'normal';
        return 'infantry';
      }
      if (m === 'tank' || m === 'ifv') {
        if (!ps || ps.state !== 'alive') return null;
        if (Game.controlMode === 'drone' || Game.controlMode === 'dog') safeCall(DF.Unmanned, 'releaseControl');
        if (Game.activeVehicle) exitCurrentVehicle();
        const vehs = safeCall(DF.Armor, 'getVehicles') || [];
        const matchType = (v) => {
          const t = ((v.type || '') + ' ' + (v.role || '') + ' ' + (v.name || '')).toLowerCase();
          return m === 'tank' ? /tank|mbt|t-64|t-72/.test(t) : /ifv|bradley|bmp/.test(t);
        };
        const target =
          vehs.find((v) => !v.destroyed && v.alive !== false && v.faction === Game.playerFaction && matchType(v)) ||
          vehs.find((v) => !v.destroyed && v.alive !== false && matchType(v)) ||
          vehs.find((v) => !v.destroyed && v.alive !== false);
        if (target && enterVehicle(target)) {
          return Game.controlMode;
        }
        return null;
      }
      if (m === 'drone' || m === 'dog') {
        if (!ps || ps.state !== 'alive') return null;
        if (Game.controlMode !== m) toggleUnmannedControl(m);
        return Game.controlMode;
      }
      return Game.controlMode;
    },

    setVehicleCamMode(camMode) {
      Game.vehicleCamMode = clamp(camMode | 0, 0, 2);
      Game.visionMode = Game.vehicleCamMode === 2 ? 'thermal_white' : 'normal';
      if (Game.activeVehicle) {
        Game.activeVehicle.camMode = Game.vehicleCamMode;
        Game.activeVehicle.thermalMode = Game.vehicleCamMode === 2;
      }
      return Game.vehicleCamMode;
    },

    triggerExplosionDemo() {
      // Pick an intact destructible piece near Sector A/B or in front of camera
      let targetPos = [-28, 1.2, -11];
      if (DF.Destruction && typeof DF.Destruction.getPieces === 'function') {
        const pieces = DF.Destruction.getPieces() || [];
        const intact = pieces.find((p) => p && !p.collapsed && p.state !== 'collapsed' && p.explosive) ||
                       pieces.find((p) => p && !p.collapsed && p.state !== 'collapsed');
        if (intact && intact.pos) {
          targetPos = [intact.pos[0], intact.pos[1] + 0.6, intact.pos[2]];
        }
      }
      Game.applyExplosion({
        pos: targetPos,
        radius: 10.5,
        damage: 240,
        attacker: getPlayerSoldier(),
        weaponId: 'RPG-7V2',
        isAntiArmor: true,
      });
      return { pos: targetPos, wallsBreached: Game.stats.wallsBreached };
    },

    selectWeapon(slot) {
      switchWeaponSlot(slot);
      return getActiveWeaponState();
    },

    fireOnce() {
      const ps = getPlayerSoldier();
      const ws = getActiveWeaponState();
      if (!ps || !ws) return false;
      const spec = getWeaponSpec(ws.slot, ps.faction || Game.playerFaction);
      ws.cooldown = 0;
      Game.equipTimer = 0;
      return firePlayerInfantryWeapon(ps, ws, spec);
    },

    reload() {
      startReload();
      return getActiveWeaponState();
    },

    throwGrenade(type) {
      throwPlayerGrenade(type || 'frag');
      return { fragCount: Game.fragCount, smokeCount: Game.smokeCount };
    },

    issueOrder(order, pos) {
      Game.issueOrder(order || 'attack', pos);
      return order;
    },

    takeOverNextAlly() {
      return Game.takeOverNextAlly();
    },

    downPlayer() {
      const ps = getPlayerSoldier();
      if (ps) {
        ps.state = 'downed';
        ps.hp = 15;
        ps.bleedTimer = 25;
        checkPlayerAliveTransition(ps);
      }
      return Game.controlMode;
    },

    revivePlayer() {
      const ps = getPlayerSoldier();
      if (!ps) return null;
      if (Game.controlMode === 'drone' || Game.controlMode === 'dog') {
        safeCall(DF.Unmanned, 'releaseControl');
      }
      if (Game.activeVehicle) exitCurrentVehicle();
      ps.state = 'alive';
      ps.hp = ps.maxHp || 100;
      ps.bleedTimer = 0;
      ps.reviveProgress = 0;
      ps.reviverId = null;
      ps.inVehicleId = null;
      ps.suppression = 0;
      if (DF.Physics && typeof DF.Physics.getGroundY === 'function' && ps.pos) {
        ps.pos[1] = DF.Physics.getGroundY(ps.pos[0], ps.pos[2], ps.pos[1] + 0.8);
      }
      Game.controlMode = 'infantry';
      Game.visionMode = 'normal';
      Game.eyeHeight = ps.crouching ? CROUCH_EYE : STAND_EYE;
      Game.postFX.damageFlash = 0;
      Game.postFX.concussion = 0;
      return { state: ps.state, hp: ps.hp, controlMode: Game.controlMode };
    },

    getState() {
      const soldiers = safeCall(DF.AI, 'getSoldiers') || [];
      let uaAlive = 0;
      let ruAlive = 0;
      let maxFloatErr = 0;
      let nanCount = 0;
      for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i];
        if (!s || !s.pos) continue;
        if (Number.isNaN(s.pos[0]) || Number.isNaN(s.pos[1]) || Number.isNaN(s.pos[2])) {
          nanCount++;
          continue;
        }
        if (s.state !== 'dead') {
          if (s.faction === 'UA') uaAlive++;
          else if (s.faction === 'RU') ruAlive++;
          if (!s.inVehicleId && DF.Physics && typeof DF.Physics.getGroundY === 'function') {
            const gy = DF.Physics.getGroundY(s.pos[0], s.pos[2], s.pos[1] + 0.5);
            const err = Math.abs(s.pos[1] - gy);
            if (err > maxFloatErr) maxFloatErr = err;
          }
        }
      }
      const ps = getPlayerSoldier();
      const ws = getActiveWeaponState();
      const vehicles = (safeCall(DF.Armor, 'getVehicles') || []).map((v) => ({
        id: v.id,
        name: v.displayName || v.name,
        faction: v.faction,
        type: v.type,
        hp: v.hp,
        destroyed: !!v.destroyed,
        pos: v.pos ? [v.pos[0], v.pos[1], v.pos[2]] : null,
      }));
      const unmanned = (safeCall(DF.Unmanned, 'getUnits') || []).map((u) => ({
        id: u.id,
        type: u.type,
        faction: u.faction,
        hp: u.hp,
        destroyed: !!u.destroyed,
        controlled: !!u.playerControlled,
        pos: u.pos ? [u.pos[0], u.pos[1], u.pos[2]] : null,
      }));

      return {
        phase: Game.phase,
        faction: Game.playerFaction,
        controlMode: Game.controlMode,
        diagnosticView: Game.diagnosticView,
        visionMode: Game.visionMode,
        vehicleCamMode: Game.vehicleCamMode,
        ads: Game.isAds,
        adsBlend: Number(Game.adsBlend.toFixed(3)),
        vaulting: !!Game.vault,
        vaultProgress: Game.vault ? Number(Game.vault.t.toFixed(3)) : 0,
        interactPrompt: Game.interactPrompt || '',
        fov: Number(Game.camera.fov.toFixed(2)),
        hideHUD: Game.hideHUD,
        frameCount: Game.frameCount,
        soldiersTotal: soldiers.length,
        uaTotal: soldiers.filter((s) => s.faction === 'UA').length,
        ruTotal: soldiers.filter((s) => s.faction === 'RU').length,
        uaAlive,
        ruAlive,
        nanPositions: nanCount,
        maxSoldierGroundError: Number(maxFloatErr.toFixed(4)),
        player: ps
          ? {
              id: ps.id,
              name: ps.name,
              faction: ps.faction,
              hp: ps.hp,
              state: ps.state,
              pos: [ps.pos[0], ps.pos[1], ps.pos[2]],
              weaponSlot: ps.weaponSlot,
              mag: ws ? ws.mag : 0,
              reserve: ws ? ws.reserve : 0,
              reloading: ws ? ws.reloading : false,
              fragCount: Game.fragCount,
              smokeCount: Game.smokeCount,
            }
          : null,
        vehicles,
        unmanned,
        sectors: safeCall(DF.Map, 'getSectors') || [],
        gameMode: safeCall(DF.GameMode, 'getState') || {},
        stats: { ...Game.stats },
      };
    },

    getStats() {
      const rStats = safeCall(DF.Renderer, 'getStats') || {};
      return {
        ...rStats,
        frameCount: Game.frameCount,
        activeFlashLights: Game.dynamicLights.length,
        wallsBreached: Game.stats.wallsBreached,
      };
    },
  };

  DF.Game = Game;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Game.init());
  } else {
    Game.init();
  }
})();
