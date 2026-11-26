(() => {
  'use strict';
  const DF = (window.DF = window.DF || {});

  // ---------------------------------------------------------------------------
  // DF.AI: 5v20 Asymmetric Urban Tactical AI Engine
  // - 5 Elite Ukrainian Defenders (Interlocking 2nd-floor defense, AT ambush,
  //   proactive medic revives, fighting withdrawal A -> B -> C)
  // - 20 Russian Attackers in 4 Coordinated Squads (Assault, Suppression,
  //   North Flank, South Flank & Armor Crew)
  // - Truly useful Player Squad Commands (F1..F6), Auto-Medic Revive,
  //   Vehicle Crew AI, Smoke Occlusion, Dynamic Cover Destruction Reaction,
  //   and Player-Body Self-Preservation during Drone/Robot-Dog control!
  // ---------------------------------------------------------------------------

  const MAX_SPEED_WALK = 2.6;
  const MAX_SPEED_RUN = 4.6;
  const MAX_SPEED_SPRINT = 5.9;
  const MAX_SPEED_CROUCH = 2.1;
  const SOLDIER_RADIUS = 0.38;
  const SOLDIER_HEIGHT_STAND = 1.76;
  const SOLDIER_HEIGHT_CROUCH = 1.24;
  const BLEED_TIME_PLAYER_WITH_ALLY = 18.0;
  const BLEED_TIME_PLAYER_SOLO = 10.0;
  const BLEED_TIME_UA = 22.0;
  const BLEED_TIME_RU = 16.0;
  const AI_RESPAWN_TIME_UA = 10.0;
  const AI_RESPAWN_TIME_RU = 12.0;
  const REVIVE_TIME_MEDIC = 2.2;
  const REVIVE_TIME_NORMAL = 3.2;

  // Faction rosters (5 Blue Team Defenders + 20 Red Team Attackers = 25 total)
  const UA_ROSTER = [
    { id: 'ua_1', callsign: 'BLU-1', name: '蓝刃-01 队长', role: 'rifleman', squadId: 'UA_ALPHA', weaponSlot: 0, backupSlot: 0, maxHp: 135 },
    { id: 'ua_2', callsign: 'BLU-2', name: '蓝盾-02 机枪手', role: 'mg',       squadId: 'UA_ALPHA', weaponSlot: 1, backupSlot: 0, maxHp: 135 },
    { id: 'ua_3', callsign: 'BLU-3', name: '蓝鹰-03 狙击手', role: 'sniper',   squadId: 'UA_ALPHA', weaponSlot: 2, backupSlot: 0, maxHp: 130 },
    { id: 'ua_4', callsign: 'BLU-4', name: '蓝矛-04 反坦克', role: 'at',       squadId: 'UA_ALPHA', weaponSlot: 5, backupSlot: 0, maxHp: 135 },
    { id: 'ua_5', callsign: 'BLU-5', name: '蓝翼-05 医疗兵', role: 'medic',    squadId: 'UA_ALPHA', weaponSlot: 0, backupSlot: 3, maxHp: 135 }
  ];

  const RU_ROSTER = [
    // Squad 1: Center Assault & Breach (5)
    { id: 'ru_1',  callsign: 'RED-1A', name: '红锋-1A 突击长', role: 'rifleman', squadId: 'RU_ASSAULT',  weaponSlot: 0, backupSlot: 0, maxHp: 100 },
    { id: 'ru_2',  callsign: 'RED-1B', name: '红锋-1B 步枪手', role: 'rifleman', squadId: 'RU_ASSAULT',  weaponSlot: 0, backupSlot: 0, maxHp: 100 },
    { id: 'ru_3',  callsign: 'RED-1C', name: '红锋-1C 榴弹手', role: 'rifleman', squadId: 'RU_ASSAULT',  weaponSlot: 4, backupSlot: 0, maxHp: 100 },
    { id: 'ru_4',  callsign: 'RED-1D', name: '红锋-1D 破门手', role: 'rifleman', squadId: 'RU_ASSAULT',  weaponSlot: 3, backupSlot: 0, maxHp: 100 },
    { id: 'ru_5',  callsign: 'RED-1M', name: '红锋-1M 医疗兵', role: 'medic',    squadId: 'RU_ASSAULT',  weaponSlot: 0, backupSlot: 0, maxHp: 100 },
    // Squad 2: Avenue Suppression & Marksman Base-of-Fire (5)
    { id: 'ru_6',  callsign: 'RED-2A', name: '红焰-2A 步枪手', role: 'rifleman', squadId: 'RU_SUPPRESS', weaponSlot: 0, backupSlot: 0, maxHp: 100 },
    { id: 'ru_7',  callsign: 'RED-2B', name: '红焰-2B 机枪手', role: 'mg',       squadId: 'RU_SUPPRESS', weaponSlot: 1, backupSlot: 0, maxHp: 105 },
    { id: 'ru_8',  callsign: 'RED-2C', name: '红焰-2C 压制手', role: 'mg',       squadId: 'RU_SUPPRESS', weaponSlot: 1, backupSlot: 0, maxHp: 105 },
    { id: 'ru_9',  callsign: 'RED-2D', name: '红焰-2D 精准手', role: 'sniper',   squadId: 'RU_SUPPRESS', weaponSlot: 2, backupSlot: 0, maxHp: 95  },
    { id: 'ru_10', callsign: 'RED-2M', name: '红焰-2M 医疗兵', role: 'medic',    squadId: 'RU_SUPPRESS', weaponSlot: 0, backupSlot: 0, maxHp: 100 },
    // Squad 3: North Flank Alley & Building Infiltration (5)
    { id: 'ru_11', callsign: 'RED-3A', name: '红狼-3A 侧翼长', role: 'rifleman', squadId: 'RU_NORTH',    weaponSlot: 0, backupSlot: 0, maxHp: 100 },
    { id: 'ru_12', callsign: 'RED-3B', name: '红狼-3B 步枪手', role: 'rifleman', squadId: 'RU_NORTH',    weaponSlot: 0, backupSlot: 0, maxHp: 100 },
    { id: 'ru_13', callsign: 'RED-3C', name: '红狼-3C 突击手', role: 'rifleman', squadId: 'RU_NORTH',    weaponSlot: 3, backupSlot: 0, maxHp: 100 },
    { id: 'ru_14', callsign: 'RED-3D', name: '红狼-3D 反坦克', role: 'at',       squadId: 'RU_NORTH',    weaponSlot: 5, backupSlot: 0, maxHp: 100 },
    { id: 'ru_15', callsign: 'RED-3M', name: '红狼-3M 医疗兵', role: 'medic',    squadId: 'RU_NORTH',    weaponSlot: 0, backupSlot: 0, maxHp: 100 },
    // Squad 4: South Flank Breach & Armor Crew (5)
    { id: 'ru_16', callsign: 'RED-4A', name: '红铁-4A 车长',   role: 'rifleman', squadId: 'RU_SOUTH', weaponSlot: 0, backupSlot: 0, maxHp: 100, armorCrew: true },
    { id: 'ru_17', callsign: 'RED-4B', name: '红铁-4B 炮手',   role: 'rifleman', squadId: 'RU_SOUTH', weaponSlot: 0, backupSlot: 0, maxHp: 100, armorCrew: true },
    { id: 'ru_18', callsign: 'RED-4C', name: '红铁-4C 反坦克', role: 'at',       squadId: 'RU_SOUTH', weaponSlot: 5, backupSlot: 0, maxHp: 100 },
    { id: 'ru_19', callsign: 'RED-4D', name: '红铁-4D 榴弹手', role: 'rifleman', squadId: 'RU_SOUTH', weaponSlot: 4, backupSlot: 0, maxHp: 100 },
    { id: 'ru_20', callsign: 'RED-4M', name: '红铁-4M 医疗兵', role: 'medic',    squadId: 'RU_SOUTH', weaponSlot: 0, backupSlot: 0, maxHp: 100 }
  ];

  // Fortified Sector A UA cover spawns (behind sandbags, Building 1/2 2nd-floor windows & interior corners)
  const DEFAULT_UA_SPAWNS = [
    [-28.5, 0.0,  -3.0],  // UA-1 Behind Sector A sandbag trench & trolleybus cover
    [-38.0, 3.85, -15.6], // UA-2 Building 1 Floor 2 South window overwatch
    [-36.0, 3.85,  15.6], // UA-3 Building 2 Floor 2 North window overwatch
    [-22.0, 0.0,   2.5],  // UA-4 Reserve hard cover / anti-armor pocket
    [-31.0, 0.25, -21.0]  // UA-5 Building 1 ground hall protected medic staging
  ];

  const DEFAULT_RU_SPAWNS = [
    // Assault Squad 1 (West avenue staging)
    [-70, 0.0, -3.5], [-72, 0.0, 2.5], [-74, 0.0, -1.0], [-71, 0.0, 6.0], [-75, 0.0, 0.5],
    // Suppression Squad 2 (West cover line)
    [-77, 0.0, -8.0], [-76, 0.0, -4.5], [-78, 0.0, 4.5], [-80, 0.0, -11.0], [-81, 0.0, 1.5],
    // North Flank Squad 3 (North alley Z ~ -38)
    [-68, 0.0, -36.0], [-71, 0.0, -39.5], [-73, 0.0, -34.5], [-75, 0.0, -41.0], [-77, 0.0, -37.5],
    // South Flank & Armor Crew Squad 4 (South alley Z ~ +36 & armor yard)
    [-67, 0.0,  8.5], [-69, 0.0,  12.5], [-68, 0.0, 35.0], [-72, 0.0, 39.0], [-75, 0.0, 36.5]
  ];

  let _soldiers = [];
  let _playerFaction = 'UA';
  let _playerSoldier = null;
  let _simTime = 0;
  let _frameCount = 0;
  let _eventsBound = false;
  let _activeSectorIdx = 0;
  let _lastSquadOrder = { UA: null, RU: null };

  // Helpers
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function distXZ(a, b) { return Math.hypot(a[0] - b[0], a[2] - b[2]); }
  function dist3D(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

  function angleDiff(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // Right-handed WebGL yaw where local -Z is forward:
  // forward = (-sin(yaw), 0, -cos(yaw)) => yaw = atan2(-dx, -dz)
  function yawFromDir(dx, dz) {
    return Math.atan2(-dx, -dz);
  }

  function getWeaponSpecSafe(slot, faction) {
    if (DF.WeaponCatalog && typeof DF.WeaponCatalog.get === 'function') {
      const s = DF.WeaponCatalog.get(slot, faction);
      if (s) return s;
    }
    // Safe fallback specs matching DESIGN.md classes
    const fallbacks = [
      { id: 'ar', name: faction === 'UA' ? 'M4A1' : 'AK-74M', rpm: 650, damage: 28, headMult: 2.2, armorPen: 0.15, muzzleVel: 850, spreadHip: 0.045, spreadAds: 0.014, magSize: 30, reserveMax: 180, reloadTacticalTime: 2.0, reloadEmptyTime: 2.5, audioProfile: faction === 'UA' ? 'ar_556' : 'ar_545' },
      { id: 'lmg', name: faction === 'UA' ? 'M249' : 'PKM', rpm: 720, damage: 30, headMult: 2.0, armorPen: 0.22, muzzleVel: 860, spreadHip: 0.065, spreadAds: 0.022, magSize: 100, reserveMax: 300, reloadTacticalTime: 3.6, reloadEmptyTime: 4.2, audioProfile: 'lmg' },
      { id: 'sniper', name: faction === 'UA' ? 'M24' : 'SVD', rpm: 75, damage: 78, headMult: 2.6, armorPen: 0.35, muzzleVel: 980, spreadHip: 0.055, spreadAds: 0.004, magSize: 10, reserveMax: 60, reloadTacticalTime: 2.4, reloadEmptyTime: 2.9, audioProfile: 'sniper' },
      { id: 'shotgun', name: faction === 'UA' ? 'M870' : 'Saiga-12K', rpm: 140, damage: 18, headMult: 1.6, armorPen: 0.08, muzzleVel: 420, spreadHip: 0.09, spreadAds: 0.06, magSize: 8, reserveMax: 48, reloadTacticalTime: 2.6, reloadEmptyTime: 3.2, pelletCount: 7, audioProfile: 'shotgun' },
      { id: 'gl', name: faction === 'UA' ? 'M320' : 'GP-25', rpm: 38, damage: 95, headMult: 1.0, armorPen: 0.40, muzzleVel: 78, spreadHip: 0.03, spreadAds: 0.015, magSize: 1, reserveMax: 10, reloadTacticalTime: 2.2, reloadEmptyTime: 2.4, explosiveRadius: 5.5, audioProfile: 'gl' },
      { id: 'rpg', name: 'RPG-7V2', rpm: 22, damage: 170, headMult: 1.0, armorPen: 0.92, muzzleVel: 115, spreadHip: 0.025, spreadAds: 0.012, magSize: 1, reserveMax: 5, reloadTacticalTime: 3.4, reloadEmptyTime: 3.4, explosiveRadius: 6.5, audioProfile: 'rpg' }
    ];
    return fallbacks[clamp(slot || 0, 0, 5)];
  }

  function getGroundY(x, z, refY) {
    if (DF.Physics && typeof DF.Physics.getGroundY === 'function') {
      const g = DF.Physics.getGroundY(x, z, refY !== undefined ? refY : 10);
      if (Number.isFinite(g)) return g;
    }
    return 0.0;
  }

  function getActiveSector() {
    if (DF.GameMode && typeof DF.GameMode.getState === 'function') {
      const st = DF.GameMode.getState();
      if (st && st.activeSector) return st.activeSector;
    }
    if (DF.Map && typeof DF.Map.getSectors === 'function') {
      const secs = DF.Map.getSectors();
      if (secs && secs.length) {
        return secs.find(s => s.active) || secs[_activeSectorIdx] || secs[0];
      }
    }
    const defaults = [
      { id: 'A', pos: [-38, 0, 0], radius: 15 },
      { id: 'B', pos: [4, 0, 0], radius: 18 },
      { id: 'C', pos: [52, 0, 0], radius: 16 }
    ];
    return defaults[clamp(_activeSectorIdx, 0, 2)];
  }

  function getSectorByIndex(idx) {
    if (DF.Map && typeof DF.Map.getSectors === 'function') {
      const secs = DF.Map.getSectors();
      if (secs && secs[idx]) return secs[idx];
    }
    const defaults = [
      { id: 'A', pos: [-38, 0, 0], radius: 15 },
      { id: 'B', pos: [4, 0, 0], radius: 18 },
      { id: 'C', pos: [52, 0, 0], radius: 16 }
    ];
    return defaults[clamp(idx, 0, 2)];
  }

  function isPlayerRemoteControlling() {
    if (DF.Unmanned && typeof DF.Unmanned.getControlledUnit === 'function') {
      return !!DF.Unmanned.getControlledUnit();
    }
    if (DF.Unmanned && typeof DF.Unmanned.isControlled === 'function') {
      return !!DF.Unmanned.isControlled();
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Soldier Factory & Spawning
  // ---------------------------------------------------------------------------
  function createSoldier(def, faction, spawnPos, faceYaw) {
    const spec = getWeaponSpecSafe(def.weaponSlot, faction);
    const x = clamp(spawnPos[0], -87, 87);
    const z = clamp(spawnPos[2], -52, 52);
    const refY = (spawnPos[1] !== undefined ? spawnPos[1] : 0) + 0.5;
    const y = getGroundY(x, z, refY);

    // Pre-populate per-slot ammo inventory (especially useful when player takes over any ally!)
    const ammoBySlot = [];
    for (let i = 0; i < 6; i++) {
      const ws = getWeaponSpecSafe(i, faction);
      ammoBySlot[i] = { mag: ws.magSize || 30, reserve: ws.reserveMax || 150 };
    }

    const s = {
      id: def.id,
      name: def.name,
      callsign: def.callsign,
      faction,
      role: def.role,
      squadId: def.squadId,
      armorCrew: !!def.armorCrew,
      isPlayer: false,
      pos: [x, y, z],
      vel: [0, 0, 0],
      yaw: faceYaw,
      pitch: 0,
      hp: def.maxHp,
      maxHp: def.maxHp,
      state: 'alive', // 'alive' | 'downed' | 'dead'
      bleedTimer: 0,
      maxBleedTime: faction === 'UA' ? BLEED_TIME_UA : BLEED_TIME_RU,
      reviveProgress: 0,
      reviverId: null,
      reviveTargetId: null,
      weaponSlot: def.weaponSlot,
      backupSlot: def.backupSlot !== undefined ? def.backupSlot : 0,
      magAmmo: spec.magSize || 30,
      reserveAmmo: spec.reserveMax || 150,
      ammoBySlot,
      reloading: false,
      reloadTimer: 0,
      reloadDuration: spec.reloadTacticalTime || 2.2,
      crouching: false,
      stance: 'stand',
      lean: 0,
      order: faction === 'UA' ? 'defend' : 'attack',
      orderPos: null,
      targetId: null,
      targetVehicleId: null,
      coverNode: null,
      path: null,
      pathIdx: 0,
      pathTimer: Math.random() * 1.2,
      suppression: 0,
      spottedTimer: 0,
      inVehicleId: null,
      fireCooldown: 0.4 + Math.random() * 0.6,
      burstCount: 0,
      burstCooldown: 0,
      animPhase: Math.random() * Math.PI * 2,
      recoil: 0,
      hitFlinch: 0,
      muzzleFlashTimer: 0,
      throwTimer: 0,
      grenadeCooldown: 3.0 + Math.random() * 6.0,
      fragCount: def.role === 'rifleman' ? 2 : 1,
      smokeCount: def.role === 'medic' ? 3 : 2,
      lastHitTime: -10,
      lastDamageTime: -10,
      timeSinceDamage: 99,
      lastAttackerId: null,
      deathTime: 0,
      respawnTimer: 0,
      aiState: 'advance',
      aiTimer: 0.1 + Math.random() * 0.6,
      losTimer: Math.random() * 0.25,
      hasTargetLOS: false,
      peekTimer: 0,
      isPeeking: false,
      stuckTimer: 0,
      lastPos: [x, y, z],
      desiredMovePos: null,
      vehicleSearchTimer: def.armorCrew ? 6.0 : 12.0,
      spawnGraceTimer: faction === 'UA' ? 5.0 : 1.5,
      engageDelay: faction === 'RU'
        ? (def.squadId === 'RU_SUPPRESS' ? 3.5 + Math.random() * 1.8
          : def.squadId === 'RU_ASSAULT' ? 4.5 + Math.random() * 2.2
          : 5.5 + Math.random() * 2.5)
        : 0.8 + Math.random() * 0.6,
      initialSmokeDone: false
    };

    // Settle capsule once against world colliders & snap flush to exact floor Y (0.000m error)
    if (DF.Physics && typeof DF.Physics.moveCapsule === 'function') {
      DF.Physics.moveCapsule(s.pos, [0, 0, 0], SOLDIER_RADIUS, SOLDIER_HEIGHT_STAND, 0.016, {
        ignoreIds: [s.id],
        noGravity: true
      });
    }
    s.pos[1] = getGroundY(s.pos[0], s.pos[2], s.pos[1] + 0.35);
    s.lastPos[0] = s.pos[0];
    s.lastPos[1] = s.pos[1];
    s.lastPos[2] = s.pos[2];
    return s;
  }

  function bindEventsOnce() {
    if (_eventsBound || !DF.Events || typeof DF.Events.on !== 'function') return;
    _eventsBound = true;

    // Immediately invalidate destroyed cover so AI ducks & relocates!
    DF.Events.on('destruction:collapsed', (ev) => {
      if (!ev || !ev.pos) return;
      const p = ev.pos;
      for (let i = 0; i < _soldiers.length; i++) {
        const s = _soldiers[i];
        if (s.state !== 'alive') continue;
        if (s.coverNode && s.coverNode.pos && dist3D(s.coverNode.pos, p) < 6.0) {
          s.coverNode = null;
          s.aiTimer = 0;
          s.pathTimer = 0;
          s.suppression = clamp(s.suppression + 0.42, 0, 1);
        } else if (dist3D(s.pos, p) < 9.0) {
          s.suppression = clamp(s.suppression + 0.28, 0, 1);
        }
      }
    });
  }

  function getSpawnList(faction, sectorIdx, defaults) {
    if (DF.Map && typeof DF.Map.getSpawns === 'function') {
      const sp = DF.Map.getSpawns(faction, sectorIdx);
      if (Array.isArray(sp) && sp.length > 0) {
        return sp.map((item) => {
          if (Array.isArray(item)) return item;
          if (item && Array.isArray(item.pos)) return item.pos;
          return null;
        }).filter(Boolean);
      }
    }
    return defaults;
  }

  function init(playerFaction) {
    bindEventsOnce();
    _playerFaction = playerFaction === 'RU' ? 'RU' : 'UA';
    _soldiers = [];
    _playerSoldier = null;
    _simTime = 0;
    _frameCount = 0;
    _activeSectorIdx = 0;
    _lastSquadOrder = { UA: null, RU: null };

    const uaSpawns = getSpawnList('UA', 0, DEFAULT_UA_SPAWNS);
    const ruSpawns = getSpawnList('RU', 0, DEFAULT_RU_SPAWNS);

    // Spawn 5 Ukrainian Defenders in fortified cover & 2nd-floor overwatch positions
    // (Skip map index 4 which sits isolated in the South flank alley; use protected indices [0, 1, 2, 6, 7])
    const yawWest = Math.PI * 0.5;
    const uaProtectedIndices = [0, 1, 2, 6, 7];
    for (let i = 0; i < UA_ROSTER.length; i++) {
      const pickIdx = uaProtectedIndices[i];
      const basePos = (uaSpawns.length > pickIdx ? uaSpawns[pickIdx] : null) || DEFAULT_UA_SPAWNS[i];
      const sp = [basePos[0], basePos[1] || 0, basePos[2]];
      const s = createSoldier(UA_ROSTER[i], 'UA', sp, yawWest);
      // Defenders start hunkered in cover rather than standing exposed
      s.crouching = i > 0;
      s.stance = s.crouching ? 'crouch' : 'stand';
      _soldiers.push(s);
    }

    // Spawn 20 Russian Attackers (facing East +X -> yaw = -PI/2 because -sin(-PI/2) = +1!)
    const yawEast = -Math.PI * 0.5;
    for (let i = 0; i < RU_ROSTER.length; i++) {
      const def = RU_ROSTER[i];
      let sp = DEFAULT_RU_SPAWNS[i];
      if (ruSpawns.length >= RU_ROSTER.length) {
        sp = ruSpawns[i];
      } else if (i < 10 && ruSpawns.length > 0) {
        const bp = ruSpawns[i % ruSpawns.length];
        sp = [bp[0] - Math.floor(i / ruSpawns.length) * 3.0, bp[1] || 0, bp[2] + ((i % 3) - 1) * 2.2];
      }
      const s = createSoldier(def, 'RU', sp, yawEast);
      _soldiers.push(s);
    }

    // Assign player to faction squad leader with 6.0s deployment grace
    const leader = _soldiers.find(s => s.faction === _playerFaction);
    if (leader) {
      setPlayerSoldier(leader);
      leader.maxHp = _playerFaction === 'UA' ? 150 : 130;
      leader.hp = leader.maxHp;
      leader.spawnGraceTimer = 6.0;
      leader.crouching = false;
      leader.stance = 'stand';
      leader.weaponSlot = 0;
      const ws = getWeaponSpecSafe(0, _playerFaction);
      leader.magAmmo = ws.magSize || 30;
      leader.reserveAmmo = ws.reserveMax || 180;
    }

    return _soldiers;
  }

  function setPlayerSoldier(soldier) {
    if (!soldier) return null;
    for (let i = 0; i < _soldiers.length; i++) {
      _soldiers[i].isPlayer = false;
    }
    soldier.isPlayer = true;
    soldier.reviveTargetId = null;
    soldier.order = 'player';
    _playerSoldier = soldier;
    return soldier;
  }

  function getSoldiers() { return _soldiers; }
  function getPlayerSoldier() { return _playerSoldier; }
  function getSoldierById(id) {
    for (let i = 0; i < _soldiers.length; i++) {
      if (_soldiers[i].id === id) return _soldiers[i];
    }
    return null;
  }

  // Safe, clear rear rally points per faction & active sector index (0=A, 1=B, 2=C)
  function getRallyPoint(faction, sectorIdx, soldier) {
    const idx = clamp(sectorIdx | 0, 0, 2);
    const seedNum = (soldier && soldier.id ? soldier.id.charCodeAt(soldier.id.length - 1) : 1) + Math.floor(Math.random() * 5);

    if (faction === 'UA') {
      const uaRally = [
        // Sector A active -> rally behind Sector A east cover / Sector B west approach
        [[-22.0, 0.0, 2.5], [-20.5, 0.0, -4.5], [-17.5, 0.0, 5.5], [-16.0, 0.0, -2.5], [-24.5, 0.0, -6.0]],
        // Sector B active -> rally behind Sector B east cover / Sector C west courtyard
        [[22.0, 0.0, -3.5], [24.0, 0.0, 4.5], [27.0, 0.0, 0.5], [20.5, 0.0, 6.0], [26.0, 0.0, -6.5]],
        // Sector C active -> rally in HQ rear courtyard / east reserve
        [[69.0, 0.0, -3.0], [69.0, 0.0, 4.5], [71.5, 0.0, 0.5], [54.0, 0.25, 4.5], [68.0, 0.0, -8.5]]
      ];
      const list = uaRally[idx];
      const pt = list[seedNum % list.length];
      return [pt[0], pt[1], pt[2]];
    } else {
      // RU rear rally behind active sector along squad lane
      const baseX = idx === 0 ? -74 : (idx === 1 ? -44 : -8);
      const laneZ = soldier && soldier.squadId === 'RU_NORTH' ? -38 + ((seedNum % 3) - 1) * 2.5
        : soldier && soldier.squadId === 'RU_SOUTH' ? 38 - ((seedNum % 3) - 1) * 2.5
        : ((seedNum % 5) - 2) * 3.4;
      return [clamp(baseX + ((seedNum % 4) - 1.5) * 2.5, -84, 80), 0.0, clamp(laneZ, -47, 47)];
    }
  }

  // Freshly respawn a single dead/downed soldier (AI or Player) at safe rear rally point
  function respawnSoldier(s, sectorIdx, isPlayerSpawn) {
    if (!s) return null;
    const secIdx = sectorIdx !== undefined ? sectorIdx : _activeSectorIdx;
    const pt = getRallyPoint(s.faction, secIdx, s);
    const sx = clamp(pt[0], -86, 86);
    const sz = clamp(pt[2], -50, 50);
    const sy = getGroundY(sx, sz, (pt[1] || 0) + 0.6);
    const yawDir = s.faction === 'RU' ? -Math.PI * 0.5 : Math.PI * 0.5;

    s.state = 'alive';
    s.hp = s.maxHp;
    s.pos[0] = sx; s.pos[1] = sy; s.pos[2] = sz;
    s.vel[0] = 0; s.vel[1] = 0; s.vel[2] = 0;
    s.yaw = yawDir; s.pitch = 0;
    s.bleedTimer = 0;
    s.reviveProgress = 0;
    s.reviverId = null;
    s.reviveTargetId = null;
    s.inVehicleId = null;
    s.coverNode = null;
    s.path = null;
    s.pathIdx = 0;
    s.pathTimer = 0;
    s.suppression = 0;
    s.deathTime = 0;
    s.respawnTimer = 0;
    s.reloading = false;
    s.reloadTimer = 0;
    s.crouching = false;
    s.stance = 'stand';
    s.lean = 0;
    s.hitFlinch = 0;
    s.lastDamageTime = -10;
    s.timeSinceDamage = 99;
    s.spawnGraceTimer = (isPlayerSpawn || s.isPlayer) ? 3.2 : 2.2;
    s.engageDelay = s.faction === 'RU' ? 1.2 : 0.4;

    // Refill all 6 weapon slots & grenades cleanly
    for (let k = 0; k < 6; k++) {
      const ws = getWeaponSpecSafe(k, s.faction);
      if (s.ammoBySlot) s.ammoBySlot[k] = { mag: ws.magSize || 30, reserve: ws.reserveMax || 150 };
    }
    const activeSpec = getWeaponSpecSafe(s.weaponSlot, s.faction);
    s.magAmmo = activeSpec.magSize || 30;
    s.reserveAmmo = activeSpec.reserveMax || 150;
    s.fragCount = s.role === 'rifleman' ? 2 : 1;
    s.smokeCount = s.role === 'medic' ? 3 : 2;
    s.order = s.isPlayer ? 'player' : (s.faction === 'UA' ? 'defend' : 'attack');
    s.orderPos = null;

    // Settle capsule against world colliders & snap flush to exact floor Y (0.000m error)
    if (DF.Physics && typeof DF.Physics.moveCapsule === 'function') {
      DF.Physics.moveCapsule(s.pos, [0, 0, 0], SOLDIER_RADIUS, SOLDIER_HEIGHT_STAND, 0.016, {
        ignoreIds: [s.id],
        noGravity: true
      });
    }
    s.pos[1] = getGroundY(s.pos[0], s.pos[2], s.pos[1] + 0.35);
    s.lastPos[0] = s.pos[0]; s.lastPos[1] = s.pos[1]; s.lastPos[2] = s.pos[2];

    return s;
  }

  // ---------------------------------------------------------------------------
  // Reinforcement Wave Spawn (called by GameMode on RU sector capture)
  // Respawns dead RU attackers at newly captured staging line up to count (cap 20)
  // ---------------------------------------------------------------------------
  function spawnReinforcementWave(faction, sectorIdx, maxToRevive) {
    let count = 0;
    for (let i = 0; i < _soldiers.length && count < maxToRevive; i++) {
      const s = _soldiers[i];
      if (s.faction !== faction || s.state !== 'dead' || s.isPlayer) continue;
      respawnSoldier(s, sectorIdx, false);
      count++;
    }
    return count;
  }

  // Triggered when a Breakthrough sector falls -> UA fighting withdrawal, RU surge!
  function onSectorFall(newSectorIdx) {
    _activeSectorIdx = clamp(newSectorIdx, 0, 2);
    const sec = getSectorByIndex(_activeSectorIdx);

    for (let i = 0; i < _soldiers.length; i++) {
      const s = _soldiers[i];
      if (s.state !== 'alive' || s.isPlayer) continue;
      s.coverNode = null;
      s.path = null;
      s.pathTimer = 0;
      s.aiTimer = 0;

      if (s.faction === 'UA') {
        // Fighting withdrawal: drop smoke if available and pull back to new sector
        if (s.smokeCount > 0 && DF.Ballistics && typeof DF.Ballistics.throwGrenade === 'function') {
          s.smokeCount--;
          const origin = [s.pos[0], s.pos[1] + 1.45, s.pos[2]];
          DF.Ballistics.throwGrenade(s, 'smoke', origin, [-0.85, 0.35, (Math.random() - 0.5) * 0.4]);
        }
        s.order = 'defend';
        s.orderPos = [sec.pos[0] + 6, sec.pos[1], sec.pos[2]];
      } else {
        // RU tactical surge into next sector
        s.order = 'attack';
        s.orderPos = [sec.pos[0], sec.pos[1], sec.pos[2]];
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Squad Orders (F1..F6 & Q Radial Wheel & M Tactical Map)
  // ---------------------------------------------------------------------------
  function issueSquadOrder(faction, order, targetPos, targetEntity) {
    const f = faction || _playerFaction;
    const ord = (order || 'follow').toLowerCase();
    const pos = targetPos ? [targetPos[0], targetPos[1] || 0, targetPos[2]] : (_playerSoldier ? _playerSoldier.pos.slice() : [0, 0, 0]);
    _lastSquadOrder[f] = { order: ord, pos, time: _simTime };

    // Collect commandable friendly AI allies
    const allies = _soldiers.filter(s => s.faction === f && !s.isPlayer && s.state === 'alive');
    // For RU (19 AI teammates), direct player's immediate squad + nearby available fighters (up to 7)
    // so orders feel ultra-responsive without breaking overall multi-axis front pressure!
    let responders = allies;
    if (f === 'RU' && allies.length > 6 && ord !== 'revive' && ord !== 'vehicle') {
      const squadMates = allies.filter(s => _playerSoldier && s.squadId === _playerSoldier.squadId);
      const others = allies
        .filter(s => !squadMates.includes(s))
        .sort((a, b) => distXZ(a.pos, pos) - distXZ(b.pos, pos))
        .slice(0, 4);
      responders = squadMates.concat(others);
    }

    let ackText = '';
    if (ord === 'follow') {
      for (let i = 0; i < responders.length; i++) {
        const s = responders[i];
        if (s.inVehicleId && DF.Armor && DF.Armor.exitVehicle) {
          // Keep tank crew inside unless specifically ordered out? Actually let infantry follow, armor escort!
        }
        s.order = 'follow';
        s.orderPos = pos.slice();
        s.coverNode = null;
        s.path = null;
        s.pathTimer = 0;
        s.aiTimer = 0;
      }
      ackText = '小队确认：紧随编队掩护推进';
    } else if (ord === 'attack' || ord === 'hold' || ord === 'defend') {
      for (let i = 0; i < responders.length; i++) {
        const s = responders[i];
        s.order = 'attack';
        const angle = (i / Math.max(1, responders.length)) * Math.PI * 2;
        const spreadR = 2.8 + (i % 3) * 1.8;
        s.orderPos = [clamp(pos[0] + Math.cos(angle) * spreadR, -86, 86), pos[1], clamp(pos[2] + Math.sin(angle) * spreadR, -51, 51)];
        s.coverNode = null;
        s.path = null;
        s.pathTimer = 0;
        s.aiTimer = 0;
      }
      ackText = '小队确认：向指定坐标进攻并固守';
    } else if (ord === 'suppress') {
      for (let i = 0; i < responders.length; i++) {
        const s = responders[i];
        s.order = 'suppress';
        s.orderPos = pos.slice();
        s.aiTimer = 0;
      }
      ackText = '小队确认：对目标区域实施重火力压制';
    } else if (ord === 'flank') {
      // Compute lateral flanking waypoint around targetPos
      const origin = _playerSoldier ? _playerSoldier.pos : pos;
      const dx = pos[0] - origin[0];
      const dz = pos[2] - origin[2];
      const len = Math.hypot(dx, dz) || 1;
      // Pick less obstructed north/south side
      const sideSign = pos[2] >= 0 ? -1 : 1;
      const perpX = (-dz / len) * sideSign;
      const perpZ = (dx / len) * sideSign;
      const flankPt = [
        clamp(pos[0] + perpX * 20, -84, 84),
        pos[1],
        clamp(pos[2] + perpZ * 20, -47, 47)
      ];
      for (let i = 0; i < responders.length; i++) {
        const s = responders[i];
        s.order = 'flank';
        s.orderPos = [
          clamp(flankPt[0] + ((i % 3) - 1) * 3.0, -85, 85),
          flankPt[1],
          clamp(flankPt[2] + (Math.floor(i / 3) - 0.5) * 3.5, -48, 48)
        ];
        s.coverNode = null;
        s.path = null;
        s.pathTimer = 0;
        s.aiTimer = 0;
      }
      ackText = '小队确认：侧翼迂回包抄敌军掩体';
    } else if (ord === 'revive') {
      // Find downed friendly (prioritize player!) and dispatch nearest/medic ally immediately
      const downedList = _soldiers
        .filter(s => s.faction === f && s.state === 'downed')
        .sort((a, b) => (b.isPlayer ? 1 : 0) - (a.isPlayer ? 1 : 0));
      if (downedList.length > 0) {
        const target = downedList[0];
        const rescuer = assignMedicToDowned(target, true);
        ackText = rescuer
          ? `${rescuer.name} 正在投烟赶往救援 ${target.isPlayer ? '你' : target.name}！`
          : '暂无可用友军执行救援';
      } else {
        ackText = '当前无倒地友军，医疗兵保持待命';
      }
    } else if (ord === 'vehicle') {
      // Dispatch ally into empty friendly Tank/IFV + coordinate friendly Drone & Robot Dog!
      let crewDispatched = null;
      const veh = findAvailableFriendlyVehicle(f, pos);
      if (veh) {
        const candidates = allies.filter(s => !s.inVehicleId && !s.reviveTargetId);
        candidates.sort((a, b) => distXZ(a.pos, veh.pos) - distXZ(b.pos, veh.pos));
        if (candidates.length > 0) {
          crewDispatched = candidates[0];
          crewDispatched.order = 'vehicle';
          crewDispatched.targetVehicleId = veh.id;
          crewDispatched.orderPos = veh.pos.slice();
          crewDispatched.path = null;
          crewDispatched.pathTimer = 0;
        }
      }
      ackText = crewDispatched
        ? `${crewDispatched.name} 正接管友军装甲，无人机与机器狗协同压上`
        : '无人机与机器狗已受命协同打击目标区域';
    }

    // Forward order to Unmanned systems (Drone + Robot Dog) for true combined-arms!
    if (DF.Unmanned && typeof DF.Unmanned.issueOrder === 'function') {
      DF.Unmanned.issueOrder(f, 'dog', ord, pos);
      DF.Unmanned.issueOrder(f, 'drone', ord, pos);
    }

    if (f === _playerFaction) {
      if (DF.Audio && typeof DF.Audio.playRadioCue === 'function') {
        DF.Audio.playRadioCue('order_ack');
      }
      if (DF.UI && typeof DF.UI.showNotification === 'function' && ackText) {
        DF.UI.showNotification(ackText, 'info');
      }
    }
    if (DF.Events && typeof DF.Events.emit === 'function') {
      DF.Events.emit('squad:order', { faction: f, order: ord, pos, targetEntity });
    }
    return ackText;
  }

  // ---------------------------------------------------------------------------
  // Spotting & Focus Fire
  // ---------------------------------------------------------------------------
  function spotTarget(pos, faction) {
    if (!pos) return 0;
    const f = faction || _playerFaction;
    const enemyFaction = f === 'UA' ? 'RU' : 'UA';
    let spottedCount = 0;

    for (let i = 0; i < _soldiers.length; i++) {
      const s = _soldiers[i];
      if (s.faction !== enemyFaction || s.state === 'dead') continue;
      if (dist3D(s.pos, pos) <= 22.0) {
        s.spottedTimer = 10.0;
        spottedCount++;
      }
    }

    // Also tag enemy vehicles near spotted coordinate
    if (DF.Armor && typeof DF.Armor.getVehicles === 'function') {
      const vehs = DF.Armor.getVehicles() || [];
      for (let i = 0; i < vehs.length; i++) {
        const v = vehs[i];
        if (v && v.faction === enemyFaction && !v.destroyed && dist3D(v.pos, pos) <= 24.0) {
          v.spottedTimer = 12.0;
          spottedCount++;
        }
      }
    }

    // Focus-fire alert for nearby allies
    if (spottedCount > 0 && f === _playerFaction) {
      if (DF.Audio && typeof DF.Audio.playRadioCue === 'function') {
        DF.Audio.playRadioCue('spot');
      }
      if (DF.UI && typeof DF.UI.showNotification === 'function') {
        DF.UI.showNotification(`已标记 ${spottedCount} 个敌方目标，友军正集中火力`, 'warning');
      }
    }
    return spottedCount;
  }

  // ---------------------------------------------------------------------------
  // Damage, Downed State, Revive & Kill Attribution
  // ---------------------------------------------------------------------------
  function damageSoldier(soldier, dmg, hitZone, attacker, weaponId) {
    if (!soldier || soldier.state === 'dead') return;
    const isHead = hitZone === 'head';
    const zoneMult = isHead ? 2.1 : (hitZone === 'limb' ? 0.72 : 1.0);
    let amount = Math.max(1, (dmg || 0) * zoneMult);

    // Friendly fire dampener for AI accidental crossfire (prevents AI killing own team)
    if (attacker && attacker.faction === soldier.faction && !attacker.isPlayer) {
      return;
    }

    // Deployment spawn grace (prevents instant spawn wipe while keeping combat sparks/suppression)
    if ((soldier.spawnGraceTimer || 0) > 0) {
      amount *= soldier.isPlayer ? 0.12 : 0.20;
    }

    // Asymmetric 5v20 urban defense resilience against AI massed fire + armor splash
    // (Player's own shots when playing RU always deal full crisp 100% damage!)
    const inCoverOrElevated = !!(soldier.crouching || soldier.coverNode || (soldier.pos && soldier.pos[1] > 2.4));
    const isAttackerAI = !attacker || !attacker.isPlayer;
    if (soldier.faction === 'UA' && isAttackerAI) {
      amount *= inCoverOrElevated ? 0.38 : 0.55;
    } else if (soldier.isPlayer && isAttackerAI) {
      amount *= inCoverOrElevated ? 0.48 : 0.65;
    }

    // Downed soldiers crouched/prone low take reduced stray splash so medics have a real window to revive
    if (soldier.state === 'downed') {
      amount *= 0.28;
    }

    amount = Math.max(1, amount);

    soldier.lastHitTime = _simTime;
    soldier.lastDamageTime = _simTime;
    soldier.timeSinceDamage = 0;
    soldier.suppression = clamp(soldier.suppression + (isHead ? 0.45 : 0.28), 0, 1);
    soldier.recoil = Math.max(soldier.recoil, 0.35);
    soldier.hitFlinch = clamp((soldier.hitFlinch || 0) + (isHead ? 0.9 : 0.55), 0, 1.0);

    if (attacker && attacker.id) {
      soldier.lastAttackerId = attacker.id;
      // Alert soldier & nearby squadmates to attacker!
      if (attacker.faction !== soldier.faction && attacker.pos) {
        if (attacker.spottedTimer !== undefined) attacker.spottedTimer = Math.max(attacker.spottedTimer, 4.0);
        if (!soldier.targetId && attacker.id && getSoldierById(attacker.id)) {
          soldier.targetId = attacker.id;
        }
      }
    }

    // Blood impact particle feedback
    if (DF.Renderer && typeof DF.Renderer.spawnParticle === 'function') {
      const hitY = soldier.pos[1] + (isHead ? 1.58 : (soldier.crouching ? 0.85 : 1.18));
      for (let k = 0; k < (isHead ? 6 : 3); k++) {
        DF.Renderer.spawnParticle({
          type: 'blood',
          pos: [soldier.pos[0], hitY, soldier.pos[2]],
          vel: [(Math.random() - 0.5) * 3.0, 0.8 + Math.random() * 2.0, (Math.random() - 0.5) * 3.0],
          size: 0.14,
          sizeEnd: 0.42,
          life: 0.45,
          color: [0.42, 0.05, 0.05],
          alpha: 0.78,
          gravity: 7.5,
          drag: 2.0
        });
      }
    }

    // Already downed: finish off if taking heavy follow-up damage
    if (soldier.state === 'downed') {
      soldier.bleedTimer -= amount * 0.25;
      if (soldier.bleedTimer <= 0 || amount >= 45) {
        killSoldier(soldier, attacker, weaponId, isHead);
      }
      return;
    }

    // Alive state damage
    soldier.hp -= amount;
    if (soldier.hp <= 0) {
      const overkill = -soldier.hp;
      soldier.hp = 0;

      // Determine Downed vs Instant KIA
      // UA elites (5 soldiers) & Player ALWAYS go Downed first unless vaporized by 125mm tank shell while isolated!
      const isHeavyOverkill = overkill > 140;
      const shouldGoDowned = soldier.isPlayer
        ? true
        : (soldier.faction === 'UA' ? !isHeavyOverkill : (!isHeavyOverkill && Math.random() < 0.65));

      // Check if any friendly ally is still alive to possibly rescue (if last man standing on non-player, instant KIA)
      const livingFriends = _soldiers.some(o => o.faction === soldier.faction && o.id !== soldier.id && o.state === 'alive');

      if (shouldGoDowned && (livingFriends || soldier.isPlayer)) {
        enterDownedState(soldier, attacker, weaponId, isHead);
      } else {
        killSoldier(soldier, attacker, weaponId, isHead);
      }
    }
  }

  function enterDownedState(soldier, attacker, weaponId, isHead) {
    // Eject from vehicle cleanly if downed inside
    if (soldier.inVehicleId && DF.Armor && typeof DF.Armor.exitVehicle === 'function') {
      const veh = getVehicleById(soldier.inVehicleId);
      if (veh) DF.Armor.exitVehicle(veh, soldier);
      soldier.inVehicleId = null;
    }

    soldier.state = 'downed';
    const hasLivingAlly = _soldiers.some(o => o.faction === soldier.faction && o.id !== soldier.id && o.state === 'alive');
    soldier.maxBleedTime = soldier.isPlayer
      ? (hasLivingAlly ? BLEED_TIME_PLAYER_WITH_ALLY : BLEED_TIME_PLAYER_SOLO)
      : (soldier.faction === 'UA' ? BLEED_TIME_UA : BLEED_TIME_RU);
    soldier.bleedTimer = soldier.maxBleedTime;
    soldier.reviveProgress = 0;
    soldier.reviverId = null;
    soldier.reviveTargetId = null;
    soldier.reloading = false;
    soldier.vel[0] = 0;
    soldier.vel[2] = 0;
    soldier.pos[1] = getGroundY(soldier.pos[0], soldier.pos[2], soldier.pos[1] + 0.5);

    // Immediately dispatch nearest safe ally medic to rescue!
    const rescuer = assignMedicToDowned(soldier, false);

    if (soldier.faction === _playerFaction) {
      if (DF.Audio && typeof DF.Audio.playRadioCue === 'function') {
        DF.Audio.playRadioCue('ally_downed');
      }
      if (DF.UI && typeof DF.UI.showNotification === 'function') {
        if (soldier.isPlayer) {
          DF.UI.showNotification(
            rescuer
              ? `你已负伤倒地！${rescuer.name} 正在赶来施救（[Space]接管友军 / [F]立即复活）`
              : '你已负伤倒地！按 [F] 立即增援复活（或等待倒计时自动复活）',
            'danger'
          );
        } else {
          DF.UI.showNotification(`${soldier.name} 重伤倒地，请求医疗支援！`, 'warning');
        }
      }
    }

    if (DF.Events && typeof DF.Events.emit === 'function') {
      DF.Events.emit('soldier:downed', { soldier, attacker, weaponId, isHead });
    }
  }

  function killSoldier(soldier, attacker, weaponId, isHead, fromBleedout) {
    if (soldier.state === 'dead') return;

    if (soldier.inVehicleId && DF.Armor && typeof DF.Armor.exitVehicle === 'function') {
      const veh = getVehicleById(soldier.inVehicleId);
      if (veh) DF.Armor.exitVehicle(veh, soldier);
      soldier.inVehicleId = null;
    }

    // Release any reviver heading to this soldier
    if (soldier.reviverId) {
      const rev = getSoldierById(soldier.reviverId);
      if (rev && rev.reviveTargetId === soldier.id) rev.reviveTargetId = null;
    }
    if (soldier.reviveTargetId) {
      const tgt = getSoldierById(soldier.reviveTargetId);
      if (tgt && tgt.reviverId === soldier.id) tgt.reviverId = null;
    }

    soldier.state = 'dead';
    soldier.hp = 0;
    soldier.deathTime = 0;
    // Start AI automatic respawn timer (UA: 10s, RU: 12s); player respawn handled by GameMode (4.0s)
    soldier.respawnTimer = soldier.isPlayer ? 0 : (soldier.faction === 'UA' ? AI_RESPAWN_TIME_UA : AI_RESPAWN_TIME_RU);
    soldier.reviverId = null;
    soldier.reviveTargetId = null;
    soldier.vel[0] = 0;
    soldier.vel[2] = 0;
    soldier.pos[1] = getGroundY(soldier.pos[0], soldier.pos[2], soldier.pos[1] + 0.5);

    const killerName = attacker ? (attacker.name || attacker.callsign || (attacker.faction === 'UA' ? 'UA部队' : 'RU部队')) : '火力打击';
    const killerFaction = attacker ? attacker.faction : (soldier.faction === 'UA' ? 'RU' : 'UA');
    const wName = weaponId || (attacker && attacker.weaponSlot !== undefined ? getWeaponSpecSafe(attacker.weaponSlot, killerFaction).name : '步枪');

    // Only post killfeed here on bleedout/delayed death or when DF.Game didn't already log it
    if ((fromBleedout || !DF.Game) && DF.UI && typeof DF.UI.addKillfeed === 'function') {
      DF.UI.addKillfeed(killerName, wName, soldier.name, killerFaction, soldier.faction, !!isHead);
    }

    if (DF.Events && typeof DF.Events.emit === 'function') {
      DF.Events.emit('soldier:killed', {
        victim: soldier,
        attacker,
        weaponId: wName,
        isHeadshot: !!isHead
      });
    }
  }

  function reviveSoldier(target, reviver) {
    if (!target || target.state !== 'downed') return false;
    target.state = 'alive';
    target.hp = (!reviver && target.isPlayer) ? target.maxHp : Math.round(target.maxHp * 0.80);
    target.bleedTimer = 0;
    target.reviveProgress = 0;
    target.reviverId = null;
    target.suppression = 0.15;
    target.spawnGraceTimer = 2.0; // Brief post-revive protection to get behind cover
    target.crouching = !target.isPlayer;
    target.pos[1] = getGroundY(target.pos[0], target.pos[2], target.pos[1] + 0.5);

    if (reviver) {
      if (reviver.reviveTargetId === target.id) reviver.reviveTargetId = null;
    }

    // Avoid duplicate audio/toast when player manually revived an ally (handled by DF.Game)
    if (target.faction === _playerFaction && (!reviver || !reviver.isPlayer)) {
      if (DF.Audio && typeof DF.Audio.playRadioCue === 'function') {
        DF.Audio.playRadioCue('revive');
      }
      if (DF.UI && typeof DF.UI.showNotification === 'function') {
        const who = reviver ? reviver.name : '医疗兵';
        DF.UI.showNotification(`${who} 已成功救起 ${target.isPlayer ? '你' : target.name}！`, 'success');
      }
    }

    if (DF.Events && typeof DF.Events.emit === 'function') {
      DF.Events.emit('soldier:revived', { target, reviver });
    }
    return true;
  }

  function assignMedicToDowned(downed, forceReassign) {
    if (!downed || downed.state !== 'downed') return null;
    if (!forceReassign && downed.reviverId) {
      const cur = getSoldierById(downed.reviverId);
      if (cur && cur.state === 'alive' && !cur.isPlayer) return cur;
    }

    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < _soldiers.length; i++) {
      const s = _soldiers[i];
      if (s.faction !== downed.faction || s.state !== 'alive' || s.isPlayer) continue;
      if (s.inVehicleId) continue;
      if (s.reviveTargetId && s.reviveTargetId !== downed.id && !forceReassign) continue;

      const d = dist3D(s.pos, downed.pos);
      // Strongly prefer combat medics and nearby soldiers
      const roleBonus = s.role === 'medic' ? -18.0 : 0;
      const hpPenalty = s.hp < 40 ? 15.0 : 0;
      const score = d + roleBonus + hpPenalty;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }

    if (best) {
      if (downed.reviverId) {
        const old = getSoldierById(downed.reviverId);
        if (old && old.reviveTargetId === downed.id) old.reviveTargetId = null;
      }
      best.reviveTargetId = downed.id;
      downed.reviverId = best.id;
      best.path = null;
      best.pathTimer = 0;
      best.aiTimer = 0;
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Perception: LOS with Wall + Floor + Smoke Occlusion!
  // ---------------------------------------------------------------------------
  function hasLineOfSight(fromEye, toEye, ignoreIds) {
    const dx = toEye[0] - fromEye[0];
    const dy = toEye[1] - fromEye[1];
    const dz = toEye[2] - fromEye[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.5) return true;

    // Respect Smoke Volumes! (Smoke grenades & tank thermal smoke blind AI!)
    if (dist > 4.5 && DF.Physics && typeof DF.Physics.lineBlockedBySmoke === 'function') {
      if (DF.Physics.lineBlockedBySmoke(fromEye, toEye)) {
        return false;
      }
    }

    if (DF.Physics && typeof DF.Physics.raycast === 'function') {
      const inv = 1 / dist;
      const hit = DF.Physics.raycast(
        fromEye,
        [dx * inv, dy * inv, dz * inv],
        dist - 0.35,
        {
          ignoreIds: ignoreIds || [],
          checkEntities: false,
          checkVehicles: false,
          hitSmoke: false
        }
      );
      if (hit) return false;
    }
    return true;
  }

  function getVehicleById(id) {
    if (!id || !DF.Armor || typeof DF.Armor.getVehicles !== 'function') return null;
    const vehs = DF.Armor.getVehicles() || [];
    for (let i = 0; i < vehs.length; i++) {
      if (vehs[i] && vehs[i].id === id) return vehs[i];
    }
    return null;
  }

  function findAvailableFriendlyVehicle(faction, nearPos) {
    if (!DF.Armor || typeof DF.Armor.getVehicles !== 'function') return null;
    const vehs = DF.Armor.getVehicles() || [];
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < vehs.length; i++) {
      const v = vehs[i];
      if (!v || v.destroyed || v.faction !== faction) continue;
      if (v.occupant || v.driver || v.isPlayerControlled) continue;
      if ((v.hp || 0) < (v.maxHp || 1000) * 0.25) continue;
      const d = nearPos ? distXZ(v.pos, nearPos) : 0;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  function findBestThreat(soldier) {
    const enemyFaction = soldier.faction === 'UA' ? 'RU' : 'UA';
    const eye = [soldier.pos[0], soldier.pos[1] + (soldier.crouching ? 1.05 : 1.55), soldier.pos[2]];

    let bestSoldier = null;
    let bestScore = -Infinity;
    let bestVehicle = null;
    let bestVehScore = -Infinity;

    // Evaluate enemy armored vehicles (especially high priority for AT RPG soldiers & vehicle gunners!)
    if (DF.Armor && typeof DF.Armor.getVehicles === 'function') {
      const vehs = DF.Armor.getVehicles() || [];
      for (let i = 0; i < vehs.length; i++) {
        const v = vehs[i];
        if (!v || v.destroyed || v.faction !== enemyFaction) continue;
        const d = dist3D(soldier.pos, v.pos);
        if (d > 95) continue;
        const vEye = [v.pos[0], v.pos[1] + 1.8, v.pos[2]];
        if (!hasLineOfSight(eye, vEye)) continue;
        const atBoost = (soldier.role === 'at' || soldier.inVehicleId) ? 140 : -30;
        const sc = atBoost - d * 0.8 + ((v.spottedTimer || 0) > 0 ? 25 : 0);
        if (sc > bestVehScore) {
          bestVehScore = sc;
          bestVehicle = v;
        }
      }
    }

    // Evaluate enemy soldiers
    for (let i = 0; i < _soldiers.length; i++) {
      const e = _soldiers[i];
      if (e.faction !== enemyFaction || e.state !== 'alive' || e.inVehicleId) continue;
      const d = dist3D(soldier.pos, e.pos);
      if (d > 88) continue;

      const eEye = [e.pos[0], e.pos[1] + (e.crouching ? 0.95 : 1.48), e.pos[2]];
      // Check LOS only for plausible threats to keep CPU ultra-fast
      if (d > 58 && soldier.role !== 'sniper' && (e.spottedTimer || 0) <= 0) continue;

      const visible = hasLineOfSight(eye, eEye);
      if (!visible) continue;

      let sc = 100 - d * 1.05;
      if ((e.spottedTimer || 0) > 0) sc += 22;
      if (e.id === soldier.targetId) sc += 14; // hysteresis prevents target jitter
      if (e.isPlayer && d < 40) sc += 6;
      if (soldier.role === 'sniper' && d > 25) sc += 20;
      if (e.role === 'at' && soldier.inVehicleId) sc += 30;

      if (sc > bestScore) {
        bestScore = sc;
        bestSoldier = e;
      }
    }

    // AT soldier with RPG ammo prioritizes visible enemy vehicle!
    if (bestVehicle && ((soldier.role === 'at' && (soldier.magAmmo > 0 || soldier.reserveAmmo > 0)) || soldier.inVehicleId)) {
      return { type: 'vehicle', entity: bestVehicle, pos: [bestVehicle.pos[0], bestVehicle.pos[1] + 1.4, bestVehicle.pos[2]] };
    }
    if (bestSoldier) {
      return { type: 'soldier', entity: bestSoldier, pos: [bestSoldier.pos[0], bestSoldier.pos[1] + (bestSoldier.crouching ? 0.92 : 1.35), bestSoldier.pos[2]] };
    }
    if (bestVehicle && soldier.role === 'at') {
      return { type: 'vehicle', entity: bestVehicle, pos: [bestVehicle.pos[0], bestVehicle.pos[1] + 1.4, bestVehicle.pos[2]] };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // AI Firing, Reloading & Grenade Tactics
  // ---------------------------------------------------------------------------
  function startReload(soldier) {
    if (soldier.reloading || soldier.reserveAmmo <= 0) return;
    const spec = getWeaponSpecSafe(soldier.weaponSlot, soldier.faction);
    const dur = soldier.magAmmo === 0 ? (spec.reloadEmptyTime || 2.6) : (spec.reloadTacticalTime || 2.1);
    soldier.reloading = true;
    soldier.reloadDuration = dur;
    soldier.reloadTimer = dur;
    if (DF.Audio && typeof DF.Audio.playReloadFoley === 'function') {
      DF.Audio.playReloadFoley('mag_out', soldier.pos);
    }
  }

  function finishReload(soldier) {
    const spec = getWeaponSpecSafe(soldier.weaponSlot, soldier.faction);
    const need = (spec.magSize || 30) - soldier.magAmmo;
    const take = Math.min(need, soldier.reserveAmmo);
    soldier.magAmmo += take;
    soldier.reserveAmmo -= take;
    // Replenish AI reserve slowly if near ammo crate or completely dry (so battles stay intense!)
    if (soldier.reserveAmmo <= 0 && !soldier.isPlayer) {
      soldier.reserveAmmo = (spec.magSize || 30) * 2;
    }
    soldier.reloading = false;
    soldier.reloadTimer = 0;
    if (DF.Audio && typeof DF.Audio.playReloadFoley === 'function') {
      DF.Audio.playReloadFoley('bolt_release', soldier.pos);
    }
  }

  function fireAIWeapon(soldier, aimPos, isSuppressive) {
    if (soldier.reloading || soldier.fireCooldown > 0) return;

    // Switch AT soldier cleanly between RPG-7 (for armor/fortifications) and backup AR (for infantry)
    if (soldier.role === 'at' && !soldier.isPlayer) {
      const targetIsArmor = !!soldier.targetVehicleId;
      const desiredSlot = targetIsArmor ? 5 : 0;
      if (soldier.weaponSlot !== desiredSlot) {
        soldier.ammoBySlot[soldier.weaponSlot] = { mag: soldier.magAmmo, reserve: soldier.reserveAmmo };
        soldier.weaponSlot = desiredSlot;
        const saved = soldier.ammoBySlot[desiredSlot] || { mag: 30, reserve: 120 };
        soldier.magAmmo = saved.mag;
        soldier.reserveAmmo = saved.reserve;
      }
    }

    if (soldier.magAmmo <= 0) {
      startReload(soldier);
      return;
    }

    const spec = getWeaponSpecSafe(soldier.weaponSlot, soldier.faction);
    const muzzle = DF.Character && DF.Character.getMuzzleWorldPos
      ? DF.Character.getMuzzleWorldPos(soldier)
      : [soldier.pos[0], soldier.pos[1] + (soldier.crouching ? 1.05 : 1.48), soldier.pos[2]];

    const dx = aimPos[0] - muzzle[0];
    const dy = aimPos[1] - muzzle[1];
    const dz = aimPos[2] - muzzle[2];
    const dist = Math.hypot(dx, dy, dz) || 1;

    // Ballistic elevation compensation for slow projectiles (GL 40mm / RPG)
    let leadY = dy;
    if (soldier.weaponSlot === 4) {
      leadY += Math.min(8.0, (dist * dist) * 0.0014);
    } else if (soldier.weaponSlot === 5) {
      leadY += Math.min(2.2, dist * 0.015);
    }

    // Realistic tactical accuracy for 5v20 balance:
    // Pass exact conical spread via extraOpts.spread to DF.Ballistics.fireWeapon so
    // UA elite defenders (5 guns, sharp aim) actually drop advancing RU attackers, while
    // RU attackers (20 guns, wider 0.078 suppressive spread) sustain intense multi-minute battles!
    const baseSpread = soldier.faction === 'UA' ? 0.016 : 0.078;
    const roleFactor = soldier.role === 'sniper' ? 0.42 : (soldier.role === 'mg' ? 1.25 : 1.0);
    const suppressPenalty = soldier.suppression * 0.095;
    const suppressModePenalty = isSuppressive ? 0.038 : 0;
    const movePenalty = Math.hypot(soldier.vel[0], soldier.vel[2]) * 0.014;
    const totalSpread = baseSpread * roleFactor + suppressPenalty + suppressModePenalty + movePenalty;

    const dLen = Math.hypot(dx, leadY, dz) || 1;
    const dir = [dx / dLen, leadY / dLen, dz / dLen];

    soldier.magAmmo--;
    soldier.recoil = Math.min(1.2, soldier.recoil + (soldier.weaponSlot >= 4 ? 0.85 : 0.28));
    soldier.muzzleFlashTimer = 0.065;

    // Rate of fire + authentic burst pacing (staggered pauses keep 5v20 intense and fair)
    const rpm = spec.rpm || 600;
    const shotInterval = 60 / rpm;
    soldier.burstCount++;
    const maxBurst = soldier.role === 'mg' ? (isSuppressive ? 7 : 5)
      : (soldier.weaponSlot >= 2 ? 1 : (isSuppressive ? 4 : 3));

    if (soldier.burstCount >= maxBurst) {
      soldier.burstCount = 0;
      const factionPause = soldier.faction === 'RU' ? 1.15 : 0.48;
      soldier.fireCooldown = (isSuppressive ? 0.50 : factionPause) + Math.random() * 0.55 + (soldier.weaponSlot >= 4 ? 1.8 : 0);
    } else {
      soldier.fireCooldown = Math.max(0.10, shotInterval * (soldier.faction === 'RU' ? 1.55 : 1.10));
    }

    if (DF.Ballistics && typeof DF.Ballistics.fireWeapon === 'function') {
      DF.Ballistics.fireWeapon(soldier, spec, muzzle, dir, false, { spread: totalSpread, isAds: true });
    }
    // Emit soft volumetric muzzle flash starburst + hot sparks + faint barrel gas wisp
    if (DF.Renderer && typeof DF.Renderer.spawnParticle === 'function') {
      DF.Renderer.spawnParticle({
        type: 'flash',
        pos: [muzzle[0], muzzle[1], muzzle[2]],
        vel: [dir[0] * 1.5, dir[1] * 1.5, dir[2] * 1.5],
        size: soldier.weaponSlot >= 4 ? 0.65 : 0.36,
        sizeEnd: soldier.weaponSlot >= 4 ? 1.25 : 0.58,
        life: 0.065,
        color: [1.0, 0.80, 0.38],
        alpha: 0.92,
        gravity: 0,
        drag: 2.0,
        additive: true
      });
      for (let k = 0; k < 2; k++) {
        DF.Renderer.spawnParticle({
          type: 'spark',
          pos: [muzzle[0], muzzle[1], muzzle[2]],
          vel: [
            dir[0] * (8 + Math.random() * 7) + (Math.random() - 0.5) * 3.5,
            dir[1] * (8 + Math.random() * 7) + (Math.random() - 0.3) * 2.5,
            dir[2] * (8 + Math.random() * 7) + (Math.random() - 0.5) * 3.5
          ],
          size: 0.055,
          sizeEnd: 0.015,
          life: 0.12 + Math.random() * 0.08,
          color: [1.0, 0.78, 0.32],
          alpha: 0.95,
          gravity: 6.5,
          drag: 1.5,
          additive: true
        });
      }
      if (Math.random() < 0.45) {
        DF.Renderer.spawnParticle({
          type: 'smoke',
          pos: [muzzle[0], muzzle[1], muzzle[2]],
          vel: [dir[0] * 1.8 + (Math.random() - 0.5) * 0.4, 0.45, dir[2] * 1.8 + (Math.random() - 0.5) * 0.4],
          size: 0.16,
          sizeEnd: 0.62,
          life: 0.55,
          color: [0.62, 0.60, 0.58],
          alpha: 0.24,
          gravity: -0.35,
          drag: 2.4
        });
      }
    }
    if (DF.Audio && typeof DF.Audio.playGunshot === 'function') {
      DF.Audio.playGunshot(spec.audioProfile || 'ar_556', muzzle, false);
    }
  }

  function tryThrowGrenade(soldier, type, targetPos) {
    if (soldier.grenadeCooldown > 0 || soldier.throwTimer > 0) return false;
    if (type === 'frag' && soldier.fragCount <= 0) return false;
    if (type === 'smoke' && soldier.smokeCount <= 0) return false;
    if (!DF.Ballistics || typeof DF.Ballistics.throwGrenade !== 'function') return false;

    const origin = [soldier.pos[0], soldier.pos[1] + 1.52, soldier.pos[2]];
    const dx = targetPos[0] - origin[0];
    const dz = targetPos[2] - origin[2];
    const dist = Math.hypot(dx, dz);
    if (dist < 6 || dist > 36) return false;

    const dy = (targetPos[1] || 0) - origin[1] + Math.min(8.5, dist * 0.34);
    const len = Math.hypot(dx, dy, dz) || 1;
    const dir = [dx / len, dy / len, dz / len];

    if (type === 'frag') soldier.fragCount--;
    else soldier.smokeCount--;

    soldier.throwTimer = 0.55;
    soldier.grenadeCooldown = type === 'smoke' ? 12.0 : 16.0;
    DF.Ballistics.throwGrenade(soldier, type, origin, dir);
    return true;
  }

  // ---------------------------------------------------------------------------
  // AI Movement, Pathfinding & Grounded Capsule Physics
  // ---------------------------------------------------------------------------
  function requestPath(soldier, dest) {
    if (!dest) return;
    if (DF.Physics && typeof DF.Physics.findPath === 'function') {
      const p = DF.Physics.findPath(soldier.pos, dest, { isVehicle: false });
      if (Array.isArray(p) && p.length > 0) {
        soldier.path = p;
        soldier.pathIdx = 0;
        return;
      }
    }
    soldier.path = [[dest[0], getGroundY(dest[0], dest[2], (dest[1] || 0) + 0.5), dest[2]]];
    soldier.pathIdx = 0;
  }

  function moveSoldierAlongPath(soldier, destPos, desiredSpeed, dt) {
    if (!destPos) {
      soldier.vel[0] *= Math.max(0, 1 - dt * 10);
      soldier.vel[2] *= Math.max(0, 1 - dt * 10);
      applyPhysicsCapsule(soldier, dt);
      return true;
    }

    const dToDest = distXZ(soldier.pos, destPos);
    if (dToDest < 1.15) {
      soldier.vel[0] *= Math.max(0, 1 - dt * 10);
      soldier.vel[2] *= Math.max(0, 1 - dt * 10);
      soldier.path = null;
      applyPhysicsCapsule(soldier, dt);
      return true;
    }

    soldier.pathTimer -= dt;
    if (!soldier.path || soldier.pathIdx >= soldier.path.length || soldier.pathTimer <= 0) {
      requestPath(soldier, destPos);
      soldier.pathTimer = 1.4 + Math.random() * 0.9;
    }

    let wp = (soldier.path && soldier.path[soldier.pathIdx]) || destPos;
    while (soldier.path && soldier.pathIdx < soldier.path.length - 1 && distXZ(soldier.pos, wp) < 1.15) {
      soldier.pathIdx++;
      wp = soldier.path[soldier.pathIdx];
    }

    const dx = wp[0] - soldier.pos[0];
    const dz = wp[2] - soldier.pos[2];
    const len = Math.hypot(dx, dz) || 1;
    const spd = soldier.crouching ? Math.min(desiredSpeed, MAX_SPEED_CROUCH) : desiredSpeed;

    // Gentle local separation from other soldiers so allies never stack on the same point
    let sepX = 0, sepZ = 0;
    for (let i = 0; i < _soldiers.length; i++) {
      const o = _soldiers[i];
      if (o === soldier || o.state !== 'alive' || o.inVehicleId) continue;
      const ox = soldier.pos[0] - o.pos[0];
      const oz = soldier.pos[2] - o.pos[2];
      const d2 = ox * ox + oz * oz;
      if (d2 > 0.001 && d2 < 1.35) {
        const inv = (1.16 - Math.sqrt(d2)) / Math.sqrt(d2);
        sepX += ox * inv * 1.4;
        sepZ += oz * inv * 1.4;
      }
    }

    const targetVx = (dx / len) * spd + sepX;
    const targetVz = (dz / len) * spd + sepZ;
    const accel = Math.min(1, dt * 8.5);
    soldier.vel[0] = lerp(soldier.vel[0], targetVx, accel);
    soldier.vel[2] = lerp(soldier.vel[2], targetVz, accel);

    // Stuck recovery: nudge laterally & re-path if blocked by fresh rubble/vehicle
    const moved = distXZ(soldier.pos, soldier.lastPos);
    if (moved < 0.06 * dt * 10 && spd > 1.0) {
      soldier.stuckTimer += dt;
      if (soldier.stuckTimer > 1.1) {
        soldier.vel[0] += (-dz / len) * 2.5;
        soldier.vel[2] += (dx / len) * 2.5;
        soldier.pathTimer = 0;
        soldier.stuckTimer = 0;
      }
    } else {
      soldier.stuckTimer = Math.max(0, soldier.stuckTimer - dt * 2);
    }
    soldier.lastPos[0] = soldier.pos[0];
    soldier.lastPos[1] = soldier.pos[1];
    soldier.lastPos[2] = soldier.pos[2];

    applyPhysicsCapsule(soldier, dt);
    return false;
  }

  function applyPhysicsCapsule(soldier, dt) {
    const h = soldier.crouching ? SOLDIER_HEIGHT_CROUCH : SOLDIER_HEIGHT_STAND;
    if (DF.Physics && typeof DF.Physics.moveCapsule === 'function') {
      const res = DF.Physics.moveCapsule(soldier.pos, soldier.vel, SOLDIER_RADIUS, h, dt, {
        ignoreIds: [soldier.id]
      });
      if (res && res.grounded && Number.isFinite(res.floorY)) {
        soldier.pos[1] = res.floorY;
      }
    } else {
      soldier.pos[0] = clamp(soldier.pos[0] + soldier.vel[0] * dt, -88, 88);
      soldier.pos[2] = clamp(soldier.pos[2] + soldier.vel[2] * dt, -53, 53);
      soldier.pos[1] = getGroundY(soldier.pos[0], soldier.pos[2], soldier.pos[1] + 0.6);
    }

    // Strict zero-NaN & map bounds guard
    if (!Number.isFinite(soldier.pos[0])) soldier.pos[0] = 0;
    if (!Number.isFinite(soldier.pos[1])) soldier.pos[1] = 0;
    if (!Number.isFinite(soldier.pos[2])) soldier.pos[2] = 0;
    soldier.pos[0] = clamp(soldier.pos[0], -88.5, 88.5);
    soldier.pos[2] = clamp(soldier.pos[2], -53.5, 53.5);

    // Advance walk/run leg cycle cleanly
    const spd = Math.hypot(soldier.vel[0], soldier.vel[2]);
    if (spd > 0.2) {
      soldier.animPhase += dt * (2.6 + spd * 1.65);
    }
  }

  // ---------------------------------------------------------------------------
  // AI Vehicle Crew Logic (Drives Tank / IFV, Engages Enemy Armor & Walls!)
  // ---------------------------------------------------------------------------
  function updateVehicleCrewAI(soldier, dt) {
    const veh = getVehicleById(soldier.inVehicleId);
    if (!veh || veh.destroyed) {
      soldier.inVehicleId = null;
      return;
    }

    // Sync soldier pos inside vehicle for tactical map/sector capture accounting
    soldier.pos[0] = veh.pos[0];
    soldier.pos[1] = veh.pos[1] + 0.6;
    soldier.pos[2] = veh.pos[2];

    // Bail out if vehicle is burning critically (< 16% HP)
    if ((veh.hp || 0) < (veh.maxHp || 1000) * 0.16) {
      if (DF.Armor && typeof DF.Armor.exitVehicle === 'function') {
        DF.Armor.exitVehicle(veh, soldier);
      }
      soldier.inVehicleId = null;
      return;
    }

    // Pick tactical anchor along the main armored avenue near active sector
    const sec = getActiveSector();
    const desiredX = soldier.faction === 'RU'
      ? clamp(sec.pos[0] - 18, -72, 48)
      : clamp(sec.pos[0] + 18, -32, 68);
    const desiredZ = clamp((veh.id && veh.id.indexOf('2') >= 0 ? 5.5 : -4.5), -9.5, 9.5);
    const dest = soldier.order === 'attack' && soldier.orderPos ? soldier.orderPos : [desiredX, 0, desiredZ];

    // Find best threat for vehicle turret
    const threat = findBestThreat(soldier);
    const dx = dest[0] - veh.pos[0];
    const dz = dest[2] - veh.pos[2];
    const distToDest = Math.hypot(dx, dz);

    // Compute AI vehicle input block (consumed by DF.Armor.update)
    let throttle = 0;
    let steer = 0;
    if (distToDest > 7.5) {
      const targetYaw = yawFromDir(dx, dz);
      const diff = angleDiff(veh.yaw || 0, targetYaw);
      steer = clamp(diff * 1.8, -1, 1);
      throttle = Math.abs(diff) < 0.8 ? 0.72 : 0.2;
    } else if (threat) {
      // Angle thick FRONT armor directly toward threat!
      const tYaw = yawFromDir(threat.pos[0] - veh.pos[0], threat.pos[2] - veh.pos[2]);
      const diff = angleDiff(veh.yaw || 0, tYaw);
      if (Math.abs(diff) > 0.25) steer = clamp(diff * 1.4, -0.8, 0.8);
    }

    let aimYaw = veh.turretYaw !== undefined ? veh.turretYaw : (veh.yaw || 0);
    let aimPitch = 0;
    let fireMain = false;
    let fireSecondary = false;
    let popSmoke = false;

    if (threat && _simTime >= 4.5) {
      const tx = threat.pos[0] - veh.pos[0];
      const ty = threat.pos[1] - (veh.pos[1] + 2.0);
      const tz = threat.pos[2] - veh.pos[2];
      const hd = Math.hypot(tx, tz) || 1;
      aimYaw = yawFromDir(tx, tz);
      aimPitch = clamp(Math.atan2(ty, hd), -0.14, 0.35);

      const turretErr = Math.abs(angleDiff(veh.turretYaw || 0, aimYaw));
      if (turretErr < 0.14) {
        if (threat.type === 'vehicle' || hd > 24) {
          fireMain = true;
        } else {
          fireMain = Math.random() < 0.25;
          fireSecondary = true;
        }
      }
    }

    // Deploy 81mm thermal smoke when damaged under 55% HP
    if ((veh.hp || 0) < (veh.maxHp || 1000) * 0.55 && (veh.smokeCooldown || 0) <= 0) {
      popSmoke = true;
    }

    // Attach standardized AI control object onto vehicle for DF.Armor.update
    veh.aiControl = {
      active: true,
      throttle,
      steer,
      aimYaw,
      aimPitch,
      aimPos: threat ? threat.pos : null,
      fireMain,
      fireSecondary,
      smoke: popSmoke
    };
  }

  // ---------------------------------------------------------------------------
  // Core Soldier Tactical FSM
  // ---------------------------------------------------------------------------
  function getSquadObjectivePos(soldier) {
    const sec = getActiveSector();

    // Respect explicit player squad orders for player's faction
    if (soldier.order === 'follow' && _playerSoldier && _playerSoldier.faction === soldier.faction && _playerSoldier.state === 'alive') {
      const idx = _soldiers.indexOf(soldier);
      const angle = (idx % 5) * 1.25 + (_playerSoldier.yaw || 0) + Math.PI;
      const dist = 5.5 + (idx % 3) * 2.2;
      return [
        clamp(_playerSoldier.pos[0] + Math.sin(angle) * dist, -86, 86),
        _playerSoldier.pos[1],
        clamp(_playerSoldier.pos[2] + Math.cos(angle) * dist, -51, 51)
      ];
    }
    if ((soldier.order === 'attack' || soldier.order === 'flank') && soldier.orderPos) {
      return soldier.orderPos;
    }

    // Ukrainian 5-man Hardened Urban Defense Doctrine
    // Keep elevated 2nd-floor windows & protected building corners per active Sector (A/B/C)!
    if (soldier.faction === 'UA') {
      if (_activeSectorIdx === 0) {
        if (soldier.role === 'mg')     return [-38.0, 3.85, -15.6]; // Building 1 Floor 2 South window
        if (soldier.role === 'sniper') return [-36.0, 3.85,  15.6]; // Building 2 Floor 2 North window
        if (soldier.role === 'at')     return [-22.0, 0.0,    2.5]; // East reserve anti-armor pocket
        if (soldier.role === 'medic')  return [-31.0, 0.25, -21.0]; // Building 1 ground hall safe staging
        return [-28.5, 0.0, -3.0];
      }
      if (_activeSectorIdx === 1) {
        if (soldier.role === 'mg')     return [2.0,  3.85, -16.6];  // Building 3 Floor 2 overwatch
        if (soldier.role === 'sniper') return [4.0,  3.85,  16.6];  // Building 4 Floor 2 overwatch
        if (soldier.role === 'at')     return [11.5, 0.0,    4.5];  // Lenin Square south barricade
        if (soldier.role === 'medic')  return [10.2, 0.25, -21.0];  // Building 3 ground hall
        return [11.2, 0.0, -1.5];
      }
      // Sector C Command HQ defense (Floor 2 + Rooftop Y=7.45 + Pillbox)
      if (soldier.role === 'sniper') return [52.5, 7.45,  2.5];     // HQ Rooftop sniper parapet
      if (soldier.role === 'mg')     return [52.0, 3.85, -1.5];     // HQ Floor 2 Command Room
      if (soldier.role === 'at')     return [39.2, 0.0,   9.0];     // Courtyard Pillbox
      if (soldier.role === 'medic')  return [54.0, 0.25,  4.5];     // HQ Ground Hall
      return [46.2, 0.0, -1.0];
    }

    // Russian 20-man Multi-Axis Breakthrough Doctrine (4 distinct squads!)
    const sx = sec.pos[0];
    if (soldier.squadId === 'RU_SUPPRESS') {
      // Base of fire overwatch 24m west of active sector
      const idx = _soldiers.indexOf(soldier) % 5;
      return [clamp(sx - 24, -76, 40), 0, (idx - 2) * 5.2];
    }
    if (soldier.squadId === 'RU_NORTH') {
      // North flank alley -> cut south into sector rear!
      const pastCorner = soldier.pos[0] > sx - 6;
      if (!pastCorner) {
        return [clamp(sx + 2, -60, 56), 0, -36];
      }
      return [clamp(sx + 4, -40, 56), 0, -6];
    }
    if (soldier.squadId === 'RU_SOUTH') {
      // South flank alley -> cut north into sector!
      const pastCorner = soldier.pos[0] > sx - 6;
      if (!pastCorner) {
        return [clamp(sx + 2, -60, 56), 0, 36];
      }
      return [clamp(sx + 4, -40, 56), 0, 6];
    }
    // RU_ASSAULT: direct push into capture radius!
    const idx = _soldiers.indexOf(soldier) % 5;
    return [clamp(sx + (idx % 2 === 0 ? 1 : -3), -50, 58), 0, (idx - 2) * 3.8];
  }

  function updateAISoldier(soldier, dt) {
    // 1. Vehicle crew duty
    if (soldier.inVehicleId) {
      updateVehicleCrewAI(soldier, dt);
      return;
    }

    // 2. Player-body self-preservation when player is piloting Drone or Robot Dog!
    if (soldier.isPlayer) {
      if (!isPlayerRemoteControlling()) return;
      soldier.crouching = true;
      soldier.stance = 'crouch';
      soldier.vel[0] *= Math.max(0, 1 - dt * 10);
      soldier.vel[2] *= Math.max(0, 1 - dt * 10);
      applyPhysicsCapsule(soldier, dt);
      // Defend self against close enemies (< 20m)
      soldier.losTimer -= dt;
      if (soldier.losTimer <= 0) {
        soldier.losTimer = 0.25;
        const t = findBestThreat(soldier);
        if (t && dist3D(soldier.pos, t.pos) < 22) {
          const dx = t.pos[0] - soldier.pos[0];
          const dy = t.pos[1] - (soldier.pos[1] + 1.05);
          const dz = t.pos[2] - soldier.pos[2];
          soldier.yaw = yawFromDir(dx, dz);
          soldier.pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz) || 1), -0.6, 0.6);
          fireAIWeapon(soldier, t.pos, false);
        }
      }
      return;
    }

    // 3. Proactive / Ordered Medic Revive Mission (Top Priority!)
    if (soldier.reviveTargetId) {
      const wounded = getSoldierById(soldier.reviveTargetId);
      if (!wounded || wounded.state !== 'downed') {
        soldier.reviveTargetId = null;
      } else {
        const d = dist3D(soldier.pos, wounded.pos);
        // Pop smoke screen mid-approach if carrying smoke and wounded ally is exposed!
        if (d > 5.0 && d < 18.0 && soldier.smokeCount > 0 && soldier.grenadeCooldown <= 0) {
          tryThrowGrenade(soldier, 'smoke', wounded.pos);
        }
        if (d > 2.35) {
          soldier.crouching = false;
          soldier.stance = 'sprint';
          soldier.lean = 0;
          moveSoldierAlongPath(soldier, wounded.pos, MAX_SPEED_SPRINT, dt);
          const mdx = wounded.pos[0] - soldier.pos[0];
          const mdz = wounded.pos[2] - soldier.pos[2];
          soldier.yaw += angleDiff(soldier.yaw, yawFromDir(mdx, mdz)) * Math.min(1, dt * 8);
          return;
        } else {
          // Kneel beside wounded ally and perform medical aid!
          soldier.vel[0] = 0;
          soldier.vel[2] = 0;
          soldier.crouching = true;
          soldier.stance = 'kneel';
          const mdx = wounded.pos[0] - soldier.pos[0];
          const mdz = wounded.pos[2] - soldier.pos[2];
          soldier.yaw += angleDiff(soldier.yaw, yawFromDir(mdx, mdz)) * Math.min(1, dt * 10);
          const reqTime = soldier.role === 'medic' ? REVIVE_TIME_MEDIC : REVIVE_TIME_NORMAL;
          wounded.reviveProgress = clamp(wounded.reviveProgress + dt / reqTime, 0, 1);
          if (wounded.reviveProgress >= 1.0) {
            reviveSoldier(wounded, soldier);
          }
          return;
        }
      }
    }

    // 4. Vehicle Boarding Mission (F6 order OR automatic crewmen)
    soldier.vehicleSearchTimer -= dt;
    if (soldier.order === 'vehicle' && soldier.targetVehicleId) {
      const veh = getVehicleById(soldier.targetVehicleId);
      if (!veh || veh.destroyed || veh.occupant || veh.driver || veh.isPlayerControlled) {
        soldier.targetVehicleId = null;
        soldier.order = soldier.faction === 'UA' ? 'defend' : 'attack';
      } else {
        const d = distXZ(soldier.pos, veh.pos);
        if (d < 4.5) {
          if (DF.Armor && typeof DF.Armor.enterVehicle === 'function') {
            const ok = DF.Armor.enterVehicle(veh, soldier, false);
            if (ok !== false) {
              soldier.inVehicleId = veh.id;
              return;
            }
          }
          soldier.targetVehicleId = null;
        } else {
          soldier.crouching = false;
          moveSoldierAlongPath(soldier, veh.pos, MAX_SPEED_SPRINT, dt);
          soldier.yaw += angleDiff(soldier.yaw, yawFromDir(veh.pos[0] - soldier.pos[0], veh.pos[2] - soldier.pos[2])) * Math.min(1, dt * 7);
          return;
        }
      }
    } else if (soldier.vehicleSearchTimer <= 0) {
      soldier.vehicleSearchTimer = 9.0 + Math.random() * 5.0;
      // Designated RU armor crewmen (and UA AT/MG if vehicle sits empty near them) automatically crew friendly armor!
      const canAutoCrew = soldier.armorCrew || (soldier.faction === 'UA' && soldier.role === 'mg' && _simTime > 12);
      if (canAutoCrew) {
        const veh = findAvailableFriendlyVehicle(soldier.faction, soldier.pos);
        if (veh && distXZ(soldier.pos, veh.pos) < 38) {
          soldier.order = 'vehicle';
          soldier.targetVehicleId = veh.id;
        }
      }
    }

    // 5. Threat Detection (staggered ~4 Hz for silky FPS)
    soldier.losTimer -= dt;
    let threat = null;
    if (soldier.losTimer <= 0) {
      soldier.losTimer = 0.22 + Math.random() * 0.12;
      threat = findBestThreat(soldier);
      if (threat) {
        soldier.hasTargetLOS = true;
        if (threat.type === 'soldier') {
          soldier.targetId = threat.entity.id;
          soldier.targetVehicleId = null;
        } else {
          soldier.targetVehicleId = threat.entity.id;
          soldier.targetId = null;
        }
      } else {
        soldier.hasTargetLOS = false;
        soldier.targetVehicleId = null;
      }
    } else if (soldier.hasTargetLOS) {
      if (soldier.targetVehicleId) {
        const v = getVehicleById(soldier.targetVehicleId);
        if (v && !v.destroyed) threat = { type: 'vehicle', entity: v, pos: [v.pos[0], v.pos[1] + 1.4, v.pos[2]] };
      } else if (soldier.targetId) {
        const e = getSoldierById(soldier.targetId);
        if (e && e.state === 'alive' && !e.inVehicleId) {
          threat = { type: 'soldier', entity: e, pos: [e.pos[0], e.pos[1] + (e.crouching ? 0.92 : 1.35), e.pos[2]] };
        }
      }
    }

    // 6. Suppress Area Order (F3): lay down sustained fire on ordered zone!
    if (soldier.order === 'suppress' && soldier.orderPos && !threat) {
      const supTarget = [soldier.orderPos[0], (soldier.orderPos[1] || 0) + 1.2, soldier.orderPos[2]];
      const eye = [soldier.pos[0], soldier.pos[1] + 1.4, soldier.pos[2]];
      if (dist3D(soldier.pos, supTarget) < 62 && hasLineOfSight(eye, supTarget)) {
        soldier.crouching = true;
        soldier.vel[0] *= 0.85;
        soldier.vel[2] *= 0.85;
        applyPhysicsCapsule(soldier, dt);
        const dx = supTarget[0] - soldier.pos[0];
        const dy = supTarget[1] - (soldier.pos[1] + 1.15);
        const dz = supTarget[2] - soldier.pos[2];
        soldier.yaw += angleDiff(soldier.yaw, yawFromDir(dx, dz)) * Math.min(1, dt * 8);
        soldier.pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz) || 1), -0.6, 0.6);
        fireAIWeapon(soldier, supTarget, true);
        return;
      }
    }

    // 7. Tactical Cover & Objective Positioning
    const objectivePos = getSquadObjectivePos(soldier);
    soldier.aiTimer -= dt;

    if (soldier.aiTimer <= 0) {
      soldier.aiTimer = 1.6 + Math.random() * 1.4;
      const threatPos = threat ? threat.pos : (soldier.faction === 'UA' ? [-70, 1, 0] : [52, 1, 0]);
      const distToObj = distXZ(soldier.pos, objectivePos);

      // Search for tactical cover near current position or near objective
      const isElevatedDefender = soldier.faction === 'UA' && (soldier.role === 'sniper' || soldier.role === 'mg') && soldier.order === 'defend';
      const searchAnchor = distToObj < 16 ? objectivePos : soldier.pos;
      const searchRad = isElevatedDefender ? 5.5 : 14.0;
      const preferElevated = isElevatedDefender;

      if (DF.Physics && typeof DF.Physics.getBestCover === 'function') {
        const cov = DF.Physics.getBestCover(searchAnchor, threatPos, searchRad, soldier.faction, preferElevated);
        if (cov && cov.pos) {
          // Elevated 2nd-floor window defenders must stay on their floor & near their window!
          const floorOk = !isElevatedDefender || (Math.abs(cov.pos[1] - objectivePos[1]) < 0.9 && distXZ(cov.pos, objectivePos) < 6.0);
          // Ground UA defenders should NOT run forward into the enemy avenue ahead of their anchor
          const safeAnchorOk = soldier.faction !== 'UA' || soldier.order !== 'defend' || cov.pos[0] >= objectivePos[0] - 5.0;
          const curDist = distXZ(soldier.pos, objectivePos);
          const covDist = distXZ(cov.pos, objectivePos);
          if (floorOk && safeAnchorOk && (soldier.faction === 'UA' || soldier.suppression > 0.35 || covDist <= curDist + 6.0)) {
            soldier.coverNode = cov;
          }
        }
      }
    }

    // Decide movement target & speed
    let moveDest = objectivePos;
    let moveSpeed = soldier.order === 'flank' ? MAX_SPEED_SPRINT : MAX_SPEED_RUN;

    if (soldier.coverNode && soldier.coverNode.pos) {
      const coverDist = distXZ(soldier.pos, soldier.coverNode.pos);
      const shouldHoldCover = soldier.suppression > 0.35
        || soldier.reloading
        || soldier.faction === 'UA'
        || soldier.squadId === 'RU_SUPPRESS'
        || (threat && coverDist < 9.0);

      if (shouldHoldCover) {
        moveDest = soldier.coverNode.pos;
        moveSpeed = soldier.suppression > 0.5 ? MAX_SPEED_SPRINT : MAX_SPEED_RUN;
      }
    }

    const arrived = moveSoldierAlongPath(soldier, moveDest, moveSpeed, dt);

    // 8. Combat Stance, Cover Peeking & Weapon Engagement
    if (arrived) {
      // Behind cover: alternate peeking up/sideways to shoot vs ducking under suppression!
      soldier.peekTimer -= dt;
      if (soldier.suppression > 0.65 || soldier.reloading) {
        soldier.isPeeking = false;
        soldier.crouching = true;
        soldier.lean = lerp(soldier.lean, 0, Math.min(1, dt * 6));
      } else if (soldier.peekTimer <= 0) {
        soldier.isPeeking = !soldier.isPeeking;
        soldier.peekTimer = soldier.isPeeking ? (1.4 + Math.random() * 1.4) : (0.9 + Math.random() * 1.0);
      }

      if (soldier.isPeeking && threat) {
        soldier.crouching = soldier.coverNode && soldier.coverNode.height && soldier.coverNode.height < 1.15 ? false : false;
        const side = ((soldier.id.charCodeAt(soldier.id.length - 1) || 0) % 2 === 0) ? 1 : -1;
        soldier.lean = lerp(soldier.lean, side * 0.65, Math.min(1, dt * 6));
      } else {
        soldier.crouching = true;
        soldier.lean = lerp(soldier.lean, 0, Math.min(1, dt * 6));
      }
    } else {
      soldier.crouching = soldier.suppression > 0.58;
      soldier.lean = lerp(soldier.lean, 0, Math.min(1, dt * 6));
    }
    soldier.stance = soldier.crouching ? 'crouch' : (Math.hypot(soldier.vel[0], soldier.vel[2]) > 4.2 ? 'sprint' : 'stand');

    // Aim & Fire / Throw Grenades
    if (threat) {
      const dx = threat.pos[0] - soldier.pos[0];
      const dy = threat.pos[1] - (soldier.pos[1] + (soldier.crouching ? 1.05 : 1.48));
      const dz = threat.pos[2] - soldier.pos[2];
      const hDist = Math.hypot(dx, dz) || 1;
      const targetYaw = yawFromDir(dx, dz);
      const targetPitch = clamp(Math.atan2(dy, hDist), -0.72, 0.72);

      const turnRate = soldier.faction === 'UA' ? 9.5 : 7.5;
      soldier.yaw += angleDiff(soldier.yaw, targetYaw) * Math.min(1, dt * turnRate);
      soldier.pitch = lerp(soldier.pitch, targetPitch, Math.min(1, dt * 9.0));

      const aimErr = Math.abs(angleDiff(soldier.yaw, targetYaw));

      // Tactical Opening Smoke Screen for RU Assault Squad (2.2s..4.0s)
      if (!soldier.initialSmokeDone && soldier.faction === 'RU' && soldier.squadId === 'RU_ASSAULT' && _simTime > 2.2 && soldier.smokeCount > 0) {
        soldier.initialSmokeDone = true;
        if (Math.random() < 0.45) {
          const midPt = [lerp(soldier.pos[0], threat.pos[0], 0.48), 0, lerp(soldier.pos[2], threat.pos[2], 0.48)];
          tryThrowGrenade(soldier, 'smoke', midPt);
        }
      }

      // Tactical Grenade Usage (RU Assault pops smoke to cross open ground; frags enemies behind cover!)
      if (soldier.grenadeCooldown <= 0 && !soldier.reloading && (soldier.engageDelay || 0) <= 0) {
        if (soldier.faction === 'RU' && soldier.squadId === 'RU_ASSAULT' && soldier.smokeCount > 0 && hDist > 16 && hDist < 34 && soldier.suppression > 0.25) {
          const midPt = [
            lerp(soldier.pos[0], threat.pos[0], 0.45),
            soldier.pos[1],
            lerp(soldier.pos[2], threat.pos[2], 0.45)
          ];
          tryThrowGrenade(soldier, 'smoke', midPt);
        } else if (soldier.fragCount > 0 && hDist > 10 && hDist < 28 && threat.type === 'soldier' && Math.random() < 0.05) {
          tryThrowGrenade(soldier, 'frag', threat.pos);
        }
      }

      if ((soldier.engageDelay || 0) <= 0 && aimErr < 0.24 && (!arrived || soldier.isPeeking || soldier.suppression < 0.5)) {
        const isSup = soldier.role === 'mg' || soldier.squadId === 'RU_SUPPRESS';
        fireAIWeapon(soldier, threat.pos, isSup);
      }
    } else {
      // Face travel direction or expected enemy front
      const spd = Math.hypot(soldier.vel[0], soldier.vel[2]);
      if (spd > 0.4) {
        const moveYaw = yawFromDir(soldier.vel[0], soldier.vel[2]);
        soldier.yaw += angleDiff(soldier.yaw, moveYaw) * Math.min(1, dt * 7.0);
      } else {
        const frontYaw = soldier.faction === 'UA' ? Math.PI * 0.5 : -Math.PI * 0.5;
        soldier.yaw += angleDiff(soldier.yaw, frontYaw) * Math.min(1, dt * 3.0);
      }
      soldier.pitch = lerp(soldier.pitch, 0, Math.min(1, dt * 5.0));

      // Tactical reload when safe & magazine below 40%
      const spec = getWeaponSpecSafe(soldier.weaponSlot, soldier.faction);
      if (!soldier.reloading && soldier.magAmmo < (spec.magSize || 30) * 0.4 && soldier.reserveAmmo > 0) {
        startReload(soldier);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Main Update & Render Loop
  // ---------------------------------------------------------------------------
  function update(dt) {
    if (!dt || dt <= 0) return;
    const step = Math.min(dt, 0.05);
    _simTime += step;
    _frameCount++;

    // Periodic check for un-assigned downed soldiers so proactive medics always respond!
    const checkMedics = (_frameCount % 20) === 0;

    for (let i = 0; i < _soldiers.length; i++) {
      const s = _soldiers[i];

      // Decay universal timers
      if (s.recoil > 0) s.recoil = Math.max(0, s.recoil - step * 4.5);
      if (s.hitFlinch > 0) s.hitFlinch = Math.max(0, s.hitFlinch - step * 5.2);
      if (s.muzzleFlashTimer > 0) s.muzzleFlashTimer = Math.max(0, s.muzzleFlashTimer - step);
      if (s.throwTimer > 0) s.throwTimer = Math.max(0, s.throwTimer - step);
      if (s.grenadeCooldown > 0) s.grenadeCooldown = Math.max(0, s.grenadeCooldown - step);
      if (s.fireCooldown > 0) s.fireCooldown = Math.max(0, s.fireCooldown - step);
      if (s.spottedTimer > 0) s.spottedTimer = Math.max(0, s.spottedTimer - step);
      if (s.suppression > 0) s.suppression = Math.max(0, s.suppression - step * 0.22);
      if (s.spawnGraceTimer > 0) s.spawnGraceTimer = Math.max(0, s.spawnGraceTimer - step);
      if (s.engageDelay > 0) s.engageDelay = Math.max(0, s.engageDelay - step);
      s.timeSinceDamage = (s.timeSinceDamage !== undefined ? s.timeSinceDamage : 99) + step;

      // Smooth out-of-combat medical stabilization (after 5.5s unhit: player up to 80%, or 100% near crate/medic!)
      if (s.state === 'alive' && (s.isPlayer || s.faction === 'UA') && s.timeSinceDamage > 5.5) {
        let capFrac = s.isPlayer ? 0.80 : 0.72;
        if (s.isPlayer) {
          // Near friendly medic or ammo crate boosts regen cap to 100%
          const nearMedic = _soldiers.some(o => o !== s && o.faction === s.faction && o.role === 'medic' && o.state === 'alive' && dist3D(o.pos, s.pos) < 5.5);
          let nearCrate = false;
          if (!nearMedic && DF.Map && typeof DF.Map.getAmmoCrates === 'function') {
            const crates = DF.Map.getAmmoCrates() || [];
            nearCrate = crates.some(c => c && c.pos && dist3D(c.pos, s.pos) < 4.5);
          }
          if (nearMedic || nearCrate) capFrac = 1.0;
        }
        const cap = Math.round(s.maxHp * capFrac);
        if (s.hp < cap) {
          s.hp = Math.min(cap, s.hp + step * (s.isPlayer ? 6.5 : 4.5));
        }
      }

      // Reload timer progression (for AI; player reload managed by main.js/viewmodel)
      if (!s.isPlayer && s.reloading) {
        s.reloadTimer -= step;
        if (s.reloadTimer <= 0) {
          finishReload(s);
        }
      }

      if (s.state === 'dead') {
        s.deathTime += step;
        if (checkMedics) {
          s.pos[1] = getGroundY(s.pos[0], s.pos[2], s.pos[1] + 0.4);
        }
        // Automatic AI Squadmate Reinforcement Respawn when tickets > 0!
        if (!s.isPlayer && DF.GameMode && typeof DF.GameMode.consumeTicket === 'function') {
          if ((s.respawnTimer || 0) <= 0) {
            s.respawnTimer = s.faction === 'UA' ? AI_RESPAWN_TIME_UA : AI_RESPAWN_TIME_RU;
          } else {
            s.respawnTimer -= step;
            if (s.respawnTimer <= 0) {
              if (DF.GameMode.consumeTicket(s.faction)) {
                respawnSoldier(s, _activeSectorIdx, false);
                if (s.faction === _playerFaction && DF.UI && typeof DF.UI.showNotification === 'function') {
                  DF.UI.showNotification(`友军增援：${s.name} 已重返战区`, 'info');
                }
              }
            }
          }
        }
        continue;
      }

      if (s.state === 'downed') {
        if (checkMedics) {
          s.pos[1] = getGroundY(s.pos[0], s.pos[2], s.pos[1] + 0.4);
        }
        // Bleedout pauses while a medic is actively kneeling & reviving!
        const rev = s.reviverId ? getSoldierById(s.reviverId) : null;
        const activelyBeingRevived = rev && rev.state === 'alive' && rev.reviveTargetId === s.id && dist3D(rev.pos, s.pos) < 2.65;
        if (!activelyBeingRevived) {
          s.bleedTimer -= step;
          s.reviveProgress = Math.max(0, s.reviveProgress - step * 0.15);
          if (checkMedics) {
            assignMedicToDowned(s, false);
          }
        }
        if (s.bleedTimer <= 0) {
          const killer = s.lastAttackerId ? getSoldierById(s.lastAttackerId) : null;
          killSoldier(s, killer, '伤势过重', false, true);
        }
        continue;
      }

      // Alive soldier update
      updateAISoldier(s, step);
    }
  }

  function render(renderer, time) {
    if (!renderer || !DF.Character || typeof DF.Character.renderSoldier !== 'function') return;
    for (let i = 0; i < _soldiers.length; i++) {
      DF.Character.renderSoldier(renderer, _soldiers[i], time);
    }
  }

  // Helper for HUD / GameMode to query nearest approaching ally medic for downed player
  function getNearestMedicInfo(target) {
    if (!target) return null;
    if (target.reviverId) {
      const rev = getSoldierById(target.reviverId);
      if (rev && rev.state === 'alive') {
        return { name: rev.name, dist: dist3D(rev.pos, target.pos), progress: target.reviveProgress || 0 };
      }
    }
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < _soldiers.length; i++) {
      const s = _soldiers[i];
      if (s.faction === target.faction && s.state === 'alive' && s.id !== target.id) {
        const d = dist3D(s.pos, target.pos);
        if (d < bestD) { bestD = d; best = s; }
      }
    }
    return best ? { name: best.name, dist: bestD, progress: target.reviveProgress || 0 } : null;
  }

  DF.AI = {
    init,
    getSoldiers,
    getSoldierById,
    getPlayerSoldier,
    setPlayerSoldier,
    issueSquadOrder,
    spotTarget,
    damageSoldier,
    reviveSoldier,
    respawnSoldier,
    getRallyPoint,
    spawnReinforcementWave,
    onSectorFall,
    getNearestMedicInfo,
    update,
    render
  };
})();
