(() => {
  'use strict';
  const DF = (window.DF = window.DF || {});

  // ---------------------------------------------------------------------------
  // DF.GameMode: 3-Sector Urban Breakthrough Match Controller (5 UA vs 20 RU)
  // - Sector A -> Sector B -> Sector C progression with weighted asymmetric capture
  // - Balanced Reinforcement Tickets (UA: 30, RU: 90, +25 RU on sector capture)
  //   maintaining strictly 5 active UA elites vs 20 active RU attackers on field!
  // - Automatic Respawn for BOTH Player (4.0s after bleedout or instant [F])
  //   and AI Squadmates (UA 10s / RU 12s) while keeping Medics valuable (revives save tickets!)
  // - Seamless Ally Takeover (Space) + Anti-Softlock fallback to Auto-Respawn
  // ---------------------------------------------------------------------------

  const INITIAL_MATCH_TIME = 720;  // 12:00 total
  const SECTOR_BONUS_TIME = 150;   // +2:30 per captured sector
  const UA_INITIAL_TICKETS = 30;
  const RU_INITIAL_TICKETS = 90;
  const RU_SECTOR_BONUS_TICKETS = 25;
  const PLAYER_RESPAWN_DELAY = 4.0;

  const DEFAULT_SECTORS = [
    { id: 'A', name: '前线十字路口街垒',     pos: [-38, 0, 0], radius: 15, owner: 'UA', progress: 0, active: true },
    { id: 'B', name: '中心广场与受损居民楼群', pos: [4, 0, 0],   radius: 18, owner: 'UA', progress: 0, active: false },
    { id: 'C', name: '市政指挥楼核心阵地',     pos: [52, 0, 0],  radius: 16, owner: 'UA', progress: 0, active: false }
  ];

  let _phase = 'briefing'; // 'briefing' | 'playing' | 'victory' | 'defeat'
  let _playerFaction = 'UA';
  let _winner = null;
  let _endReason = '';
  let _matchTimer = INITIAL_MATCH_TIME;
  let _elapsed = 0;
  let _activeSectorIndex = 0;
  let _sectors = [];
  let _tickets = { UA: UA_INITIAL_TICKETS, RU: RU_INITIAL_TICKETS };
  let _playerRespawnTimer = 0;
  let _eventsBound = false;

  let _stats = createFreshStats();

  function createFreshStats() {
    return {
      playerKills: 0,
      playerHeadshots: 0,
      playerDeaths: 0,
      alliesRevived: 0,
      vehiclesDestroyed: 0,
      wallsBreached: 0,
      sectorsCaptured: 0,
      sectorsHeld: 3,
      uaKills: 0,
      ruKills: 0,
      damageDealt: 0
    };
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function distXZ(a, b) { return Math.hypot(a[0] - b[0], a[2] - b[2]); }

  function bindEventsOnce() {
    if (_eventsBound || !DF.Events || typeof DF.Events.on !== 'function') return;
    _eventsBound = true;

    DF.Events.on('soldier:killed', (ev) => {
      if (!ev || !ev.victim) return;
      const victim = ev.victim;
      const attacker = ev.attacker;

      if (victim.faction === 'RU') _stats.uaKills++;
      else _stats.ruKills++;

      if (victim.isPlayer) {
        _stats.playerDeaths++;
        // Start automatic 4.0s respawn timer when player dies with remaining tickets
        if (_tickets[_playerFaction] > 0) {
          _playerRespawnTimer = PLAYER_RESPAWN_DELAY;
        }
      }
      if (attacker && attacker.isPlayer && attacker.faction !== victim.faction) {
        _stats.playerKills++;
        if (ev.isHeadshot) _stats.playerHeadshots++;
      }
    });

    DF.Events.on('soldier:revived', (ev) => {
      if (!ev) return;
      if (ev.target && ev.target.faction === _playerFaction) {
        _stats.alliesRevived++;
      }
      if (ev.target && ev.target.isPlayer) {
        _playerRespawnTimer = 0;
      }
    });

    DF.Events.on('vehicle:destroyed', (ev) => {
      if (!ev) return;
      if (!ev.attacker || ev.attacker.isPlayer || ev.attacker.faction === _playerFaction) {
        _stats.vehiclesDestroyed++;
      }
    });

    DF.Events.on('destruction:collapsed', () => {
      _stats.wallsBreached++;
    });

    DF.Events.on('ui:respawnNow', () => {
      respawnPlayerNow(false);
    });
  }

  function syncSectorsFromMap() {
    const mapSecs = (DF.Map && typeof DF.Map.getSectors === 'function') ? DF.Map.getSectors() : null;
    if (Array.isArray(mapSecs) && mapSecs.length >= 3) {
      _sectors = mapSecs;
      for (let i = 0; i < _sectors.length; i++) {
        _sectors[i].owner = 'UA';
        _sectors[i].progress = 0;
        _sectors[i].active = (i === 0);
        _sectors[i].status = 'defended';
        _sectors[i].contested = false;
        _sectors[i].uaCount = 0;
        _sectors[i].ruCount = 0;
      }
    } else {
      _sectors = DEFAULT_SECTORS.map((s, i) => ({
        id: s.id,
        name: s.name,
        pos: s.pos.slice(),
        radius: s.radius,
        owner: 'UA',
        progress: 0,
        active: i === 0,
        status: 'defended',
        contested: false,
        uaCount: 0,
        ruCount: 0
      }));
    }
  }

  function init(playerFaction) {
    bindEventsOnce();
    _playerFaction = playerFaction === 'RU' ? 'RU' : 'UA';
    _phase = 'playing';
    _winner = null;
    _endReason = '';
    _matchTimer = INITIAL_MATCH_TIME;
    _elapsed = 0;
    _activeSectorIndex = 0;
    _tickets = { UA: UA_INITIAL_TICKETS, RU: RU_INITIAL_TICKETS };
    _playerRespawnTimer = 0;
    _stats = createFreshStats();

    syncSectorsFromMap();
    return getState();
  }

  function setPhase(phase) {
    _phase = phase;
  }

  // Ticket ledger used by DF.AI for AI auto-respawn and by player auto-respawn
  function getTickets(faction) {
    if (faction === 'UA' || faction === 'RU') return _tickets[faction];
    return { UA: _tickets.UA, RU: _tickets.RU };
  }

  function consumeTicket(faction) {
    const f = faction === 'RU' ? 'RU' : 'UA';
    if (_tickets[f] > 0) {
      _tickets[f]--;
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Player Auto-Respawn (instant on [F] or automatic when 4.0s timer reaches 0)
  // ---------------------------------------------------------------------------
  function respawnPlayerNow(forceImmediate) {
    if (!DF.AI || typeof DF.AI.getPlayerSoldier !== 'function') return null;
    const ps = DF.AI.getPlayerSoldier();
    if (!ps || ps.state === 'alive') return null;
    if (_phase !== 'playing' && !forceImmediate) return null;

    const f = ps.faction || _playerFaction;
    const hasTicket = _tickets[f] > 0;
    if (!hasTicket && !forceImmediate) {
      // No tickets left — try taking over a living ally if one exists
      return takeOverNextAlly();
    }

    if (hasTicket) {
      _tickets[f]--;
    }
    _playerRespawnTimer = 0;

    // Release any active unmanned/vehicle binding before fresh deployment
    if (DF.Unmanned && typeof DF.Unmanned.releaseControl === 'function') {
      DF.Unmanned.releaseControl();
    }

    if (typeof DF.AI.respawnSoldier === 'function') {
      DF.AI.respawnSoldier(ps, _activeSectorIndex, true);
    } else {
      ps.state = 'alive';
      ps.hp = ps.maxHp || 130;
      ps.bleedTimer = 0;
      ps.reviveProgress = 0;
      ps.reviverId = null;
      ps.inVehicleId = null;
      ps.spawnGraceTimer = 3.0;
    }

    if (DF.Viewmodel && typeof DF.Viewmodel.equip === 'function') {
      DF.Viewmodel.equip(ps.weaponSlot || 0, ps.faction);
    }
    if (DF.Audio && typeof DF.Audio.playRadioCue === 'function') {
      DF.Audio.playRadioCue('ack');
    }
    if (DF.UI && typeof DF.UI.showNotification === 'function') {
      DF.UI.showNotification(`增援部署完成：已于友军集结点复活（剩余兵力 ${_tickets[f]}）`, 'success');
    }
    if (DF.Events && typeof DF.Events.emit === 'function') {
      DF.Events.emit('player:respawned', { soldier: ps, faction: f, ticketsRemaining: _tickets[f] });
    }
    return ps;
  }

  // Optional skip-bleedout trigger (immediately enters dead/respawn or respawns immediately)
  function skipBleedout(immediate) {
    const ps = (DF.AI && DF.AI.getPlayerSoldier) ? DF.AI.getPlayerSoldier() : null;
    if (!ps || ps.state === 'alive') return null;
    if (immediate !== false) {
      return respawnPlayerNow(false);
    }
    if (ps.state === 'downed') {
      ps.bleedTimer = 0;
      ps.state = 'dead';
      if (_tickets[ps.faction] > 0) {
        _playerRespawnTimer = PLAYER_RESPAWN_DELAY;
      }
    }
    return ps;
  }

  // ---------------------------------------------------------------------------
  // Seamless Ally Takeover (Space / Button when Player is Downed or Dead)
  // Anti-softlock: if no living ally is available, automatically triggers respawn!
  // ---------------------------------------------------------------------------
  function takeOverNextAlly() {
    if (!DF.AI || typeof DF.AI.getSoldiers !== 'function') return null;
    const soldiers = DF.AI.getSoldiers();
    const curPlayer = DF.AI.getPlayerSoldier ? DF.AI.getPlayerSoldier() : null;
    const refPos = curPlayer ? curPlayer.pos : [0, 0, 0];

    if (DF.Unmanned && typeof DF.Unmanned.releaseControl === 'function') {
      DF.Unmanned.releaseControl();
    }

    const candidates = soldiers.filter(s =>
      s.faction === _playerFaction &&
      s.state === 'alive' &&
      !s.isPlayer
    );

    if (candidates.length === 0) {
      // Anti-softlock: no living ally -> immediately respawn player if tickets remain!
      if (_tickets[_playerFaction] > 0) {
        return respawnPlayerNow(false);
      }
      if (DF.UI && typeof DF.UI.showNotification === 'function') {
        DF.UI.showNotification('当前已无存活友军及剩余增援兵力', 'danger');
      }
      return null;
    }

    candidates.sort((a, b) => {
      const scoreA = distXZ(a.pos, refPos) + (a.hp < 25 ? 25 : 0) + (a.inVehicleId ? 18 : 0);
      const scoreB = distXZ(b.pos, refPos) + (b.hp < 25 ? 25 : 0) + (b.inVehicleId ? 18 : 0);
      return scoreA - scoreB;
    });

    const nextAlly = candidates[0];
    _playerRespawnTimer = 0;

    if (nextAlly.inVehicleId && DF.Armor && typeof DF.Armor.getVehicles === 'function') {
      const veh = (DF.Armor.getVehicles() || []).find(v => v && v.id === nextAlly.inVehicleId);
      if (veh && DF.Armor.exitVehicle) {
        DF.Armor.exitVehicle(veh, nextAlly);
      }
      nextAlly.inVehicleId = null;
    }

    DF.AI.setPlayerSoldier(nextAlly);

    if (DF.Viewmodel && typeof DF.Viewmodel.equip === 'function') {
      DF.Viewmodel.equip(nextAlly.weaponSlot || 0, nextAlly.faction);
    }

    if (DF.Events && typeof DF.Events.emit === 'function') {
      DF.Events.emit('player:takeover', { oldSoldier: curPlayer, newSoldier: nextAlly });
    }
    return nextAlly;
  }

  // ---------------------------------------------------------------------------
  // Breakthrough Sector Capture, Auto-Respawn Countdown & Victory/Defeat
  // ---------------------------------------------------------------------------
  function computeTroopCounts() {
    const soldiers = (DF.AI && DF.AI.getSoldiers) ? DF.AI.getSoldiers() : [];
    const c = {
      uaAlive: 0, uaDowned: 0, uaDead: 0, uaTotal: 5,
      ruAlive: 0, ruDowned: 0, ruDead: 0, ruTotal: 20,
      uaTickets: _tickets.UA,
      ruTickets: _tickets.RU,
      ruReserves: _tickets.RU
    };
    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (s.faction === 'UA') {
        if (s.state === 'alive') c.uaAlive++;
        else if (s.state === 'downed') c.uaDowned++;
        else c.uaDead++;
      } else {
        if (s.state === 'alive') c.ruAlive++;
        else if (s.state === 'downed') c.ruDowned++;
        else c.ruDead++;
      }
    }
    return c;
  }

  function advanceSector() {
    const captured = _sectors[_activeSectorIndex];
    if (captured) {
      captured.owner = 'RU';
      captured.progress = 1.0;
      captured.active = false;
      captured.status = 'captured';
      captured.contested = false;
    }
    _stats.sectorsCaptured++;
    _stats.sectorsHeld = Math.max(0, _sectors.length - _stats.sectorsCaptured);

    if (DF.Events && typeof DF.Events.emit === 'function') {
      DF.Events.emit('sector:captured', { sectorIndex: _activeSectorIndex, sector: captured });
    }

    if (_activeSectorIndex >= _sectors.length - 1) {
      finishMatch('RU', '红方合成突击群突破全部三道防线，占领市政指挥楼！');
      return;
    }

    // Advance to next sector + time bonus + RU +25 reinforcement ticket bonus!
    _activeSectorIndex++;
    _matchTimer += SECTOR_BONUS_TIME;
    _tickets.RU += RU_SECTOR_BONUS_TICKETS;

    const nextSec = _sectors[_activeSectorIndex];
    if (nextSec) {
      nextSec.active = true;
      nextSec.progress = 0;
      nextSec.status = 'defended';
      nextSec.contested = false;
    }

    // Surge up to 6 fallen RU attackers immediately at captured staging line
    let spawned = 0;
    if (_tickets.RU > 0 && DF.AI && typeof DF.AI.spawnReinforcementWave === 'function') {
      const toDeploy = Math.min(_tickets.RU, 6);
      spawned = DF.AI.spawnReinforcementWave('RU', _activeSectorIndex, toDeploy);
      _tickets.RU = Math.max(0, _tickets.RU - spawned);
    }

    if (DF.AI && typeof DF.AI.onSectorFall === 'function') {
      DF.AI.onSectorFall(_activeSectorIndex);
    }

    if (DF.Audio && typeof DF.Audio.playRadioCue === 'function') {
      DF.Audio.playRadioCue('sector_fall');
    }
    if (DF.UI && typeof DF.UI.showNotification === 'function') {
      const msg = _playerFaction === 'UA'
        ? `${captured.id}区失守！全员立即向 ${nextSec.id}区（${nextSec.name}）转进防守！`
        : `${captured.id}区已攻克！时间 +2:30，增援兵力 +${RU_SECTOR_BONUS_TICKETS}，推进至 ${nextSec.id}区！`;
      DF.UI.showNotification(msg, _playerFaction === 'UA' ? 'danger' : 'success');
    }
  }

  function finishMatch(winnerFaction, reason) {
    if (_phase === 'victory' || _phase === 'defeat') return;
    _winner = winnerFaction;
    _endReason = reason;
    _phase = (winnerFaction === _playerFaction) ? 'victory' : 'defeat';
    _playerRespawnTimer = 0;

    if (DF.Audio && typeof DF.Audio.playRadioCue === 'function') {
      DF.Audio.playRadioCue(_phase === 'victory' ? 'victory' : 'defeat');
    }
    if (DF.Events && typeof DF.Events.emit === 'function') {
      DF.Events.emit('match:ended', { winner: _winner, phase: _phase, reason: _endReason, stats: _stats });
    }
  }

  function update(dt) {
    if (_phase !== 'playing' || !dt || dt <= 0) return;
    const step = Math.min(dt, 0.1);
    _elapsed += step;
    _matchTimer = Math.max(0, _matchTimer - step);

    if (!_sectors.length) syncSectorsFromMap();
    const activeSec = _sectors[_activeSectorIndex];
    const soldiers = (DF.AI && DF.AI.getSoldiers) ? DF.AI.getSoldiers() : [];
    const player = (DF.AI && DF.AI.getPlayerSoldier) ? DF.AI.getPlayerSoldier() : null;

    // Player Auto-Respawn countdown when dead (never leaves player softlocked!)
    if (player && player.state === 'dead') {
      if (_tickets[_playerFaction] > 0) {
        if (_playerRespawnTimer <= 0) {
          _playerRespawnTimer = PLAYER_RESPAWN_DELAY;
        } else {
          _playerRespawnTimer = Math.max(0, _playerRespawnTimer - step);
          if (_playerRespawnTimer <= 0) {
            respawnPlayerNow(false);
          }
        }
      }
    } else {
      _playerRespawnTimer = 0;
    }

    // Evaluate active sector capture presence
    if (activeSec) {
      let uaPresence = 0;
      let ruPresence = 0;
      let uaRaw = 0;
      let ruRaw = 0;

      for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i];
        if (s.state !== 'alive') continue;
        if (distXZ(s.pos, activeSec.pos) <= activeSec.radius) {
          const weight = s.inVehicleId ? 2.0 : 1.0;
          if (s.faction === 'UA') {
            uaRaw++;
            uaPresence += weight * 2.2;
          } else {
            ruRaw++;
            ruPresence += weight;
          }
        }
      }

      activeSec.uaCount = uaRaw;
      activeSec.ruCount = ruRaw;

      if (ruPresence > 0 && uaPresence > 0 && Math.abs(ruPresence - uaPresence) < 0.8) {
        activeSec.status = 'contested';
        activeSec.contested = true;
      } else if (ruPresence > uaPresence) {
        activeSec.status = 'capturing';
        activeSec.contested = uaPresence > 0;
        const advantage = Math.min(6.0, ruPresence - uaPresence);
        activeSec.progress = clamp(activeSec.progress + step * (0.038 + advantage * 0.011), 0, 1);
      } else if (ruPresence === 0 && activeSec.progress > 0) {
        activeSec.status = 'defended';
        activeSec.contested = false;
        activeSec.progress = clamp(activeSec.progress - step * 0.032, 0, 1);
      } else {
        activeSec.status = uaRaw > 0 ? 'defended' : 'idle';
        activeSec.contested = false;
      }

      if (activeSec.progress >= 1.0) {
        advanceSector();
        if (_phase !== 'playing') return;
      }
    }

    // Evaluate victory / defeat conditions (factoring in reinforcement tickets!)
    const counts = computeTroopCounts();

    if (_matchTimer <= 0) {
      finishMatch('UA', '防守倒计时结束！蓝方精英防线成功守住核心阵地！');
      return;
    }

    if (counts.uaAlive === 0 && counts.uaDowned === 0 && _tickets.UA <= 0) {
      finishMatch('RU', '蓝方防线兵力与增援已耗尽，红方夺取战区控制权！');
      return;
    }

    if (counts.ruAlive === 0 && counts.ruDowned === 0 && _tickets.RU <= 0) {
      finishMatch('UA', '红方进攻集群及增援兵力全数耗尽，蓝方防线固若金汤！');
      return;
    }
  }

  function recordDamage(amount, isPlayer) {
    if (isPlayer && amount > 0) _stats.damageDealt += Math.round(amount);
  }

  function getState() {
    const counts = computeTroopCounts();
    const player = (DF.AI && DF.AI.getPlayerSoldier) ? DF.AI.getPlayerSoldier() : null;
    const livingAllies = _playerFaction === 'UA'
      ? Math.max(0, counts.uaAlive - (player && player.state === 'alive' ? 1 : 0))
      : Math.max(0, counts.ruAlive - (player && player.state === 'alive' ? 1 : 0));

    let medicInfo = null;
    if (player && player.state === 'downed' && DF.AI && typeof DF.AI.getNearestMedicInfo === 'function') {
      medicInfo = DF.AI.getNearestMedicInfo(player);
    }

    return {
      phase: _phase,
      playerFaction: _playerFaction,
      winner: _winner,
      endReason: _endReason,
      timer: _matchTimer,
      elapsed: _elapsed,
      activeSectorIndex: _activeSectorIndex,
      activeSector: _sectors[_activeSectorIndex] || null,
      sectors: _sectors,
      tickets: { UA: _tickets.UA, RU: _tickets.RU },
      activeCounts: { UA: counts.uaAlive, RU: counts.ruAlive },
      counts,
      playerRespawnTimer: _playerRespawnTimer,
      canRespawn: _tickets[_playerFaction] > 0,
      canTakeOverAlly: livingAllies > 0,
      livingAllies,
      medicInfo,
      stats: {
        kills: _stats.playerKills,
        headshots: _stats.playerHeadshots,
        revives: _stats.alliesRevived,
        playerKills: _stats.playerKills,
        playerHeadshots: _stats.playerHeadshots,
        playerDeaths: _stats.playerDeaths,
        alliesRevived: _stats.alliesRevived,
        vehiclesDestroyed: _stats.vehiclesDestroyed,
        wallsBreached: _stats.wallsBreached,
        sectorsCaptured: _stats.sectorsCaptured,
        sectorsHeld: _stats.sectorsHeld,
        sectorsLabel: _playerFaction === 'RU' ? `${_stats.sectorsCaptured}/3` : `${_stats.sectorsHeld}/3`,
        uaKills: _stats.uaKills,
        ruKills: _stats.ruKills,
        damageDealt: _stats.damageDealt,
        matchElapsed: Math.round(_elapsed)
      }
    };
  }

  DF.GameMode = {
    init,
    setPhase,
    getTickets,
    consumeTicket,
    respawnPlayerNow,
    skipBleedout,
    takeOverNextAlly,
    recordDamage,
    update,
    getState
  };
})();
