(() => {
  'use strict';

  const DF = (window.DF = window.DF || {});

  // World dimensions & constants (strictly matching DESIGN.md)
  const WORLD_MIN_X = -90;
  const WORLD_MAX_X = 90;
  const WORLD_MIN_Z = -55;
  const WORLD_MAX_Z = 55;
  const PLAY_MIN_X = -89;
  const PLAY_MAX_X = 89;
  const PLAY_MIN_Z = -54;
  const PLAY_MAX_Z = 54;

  // Spatial hash for colliders (4m x 4m buckets)
  const HASH_CELL = 4.0;
  const INV_HASH_CELL = 1.0 / HASH_CELL;

  // Navigation grid (2m resolution: 90 x 55 cells x 3 elevation layers)
  const NAV_CELL = 2.0;
  const NAV_W = 90; // X: -90..+90
  const NAV_H = 55; // Z: -55..+55
  const NAV_LAYER_SIZE = NAV_W * NAV_H; // 4950
  const NAV_LAYERS = 3; // 0: Ground/Floor1, 1: Floor2 (3.85m), 2: Roof (7.45m)
  const NAV_TOTAL = NAV_LAYER_SIZE * NAV_LAYERS; // 14850

  // Collider storage
  const colliders = new Map();
  const spatialHash = new Map();
  let queryStamp = 1;

  // Terrain height callback (set by DF.Map so craters/terrain match rendered mesh exactly)
  let terrainHeightFn = () => 0.0;

  // Active smoke volumes (block AI vision & optional raycasts)
  const smokeVolumes = [];
  let simTime = 0;
  let lastWallClock = typeof performance !== 'undefined' ? performance.now() * 0.001 : 0;

  // Navigation grid typed arrays (zero-GC A*)
  const navWalkable = new Uint8Array(NAV_TOTAL);
  const navVehicle = new Uint8Array(NAV_LAYER_SIZE); // Ground layer only
  const navY = new Float32Array(NAV_TOTAL);
  const navCost = new Float32Array(NAV_TOTAL);
  const navLinks = new Map(); // nodeIdx -> Array<{ to, cost, waypoints }>
  const rawStairLinks = []; // stored stair links for persistence across rebuilds
  let navBuilt = false;

  // Reusable A* buffers
  const astarG = new Float32Array(NAV_TOTAL);
  const astarF = new Float32Array(NAV_TOTAL);
  const astarParent = new Int32Array(NAV_TOTAL);
  const astarOpenStamp = new Uint32Array(NAV_TOTAL);
  const astarClosedStamp = new Uint32Array(NAV_TOTAL);
  const heapNodes = new Int32Array(NAV_TOTAL);
  const heapPos = new Int32Array(NAV_TOTAL);
  let astarRunStamp = 1;

  // Tactical Cover Node graph
  const coverNodes = [];
  let nextCoverId = 1;

  // Math helpers (self-contained so physics has zero fragile dependencies)
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function hashKey(cx, cz) {
    return ((cx + 512) << 12) | ((cz + 512) & 0xfff);
  }

  function getClockTime() {
    if (typeof performance !== 'undefined') {
      const now = performance.now() * 0.001;
      const delta = Math.max(0, Math.min(0.25, now - lastWallClock));
      lastWallClock = now;
      simTime += delta;
    }
    return simTime;
  }

  function getTerrainHeight(x, z) {
    return terrainHeightFn(x, z);
  }

  // Evaluate exact walkable elevation of a stair collider at world (x, z)
  function getStairY(c, x, z) {
    const dir = c.stairDir || '+x';
    const y0 = c.stairY0;
    const y1 = c.stairY1;
    let t = 0;
    if (dir === '+x') {
      const span = Math.max(0.01, c.max[0] - c.min[0]);
      t = clamp((x - c.min[0]) / span, 0, 1);
    } else if (dir === '-x') {
      const span = Math.max(0.01, c.max[0] - c.min[0]);
      t = clamp((c.max[0] - x) / span, 0, 1);
    } else if (dir === '+z') {
      const span = Math.max(0.01, c.max[2] - c.min[2]);
      t = clamp((z - c.min[2]) / span, 0, 1);
    } else if (dir === '-z') {
      const span = Math.max(0.01, c.max[2] - c.min[2]);
      t = clamp((c.max[2] - z) / span, 0, 1);
    } else if (Array.isArray(dir)) {
      const dx = dir[0];
      const dz = dir[1];
      if (Math.abs(dx) >= Math.abs(dz)) {
        const span = Math.max(0.01, c.max[0] - c.min[0]);
        t = dx >= 0 ? clamp((x - c.min[0]) / span, 0, 1) : clamp((c.max[0] - x) / span, 0, 1);
      } else {
        const span = Math.max(0.01, c.max[2] - c.min[2]);
        t = dz >= 0 ? clamp((z - c.min[2]) / span, 0, 1) : clamp((c.max[2] - z) / span, 0, 1);
      }
    }
    return y0 + t * (y1 - y0);
  }

  function insertIntoHash(c) {
    const x0 = Math.floor(c.min[0] * INV_HASH_CELL);
    const x1 = Math.floor(c.max[0] * INV_HASH_CELL);
    const z0 = Math.floor(c.min[2] * INV_HASH_CELL);
    const z1 = Math.floor(c.max[2] * INV_HASH_CELL);
    c.cellMinX = x0;
    c.cellMaxX = x1;
    c.cellMinZ = z0;
    c.cellMaxZ = z1;
    c.cells.length = 0;

    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = hashKey(cx, cz);
        let bucket = spatialHash.get(k);
        if (!bucket) {
          bucket = [];
          spatialHash.set(k, bucket);
        }
        bucket.push(c);
        c.cells.push(k);
      }
    }
  }

  function removeFromHash(c) {
    const keys = c.cells;
    for (let i = 0; i < keys.length; i++) {
      const bucket = spatialHash.get(keys[i]);
      if (!bucket) continue;
      const idx = bucket.indexOf(c);
      if (idx !== -1) {
        const last = bucket.length - 1;
        if (idx !== last) bucket[idx] = bucket[last];
        bucket.pop();
        if (bucket.length === 0) spatialHash.delete(keys[i]);
      }
    }
    keys.length = 0;
  }

  function queryBoxColliders(minX, minZ, maxX, maxZ, outList) {
    outList.length = 0;
    const stamp = ++queryStamp;
    const x0 = Math.floor(minX * INV_HASH_CELL);
    const x1 = Math.floor(maxX * INV_HASH_CELL);
    const z0 = Math.floor(minZ * INV_HASH_CELL);
    const z1 = Math.floor(maxZ * INV_HASH_CELL);

    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const bucket = spatialHash.get(hashKey(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const c = bucket[i];
          if (c._stamp === stamp || !c.active) continue;
          c._stamp = stamp;
          if (c.max[0] < minX || c.min[0] > maxX || c.max[2] < minZ || c.min[2] > maxZ) {
            continue;
          }
          outList.push(c);
        }
      }
    }
    return outList;
  }

  // Reusable scratch lists to keep per-frame queries GC-free
  const _moveCandidates = [];
  const _groundCandidates = [];
  const _navCandidates = [];
  const _headroomCandidates = [];

  // Ray-AABB slab intersection; writes normal into outNormal, returns distance t >= 0 or -1
  function intersectRayAABB(ox, oy, oz, dx, dy, dz, min, max, maxDist, outNormal) {
    let tmin = 0.0;
    let tmax = maxDist;
    let nx = 0;
    let ny = 0;
    let nz = 0;

    // X slab
    if (Math.abs(dx) < 1e-8) {
      if (ox < min[0] || ox > max[0]) return -1;
    } else {
      const invD = 1.0 / dx;
      let t1 = (min[0] - ox) * invD;
      let t2 = (max[0] - ox) * invD;
      let sign = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        sign = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        nx = sign;
        ny = 0;
        nz = 0;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }

    // Y slab
    if (Math.abs(dy) < 1e-8) {
      if (oy < min[1] || oy > max[1]) return -1;
    } else {
      const invD = 1.0 / dy;
      let t1 = (min[1] - oy) * invD;
      let t2 = (max[1] - oy) * invD;
      let sign = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        sign = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        nx = 0;
        ny = sign;
        nz = 0;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }

    // Z slab
    if (Math.abs(dz) < 1e-8) {
      if (oz < min[2] || oz > max[2]) return -1;
    } else {
      const invD = 1.0 / dz;
      let t1 = (min[2] - oz) * invD;
      let t2 = (max[2] - oz) * invD;
      let sign = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        sign = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        nx = 0;
        ny = 0;
        nz = sign;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }

    if (tmin < 0 || tmin > maxDist) return -1;
    if (nx === 0 && ny === 0 && nz === 0) {
      // Ray started inside AABB
      nx = -dx;
      ny = -dy;
      nz = -dz;
    }
    outNormal[0] = nx;
    outNormal[1] = ny;
    outNormal[2] = nz;
    return tmin;
  }

  // Exact ray-wedge intersection for stairs so bullets pass through empty air above lower steps
  function intersectRayStair(ox, oy, oz, dx, dy, dz, c, maxDist, outNormal) {
    const tmpN = [0, 1, 0];
    const boxT = intersectRayAABB(ox, oy, oz, dx, dy, dz, c.min, c.max, maxDist, tmpN);
    if (boxT < 0) return -1;

    // Check if entry point on bounding box is already below the ramp surface (solid side/underside)
    const ex = ox + dx * boxT;
    const ey = oy + dy * boxT;
    const ez = oz + dz * boxT;
    const rampAtEntry = getStairY(c, ex, ez);
    if (ey <= rampAtEntry + 0.06) {
      outNormal[0] = tmpN[0];
      outNormal[1] = tmpN[1];
      outNormal[2] = tmpN[2];
      return boxT;
    }

    // Otherwise ray entered the empty air wedge above the ramp; intersect the sloped plane
    const dir = c.stairDir || '+x';
    const dySpan = c.stairY1 - c.stairY0;
    let pnx = 0;
    let pny = 1;
    let pnz = 0;
    let px0 = c.min[0];
    let py0 = c.stairY0;
    let pz0 = c.min[2];

    if (dir === '+x') {
      const span = Math.max(0.01, c.max[0] - c.min[0]);
      pnx = -dySpan / span;
      pny = 1;
      px0 = c.min[0];
    } else if (dir === '-x') {
      const span = Math.max(0.01, c.max[0] - c.min[0]);
      pnx = dySpan / span;
      pny = 1;
      px0 = c.max[0];
    } else if (dir === '+z') {
      const span = Math.max(0.01, c.max[2] - c.min[2]);
      pnz = -dySpan / span;
      pny = 1;
      pz0 = c.min[2];
    } else if (dir === '-z') {
      const span = Math.max(0.01, c.max[2] - c.min[2]);
      pnz = dySpan / span;
      pny = 1;
      pz0 = c.max[2];
    }

    const denom = dx * pnx + dy * pny + dz * pnz;
    if (Math.abs(denom) < 1e-6) return -1;
    const t = ((px0 - ox) * pnx + (py0 - oy) * pny + (pz0 - oz) * pnz) / denom;
    if (t < 0 || t > maxDist) return -1;

    const hx = ox + dx * t;
    const hy = oy + dy * t;
    const hz = oz + dz * t;
    if (
      hx < c.min[0] - 0.02 || hx > c.max[0] + 0.02 ||
      hz < c.min[2] - 0.02 || hz > c.max[2] + 0.02 ||
      hy < c.min[1] - 0.05 || hy > c.max[1] + 0.05
    ) {
      return -1;
    }
    const len = Math.hypot(pnx, pny, pnz) || 1;
    const flip = denom > 0 ? -1 : 1;
    outNormal[0] = (pnx / len) * flip;
    outNormal[1] = (pny / len) * flip;
    outNormal[2] = (pnz / len) * flip;
    return t;
  }

  function intersectRaySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxDist) {
    const mx = ox - cx;
    const my = oy - cy;
    const mz = oz - cz;
    const b = mx * dx + my * dy + mz * dz;
    const c = mx * mx + my * my + mz * mz - r * r;
    if (c > 0 && b > 0) return -1;
    const disc = b * b - c;
    if (disc < 0) return -1;
    let t = -b - Math.sqrt(disc);
    if (t < 0) t = 0;
    return t <= maxDist ? t : -1;
  }

  // Vertical cylinder intersection (finite Y range [y0, y1])
  function intersectRayCylinder(ox, oy, oz, dx, dy, dz, cx, y0, y1, cz, r, maxDist, outNormal) {
    const mx = ox - cx;
    const mz = oz - cz;
    const a = dx * dx + dz * dz;
    let bestT = -1;
    let bnx = 0, bny = 0, bnz = 0;

    if (a > 1e-8) {
      const b = mx * dx + mz * dz;
      const c = mx * mx + mz * mz - r * r;
      const disc = b * b - a * c;
      if (disc >= 0) {
        const s = Math.sqrt(disc);
        const t1 = (-b - s) / a;
        if (t1 >= 0 && t1 <= maxDist) {
          const hy = oy + dy * t1;
          if (hy >= y0 && hy <= y1) {
            bestT = t1;
            const hx = ox + dx * t1 - cx;
            const hz = oz + dz * t1 - cz;
            const invR = 1.0 / (r || 1);
            bnx = hx * invR;
            bny = 0;
            bnz = hz * invR;
          }
        }
      }
    }

    // Check top/bottom caps if ray has Y velocity
    if (Math.abs(dy) > 1e-6) {
      const tTop = (y1 - oy) / dy;
      if (tTop >= 0 && tTop <= maxDist && (bestT < 0 || tTop < bestT)) {
        const hx = ox + dx * tTop - cx;
        const hz = oz + dz * tTop - cz;
        if (hx * hx + hz * hz <= r * r) {
          bestT = tTop;
          bnx = 0; bny = 1; bnz = 0;
        }
      }
      const tBot = (y0 - oy) / dy;
      if (tBot >= 0 && tBot <= maxDist && (bestT < 0 || tBot < bestT)) {
        const hx = ox + dx * tBot - cx;
        const hz = oz + dz * tBot - cz;
        if (hx * hx + hz * hz <= r * r) {
          bestT = tBot;
          bnx = 0; bny = -1; bnz = 0;
        }
      }
    }

    if (bestT >= 0 && outNormal) {
      outNormal[0] = bnx;
      outNormal[1] = bny;
      outNormal[2] = bnz;
    }
    return bestT;
  }

  function pruneSmokeVolumes(now) {
    for (let i = smokeVolumes.length - 1; i >= 0; i--) {
      if (now >= smokeVolumes[i].expiresAt) {
        smokeVolumes.splice(i, 1);
      }
    }
  }

  function getSmokeEffectiveRadius(sv, now) {
    const elapsed = now - sv.createdAt;
    const remaining = sv.expiresAt - now;
    if (remaining <= 0) return 0;
    const grow = Math.min(1, elapsed / sv.growTime);
    const fade = Math.min(1, remaining / 2.2);
    return sv.maxRadius * (0.28 + 0.72 * grow) * (0.35 + 0.65 * fade);
  }

  // ---- Navigation Grid Helpers ----
  function worldToNavX(x) {
    return clamp(Math.floor((x - WORLD_MIN_X) / NAV_CELL), 0, NAV_W - 1);
  }
  function worldToNavZ(z) {
    return clamp(Math.floor((z - WORLD_MIN_Z) / NAV_CELL), 0, NAV_H - 1);
  }
  function navToWorldX(gx) {
    return WORLD_MIN_X + (gx + 0.5) * NAV_CELL;
  }
  function navToWorldZ(gz) {
    return WORLD_MIN_Z + (gz + 0.5) * NAV_CELL;
  }
  function navIndex(layer, gx, gz) {
    return layer * NAV_LAYER_SIZE + gz * NAV_W + gx;
  }
  function elevationToLayer(y) {
    if (y >= 5.8) return 2;
    if (y >= 2.2) return 1;
    return 0;
  }

  function isSolidBlockerAt(cx, cz, yBot, yTop, halfExtent, ignoreVehicles) {
    const list = queryBoxColliders(
      cx - halfExtent, cz - halfExtent,
      cx + halfExtent, cz + halfExtent,
      _navCandidates
    );
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.passableForMove) continue;
      if (c.type === 'stair' || c.type === 'ground') continue;
      if (ignoreVehicles && c.type === 'vehicle') continue;
      // Ignore floor slabs beneath feet or ceilings above head
      if (c.max[1] <= yBot + 0.42) continue;
      if (c.min[1] >= yTop) continue;
      return true;
    }
    return false;
  }

  function findLayerSupportY(cx, cz, layer) {
    const list = queryBoxColliders(cx - 0.35, cz - 0.35, cx + 0.35, cz + 0.35, _navCandidates);
    if (layer === 0) {
      let bestY = getTerrainHeight(cx, cz);
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.type === 'vehicle' || c.passableForMove) continue;
        if (c.type === 'stair') {
          const sy = getStairY(c, cx, cz);
          if (sy <= 1.2 && sy > bestY) bestY = sy;
        } else if (c.type === 'floor' || c.type === 'ground') {
          if (c.max[1] <= 1.2 && c.max[1] > bestY) bestY = c.max[1];
        }
      }
      return bestY;
    }

    // Upper layers require an actual supporting floor slab
    const minRef = layer === 1 ? 3.2 : 6.8;
    const maxRef = layer === 1 ? 4.4 : 8.1;
    let found = -999;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.type === 'floor' && c.max[1] >= minRef && c.max[1] <= maxRef) {
        if (c.max[1] > found) found = c.max[1];
      }
    }
    return found;
  }

  function evaluateNavCell(gx, gz) {
    const cx = navToWorldX(gx);
    const cz = navToWorldZ(gz);

    // Layer 0 (Ground / 1st floor)
    const idx0 = navIndex(0, gx, gz);
    if (cx < PLAY_MIN_X || cx > PLAY_MAX_X || cz < PLAY_MIN_Z || cz > PLAY_MAX_Z) {
      navWalkable[idx0] = 0;
      navVehicle[idx0] = 0;
      navY[idx0] = 0;
      navCost[idx0] = 10;
    } else {
      const y0 = findLayerSupportY(cx, cz, 0);
      navY[idx0] = y0;
      const blocked = isSolidBlockerAt(cx, cz, y0, y0 + 1.65, 0.45, true);
      navWalkable[idx0] = blocked ? 0 : 1;

      // Slight preference for roads/alleys vs deep rubble/interiors
      const absZ = Math.abs(cz);
      if (absZ <= 10.5) navCost[idx0] = 1.0;
      else if (absZ >= 34 && absZ <= 46) navCost[idx0] = 1.08;
      else navCost[idx0] = 1.25;
    }

    // Layer 1 (2nd floor, Y ~ 3.85)
    const idx1 = navIndex(1, gx, gz);
    const y1 = findLayerSupportY(cx, cz, 1);
    if (y1 > -900) {
      navY[idx1] = y1;
      const blocked1 = isSolidBlockerAt(cx, cz, y1, y1 + 1.65, 0.42, true);
      navWalkable[idx1] = blocked1 ? 0 : 1;
      navCost[idx1] = 1.2;
    } else {
      navWalkable[idx1] = 0;
      navY[idx1] = 3.85;
      navCost[idx1] = 10;
    }

    // Layer 2 (Roof deck, Y ~ 7.45)
    const idx2 = navIndex(2, gx, gz);
    const y2 = findLayerSupportY(cx, cz, 2);
    if (y2 > -900) {
      navY[idx2] = y2;
      const blocked2 = isSolidBlockerAt(cx, cz, y2, y2 + 1.65, 0.42, true);
      navWalkable[idx2] = blocked2 ? 0 : 1;
      navCost[idx2] = 1.25;
    } else {
      navWalkable[idx2] = 0;
      navY[idx2] = 7.45;
      navCost[idx2] = 10;
    }
  }

  function evaluateVehicleClearance(gx, gz) {
    const idx0 = gz * NAV_W + gx;
    if (!navWalkable[idx0]) {
      navVehicle[idx0] = 0;
      return;
    }
    const cx = navToWorldX(gx);
    const cz = navToWorldZ(gz);
    // Vehicles stay outdoors (floor height near street level < 0.22m, no indoor ceilings)
    if (navY[idx0] > 0.20) {
      navVehicle[idx0] = 0;
      return;
    }
    // Check 3x3 walkable neighborhood and 1.75m half-width clear of solid walls/buildings
    if (gx <= 0 || gx >= NAV_W - 1 || gz <= 0 || gz >= NAV_H - 1) {
      navVehicle[idx0] = 0;
      return;
    }
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nIdx = (gz + dz) * NAV_W + (gx + dx);
        if (!navWalkable[nIdx] || navY[nIdx] > 0.20) {
          navVehicle[idx0] = 0;
          return;
        }
      }
    }
    const blockedWide = isSolidBlockerAt(cx, cz, navY[idx0], navY[idx0] + 2.6, 1.55, true);
    navVehicle[idx0] = blockedWide ? 0 : 1;
  }

  function rebuildStairNavLinks() {
    navLinks.clear();

    const addEdge = (fromIdx, toIdx, cost, waypoints) => {
      let arr = navLinks.get(fromIdx);
      if (!arr) {
        arr = [];
        navLinks.set(fromIdx, arr);
      }
      arr.push({ to: toIdx, cost, waypoints });
    };

    // Auto-derive links from all stair colliders
    colliders.forEach((c) => {
      if (!c.active || c.type !== 'stair') return;
      const dir = c.stairDir || '+x';
      const midX = (c.min[0] + c.max[0]) * 0.5;
      const midZ = (c.min[2] + c.max[2]) * 0.5;
      const midY = (c.stairY0 + c.stairY1) * 0.5;
      let bx = midX, bz = midZ, tx = midX, tz = midZ;

      if (dir === '+x') {
        bx = c.min[0] - 0.9;
        tx = c.max[0] + 0.9;
      } else if (dir === '-x') {
        bx = c.max[0] + 0.9;
        tx = c.min[0] - 0.9;
      } else if (dir === '+z') {
        bz = c.min[2] - 0.9;
        tz = c.max[2] + 0.9;
      } else if (dir === '-z') {
        bz = c.max[2] + 0.9;
        tz = c.min[2] - 0.9;
      }

      const l0 = elevationToLayer(c.stairY0);
      const l1 = elevationToLayer(c.stairY1);
      const gx0 = worldToNavX(bx), gz0 = worldToNavZ(bz);
      const gx1 = worldToNavX(tx), gz1 = worldToNavZ(tz);
      const idxA = navIndex(l0, gx0, gz0);
      const idxB = navIndex(l1, gx1, gz1);

      // Ensure landing cells are marked walkable
      navWalkable[idxA] = 1;
      navY[idxA] = c.stairY0;
      navWalkable[idxB] = 1;
      navY[idxB] = c.stairY1;

      const dist = Math.hypot(tx - bx, c.stairY1 - c.stairY0, tz - bz) * 1.15;
      const pEntry = [bx, c.stairY0, bz];
      const pMid1 = [bx * 0.65 + tx * 0.35, c.stairY0 * 0.65 + c.stairY1 * 0.35, bz * 0.65 + tz * 0.35];
      const pMid2 = [bx * 0.35 + tx * 0.65, c.stairY0 * 0.35 + c.stairY1 * 0.65, bz * 0.35 + tz * 0.65];
      const pExit = [tx, c.stairY1, tz];

      addEdge(idxA, idxB, dist, [pEntry, pMid1, pMid2, pExit]);
      addEdge(idxB, idxA, dist, [pExit, pMid2, pMid1, pEntry]);
    });

    // Manual explicit nav links
    for (let i = 0; i < rawStairLinks.length; i++) {
      const ln = rawStairLinks[i];
      const lA = elevationToLayer(ln.from[1]);
      const lB = elevationToLayer(ln.to[1]);
      const idxA = navIndex(lA, worldToNavX(ln.from[0]), worldToNavZ(ln.from[2]));
      const idxB = navIndex(lB, worldToNavX(ln.to[0]), worldToNavZ(ln.to[2]));
      const dist = Math.hypot(ln.to[0] - ln.from[0], ln.to[1] - ln.from[1], ln.to[2] - ln.from[2]) * 1.15;
      const wps = ln.waypoints || [ln.from, ln.to];
      addEdge(idxA, idxB, dist, wps);
      if (ln.bidirectional !== false) {
        addEdge(idxB, idxA, dist, wps.slice().reverse());
      }
    }
  }

  function findNearestWalkableNode(wx, wz, layer, isVehicle) {
    const gx0 = worldToNavX(wx);
    const gz0 = worldToNavZ(wz);
    const check = (gx, gz) => {
      if (gx < 0 || gx >= NAV_W || gz < 0 || gz >= NAV_H) return -1;
      const idx = navIndex(layer, gx, gz);
      if (isVehicle) return navVehicle[idx] ? idx : -1;
      return navWalkable[idx] ? idx : -1;
    };

    const direct = check(gx0, gz0);
    if (direct !== -1) return direct;

    for (let r = 1; r <= 6; r++) {
      let bestIdx = -1;
      let bestD2 = Infinity;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const idx = check(gx0 + dx, gz0 + dz);
          if (idx !== -1) {
            const cx = navToWorldX(gx0 + dx);
            const cz = navToWorldZ(gz0 + dz);
            const d2 = (cx - wx) * (cx - wx) + (cz - wz) * (cz - wz);
            if (d2 < bestD2) {
              bestD2 = d2;
              bestIdx = idx;
            }
          }
        }
      }
      if (bestIdx !== -1) return bestIdx;
    }
    return -1;
  }

  // Min-heap operations for A*
  let heapSize = 0;
  function heapReset() {
    heapSize = 0;
  }
  function heapSwap(a, b) {
    const na = heapNodes[a];
    const nb = heapNodes[b];
    heapNodes[a] = nb;
    heapNodes[b] = na;
    heapPos[nb] = a;
    heapPos[na] = b;
  }
  function heapPush(node) {
    let i = heapSize++;
    heapNodes[i] = node;
    heapPos[node] = i;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (astarF[heapNodes[i]] < astarF[heapNodes[p]]) {
        heapSwap(i, p);
        i = p;
      } else {
        break;
      }
    }
  }
  function heapDecrease(node) {
    let i = heapPos[node];
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (astarF[heapNodes[i]] < astarF[heapNodes[p]]) {
        heapSwap(i, p);
        i = p;
      } else {
        break;
      }
    }
  }
  function heapPop() {
    const top = heapNodes[0];
    heapSize--;
    if (heapSize > 0) {
      const last = heapNodes[heapSize];
      heapNodes[0] = last;
      heapPos[last] = 0;
      let i = 0;
      while (true) {
        const l = (i << 1) + 1;
        const r = l + 1;
        let smallest = i;
        if (l < heapSize && astarF[heapNodes[l]] < astarF[heapNodes[smallest]]) smallest = l;
        if (r < heapSize && astarF[heapNodes[r]] < astarF[heapNodes[smallest]]) smallest = r;
        if (smallest !== i) {
          heapSwap(i, smallest);
          i = smallest;
        } else {
          break;
        }
      }
    }
    return top;
  }

  // 8-direction offsets (cardinals first, diagonals last)
  const DIR_X = [1, -1, 0, 0, 1, 1, -1, -1];
  const DIR_Z = [0, 0, 1, -1, 1, -1, 1, -1];
  const DIR_DIST = [2.0, 2.0, 2.0, 2.0, 2.828427, 2.828427, 2.828427, 2.828427];

  // ---- Public API: DF.Physics ----
  const Physics = {
    WORLD_BOUNDS: {
      minX: WORLD_MIN_X, maxX: WORLD_MAX_X,
      minZ: WORLD_MIN_Z, maxZ: WORLD_MAX_Z,
      playMinX: PLAY_MIN_X, playMaxX: PLAY_MAX_X,
      playMinZ: PLAY_MIN_Z, playMaxZ: PLAY_MAX_Z
    },

    init() {
      colliders.clear();
      spatialHash.clear();
      smokeVolumes.length = 0;
      coverNodes.length = 0;
      navLinks.clear();
      rawStairLinks.length = 0;
      navWalkable.fill(0);
      navVehicle.fill(0);
      navY.fill(0);
      navCost.fill(1);
      navBuilt = false;
      nextCoverId = 1;
      queryStamp = 1;
      astarRunStamp = 1;
      terrainHeightFn = () => 0.0;
      simTime = 0;
      lastWallClock = typeof performance !== 'undefined' ? performance.now() * 0.001 : 0;
    },

    setTerrainHeightFn(fn) {
      terrainHeightFn = typeof fn === 'function' ? fn : () => 0.0;
    },

    getTerrainHeight(x, z) {
      return getTerrainHeight(x, z);
    },

    addCollider(id, min, max, meta) {
      if (colliders.has(id)) {
        Physics.removeCollider(id);
      }
      const m = meta || {};
      const cMin = [
        Math.min(min[0], max[0]),
        Math.min(min[1], max[1]),
        Math.min(min[2], max[2])
      ];
      const cMax = [
        Math.max(min[0], max[0]),
        Math.max(min[1], max[1]),
        Math.max(min[2], max[2])
      ];
      const c = {
        id,
        min: cMin,
        max: cMax,
        type: m.type || 'wall',
        material: m.material || 'concrete',
        destructibleId: m.destructibleId || null,
        passableForBullets: !!m.passableForBullets,
        passableForMove: !!m.passableForMove,
        stairDir: m.stairDir || null,
        stairY0: m.stairY0 !== undefined ? m.stairY0 : cMin[1],
        stairY1: m.stairY1 !== undefined ? m.stairY1 : cMax[1],
        vehicleId: m.vehicleId || null,
        vehicleRef: m.vehicleRef || null,
        meta: m,
        active: true,
        cells: [],
        cellMinX: 0, cellMaxX: 0, cellMinZ: 0, cellMaxZ: 0,
        _stamp: 0
      };
      colliders.set(id, c);
      insertIntoHash(c);
      return c;
    },

    removeCollider(id) {
      const c = colliders.get(id);
      if (!c) return false;
      c.active = false;
      removeFromHash(c);
      colliders.delete(id);
      return true;
    },

    updateCollider(id, min, max, metaPatch) {
      const c = colliders.get(id);
      if (!c) return null;
      c.min[0] = Math.min(min[0], max[0]);
      c.min[1] = Math.min(min[1], max[1]);
      c.min[2] = Math.min(min[2], max[2]);
      c.max[0] = Math.max(min[0], max[0]);
      c.max[1] = Math.max(min[1], max[1]);
      c.max[2] = Math.max(min[2], max[2]);
      if (metaPatch) {
        if (metaPatch.type !== undefined) c.type = metaPatch.type;
        if (metaPatch.material !== undefined) c.material = metaPatch.material;
        if (metaPatch.passableForBullets !== undefined) c.passableForBullets = !!metaPatch.passableForBullets;
        if (metaPatch.passableForMove !== undefined) c.passableForMove = !!metaPatch.passableForMove;
      }
      const x0 = Math.floor(c.min[0] * INV_HASH_CELL);
      const x1 = Math.floor(c.max[0] * INV_HASH_CELL);
      const z0 = Math.floor(c.min[2] * INV_HASH_CELL);
      const z1 = Math.floor(c.max[2] * INV_HASH_CELL);
      if (x0 !== c.cellMinX || x1 !== c.cellMaxX || z0 !== c.cellMinZ || z1 !== c.cellMaxZ) {
        removeFromHash(c);
        insertIntoHash(c);
      }
      return c;
    },

    getCollider(id) {
      return colliders.get(id) || null;
    },

    getAllColliders() {
      return Array.from(colliders.values());
    },

    getGroundY(x, z, refY, opts) {
      const ry = refY === undefined ? 10.0 : refY;
      const ignoreTypes = opts && opts.ignoreTypes ? opts.ignoreTypes : null;
      const ignoreLowDebris = !!(opts && opts.ignoreLowDebris);
      const maxStep = opts && opts.maxStep !== undefined ? opts.maxStep : 0.62;
      let bestY = getTerrainHeight(x, z);
      const list = queryBoxColliders(x - 0.05, z - 0.05, x + 0.05, z + 0.05, _groundCandidates);

      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.passableForMove || c.type === 'vehicle') continue;
        if (ignoreTypes && ignoreTypes.indexOf(c.type) !== -1) continue;
        if (ignoreLowDebris && (c.type === 'cover' || c.type === 'destructible') && (c.max[1] - c.min[1]) < 0.45) continue;
        if (x < c.min[0] - 0.02 || x > c.max[0] + 0.02 || z < c.min[2] - 0.02 || z > c.max[2] + 0.02) {
          continue;
        }
        let surfaceY;
        if (c.type === 'stair') {
          surfaceY = getStairY(c, x, z);
        } else {
          surfaceY = c.max[1];
        }
        if (surfaceY <= ry + maxStep && surfaceY > bestY) {
          bestY = surfaceY;
        }
      }
      return bestY;
    },

    moveCapsule(pos, vel, radius, height, dt, opts) {
      const o = opts || {};
      const r = radius > 0 ? radius : 0.35;
      const h = height > 0 ? height : 1.75;
      const safeDt = Math.min(Math.max(dt || 0, 0), 0.1);
      const stepH = o.stepHeight !== undefined ? o.stepHeight : 0.6;
      // main.js applies gravity before moveCapsule when isPlayer=true; avoid double gravity
      const gravity = o.gravity !== undefined ? o.gravity : (o.isPlayer ? 0.0 : 18.0);
      const ignoreIds = o.ignoreIds || (o.ignoreId ? [o.ignoreId] : null);
      const ignoreTypes = o.ignoreTypes || null;
      const clampBounds = o.clampBounds !== false;

      if (safeDt <= 0) {
        const fy = Physics.getGroundY(pos[0], pos[2], pos[1]);
        return { grounded: pos[1] <= fy + 0.05, floorY: fy, hitWall: false };
      }

      // Check initial grounded status for smooth downward stair/slope snapping
      const initialFloorY = Physics.getGroundY(pos[0], pos[2], pos[1]);
      let wasGrounded = pos[1] <= initialFloorY + 0.08 && vel[1] <= 0.15;

      if (!o.noGravity && gravity > 0) {
        vel[1] = Math.max(-36, vel[1] - gravity * safeDt);
      }

      const disp = Math.hypot(vel[0] * safeDt, vel[1] * safeDt, vel[2] * safeDt);
      const steps = Math.min(4, Math.max(1, Math.ceil(disp / Math.max(0.18, r * 0.65))));
      const subDt = safeDt / steps;

      let hitWall = false;
      let grounded = false;
      let finalFloorY = initialFloorY;

      for (let s = 0; s < steps; s++) {
        const prevY = pos[1];

        // 1. Advance XZ
        pos[0] += vel[0] * subDt;
        pos[2] += vel[2] * subDt;

        // 2. Gather nearby colliders once per substep
        const pad = r + 0.45;
        const cands = queryBoxColliders(pos[0] - pad, pos[2] - pad, pos[0] + pad, pos[2] + pad, _moveCandidates);

        // Detect active stair ride early so floor slabs framing the stairwell never snag or head-clip
        let activeStair = null;
        let activeStairRampY = -1e9;
        for (let i = 0; i < cands.length; i++) {
          const sc = cands[i];
          if (sc.type !== 'stair' || sc.passableForMove) continue;
          if (ignoreIds && ignoreIds.indexOf(sc.id) !== -1) continue;
          if (ignoreTypes && ignoreTypes.indexOf(sc.type) !== -1) continue;
          const sqx = clamp(pos[0], sc.min[0], sc.max[0]);
          const sqz = clamp(pos[2], sc.min[2], sc.max[2]);
          const sd2 = (pos[0] - sqx) * (pos[0] - sqx) + (pos[2] - sqz) * (pos[2] - sqz);
          if (sd2 <= (r + 0.14) * (r + 0.14)) {
            const ry = getStairY(sc, pos[0], pos[2]);
            if (ry <= pos[1] + stepH + 0.22 && pos[1] >= sc.min[1] - 0.55 && pos[1] <= sc.max[1] + 0.40) {
              if (!activeStair || ry > activeStairRampY) {
                activeStair = sc;
                activeStairRampY = ry;
              }
            }
          }
        }

        let stepTargetY = activeStair && activeStairRampY > pos[1] ? activeStairRampY : -1e9;

        // 3. Iterative horizontal circle-vs-AABB resolution (3 passes for crisp corners)
        for (let iter = 0; iter < 3; iter++) {
          for (let i = 0; i < cands.length; i++) {
            const c = cands[i];
            if (c.passableForMove) continue;
            if (ignoreIds && ignoreIds.indexOf(c.id) !== -1) continue;
            if (ignoreTypes && ignoreTypes.indexOf(c.type) !== -1) continue;

            // Quick circle-AABB XZ overlap check
            const qx = clamp(pos[0], c.min[0], c.max[0]);
            const qz = clamp(pos[2], c.min[2], c.max[2]);
            const dx = pos[0] - qx;
            const dz = pos[2] - qz;
            const d2 = dx * dx + dz * dz;
            if (d2 >= r * r) continue;

            // Special handling for stairs: walkable inclined ramp
            if (c.type === 'stair') {
              const rampY = getStairY(c, pos[0], pos[2]);
              // Approaching from top/bottom or riding the stair smoothly
              if (rampY <= pos[1] + stepH + 0.18 && pos[1] >= c.min[1] - 0.50) {
                if (rampY > stepTargetY) stepTargetY = rampY;
                continue;
              }
              // Completely above stair
              if (pos[1] >= c.max[1] - 0.05) continue;
              // Completely below underside
              if (pos[1] + h <= c.min[1] + 0.05) continue;
              // Otherwise colliding with tall side/underside of stairs -> push horizontally below
            } else {
              // While riding a staircase, never let the destination upper landing slab snag the capsule horizontally
              if (
                activeStair &&
                c.type === 'floor' &&
                Math.abs(c.max[1] - activeStair.stairY1) < 0.22
              ) {
                if (c.max[1] <= Math.max(pos[1], activeStairRampY) + stepH + 0.18) {
                  if (c.max[1] > stepTargetY && activeStairRampY >= activeStair.stairY1 - 0.55) {
                    stepTargetY = c.max[1];
                  }
                  continue;
                }
                // Also skip rim snagging when head clears the expanded stairwell cutout
                continue;
              }

              // Vertical separation check
              if (c.max[1] <= pos[1] + 0.02 || c.min[1] >= pos[1] + h - 0.02) continue;

              // Check step-up (curbs, rubble, floor thresholds up to stepH)
              if (c.max[1] > pos[1] && c.max[1] <= pos[1] + stepH) {
                // Verify headroom above c.max[1] so we don't step into a low ceiling
                const hrCands = queryBoxColliders(pos[0] - r * 0.7, pos[2] - r * 0.7, pos[0] + r * 0.7, pos[2] + r * 0.7, _headroomCandidates);
                let clear = true;
                for (let k = 0; k < hrCands.length; k++) {
                  const hc = hrCands[k];
                  if (hc === c || hc.passableForMove || hc.type === 'stair') continue;
                  if (ignoreIds && ignoreIds.indexOf(hc.id) !== -1) continue;
                  if (ignoreTypes && ignoreTypes.indexOf(hc.type) !== -1) continue;
                  if (hc.min[1] < c.max[1] + h - 0.05 && hc.max[1] > c.max[1] + 0.08) {
                    clear = false;
                    break;
                  }
                }
                if (clear) {
                  if (c.max[1] > stepTargetY) stepTargetY = c.max[1];
                  continue;
                }
              }
            }

            // Solid horizontal pushout
            hitWall = true;
            if (d2 > 1e-8) {
              const dist = Math.sqrt(d2);
              const nx = dx / dist;
              const nz = dz / dist;
              const pen = r - dist;
              pos[0] += nx * pen;
              pos[2] += nz * pen;
              const vn = vel[0] * nx + vel[2] * nz;
              if (vn < 0) {
                vel[0] -= vn * nx;
                vel[2] -= vn * nz;
              }
            } else {
              // Capsule center inside AABB: eject along shallowest axis
              const dl = Math.abs(pos[0] - c.min[0]);
              const dr = Math.abs(c.max[0] - pos[0]);
              const db = Math.abs(pos[2] - c.min[2]);
              const df = Math.abs(c.max[2] - pos[2]);
              const m = Math.min(dl, dr, db, df);
              if (m === dl) {
                pos[0] = c.min[0] - r;
                if (vel[0] > 0) vel[0] = 0;
              } else if (m === dr) {
                pos[0] = c.max[0] + r;
                if (vel[0] < 0) vel[0] = 0;
              } else if (m === db) {
                pos[2] = c.min[2] - r;
                if (vel[2] > 0) vel[2] = 0;
              } else {
                pos[2] = c.max[2] + r;
                if (vel[2] < 0) vel[2] = 0;
              }
            }
          }
        }

        // 4. Vertical movement & exact supporting surface check
        pos[1] += vel[1] * subDt;
        if (stepTargetY > pos[1]) {
          pos[1] = stepTargetY;
        }

        let supportY = getTerrainHeight(pos[0], pos[2]);
        if (stepTargetY > supportY) {
          supportY = stepTargetY;
        }
        const footR = r * 0.78;
        const maxAcceptY = Math.max(prevY, pos[1]) + stepH + 0.14;

        for (let i = 0; i < cands.length; i++) {
          const c = cands[i];
          if (c.passableForMove || c.type === 'vehicle') continue;
          if (ignoreIds && ignoreIds.indexOf(c.id) !== -1) continue;
          if (ignoreTypes && ignoreTypes.indexOf(c.type) !== -1) continue;

          const qx = clamp(pos[0], c.min[0], c.max[0]);
          const qz = clamp(pos[2], c.min[2], c.max[2]);
          const d2 = (pos[0] - qx) * (pos[0] - qx) + (pos[2] - qz) * (pos[2] - qz);
          // Use full capsule radius when stepping onto/off an active staircase's upper landing slab so toes never dip into the lip!
          const isStairTopSlab = activeStair && c.type === 'floor' && Math.abs(c.max[1] - activeStair.stairY1) < 0.22;
          const checkR = isStairTopSlab ? r : footR;
          if (d2 > checkR * checkR) continue;

          let sy;
          if (c.type === 'stair') {
            // Sample at capsule center clamped along stair run for smooth continuous ascent/descent
            sy = getStairY(c, pos[0], pos[2]);
          } else {
            sy = c.max[1];
          }
          if (sy <= maxAcceptY && sy > supportY) {
            supportY = sy;
          }
        }

        // Floor landing & smooth downward stair/ramp snap (generous snap on stairs so sprinting down never bounces!)
        const downSnapLimit = activeStair ? 0.65 : 0.48;
        if (pos[1] <= supportY + 0.005) {
          pos[1] = supportY;
          if (vel[1] < 0) vel[1] = 0;
          grounded = true;
        } else if (wasGrounded && vel[1] <= 0.15 && (pos[1] - supportY) <= downSnapLimit) {
          pos[1] = supportY;
          vel[1] = 0;
          grounded = true;
        } else {
          grounded = false;
        }

        // Ceiling collision check (skip stairwell destination floor slab edge while actively riding stairs)
        const headR = r * 0.72;
        for (let i = 0; i < cands.length; i++) {
          const c = cands[i];
          if (c.passableForMove || c.type === 'stair') continue;
          if (ignoreIds && ignoreIds.indexOf(c.id) !== -1) continue;
          if (ignoreTypes && ignoreTypes.indexOf(c.type) !== -1) continue;
          if (activeStair && c.type === 'floor' && Math.abs(c.max[1] - activeStair.stairY1) < 0.25) continue;
          const qx = clamp(pos[0], c.min[0], c.max[0]);
          const qz = clamp(pos[2], c.min[2], c.max[2]);
          if ((pos[0] - qx) * (pos[0] - qx) + (pos[2] - qz) * (pos[2] - qz) > headR * headR) continue;
          if (c.min[1] < pos[1] + h && c.min[1] >= prevY + h * 0.45 && c.max[1] > pos[1] + h * 0.5) {
            pos[1] = Math.min(pos[1], c.min[1] - h);
            if (vel[1] > 0) vel[1] = 0;
          }
        }

        // 5. Playable boundary clamping [-89..89, -54..54]
        if (clampBounds) {
          if (pos[0] < PLAY_MIN_X + r) {
            pos[0] = PLAY_MIN_X + r;
            if (vel[0] < 0) vel[0] = 0;
            hitWall = true;
          } else if (pos[0] > PLAY_MAX_X - r) {
            pos[0] = PLAY_MAX_X - r;
            if (vel[0] > 0) vel[0] = 0;
            hitWall = true;
          }
          if (pos[2] < PLAY_MIN_Z + r) {
            pos[2] = PLAY_MIN_Z + r;
            if (vel[2] < 0) vel[2] = 0;
            hitWall = true;
          } else if (pos[2] > PLAY_MAX_Z - r) {
            pos[2] = PLAY_MAX_Z - r;
            if (vel[2] > 0) vel[2] = 0;
            hitWall = true;
          }
        }

        wasGrounded = grounded;
        finalFloorY = supportY;
      }

      return { grounded, floorY: finalFloorY, hitWall };
    },

    raycast(origin, dir, maxDist, opts) {
      const o = opts || {};
      const maxD = maxDist > 0 ? maxDist : 300;
      const dLen = Math.hypot(dir[0], dir[1], dir[2]);
      if (dLen < 1e-8) return null;
      const dx = dir[0] / dLen;
      const dy = dir[1] / dLen;
      const dz = dir[2] / dLen;
      const ox = origin[0];
      const oy = origin[1];
      const oz = origin[2];

      const ignoreIds = o.ignoreIds || null;
      const ignoreTypes = o.ignoreTypes || null;
      const forBullets = o.forBullets !== false;
      const checkVehicles = !!o.checkVehicles;
      const checkEntities = !!o.checkEntities;
      const ignoreFaction = o.ignoreFaction || null;
      const ignoreEntityId = o.ignoreEntityId || null;

      let bestDist = maxD;
      let hitResult = null;
      const tmpNormal = [0, 1, 0];

      // 1. Optional smoke volume hit
      if (o.hitSmoke && smokeVolumes.length > 0) {
        const now = getClockTime();
        pruneSmokeVolumes(now);
        for (let i = 0; i < smokeVolumes.length; i++) {
          const sv = smokeVolumes[i];
          const sr = getSmokeEffectiveRadius(sv, now);
          if (sr <= 0.1) continue;
          const t = intersectRaySphere(ox, oy, oz, dx, dy, dz, sv.pos[0], sv.pos[1], sv.pos[2], sr, bestDist);
          if (t >= 0 && t < bestDist) {
            bestDist = t;
            const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
            const nx = px - sv.pos[0], ny = py - sv.pos[1], nz = pz - sv.pos[2];
            const nl = Math.hypot(nx, ny, nz) || 1;
            hitResult = {
              dist: t,
              point: [px, py, pz],
              normal: [nx / nl, ny / nl, nz / nl],
              collider: null,
              entity: null,
              vehicle: null,
              material: 'smoke',
              hitZone: null
            };
          }
        }
      }

      // 2. Fast 2D DDA spatial-hash traversal for world colliders
      const stamp = ++queryStamp;
      let cellX = Math.floor(ox * INV_HASH_CELL);
      let cellZ = Math.floor(oz * INV_HASH_CELL);
      const stepX = dx >= 0 ? 1 : -1;
      const stepZ = dz >= 0 ? 1 : -1;

      const tDeltaX = Math.abs(dx) > 1e-8 ? Math.abs(HASH_CELL / dx) : 1e30;
      const tDeltaZ = Math.abs(dz) > 1e-8 ? Math.abs(HASH_CELL / dz) : 1e30;

      const nextBoundX = (cellX + (dx >= 0 ? 1 : 0)) * HASH_CELL;
      const nextBoundZ = (cellZ + (dz >= 0 ? 1 : 0)) * HASH_CELL;
      let tMaxX = Math.abs(dx) > 1e-8 ? (nextBoundX - ox) / dx : 1e30;
      let tMaxZ = Math.abs(dz) > 1e-8 ? (nextBoundZ - oz) / dz : 1e30;

      let tTraversed = 0;
      const maxSteps = 220;

      for (let step = 0; step < maxSteps; step++) {
        const bucket = spatialHash.get(hashKey(cellX, cellZ));
        if (bucket) {
          for (let i = 0; i < bucket.length; i++) {
            const c = bucket[i];
            if (c._stamp === stamp || !c.active) continue;
            c._stamp = stamp;
            if (forBullets && c.passableForBullets) continue;
            if (checkVehicles && c.type === 'vehicle') continue; // Handled via directional OBB below
            if (ignoreIds && ignoreIds.indexOf(c.id) !== -1) continue;
            if (ignoreTypes && ignoreTypes.indexOf(c.type) !== -1) continue;

            const t = c.type === 'stair'
              ? intersectRayStair(ox, oy, oz, dx, dy, dz, c, bestDist, tmpNormal)
              : intersectRayAABB(ox, oy, oz, dx, dy, dz, c.min, c.max, bestDist, tmpNormal);

            if (t >= 0 && t < bestDist) {
              bestDist = t;
              hitResult = {
                dist: t,
                point: [ox + dx * t, oy + dy * t, oz + dz * t],
                normal: [tmpNormal[0], tmpNormal[1], tmpNormal[2]],
                collider: c,
                entity: null,
                vehicle: c.vehicleRef || null,
                material: c.material,
                hitZone: null
              };
            }
          }
        }

        // Advance DDA cell
        if (tMaxX < tMaxZ) {
          tTraversed = tMaxX;
          if (tTraversed > bestDist) break;
          cellX += stepX;
          tMaxX += tDeltaX;
        } else {
          tTraversed = tMaxZ;
          if (tTraversed > bestDist) break;
          cellZ += stepZ;
          tMaxZ += tDeltaZ;
        }
      }

      // 3. Terrain / crater ground intersection (for open ground / craters below Y=0.25)
      if (!ignoreTypes || ignoreTypes.indexOf('ground') === -1) {
        if (dy < -1e-5 || oy < 0.35) {
          // Intersect bounding top plane Y = 0.35 to start marching near ground
          let tStart = 0;
          if (oy > 0.35 && dy < -1e-5) {
            tStart = (0.35 - oy) / dy;
          }
          if (tStart >= 0 && tStart < bestDist) {
            // Coarse-to-fine ground hit along ray segment
            let tEnd = bestDist;
            if (dy < -1e-5) {
              const tLow = (-1.0 - oy) / dy;
              if (tLow > tStart && tLow < tEnd) tEnd = tLow;
            } else {
              tEnd = Math.min(bestDist, tStart + 24);
            }

            const stepsG = 12;
            const dtG = (tEnd - tStart) / stepsG;
            let prevT = tStart;
            let prevDiff = (oy + dy * prevT) - getTerrainHeight(ox + dx * prevT, oz + dz * prevT);

            if (prevDiff <= 0 && tStart > 0) {
              // Hit raised berm right at tStart
              bestDist = tStart;
              const px = ox + dx * tStart, pz = oz + dz * tStart;
              hitResult = {
                dist: tStart,
                point: [px, getTerrainHeight(px, pz), pz],
                normal: [0, 1, 0],
                collider: null,
                entity: null,
                vehicle: null,
                material: Math.abs(pz) <= 10.2 ? 'concrete' : 'earth',
                hitZone: null
              };
            } else if (dtG > 1e-4) {
              for (let k = 1; k <= stepsG; k++) {
                const curT = tStart + dtG * k;
                const px = ox + dx * curT;
                const py = oy + dy * curT;
                const pz = oz + dz * curT;
                const diff = py - getTerrainHeight(px, pz);
                if (diff <= 0) {
                  // Binary search refinement (5 steps -> < 1cm precision)
                  let lo = prevT;
                  let hi = curT;
                  for (let b = 0; b < 5; b++) {
                    const mid = (lo + hi) * 0.5;
                    const md = (oy + dy * mid) - getTerrainHeight(ox + dx * mid, oz + dz * mid);
                    if (md > 0) lo = mid;
                    else hi = mid;
                  }
                  const hitT = (lo + hi) * 0.5;
                  if (hitT < bestDist) {
                    const hx = ox + dx * hitT;
                    const hz = oz + dz * hitT;
                    const hy = getTerrainHeight(hx, hz);
                    // Approximate terrain surface normal via central finite difference
                    const eps = 0.25;
                    const hL = getTerrainHeight(hx - eps, hz);
                    const hR = getTerrainHeight(hx + eps, hz);
                    const hB = getTerrainHeight(hx, hz - eps);
                    const hF = getTerrainHeight(hx, hz + eps);
                    let gnx = hL - hR;
                    let gny = 2 * eps;
                    let gnz = hB - hF;
                    const gnl = Math.hypot(gnx, gny, gnz) || 1;
                    bestDist = hitT;
                    hitResult = {
                      dist: hitT,
                      point: [hx, hy, hz],
                      normal: [gnx / gnl, gny / gnl, gnz / gnl],
                      collider: null,
                      entity: null,
                      vehicle: null,
                      material: Math.abs(hz) <= 10.2 ? 'concrete' : 'earth',
                      hitZone: null
                    };
                  }
                  break;
                }
                prevT = curT;
                prevDiff = diff;
              }
            }
          }
        }
      }

      // 4. Optional Armored Vehicles directional OBB check (front/side/rear/top)
      if (checkVehicles) {
        const vehicles = o.vehicles || (DF.Armor && typeof DF.Armor.getVehicles === 'function' ? DF.Armor.getVehicles() : null);
        if (vehicles) {
          for (let i = 0; i < vehicles.length; i++) {
            const v = vehicles[i];
            if (!v || !v.pos) continue;
            if (ignoreIds && (ignoreIds.indexOf(v.id) !== -1 || (v.colliderId && ignoreIds.indexOf(v.colliderId) !== -1))) continue;
            if (ignoreFaction && v.faction === ignoreFaction && !o.hitFriendlyVehicles) continue;

            // Compute vehicle orthonormal basis (right, up, forward)
            let fx, fz;
            if (v.forward && v.forward.length >= 3) {
              const fl = Math.hypot(v.forward[0], v.forward[2]) || 1;
              fx = v.forward[0] / fl;
              fz = v.forward[2] / fl;
            } else {
              const yaw = v.hullYaw !== undefined ? v.hullYaw : (v.yaw || 0);
              fx = Math.sin(yaw);
              fz = Math.cos(yaw);
            }
            const rx = fz;
            const rz = -fx;

            // Hull + turret approximate OBB dimensions
            const halfW = (v.width || (v.type === 'ifv' ? 3.2 : 3.6)) * 0.5;
            const fullH = v.height || (v.type === 'ifv' ? 2.55 : 2.45);
            const halfL = (v.length || (v.type === 'ifv' ? 6.5 : 7.0)) * 0.5;

            const relX = ox - v.pos[0];
            const relY = oy - v.pos[1];
            const relZ = oz - v.pos[2];

            // Transform ray into vehicle local frame (X=right, Y=up, Z=forward)
            const lox = relX * rx + relZ * rz;
            const loy = relY;
            const loz = relX * fx + relZ * fz;

            const ldx = dx * rx + dz * rz;
            const ldy = dy;
            const ldz = dx * fx + dz * fz;

            const vMin = [-halfW, 0.15, -halfL];
            const vMax = [halfW, fullH, halfL];
            const t = intersectRayAABB(lox, loy, loz, ldx, ldy, ldz, vMin, vMax, bestDist, tmpNormal);

            if (t >= 0 && t < bestDist) {
              bestDist = t;
              const lnx = tmpNormal[0], lny = tmpNormal[1], lnz = tmpNormal[2];
              let hitZone = 'side';
              if (lny > 0.6) hitZone = 'top';
              else if (lnz > 0.6) hitZone = 'front';
              else if (lnz < -0.6) hitZone = 'rear';
              else hitZone = 'side';

              // Transform local normal back to world space
              const wnx = lnx * rx + lnz * fx;
              const wny = lny;
              const wnz = lnx * rz + lnz * fz;

              hitResult = {
                dist: t,
                point: [ox + dx * t, oy + dy * t, oz + dz * t],
                normal: [wnx, wny, wnz],
                collider: null,
                entity: null,
                vehicle: v,
                material: 'metal',
                hitZone
              };
            }
          }
        }
      }

      // 5. Optional Active Soldiers & Unmanned Units check (head/torso/limb hit zones)
      if (checkEntities) {
        const soldiers = o.entities || (DF.AI && typeof DF.AI.getSoldiers === 'function' ? DF.AI.getSoldiers() : null);
        if (soldiers) {
          for (let i = 0; i < soldiers.length; i++) {
            const s = soldiers[i];
            if (!s || !s.pos || s.state === 'dead' || s.inVehicleId) continue;
            if (ignoreEntityId && s.id === ignoreEntityId) continue;
            if (ignoreIds && ignoreIds.indexOf(s.id) !== -1) continue;
            if (ignoreFaction && s.faction === ignoreFaction) continue;

            const sx = s.pos[0], sy = s.pos[1], sz = s.pos[2];

            // Quick bounding sphere pre-reject (center at sy + 0.9, radius 1.15)
            if (intersectRaySphere(ox, oy, oz, dx, dy, dz, sx, sy + 0.9, sz, 1.15, bestDist) < 0) {
              continue;
            }

            if (s.state === 'downed') {
              const tDown = intersectRayCylinder(ox, oy, oz, dx, dy, dz, sx, sy, sy + 0.68, sz, 0.44, bestDist, tmpNormal);
              if (tDown >= 0 && tDown < bestDist) {
                bestDist = tDown;
                hitResult = {
                  dist: tDown,
                  point: [ox + dx * tDown, oy + dy * tDown, oz + dz * tDown],
                  normal: [tmpNormal[0], tmpNormal[1], tmpNormal[2]],
                  collider: null,
                  entity: s,
                  vehicle: null,
                  material: 'flesh',
                  hitZone: 'torso'
                };
              }
              continue;
            }

            const crouching = !!(s.crouching || s.stance === 'crouch');
            const headY = sy + (crouching ? 1.18 : 1.64);
            const torsoY0 = sy + (crouching ? 0.50 : 0.84);
            const torsoY1 = sy + (crouching ? 1.06 : 1.48);
            const legY1 = torsoY0;

            let entT = bestDist;
            let entZone = null;
            let enx = 0, eny = 1, enz = 0;

            // Head sphere (generous 0.18m helmet radius for crisp tactical headshots)
            const tHead = intersectRaySphere(ox, oy, oz, dx, dy, dz, sx, headY, sz, 0.18, entT);
            if (tHead >= 0 && tHead < entT) {
              entT = tHead;
              entZone = 'head';
              const hx = ox + dx * tHead - sx;
              const hy = oy + dy * tHead - headY;
              const hz = oz + dz * tHead - sz;
              const hl = Math.hypot(hx, hy, hz) || 1;
              enx = hx / hl; eny = hy / hl; enz = hz / hl;
            }

            // Torso cylinder (plate carrier width)
            const tTorso = intersectRayCylinder(ox, oy, oz, dx, dy, dz, sx, torsoY0, torsoY1, sz, 0.29, entT, tmpNormal);
            if (tTorso >= 0 && tTorso < entT) {
              entT = tTorso;
              entZone = 'torso';
              enx = tmpNormal[0]; eny = tmpNormal[1]; enz = tmpNormal[2];
            }

            // Legs/limbs cylinder
            const tLimb = intersectRayCylinder(ox, oy, oz, dx, dy, dz, sx, sy, legY1, sz, 0.27, entT, tmpNormal);
            if (tLimb >= 0 && tLimb < entT) {
              entT = tLimb;
              entZone = 'limb';
              enx = tmpNormal[0]; eny = tmpNormal[1]; enz = tmpNormal[2];
            }

            if (entZone) {
              bestDist = entT;
              hitResult = {
                dist: entT,
                point: [ox + dx * entT, oy + dy * entT, oz + dz * entT],
                normal: [enx, eny, enz],
                collider: null,
                entity: s,
                vehicle: null,
                material: 'flesh',
                hitZone: entZone
              };
            }
          }
        }

        // Also check Drones & Armed Robot Dogs so players/AI can shoot them down!
        const unmanned = DF.Unmanned && typeof DF.Unmanned.getUnits === 'function' ? DF.Unmanned.getUnits() : null;
        if (unmanned) {
          for (let i = 0; i < unmanned.length; i++) {
            const u = unmanned[i];
            if (!u || !u.pos || u.alive === false || u.hp <= 0) continue;
            if (ignoreEntityId && u.id === ignoreEntityId) continue;
            if (ignoreIds && ignoreIds.indexOf(u.id) !== -1) continue;
            if (ignoreFaction && u.faction === ignoreFaction) continue;

            const isDog = u.type === 'dog';
            const cy = u.pos[1] + (isDog ? 0.45 : 0.05);
            const ur = isDog ? 0.52 : 0.55;
            const tU = intersectRaySphere(ox, oy, oz, dx, dy, dz, u.pos[0], cy, u.pos[2], ur, bestDist);
            if (tU >= 0 && tU < bestDist) {
              bestDist = tU;
              const px = ox + dx * tU, py = oy + dy * tU, pz = oz + dz * tU;
              const nx = px - u.pos[0], ny = py - cy, nz = pz - u.pos[2];
              const nl = Math.hypot(nx, ny, nz) || 1;
              hitResult = {
                dist: tU,
                point: [px, py, pz],
                normal: [nx / nl, ny / nl, nz / nl],
                collider: null,
                entity: u,
                vehicle: null,
                material: 'metal',
                hitZone: 'torso'
              };
            }
          }
        }
      }

      return hitResult;
    },

    addSmokeVolume(pos, radius, duration) {
      const now = getClockTime();
      const maxR = radius > 0 ? radius : 6.5;
      const dur = duration > 0 ? duration : 16.0;
      const vol = {
        pos: [pos[0], pos[1] + 1.2, pos[2]],
        radius: maxR,
        maxRadius: maxR,
        createdAt: now,
        expiresAt: now + dur,
        growTime: 1.4
      };
      smokeVolumes.push(vol);
      if (smokeVolumes.length > 32) smokeVolumes.shift();
      return vol;
    },

    getSmokeVolumes() {
      const now = getClockTime();
      pruneSmokeVolumes(now);
      return smokeVolumes;
    },

    lineBlockedBySmoke(a, b) {
      if (smokeVolumes.length === 0) return false;
      const now = getClockTime();
      pruneSmokeVolumes(now);
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const abz = b[2] - a[2];
      const abLenSq = abx * abx + aby * aby + abz * abz;
      if (abLenSq < 1e-6) return false;

      for (let i = 0; i < smokeVolumes.length; i++) {
        const sv = smokeVolumes[i];
        const r = getSmokeEffectiveRadius(sv, now);
        if (r < 0.8) continue;
        const acx = sv.pos[0] - a[0];
        const acy = sv.pos[1] - a[1];
        const acz = sv.pos[2] - a[2];
        const t = clamp((acx * abx + acy * aby + acz * abz) / abLenSq, 0, 1);
        const px = a[0] + abx * t - sv.pos[0];
        const py = a[1] + aby * t - sv.pos[1];
        const pz = a[2] + abz * t - sv.pos[2];
        if (px * px + py * py + pz * pz <= r * r) {
          return true;
        }
      }
      return false;
    },

    update(dt) {
      if (dt > 0) {
        simTime += dt;
        if (typeof performance !== 'undefined') {
          lastWallClock = performance.now() * 0.001;
        }
      }
      pruneSmokeVolumes(simTime);
    },

    // ---- Dynamic Navigation Grid ----
    addNavLink(fromPos, toPos, bidirectional, waypoints) {
      rawStairLinks.push({
        from: [fromPos[0], fromPos[1], fromPos[2]],
        to: [toPos[0], toPos[1], toPos[2]],
        bidirectional: bidirectional !== false,
        waypoints: waypoints || null
      });
      if (navBuilt) rebuildStairNavLinks();
    },

    buildNavGrid() {
      for (let gz = 0; gz < NAV_H; gz++) {
        for (let gx = 0; gx < NAV_W; gx++) {
          evaluateNavCell(gx, gz);
        }
      }
      for (let gz = 0; gz < NAV_H; gz++) {
        for (let gx = 0; gx < NAV_W; gx++) {
          evaluateVehicleClearance(gx, gz);
        }
      }
      rebuildStairNavLinks();
      navBuilt = true;
    },

    rebuildNavCell(minX, minZ, maxX, maxZ) {
      if (!navBuilt) {
        Physics.buildNavGrid();
        return;
      }
      const x0 = worldToNavX(minX - 2.0);
      const x1 = worldToNavX(maxX + 2.0);
      const z0 = worldToNavZ(minZ - 2.0);
      const z1 = worldToNavZ(maxZ + 2.0);

      for (let gz = z0; gz <= z1; gz++) {
        for (let gx = x0; gx <= x1; gx++) {
          evaluateNavCell(gx, gz);
        }
      }
      // Update vehicle clearance in slightly expanded margin (3x3 dependency)
      const vx0 = Math.max(0, x0 - 1);
      const vx1 = Math.min(NAV_W - 1, x1 + 1);
      const vz0 = Math.max(0, z0 - 1);
      const vz1 = Math.min(NAV_H - 1, z1 + 1);
      for (let gz = vz0; gz <= vz1; gz++) {
        for (let gx = vx0; gx <= vx1; gx++) {
          evaluateVehicleClearance(gx, gz);
        }
      }
      rebuildStairNavLinks();
    },

    findPath(startPos, endPos, opts) {
      if (!navBuilt) Physics.buildNavGrid();
      const o = opts || {};
      const isVehicle = !!o.isVehicle;
      const startLayer = isVehicle ? 0 : elevationToLayer(startPos[1]);
      const goalLayer = isVehicle ? 0 : elevationToLayer(endPos[1]);

      const startIdx = findNearestWalkableNode(startPos[0], startPos[2], startLayer, isVehicle);
      const goalIdx = findNearestWalkableNode(endPos[0], endPos[2], goalLayer, isVehicle);

      if (startIdx === -1 || goalIdx === -1) {
        return [[endPos[0], Physics.getGroundY(endPos[0], endPos[2], endPos[1]), endPos[2]]];
      }
      if (startIdx === goalIdx) {
        return [[endPos[0], navY[goalIdx], endPos[2]]];
      }

      const goalLayerNum = Math.floor(goalIdx / NAV_LAYER_SIZE);
      const goalRem = goalIdx - goalLayerNum * NAV_LAYER_SIZE;
      const goalGz = Math.floor(goalRem / NAV_W);
      const goalGx = goalRem - goalGz * NAV_W;
      const goalWX = navToWorldX(goalGx);
      const goalWZ = navToWorldZ(goalGz);
      const goalWY = navY[goalIdx];

      const stamp = ++astarRunStamp;
      heapReset();

      astarG[startIdx] = 0;
      astarF[startIdx] = Math.hypot(
        goalWX - navToWorldX(startIdx % NAV_W),
        (goalWY - navY[startIdx]) * 1.5,
        goalWZ - navToWorldZ(Math.floor((startIdx % NAV_LAYER_SIZE) / NAV_W))
      );
      astarParent[startIdx] = -1;
      astarOpenStamp[startIdx] = stamp;
      heapPush(startIdx);

      let bestFallback = startIdx;
      let bestFallbackH = astarF[startIdx];
      let found = false;
      let iterations = 0;
      const maxIter = o.maxIterations || 2600;

      while (heapSize > 0 && iterations++ < maxIter) {
        const cur = heapPop();
        if (cur === goalIdx) {
          found = true;
          break;
        }
        astarClosedStamp[cur] = stamp;

        const layer = Math.floor(cur / NAV_LAYER_SIZE);
        const rem = cur - layer * NAV_LAYER_SIZE;
        const gz = Math.floor(rem / NAV_W);
        const gx = rem - gz * NAV_W;
        const curG = astarG[cur];

        // Track closest node reached in case goal is unreachable
        const hCur = Math.hypot(goalWX - navToWorldX(gx), (goalWY - navY[cur]) * 1.8, goalWZ - navToWorldZ(gz));
        if (hCur < bestFallbackH) {
          bestFallbackH = hCur;
          bestFallback = cur;
        }

        // 8-direction neighbors on same layer
        for (let d = 0; d < 8; d++) {
          const ngx = gx + DIR_X[d];
          const ngz = gz + DIR_Z[d];
          if (ngx < 0 || ngx >= NAV_W || ngz < 0 || ngz >= NAV_H) continue;
          const nIdx = layer * NAV_LAYER_SIZE + ngz * NAV_W + ngx;
          if (astarClosedStamp[nIdx] === stamp) continue;

          if (isVehicle) {
            if (!navVehicle[nIdx]) continue;
          } else {
            if (!navWalkable[nIdx]) continue;
          }

          // Prevent diagonal corner cutting through doorways/pillars
          if (d >= 4) {
            const c1 = layer * NAV_LAYER_SIZE + gz * NAV_W + ngx;
            const c2 = layer * NAV_LAYER_SIZE + ngz * NAV_W + gx;
            if (isVehicle) {
              if (!navVehicle[c1] || !navVehicle[c2]) continue;
            } else {
              if (!navWalkable[c1] || !navWalkable[c2]) continue;
            }
          }

          // For vehicles, strongly prefer main avenue (|Z| <= 10.5)
          let weight = navCost[nIdx];
          if (isVehicle) {
            const nwz = navToWorldZ(ngz);
            weight = Math.abs(nwz) <= 10.5 ? 1.0 : 1.75;
          }

          const tentativeG = curG + DIR_DIST[d] * weight;
          if (astarOpenStamp[nIdx] !== stamp) {
            astarG[nIdx] = tentativeG;
            const nh = Math.hypot(goalWX - navToWorldX(ngx), (goalWY - navY[nIdx]) * 1.6, goalWZ - navToWorldZ(ngz));
            astarF[nIdx] = tentativeG + nh;
            astarParent[nIdx] = cur;
            astarOpenStamp[nIdx] = stamp;
            heapPush(nIdx);
          } else if (tentativeG < astarG[nIdx]) {
            const diff = astarG[nIdx] - tentativeG;
            astarG[nIdx] = tentativeG;
            astarF[nIdx] -= diff;
            astarParent[nIdx] = cur;
            heapDecrease(nIdx);
          }
        }

        // Multi-floor stair links (infantry/robot dog only)
        if (!isVehicle) {
          const links = navLinks.get(cur);
          if (links) {
            for (let i = 0; i < links.length; i++) {
              const lk = links[i];
              const nIdx = lk.to;
              if (astarClosedStamp[nIdx] === stamp || !navWalkable[nIdx]) continue;
              const tentativeG = curG + lk.cost;
              const nl = Math.floor(nIdx / NAV_LAYER_SIZE);
              const nrem = nIdx - nl * NAV_LAYER_SIZE;
              const ngz = Math.floor(nrem / NAV_W);
              const ngx = nrem - ngz * NAV_W;

              if (astarOpenStamp[nIdx] !== stamp) {
                astarG[nIdx] = tentativeG;
                const nh = Math.hypot(goalWX - navToWorldX(ngx), (goalWY - navY[nIdx]) * 1.6, goalWZ - navToWorldZ(ngz));
                astarF[nIdx] = tentativeG + nh;
                astarParent[nIdx] = cur;
                astarOpenStamp[nIdx] = stamp;
                heapPush(nIdx);
              } else if (tentativeG < astarG[nIdx]) {
                const diff = astarG[nIdx] - tentativeG;
                astarG[nIdx] = tentativeG;
                astarF[nIdx] -= diff;
                astarParent[nIdx] = cur;
                heapDecrease(nIdx);
              }
            }
          }
        }
      }

      // Reconstruct node chain
      const endNode = found ? goalIdx : bestFallback;
      const chain = [];
      let cur = endNode;
      while (cur !== -1) {
        chain.push(cur);
        cur = astarParent[cur];
      }
      chain.reverse();

      // Convert to 3D waypoints, injecting smooth stair midpoints & pruning collinear flat nodes
      const rawPoints = [];
      for (let i = 0; i < chain.length; i++) {
        const idx = chain[i];
        const l = Math.floor(idx / NAV_LAYER_SIZE);
        const rem = idx - l * NAV_LAYER_SIZE;
        const gz = Math.floor(rem / NAV_W);
        const gx = rem - gz * NAV_W;
        const pt = [navToWorldX(gx), navY[idx], navToWorldZ(gz)];

        if (i > 0) {
          const prevIdx = chain[i - 1];
          const prevL = Math.floor(prevIdx / NAV_LAYER_SIZE);
          if (prevL !== l) {
            // Look up stair link waypoints for smooth stair traversal
            const links = navLinks.get(prevIdx);
            if (links) {
              for (let k = 0; k < links.length; k++) {
                if (links[k].to === idx && links[k].waypoints) {
                  for (let w = 0; w < links[k].waypoints.length; w++) {
                    const wp = links[k].waypoints[w];
                    rawPoints.push([wp[0], wp[1], wp[2], true]);
                  }
                  break;
                }
              }
            }
          }
        }
        rawPoints.push([pt[0], pt[1], pt[2], false]);
      }

      // Prune redundant collinear waypoints on flat segments while keeping stair points intact
      const smooth = [];
      for (let i = 0; i < rawPoints.length; i++) {
        const p = rawPoints[i];
        if (i === 0 || i === rawPoints.length - 1 || p[3]) {
          smooth.push([p[0], p[1], p[2]]);
          continue;
        }
        const prev = smooth[smooth.length - 1];
        const next = rawPoints[i + 1];
        if (Math.abs(p[1] - prev[1]) > 0.25 || Math.abs(next[1] - p[1]) > 0.25 || next[3]) {
          smooth.push([p[0], p[1], p[2]]);
          continue;
        }
        const v1x = p[0] - prev[0], v1z = p[2] - prev[2];
        const v2x = next[0] - p[0], v2z = next[2] - p[2];
        const cross = Math.abs(v1x * v2z - v1z * v2x);
        if (cross > 0.15) {
          smooth.push([p[0], p[1], p[2]]);
        }
      }

      // Snap exact final point if we reached the goal
      if (found && smooth.length > 0) {
        const last = smooth[smooth.length - 1];
        if (Math.hypot(last[0] - endPos[0], last[2] - endPos[2]) < 3.0) {
          last[0] = clamp(endPos[0], PLAY_MIN_X + 0.5, PLAY_MAX_X - 0.5);
          last[1] = Physics.getGroundY(last[0], clamp(endPos[2], PLAY_MIN_Z + 0.5, PLAY_MAX_Z - 0.5), endPos[1]);
          last[2] = clamp(endPos[2], PLAY_MIN_Z + 0.5, PLAY_MAX_Z - 0.5);
        }
      }
      // Drop start node if we are already standing right on it
      if (smooth.length > 1) {
        const first = smooth[0];
        if (Math.hypot(first[0] - startPos[0], first[2] - startPos[2]) < 1.2 && Math.abs(first[1] - startPos[1]) < 0.8) {
          smooth.shift();
        }
      }

      return smooth;
    },

    // ---- Tactical Cover Graph ----
    addCoverNode(cfg) {
      const normal = cfg.normal || [-1, 0, 0];
      const nl = Math.hypot(normal[0], normal[2]) || 1;
      const nx = normal[0] / nl;
      const nz = normal[2] / nl;
      const refY = cfg.pos[1] !== undefined ? cfg.pos[1] : 0;
      const gy = Physics.getGroundY(cfg.pos[0], cfg.pos[2], refY);

      const peek = cfg.peekPos
        ? [cfg.peekPos[0], cfg.peekPos[1] !== undefined ? cfg.peekPos[1] : gy, cfg.peekPos[2]]
        : [cfg.pos[0] + nx * 0.55, gy, cfg.pos[2] + nz * 0.55];

      const node = {
        id: cfg.id || ('cov_' + (nextCoverId++)),
        pos: [cfg.pos[0], gy, cfg.pos[2]],
        peekPos: peek,
        normal: [nx, 0, nz],
        height: cfg.height !== undefined ? cfg.height : 1.15,
        elevated: gy > 2.2,
        sectorIdx: cfg.sectorIdx !== undefined ? cfg.sectorIdx : -1,
        factionHint: cfg.factionHint || null,
        destructibleId: cfg.destructibleId || null,
        active: true
      };
      coverNodes.push(node);
      return node;
    },

    invalidateCoverNear(pos, radius, destructibleId) {
      const r2 = (radius || 2.0) * (radius || 2.0);
      let count = 0;
      for (let i = 0; i < coverNodes.length; i++) {
        const cn = coverNodes[i];
        if (!cn.active) continue;
        if (destructibleId && cn.destructibleId === destructibleId) {
          cn.active = false;
          count++;
          continue;
        }
        const dx = cn.pos[0] - pos[0];
        const dy = cn.pos[1] - pos[1];
        const dz = cn.pos[2] - pos[2];
        if (dx * dx + dz * dz <= r2 && Math.abs(dy) < 2.2) {
          cn.active = false;
          count++;
        }
      }
      return count;
    },

    restoreAllCover() {
      for (let i = 0; i < coverNodes.length; i++) {
        coverNodes[i].active = true;
      }
    },

    getCoverNodes() {
      return coverNodes;
    },

    getBestCover(pos, threatPos, radius, faction, preferElevated) {
      const searchR = radius > 0 ? radius : 22.0;
      const r2 = searchR * searchR;
      const tx = threatPos ? threatPos[0] : (faction === 'UA' ? -80 : 80);
      const ty = threatPos ? threatPos[1] : 1.5;
      const tz = threatPos ? threatPos[2] : 0;

      const soldiers = DF.AI && typeof DF.AI.getSoldiers === 'function' ? DF.AI.getSoldiers() : null;

      let bestNode = null;
      let bestScore = -1e9;

      for (let i = 0; i < coverNodes.length; i++) {
        const cn = coverNodes[i];
        if (!cn.active) continue;
        const dx = cn.pos[0] - pos[0];
        const dy = cn.pos[1] - pos[1];
        const dz = cn.pos[2] - pos[2];
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;

        // Threat direction from cover node
        const tdx = tx - cn.pos[0];
        const tdz = tz - cn.pos[2];
        const tDist = Math.hypot(tdx, tdz);
        if (tDist < 3.5) continue; // Don't take cover right on top of the enemy

        const dot = (tdx / tDist) * cn.normal[0] + (tdz / tDist) * cn.normal[2];
        if (dot < 0.22) continue; // Cover faces the wrong way relative to threat

        const dist = Math.sqrt(d2) + Math.abs(dy) * 1.4;
        let score = dot * 18.0 - dist * 0.55;

        // Prefer crouchable waist cover and elevated firing decks when requested
        if (cn.height >= 1.0 && cn.height <= 1.5) score += 2.5;
        if (preferElevated && cn.elevated) score += 13.5;
        else if (!preferElevated && cn.elevated && Math.abs(dy) > 2.5) score -= 3.5;

        // Faction defensive hint bonus
        if (faction && cn.factionHint === faction) score += 3.0;

        // Optimal engagement range bonus (14m..58m)
        if (tDist >= 12 && tDist <= 60) score += 3.0;

        // Avoid crowding already occupied cover nodes
        if (soldiers) {
          for (let j = 0; j < soldiers.length; j++) {
            const s = soldiers[j];
            if (!s || s.state === 'dead' || s.inVehicleId) continue;
            const sdx = s.pos[0] - cn.pos[0];
            const sdz = s.pos[2] - cn.pos[2];
            if (sdx * sdx + sdz * sdz < 2.25 && Math.abs(s.pos[1] - cn.pos[1]) < 1.5) {
              // Ignore if this is the requesting soldier themselves
              const selfD = Math.hypot(s.pos[0] - pos[0], s.pos[2] - pos[2]);
              if (selfD > 0.6) {
                score -= 16.0;
                break;
              }
            }
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestNode = cn;
        }
      }

      if (!bestNode) return null;
      return {
        id: bestNode.id,
        pos: [bestNode.pos[0], bestNode.pos[1], bestNode.pos[2]],
        peekPos: [bestNode.peekPos[0], bestNode.peekPos[1], bestNode.peekPos[2]],
        height: bestNode.height,
        quality: clamp((bestScore + 10) / 35, 0.1, 1.0),
        elevated: bestNode.elevated,
        normal: [bestNode.normal[0], bestNode.normal[1], bestNode.normal[2]]
      };
    }
  };

  DF.Physics = Physics;
})();
