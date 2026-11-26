(() => {
  'use strict';

  window.DF = window.DF || {};

  // ============================================================================
  // DF.UI — Battlefield-Grade Military HUD, Briefing, Radial Wheel, Live Map,
  // Optical/Thermal Scopes, Downed Takeover & Settings.
  // ZERO emojis. ZERO external URLs/fonts. 100% inline SVG + Canvas 2D.
  // ============================================================================

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // Unified Friend-vs-Foe Semantic Palette (consistent regardless of UA or RU side)
  const COL_ALLY = '#38bdf8';       // Cyan-Blue friendly infantry / armor / UAV
  const COL_ALLY_UGV = '#34d399';   // Squad-Teal / Emerald friendly robot dog / accent
  const COL_ENEMY = '#ff3b30';      // Crimson-Red hostile infantry / armor / UAV / UGV
  const COL_REVIVE = '#f5c542';     // Tactical Gold/Amber downed medic cross accent
  const COL_ORDER = '#e8a838';      // Tactical Amber sector / order marker

  // Reusable scratch 4x4 ViewProj matrix for 3D overhead IFF projection
  const scratchVP = new Float32Array(16);
  let iffAnimTime = 0;

  // Map world bounds from DESIGN.md
  const MAP_MIN_X = -90;
  const MAP_MAX_X = 90;
  const MAP_MIN_Z = -55;
  const MAP_MAX_Z = 55;

  // Exact Donbas map building footprints matching src/world/map.js (overridden if snap.mapBuildings provided)
  const FALLBACK_BUILDINGS = [
    { x: -39, z: -22, w: 26, d: 16, label: 'B1' },
    { x: -37, z: 22,  w: 26, d: 16, label: 'B2' },
    { x: 3,   z: -23, w: 30, d: 16, label: 'B3' },
    { x: 4,   z: 23,  w: 28, d: 16, label: 'B4' },
    { x: 37,  z: -24, w: 18, d: 16, label: 'B5' },
    { x: 58,  z: 0,   w: 16, d: 26, label: 'HQ' },
    { x: 37,  z: 23,  w: 16, d: 12, label: 'DEP' }
  ];

  const ORDERS = [
    { id: 'follow',   key: 'F1', name: '跟随推进',  short: '跟随', angle: -90 },
    { id: 'attack',   key: 'F2', name: '进攻/固守', short: '突击', angle: -30 },
    { id: 'suppress', key: 'F3', name: '火力压制',  short: '压制', angle: 30 },
    { id: 'flank',    key: 'F4', name: '侧翼包抄',  short: '包抄', angle: 90 },
    { id: 'revive',   key: 'F5', name: '紧急救援',  short: '救援', angle: 150 },
    { id: 'vehicle',  key: 'F6', name: '载具/无人', short: '协同', angle: 210 }
  ];

  const ORDER_LABELS = {
    follow: '跟随推进',
    attack: '进攻/固守',
    defend: '固守阵地',
    suppress: '火力压制',
    flank: '侧翼包抄',
    revive: '紧急救援',
    vehicle: '载具/无人协同'
  };

  const RELOAD_LABELS = {
    mag_out: '卸下弹匣',
    mag_drop: '抛弃空匣',
    mag_in: '装入弹匣',
    bolt_pull: '拉动枪机',
    bolt_release: '释放枪机',
    pump: '泵动上膛',
    shell_insert: '逐发填弹',
    breech_open: '打开枪膛',
    breech_close: '闭锁枪膛',
    rpg_load: '装填火箭弹'
  };

  // ============================================================================
  // Inline SVG Icon & Weapon Silhouette Library (Zero xmlns URL, Zero Emojis)
  // ============================================================================
  const SVG_ICONS = {
    role_rifleman: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 10L8 5L13 10"/><path d="M3 13L8 8L13 13"/></svg>',
    role_mg:       '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 5h12M2 8h12M2 11h12"/><rect x="5" y="3" width="6" height="10" fill="none"/></svg>',
    role_sniper:   '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/></svg>',
    role_at:       '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 12L10 4M8 3l5 0 0 5"/><path d="M4 10l2 2"/></svg>',
    role_medic:    '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M6.5 2.5h3v4h4v3h-4v4h-3v-4h-4v-3h4z"/></svg>',

    headshot: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="4.5"/><path d="M8 1.5v2.5M8 12v2.5M1.5 8h2.5M12 8h2.5"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/></svg>',
    hitmarker: '<svg viewBox="0 0 44 44" width="44" height="44" fill="none" stroke="currentColor" stroke-linecap="square"><g stroke-width="2.1"><path d="M11 11L17.5 17.5M33 11L26.5 17.5M11 33L17.5 26.5M33 33L26.5 26.5"/></g><g class="df-hm-outer" stroke-width="1.6"><path d="M5.5 5.5L9.5 9.5M38.5 5.5L34.5 9.5M5.5 38.5L9.5 34.5M38.5 38.5L34.5 34.5"/></g><g class="df-hm-armor" stroke-width="1.5"><path d="M22 4L38 22L22 40L6 22Z" stroke-dasharray="5 5"/></g></svg>',

    stance_stand:  '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><circle cx="8" cy="2.6" r="1.6"/><path d="M6 5h4l.8 4.8h-1.4l-.4 5.2h-2l-.4-5.2H5.2z"/></svg>',
    stance_crouch: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><circle cx="8" cy="4.2" r="1.6"/><path d="M5.5 6.8h5l1.2 3.2-2.2 1.2 1 3.3h-2l-.9-2.7-1.6.7-.9 2H3.5l1.2-3.7 1.3-.8z"/></svg>',
    stance_sprint: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><circle cx="10.5" cy="2.8" r="1.5"/><path d="M6.5 5.4l4 .6-1.2 3.4 3.2 2.4-1.2 1.4-3.3-2.2-1.8 3.6-1.7-.8 2.1-4.5-2.6.8-.5-1.5 3.6-1.5z"/></svg>',
    deploy: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 8h10M8 3l5 5-5 5"/></svg>',

    wpn_0: '<svg viewBox="0 0 112 30" class="df-wpn-svg" fill="currentColor"><path d="M4 13h18v-2h14v-3h14v3h22v1.5h28v2.5H72v2h-8l-2 9h-6l2-9H44l-3 7h-5l2-7H22l-5 5H4v-9z"/><rect x="44" y="5" width="10" height="3"/></svg>',
    wpn_1: '<svg viewBox="0 0 112 30" class="df-wpn-svg" fill="currentColor"><path d="M3 13h17v-3h20v-2h18v2h18v2h29v3H78v2H64v8H48v-8h-8l-3 7h-5l2-7H20l-5 4H3v-8z"/><path d="M90 15l5 8h-3l-4-8z"/></svg>',
    wpn_2: '<svg viewBox="0 0 112 30" class="df-wpn-svg" fill="currentColor"><path d="M2 14h20v-2h18v-1h24v2h44v2H64v2h-6l-1 6h-6l1-6H36l-3 6h-5l2-6H18l-4 4H2v-7z"/><path d="M38 6h22v3H38zM43 9h2v3h-2zM53 9h2v3h-2z"/></svg>',
    wpn_3: '<svg viewBox="0 0 112 30" class="df-wpn-svg" fill="currentColor"><path d="M4 15h18l6-3h36v1h40v2.5H68v2h-8v2H40v-2H28l-6 4H4v-6.5z"/><rect x="66" y="16" width="22" height="3.2"/></svg>',
    wpn_4: '<svg viewBox="0 0 112 30" class="df-wpn-svg" fill="currentColor"><path d="M12 13h16v-3h26v-1h38v7H54v2h-8l-3 8h-6l2-8H26l-6 4h-8v-9z"/><rect x="58" y="16" width="16" height="5" rx="1"/></svg>',
    wpn_5: '<svg viewBox="0 0 112 30" class="df-wpn-svg" fill="currentColor"><path d="M6 12l6 2h58v-1h14l14-4 10 5-10 5-14-4H70v-1H12l-6 2v-4z"/><path d="M42 16h5l-2 8h-5zM58 16h5l1 7h-5z"/><rect x="48" y="8" width="6" height="5"/></svg>',
    wpn_tank: '<svg viewBox="0 0 112 30" class="df-wpn-svg" fill="currentColor"><path d="M16 17h56l8 5v4H12v-4z"/><path d="M30 10h26l6 7H26z"/><rect x="58" y="11.5" width="48" height="3"/></svg>',
    wpn_ifv:  '<svg viewBox="0 0 112 30" class="df-wpn-svg" fill="currentColor"><path d="M12 16h64l8 5v5H10v-5z"/><path d="M36 9h22l5 7H32z"/><rect x="58" y="10.5" width="42" height="2.4"/></svg>',
    wpn_drone:'<svg viewBox="0 0 112 30" class="df-wpn-svg" fill="currentColor"><rect x="44" y="12" width="24" height="6"/><path d="M22 10h24v2H22zM66 10h24v2H66zM26 7h14v2H26zM72 7h14v2H72zM48 18h16v4H48z"/></svg>',
    wpn_dog:  '<svg viewBox="0 0 112 30" class="df-wpn-svg" fill="currentColor"><path d="M34 11h42v7H34z"/><path d="M38 18l-6 9h4l6-9zM70 18l6 9h-4l-6-9z"/><rect x="48" y="6" width="16" height="5"/><rect x="64" y="7" width="18" height="2"/></svg>'
  };

  // ============================================================================
  // Module State
  // ============================================================================
  let root = null;
  let callbacks = {};
  let isInit = false;
  let hudHidden = false;
  let briefingVisible = true;
  let radialOpen = false;
  let mapOpen = false;
  let pauseOpen = false;
  let endVisible = false;
  let settingsSyncedOnce = false;
  let endScreenShownForMatch = false;

  const settings = {
    faction: 'UA',
    quality: 'ultra',
    sensitivity: 1.0,
    masterVol: 0.82,
    sfxVol: 0.90,
    musicVol: 0.55,
    invertY: false
  };

  // Transient HUD feedback state (supports BOTH snapshot-driven and imperative triggers)
  let impHitmarkerTimer = 0;
  let impHitmarkerKill = false;
  let impHitmarkerHS = false;
  let impHitmarkerArmor = false;
  let impDamageArcTimer = 0;
  let impDamageArcAngle = 0;
  let toastTimer = 0;
  let lastWeaponKey = '';
  let lastOverlayKey = '';
  let lastActiveOrderName = '跟随推进';
  let lastOrderPos = null;
  let squadHtmlThrottle = 0;
  let lastMatchFaction = null;
  let lastGmElapsed = 0;
  let lastPhase = 'menu';

  // Radial wheel tracking
  let radialHoverIdx = -1;
  let radialVirtX = 0;
  let radialVirtY = 0;

  // Map interactive state
  let mapSelectedOrder = 'attack';
  let mapPings = [];

  // Killfeed entries
  const killfeedEntries = [];

  // Cached DOM refs
  const dom = {};

  function emitAction(eventName, cbName, payload) {
    if (callbacks && typeof callbacks[cbName] === 'function') {
      try { callbacks[cbName](payload); } catch (_) { /* ignore */ }
    }
    if (window.DF && window.DF.Events && typeof window.DF.Events.emit === 'function') {
      try { window.DF.Events.emit(eventName, payload); } catch (_) { /* ignore */ }
    }
  }

  function audioCue(type) {
    if (window.DF && window.DF.Audio && typeof window.DF.Audio.playRadioCue === 'function') {
      window.DF.Audio.playRadioCue(type);
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
    ));
  }

  // ============================================================================
  // Build Complete DOM Tree (Zero External Assets, Zero Emojis)
  // ============================================================================
  function buildMarkup() {
    const cx = 170, cy = 170, rIn = 54, rOut = 154;
    let wedgesMarkup = '';
    for (let i = 0; i < ORDERS.length; i++) {
      const o = ORDERS[i];
      const a0 = ((o.angle - 30) * Math.PI) / 180;
      const a1 = ((o.angle + 30) * Math.PI) / 180;
      const am = (o.angle * Math.PI) / 180;
      const x0i = cx + Math.cos(a0) * rIn, y0i = cy + Math.sin(a0) * rIn;
      const x0o = cx + Math.cos(a0) * rOut, y0o = cy + Math.sin(a0) * rOut;
      const x1o = cx + Math.cos(a1) * rOut, y1o = cy + Math.sin(a1) * rOut;
      const x1i = cx + Math.cos(a1) * rIn, y1i = cy + Math.sin(a1) * rIn;
      const d = `M ${x0i.toFixed(1)} ${y0i.toFixed(1)} L ${x0o.toFixed(1)} ${y0o.toFixed(1)} A ${rOut} ${rOut} 0 0 1 ${x1o.toFixed(1)} ${y1o.toFixed(1)} L ${x1i.toFixed(1)} ${y1i.toFixed(1)} A ${rIn} ${rIn} 0 0 0 ${x0i.toFixed(1)} ${y0i.toFixed(1)} Z`;
      const lx = cx + Math.cos(am) * 106;
      const ly = cy + Math.sin(am) * 106;
      wedgesMarkup += `
        <g data-wedge="${i}">
          <path class="df-wedge" data-idx="${i}" d="${d}"/>
          <text class="df-radial-sub" x="${lx.toFixed(1)}" y="${(ly - 6).toFixed(1)}">${o.key}</text>
          <text class="df-radial-label" x="${lx.toFixed(1)}" y="${(ly + 10).toFixed(1)}">${o.name}</text>
        </g>`;
    }

    return `
      <!-- 1. PRE-BATTLE BRIEFING OVERLAY -->
      <div id="df-briefing">
        <div class="df-brief-panel">
          <div>
            <div class="df-brand-eyebrow"><span class="df-brand-eyebrow-bar"></span><span>5V20 COMBINED ARMS // RED VS BLUE</span></div>
            <h1 class="df-brand-title"><span class="df-brand-title-thin">URBAN BREAKTHROUGH</span>RED VS BLUE</h1>
            <div class="df-amber-rule"></div>
            <div class="df-brand-sub"><span>红蓝对抗</span><span class="df-sep">//</span><span>现代城市防线突破战</span></div>
          </div>

          <div>
            <div class="df-section-label"><span>作战阵营 // FACTION SELECT</span><span>实时战场预览</span></div>
            <div class="df-factions">
              <button type="button" class="df-faction-btn df-ua active" data-faction="UA">
                <div class="df-faction-head">
                  <span class="df-faction-code">BLUE TEAM // 防守</span>
                  <span class="df-faction-force">5人精英</span>
                </div>
                <div class="df-faction-name">蓝方防守阵线</div>
                <div class="df-faction-assets">T-64BV / M2A2 / UAV / UGV</div>
              </button>
              <button type="button" class="df-faction-btn df-ru" data-faction="RU">
                <div class="df-faction-head">
                  <span class="df-faction-code">RED TEAM // 进攻</span>
                  <span class="df-faction-force">20人合成</span>
                </div>
                <div class="df-faction-name">红方进攻集群</div>
                <div class="df-faction-assets">T-72B3 / 2x BMP-2 / UAV / UGV</div>
              </button>
            </div>
          </div>

          <div class="df-bracket df-brief-config">
            <div>
              <div class="df-section-label"><span>画质预设 // GRAPHICS</span><span>PCSS / SSR / FLIR / CAS</span></div>
              <div class="df-quality-seg" id="df-brief-quality">
                <button type="button" class="df-seg-btn active" data-quality="ultra">电影 Ultra</button>
                <button type="button" class="df-seg-btn" data-quality="high">高 High</button>
                <button type="button" class="df-seg-btn" data-quality="medium">中 Medium</button>
                <button type="button" class="df-seg-btn" data-quality="low">低 Low</button>
              </div>
            </div>

            <div class="df-slider-grid">
              <div class="df-slider-row">
                <div class="df-slider-label"><span>鼠标灵敏度</span><strong id="df-b-sens-val">1.00</strong></div>
                <input type="range" class="df-range" id="df-b-sens" min="0.25" max="2.5" step="0.05" value="1.0">
              </div>
              <div class="df-slider-row">
                <div class="df-slider-label"><span>主音量</span><strong id="df-b-master-val">82%</strong></div>
                <input type="range" class="df-range" id="df-b-master" min="0" max="1" step="0.02" value="0.82">
              </div>
              <div class="df-slider-row">
                <div class="df-slider-label"><span>配乐音量</span><strong id="df-b-music-val">55%</strong></div>
                <input type="range" class="df-range" id="df-b-music" min="0" max="1" step="0.02" value="0.55">
              </div>
              <div class="df-slider-row">
                <div class="df-slider-label"><span>音效音量</span><strong id="df-b-sfx-val">90%</strong></div>
                <input type="range" class="df-range" id="df-b-sfx" min="0" max="1" step="0.02" value="0.90">
              </div>
            </div>
          </div>

          <button type="button" class="df-deploy-btn" id="df-deploy-btn">
            <span>部署参战 // DEPLOY</span>
            ${SVG_ICONS.deploy}
          </button>
        </div>

        <div class="df-brief-footer">
          <div class="df-brief-stamp">WEBGL2 PBR // OFFLINE STANDALONE // 3 SECTORS</div>
          <div class="df-brief-keygrid">
            <div class="df-kg-item"><b>WASD</b><span>战术移动</span></div>
            <div class="df-kg-item"><b>RMB</b><span>光学瞄准</span></div>
            <div class="df-kg-item"><b>1-6</b><span>切换武器</span></div>
            <div class="df-kg-item"><b>7 / 8</b><span>无人机/机器狗</span></div>
            <div class="df-kg-item"><b>E</b><span>驾驶/救援</span></div>
            <div class="df-kg-item"><b>Q</b><span>指挥轮盘</span></div>
            <div class="df-kg-item"><b>M</b><span>战术地图</span></div>
            <div class="df-kg-item"><b>T</b><span>烟雾/热成像</span></div>
            <div class="df-kg-item"><b>G / X</b><span>手雷/烟幕</span></div>
          </div>
        </div>
      </div>

      <!-- 2. IN-GAME TACTICAL HUD -->
      <div id="df-hud" class="df-hidden">
        <!-- 3D World-to-Screen Overhead Battlefield IFF Markers -->
        <canvas id="df-iff-canvas"></canvas>
        <div id="df-lowhp-vignette"></div>

        <!-- Persistent Top-Left Live Tactical Minimap (Forward-Up Radar) -->
        <div id="df-minimap-wrap">
          <div class="df-minimap-head">
            <span>TAC RADAR // 75M</span>
            <b id="df-minimap-grid">C3</b>
          </div>
          <canvas id="df-minimap" width="186" height="170"></canvas>
          <div class="df-minimap-foot">
            <span><strong>[M]</strong> 战术全图</span>
            <span id="df-minimap-sec">SEC A</span>
          </div>
        </div>

        <!-- Top Center: Compass + Breakthrough Sector Bar -->
        <div class="df-top-center">
          <div class="df-compass-wrap">
            <canvas id="df-compass-canvas" width="390" height="30"></canvas>
            <div class="df-compass-bearing" id="df-bearing-txt">090</div>
          </div>
          <div class="df-breakthrough">
            <div class="df-force-pill ua"><span class="df-force-dot"></span><span>蓝方</span><span id="df-ua-count">5</span><span class="df-tickets-tag" id="df-ua-tickets">[30]</span></div>
            <div class="df-sectors-row" id="df-sectors-row">
              <div class="df-sector-node owner-ua active" data-sec="0"><div class="df-sector-fill"></div><span class="df-sector-label">A</span></div>
              <div class="df-sector-link"></div>
              <div class="df-sector-node owner-ua" data-sec="1"><div class="df-sector-fill"></div><span class="df-sector-label">B</span></div>
              <div class="df-sector-link"></div>
              <div class="df-sector-node owner-ua" data-sec="2"><div class="df-sector-fill"></div><span class="df-sector-label">C</span></div>
            </div>
            <div class="df-match-timer" id="df-match-timer">06:00</div>
            <div class="df-force-pill ru"><span class="df-tickets-tag" id="df-ru-tickets">[90]</span><span id="df-ru-count">20</span><span>红方</span><span class="df-force-dot"></span></div>
          </div>
        </div>

        <!-- Top Right: Killfeed + Radio Order Toast -->
        <div class="df-top-right">
          <div class="df-killfeed" id="df-killfeed"></div>
          <div id="df-radio-toast"><span class="df-radio-tag">RADIO</span><span id="df-radio-msg"></span></div>
        </div>

        <!-- Center Combat Layer -->
        <div class="df-center-layer">
          <div id="df-optic-layer" class="df-optic-layer df-hidden"></div>

          <div id="df-crosshair">
            <div class="df-ch-tick df-ch-top" id="df-ch-t"></div>
            <div class="df-ch-tick df-ch-bottom" id="df-ch-b"></div>
            <div class="df-ch-tick df-ch-left" id="df-ch-l"></div>
            <div class="df-ch-tick df-ch-right" id="df-ch-r"></div>
            <div class="df-ch-dot"></div>
          </div>

          <div id="df-hitmarker">${SVG_ICONS.hitmarker}</div>

          <svg id="df-damage-arc" viewBox="0 0 210 210">
            <path d="M 65 22 A 92 92 0 0 1 145 22" fill="none" stroke="#e23b32" stroke-width="5" stroke-linecap="butt"/>
            <path d="M 85 16 L 105 4 L 125 16" fill="none" stroke="#f5a642" stroke-width="2"/>
          </svg>
        </div>

        <!-- Center-Bottom Contextual Interaction Prompt -->
        <div id="df-interact-prompt" class="df-hidden">
          <span id="df-interact-text"></span>
          <div class="df-interact-bar df-hidden" id="df-interact-bar"><div class="df-interact-bar-fill" id="df-interact-fill"></div></div>
        </div>

        <!-- Bottom Left: Squad Strip + Player Vitals -->
        <div class="df-bottom-left">
          <div class="df-squad-list" id="df-squad-list"></div>
          <div class="df-bracket df-vitals-box">
            <div class="df-vitals-top">
              <div class="df-hp-readout">
                <span class="df-hp-num" id="df-hp-num">100</span>
                <span class="df-hp-label" id="df-hp-label">HP // INFANTRY</span>
              </div>
              <div class="df-stance-badge" id="df-stance-badge">${SVG_ICONS.stance_stand}<span>STAND</span></div>
            </div>
            <div class="df-bar-track"><div class="df-bar-fill hp" id="df-hp-bar" style="width:100%"></div></div>
            <div class="df-order-pill">
              <span>小队指令</span>
              <strong id="df-active-order">跟随推进</strong>
            </div>
          </div>
        </div>

        <!-- Bottom Right: Weapon Telemetry + Hotkey Ribbon -->
        <div class="df-bottom-right">
          <div class="df-bracket df-weapon-box">
            <div class="df-wpn-top">
              <div id="df-wpn-svg-wrap">${SVG_ICONS.wpn_0}</div>
              <div class="df-ammo-block">
                <span class="df-ammo-mag" id="df-ammo-mag">30</span>
                <span class="df-ammo-slash">/</span>
                <span class="df-ammo-res" id="df-ammo-res">150</span>
              </div>
            </div>
            <div class="df-reload-row df-hidden" id="df-reload-row">
              <span id="df-reload-stage">装填中</span>
              <div class="df-reload-track"><div class="df-reload-fill" id="df-reload-fill"></div></div>
            </div>
            <div class="df-wpn-meta">
              <span class="df-wpn-name" id="df-wpn-name">M4A1</span>
              <span id="df-wpn-cal">5.56x45</span>
              <span class="df-firemode-pill" id="df-firemode">AUTO</span>
            </div>
          </div>

          <div class="df-hotkey-ribbon" id="df-hotkey-ribbon">
            <div class="df-hk-slot active" data-slot="0"><b>1</b>AR</div>
            <div class="df-hk-slot" data-slot="1"><b>2</b>MG</div>
            <div class="df-hk-slot" data-slot="2"><b>3</b>SR</div>
            <div class="df-hk-slot" data-slot="3"><b>4</b>SG</div>
            <div class="df-hk-slot" data-slot="4"><b>5</b>GL</div>
            <div class="df-hk-slot" data-slot="5"><b>6</b>AT</div>
            <div class="df-hk-sep"></div>
            <div class="df-hk-slot" id="df-hk-drone"><b>7</b>UAV</div>
            <div class="df-hk-slot" id="df-hk-dog"><b>8</b>DOG</div>
            <div class="df-hk-sep"></div>
            <div class="df-hk-slot" id="df-hk-frag"><b>G</b><span id="df-frag-cnt">2</span></div>
            <div class="df-hk-slot" id="df-hk-smoke"><b>T</b><span id="df-smoke-cnt">2</span></div>
            <div class="df-hk-slot"><b>Q</b>CMD</div>
            <div class="df-hk-slot"><b>M</b>MAP</div>
          </div>
        </div>
      </div>

      <!-- 3. RADIAL TACTICAL COMMAND WHEEL (HOLD Q) -->
      <div id="df-radial" class="df-hidden">
        <div class="df-radial-wrap">
          <svg class="df-radial-svg" viewBox="0 0 340 340">${wedgesMarkup}</svg>
          <div class="df-radial-hub">
            <div class="df-radial-hub-title" id="df-radial-hub-title">小队指挥</div>
            <div class="df-radial-hub-hint">松开 Q 或点击下达</div>
          </div>
        </div>
      </div>

      <!-- 4. LIVE INTERACTIVE TACTICAL MAP (M KEY) -->
      <div id="df-map-modal" class="df-hidden">
        <div class="df-bracket df-map-frame">
          <div class="df-map-header">
            <div class="df-map-title">TACTICAL MAP // 红蓝战区实时态势 (点击地图派遣小队)</div>
            <div class="df-map-legend">
              <span><i class="df-leg-dot" style="background:#38bdf8"></i>友军力量</span>
              <span><i class="df-leg-dot" style="background:#ff3b30"></i>敌方目标</span>
              <span><i class="df-leg-dot" style="background:#e8a838"></i>任务航点</span>
              <span><i class="df-leg-dot" style="background:#34d399"></i>友方机器狗</span>
            </div>
          </div>
          <canvas id="df-map-canvas" width="790" height="472"></canvas>
          <div class="df-map-footer">
            <div class="df-map-orders" id="df-map-orders">
              <button type="button" class="df-btn-sm active" data-order="attack">进攻/固守目标</button>
              <button type="button" class="df-btn-sm" data-order="suppress">火力压制区域</button>
              <button type="button" class="df-btn-sm" data-order="flank">侧翼包抄路线</button>
              <button type="button" class="df-btn-sm" data-order="vehicle">载具/无人协同</button>
            </div>
            <button type="button" class="df-btn-sm" id="df-map-close">关闭地图 [M / ESC]</button>
          </div>
        </div>
      </div>

      <!-- 5. DOWNED / REVIVE / TAKEOVER OVERLAY -->
      <div id="df-downed" class="df-hidden">
        <div class="df-bracket df-downed-card">
          <svg class="df-bleed-ring" viewBox="0 0 60 60">
            <circle cx="30" cy="30" r="24" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="4"/>
            <circle id="df-bleed-arc" cx="30" cy="30" r="24" fill="none" stroke="#e23b32" stroke-width="4" stroke-dasharray="150.8" stroke-dashoffset="0" transform="rotate(-90 30 30)"/>
            <text id="df-bleed-sec" x="30" y="34" text-anchor="middle" fill="#f0f4f8" font-family="monospace" font-size="13" font-weight="700">15s</text>
          </svg>
          <div class="df-downed-info">
            <div class="df-downed-title" id="df-downed-title">倒地重伤 // 等待队友施救</div>
            <div class="df-downed-medic" id="df-downed-medic">正在呼叫最近友军支援...</div>
            <div class="df-downed-actions">
              <button type="button" class="df-takeover-btn" id="df-takeover-btn">[ SPACE ] 接管存活友军</button>
              <button type="button" class="df-respawn-btn" id="df-respawn-btn">[ F ] 立即跳过并复活</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 6. PAUSE / SETTINGS OVERLAY -->
      <div id="df-pause" class="df-hidden">
        <div class="df-bracket df-modal-box">
          <div class="df-modal-head">
            <div class="df-modal-title">战术暂停 // PAUSED</div>
            <span class="df-mono" style="color:var(--df-text-dim);font-size:11px">ESC / P 继续</span>
          </div>

          <div>
            <div class="df-section-label"><span>画质等级</span><span id="df-p-fps">-- FPS</span></div>
            <div class="df-quality-seg" id="df-pause-quality">
              <button type="button" class="df-seg-btn active" data-quality="ultra">电影 Ultra</button>
              <button type="button" class="df-seg-btn" data-quality="high">高 High</button>
              <button type="button" class="df-seg-btn" data-quality="medium">中 Medium</button>
              <button type="button" class="df-seg-btn" data-quality="low">低 Low</button>
            </div>
          </div>

          <div class="df-slider-grid">
            <div class="df-slider-row">
              <div class="df-slider-label"><span>鼠标灵敏度</span><strong id="df-p-sens-val">1.00</strong></div>
              <input type="range" class="df-range" id="df-p-sens" min="0.25" max="2.5" step="0.05" value="1.0">
            </div>
            <div class="df-slider-row">
              <div class="df-slider-label"><span>主音量</span><strong id="df-p-master-val">82%</strong></div>
              <input type="range" class="df-range" id="df-p-master" min="0" max="1" step="0.02" value="0.82">
            </div>
            <div class="df-slider-row">
              <div class="df-slider-label"><span>音效音量</span><strong id="df-p-sfx-val">90%</strong></div>
              <input type="range" class="df-range" id="df-p-sfx" min="0" max="1" step="0.02" value="0.90">
            </div>
            <div class="df-slider-row">
              <div class="df-slider-label"><span>配乐音量</span><strong id="df-p-music-val">55%</strong></div>
              <input type="range" class="df-range" id="df-p-music" min="0" max="1" step="0.02" value="0.55">
            </div>
          </div>

          <div class="df-toggle-row">
            <span>反转鼠标 Y 轴</span>
            <button type="button" class="df-btn-sm" id="df-p-invert">关闭 OFF</button>
          </div>

          <div class="df-controls-grid">
            <div>移动 / 冲刺 / 蹲下<span>WASD / Shift / C</span></div>
            <div>开火 / 瞄准 / 换弹<span>LMB / RMB / R</span></div>
            <div>切换武器 / 射速<span>1-6 / B</span></div>
            <div>手雷 / 烟雾 / 热成像<span>G / T</span></div>
            <div>驾驶 / 救援 / 弹药<span>E</span></div>
            <div>无人机 / 机器狗<span>7 / 8</span></div>
            <div>标点 / 指挥轮盘<span>Q / F1-F6</span></div>
            <div>战术地图 / 载具视角<span>M / C / X</span></div>
          </div>

          <div class="df-modal-actions">
            <button type="button" class="df-btn primary" id="df-p-resume">继续战斗</button>
            <button type="button" class="df-btn" id="df-p-switch">切换阵营</button>
            <button type="button" class="df-btn" id="df-p-restart">重新开始</button>
          </div>
        </div>
      </div>

      <!-- 7. END-OF-MATCH SCREEN -->
      <div id="df-endscreen" class="df-hidden">
        <div class="df-bracket df-modal-box">
          <div class="df-end-banner victory" id="df-end-banner">
            <div class="df-end-verdict" id="df-end-verdict">VICTORY // 作战胜利</div>
            <div class="df-end-reason" id="df-end-reason">防线坚守完成</div>
          </div>
          <div class="df-stats-grid">
            <div class="df-stat-cell"><span class="df-stat-val" id="df-st-kills">0</span><span class="df-stat-lbl">击杀敌军</span></div>
            <div class="df-stat-cell"><span class="df-stat-val" id="df-st-hs">0</span><span class="df-stat-lbl">精准爆头</span></div>
            <div class="df-stat-cell"><span class="df-stat-val" id="df-st-veh">0</span><span class="df-stat-lbl">摧毁载具</span></div>
            <div class="df-stat-cell"><span class="df-stat-val" id="df-st-walls">0</span><span class="df-stat-lbl">破墙掩体</span></div>
            <div class="df-stat-cell"><span class="df-stat-val" id="df-st-rev">0</span><span class="df-stat-lbl">救援友军</span></div>
            <div class="df-stat-cell"><span class="df-stat-val" id="df-st-sec">0/3</span><span class="df-stat-lbl">战区战果</span></div>
          </div>
          <div class="df-modal-actions" style="grid-template-columns:1fr 1fr">
            <button type="button" class="df-btn primary" id="df-end-restart">再战一局 // RESTART</button>
            <button type="button" class="df-btn" id="df-end-switch">切换阵营 // SWITCH</button>
          </div>
        </div>
      </div>
    `;
  }

  // ============================================================================
  // Sync Settings Across Briefing & Pause Menus
  // ============================================================================
  function syncSettingsUI() {
    const syncQuality = (container) => {
      if (!container) return;
      const btns = container.querySelectorAll('[data-quality]');
      for (let i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].dataset.quality === settings.quality);
      }
    };
    syncQuality(dom.briefQuality);
    syncQuality(dom.pauseQuality);

    const sensTxt = Number(settings.sensitivity).toFixed(2);
    const mTxt = Math.round(settings.masterVol * 100) + '%';
    const sTxt = Math.round(settings.sfxVol * 100) + '%';
    const muTxt = Math.round(settings.musicVol * 100) + '%';

    if (dom.bSens) { dom.bSens.value = settings.sensitivity; dom.bSensVal.textContent = sensTxt; }
    if (dom.pSens) { dom.pSens.value = settings.sensitivity; dom.pSensVal.textContent = sensTxt; }
    if (dom.bMaster) { dom.bMaster.value = settings.masterVol; dom.bMasterVal.textContent = mTxt; }
    if (dom.pMaster) { dom.pMaster.value = settings.masterVol; dom.pMasterVal.textContent = mTxt; }
    if (dom.bSfx) { dom.bSfx.value = settings.sfxVol; dom.bSfxVal.textContent = sTxt; }
    if (dom.pSfx) { dom.pSfx.value = settings.sfxVol; dom.pSfxVal.textContent = sTxt; }
    if (dom.bMusic) { dom.bMusic.value = settings.musicVol; dom.bMusicVal.textContent = muTxt; }
    if (dom.pMusic) { dom.pMusic.value = settings.musicVol; dom.pMusicVal.textContent = muTxt; }
    if (dom.pInvert) {
      dom.pInvert.textContent = settings.invertY ? '开启 ON' : '关闭 OFF';
      dom.pInvert.classList.toggle('active', settings.invertY);
    }

    if (window.DF && window.DF.Audio && typeof window.DF.Audio.setVolumes === 'function') {
      window.DF.Audio.setVolumes({
        master: settings.masterVol,
        sfx: settings.sfxVol,
        music: settings.musicVol
      });
    }
  }

  function applyQuality(q) {
    if (!q) return;
    settings.quality = q;
    syncSettingsUI();
    if (window.DF && window.DF.Renderer && typeof window.DF.Renderer.setQuality === 'function') {
      try { window.DF.Renderer.setQuality(q); } catch (_) { /* ignore */ }
    }
    emitAction('ui:settings', 'onSettingsChange', { quality: q });
  }

  // ============================================================================
  // Bind Interactive Event Listeners
  // ============================================================================
  function bindEvents() {
    // Faction select
    const factionBtns = dom.briefing.querySelectorAll('[data-faction]');
    for (let i = 0; i < factionBtns.length; i++) {
      factionBtns[i].addEventListener('click', () => {
        settings.faction = factionBtns[i].dataset.faction;
        for (let j = 0; j < factionBtns.length; j++) {
          factionBtns[j].classList.toggle('active', factionBtns[j].dataset.faction === settings.faction);
        }
        audioCue('ui_click');
      });
    }

    // Quality buttons (briefing + pause)
    const wireQuality = (container) => {
      if (!container) return;
      container.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-quality]');
        if (!btn) return;
        applyQuality(btn.dataset.quality);
        audioCue('ui_click');
      });
    };
    wireQuality(dom.briefQuality);
    wireQuality(dom.pauseQuality);

    // Sliders
    const wireSlider = (el, key) => {
      if (!el) return;
      el.addEventListener('input', () => {
        settings[key] = parseFloat(el.value);
        syncSettingsUI();
        const partial = {};
        partial[key] = settings[key];
        emitAction('ui:settings', 'onSettingsChange', partial);
      });
    };
    wireSlider(dom.bSens, 'sensitivity');
    wireSlider(dom.pSens, 'sensitivity');
    wireSlider(dom.bMaster, 'masterVol');
    wireSlider(dom.pMaster, 'masterVol');
    wireSlider(dom.bSfx, 'sfxVol');
    wireSlider(dom.pSfx, 'sfxVol');
    wireSlider(dom.bMusic, 'musicVol');
    wireSlider(dom.pMusic, 'musicVol');

    // Invert Y toggle
    dom.pInvert.addEventListener('click', () => {
      settings.invertY = !settings.invertY;
      syncSettingsUI();
      audioCue('ui_click');
      emitAction('ui:settings', 'onSettingsChange', { invertY: settings.invertY });
    });

    // Deploy button — emits 'ui:startMatch' (exact contract in src/main.js)
    dom.deployBtn.addEventListener('click', () => {
      if (window.DF && window.DF.Audio && typeof window.DF.Audio.unlock === 'function') {
        window.DF.Audio.unlock();
      }
      audioCue('order');
      clearKillfeed();
      showBriefing(false);
      emitAction('ui:settings', 'onSettingsChange', {
        quality: settings.quality,
        sensitivity: settings.sensitivity,
        masterVol: settings.masterVol,
        sfxVol: settings.sfxVol,
        musicVol: settings.musicVol,
        invertY: settings.invertY
      });
      emitAction('ui:startMatch', 'onDeploy', { faction: settings.faction });
    });

    // Radial wheel click & hover
    const wedges = dom.radial.querySelectorAll('.df-wedge');
    for (let i = 0; i < wedges.length; i++) {
      wedges[i].addEventListener('mouseenter', () => {
        setRadialHover(parseInt(wedges[i].dataset.idx, 10));
      });
      wedges[i].addEventListener('click', (e) => {
        e.stopPropagation();
        setRadialHover(parseInt(wedges[i].dataset.idx, 10));
        const chosen = confirmRadial();
        if (window.DF && window.DF.Game) window.DF.Game.radialOpen = false;
        if (chosen) {
          emitAction('ui:order', 'onOrder', { order: chosen });
        }
      });
    }
    dom.radial.addEventListener('mousemove', (e) => {
      if (!radialOpen) return;
      const rect = dom.radial.querySelector('.df-radial-wrap').getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width * 0.5);
      const dy = e.clientY - (rect.top + rect.height * 0.5);
      updateRadialFromVector(dx, dy);
    });

    // Tactical map order buttons & click-to-waypoint
    dom.mapOrders.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-order]');
      if (!btn) return;
      mapSelectedOrder = btn.dataset.order;
      const all = dom.mapOrders.querySelectorAll('[data-order]');
      for (let i = 0; i < all.length; i++) {
        all[i].classList.toggle('active', all[i].dataset.order === mapSelectedOrder);
      }
      audioCue('ui_click');
    });

    dom.mapClose.addEventListener('click', () => {
      toggleMap(false);
      if (window.DF && window.DF.Game) window.DF.Game.mapOpen = false;
      audioCue('ui_click');
    });

    dom.mapCanvas.addEventListener('click', (e) => {
      const rect = dom.mapCanvas.getBoundingClientRect();
      const nx = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const nz = clamp((e.clientY - rect.top) / rect.height, 0, 1);
      const wx = MAP_MIN_X + nx * (MAP_MAX_X - MAP_MIN_X);
      const wz = MAP_MIN_Z + nz * (MAP_MAX_Z - MAP_MIN_Z);
      mapPings.push({ wx, wz, life: 1.4, maxLife: 1.4 });
      lastOrderPos = [wx, 0, wz];
      lastActiveOrderName = ORDER_LABELS[mapSelectedOrder] || mapSelectedOrder;
      audioCue('order');
      showNotification(`地图航点指令: ${lastActiveOrderName} (${Math.round(wx)}, ${Math.round(wz)})`, 'order');
      emitAction('ui:mapWaypoint', 'onMapWaypoint', { order: mapSelectedOrder, pos: [wx, 0, wz] });
    });

    // Downed takeover & immediate respawn buttons
    dom.takeoverBtn.addEventListener('click', () => {
      audioCue('ack');
      emitAction('ui:takeOverAlly', 'onTakeOverAlly', {});
    });
    if (dom.respawnBtn) {
      dom.respawnBtn.addEventListener('click', () => {
        audioCue('ack');
        emitAction('ui:respawnNow', 'onRespawnNow', {});
        if (window.DF && window.DF.Game && typeof window.DF.Game.respawnPlayerNow === 'function') {
          window.DF.Game.respawnPlayerNow();
        } else if (window.DF && window.DF.GameMode && typeof window.DF.GameMode.respawnPlayerNow === 'function') {
          window.DF.GameMode.respawnPlayerNow();
        }
      });
    }

    // Pause buttons
    dom.pResume.addEventListener('click', () => {
      togglePause(false);
      emitAction('ui:resume', 'onResume', {});
    });
    dom.pSwitch.addEventListener('click', () => {
      togglePause(false);
      endVisible = false;
      endScreenShownForMatch = false;
      dom.endscreen.classList.add('df-hidden');
      clearKillfeed();
      const nextF = settings.faction === 'UA' ? 'RU' : 'UA';
      setFaction(nextF);
      emitAction('ui:switchFaction', 'onSwitchFaction', nextF);
    });
    dom.pRestart.addEventListener('click', () => {
      togglePause(false);
      endVisible = false;
      endScreenShownForMatch = false;
      dom.endscreen.classList.add('df-hidden');
      clearKillfeed();
      emitAction('ui:restart', 'onRestart', settings.faction);
    });

    // Endscreen buttons
    dom.endRestart.addEventListener('click', () => {
      endVisible = false;
      endScreenShownForMatch = false;
      dom.endscreen.classList.add('df-hidden');
      clearKillfeed();
      emitAction('ui:restart', 'onRestart', settings.faction);
    });
    dom.endSwitch.addEventListener('click', () => {
      endVisible = false;
      endScreenShownForMatch = false;
      dom.endscreen.classList.add('df-hidden');
      clearKillfeed();
      const nextF = settings.faction === 'UA' ? 'RU' : 'UA';
      setFaction(nextF);
      emitAction('ui:switchFaction', 'onSwitchFaction', nextF);
    });
  }

  // ============================================================================
  // Radial Command Wheel Helpers
  // ============================================================================
  function setRadialHover(idx) {
    if (idx === radialHoverIdx) return;
    radialHoverIdx = idx;
    const wedges = dom.radial.querySelectorAll('.df-wedge');
    for (let i = 0; i < wedges.length; i++) {
      wedges[i].classList.toggle('hovered', i === idx);
    }
    if (idx >= 0 && idx < ORDERS.length) {
      dom.radialHubTitle.textContent = `${ORDERS[idx].key} ${ORDERS[idx].name}`;
      audioCue('ui_hover');
    } else {
      dom.radialHubTitle.textContent = '小队指挥';
    }
  }

  function updateRadialFromVector(dx, dy) {
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 24) {
      setRadialHover(-1);
      return;
    }
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const shifted = (deg + 120 + 360) % 360;
    const idx = Math.floor(shifted / 60) % 6;
    setRadialHover(idx);
  }

  function handleRadialMove(dx, dy) {
    if (!radialOpen) return;
    radialVirtX = clamp(radialVirtX + dx, -140, 140);
    radialVirtY = clamp(radialVirtY + dy, -140, 140);
    updateRadialFromVector(radialVirtX, radialVirtY);
  }

  function confirmRadial() {
    if (!radialOpen) return null;
    const chosen = radialHoverIdx >= 0 ? ORDERS[radialHoverIdx] : null;
    radialOpen = false;
    dom.radial.classList.add('df-hidden');
    if (chosen) {
      lastActiveOrderName = chosen.name;
      return chosen.id;
    }
    return null;
  }

  // Note: main.js calls openRadial(false) on Q keyup and uses the returned order id!
  function openRadial(open) {
    if (!isInit) return null;
    const next = !!open;
    if (!next) {
      if (!radialOpen) return null;
      return confirmRadial();
    }
    if (briefingVisible || pauseOpen || endVisible) return null;
    radialOpen = true;
    dom.radial.classList.remove('df-hidden');
    radialVirtX = 0;
    radialVirtY = 0;
    setRadialHover(-1);
    return null;
  }

  // ============================================================================
  // Compass Azimuth Ribbon Renderer (60fps Canvas)
  // ============================================================================
  function renderCompass(yawRad, playerPos, sectors, soldiers, orderPos, playerFaction) {
    const canvas = dom.compassCanvas;
    if (!canvas) return;
    const g = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    g.clearRect(0, 0, W, H);

    // Forward = (-sin(yaw), 0, -cos(yaw)); yaw=0 -> North (-Z, 0°), yaw=-PI/2 -> East (+X, 90°)
    const heading = (((-yawRad * 180) / Math.PI) % 360 + 360) % 360;
    dom.bearingTxt.textContent = String(Math.round(heading) % 360).padStart(3, '0');

    const pxPerDeg = W / 112;
    const startDeg = Math.floor((heading - 60) / 5) * 5;
    const endDeg = heading + 60;
    const cardinals = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

    g.textAlign = 'center';
    g.textBaseline = 'top';

    for (let d = startDeg; d <= endDeg; d += 5) {
      const x = W * 0.5 + (d - heading) * pxPerDeg;
      if (x < 6 || x > W - 6) continue;
      const norm = ((d % 360) + 360) % 360;
      const edgeFade = 1 - Math.pow(Math.abs((x - W * 0.5) / (W * 0.5)), 2.2);
      const isCard = cardinals[norm] !== undefined;
      const isMajor = norm % 15 === 0;

      g.strokeStyle = `rgba(218, 230, 242, ${(isMajor ? 0.58 : 0.25) * edgeFade})`;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, H - (isMajor ? 9 : 5));
      g.lineTo(x, H);
      g.stroke();

      if (isCard) {
        g.fillStyle = norm === 0
          ? `rgba(232, 168, 56, ${0.95 * edgeFade})`
          : `rgba(235, 242, 248, ${0.92 * edgeFade})`;
        g.font = '700 11px monospace';
        g.fillText(cardinals[norm], x, 4);
      } else if (norm % 30 === 0) {
        g.fillStyle = `rgba(150, 166, 182, ${0.72 * edgeFade})`;
        g.font = '600 9px monospace';
        g.fillText(String(norm), x, 6);
      }
    }

    const drawWorldPip = (pos, color, shape) => {
      if (!pos || !playerPos) return;
      const dx = pos[0] - playerPos[0];
      const dz = pos[2] - playerPos[2];
      const targetDeg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
      let diff = targetDeg - heading;
      while (diff > 180) diff -= 360;
      while (diff < -180) diff += 360;
      if (Math.abs(diff) > 54) return;
      const x = W * 0.5 + diff * pxPerDeg;
      g.fillStyle = color;
      if (shape === 'diamond') {
        g.beginPath();
        g.moveTo(x, 14);
        g.lineTo(x + 4, 18);
        g.lineTo(x, 22);
        g.lineTo(x - 4, 18);
        g.closePath();
        g.fill();
      } else if (shape === 'chevron') {
        g.beginPath();
        g.moveTo(x, 22);
        g.lineTo(x - 4, 15);
        g.lineTo(x + 4, 15);
        g.closePath();
        g.fill();
      } else {
        g.fillRect(x - 2, 16, 4, 4);
      }
    };

    if (Array.isArray(sectors)) {
      for (let i = 0; i < sectors.length; i++) {
        if (sectors[i] && sectors[i].active) {
          drawWorldPip(sectors[i].pos, '#e8a838', 'chevron');
        }
      }
    }
    if (orderPos) {
      drawWorldPip(orderPos, '#5db87a', 'square');
    }
    if (Array.isArray(soldiers)) {
      for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i];
        if (!s || s.state === 'dead' || s.isPlayer) continue;
        if (s.faction !== playerFaction && (s.spottedTimer > 0 || s.inPlayerLOS)) {
          drawWorldPip(s.pos, COL_ENEMY, 'diamond');
        } else if (s.faction === playerFaction && s.state === 'downed') {
          drawWorldPip(s.pos, COL_ALLY, 'square');
        }
      }
    }

    g.fillStyle = '#e8a838';
    g.beginPath();
    g.moveTo(W * 0.5, 0);
    g.lineTo(W * 0.5 - 4, 5);
    g.lineTo(W * 0.5 + 4, 5);
    g.closePath();
    g.fill();
  }

  // ============================================================================
  // Optical Scopes, Tank/IFV FCS & FLIR Thermal, Drone FPV, Robot Dog Overlays
  // ============================================================================
  function renderOpticOverlay(snap) {
    const rawMode = snap.controlMode || 'infantry';
    const vision = snap.visionMode || 'normal';
    const isThermal = vision === 'thermal_white' || vision === 'thermal_green';
    const veh = snap.vehicle || null;
    const wpn = snap.weapon || null;
    const adsBlend = (wpn && wpn.adsBlend) || (snap.player && snap.player.adsBlend) || 0;
    const rawScope = wpn ? (wpn.scopeType || 'none') : 'none';
    const scopeThreshold = rawScope === 'pgo7' ? 0.78 : 0.72;
    const scope = (rawMode === 'infantry' && (adsBlend > scopeThreshold || vision === 'optic')) ? rawScope : 'none';

    // Determine armor subtype & camera mode (0=3rd person, 1=gunner optic, 2=thermal)
    let vehSubtype = 'tank';
    if (veh) {
      const vt = ((veh.type || '') + ' ' + (veh.name || '')).toLowerCase();
      vehSubtype = /ifv|bradley|bmp/.test(vt) ? 'ifv' : 'tank';
    }
    const vehCam = veh && veh.camMode != null ? veh.camMode : 1;

    let overlayType = 'none';
    if (rawMode === 'vehicle' || rawMode === 'tank' || rawMode === 'ifv') {
      overlayType = vehCam === 0 && !isThermal ? (vehSubtype + '_3p') : vehSubtype;
    } else if (rawMode === 'drone') {
      overlayType = 'drone';
    } else if (rawMode === 'dog') {
      overlayType = 'dog';
    } else if (scope === 'pso' || scope === 'mildot' || scope === 'pgo7') {
      overlayType = scope;
    }

    const key = `${overlayType}|${vision}`;
    const layer = dom.opticLayer;

    if (overlayType === 'none') {
      if (lastOverlayKey !== 'none') {
        layer.classList.add('df-hidden');
        layer.innerHTML = '';
        lastOverlayKey = 'none';
      }
      return false;
    }

    layer.classList.remove('df-hidden');

    if (key !== lastOverlayKey) {
      lastOverlayKey = key;
      const accent = vision === 'thermal_green' ? '#6dff9c' : (isThermal ? '#eef6ff' : '#e8a838');
      const scanHtml = isThermal ? '<div class="df-thermal-scanlines"></div>' : '';

      if (overlayType === 'pgo7') {
        // Authentic Russian PGO-7V (2.7x) Illuminated Anti-Tank Optical Scope for RPG-7V2
        // Features: 100m zero cross, 200-500m progressive drop & windage lead ladder,
        // and iconic 2.7m MBT-height stadiametric rangefinder curve in lower-right quadrant.
        layer.innerHTML = `
          <svg class="df-scope-svg" viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice">
            <defs>
              <radialGradient id="pgo7Vig" cx="50%" cy="50%" r="42%">
                <stop offset="70%" stop-color="rgba(0,0,0,0)"/>
                <stop offset="86%" stop-color="rgba(12,18,14,0.22)"/>
                <stop offset="93%" stop-color="rgba(3,5,6,0.92)"/>
                <stop offset="100%" stop-color="rgba(2,3,4,0.995)"/>
              </radialGradient>
            </defs>
            <rect width="1280" height="720" fill="url(#pgo7Vig)"/>
            <!-- Machined Rubber Eyecup & Optical Bezel -->
            <circle cx="640" cy="360" r="290" fill="none" stroke="rgba(8,10,12,0.96)" stroke-width="14"/>
            <circle cx="640" cy="360" r="283" fill="none" stroke="rgba(120,145,125,0.22)" stroke-width="1.2"/>

            <!-- PGO-7V Illuminated Red-Amber Reticle Grid -->
            <g class="df-scope-glow" stroke="#ff5c2e" fill="none" stroke-linecap="square" opacity="0.95">
              <!-- Vertical Ballistic Axis -->
              <line x1="640" y1="305" x2="640" y2="550" stroke-width="1.4"/>

              <!-- Upper 100m Zero Cross (+) & Top Lead Scale -->
              <line x1="628" y1="322" x2="652" y2="322" stroke-width="1.6"/>
              <line x1="640" y1="312" x2="640" y2="332" stroke-width="1.6"/>

              <!-- Primary 200m Horizon Line + Crosswind/Lead Ticks (5..1 | 1..5) -->
              <line x1="480" y1="360" x2="800" y2="360" stroke-width="1.7"/>
              <path d="M 633 367 L 640 360 L 647 367" stroke-width="1.8"/>
              <!-- Windage Ticks along 200m Bar -->
              <path d="M 515 352 v 16 M 540 355 v 10 M 565 352 v 16 M 590 355 v 10 M 615 353 v 14" stroke-width="1.3"/>
              <path d="M 665 353 v 14 M 690 355 v 10 M 715 352 v 16 M 740 355 v 10 M 765 352 v 16" stroke-width="1.3"/>

              <!-- 300m Range Bar + Chevrons + Lead Ticks -->
              <line x1="510" y1="404" x2="770" y2="404" stroke-width="1.4"/>
              <path d="M 634 410 L 640 404 L 646 410" stroke-width="1.5"/>
              <path d="M 540 398 v 12 M 565 400 v 8 M 590 398 v 12 M 615 400 v 8" stroke-width="1.15"/>
              <path d="M 665 400 v 8 M 690 398 v 12 M 715 400 v 8 M 740 398 v 12" stroke-width="1.15"/>

              <!-- 400m Range Bar + Chevrons + Lead Ticks -->
              <line x1="535" y1="456" x2="745" y2="456" stroke-width="1.35"/>
              <path d="M 635 462 L 640 456 L 645 462" stroke-width="1.4"/>
              <path d="M 565 451 v 10 M 590 453 v 6 M 615 451 v 10 M 665 451 v 10 M 690 453 v 6 M 715 451 v 10" stroke-width="1.1"/>

              <!-- 500m Range Bar + Chevrons -->
              <line x1="560" y1="516" x2="720" y2="516" stroke-width="1.3"/>
              <path d="M 635 522 L 640 516 L 645 522" stroke-width="1.35"/>
              <path d="M 590 512 v 8 M 615 512 v 8 M 665 512 v 8 M 690 512 v 8" stroke-width="1.05"/>

              <!-- Left & Right Heavy Outer Acquisition Stadia -->
              <line x1="395" y1="360" x2="462" y2="360" stroke-width="2.6"/>
              <line x1="818" y1="360" x2="885" y2="360" stroke-width="2.6"/>

              <!-- Authentic 2.7m Tank-Height Stadiametric Rangefinder Curve (Lower Right) -->
              <line x1="726" y1="506" x2="854" y2="506" stroke-width="1.45"/>
              <path d="M 730 434 C 748 468, 774 484, 850 494" stroke-width="1.45"/>
              <line x1="734" y1="506" x2="734" y2="442" stroke-width="1.15"/>
              <line x1="762" y1="506" x2="762" y2="472" stroke-width="1.15"/>
              <line x1="790" y1="506" x2="790" y2="483" stroke-width="1.15"/>
              <line x1="818" y1="506" x2="818" y2="490" stroke-width="1.15"/>
              <line x1="846" y1="506" x2="846" y2="494" stroke-width="1.15"/>
            </g>

            <!-- Illuminated Range & Lead Numerals -->
            <g class="df-scope-glow" fill="#ff6a3d" font-family="monospace" font-weight="700" font-size="12" opacity="0.94">
              <text x="613" y="325">+</text>
              <text x="466" y="364">2</text>
              <text x="496" y="408">3</text>
              <text x="521" y="460">4</text>
              <text x="546" y="520">5</text>
              <text x="511" y="346" font-size="10">5</text>
              <text x="561" y="346" font-size="10">3</text>
              <text x="611" y="346" font-size="10">1</text>
              <text x="661" y="346" font-size="10">1</text>
              <text x="711" y="346" font-size="10">3</text>
              <text x="761" y="346" font-size="10">5</text>
              <!-- 2.7m Tank Stadia Labels -->
              <text x="730" y="520" font-size="10">2</text>
              <text x="758" y="520" font-size="10">4</text>
              <text x="786" y="520" font-size="10">6</text>
              <text x="814" y="520" font-size="10">8</text>
              <text x="840" y="520" font-size="10">10</text>
              <text x="700" y="509" font-size="10">2.7</text>
            </g>

            <!-- Subtle Optic Designation & Live Range Estimate -->
            <g class="df-scope-crisp" fill="rgba(232,168,56,0.88)" font-family="monospace" font-size="11" font-weight="700">
              <text x="424" y="216">PGO-7V // 2.7X // PG-7VL</text>
              <text id="df-scope-rng" x="772" y="216">RNG ---M</text>
            </g>
          </svg>`;

      } else if (overlayType === 'pso') {
        // Authentic SVD Dragunov PSO-1M2 (4.0x) Illuminated Optical Scope
        layer.innerHTML = `
          <svg class="df-scope-svg" viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice">
            <defs>
              <radialGradient id="psoVig" cx="50%" cy="50%" r="40%">
                <stop offset="74%" stop-color="rgba(0,0,0,0)"/>
                <stop offset="88%" stop-color="rgba(10,14,12,0.20)"/>
                <stop offset="94%" stop-color="rgba(4,6,8,0.92)"/>
                <stop offset="100%" stop-color="rgba(2,3,4,0.995)"/>
              </radialGradient>
            </defs>
            <rect width="1280" height="720" fill="url(#psoVig)"/>
            <circle cx="640" cy="360" r="276" fill="none" stroke="rgba(10,12,15,0.96)" stroke-width="12"/>
            <circle cx="640" cy="360" r="270" fill="none" stroke="rgba(160,180,170,0.18)" stroke-width="1"/>
            <g class="df-scope-glow" stroke="#ff5533" stroke-width="1.45" fill="none" opacity="0.95">
              <!-- Ballistic Chevrons (100m, 1100m, 1200m, 1300m style) -->
              <path d="M 631 369 L 640 360 L 649 369" stroke-width="1.75"/>
              <path d="M 634 388 L 640 382 L 646 388"/>
              <path d="M 634 409 L 640 403 L 646 409"/>
              <path d="M 634 432 L 640 426 L 646 432"/>
              <!-- Horizontal Windage Stadia + Heavy Outer Posts -->
              <line x1="390" y1="360" x2="480" y2="360" stroke-width="2.4"/>
              <line x1="480" y1="360" x2="622" y2="360"/>
              <line x1="658" y1="360" x2="800" y2="360"/>
              <line x1="800" y1="360" x2="890" y2="360" stroke-width="2.4"/>
              <path d="M 500 353 v 14 M 520 356 v 8 M 540 353 v 14 M 560 356 v 8 M 580 353 v 14 M 600 356 v 8"/>
              <path d="M 680 356 v 8 M 700 353 v 14 M 720 356 v 8 M 740 353 v 14 M 760 356 v 8 M 780 353 v 14"/>
              <line x1="640" y1="444" x2="640" y2="575" stroke-width="1.8"/>
              <!-- Parabolic 1.7m Infantry Stadiametric Rangefinder -->
              <line x1="468" y1="462" x2="588" y2="462"/>
              <path d="M 472 414 Q 508 444 584 453"/>
              <line x1="476" y1="462" x2="476" y2="418"/>
              <line x1="502" y1="462" x2="502" y2="435"/>
              <line x1="528" y1="462" x2="528" y2="444"/>
              <line x1="554" y1="462" x2="554" y2="449"/>
              <line x1="580" y1="462" x2="580" y2="453"/>
            </g>
            <g class="df-scope-glow" fill="#ff5e3a" font-family="monospace" font-weight="700" font-size="11" opacity="0.92">
              <text x="494" y="346">10</text><text x="774" y="346">10</text>
              <text x="472" y="476">2</text><text x="498" y="476">4</text><text x="524" y="476">6</text><text x="550" y="476">8</text><text x="574" y="476">10</text>
              <text x="448" y="466">1.7</text>
            </g>
            <g class="df-scope-crisp" fill="rgba(232,168,56,0.85)" font-family="monospace" font-size="11" font-weight="700">
              <text x="440" y="220">PSO-1M2 // 4.0X</text>
              <text id="df-scope-rng" x="760" y="220">RNG ---M</text>
            </g>
          </svg>`;

      } else if (overlayType === 'mildot') {
        // M24 SWS Leupold Mk4 Precision Mil-Dot Optical Scope (8.0x)
        layer.innerHTML = `
          <svg class="df-scope-svg" viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice">
            <defs>
              <radialGradient id="mdVig" cx="50%" cy="50%" r="41%">
                <stop offset="76%" stop-color="rgba(0,0,0,0)"/>
                <stop offset="89%" stop-color="rgba(8,12,18,0.22)"/>
                <stop offset="94%" stop-color="rgba(4,6,8,0.92)"/>
                <stop offset="100%" stop-color="rgba(2,3,4,0.995)"/>
              </radialGradient>
            </defs>
            <rect width="1280" height="720" fill="url(#mdVig)"/>
            <circle cx="640" cy="360" r="284" fill="none" stroke="rgba(8,10,13,0.97)" stroke-width="14"/>
            <circle cx="640" cy="360" r="277" fill="none" stroke="rgba(130,175,210,0.18)" stroke-width="1.2"/>
            <!-- Subtle dark shadow under hairlines for bright-sky contrast -->
            <g stroke="rgba(255,255,255,0.16)" stroke-width="2.2" fill="none">
              <line x1="490" y1="360" x2="790" y2="360"/>
              <line x1="640" y1="210" x2="640" y2="510"/>
            </g>
            <g stroke="rgba(12,16,20,0.95)" fill="rgba(12,16,20,0.95)">
              <!-- Heavy Duplex Posts -->
              <line x1="358" y1="360" x2="495" y2="360" stroke-width="3.6"/>
              <line x1="785" y1="360" x2="922" y2="360" stroke-width="3.6"/>
              <line x1="640" y1="78" x2="640" y2="215" stroke-width="3.6"/>
              <line x1="640" y1="505" x2="640" y2="642" stroke-width="3.6"/>
              <!-- Fine Mil-Dot Crosshair -->
              <line x1="495" y1="360" x2="785" y2="360" stroke-width="1.15"/>
              <line x1="640" y1="215" x2="640" y2="505" stroke-width="1.15"/>
              <!-- Full Mil-Dots -->
              <circle cx="520" cy="360" r="2.3"/><circle cx="550" cy="360" r="2.3"/><circle cx="580" cy="360" r="2.3"/><circle cx="610" cy="360" r="2.3"/>
              <circle cx="670" cy="360" r="2.3"/><circle cx="700" cy="360" r="2.3"/><circle cx="730" cy="360" r="2.3"/><circle cx="760" cy="360" r="2.3"/>
              <circle cx="640" cy="240" r="2.3"/><circle cx="640" cy="270" r="2.3"/><circle cx="640" cy="300" r="2.3"/><circle cx="640" cy="330" r="2.3"/>
              <circle cx="640" cy="390" r="2.3"/><circle cx="640" cy="420" r="2.3"/><circle cx="640" cy="450" r="2.3"/><circle cx="640" cy="480" r="2.3"/>
              <!-- Half-Mil Hash Marks -->
              <path d="M 535 357 v 6 M 565 357 v 6 M 595 357 v 6 M 625 357 v 6 M 655 357 v 6 M 685 357 v 6 M 715 357 v 6 M 745 357 v 6" stroke-width="1"/>
              <path d="M 637 255 h 6 M 637 285 h 6 M 637 315 h 6 M 637 345 h 6 M 637 375 h 6 M 637 405 h 6 M 637 435 h 6 M 637 465 h 6" stroke-width="1"/>
            </g>
            <!-- Illuminated Amber Micro-Dot Center -->
            <circle cx="640" cy="360" r="2.0" fill="#f5b841" class="df-scope-glow"/>
            <g class="df-scope-crisp" fill="rgba(220,234,246,0.82)" font-family="monospace" font-size="11" font-weight="700">
              <text x="430" y="218">M24 MK4 // 8.0X // ZERO 200M</text>
              <text id="df-scope-rng" x="765" y="218">RNG ---M</text>
            </g>
          </svg>`;

      } else if (overlayType === 'tank' || overlayType === 'ifv' || overlayType === 'tank_3p' || overlayType === 'ifv_3p') {
        const isOptic = overlayType === 'tank' || overlayType === 'ifv';
        const isTank = overlayType.startsWith('tank');
        const reticleSvg = isOptic ? `
          <svg class="df-scope-svg" viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid meet">
            <g stroke="${accent}" fill="none" opacity="0.88">
              <path d="M 380 180 L 380 150 L 420 150 M 860 150 L 900 150 L 900 180" stroke-width="2"/>
              <path d="M 380 540 L 380 570 L 420 570 M 860 570 L 900 570 L 900 540" stroke-width="2"/>
              <line x1="540" y1="360" x2="624" y2="360" stroke-width="1.6"/>
              <line x1="656" y1="360" x2="740" y2="360" stroke-width="1.6"/>
              <line x1="640" y1="270" x2="640" y2="344" stroke-width="1.6"/>
              <line x1="640" y1="376" x2="640" y2="445" stroke-width="1.6"/>
              <rect x="632" y="352" width="16" height="16" stroke-width="1.2"/>
              <line x1="628" y1="395" x2="652" y2="395" stroke-width="1.2"/>
              <line x1="631" y1="416" x2="649" y2="416" stroke-width="1.2"/>
              <line x1="634" y1="436" x2="646" y2="436" stroke-width="1.2"/>
              <line x1="570" y1="354" x2="570" y2="366" stroke-width="1.2"/>
              <line x1="600" y1="355" x2="600" y2="365" stroke-width="1.2"/>
              <line x1="680" y1="355" x2="680" y2="365" stroke-width="1.2"/>
              <line x1="710" y1="354" x2="710" y2="366" stroke-width="1.2"/>
            </g>
            <text id="df-fcs-lrf" x="670" y="346" fill="${accent}" font-family="monospace" font-size="12" font-weight="700">LRF ---M</text>
            <text id="df-fcs-rdy" x="670" y="382" fill="${accent}" font-family="monospace" font-size="11" font-weight="700">MAIN READY</text>
          </svg>` : `
          <svg class="df-scope-svg" viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid meet">
            <g stroke="${accent}" fill="none" opacity="0.82">
              <circle cx="640" cy="360" r="14" stroke-width="1.4"/>
              <line x1="612" y1="360" x2="628" y2="360" stroke-width="1.4"/>
              <line x1="652" y1="360" x2="668" y2="360" stroke-width="1.4"/>
              <line x1="640" y1="336" x2="640" y2="348" stroke-width="1.4"/>
              <line x1="640" y1="372" x2="640" y2="384" stroke-width="1.4"/>
            </g>
          </svg>`;

        layer.innerHTML = `
          ${scanHtml}
          ${reticleSvg}
          <div class="df-fcs-readout df-fcs-tl" style="color:${accent}">
            <span class="df-fcs-badge" id="df-fcs-veh-name">${isTank ? 'MBT GUNNER FCS' : 'IFV GUNNER FCS'}</span>
            <span id="df-fcs-vision">${isThermal ? (vision === 'thermal_green' ? 'FLIR // GREEN-HOT' : 'FLIR // WHITE-HOT') : (isOptic ? 'GUNNER OPTIC // [T] FLIR' : 'EXT CAM // [C] OPTIC // [T] FLIR')}</span>
            <span id="df-fcs-cam">[C] 视角 // [X] 烟幕 // [E] 下车</span>
          </div>
          <div class="df-fcs-readout df-fcs-tr" style="color:${accent}">
            <span class="df-fcs-badge" id="df-fcs-ammo">${isTank ? '125MM APFSDS' : '30MM HEI-T'}</span>
            <span id="df-fcs-coax">${isTank ? 'COAX 7.62 // RMB' : 'ATGM / COAX // RMB'}</span>
            <span id="df-fcs-smoke">SMOKE READY [X]</span>
          </div>
          <div class="df-armor-diag">
            <svg viewBox="0 0 64 64" width="54" height="54">
              <g id="df-hull-group" transform="rotate(0 32 32)">
                <rect x="20" y="12" width="24" height="40" rx="2" fill="rgba(220,232,244,0.12)" stroke="${accent}" stroke-width="1.6"/>
                <line x1="20" y1="18" x2="44" y2="18" stroke="${accent}" stroke-width="1"/>
                <path d="M 27 10 L 32 5 L 37 10" fill="none" stroke="${accent}" stroke-width="1.5"/>
              </g>
              <g>
                <polygon points="26,26 38,26 40,38 24,38" fill="rgba(232,168,56,0.28)" stroke="#f2f6fa" stroke-width="1.4"/>
                <line x1="32" y1="26" x2="32" y2="6" stroke="#f2f6fa" stroke-width="2.2"/>
              </g>
            </svg>
            <div class="df-armor-bars">
              <div class="df-armor-meta"><span id="df-veh-hp-txt">ARMOR 100%</span><span id="df-veh-spd-txt">0 KM/H</span></div>
              <div class="df-bar-track"><div class="df-bar-fill hp" id="df-veh-hp-bar" style="width:100%"></div></div>
              <div class="df-armor-meta"><span>MAIN CANNON</span><span id="df-veh-rld-txt">READY</span></div>
              <div class="df-bar-track"><div class="df-bar-fill reload" id="df-veh-rld-bar" style="width:100%"></div></div>
            </div>
          </div>`;

      } else if (overlayType === 'drone') {
        layer.innerHTML = `
          ${scanHtml}
          <svg class="df-scope-svg" viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid meet">
            <g stroke="${accent}" fill="none" opacity="0.88">
              <path d="M 140 120 L 140 90 L 180 90 M 1100 90 L 1140 90 L 1140 120" stroke-width="1.8"/>
              <path d="M 140 600 L 140 630 L 180 630 M 1100 630 L 1140 630 L 1140 600" stroke-width="1.8"/>
              <line x1="480" y1="360" x2="575" y2="360" stroke-width="1.4"/>
              <line x1="705" y1="360" x2="800" y2="360" stroke-width="1.4"/>
              <line x1="560" y1="310" x2="600" y2="310" stroke-width="1" stroke-dasharray="4 3"/>
              <line x1="680" y1="310" x2="720" y2="310" stroke-width="1" stroke-dasharray="4 3"/>
              <line x1="560" y1="410" x2="600" y2="410" stroke-width="1" stroke-dasharray="4 3"/>
              <line x1="680" y1="410" x2="720" y2="410" stroke-width="1" stroke-dasharray="4 3"/>
              <circle cx="640" cy="360" r="22" stroke-width="1.4" stroke-dasharray="6 4"/>
              <line x1="628" y1="360" x2="652" y2="360" stroke-width="1.4"/>
              <line x1="640" y1="348" x2="640" y2="372" stroke-width="1.4"/>
            </g>
          </svg>
          <div class="df-fcs-readout df-fcs-tl" style="color:${accent}">
            <span class="df-fcs-badge">UAV // RECON-STRIKE LINK</span>
            <span id="df-uav-alt">ALT 18.0 M</span>
            <span id="df-uav-spd">SPD 0.0 M/S</span>
            <span id="df-uav-vis">${isThermal ? 'FLIR THERMAL ACTIVE' : 'EO DAY CAM [T] FLIR'}</span>
          </div>
          <div class="df-fcs-readout df-fcs-tr" style="color:${accent}">
            <span class="df-fcs-badge" id="df-uav-bat">BAT 100%</span>
            <span id="df-uav-sig">LINK 98% // ENCRYPTED</span>
            <span id="df-uav-vog">VOG-17 PAYLOAD: 2</span>
          </div>
          <div class="df-uav-prompt">
            <span><b>LMB</b> 投掷 VOG-17</span>
            <span>|</span>
            <span style="color:#ff7a70"><b>[F] FPV 俯冲自爆攻击</b></span>
            <span>|</span>
            <span><b>SPACE/SHIFT</b> 升降</span>
            <span>|</span>
            <span><b>[7]</b> 返回本体</span>
          </div>`;

      } else if (overlayType === 'dog') {
        layer.innerHTML = `
          ${scanHtml}
          <svg class="df-scope-svg" viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid meet">
            <g stroke="${accent}" fill="none" opacity="0.88">
              <path d="M 180 140 L 180 110 L 220 110 M 1060 110 L 1100 110 L 1100 140" stroke-width="1.8"/>
              <path d="M 180 580 L 180 610 L 220 610 M 1060 610 L 1100 610 L 1100 580" stroke-width="1.8"/>
              <polygon points="640,342 658,360 640,378 622,360" stroke-width="1.3"/>
              <line x1="590" y1="360" x2="620" y2="360" stroke-width="1.5"/>
              <line x1="660" y1="360" x2="690" y2="360" stroke-width="1.5"/>
              <line x1="640" y1="320" x2="640" y2="340" stroke-width="1.5"/>
              <line x1="640" y1="380" x2="640" y2="400" stroke-width="1.5"/>
              <circle cx="640" cy="360" r="2" fill="${accent}"/>
            </g>
          </svg>
          <div class="df-fcs-readout df-fcs-tl" style="color:${accent}">
            <span class="df-fcs-badge">UGV // QUADRUPED RWS</span>
            <span id="df-dog-stance">GAIT: TROT // STABILIZED</span>
            <span id="df-dog-spd">SPD 0.0 M/S</span>
          </div>
          <div class="df-fcs-readout df-fcs-tr" style="color:${accent}">
            <span class="df-fcs-badge" id="df-dog-hp">CHASSIS 100%</span>
            <span id="df-dog-ammo">RWS AMMO: 60</span>
            <span>${isThermal ? 'FLIR THERMAL ACTIVE' : 'OPTIC [T] FLIR'}</span>
          </div>
          <div class="df-uav-prompt">
            <span><b>LMB</b> 遥控武器站开火</span>
            <span>|</span>
            <span><b>SHIFT</b> 高速疾奔</span>
            <span>|</span>
            <span><b>[T]</b> 热成像</span>
            <span>|</span>
            <span><b>[8]</b> 返回本体</span>
          </div>`;
      }
    }

    // Update live telemetry numbers inside active overlay
    if (overlayType === 'pgo7' || overlayType === 'pso' || overlayType === 'mildot') {
      const rngEl = layer.querySelector('#df-scope-rng');
      if (rngEl && snap.camera && snap.camera.pos && window.DF && window.DF.Physics && typeof window.DF.Physics.raycast === 'function') {
        const cp = Math.cos(snap.camera.pitch || 0);
        const dir = [-Math.sin(snap.camera.yaw || 0) * cp, Math.sin(snap.camera.pitch || 0), -Math.cos(snap.camera.yaw || 0) * cp];
        const start = [
          snap.camera.pos[0] + dir[0] * 1.2,
          snap.camera.pos[1] + dir[1] * 1.2,
          snap.camera.pos[2] + dir[2] * 1.2
        ];
        const ignore = snap.player && snap.player.id != null ? [snap.player.id] : undefined;
        const hit = window.DF.Physics.raycast(start, dir, 260, { checkEntities: true, checkVehicles: true, ignoreIds: ignore });
        rngEl.textContent = hit && hit.dist != null ? `RNG ${Math.round(hit.dist + 1.2)}M` : 'RNG ---M';
      }
    } else if (overlayType.startsWith('tank') || overlayType.startsWith('ifv')) {
      const v = veh || {};
      const nameEl = layer.querySelector('#df-fcs-veh-name');
      const lrfEl = layer.querySelector('#df-fcs-lrf');
      const rdyEl = layer.querySelector('#df-fcs-rdy');
      const ammoEl = layer.querySelector('#df-fcs-ammo');
      const coaxEl = layer.querySelector('#df-fcs-coax');
      const smokeEl = layer.querySelector('#df-fcs-smoke');
      const hullG = layer.querySelector('#df-hull-group');
      const hpTxt = layer.querySelector('#df-veh-hp-txt');
      const spdTxt = layer.querySelector('#df-veh-spd-txt');
      const hpBar = layer.querySelector('#df-veh-hp-bar');
      const rldTxt = layer.querySelector('#df-veh-rld-txt');
      const rldBar = layer.querySelector('#df-veh-rld-bar');

      if (nameEl && v.name) nameEl.textContent = v.name;
      // Estimate laser rangefinder via physics raycast starting 3.6m ahead of turret to clear own hull collider
      if (lrfEl) {
        let rangeTxt = '---M';
        if (v.range != null) {
          rangeTxt = `${Math.round(v.range)}M`;
        } else if (snap.camera && snap.camera.pos && window.DF && window.DF.Physics && typeof window.DF.Physics.raycast === 'function') {
          const cp = Math.cos(snap.camera.pitch || 0);
          const dir = [-Math.sin(snap.camera.yaw || 0) * cp, Math.sin(snap.camera.pitch || 0), -Math.cos(snap.camera.yaw || 0) * cp];
          const start = [
            snap.camera.pos[0] + dir[0] * 3.6,
            snap.camera.pos[1] + dir[1] * 3.6,
            snap.camera.pos[2] + dir[2] * 3.6
          ];
          const hit = window.DF.Physics.raycast(start, dir, 220, {
            checkEntities: true,
            checkVehicles: true,
            ignoreIds: v.id ? [v.id] : undefined
          });
          if (hit && hit.dist != null) rangeTxt = `${Math.round(hit.dist + 3.6)}M`;
        }
        lrfEl.textContent = `LRF ${rangeTxt}`;
      }

      const rMax = Math.max(0.1, v.mainReloadMax || 4.0);
      const reloadPct = v.reloadProgress !== undefined
        ? clamp(v.reloadProgress, 0, 1)
        : clamp(1 - (v.mainReload || 0) / rMax, 0, 1);

      if (rdyEl) rdyEl.textContent = reloadPct >= 0.99 ? 'MAIN READY' : `LOAD ${Math.round(reloadPct * 100)}%`;
      if (ammoEl) {
        const label = v.mainAmmoName || (vehSubtype === 'tank' ? '125MM APFSDS' : '30MM HEI-T');
        ammoEl.textContent = v.mainAmmo != null ? `${label} [${v.mainAmmo}]` : label;
      }
      if (coaxEl && v.secAmmo != null) {
        coaxEl.textContent = `SEC / COAX [${v.secAmmo}] // RMB`;
      }
      if (smokeEl) smokeEl.textContent = v.smokeReady === false ? 'SMOKE RECHARGING' : 'SMOKE READY [X]';
      if (hullG) {
        const relDeg = (((v.turretYaw || 0) - (v.hullYaw || 0)) * 180) / Math.PI;
        hullG.setAttribute('transform', `rotate(${relDeg.toFixed(1)} 32 32)`);
      }
      const hpPct = v.maxHp > 0 ? clamp((v.hp / v.maxHp) * 100, 0, 100) : 100;
      if (hpTxt) hpTxt.textContent = `ARMOR ${Math.round(hpPct)}%`;
      if (spdTxt) spdTxt.textContent = `${Math.round(Math.abs(v.speed || 0) * 3.6)} KM/H`;
      if (hpBar) {
        hpBar.style.width = `${hpPct.toFixed(1)}%`;
        hpBar.classList.toggle('low', hpPct < 30);
      }
      if (rldTxt) rldTxt.textContent = reloadPct >= 0.99 ? 'READY' : `${Math.round(reloadPct * 100)}%`;
      if (rldBar) rldBar.style.width = `${(reloadPct * 100).toFixed(1)}%`;

    } else if (overlayType === 'drone') {
      const dr = snap.unmannedUnit || snap.drone || {};
      const altEl = layer.querySelector('#df-uav-alt');
      const spdEl = layer.querySelector('#df-uav-spd');
      const batEl = layer.querySelector('#df-uav-bat');
      const sigEl = layer.querySelector('#df-uav-sig');
      const vogEl = layer.querySelector('#df-uav-vog');
      const spd = dr.speed != null ? dr.speed : (dr.vel ? Math.hypot(dr.vel[0] || 0, dr.vel[1] || 0, dr.vel[2] || 0) : 0);
      const alt = dr.altitude != null ? dr.altitude : (dr.pos ? dr.pos[1] : 14);
      const bat = dr.battery != null ? (dr.battery <= 1 ? dr.battery * 100 : dr.battery) : 100;
      const bombs = dr.bombs != null ? dr.bombs : (dr.payload != null ? dr.payload : 2);
      if (altEl) altEl.textContent = `ALT ${alt.toFixed(1)} M`;
      if (spdEl) spdEl.textContent = `SPD ${spd.toFixed(1)} M/S`;
      if (batEl) batEl.textContent = `BAT ${Math.round(bat)}%`;
      if (sigEl) sigEl.textContent = `LINK ${Math.round(dr.signal != null ? dr.signal : 96)}% // ACTIVE`;
      if (vogEl) vogEl.textContent = `VOG-17 PAYLOAD: ${bombs}`;

    } else if (overlayType === 'dog') {
      const dg = snap.unmannedUnit || snap.dog || {};
      const stEl = layer.querySelector('#df-dog-stance');
      const spdEl = layer.querySelector('#df-dog-spd');
      const hpEl = layer.querySelector('#df-dog-hp');
      const ammoEl = layer.querySelector('#df-dog-ammo');
      const spd = dg.speed != null ? dg.speed : (dg.vel ? Math.hypot(dg.vel[0] || 0, dg.vel[2] || 0) : 0);
      if (stEl) stEl.textContent = `GAIT: ${(dg.stance || (spd > 5 ? 'SPRINT' : 'TROT')).toUpperCase()} // RWS LOCK`;
      if (spdEl) spdEl.textContent = `SPD ${spd.toFixed(1)} M/S`;
      const hpPct = dg.maxHp > 0 ? Math.round((dg.hp / dg.maxHp) * 100) : 100;
      if (hpEl) hpEl.textContent = `CHASSIS ${hpPct}%`;
      if (ammoEl) ammoEl.textContent = `RWS AMMO: ${dg.ammo != null ? dg.ammo : 60}`;
    }

    return true;
  }

  // ============================================================================
  // Persistent Top-Left Live Tactical Minimap (Player-Centered, Forward = UP!)
  // ============================================================================
  function renderMinimap(snap, yawRad, centerPos, playerFaction) {
    const canvas = dom.minimapCanvas;
    if (!canvas) return;
    const g = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const cx = W * 0.5;
    const cy = H * 0.52;
    const radiusMeters = 75;
    const pxPerM = (Math.min(W, H) * 0.5) / radiusMeters;
    const px = centerPos ? centerPos[0] : 0;
    const pz = centerPos ? centerPos[2] : 0;

    // Update grid coord + active sector footer
    if (dom.minimapGrid) {
      const colIdx = clamp(Math.floor((px + 90) / 20), 0, 8);
      const rowIdx = clamp(Math.floor((pz + 55) / 20) + 1, 1, 6);
      dom.minimapGrid.textContent = String.fromCharCode(65 + colIdx) + rowIdx;
    }

    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0b1015';
    g.fillRect(0, 0, W, H);

    // World-space rotated layer (Forward = UP, Right = RIGHT)
    g.save();
    g.beginPath();
    g.rect(0, 0, W, H);
    g.clip();
    g.translate(cx, cy);
    g.rotate(yawRad);
    g.scale(pxPerM, pxPerM);
    g.translate(-px, -pz);

    // 1. Roads: Main Armored Avenue & North/South Flank Alleys
    g.fillStyle = '#18222c';
    g.fillRect(MAP_MIN_X, -10, MAP_MAX_X - MAP_MIN_X, 20);
    g.fillStyle = '#131b24';
    g.fillRect(MAP_MIN_X, -46, MAP_MAX_X - MAP_MIN_X, 12);
    g.fillRect(MAP_MIN_X, 34, MAP_MAX_X - MAP_MIN_X, 12);

    // Center road lane dashes
    g.strokeStyle = 'rgba(210, 224, 238, 0.16)';
    g.lineWidth = 1 / pxPerM;
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(MAP_MIN_X, 0);
    g.lineTo(MAP_MAX_X, 0);
    g.stroke();
    g.setLineDash([]);

    // 2. Subtle 20m Tactical Grid
    g.strokeStyle = 'rgba(170, 198, 224, 0.08)';
    g.lineWidth = 0.8 / pxPerM;
    for (let wx = -80; wx <= 80; wx += 20) {
      g.beginPath(); g.moveTo(wx, MAP_MIN_Z); g.lineTo(wx, MAP_MAX_Z); g.stroke();
    }
    for (let wz = -40; wz <= 40; wz += 20) {
      g.beginPath(); g.moveTo(MAP_MIN_X, wz); g.lineTo(MAP_MAX_X, wz); g.stroke();
    }

    // 3. Map Outer Perimeter
    g.strokeStyle = 'rgba(232, 168, 56, 0.22)';
    g.lineWidth = 1.2 / pxPerM;
    g.strokeRect(MAP_MIN_X, MAP_MIN_Z, MAP_MAX_X - MAP_MIN_X, MAP_MAX_Z - MAP_MIN_Z);

    // 4. Buildings
    const buildings = (snap && snap.mapBuildings) ||
      (window.DF && window.DF.Map && typeof window.DF.Map.getBuildings === 'function' && window.DF.Map.getBuildings()) ||
      FALLBACK_BUILDINGS;
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      if (!b) continue;
      const bx = b.x != null ? (b.x - (b.w || 16) * 0.5) : (b.x0 || 0);
      const bz = b.z != null ? (b.z - (b.d || 16) * 0.5) : (b.z0 || 0);
      const bw = b.w != null ? b.w : ((b.x1 || 0) - (b.x0 || 0));
      const bd = b.d != null ? b.d : ((b.z1 || 0) - (b.z0 || 0));
      g.fillStyle = 'rgba(42, 54, 68, 0.86)';
      g.fillRect(bx, bz, bw, bd);
      g.strokeStyle = 'rgba(165, 190, 214, 0.42)';
      g.lineWidth = 1 / pxPerM;
      g.strokeRect(bx, bz, bw, bd);
    }

    // 5. Breached Wall Openings (Structural collapsed pieces)
    if (window.DF && window.DF.Destruction && typeof window.DF.Destruction.getPieces === 'function') {
      const pieces = window.DF.Destruction.getPieces() || [];
      g.fillStyle = 'rgba(232, 168, 56, 0.78)';
      const sz = 2.4;
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        if (!p || !(p.collapsed || p.state === 'collapsed') || !p.pos) continue;
        const mat = p.material || '';
        if (mat !== 'concrete' && mat !== 'brick' && !p.explosive) continue;
        g.fillRect(p.pos[0] - sz * 0.5, p.pos[2] - sz * 0.5, sz, sz);
      }
    }

    // 6. Breakthrough Sectors A / B / C
    const sectors = (snap && Array.isArray(snap.sectors) && snap.sectors.length) ? snap.sectors : [
      { id: 'A', pos: [-38, 0, 0], radius: 15, owner: 'UA', progress: 0, active: true },
      { id: 'B', pos: [4, 0, 0], radius: 18, owner: 'UA', progress: 0, active: false },
      { id: 'C', pos: [52, 0, 0], radius: 16, owner: 'UA', progress: 0, active: false }
    ];
    let activeSecLabel = 'SEC A';
    for (let i = 0; i < sectors.length; i++) {
      const s = sectors[i];
      if (!s || !s.pos) continue;
      if (s.active) activeSecLabel = 'SEC ' + (s.id || 'A');
      const r = s.radius || 16;
      const sFriendly = s.owner === playerFaction;
      g.beginPath();
      g.arc(s.pos[0], s.pos[2], r, 0, Math.PI * 2);
      g.fillStyle = sFriendly ? 'rgba(56, 189, 248, 0.14)' : 'rgba(255, 59, 48, 0.16)';
      g.fill();
      g.strokeStyle = s.active ? COL_ORDER : (sFriendly ? COL_ALLY : COL_ENEMY);
      g.lineWidth = (s.active ? 1.8 : 1.1) / pxPerM;
      g.stroke();

      // Upright Sector Letter
      g.save();
      g.translate(s.pos[0], s.pos[2]);
      g.rotate(-yawRad);
      g.fillStyle = s.active ? '#f7d582' : '#d6e2ed';
      g.font = `800 ${(10 / pxPerM).toFixed(2)}px monospace`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(s.id || 'A', 0, 0);
      g.restore();
    }
    if (dom.minimapSec) dom.minimapSec.textContent = activeSecLabel;

    // 7. Squad Order Waypoint Line & Marker
    const orderPos = (snap && snap.orderPos) || lastOrderPos;
    if (orderPos) {
      g.strokeStyle = 'rgba(232, 168, 56, 0.55)';
      g.lineWidth = 1.1 / pxPerM;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(px, pz);
      g.lineTo(orderPos[0], orderPos[2]);
      g.stroke();
      g.setLineDash([]);

      g.strokeStyle = '#e8a838';
      g.lineWidth = 1.4 / pxPerM;
      const rOrd = 4.2 / pxPerM;
      g.beginPath();
      g.arc(orderPos[0], orderPos[2], rOrd, 0, Math.PI * 2);
      g.stroke();
    }

    // 8. Armored Vehicles (Hull + Turret Barrel Vector)
    const vehicles = (snap && snap.vehicles) || [];
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v || !v.pos) continue;
      if (v.faction !== playerFaction && !(v.spottedTimer > 0) && !v.destroyed) continue;
      const isTank = (v.type === 'tank') || /t-64|t-72/i.test(v.name || '');
      const hullA = -(v.hullYaw != null ? v.hullYaw : (v.yaw || 0)) - Math.PI * 0.5;
      const turA = -(v.turretYaw != null ? v.turretYaw : (v.yaw || 0)) - Math.PI * 0.5;
      const vCol = v.destroyed ? '#5c6670' : (v.faction === playerFaction ? COL_ALLY : COL_ENEMY);

      g.save();
      g.translate(v.pos[0], v.pos[2]);
      g.rotate(hullA);
      const len = (isTank ? 9.5 : 7.8) / pxPerM;
      const wid = (isTank ? 5.8 : 4.6) / pxPerM;
      g.fillStyle = vCol;
      g.fillRect(-len * 0.5, -wid * 0.5, len, wid);
      g.strokeStyle = '#e6edf3';
      g.lineWidth = 0.8 / pxPerM;
      g.strokeRect(-len * 0.5, -wid * 0.5, len, wid);
      g.restore();

      if (!v.destroyed) {
        g.save();
        g.translate(v.pos[0], v.pos[2]);
        g.rotate(turA);
        g.strokeStyle = '#f5c542';
        g.lineWidth = 1.5 / pxPerM;
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo((isTank ? 8.5 : 6.8) / pxPerM, 0);
        g.stroke();
        g.restore();
      }
    }

    // 9. Friendly Squad (Cyan-Blue) & Spotted/LOS Enemy Soldiers (Crimson-Red)
    const soldiers = (snap && snap.soldiers) || [];
    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (!s || !s.pos || s.state === 'dead' || s.isPlayer || s.inVehicleId) continue;
      const isFriendly = s.faction === playerFaction;
      if (!isFriendly && !(s.spottedTimer > 0) && !s.inPlayerLOS) continue;

      if (s.state === 'downed') {
        const cr = 3.2 / pxPerM;
        g.strokeStyle = isFriendly ? COL_REVIVE : COL_ENEMY;
        g.lineWidth = 1.6 / pxPerM;
        g.beginPath();
        g.moveTo(s.pos[0] - cr, s.pos[2]); g.lineTo(s.pos[0] + cr, s.pos[2]);
        g.moveTo(s.pos[0], s.pos[2] - cr); g.lineTo(s.pos[0], s.pos[2] + cr);
        g.stroke();
      } else if (isFriendly) {
        g.fillStyle = COL_ALLY;
        g.beginPath();
        g.arc(s.pos[0], s.pos[2], 3.1 / pxPerM, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#07111a';
        g.lineWidth = 0.85 / pxPerM;
        g.stroke();
      } else {
        const dr = 3.6 / pxPerM;
        g.fillStyle = COL_ENEMY;
        g.beginPath();
        g.moveTo(s.pos[0], s.pos[2] - dr);
        g.lineTo(s.pos[0] + dr, s.pos[2]);
        g.lineTo(s.pos[0], s.pos[2] + dr);
        g.lineTo(s.pos[0] - dr, s.pos[2]);
        g.closePath();
        g.fill();
      }
    }

    // 10. Unmanned Units (Friendly Cyan/Emerald, Enemy Crimson-Red)
    const unmanned = (snap && snap.unmanned) || [];
    for (let i = 0; i < unmanned.length; i++) {
      const u = unmanned[i];
      if (!u || !u.pos || u.destroyed || u.alive === false) continue;
      const isFriendly = u.faction === playerFaction;
      if (!isFriendly && !(u.spottedTimer > 0) && !u.inPlayerLOS) continue;
      const ur = 3.5 / pxPerM;
      if (u.type === 'drone') {
        g.strokeStyle = isFriendly ? COL_ALLY : COL_ENEMY;
        g.lineWidth = 1.4 / pxPerM;
        g.beginPath();
        g.moveTo(u.pos[0] - ur, u.pos[2] - ur); g.lineTo(u.pos[0] + ur, u.pos[2] + ur);
        g.moveTo(u.pos[0] + ur, u.pos[2] - ur); g.lineTo(u.pos[0] - ur, u.pos[2] + ur);
        g.stroke();
      } else {
        g.strokeStyle = isFriendly ? COL_ALLY_UGV : COL_ENEMY;
        g.lineWidth = 1.4 / pxPerM;
        g.strokeRect(u.pos[0] - ur * 0.85, u.pos[2] - ur * 0.85, ur * 1.7, ur * 1.7);
      }
    }

    g.restore();

    // 11. Screen-space overlays: Subtle Range Rings + Player Translucent FOV Sight Cone + Player Chevron
    g.strokeStyle = 'rgba(210, 224, 238, 0.11)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, cy, 25 * pxPerM, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, 50 * pxPerM, 0, Math.PI * 2);
    g.stroke();

    // Player FOV cone (pointing UP = forward)
    const fovGrad = g.createRadialGradient(cx, cy, 2, cx, cy, 52);
    fovGrad.addColorStop(0, 'rgba(232, 168, 56, 0.28)');
    fovGrad.addColorStop(1, 'rgba(232, 168, 56, 0.0)');
    g.fillStyle = fovGrad;
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, 52, -Math.PI * 0.5 - 0.56, -Math.PI * 0.5 + 0.56);
    g.closePath();
    g.fill();

    // Center player chevron
    g.fillStyle = '#f5c542';
    g.strokeStyle = '#090d12';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx, cy - 6);
    g.lineTo(cx + 4.5, cy + 4.5);
    g.lineTo(cx, cy + 1.8);
    g.lineTo(cx - 4.5, cy + 4.5);
    g.closePath();
    g.fill();
    g.stroke();

    // Orbiting North (N) compass pip along radar edge
    const nx = cx + Math.sin(yawRad) * (W * 0.44);
    const ny = cy - Math.cos(yawRad) * (H * 0.43);
    g.fillStyle = 'rgba(10, 14, 19, 0.86)';
    g.fillRect(nx - 6, ny - 6, 12, 12);
    g.fillStyle = '#e8a838';
    g.font = '800 9px monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', nx, ny + 0.5);
  }

  // ============================================================================
  // 3D World-to-Screen Overhead Battlefield IFF Markers (#df-iff-canvas)
  // Restrained Battlefield 4 symbology:
  //   Friendly = Cyan-Blue (#38bdf8) chevron / Emerald UGV / Pulsing Medic Cross
  //   Enemy    = Crimson-Red (#ff3b30) tactical diamond (spotted / firing / LOS)
  // ============================================================================
  function getActiveViewProj(snap) {
    if (snap && snap.viewProj && snap.viewProj.length >= 16) return snap.viewProj;
    const gCam = window.DF && window.DF.Game && window.DF.Game.camera;
    if (gCam && gCam.projMat && gCam.viewMat && window.DF.Mat4 && typeof window.DF.Mat4.multiply === 'function') {
      window.DF.Mat4.multiply(scratchVP, gCam.projMat, gCam.viewMat);
      return scratchVP;
    }
    return null;
  }

  function projectToScreen(vp, wx, wy, wz, W, H) {
    const cx = vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12];
    const cy = vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13];
    const cz = vp[2] * wx + vp[6] * wy + vp[10] * wz + vp[14];
    const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
    if (cw <= 0.25) return null;
    const invW = 1 / cw;
    const nx = cx * invW;
    const ny = cy * invW;
    const nz = cz * invW;
    if (nz < -1.0 || nz > 1.0) return null;
    if (nx < -1.04 || nx > 1.04 || ny < -1.04 || ny > 1.04) return null;
    return {
      x: (nx * 0.5 + 0.5) * W,
      y: (0.5 - ny * 0.5) * H,
      dist: cw
    };
  }

  function renderOverheadIFF(snap, camPos, playerFaction, dt) {
    const canvas = dom.iffCanvas;
    if (!canvas) return null;

    iffAnimTime += dt;
    const W = window.innerWidth || 1280;
    const H = window.innerHeight || 720;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.round(W * dpr);
    const ph = Math.round(H * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }

    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    // Keep IFF completely clear when HUD hidden, briefing open, map open, or paused
    if (hudHidden || briefingVisible || mapOpen || pauseOpen || endVisible) return null;

    const vp = getActiveViewProj(snap);
    if (!vp) return null;

    const cx = W * 0.5;
    const cy = H * 0.5;
    const activeVehId = snap.vehicle && snap.controlMode === 'vehicle' ? snap.vehicle.id : null;
    const activeUnmId = snap.unmannedUnit && (snap.controlMode === 'drone' || snap.controlMode === 'dog') ? snap.unmannedUnit.id : null;
    const losMap = snap.losVisible || null;

    let closestAllyHover = null;
    let closestAllyCenterDist = 115;
    let fallbackCrosshairIff = null;
    let fallbackCrosshairDist = 26;

    const drawHpBar = (x, y, w, frac, color) => {
      const f = clamp(frac, 0, 1);
      g.fillStyle = 'rgba(7, 11, 16, 0.82)';
      g.fillRect(x - w * 0.5 - 1, y - 1, w + 2, 5);
      g.fillStyle = color;
      g.fillRect(x - w * 0.5, y, w * f, 3);
    };

    // 1. Soldiers (Allies + Spotted/LOS/Firing Enemies)
    const soldiers = (snap && snap.soldiers) || [];
    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (!s || !s.pos || s.state === 'dead' || s.isPlayer || s.inVehicleId) continue;

      const isFriendly = s.faction === playerFaction;
      const dx = s.pos[0] - camPos[0];
      const dy = s.pos[1] - camPos[1];
      const dz = s.pos[2] - camPos[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 1.2 || dist > 155) continue;

      const headOffset = s.state === 'downed' ? 0.95 : (s.crouching ? 1.58 : 2.08);
      const pt = projectToScreen(vp, s.pos[0], s.pos[1] + headOffset, s.pos[2], W, H);
      if (!pt) continue;

      const bodyPt = projectToScreen(vp, s.pos[0], s.pos[1] + (s.crouching ? 0.85 : 1.18), s.pos[2], W, H);
      const centerDist = bodyPt ? Math.hypot(bodyPt.x - cx, bodyPt.y - cy) : Math.hypot(pt.x - cx, pt.y - cy);

      if (isFriendly) {
        if (s.state === 'downed') {
          // Pulsing Amber/Cyan Medic Cross (+) so downed allies stand out immediately
          const pulse = 0.72 + 0.28 * Math.sin(iffAnimTime * 6.5);
          const alpha = clamp(1 - (dist - 85) / 60, 0.45, 1.0) * pulse;
          g.save();
          g.globalAlpha = alpha;
          g.translate(pt.x, pt.y - 4);
          g.fillStyle = 'rgba(8, 13, 19, 0.84)';
          g.strokeStyle = COL_ALLY;
          g.lineWidth = 1.4;
          g.beginPath();
          g.arc(0, 0, 8.5, 0, Math.PI * 2);
          g.fill();
          g.stroke();
          // Crisp Medical Cross
          g.fillStyle = COL_REVIVE;
          g.fillRect(-4.5, -1.5, 9, 3);
          g.fillRect(-1.5, -4.5, 3, 9);
          // Distance micro-tag
          g.font = '700 9px monospace';
          g.textAlign = 'center';
          g.fillStyle = '#f5e4b8';
          g.fillText(`${Math.round(dist)}M`, 0, -12);
          g.restore();
        } else {
          // Clean Battlefield Cyan-Blue downward chevron (8px, crisp dark outline, gentle fade >75m)
          const alpha = clamp(1 - Math.max(0, dist - 75) / 65, 0.28, 0.96);
          g.save();
          g.globalAlpha = alpha;
          g.translate(pt.x, pt.y);
          g.beginPath();
          g.moveTo(0, 4.5);
          g.lineTo(-4.8, -3.5);
          g.lineTo(4.8, -3.5);
          g.closePath();
          g.fillStyle = COL_ALLY;
          g.strokeStyle = 'rgba(5, 10, 16, 0.95)';
          g.lineWidth = 1.6;
          g.stroke();
          g.fill();
          g.restore();

          // Track closest-to-crosshair living ally for single restrained hover label
          if (dist < 70 && centerDist < closestAllyCenterDist) {
            closestAllyCenterDist = centerDist;
            closestAllyHover = { s, x: pt.x, y: pt.y, dist };
          }
          if (dist < 75 && centerDist < fallbackCrosshairDist) {
            fallbackCrosshairDist = centerDist;
            fallbackCrosshairIff = 'ally';
          }
        }
      } else {
        // Hostile Enemy IFF: show if spotted, inPlayerLOS, losVisible map, or recently firing within 60m
        const isSpotted = (s.spottedTimer || 0) > 0;
        const isLos = !!(s.inPlayerLOS || (losMap && losMap[s.id]));
        const recentlyFired = (s.fireCooldown || 0) > 0.01 && dist < 58;
        if (!isSpotted && !isLos && !recentlyFired) continue;

        const alpha = clamp(1 - Math.max(0, dist - 75) / 65, 0.35, 0.96);
        g.save();
        g.globalAlpha = alpha;
        g.translate(pt.x, pt.y);
        g.beginPath();
        g.moveTo(0, -5.2);
        g.lineTo(5.2, 0);
        g.lineTo(0, 5.2);
        g.lineTo(-5.2, 0);
        g.closePath();
        g.strokeStyle = 'rgba(18, 4, 4, 0.96)';
        g.lineWidth = 2.6;
        g.stroke();
        if (isSpotted || centerDist < 55) {
          g.fillStyle = COL_ENEMY;
          g.fill();
        } else {
          g.strokeStyle = COL_ENEMY;
          g.lineWidth = 1.6;
          g.stroke();
          g.fillStyle = COL_ENEMY;
          g.fillRect(-1.2, -1.2, 2.4, 2.4);
        }
        // Subtle HP bar ONLY when aiming closely at enemy
        if (centerDist < 48 && dist < 80 && s.maxHp > 0) {
          drawHpBar(0, -13, 30, (s.hp || 0) / s.maxHp, COL_ENEMY);
        }
        g.restore();

        if (dist < 90 && centerDist < fallbackCrosshairDist) {
          fallbackCrosshairDist = centerDist;
          fallbackCrosshairIff = 'enemy';
        }
      }
    }

    // Draw tiny restrained name + HP bar ONLY for the single ally closest to crosshair
    if (closestAllyHover) {
      const a = closestAllyHover;
      g.save();
      g.font = '600 10px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      g.textAlign = 'center';
      const lbl = a.s.name || 'ALLY';
      g.fillStyle = 'rgba(5, 10, 16, 0.92)';
      g.fillText(lbl, a.x + 1, a.y - 14);
      g.fillStyle = '#a5e4ff';
      g.fillText(lbl, a.x, a.y - 15);
      if (a.s.maxHp > 0) {
        drawHpBar(a.x, a.y - 11, 34, (a.s.hp || 0) / a.s.maxHp, COL_ALLY);
      }
      g.restore();
    }

    // 2. Armored Vehicles (Friendly Cyan-Blue brackets vs Spotted/LOS Enemy Crimson-Red brackets)
    const vehicles = (snap && snap.vehicles) || [];
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v || !v.pos || v.destroyed || v.hp <= 0 || v.id === activeVehId) continue;
      const isFriendly = v.faction === playerFaction;
      const isSpotted = (v.spottedTimer || 0) > 0;
      const isLos = !!(v.inPlayerLOS || (losMap && losMap[v.id]));
      if (!isFriendly && !isSpotted && !isLos) continue;

      const dx = v.pos[0] - camPos[0];
      const dy = v.pos[1] - camPos[1];
      const dz = v.pos[2] - camPos[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 3.0 || dist > 180) continue;

      const pt = projectToScreen(vp, v.pos[0], v.pos[1] + 3.15, v.pos[2], W, H);
      if (!pt) continue;

      const col = isFriendly ? COL_ALLY : COL_ENEMY;
      const isTank = (v.type === 'tank') || /t-64|t-72/i.test(v.name || '');
      const alpha = clamp(1 - Math.max(0, dist - 90) / 80, 0.40, 0.96);

      g.save();
      g.globalAlpha = alpha;
      g.translate(pt.x, pt.y);
      // Compact military armor bracket + icon
      g.fillStyle = 'rgba(8, 12, 18, 0.78)';
      g.fillRect(-13, -7, 26, 13);
      g.strokeStyle = col;
      g.lineWidth = 1.4;
      g.strokeRect(-13, -7, 26, 13);
      g.fillStyle = col;
      g.font = '800 8.5px monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(isTank ? 'MBT' : 'IFV', 0, 0);
      // Compact armor HP bar
      if (v.maxHp > 0 && (v.hp < v.maxHp || Math.hypot(pt.x - cx, pt.y - cy) < 95)) {
        drawHpBar(0, -13, 32, v.hp / v.maxHp, col);
      }
      g.restore();

      const bodyPt = projectToScreen(vp, v.pos[0], v.pos[1] + 1.4, v.pos[2], W, H);
      if (bodyPt) {
        const cd = Math.hypot(bodyPt.x - cx, bodyPt.y - cy);
        if (cd < 42 && cd < fallbackCrosshairDist + 16) {
          fallbackCrosshairDist = cd;
          fallbackCrosshairIff = isFriendly ? 'ally' : 'enemy';
        }
      }
    }

    // 3. Unmanned Units (Friendly Cyan/Emerald UAV & UGV brackets vs Enemy Crimson-Red)
    const unmanned = (snap && snap.unmanned) || [];
    for (let i = 0; i < unmanned.length; i++) {
      const u = unmanned[i];
      if (!u || !u.pos || u.destroyed || u.alive === false || u.hp <= 0 || u.id === activeUnmId) continue;
      const isFriendly = u.faction === playerFaction;
      const isSpotted = (u.spottedTimer || 0) > 0;
      const isLos = !!(u.inPlayerLOS || (losMap && losMap[u.id]));
      if (!isFriendly && !isSpotted && !isLos) continue;

      const dx = u.pos[0] - camPos[0];
      const dy = u.pos[1] - camPos[1];
      const dz = u.pos[2] - camPos[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 1.5 || dist > 140) continue;

      const yOff = u.type === 'drone' ? 0.65 : 1.15;
      const pt = projectToScreen(vp, u.pos[0], u.pos[1] + yOff, u.pos[2], W, H);
      if (!pt) continue;

      const col = isFriendly ? (u.type === 'dog' ? COL_ALLY_UGV : COL_ALLY) : COL_ENEMY;
      g.save();
      g.globalAlpha = clamp(1 - Math.max(0, dist - 70) / 65, 0.35, 0.94);
      g.translate(pt.x, pt.y);
      g.strokeStyle = 'rgba(6, 10, 16, 0.92)';
      g.lineWidth = 2.4;
      if (u.type === 'drone') {
        g.beginPath();
        g.moveTo(-4.5, -4.5); g.lineTo(4.5, 4.5);
        g.moveTo(4.5, -4.5); g.lineTo(-4.5, 4.5);
        g.stroke();
        g.strokeStyle = col;
        g.lineWidth = 1.4;
        g.stroke();
      } else {
        g.strokeRect(-4.5, -4.5, 9, 9);
        g.strokeStyle = col;
        g.lineWidth = 1.4;
        g.strokeRect(-4.5, -4.5, 9, 9);
      }
      g.font = '700 8px monospace';
      g.textAlign = 'center';
      g.fillStyle = col;
      g.fillText(u.type === 'drone' ? 'UAV' : 'UGV', 0, -8);
      g.restore();
    }

    return fallbackCrosshairIff;
  }

  // ============================================================================
  // Live Interactive Tactical Map Canvas Renderer (M Key)
  // ============================================================================
  function renderTacticalMap(snap, dt) {
    const canvas = dom.mapCanvas;
    if (!canvas || !mapOpen) return;
    const g = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;

    const toX = (wx) => ((wx - MAP_MIN_X) / (MAP_MAX_X - MAP_MIN_X)) * W;
    const toY = (wz) => ((wz - MAP_MIN_Z) / (MAP_MAX_Z - MAP_MIN_Z)) * H;
    const scaleX = W / (MAP_MAX_X - MAP_MIN_X);
    const scaleZ = H / (MAP_MAX_Z - MAP_MIN_Z);

    g.fillStyle = '#0d1218';
    g.fillRect(0, 0, W, H);

    // Main Armored Avenue & Flank Alleys
    g.fillStyle = '#182029';
    g.fillRect(0, toY(-10), W, 20 * scaleZ);
    g.fillStyle = '#141b23';
    g.fillRect(0, toY(-46), W, 12 * scaleZ);
    g.fillRect(0, toY(34), W, 12 * scaleZ);

    // Center road lane dashes
    g.strokeStyle = 'rgba(220, 230, 240, 0.14)';
    g.lineWidth = 1;
    g.setLineDash([10, 10]);
    g.beginPath();
    g.moveTo(0, toY(0));
    g.lineTo(W, toY(0));
    g.stroke();
    g.setLineDash([]);

    // 20m Tactical Grid
    g.strokeStyle = 'rgba(180, 205, 230, 0.07)';
    g.lineWidth = 1;
    g.font = '600 9px monospace';
    g.fillStyle = 'rgba(140, 160, 180, 0.45)';
    let col = 0;
    for (let wx = -80; wx <= 80; wx += 20) {
      const px = toX(wx);
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
      g.fillText(String.fromCharCode(65 + col), px + 4, 11);
      col++;
    }
    let row = 1;
    for (let wz = -40; wz <= 40; wz += 20) {
      const py = toY(wz);
      g.beginPath(); g.moveTo(0, py); g.lineTo(W, py); g.stroke();
      g.fillText(String(row), 4, py + 11);
      row++;
    }

    // Buildings (prefer live DF.Map.getBuildings() if exposed, else exact map.js footprints)
    const buildings = (snap && snap.mapBuildings) ||
      (window.DF && window.DF.Map && typeof window.DF.Map.getBuildings === 'function' && window.DF.Map.getBuildings()) ||
      FALLBACK_BUILDINGS;
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      if (!b) continue;
      const bwRaw = b.w != null ? b.w : ((b.x1 || 0) - (b.x0 || 0));
      const bdRaw = b.d != null ? b.d : ((b.z1 || 0) - (b.z0 || 0));
      const bxWorld = b.x != null ? (b.x - bwRaw * 0.5) : (b.x0 || 0);
      const bzWorld = b.z != null ? (b.z - bdRaw * 0.5) : (b.z0 || 0);
      const bx = toX(bxWorld);
      const by = toY(bzWorld);
      const bw = bwRaw * scaleX;
      const bd = bdRaw * scaleZ;
      g.fillStyle = 'rgba(38, 48, 60, 0.78)';
      g.fillRect(bx, by, bw, bd);
      g.strokeStyle = 'rgba(160, 184, 208, 0.35)';
      g.lineWidth = 1.2;
      g.strokeRect(bx, by, bw, bd);
      if (b.label) {
        g.fillStyle = 'rgba(170, 190, 210, 0.48)';
        g.font = '700 10px monospace';
        g.fillText(b.label, bx + 5, by + 13);
      }
    }

    // Collapsed / breached structural walls (filtered to major walls/vehicles to keep map crisp)
    if (window.DF && window.DF.Destruction && typeof window.DF.Destruction.getPieces === 'function') {
      const pieces = window.DF.Destruction.getPieces() || [];
      g.strokeStyle = 'rgba(232, 168, 56, 0.55)';
      g.lineWidth = 1;
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        if (!p || !(p.collapsed || p.state === 'collapsed') || !p.pos) continue;
        const mat = p.material || '';
        if (mat !== 'concrete' && mat !== 'brick' && !p.explosive) continue;
        g.strokeRect(toX(p.pos[0]) - 2.5, toY(p.pos[2]) - 2.5, 5, 5);
      }
    }

    // Breakthrough Sectors A / B / C
    const sectors = (snap && Array.isArray(snap.sectors) && snap.sectors.length) ? snap.sectors : [
      { id: 'A', pos: [-38, 0, 0], radius: 15, owner: 'UA', progress: 0, active: true },
      { id: 'B', pos: [4, 0, 0], radius: 18, owner: 'UA', progress: 0, active: false },
      { id: 'C', pos: [52, 0, 0], radius: 16, owner: 'UA', progress: 0, active: false }
    ];
    for (let i = 0; i < sectors.length; i++) {
      const s = sectors[i];
      if (!s || !s.pos) continue;
      const sx = toX(s.pos[0]);
      const sy = toY(s.pos[2]);
      const rx = (s.radius || 16) * scaleX;
      const pfMap = (snap && (snap.playerFaction || snap.faction)) || settings.faction;
      const sFriendly = s.owner === pfMap;
      const colStroke = s.active ? COL_ORDER : (sFriendly ? COL_ALLY : COL_ENEMY);
      const colFill = sFriendly ? 'rgba(56, 189, 248, 0.14)' : 'rgba(255, 59, 48, 0.16)';

      g.beginPath();
      g.arc(sx, sy, rx, 0, Math.PI * 2);
      g.fillStyle = colFill;
      g.fill();
      g.strokeStyle = colStroke;
      g.lineWidth = s.active ? 2 : 1.2;
      g.stroke();

      if (s.progress > 0.01) {
        g.beginPath();
        g.arc(sx, sy, rx - 3, -Math.PI * 0.5, -Math.PI * 0.5 + Math.PI * 2 * clamp(s.progress, 0, 1));
        g.strokeStyle = '#e8a838';
        g.lineWidth = 3;
        g.stroke();
      }

      g.fillStyle = '#eef4fa';
      g.font = '800 13px monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(s.id || 'A', sx, sy);
    }
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';

    // Active Squad Order Waypoint
    const orderPos = (snap && snap.orderPos) || lastOrderPos;
    const pPos = (snap && snap.player && snap.player.pos) || (snap && snap.camera && snap.camera.pos);
    if (orderPos) {
      const ox = toX(orderPos[0]);
      const oy = toY(orderPos[2]);
      if (pPos) {
        g.strokeStyle = 'rgba(232, 168, 56, 0.42)';
        g.setLineDash([5, 5]);
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(toX(pPos[0]), toY(pPos[2]));
        g.lineTo(ox, oy);
        g.stroke();
        g.setLineDash([]);
      }
      g.strokeStyle = '#e8a838';
      g.lineWidth = 1.6;
      g.beginPath();
      g.arc(ox, oy, 8, 0, Math.PI * 2);
      g.moveTo(ox - 12, oy); g.lineTo(ox + 12, oy);
      g.moveTo(ox, oy - 12); g.lineTo(ox, oy + 12);
      g.stroke();
    }

    const playerFaction = (snap && snap.faction) || settings.faction;

    // Armored Vehicles (Friendly Cyan-Blue vs Enemy Crimson-Red + Turret Heading)
    const vehicles = (snap && snap.vehicles) || [];
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v || !v.pos) continue;
      if (v.faction !== playerFaction && !(v.spottedTimer > 0) && !v.inPlayerLOS && !v.destroyed) continue;
      const vx = toX(v.pos[0]);
      const vy = toY(v.pos[2]);
      const hullA = -(v.hullYaw != null ? v.hullYaw : (v.yaw || 0)) - Math.PI * 0.5;
      const turA = -(v.turretYaw != null ? v.turretYaw : (v.yaw || 0)) - Math.PI * 0.5;
      const color = v.destroyed ? '#5c6670' : (v.faction === playerFaction ? COL_ALLY : COL_ENEMY);
      const isTank = (v.type === 'tank') || /t-64|t-72/i.test(v.name || '');

      g.save();
      g.translate(vx, vy);
      g.rotate(hullA);
      const len = isTank ? 16 : 13;
      const wid = isTank ? 10 : 8;
      g.fillStyle = color;
      g.fillRect(-len * 0.5, -wid * 0.5, len, wid);
      g.strokeStyle = '#e6edf3';
      g.lineWidth = 1;
      g.strokeRect(-len * 0.5, -wid * 0.5, len, wid);
      g.restore();

      if (!v.destroyed) {
        g.save();
        g.translate(vx, vy);
        g.rotate(turA);
        g.strokeStyle = '#f5c542';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(isTank ? 14 : 11, 0);
        g.stroke();
        g.restore();
      }
    }

    // Soldiers (Friendly Cyan-Blue, Downed Amber Cross, Enemy Crimson-Red Diamond)
    const soldiers = (snap && snap.soldiers) || [];
    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (!s || !s.pos || s.state === 'dead' || s.inVehicleId) continue;
      const isFriendly = s.faction === playerFaction;
      if (!isFriendly && !(s.spottedTimer > 0) && !s.inPlayerLOS) continue;

      const sx = toX(s.pos[0]);
      const sy = toY(s.pos[2]);

      if (s.isPlayer) {
        const ang = -(s.yaw || 0) - Math.PI * 0.5;
        g.save();
        g.translate(sx, sy);
        g.rotate(ang);
        g.fillStyle = '#f5c542';
        g.beginPath();
        g.moveTo(8, 0);
        g.lineTo(-5, -5);
        g.lineTo(-2, 0);
        g.lineTo(-5, 5);
        g.closePath();
        g.fill();
        g.restore();
      } else if (s.state === 'downed') {
        g.strokeStyle = isFriendly ? COL_REVIVE : COL_ENEMY;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(sx - 4, sy); g.lineTo(sx + 4, sy);
        g.moveTo(sx, sy - 4); g.lineTo(sx, sy + 4);
        g.stroke();
      } else if (isFriendly) {
        g.fillStyle = COL_ALLY;
        g.beginPath();
        g.arc(sx, sy, 4.2, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#07111a';
        g.lineWidth = 1;
        g.stroke();
      } else {
        g.fillStyle = COL_ENEMY;
        g.beginPath();
        g.moveTo(sx, sy - 5);
        g.lineTo(sx + 5, sy);
        g.lineTo(sx, sy + 5);
        g.lineTo(sx - 5, sy);
        g.closePath();
        g.fill();
      }
    }

    // Unmanned Units (Friendly Cyan/Emerald vs Enemy Crimson-Red)
    const unmanned = (snap && snap.unmanned) || [];
    for (let i = 0; i < unmanned.length; i++) {
      const u = unmanned[i];
      if (!u || !u.pos || u.destroyed || u.alive === false) continue;
      const isFriendly = u.faction === playerFaction;
      if (!isFriendly && !(u.spottedTimer > 0) && !u.inPlayerLOS) continue;
      const ux = toX(u.pos[0]);
      const uy = toY(u.pos[2]);
      if (u.type === 'drone') {
        g.strokeStyle = isFriendly ? COL_ALLY : COL_ENEMY;
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(ux - 5, uy - 5); g.lineTo(ux + 5, uy + 5);
        g.moveTo(ux + 5, uy - 5); g.lineTo(ux - 5, uy + 5);
        g.stroke();
      } else {
        g.strokeStyle = isFriendly ? COL_ALLY_UGV : COL_ENEMY;
        g.lineWidth = 1.6;
        g.strokeRect(ux - 4, uy - 4, 8, 8);
      }
    }

    // Animated Click Waypoint Ripples
    for (let i = mapPings.length - 1; i >= 0; i--) {
      const p = mapPings[i];
      p.life -= dt;
      if (p.life <= 0) {
        mapPings.splice(i, 1);
        continue;
      }
      const prog = 1 - p.life / p.maxLife;
      g.beginPath();
      g.arc(toX(p.wx), toY(p.wz), 6 + prog * 28, 0, Math.PI * 2);
      g.strokeStyle = `rgba(232, 168, 56, ${(1 - prog).toFixed(2)})`;
      g.lineWidth = 2;
      g.stroke();
    }
  }

  // ============================================================================
  // Public HUD Feedback & State Methods
  // ============================================================================
  function showNotification(text, tone) {
    if (!isInit || !dom.radioToast) return;
    dom.radioMsg.textContent = String(text || '');
    dom.radioToast.className = 'visible' + (tone ? ' tone-' + tone : '');
    toastTimer = 3.8;
  }

  function addKillfeed(killer, weapon, victim, killerFaction, victimFaction, isHeadshot) {
    if (!isInit || !dom.killfeed) return;
    killfeedEntries.push({
      killer: killer || 'Unknown',
      weapon: weapon || 'RIFLE',
      victim: victim || 'Target',
      kf: killerFaction || 'UA',
      vf: victimFaction || 'RU',
      hs: !!isHeadshot,
      ttl: 6.5
    });
    while (killfeedEntries.length > 5) killfeedEntries.shift();
    rebuildKillfeedDOM();
  }

  function rebuildKillfeedDOM() {
    if (!dom.killfeed) return;
    const pf = settings.faction || 'UA';
    let html = '';
    for (let i = 0; i < killfeedEntries.length; i++) {
      const e = killfeedEntries[i];
      const op = e.ttl < 1.0 ? clamp(e.ttl, 0, 1).toFixed(2) : '1';
      const kAlly = e.kf === pf;
      const vAlly = e.vf === pf;
      const kCls = kAlly ? 'df-kf-name-ally' : 'df-kf-name-enemy';
      const vCls = vAlly ? 'df-kf-name-ally' : 'df-kf-name-enemy';
      const rCls = kAlly ? 'kf-ally' : 'kf-enemy';
      html += `<div class="df-kf-row ${rCls}" style="opacity:${op}">
        <span class="${kCls}">${escapeHtml(e.killer)}</span>
        <span class="df-kf-wpn">${escapeHtml(e.weapon)}</span>
        ${e.hs ? `<span class="df-kf-hs">${SVG_ICONS.headshot}</span>` : ''}
        <span class="${vCls}">${escapeHtml(e.victim)}</span>
      </div>`;
    }
    dom.killfeed.innerHTML = html;
  }

  function triggerHitmarker(isKill, isHeadshot, isArmor) {
    impHitmarkerTimer = isKill ? 0.28 : 0.16;
    impHitmarkerKill = !!isKill;
    impHitmarkerHS = !!isHeadshot;
    impHitmarkerArmor = !!isArmor;
  }

  function triggerDamageIndicator(sourcePosOrAngle, playerPos, playerYaw) {
    impDamageArcTimer = 0.95;
    if (typeof sourcePosOrAngle === 'number') {
      impDamageArcAngle = sourcePosOrAngle;
    } else if (sourcePosOrAngle && playerPos) {
      const dx = sourcePosOrAngle[0] - playerPos[0];
      const dz = sourcePosOrAngle[2] - playerPos[2];
      const srcAngle = Math.atan2(dx, -dz);
      const lookAngle = -(playerYaw || 0);
      impDamageArcAngle = srcAngle - lookAngle;
    }
  }

  function clearKillfeed() {
    killfeedEntries.length = 0;
    if (dom.killfeed) dom.killfeed.innerHTML = '';
  }

  function resetMatchState(clearToast) {
    clearKillfeed();
    mapPings.length = 0;
    lastOrderPos = null;
    lastActiveOrderName = '跟随推进';
    impHitmarkerTimer = 0;
    impHitmarkerKill = false;
    impHitmarkerHS = false;
    impHitmarkerArmor = false;
    impDamageArcTimer = 0;
    squadHtmlThrottle = 0;
    if (dom.hitmarker) {
      dom.hitmarker.classList.remove('show', 'kill', 'headshot', 'armor');
      dom.hitmarker.style.opacity = '0';
    }
    if (dom.damageArc) dom.damageArc.style.opacity = '0';
    if (clearToast) {
      toastTimer = 0;
      if (dom.radioToast) dom.radioToast.classList.remove('visible');
    }
  }

  function showBriefing(show) {
    const prev = briefingVisible;
    briefingVisible = !!show;
    if (!isInit) return;
    dom.briefing.classList.toggle('df-hidden', !briefingVisible);
    dom.hud.classList.toggle('df-hidden', briefingVisible);
    if (briefingVisible) {
      resetMatchState(true);
      openRadial(false);
      toggleMap(false);
      togglePause(false);
      dom.downed.classList.add('df-hidden');
      dom.endscreen.classList.add('df-hidden');
      endVisible = false;
    } else if (prev) {
      // Entering fresh HUD from briefing
      resetMatchState(false);
    }
  }

  function toggleMap(force) {
    if (!isInit) return false;
    if (briefingVisible || endVisible) {
      mapOpen = false;
      dom.mapModal.classList.add('df-hidden');
      return false;
    }
    mapOpen = force !== undefined ? !!force : !mapOpen;
    if (mapOpen) {
      openRadial(false);
      togglePause(false);
    }
    dom.mapModal.classList.toggle('df-hidden', !mapOpen);
    return mapOpen;
  }

  function togglePause(force) {
    if (!isInit) return false;
    if (briefingVisible || endVisible) {
      pauseOpen = false;
      dom.pause.classList.add('df-hidden');
      return false;
    }
    pauseOpen = force !== undefined ? !!force : !pauseOpen;
    if (pauseOpen) {
      openRadial(false);
      toggleMap(false);
    }
    dom.pause.classList.toggle('df-hidden', !pauseOpen);
    emitAction('ui:pause', 'onPauseToggle', pauseOpen);
    return pauseOpen;
  }

  function showEndScreen(result) {
    if (!isInit || !result) return;
    endVisible = true;
    openRadial(false);
    toggleMap(false);
    togglePause(false);
    dom.downed.classList.add('df-hidden');
    dom.endscreen.classList.remove('df-hidden');

    const won = !!result.victory;
    dom.endBanner.classList.toggle('victory', won);
    dom.endBanner.classList.toggle('defeat', !won);
    dom.endVerdict.textContent = won ? 'VICTORY // 作战胜利' : 'DEFEAT // 防线失守';
    dom.endReason.textContent = result.reason || (won ? '战术目标全部达成' : '敌方已完成战区突破');

    const st = result.stats || result;
    dom.stKills.textContent = String(st.kills || 0);
    dom.stHs.textContent = String(st.headshots || 0);
    dom.stVeh.textContent = String(st.vehiclesDestroyed || 0);
    dom.stWalls.textContent = String(st.wallsBreached || 0);
    dom.stRev.textContent = String(st.alliesRevived != null ? st.alliesRevived : (st.revives || 0));
    dom.stSec.textContent = st.sectorsLabel || `${st.sectorsCaptured || 0}/3`;

    audioCue(won ? 'victory' : 'defeat');
  }

  function setHidden(hide) {
    hudHidden = !!hide;
    if (root) {
      root.classList.toggle('df-hud-hidden', hudHidden);
    }
  }

  function setFaction(f) {
    if (f !== 'UA' && f !== 'RU') return;
    settings.faction = f;
    if (dom.briefing) {
      const fBtns = dom.briefing.querySelectorAll('[data-faction]');
      for (let i = 0; i < fBtns.length; i++) {
        fBtns[i].classList.toggle('active', fBtns[i].dataset.faction === f);
      }
    }
  }

  // ============================================================================
  // Per-Frame HUD Update (Seamlessly compatible with src/main.js buildUISnapshot)
  // ============================================================================
  function update(dt, snapshot) {
    if (!isInit) return;
    const safeDt = clamp(dt || 0.016, 0.001, 0.1);
    const snap = snapshot || {};

    // Sync initial settings from Game.settings once
    if (!settingsSyncedOnce && snap.settings) {
      settingsSyncedOnce = true;
      if (snap.settings.quality) settings.quality = snap.settings.quality;
      if (snap.settings.sensitivity != null) settings.sensitivity = snap.settings.sensitivity;
      if (snap.settings.masterVol != null) settings.masterVol = snap.settings.masterVol;
      if (snap.settings.sfxVol != null) settings.sfxVol = snap.settings.sfxVol;
      if (snap.settings.musicVol != null) settings.musicVol = snap.settings.musicVol;
      if (snap.settings.invertY != null) settings.invertY = !!snap.settings.invertY;
      syncSettingsUI();
    }

    // Respect hideHUD flag from DF_DEBUG / Game
    if (snap.hideHUD !== undefined && snap.hideHUD !== hudHidden) {
      setHidden(snap.hideHUD);
    }

    // Detect fresh match start (menu/ended -> playing, faction switch, or GameMode elapsed reset)
    const snapGm = snap.gameMode || {};
    const gmElapsed = snapGm.elapsed != null ? snapGm.elapsed : null;
    const matchRestarted =
      (snap.phase === 'playing' && (lastPhase === 'menu' || lastPhase === 'ended')) ||
      (snap.phase === 'playing' && lastMatchFaction !== null && snap.faction && snap.faction !== lastMatchFaction) ||
      (snap.phase === 'playing' && gmElapsed !== null && lastGmElapsed > 0.45 && gmElapsed < lastGmElapsed - 0.35);
    if (matchRestarted) {
      resetMatchState(false);
    }
    if (snap.phase) lastPhase = snap.phase;
    if (snap.faction) lastMatchFaction = snap.faction;
    if (gmElapsed !== null) lastGmElapsed = gmElapsed;

    // Phase synchronization (handles DF_DEBUG.startMatch(), pause, and match end automatically!)
    if (snap.phase === 'menu') {
      if (!briefingVisible) showBriefing(true);
      endScreenShownForMatch = false;
    } else if (snap.phase === 'playing') {
      if (briefingVisible) showBriefing(false);
      if (pauseOpen) togglePause(false);
      if (endVisible) {
        endVisible = false;
        dom.endscreen.classList.add('df-hidden');
      }
      endScreenShownForMatch = false;
    } else if (snap.phase === 'paused') {
      if (briefingVisible) showBriefing(false);
      if (!pauseOpen) togglePause(true);
    } else if (snap.phase === 'ended') {
      if (briefingVisible) showBriefing(false);
      if (!endScreenShownForMatch) {
        endScreenShownForMatch = true;
        const gm = snap.gameMode || {};
        const pf = snap.faction || settings.faction;
        const won = gm.winner ? (gm.winner === pf) : false;
        let captured = 0;
        if (Array.isArray(snap.sectors)) {
          for (let i = 0; i < snap.sectors.length; i++) {
            if (snap.sectors[i] && snap.sectors[i].owner === 'RU') captured++;
          }
        }
        showEndScreen({
          victory: won,
          reason: gm.endReason || gm.reason || (won ? '作战目标已完成' : '敌方赢得本局胜利'),
          stats: Object.assign({}, gm.stats || {}, snap.stats || {}),
          sectorsLabel: (gm.stats && gm.stats.sectorsLabel) || `${captured}/3`
        });
      }
    }

    // Sync map open flag if changed externally
    if (snap.mapOpen !== undefined && snap.mapOpen !== mapOpen && !briefingVisible && !endVisible) {
      toggleMap(snap.mapOpen);
    }

    // Fade killfeed entries
    if (killfeedEntries.length > 0) {
      let dirty = false;
      for (let i = killfeedEntries.length - 1; i >= 0; i--) {
        killfeedEntries[i].ttl -= safeDt;
        if (killfeedEntries[i].ttl <= 0) {
          killfeedEntries.splice(i, 1);
          dirty = true;
        } else if (killfeedEntries[i].ttl < 1.0) {
          dirty = true;
        }
      }
      if (dirty) rebuildKillfeedDOM();
    }

    // Fade radio toast
    if (toastTimer > 0) {
      toastTimer -= safeDt;
      if (toastTimer <= 0 && dom.radioToast) {
        dom.radioToast.classList.remove('visible');
      }
    }

    // Pause menu FPS badge
    if (pauseOpen && dom.pFps) {
      const fpsVal = (snap.rendererStats && snap.rendererStats.fps) || snap.fps;
      if (fpsVal !== undefined) dom.pFps.textContent = `${Math.round(fpsVal)} FPS`;
    }

    if (briefingVisible) return;

    const p = snap.player || {};
    const w = snap.weapon || {};
    const gm = snap.gameMode || {};
    const cam = snap.camera || {};
    const playerFaction = snap.playerFaction || snap.faction || settings.faction;
    if (playerFaction !== settings.faction) setFaction(playerFaction);

    // 1. Compass, Persistent Minimap, 3D Overhead IFF & Breakthrough Sectors + Reinforcement Tickets
    const yaw = cam.yaw != null ? cam.yaw : (p.yaw || 0);
    const pPos = cam.pos || p.pos || [0, 0, 0];
    renderCompass(yaw, pPos, snap.sectors, snap.soldiers, snap.orderPos || lastOrderPos, playerFaction);
    renderMinimap(snap, yaw, pPos, playerFaction);
    const projectedIff = renderOverheadIFF(snap, pPos, playerFaction, safeDt);

    // Live UA/RU troop counters & Reinforcement Tickets
    const activeCnt = gm.activeCounts || gm.counts || {};
    let uaAlive = activeCnt.UA != null ? activeCnt.UA : (activeCnt.uaAlive != null ? activeCnt.uaAlive : gm.uaAlive);
    let ruAlive = activeCnt.RU != null ? activeCnt.RU : (activeCnt.ruAlive != null ? activeCnt.ruAlive : gm.ruAlive);
    if (uaAlive == null || ruAlive == null) {
      uaAlive = 0;
      ruAlive = 0;
      const list = snap.soldiers || [];
      for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].state !== 'dead') {
          if (list[i].faction === 'UA') uaAlive++;
          else if (list[i].faction === 'RU') ruAlive++;
        }
      }
    }
    dom.uaCount.textContent = String(uaAlive);
    dom.ruCount.textContent = String(ruAlive);

    const tix = snap.tickets || gm.tickets || null;
    const uaTix = tix && tix.UA != null ? tix.UA : (gm.uaTickets != null ? gm.uaTickets : (activeCnt.uaTickets != null ? activeCnt.uaTickets : null));
    const ruTix = tix && tix.RU != null ? tix.RU : (gm.ruTickets != null ? gm.ruTickets : (activeCnt.ruTickets != null ? activeCnt.ruTickets : null));
    if (dom.uaTickets) {
      if (uaTix != null) {
        dom.uaTickets.classList.remove('df-hidden');
        dom.uaTickets.textContent = `[${Math.max(0, Math.round(uaTix))}]`;
        dom.uaTickets.classList.toggle('low', uaTix <= 5);
      } else {
        dom.uaTickets.classList.add('df-hidden');
      }
    }
    if (dom.ruTickets) {
      if (ruTix != null) {
        dom.ruTickets.classList.remove('df-hidden');
        dom.ruTickets.textContent = `[${Math.max(0, Math.round(ruTix))}]`;
        dom.ruTickets.classList.toggle('low', ruTix <= 10);
      } else {
        dom.ruTickets.classList.add('df-hidden');
      }
    }

    const timeRem = gm.timeRemaining != null ? gm.timeRemaining : (gm.timer != null ? gm.timer : snap.timeRemaining);
    if (timeRem != null) {
      const sec = Math.max(0, Math.ceil(timeRem));
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      dom.matchTimer.textContent = `${mm}:${ss}`;
    }

    if (Array.isArray(snap.sectors)) {
      const nodes = dom.sectorsRow.querySelectorAll('.df-sector-node');
      for (let i = 0; i < nodes.length && i < snap.sectors.length; i++) {
        const s = snap.sectors[i];
        const node = nodes[i];
        node.classList.toggle('owner-ua', s.owner === 'UA');
        node.classList.toggle('owner-ru', s.owner === 'RU');
        node.classList.toggle('active', !!s.active);
        node.classList.toggle('contested', !!s.contested);
        const fill = node.querySelector('.df-sector-fill');
        if (fill) {
          const pct = s.owner === 'RU' ? 100 : clamp((s.progress || 0) * 100, 0, 100);
          fill.style.height = `${pct.toFixed(0)}%`;
        }
      }
    }

    // 2. Hitmarker (both snapshot.hitmarker AND imperative triggerHitmarker: normal/headshot/kill/armor)
    if (impHitmarkerTimer > 0) impHitmarkerTimer -= safeDt;
    const snapHm = snap.hitmarker || {};
    const hmAlpha = Math.max(snapHm.alpha || 0, impHitmarkerTimer > 0 ? clamp(impHitmarkerTimer / 0.16, 0, 1) : 0);
    if (hmAlpha > 0.02) {
      const isK = !!(snapHm.isKill || impHitmarkerKill);
      const isH = !!(snapHm.isHeadshot || impHitmarkerHS);
      const isA = !!(snapHm.isArmor || impHitmarkerArmor);
      dom.hitmarker.classList.add('show');
      dom.hitmarker.style.opacity = hmAlpha.toFixed(2);
      dom.hitmarker.classList.toggle('kill', isK);
      dom.hitmarker.classList.toggle('headshot', isH && !isK);
      dom.hitmarker.classList.toggle('armor', isA && !isK && !isH);
    } else {
      dom.hitmarker.classList.remove('show', 'kill', 'headshot', 'armor');
      dom.hitmarker.style.opacity = '0';
    }

    // 3. Directional Damage Arc (both snapshot.damageIndicator AND imperative)
    if (impDamageArcTimer > 0) impDamageArcTimer -= safeDt;
    const snapDmg = snap.damageIndicator || {};
    const dmgAlpha = Math.max(snapDmg.alpha || 0, impDamageArcTimer > 0 ? clamp(impDamageArcTimer / 0.95, 0, 1) : 0);
    if (dmgAlpha > 0.02) {
      // main.js computes angle = worldAngle - yaw where positive is CCW (left); CSS rotate is CW
      const deg = snapDmg.alpha > 0.02
        ? (-(snapDmg.angle || 0) * 180) / Math.PI
        : (impDamageArcAngle * 180) / Math.PI;
      dom.damageArc.style.opacity = clamp(dmgAlpha, 0, 1).toFixed(2);
      dom.damageArc.style.transform = `rotate(${deg.toFixed(1)}deg)`;
    } else if (dom.damageArc.style.opacity !== '0') {
      dom.damageArc.style.opacity = '0';
    }

    // 4. Optical / Vehicle / Unmanned Overlays + Crosshair Dynamics + Crosshair IFF Tint
    const opticCoversCrosshair = renderOpticOverlay(snap);
    const adsBlend = w.adsBlend != null ? w.adsBlend : (p.adsBlend || 0);
    const playerState = p.state || (snap.controlMode === 'downed' ? 'downed' : (snap.controlMode === 'dead' ? 'dead' : 'alive'));
    const hideCrosshair = opticCoversCrosshair || adsBlend > 0.55 || !!p.sprinting || playerState === 'downed' || playerState === 'dead';
    dom.crosshair.style.opacity = hideCrosshair ? '0' : '1';
    const chIff = snap.crosshairTargetType !== undefined ? snap.crosshairTargetType : projectedIff;
    dom.crosshair.classList.toggle('iff-ally', !hideCrosshair && chIff === 'ally');
    dom.crosshair.classList.toggle('iff-enemy', !hideCrosshair && chIff === 'enemy');
    if (!hideCrosshair) {
      const velSpeed = p.vel ? Math.hypot(p.vel[0] || 0, p.vel[2] || 0) : 0;
      const spreadPx = clamp(7 + velSpeed * 1.45 + (p.suppression || 0) * 12, 6, 42);
      dom.chT.style.bottom = `${spreadPx.toFixed(1)}px`;
      dom.chB.style.top = `${spreadPx.toFixed(1)}px`;
      dom.chL.style.right = `${spreadPx.toFixed(1)}px`;
      dom.chR.style.left = `${spreadPx.toFixed(1)}px`;
    }

    // 5. Player Vitals & Low-HP Vignette
    const hp = Math.max(0, Math.round(p.hp != null ? p.hp : 100));
    const maxHp = Math.max(1, p.maxHp || 100);
    const hpPct = clamp((hp / maxHp) * 100, 0, 100);
    dom.hpNum.textContent = String(hp);
    dom.hpNum.classList.toggle('low', hpPct < 35);
    dom.hpBar.style.width = `${hpPct.toFixed(1)}%`;
    dom.hpBar.classList.toggle('low', hpPct < 35);
    dom.lowHpVig.style.opacity = hpPct < 38 && playerState === 'alive'
      ? ((1 - hpPct / 38) * 0.85).toFixed(2)
      : '0';

    const modeTag = snap.controlMode === 'vehicle' && snap.vehicle
      ? (snap.vehicle.name || 'ARMOR').toUpperCase()
      : (snap.controlMode || 'INFANTRY').toUpperCase();
    dom.hpLabel.textContent = `HP // ${modeTag}`;

    const stance = p.crouching ? 'crouch' : (p.sprinting ? 'sprint' : 'stand');
    const stIcon = stance === 'crouch' ? SVG_ICONS.stance_crouch : (stance === 'sprint' ? SVG_ICONS.stance_sprint : SVG_ICONS.stance_stand);
    dom.stanceBadge.innerHTML = `${stIcon}<span>${stance.toUpperCase()}</span>`;

    // Active squad order
    if (Array.isArray(snap.allies) && snap.allies.length > 0 && snap.allies[0].order) {
      const ord = snap.allies[0].order;
      lastActiveOrderName = ORDER_LABELS[ord] || ord;
      if (snap.allies[0].orderPos) lastOrderPos = snap.allies[0].orderPos;
    }
    dom.activeOrder.textContent = lastActiveOrderName;

    // 6. Squad Status Strip (throttled ~10Hz to keep DOM light)
    squadHtmlThrottle -= safeDt;
    if (squadHtmlThrottle <= 0) {
      squadHtmlThrottle = 0.10;
      const allies = Array.isArray(snap.allies) ? snap.allies : [];
      const squadRows = [];
      if (p && p.id != null) {
        squadRows.push({
          name: p.name || 'PLAYER',
          role: p.role || 'rifleman',
          hp: p.hp,
          maxHp: p.maxHp || 100,
          faction: playerFaction,
          state: playerState,
          isPlayer: true,
          inVehicleId: snap.controlMode === 'vehicle' ? 1 : 0,
          order: ''
        });
      }
      // Prioritize alive / downed allies up to 5 total rows
      const sortedAllies = allies.slice().sort((a, b) => {
        const sA = a.state === 'downed' ? 0 : (a.state === 'alive' ? 1 : 2);
        const sB = b.state === 'downed' ? 0 : (b.state === 'alive' ? 1 : 2);
        return sA - sB;
      });
      for (let i = 0; i < sortedAllies.length && squadRows.length < 5; i++) {
        squadRows.push(sortedAllies[i]);
      }

      let sqHtml = '';
      for (let i = 0; i < squadRows.length; i++) {
        const m = squadRows[i];
        const mHp = m.maxHp > 0 ? clamp((m.hp / m.maxHp) * 100, 0, 100) : 0;
        const rSvg = SVG_ICONS['role_' + (m.role || 'rifleman')] || SVG_ICONS.role_rifleman;
        const fCls = m.faction === 'RU' ? 'ru' : 'ua';
        const sCls = m.state === 'dead' ? 'dead' : (m.state === 'downed' ? 'downed' : '');
        const pCls = m.isPlayer ? 'is-player' : '';
        const tag = m.state === 'dead' ? 'KIA'
          : (m.state === 'downed' ? 'DOWN'
          : (m.inVehicleId ? 'ARMOR' : (m.isPlayer ? 'YOU' : (ORDER_LABELS[m.order] ? ORDER_LABELS[m.order].slice(0, 2) : 'OK'))));
        sqHtml += `<div class="df-sq-row ${fCls} ${sCls} ${pCls}">
          <span>${rSvg}</span>
          <span class="df-sq-name">${escapeHtml(m.name || 'SQUAD')}</span>
          <div class="df-sq-hp-track"><div class="df-sq-hp-fill" style="width:${mHp.toFixed(0)}%"></div></div>
          <span class="df-sq-tag">${tag}</span>
        </div>`;
      }
      dom.squadList.innerHTML = sqHtml;
    }

    // 7. Weapon Telemetry, SVG Silhouette & Reload Stage
    const ctrl = snap.controlMode || 'infantry';
    const slot = w.slot != null ? w.slot : (p.weaponSlot || 0);
    let wpnSvgKey = 'wpn_' + clamp(slot, 0, 5);
    if (ctrl === 'vehicle' && snap.vehicle) {
      const vt = ((snap.vehicle.type || '') + ' ' + (snap.vehicle.name || '')).toLowerCase();
      wpnSvgKey = /ifv|bradley|bmp/.test(vt) ? 'wpn_ifv' : 'wpn_tank';
    } else if (ctrl === 'drone') {
      wpnSvgKey = 'wpn_drone';
    } else if (ctrl === 'dog') {
      wpnSvgKey = 'wpn_dog';
    }
    if (wpnSvgKey !== lastWeaponKey) {
      lastWeaponKey = wpnSvgKey;
      dom.wpnSvgWrap.innerHTML = SVG_ICONS[wpnSvgKey] || SVG_ICONS.wpn_0;
    }

    let magVal = w.mag != null ? w.mag : 0;
    let magMax = w.magSize || 30;
    let resVal = w.reserve != null ? w.reserve : 0;
    let wName = w.name || 'RIFLE';
    let wCal = w.caliber || '';
    let wMode = (w.fireMode || 'AUTO').toUpperCase();

    if (ctrl === 'vehicle' && snap.vehicle) {
      magVal = snap.vehicle.secAmmo != null ? snap.vehicle.secAmmo : 200;
      magMax = 200;
      resVal = 999;
      wName = snap.vehicle.name || 'ARMOR';
      wCal = wpnSvgKey === 'wpn_tank' ? '125MM + 7.62' : '30MM + ATGM';
      wMode = 'FCS';
    } else if (ctrl === 'drone' && snap.unmannedUnit) {
      magVal = snap.unmannedUnit.bombs != null ? snap.unmannedUnit.bombs : 2;
      magMax = 2;
      resVal = 0;
      wName = 'RECON / FPV UAV';
      wCal = 'VOG-17';
      wMode = 'DROP';
    } else if (ctrl === 'dog' && snap.unmannedUnit) {
      magVal = snap.unmannedUnit.ammo != null ? snap.unmannedUnit.ammo : 60;
      magMax = 60;
      resVal = 180;
      wName = 'UGV RWS TURRET';
      wCal = '5.56 SUPP';
      wMode = 'AUTO';
    }

    dom.ammoMag.textContent = String(magVal);
    dom.ammoMag.classList.toggle('empty', magVal <= 0);
    dom.ammoMag.classList.toggle('low', magVal > 0 && magVal <= Math.max(1, Math.floor(magMax * 0.25)));
    dom.ammoRes.textContent = resVal >= 999 ? 'INF' : String(resVal);
    dom.wpnName.textContent = wName;
    dom.wpnCal.textContent = wCal;
    dom.fireMode.textContent = wMode;

    if (ctrl === 'infantry' && w.reloading) {
      dom.reloadRow.classList.remove('df-hidden');
      const rp = clamp(w.reloadProgress || 0, 0, 1);
      const stageTxt = w.reloadStage
        ? (RELOAD_LABELS[w.reloadStage] || w.reloadStage)
        : (rp < 0.35 ? '卸下弹匣' : (rp < 0.72 ? '装入弹匣' : '拉栓上膛'));
      dom.reloadStage.textContent = stageTxt;
      dom.reloadFill.style.width = `${(rp * 100).toFixed(0)}%`;
    } else {
      dom.reloadRow.classList.add('df-hidden');
    }

    // Hotkey ribbon active state & gadget counts
    const slotEls = dom.hotkeyRibbon.querySelectorAll('[data-slot]');
    for (let i = 0; i < slotEls.length; i++) {
      slotEls[i].classList.toggle('active', ctrl === 'infantry' && parseInt(slotEls[i].dataset.slot, 10) === slot);
    }
    dom.hkDrone.classList.toggle('active', ctrl === 'drone');
    dom.hkDog.classList.toggle('active', ctrl === 'dog');
    if (w.fragCount != null) dom.fragCnt.textContent = String(w.fragCount);
    if (w.smokeCount != null) dom.smokeCnt.textContent = String(w.smokeCount);

    // Check friendly drone/dog ready status from snap.unmanned
    if (Array.isArray(snap.unmanned)) {
      const fDrone = snap.unmanned.find((u) => u.type === 'drone' && u.faction === playerFaction);
      const fDog = snap.unmanned.find((u) => u.type === 'dog' && u.faction === playerFaction);
      dom.hkDrone.classList.toggle('cooldown', !!(fDrone && (fDrone.destroyed || fDrone.hp <= 0)));
      dom.hkDog.classList.toggle('cooldown', !!(fDog && (fDog.destroyed || fDog.hp <= 0)));
    }

    // 8. Contextual Interaction Prompt ([E]) & Downed / Takeover Overlay (mutually exclusive bottom-center)
    const isDowned = (playerState === 'downed' || playerState === 'dead' || ctrl === 'downed' || ctrl === 'dead') && !endVisible;

    // Hide bottom-center vehicle armor diagram & uav prompt whenever downed so they never overlap #df-downed
    if (dom.opticLayer) {
      const armorDiag = dom.opticLayer.querySelector('.df-armor-diag');
      if (armorDiag) armorDiag.classList.toggle('df-hidden', isDowned);
      const uavPrompt = dom.opticLayer.querySelector('.df-uav-prompt');
      if (uavPrompt) uavPrompt.classList.toggle('df-hidden', isDowned);
    }

    if (snap.interactPrompt && !isDowned && !mapOpen && !pauseOpen && !endVisible) {
      dom.interactPrompt.classList.remove('df-hidden');
      dom.interactText.textContent = snap.interactPrompt;
      const prog = snap.reviveChannelProgress || 0;
      if (prog > 0.01) {
        dom.interactBar.classList.remove('df-hidden');
        dom.interactFill.style.width = `${(clamp(prog, 0, 1) * 100).toFixed(0)}%`;
      } else {
        dom.interactBar.classList.add('df-hidden');
      }
    } else {
      dom.interactPrompt.classList.add('df-hidden');
    }

    // 9. Downed / Auto-Respawn / Takeover Overlay (yields cleanly when Tactical Map, Pause, or Endscreen is open)
    const showDowned = isDowned && !mapOpen && !pauseOpen && !endVisible;
    dom.downed.classList.toggle('df-hidden', !showDowned);
    if (showDowned) {
      const respawnTimer = snap.playerRespawnTimer != null
        ? snap.playerRespawnTimer
        : (gm.playerRespawnTimer != null ? gm.playerRespawnTimer : 0);
      const isRespawning = (playerState === 'dead' || ctrl === 'dead') || respawnTimer > 0.01;
      const bleed = Math.max(0, p.bleedTimer != null ? p.bleedTimer : 0);
      const frac = isRespawning ? clamp(respawnTimer / 4.0, 0, 1) : clamp(bleed / 18, 0, 1);

      dom.bleedArc.setAttribute('stroke-dashoffset', (150.8 * (1 - frac)).toFixed(1));
      dom.bleedArc.setAttribute('stroke', isRespawning ? '#e8a838' : '#e23b32');
      dom.bleedSec.textContent = isRespawning
        ? `${Math.max(0, respawnTimer).toFixed(1)}s`
        : `${Math.ceil(bleed)}s`;

      dom.downedTitle.textContent = isRespawning
        ? '准备重返战线 // 自动复活中'
        : '倒地重伤 // 等待救援或快速复活';

      const myTickets = playerFaction === 'UA' ? uaTix : ruTix;
      if ((p.reviveProgress || 0) > 0.01) {
        dom.downedMedic.textContent = `友军正在施救: ${Math.round(p.reviveProgress * 100)}% (救起不消耗兵力)`;
      } else if (isRespawning) {
        dom.downedMedic.textContent = `自动复活倒计时: ${Math.max(0, respawnTimer).toFixed(1)}s — 将在友军集结点满血部署`;
      } else if (p.medicDist != null && p.medicDist < 140) {
        dom.downedMedic.textContent = `友军正在赶来施救 (距离 ${p.medicDist.toFixed(1)}m) // 倒计时结束后自动复活`;
      } else {
        dom.downedMedic.textContent = '附近暂无友军接近 — 可立即接管友军或按 [F] 自动复活';
      }

      const friendlyAlive = playerFaction === 'UA'
        ? Math.max(0, uaAlive - (playerState === 'downed' ? 1 : 0))
        : Math.max(0, ruAlive - (playerState === 'downed' ? 1 : 0));
      dom.takeoverBtn.textContent = `[ SPACE ] 接管存活友军 (${friendlyAlive})`;
      dom.takeoverBtn.disabled = friendlyAlive <= 0;
      dom.takeoverBtn.classList.toggle('df-hidden', friendlyAlive <= 0);

      if (dom.respawnBtn) {
        const canRespawn = myTickets == null || myTickets > 0 || isRespawning;
        dom.respawnBtn.textContent = isRespawning
          ? `[ F ] 立即集结点复活 (${Math.max(0, respawnTimer).toFixed(1)}s)`
          : '[ F ] 跳过倒地 · 自动复活';
        dom.respawnBtn.disabled = !canRespawn;
        dom.respawnBtn.classList.toggle('primary', friendlyAlive <= 0);
      }
    }

    // 10. Live Interactive Tactical Map
    if (mapOpen) {
      renderTacticalMap(snap, safeDt);
    }
  }

  // ============================================================================
  // Initialization
  // ============================================================================
  function init(container, cb) {
    if (cb) callbacks = Object.assign({}, callbacks, cb);
    if (isInit) return;

    const host = container || document.getElementById('ui-layer') || document.body;
    root = document.getElementById('df-ui-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'df-ui-root';
      host.appendChild(root);
    }
    root.innerHTML = buildMarkup();

    dom.briefing = root.querySelector('#df-briefing');
    dom.briefQuality = root.querySelector('#df-brief-quality');
    dom.bSens = root.querySelector('#df-b-sens');
    dom.bSensVal = root.querySelector('#df-b-sens-val');
    dom.bMaster = root.querySelector('#df-b-master');
    dom.bMasterVal = root.querySelector('#df-b-master-val');
    dom.bSfx = root.querySelector('#df-b-sfx');
    dom.bSfxVal = root.querySelector('#df-b-sfx-val');
    dom.bMusic = root.querySelector('#df-b-music');
    dom.bMusicVal = root.querySelector('#df-b-music-val');
    dom.deployBtn = root.querySelector('#df-deploy-btn');

    dom.hud = root.querySelector('#df-hud');
    dom.iffCanvas = root.querySelector('#df-iff-canvas');
    dom.lowHpVig = root.querySelector('#df-lowhp-vignette');
    dom.minimapWrap = root.querySelector('#df-minimap-wrap');
    dom.minimapCanvas = root.querySelector('#df-minimap');
    dom.minimapGrid = root.querySelector('#df-minimap-grid');
    dom.minimapSec = root.querySelector('#df-minimap-sec');
    dom.compassCanvas = root.querySelector('#df-compass-canvas');
    dom.bearingTxt = root.querySelector('#df-bearing-txt');
    dom.uaCount = root.querySelector('#df-ua-count');
    dom.ruCount = root.querySelector('#df-ru-count');
    dom.uaTickets = root.querySelector('#df-ua-tickets');
    dom.ruTickets = root.querySelector('#df-ru-tickets');
    dom.sectorsRow = root.querySelector('#df-sectors-row');
    dom.matchTimer = root.querySelector('#df-match-timer');
    dom.killfeed = root.querySelector('#df-killfeed');
    dom.radioToast = root.querySelector('#df-radio-toast');
    dom.radioMsg = root.querySelector('#df-radio-msg');

    dom.opticLayer = root.querySelector('#df-optic-layer');
    dom.crosshair = root.querySelector('#df-crosshair');
    dom.chT = root.querySelector('#df-ch-t');
    dom.chB = root.querySelector('#df-ch-b');
    dom.chL = root.querySelector('#df-ch-l');
    dom.chR = root.querySelector('#df-ch-r');
    dom.hitmarker = root.querySelector('#df-hitmarker');
    dom.damageArc = root.querySelector('#df-damage-arc');

    dom.interactPrompt = root.querySelector('#df-interact-prompt');
    dom.interactText = root.querySelector('#df-interact-text');
    dom.interactBar = root.querySelector('#df-interact-bar');
    dom.interactFill = root.querySelector('#df-interact-fill');

    dom.squadList = root.querySelector('#df-squad-list');
    dom.hpNum = root.querySelector('#df-hp-num');
    dom.hpLabel = root.querySelector('#df-hp-label');
    dom.hpBar = root.querySelector('#df-hp-bar');
    dom.stanceBadge = root.querySelector('#df-stance-badge');
    dom.activeOrder = root.querySelector('#df-active-order');

    dom.wpnSvgWrap = root.querySelector('#df-wpn-svg-wrap');
    dom.ammoMag = root.querySelector('#df-ammo-mag');
    dom.ammoRes = root.querySelector('#df-ammo-res');
    dom.reloadRow = root.querySelector('#df-reload-row');
    dom.reloadStage = root.querySelector('#df-reload-stage');
    dom.reloadFill = root.querySelector('#df-reload-fill');
    dom.wpnName = root.querySelector('#df-wpn-name');
    dom.wpnCal = root.querySelector('#df-wpn-cal');
    dom.fireMode = root.querySelector('#df-firemode');
    dom.hotkeyRibbon = root.querySelector('#df-hotkey-ribbon');
    dom.hkDrone = root.querySelector('#df-hk-drone');
    dom.hkDog = root.querySelector('#df-hk-dog');
    dom.fragCnt = root.querySelector('#df-frag-cnt');
    dom.smokeCnt = root.querySelector('#df-smoke-cnt');

    dom.radial = root.querySelector('#df-radial');
    dom.radialHubTitle = root.querySelector('#df-radial-hub-title');

    dom.mapModal = root.querySelector('#df-map-modal');
    dom.mapCanvas = root.querySelector('#df-map-canvas');
    dom.mapOrders = root.querySelector('#df-map-orders');
    dom.mapClose = root.querySelector('#df-map-close');

    dom.downed = root.querySelector('#df-downed');
    dom.bleedArc = root.querySelector('#df-bleed-arc');
    dom.bleedSec = root.querySelector('#df-bleed-sec');
    dom.downedTitle = root.querySelector('#df-downed-title');
    dom.downedMedic = root.querySelector('#df-downed-medic');
    dom.takeoverBtn = root.querySelector('#df-takeover-btn');
    dom.respawnBtn = root.querySelector('#df-respawn-btn');

    dom.pause = root.querySelector('#df-pause');
    dom.pauseQuality = root.querySelector('#df-pause-quality');
    dom.pFps = root.querySelector('#df-p-fps');
    dom.pSens = root.querySelector('#df-p-sens');
    dom.pSensVal = root.querySelector('#df-p-sens-val');
    dom.pMaster = root.querySelector('#df-p-master');
    dom.pMasterVal = root.querySelector('#df-p-master-val');
    dom.pSfx = root.querySelector('#df-p-sfx');
    dom.pSfxVal = root.querySelector('#df-p-sfx-val');
    dom.pMusic = root.querySelector('#df-p-music');
    dom.pMusicVal = root.querySelector('#df-p-music-val');
    dom.pInvert = root.querySelector('#df-p-invert');
    dom.pResume = root.querySelector('#df-p-resume');
    dom.pSwitch = root.querySelector('#df-p-switch');
    dom.pRestart = root.querySelector('#df-p-restart');

    dom.endscreen = root.querySelector('#df-endscreen');
    dom.endBanner = root.querySelector('#df-end-banner');
    dom.endVerdict = root.querySelector('#df-end-verdict');
    dom.endReason = root.querySelector('#df-end-reason');
    dom.stKills = root.querySelector('#df-st-kills');
    dom.stHs = root.querySelector('#df-st-hs');
    dom.stVeh = root.querySelector('#df-st-veh');
    dom.stWalls = root.querySelector('#df-st-walls');
    dom.stRev = root.querySelector('#df-st-rev');
    dom.stSec = root.querySelector('#df-st-sec');
    dom.endRestart = root.querySelector('#df-end-restart');
    dom.endSwitch = root.querySelector('#df-end-switch');

    isInit = true;
    bindEvents();
    syncSettingsUI();
    if (hudHidden) root.classList.add('df-hud-hidden');
  }

  window.DF.UI = {
    init,
    setCallbacks: (cb) => { if (cb) callbacks = Object.assign({}, callbacks, cb); },
    update,
    setHidden,
    isHidden: () => hudHidden,
    showBriefing,
    isBriefingOpen: () => briefingVisible,
    openRadial,
    isRadialOpen: () => radialOpen,
    handleRadialMove,
    confirmRadial,
    toggleMap,
    isMapOpen: () => mapOpen,
    togglePause,
    isPauseOpen: () => pauseOpen,
    showNotification,
    addKillfeed,
    clearKillfeed,
    reset: () => resetMatchState(true),
    triggerHitmarker,
    triggerDamageIndicator,
    showEndScreen,
    hideEndScreen: () => {
      endVisible = false;
      if (dom.endscreen) dom.endscreen.classList.add('df-hidden');
    },
    getSettings: () => Object.assign({}, settings),
    setFaction
  };
})();
